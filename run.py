"""Local entrypoint: `python run.py path/to/feed.zip` starts a server on
localhost and opens it in your browser. You can also start it with no path
and load a feed from the browser (drag a zip, or paste a local path).
"""

from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from app.main import app, load_feed_from_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local GTFS Garage.")
    parser.add_argument(
        "path", nargs="?", help="Path to a GTFS zip file or an already-extracted GTFS folder."
    )
    parser.add_argument("--port", type=int, default=8811)
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open a browser tab.")
    args = parser.parse_args()

    if args.path:
        load_feed_from_path(args.path)

    url = f"http://127.0.0.1:{args.port}"
    print(f"GTFS Garage running at {url}")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
