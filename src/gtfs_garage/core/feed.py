"""Loads a GTFS feed (zip file or already-extracted folder) into DuckDB views,
one per .txt file, so the rest of the app can query it with SQL without a
separate import/ETL step - this is what lets a large feed stay responsive.

By default the CSVs are then rewritten once as Parquet and the views repointed
at that. See `_convert_to_parquet` for why, and pass `optimise=False` to keep
reading the CSVs where they sit.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# Reported through `on_progress` so a caller can say which phase is running.
PHASE_EXTRACT = "extract"
PHASE_CONVERT = "convert"

# Describes an exported dataset, so a reader need not probe for its tables.
MANIFEST = "manifest.json"

# The one GTFS file that is not a CSV, and the table it becomes.
LOCATIONS_GEOJSON = "locations.geojson"
LOCATIONS_TABLE = "locations"

ProgressFn = Callable[[str, int, int, str], None]
"""Called as (phase, done, total, detail) while a feed opens."""


class GtfsLoadError(Exception):
    pass


def _elapsed_ms(since: float) -> float:
    return (time.perf_counter() - since) * 1000


@dataclass
class FileStats:
    """What one .txt file cost to open."""

    name: str
    table: str
    # Uncompressed size on disk.
    bytes: int
    # Only known for zip sources; a folder has no compressed form.
    compressed_bytes: int | None
    # Declaring the view, which is all opening a feed does: DuckDB resolves the
    # column list off the start of the file and reads no further, so this
    # barely varies with size. Reported to the user as "read headers".
    register_ms: float
    columns: int
    # Filled in later, by the pass that actually scans the file.
    row_count: int | None = None
    count_ms: float | None = None
    # Set only when the feed was converted; the Parquet this table now reads.
    parquet_bytes: int | None = None
    convert_ms: float | None = None


@dataclass
class FeedStats:
    """Sizes and timings for the phases of opening a feed.

    Deliberately plain dataclasses: `gtfs_garage.core` stays framework-free, so
    the server layer is what turns these into its published response models.
    """

    # The zip's own size, or the sum of the .txt files in a folder.
    source_bytes: int = 0
    # None when the source was already-extracted files.
    extract_ms: float | None = None
    register_ms: float = 0.0
    # None when the feed was opened with optimise=False.
    convert_ms: float | None = None
    files: list[FileStats] = field(default_factory=list)

    def record_count(self, table: str, rows: int, elapsed_ms: float) -> None:
        """Attach the result of a row-counting scan to its file.

        Called again on every summary pass, so the numbers always describe the
        most recent one rather than only the first.
        """
        for stats in self.files:
            if stats.table == table:
                stats.row_count, stats.count_ms = rows, elapsed_ms
                return

    @property
    def count_ms(self) -> float:
        return sum(f.count_ms or 0.0 for f in self.files)

    @property
    def stored_bytes(self) -> int | None:
        """What the feed occupies to query, once converted."""
        converted = [f.parquet_bytes for f in self.files if f.parquet_bytes is not None]
        return sum(converted) if converted else None

    @property
    def total_ms(self) -> float:
        return (self.extract_ms or 0.0) + self.register_ms + (self.convert_ms or 0.0) + self.count_ms


class GtfsFeed:
    def __init__(self, source_path: str, optimise: bool = True, on_progress: ProgressFn | None = None):
        import duckdb

        self.source_path = Path(source_path).expanduser()
        self._on_progress = on_progress
        # Directories this feed created and is therefore allowed to delete. A
        # folder handed to us belongs to the user and never goes in here.
        self._owned_dirs: list[Path] = []
        self._extract_dir: Path | None = None
        self.stats = FeedStats()
        # Populated from the archive before extraction; empty for a folder.
        self._compressed_sizes: dict[str, int] = {}
        # Set by `_resolve_data_dir`, which runs next, when the source has
        # already been converted.
        self._parquet_source = False
        self.data_dir = self._resolve_data_dir()
        self.con = duckdb.connect(database=":memory:")
        self.tables: dict[str, list[str]] = {}
        self._load_tables()
        if not self.tables:
            self.close()
            raise GtfsLoadError(f"No GTFS files found under {self.data_dir}")
        # Nothing to convert when the source is already Parquet.
        if optimise and not self._parquet_source:
            self._convert_to_parquet()

    def _progress(self, phase: str, done: int, total: int, detail: str = "") -> None:
        if self._on_progress:
            self._on_progress(phase, done, total, detail)

    def _scratch_dir(self, prefix: str) -> Path:
        directory = Path(tempfile.mkdtemp(prefix=prefix))
        self._owned_dirs.append(directory)
        return directory

    def _resolve_data_dir(self) -> Path:
        if not self.source_path.exists():
            raise GtfsLoadError(f"Path does not exist: {self.source_path}")

        if self.source_path.is_dir():
            # A directory of Parquet is what `export_parquet` writes and what a
            # browser reads over range requests. Opening one skips extracting
            # and converting entirely, which is the whole point of producing it.
            if not any(self.source_path.glob("*.txt")) and any(self.source_path.glob("*.parquet")):
                self._parquet_source = True
                self.stats.source_bytes = sum(f.stat().st_size for f in self.source_path.glob("*.parquet"))
                return self.source_path

            data_dir = self.source_path
            if not (self.source_path / "stops.txt").exists():
                nested = next(self.source_path.rglob("stops.txt"), None)
                data_dir = nested.parent if nested else self.source_path
            self.stats.source_bytes = sum(
                f.stat().st_size for f in list(data_dir.glob("*.txt")) + list(data_dir.glob(LOCATIONS_GEOJSON))
            )
            return data_dir

        if self.source_path.suffix.lower() == ".zip":
            self.stats.source_bytes = self.source_path.stat().st_size
            self._extract_dir = self._scratch_dir("gtfs-garage-")
            started = time.perf_counter()
            try:
                with zipfile.ZipFile(self.source_path) as zf:
                    # Read the directory before extracting: it carries the
                    # compressed size per member, which the files on disk lose.
                    members = zf.infolist()
                    self._compressed_sizes = {Path(info.filename).name: info.compress_size for info in members}
                    total = len(members)
                    for done, info in enumerate(members, start=1):
                        zf.extract(info, self._extract_dir)
                        self._progress(PHASE_EXTRACT, done, total, Path(info.filename).name)
            except zipfile.BadZipFile as exc:
                raise GtfsLoadError(f"Not a valid zip file: {self.source_path}") from exc
            self.stats.extract_ms = _elapsed_ms(started)
            # Real-world GTFS zips sometimes wrap the .txt files in a single
            # subfolder (e.g. exported from GitHub) instead of putting them
            # at the archive root.
            nested = next(self._extract_dir.rglob("stops.txt"), None)
            return nested.parent if nested else self._extract_dir

        raise GtfsLoadError(f"Expected a .zip file or a folder, got: {self.source_path}")

    def _load_tables(self) -> None:
        started = time.perf_counter()
        if self._parquet_source:
            self._load_parquet_tables()
            self.stats.register_ms = _elapsed_ms(started)
            return
        for txt_file in sorted(self.data_dir.glob("*.txt")):
            table_name = txt_file.stem
            escaped_path = str(txt_file).replace("'", "''")
            file_started = time.perf_counter()
            try:
                self.con.execute(f"""
                    CREATE VIEW "{table_name}" AS
                    SELECT * FROM read_csv(
                        '{escaped_path}',
                        ALL_VARCHAR = TRUE,
                        IGNORE_ERRORS = TRUE,
                        NULLSTR = ''
                    )
                    """)
            except Exception:
                # Skip files DuckDB can't parse (e.g. empty files) rather than
                # failing the whole feed load over one optional file.
                continue
            columns = [row[0] for row in self.con.execute(f'DESCRIBE "{table_name}"').fetchall()]
            self.tables[table_name] = columns
            self.stats.files.append(
                FileStats(
                    name=txt_file.name,
                    table=table_name,
                    bytes=txt_file.stat().st_size,
                    compressed_bytes=self._compressed_sizes.get(txt_file.name),
                    register_ms=_elapsed_ms(file_started),
                    columns=len(columns),
                )
            )
        self._load_locations_geojson()
        self.stats.register_ms = _elapsed_ms(started)

    def _load_parquet_tables(self) -> None:
        """Point a view at each Parquet file, with no conversion to do.

        `export_parquet` wrote these through the same `ALL_VARCHAR` views the
        CSVs were read with, so every column is already text and the queries
        behave identically to a feed opened from source.
        """
        for parquet_file in sorted(self.data_dir.glob("*.parquet")):
            table_name = parquet_file.stem
            escaped_path = str(parquet_file).replace("'", "''")
            file_started = time.perf_counter()
            try:
                self.con.execute(f"""CREATE VIEW "{table_name}" AS SELECT * FROM read_parquet('{escaped_path}')""")
            except Exception:
                continue
            columns = [row[0] for row in self.con.execute(f'DESCRIBE "{table_name}"').fetchall()]
            self.tables[table_name] = columns
            size = parquet_file.stat().st_size
            self.stats.files.append(
                FileStats(
                    name=parquet_file.name,
                    table=table_name,
                    bytes=size,
                    # Already converted, so there is no archive it came out of
                    # and no separate on-disk form to report.
                    compressed_bytes=None,
                    parquet_bytes=size,
                    register_ms=_elapsed_ms(file_started),
                    columns=len(columns),
                )
            )

    def export_parquet(self, destination: Path) -> list[Path]:
        """Write every table as Parquet into `destination`, and return the files.

        The same conversion `_convert_to_parquet` performs, kept rather than
        thrown away with the scratch directory. This is the artifact a browser
        queries over range requests, and producing it here means the thing
        served is the thing this tool's own tests cover.

        The manifest is what stops a reader guessing. Without it a client knows
        only that files are named after tables, so it has to try all 32 GTFS
        defines and see which answer - for a seven-table feed that measured at
        123 requests before the first row appeared. With it the dataset
        describes itself, and anything holding the URL can read it.
        """
        destination.mkdir(parents=True, exist_ok=True)
        written = []
        tables = []

        for table in sorted(self.tables):
            target = destination / f"{table}.parquet"
            escaped = str(target).replace("'", "''")
            self.con.execute(f"""COPY (SELECT * FROM "{table}") TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
            written.append(target)
            tables.append(
                {"name": table, "file": target.name, "rows": self.row_count(table), "bytes": target.stat().st_size}
            )

        manifest = destination / MANIFEST
        manifest.write_text(json.dumps({"version": 1, "tables": tables}, indent=2) + "\n", encoding="utf-8")
        written.append(manifest)
        return written

    def _load_locations_geojson(self) -> None:
        """Register locations.geojson, the one GTFS file that is not a CSV.

        GTFS-Flex describes pickup and drop-off zones as GeoJSON polygons, and
        `stop_times.location_id` references a Feature's id. Flattening the
        FeatureCollection to one row per Feature is what lets the rest of the
        application treat it like any other file: it browses, filters and links
        with no special case anywhere downstream.

        Every column is cast to VARCHAR to match the `read_csv(ALL_VARCHAR)`
        contract the rest of the code is written against - `core/filters.py`
        compares with ILIKE and `= ''`, which need text.
        """
        source = self.data_dir / LOCATIONS_GEOJSON
        if not source.exists():
            return

        escaped_path = str(source).replace("'", "''")
        file_started = time.perf_counter()
        try:
            # `features` is read as opaque JSON rather than letting DuckDB infer
            # its shape, so a feed mixing Polygon and MultiPolygon cannot change
            # the columns this produces.
            self.con.execute(f"""
                CREATE VIEW "{LOCATIONS_TABLE}" AS
                SELECT
                    CAST(json_extract_string(feature, '$.id') AS VARCHAR) AS id,
                    CAST(json_extract_string(feature, '$.properties.stop_name') AS VARCHAR)
                        AS stop_name,
                    CAST(json_extract_string(feature, '$.properties.stop_desc') AS VARCHAR)
                        AS stop_desc,
                    CAST(json_extract_string(feature, '$.geometry.type') AS VARCHAR)
                        AS geometry_type,
                    CAST(json_extract(feature, '$.geometry') AS VARCHAR) AS geometry
                FROM (
                    SELECT unnest(features) AS feature
                    FROM read_json(
                        '{escaped_path}',
                        columns = {{type: 'VARCHAR', features: 'JSON[]'}}
                    )
                )
                """)
            columns = [row[0] for row in self.con.execute(f'DESCRIBE "{LOCATIONS_TABLE}"').fetchall()]
            # A view is lazy, so creating one over malformed JSON succeeds and
            # the parse error surfaces later - during the Parquet conversion, or
            # under a reader's query. Reading a row here forces the parse while
            # it can still be handled.
            self.con.execute(f'SELECT * FROM "{LOCATIONS_TABLE}" LIMIT 1').fetchall()
        except Exception:
            # Malformed JSON, or a document that is not a FeatureCollection. The
            # rest of the feed still opens; the zones are simply not there.
            self.con.execute(f'DROP VIEW IF EXISTS "{LOCATIONS_TABLE}"')
            return

        self.tables[LOCATIONS_TABLE] = columns
        self.stats.files.append(
            FileStats(
                name=LOCATIONS_GEOJSON,
                table=LOCATIONS_TABLE,
                bytes=source.stat().st_size,
                compressed_bytes=self._compressed_sizes.get(LOCATIONS_GEOJSON),
                register_ms=_elapsed_ms(file_started),
                columns=len(columns),
            )
        )

    def _convert_to_parquet(self) -> None:
        """Rewrite each table as Parquet and repoint its view at the result.

        Worth the one-off cost by a wide margin: on a 4.5 GB feed this
        takes about six seconds and makes COUNT(*) and filtered counts a few
        hundred times faster, because a CSV has to be re-parsed end to end for
        every one of them while Parquet carries its row count in the footer and
        only reads the columns a query names. It also shrinks the feed roughly
        twentyfold on disk, which is why the extracted CSVs can go afterwards.

        Selecting through the existing view preserves ALL_VARCHAR, so every
        column stays text and no query behaves differently than before.
        """
        started = time.perf_counter()
        parquet_dir = self._scratch_dir("gtfs-garage-parquet-")
        by_table = {f.table: f for f in self.stats.files}
        total = len(self.tables)

        for done, table in enumerate(list(self.tables), start=1):
            self._progress(PHASE_CONVERT, done, total, table)
            destination = parquet_dir / f"{table}.parquet"
            escaped = str(destination).replace("'", "''")
            table_started = time.perf_counter()
            try:
                self.con.execute(
                    f"""COPY (SELECT * FROM "{table}") TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)"""
                )
                self.con.execute(f'DROP VIEW "{table}"')
                self.con.execute(f"""CREATE VIEW "{table}" AS SELECT * FROM read_parquet('{escaped}')""")
            except Exception:
                # A table that will not convert keeps its CSV view, so the feed
                # still opens. That is also why the CSVs are only deleted below
                # once every table has been repointed.
                continue
            stats = by_table.get(table)
            if stats is not None:
                stats.parquet_bytes = destination.stat().st_size
                stats.convert_ms = _elapsed_ms(table_started)

        self.stats.convert_ms = _elapsed_ms(started)
        self._drop_extracted_csvs()

    def _drop_extracted_csvs(self) -> None:
        """Release the extracted CSVs, which nothing reads once converted.

        Only ever touches files this feed extracted itself. A feed opened from
        a folder reads the user's own files, and those are never deleted.
        """
        if self._extract_dir is None or not self._extract_dir.exists():
            return
        if all(f.parquet_bytes is not None for f in self.stats.files):
            shutil.rmtree(self._extract_dir, ignore_errors=True)

    def cursor(self):
        """A fresh cursor sharing the same in-memory database - required
        because a single DuckDB connection object can't run queries fired
        from concurrent requests safely, only a plain sequence of them.
        """
        return self.con.cursor()

    def row_count(self, table: str) -> int:
        return self.cursor().execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]

    def close(self) -> None:
        try:
            self.con.close()
        except Exception:
            pass
        for directory in self._owned_dirs:
            shutil.rmtree(directory, ignore_errors=True)
        self._owned_dirs.clear()
