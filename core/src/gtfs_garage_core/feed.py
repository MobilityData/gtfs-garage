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

from gtfs_garage_core.convert import (
    LOCATIONS_GEOJSON,
    LOCATIONS_TABLE,
    MANIFEST,
    convert_table,
    manifest_entry,
    register_table,
    sql_path,
    write_manifest,
)
from gtfs_garage_core.lines import (
    APPROXIMATE,
    BY_COLUMN,
    BY_POSITION,
    BY_WINDOW,
    EXACT,
    LINE_COLUMN,
    SLOW_PATH_ROW_LIMIT,
    kept_record_lines,
    physical_lines,
)
from gtfs_garage_core.workspace import FeedSlot

# Reported through `on_progress` so a caller can say which phase is running.
PHASE_EXTRACT = "extract"
PHASE_CONVERT = "convert"

ProgressFn = Callable[[str, int, int, str], None]
"""Called as (phase, done, total, detail) while a feed opens."""


class GtfsLoadError(Exception):
    pass


def _elapsed_ms(since: float) -> float:
    return (time.perf_counter() - since) * 1000


@dataclass
class LineNumbers:
    """How one table's rows map back to the lines of the file they came from.

    See `lines.py`. `storage` says how the number is produced and
    `quality` whether it was checked against the file.
    """

    storage: str
    quality: str
    # The Parquet behind the table, for the two storages that read it directly.
    parquet: Path | None = None


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

    Deliberately plain dataclasses: `gtfs_garage_core` stays framework-free, so
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
    def __init__(
        self,
        source_path: str,
        optimise: bool = True,
        on_progress: ProgressFn | None = None,
        slot: FeedSlot | None = None,
        temp_directory: Path | None = None,
    ):
        """Open a feed.

        `slot` puts the extracted CSVs and the Parquet in a workspace instead of
        in directories of this feed's own making. The difference is ownership: a
        slot outlives the feed and can be reopened from, while directories the
        feed made it deletes on close. Without one, behaviour is as before.
        """
        import duckdb

        self.source_path = Path(source_path).expanduser()
        self._on_progress = on_progress
        self.slot = slot
        # Directories this feed created and is therefore allowed to delete. A
        # folder handed to us belongs to the user and never goes in here, and
        # neither does a workspace slot, which the workspace owns.
        self._owned_dirs: list[Path] = []
        self._extract_dir: Path | None = None
        self.stats = FeedStats()
        # Populated from the archive before extraction; empty for a folder.
        self._compressed_sizes: dict[str, int] = {}
        # Set by `_resolve_data_dir`, which runs next, when the source has
        # already been converted.
        self._parquet_source = False
        self.data_dir = self._resolve_data_dir()
        # Keeping DuckDB's own spill beside everything else is the difference
        # between a workdir that accounts for the disk it uses and one that does
        # not: a query over a feed too large for memory writes gigabytes here.
        config = {"temp_directory": str(temp_directory)} if temp_directory else {}
        self.con = duckdb.connect(database=":memory:", config=config)
        self.tables: dict[str, list[str]] = {}
        # Per table, how to recover the line each row was read from. A table
        # without an entry has none to give - locations.geojson is not lines.
        self.lines: dict[str, LineNumbers] = {}
        # The CSV each table was read from, while it still exists.
        self._csv_paths: dict[str, Path] = {}
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

    def _scratch_dir(self, prefix: str, slot_dir: Path | None = None) -> Path:
        """Somewhere to write. The workspace's, if there is one; ours if not.

        Only a directory this feed made itself is recorded as owned, which is
        what `close` deletes; a slot's belong to the workspace and outlive it.
        """
        if slot_dir is not None:
            slot_dir.mkdir(parents=True, exist_ok=True)
            return slot_dir
        directory = Path(tempfile.mkdtemp(prefix=prefix))
        self._owned_dirs.append(directory)
        return directory

    def _resolve_data_dir(self) -> Path:
        if not self.source_path.exists():
            raise GtfsLoadError(f"Path does not exist: {self.source_path}")

        if self.source_path.is_dir():
            # A directory of Parquet, as `export_parquet` writes. Already
            # converted, so extracting and converting are both skipped.
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
            self._extract_dir = self._scratch_dir("gtfs-garage-", self.slot.extract_dir if self.slot else None)
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
            file_started = time.perf_counter()
            columns = register_table(self.con, table_name, txt_file)
            if columns is None:
                # Skip files DuckDB can't parse rather than failing the whole
                # feed load over one optional file.
                continue
            self.tables[table_name] = columns
            self._csv_paths[table_name] = txt_file
            # Until a conversion checks it, a CSV view can only number its rows
            # by position, which a multi-line value or a dropped row puts off.
            self.lines[table_name] = LineNumbers(BY_WINDOW, APPROXIMATE)
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
        # What the files weighed before they were converted cannot be recovered
        # from the Parquet, so the manifest beside it is the only place the load
        # report can get them. Absent for a dataset written by an older version,
        # in which case those columns are simply not reported.
        original = self._manifest_sizes()
        for parquet_file in sorted(self.data_dir.glob("*.parquet")):
            table_name = parquet_file.stem
            file_started = time.perf_counter()
            try:
                stored = [
                    row[0]
                    for row in self.con.execute(
                        f"DESCRIBE SELECT * FROM read_parquet({sql_path(parquet_file)})"
                    ).fetchall()
                ]
                self._create_parquet_view(table_name, parquet_file, LINE_COLUMN in stored)
            except Exception:
                continue
            columns = [row[0] for row in self.con.execute(f'DESCRIBE "{table_name}"').fetchall()]
            self.tables[table_name] = columns
            # A dataset written before line numbers were checked records no
            # verdict, and its CSVs were read with sniffed quoting - so its
            # positions are offered, but not as exact.
            if table_name != LOCATIONS_TABLE:  # a GeoJSON document, not lines
                self.lines[table_name] = LineNumbers(
                    BY_COLUMN if LINE_COLUMN in stored else BY_POSITION,
                    original.get(table_name, {}).get("lines") or APPROXIMATE,
                    parquet_file,
                )
            size = parquet_file.stat().st_size
            was = original.get(table_name, {})
            self.stats.files.append(
                FileStats(
                    name=parquet_file.name,
                    table=table_name,
                    # The source's own size where the manifest remembers it, so
                    # a reopened feed reports the feed rather than its storage.
                    bytes=was.get("bytes") or size,
                    compressed_bytes=was.get("compressed_bytes"),
                    parquet_bytes=size,
                    register_ms=_elapsed_ms(file_started),
                    columns=len(columns),
                )
            )

    def _manifest_sizes(self) -> dict[str, dict]:
        """Per table, what the manifest beside the Parquet remembers of the source."""
        try:
            data = json.loads((self.data_dir / MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        tables = data.get("tables")
        if not isinstance(tables, list):
            return {}
        return {
            str(entry.get("name")): {
                "bytes": entry.get("bytes"),
                "compressed_bytes": entry.get("compressed_bytes"),
                "lines": entry.get("lines") if entry.get("lines") in (EXACT, APPROXIMATE) else None,
            }
            for entry in tables
            if isinstance(entry, dict) and entry.get("name")
        }

    def export_parquet(self, destination: Path) -> list[Path]:
        """Write every table as Parquet into `destination`, and return the files.

        One `{table}.parquet` per table plus a `manifest.json` naming them, so a
        reader need not know which files to expect. The sizes it records cannot
        be recovered afterwards: conversion deletes the CSVs, and a zip member's
        compressed size exists only in the archive's directory.
        """
        destination.mkdir(parents=True, exist_ok=True)
        stats_by_table = {f.table: f for f in self.stats.files}
        written = []
        tables = []

        for table in sorted(self.tables):
            target = destination / f"{table}.parquet"
            numbered = self.lines.get(table)
            # A stored line column is the only record of lines a position
            # cannot give, so it travels with the export. Positions survive the
            # copy as they are, because COPY keeps the order it reads in.
            if numbered and numbered.storage == BY_COLUMN and numbered.parquet:
                self.con.execute(
                    f"COPY (SELECT * FROM read_parquet({sql_path(numbered.parquet)})) "
                    f"TO {sql_path(target)} (FORMAT PARQUET, COMPRESSION ZSTD)"
                )
            else:
                convert_table(self.con, table, target)
            written.append(target)

            source = stats_by_table.get(table)
            tables.append(
                manifest_entry(
                    table,
                    rows=self.row_count(table),
                    columns=len(self.tables[table]),
                    bytes=source.bytes if source else None,
                    compressed_bytes=source.compressed_bytes if source else None,
                    parquet_bytes=target.stat().st_size,
                    lines=self._line_quality(table),
                )
            )

        written.append(self._manifest(destination, tables))
        return written

    def _manifest(self, destination: Path, tables: list[dict]) -> Path:
        """Write the manifest for `tables` into `destination`. See `convert.write_manifest`."""
        return write_manifest(
            destination, tables, source_kind=self._source_kind(), source_bytes=self.stats.source_bytes
        )

    def _source_kind(self) -> str:
        if self._parquet_source:
            return "parquet"
        return "zip" if self.source_path.suffix.lower() == ".zip" else "folder"

    def _load_locations_geojson(self) -> None:
        """Register locations.geojson, the one GTFS file that is not a CSV.

        See `convert.register_table`. A file that will not parse is left out
        and the rest of the feed still opens; the zones are simply not there.
        """
        source = self.data_dir / LOCATIONS_GEOJSON
        if not source.exists():
            return

        file_started = time.perf_counter()
        columns = register_table(self.con, LOCATIONS_TABLE, source)
        if columns is None:
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
        parquet_dir = self._scratch_dir("gtfs-garage-parquet-", self.slot.parquet_dir if self.slot else None)
        by_table = {f.table: f for f in self.stats.files}
        total = len(self.tables)

        for done, table in enumerate(list(self.tables), start=1):
            self._progress(PHASE_CONVERT, done, total, table)
            destination = parquet_dir / f"{table}.parquet"
            table_started = time.perf_counter()
            try:
                convert_table(self.con, table, destination)
                numbered = self._number_lines(table, destination)
                self.con.execute(f'DROP VIEW "{table}"')
                self._create_parquet_view(table, destination, bool(numbered and numbered.storage == BY_COLUMN))
                if numbered:
                    self.lines[table] = numbered
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
        if self.slot is not None:
            # Only a slot is reopened later, and only a manifest makes that
            # reopening report the feed rather than the Parquet it became.
            self._write_manifest(parquet_dir)
        self._drop_extracted_csvs()

    def _write_manifest(self, destination: Path) -> None:
        """Describe the converted dataset beside it, as `export_parquet` does.

        These sizes cannot be recovered later: the CSVs are deleted by the next
        step, and a zip member's compressed size lives only in the archive.
        """
        try:
            tables = [
                manifest_entry(
                    stats.table,
                    # Read from the Parquet footer rather than scanned, so this
                    # costs nothing even on a feed of sixty million rows.
                    rows=self.row_count(stats.table),
                    columns=stats.columns,
                    bytes=stats.bytes,
                    compressed_bytes=stats.compressed_bytes,
                    parquet_bytes=stats.parquet_bytes,
                    lines=self._line_quality(stats.table),
                )
                for stats in self.stats.files
                if stats.parquet_bytes is not None
            ]
            self._manifest(destination, tables)
        except Exception:
            # A dataset without its manifest still opens; only the report is
            # poorer. Failing the load over it would be the worse trade.
            pass

    def _create_parquet_view(self, table: str, parquet: Path, has_line_column: bool) -> None:
        """Point a table's view at its Parquet, leaving the line column out.

        The line is not a GTFS field, so it is never one of the table's
        columns: it is reached only through `line_source`, which is what keeps
        every existing query, page and export exactly as it was.
        """
        exclude = f' EXCLUDE ("{LINE_COLUMN}")' if has_line_column else ""
        self.con.execute(f'CREATE VIEW "{table}" AS SELECT *{exclude} FROM read_parquet({sql_path(parquet)})')

    def _number_lines(self, table: str, parquet: Path) -> LineNumbers | None:
        """Check the converted rows against the file's lines, and fix them if needed.

        See `lines.py`. The common case costs one pass over the bytes
        counting newlines; only a file whose lines and rows disagree is read
        again, and then its line numbers are stored beside the rows.
        """
        if table not in self.lines:
            return None  # not read from lines, as locations.geojson is not
        source = self._csv_paths.get(table)
        if source is None or not source.exists():
            return LineNumbers(BY_POSITION, APPROXIMATE, parquet)

        rows = self.cursor().execute(f"SELECT COUNT(*) FROM read_parquet({sql_path(parquet)})").fetchone()[0]
        lines = physical_lines(source)
        if lines == rows + 1:
            return LineNumbers(BY_POSITION, EXACT, parquet)
        if rows > SLOW_PATH_ROW_LIMIT:
            return LineNumbers(BY_POSITION, APPROXIMATE, parquet)

        kept = kept_record_lines(source)
        if kept is None or len(kept) != rows:
            # The two readers disagree about which records exist, so neither
            # numbering can be trusted to pair with the right row.
            return LineNumbers(BY_POSITION, APPROXIMATE, parquet)

        numbered = parquet.with_suffix(".lines.parquet")
        listing = parquet.with_suffix(".lines.txt")
        try:
            listing.write_text("".join(f"{line}\n" for line in kept), encoding="ascii")
            # A positional join pairs the n-th kept row with the n-th line,
            # which is exactly the correspondence `kept_record_lines` builds.
            self.con.execute(f"""COPY (
                    SELECT r.*, l."{LINE_COLUMN}"
                    FROM read_parquet({sql_path(parquet)}) r
                    POSITIONAL JOIN read_csv({sql_path(listing)}, HEADER = FALSE,
                                             COLUMNS = {{'{LINE_COLUMN}': 'BIGINT'}}) l
                ) TO {sql_path(numbered)} (FORMAT PARQUET, COMPRESSION ZSTD)""")
            numbered.replace(parquet)
        finally:
            listing.unlink(missing_ok=True)
            numbered.unlink(missing_ok=True)
        return LineNumbers(BY_COLUMN, EXACT, parquet)

    def _line_quality(self, table: str) -> str | None:
        """The manifest's record of a table's line numbers, if it has any."""
        numbered = self.lines.get(table)
        return numbered.quality if numbered else None

    def line_source(self, table: str) -> str | None:
        """A relation with the table's columns plus `_line`, or None.

        Separate from the view so that the line costs nothing unless a query
        asks for it - which matters for the window over a CSV view, a scan of
        the whole file each time.
        """
        numbered = self.lines.get(table)
        if numbered is None:
            return None
        if numbered.storage == BY_COLUMN and numbered.parquet:
            return f"(SELECT * FROM read_parquet({sql_path(numbered.parquet)}))"
        if numbered.storage == BY_POSITION and numbered.parquet:
            return (
                f'(SELECT * EXCLUDE (file_row_number), file_row_number + 2 AS "{LINE_COLUMN}" '
                f"FROM read_parquet({sql_path(numbered.parquet)}, file_row_number = true))"
            )
        return f'(SELECT *, row_number() OVER () + 1 AS "{LINE_COLUMN}" FROM "{table}")'

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
