# gtfs-garage-core

The library behind [GTFS Garage](https://github.com/MobilityData/gtfs-garage): load a GTFS feed into DuckDB, convert it to Parquet, and query it. No web server and no interface. It depends only on `duckdb`.

```bash
pip install gtfs-garage-core
```

```python
from pathlib import Path

from gtfs_garage_core import GtfsFeed, query_table

feed = GtfsFeed("feed.zip")
print(query_table(feed, "routes", page=1, page_size=20))
feed.export_parquet(Path("out"))  # {table}.parquet + manifest.json
feed.close()
```

## Converting one table at a time

`gtfs_garage_core.convert` does the conversion without a `GtfsFeed`, one table at a time, so peak memory tracks the largest table rather than the whole feed:

```python
from pathlib import Path

import duckdb
from gtfs_garage_core.convert import convert_table, manifest_entry, register_table, write_manifest

con = duckdb.connect()
columns = register_table(con, "stops", Path("stops.txt"))
convert_table(con, "stops", Path("out/stops.parquet"))
```

The output is the dataset GTFS Garage's viewer reads, in the browser or on a server. Every column is text, and empty fields are NULL. The manifest records each table's rows and sizes.

`gtfs-garage` is released together with this package and depends on its exact version. Code that imports `gtfs_garage.core` keeps working: it is the same package under its old name.
