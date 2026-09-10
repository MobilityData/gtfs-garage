"""Loads a GTFS feed (zip file or already-extracted folder) into DuckDB views,
one per .txt file, so the rest of the app can query it with SQL without a
separate import/ETL step - this is what lets a large feed stay responsive.
"""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path


class GtfsLoadError(Exception):
    pass


class GtfsFeed:
    def __init__(self, source_path: str):
        import duckdb

        self.source_path = Path(source_path).expanduser()
        self._extract_dir: Path | None = None
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
            if (self.source_path / "stops.txt").exists():
                return self.source_path
            nested = next(self.source_path.rglob("stops.txt"), None)
            return nested.parent if nested else self.source_path

        if self.source_path.suffix.lower() == ".zip":
            self._extract_dir = Path(tempfile.mkdtemp(prefix="gtfs-garage-"))
            try:
                with zipfile.ZipFile(self.source_path) as zf:
                    zf.extractall(self._extract_dir)
            except zipfile.BadZipFile as exc:
                raise GtfsLoadError(f"Not a valid zip file: {self.source_path}") from exc
            # Real-world GTFS zips sometimes wrap the .txt files in a single
            # subfolder (e.g. exported from GitHub) instead of putting them
            # at the archive root.
            nested = next(self._extract_dir.rglob("stops.txt"), None)
            return nested.parent if nested else self._extract_dir

        raise GtfsLoadError(f"Expected a .zip file or a folder, got: {self.source_path}")

    def _load_tables(self) -> None:
        for txt_file in sorted(self.data_dir.glob("*.txt")):
            table_name = txt_file.stem
            escaped_path = str(txt_file).replace("'", "''")
            try:
                self.con.execute(
                    f"""
                    CREATE VIEW "{table_name}" AS
                    SELECT * FROM read_csv(
                        '{escaped_path}',
                        ALL_VARCHAR = TRUE,
                        IGNORE_ERRORS = TRUE,
                        NULLSTR = ''
                    )
                    """
                )
            except Exception:
                # Skip files DuckDB can't parse (e.g. empty files) rather than
                # failing the whole feed load over one optional file.
                continue
            columns = [row[0] for row in self.con.execute(f'DESCRIBE "{table_name}"').fetchall()]
            self.tables[table_name] = columns

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
