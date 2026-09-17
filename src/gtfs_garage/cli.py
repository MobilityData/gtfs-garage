#
#   MobilityData 2026
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#        http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
#
"""Command line entry point: `gtfs-garage <feed>` serves the browser UI."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
import threading
import webbrowser

import uvicorn

from gtfs_garage import __version__
from gtfs_garage.core.feed import GtfsFeed, GtfsLoadError
from gtfs_garage.server.app import (
    BASEMAP_ENV_VAR,
    BUILD_COMMAND,
    create_app,
    frontend_is_built,
)

DEFAULT_PORT = 8811
DEFAULT_HOST = "127.0.0.1"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gtfs-garage",
        description="Browse a GTFS feed locally: cross-referenced tables, filters and a map.",
    )
    parser.add_argument(
        "feed",
        nargs="?",
        help="GTFS zip file or an extracted GTFS folder. Omit to choose one in the browser.",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"default: {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"default: {DEFAULT_PORT}")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab on start")
    parser.add_argument(
        "--basemap",
        default=None,
        metavar="NAME|URL",
        help=(
            "map backdrop: openfreemap (default), esri, osm, carto, none, "
            "or a tile template or style URL. Also read from $" + BASEMAP_ENV_VAR
        ),
    )
    parser.add_argument(
        "--no-parquet",
        action="store_true",
        help=(
            "read the CSVs in place instead of rewriting the feed as Parquet at load. "
            "Opening is a little quicker; every query afterwards is much slower and the "
            "extracted feed stays on disk in full"
        ),
    )
    parser.add_argument(
        "--export",
        metavar="DIR",
        help=(
            "convert the feed to Parquet in DIR and exit instead of serving. "
            "One file per table, every column text, which is what a browser "
            "reads over range requests"
        ),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def _export(feed_path: str | None, destination: str) -> int:
    """Write the feed out as Parquet, the artifact a browser can query."""
    if not feed_path:
        print("error: --export needs a feed to convert", file=sys.stderr)
        return 1

    try:
        feed = GtfsFeed(feed_path, optimise=False)
    except GtfsLoadError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    try:
        written = feed.export_parquet(Path(destination))
    finally:
        feed.close()

    total = sum(f.stat().st_size for f in written)
    tables = [f for f in written if f.suffix == ".parquet"]
    print(f"wrote {len(tables)} tables and a manifest to {destination} ({total / 1_000_000:.1f} MB)")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.export:
        return _export(args.feed, args.export)

    try:
        app = create_app(args.feed, args.basemap, optimise=not args.no_parquet)
    except GtfsLoadError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not frontend_is_built():
        print(
            f"warning: the frontend has not been built, so only the API will respond.\n"
            f"         build it with: {BUILD_COMMAND}",
            file=sys.stderr,
        )

    url = f"http://{args.host}:{args.port}"
    print(f"GTFS Garage running at {url}")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
