"""Loads a GTFS feed (zip file or already-extracted folder) into DuckDB views,
one per .txt file, so the rest of the app can query it with SQL without a
separate import/ETL step - this is what lets a large feed stay responsive.
"""

from __future__ import annotations

import shutil
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path


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
    # Declaring the view, which is all opening a feed does. DuckDB views are
    # lazy, so this is near zero by design - it is not where a slow feed goes.
    register_ms: float
    columns: int
    # Filled in later, by the pass that actually scans the file.
    row_count: int | None = None
    count_ms: float | None = None


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
    def total_ms(self) -> float:
        return (self.extract_ms or 0.0) + self.register_ms + self.count_ms


class GtfsFeed:
    def __init__(self, source_path: str):
        import duckdb

        self.source_path = Path(source_path).expanduser()
        self._extract_dir: Path | None = None
        self.stats = FeedStats()
        # Populated from the archive before extraction; empty for a folder.
        self._compressed_sizes: dict[str, int] = {}
        self.data_dir = self._resolve_data_dir()
        self.con = duckdb.connect(database=":memory:")
        self.tables: dict[str, list[str]] = {}
        self._load_tables()
        if not self.tables:
            self.close()
            raise GtfsLoadError(f"No GTFS .txt files found under {self.data_dir}")

    def _resolve_data_dir(self) -> Path:
        if not self.source_path.exists():
            raise GtfsLoadError(f"Path does not exist: {self.source_path}")

        if self.source_path.is_dir():
            data_dir = self.source_path
            if not (self.source_path / "stops.txt").exists():
                nested = next(self.source_path.rglob("stops.txt"), None)
                data_dir = nested.parent if nested else self.source_path
            self.stats.source_bytes = sum(f.stat().st_size for f in data_dir.glob("*.txt"))
            return data_dir

        if self.source_path.suffix.lower() == ".zip":
            self.stats.source_bytes = self.source_path.stat().st_size
            self._extract_dir = Path(tempfile.mkdtemp(prefix="gtfs-garage-"))
            started = time.perf_counter()
            try:
                with zipfile.ZipFile(self.source_path) as zf:
                    # Read the directory before extracting: it carries the
                    # compressed size per member, which the files on disk lose.
                    self._compressed_sizes = {Path(info.filename).name: info.compress_size for info in zf.infolist()}
                    zf.extractall(self._extract_dir)
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
        self.stats.register_ms = _elapsed_ms(started)

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
        if self._extract_dir and self._extract_dir.exists():
            shutil.rmtree(self._extract_dir, ignore_errors=True)
