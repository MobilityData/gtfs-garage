"""Application factory."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from gtfs_garage import __version__
from gtfs_garage.server.routes import router
from gtfs_garage.server.state import FeedRegistry

BUILD_COMMAND = "cd web && yarn install && yarn build"

# Released wheels carry the built frontend, but a source checkout does not: the
# build output is not in version control. Say so plainly instead of failing with
# a missing-directory error.
FRONTEND_MISSING_PAGE = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>GTFS Garage</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>The frontend has not been built</h1>
<p>The API is running, but there is no interface to serve. From a source checkout, build it:</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">{BUILD_COMMAND}</pre>
<p>Then reload this page. Installed releases include the built interface already.</p>
</body></html>
"""


def web_root() -> Path:
    """Directory holding the built frontend, resolved from the installed package."""
    return Path(str(resources.files("gtfs_garage").joinpath("web")))


def frontend_is_built() -> bool:
    return (web_root() / "index.html").is_file()


DEFAULT_BASEMAP = "openfreemap"
BASEMAP_ENV_VAR = "GTFS_GARAGE_BASEMAP"
FEED_ENV_VAR = "GTFS_GARAGE_FEED"
NO_PARQUET_ENV_VAR = "GTFS_GARAGE_NO_PARQUET"


def create_app(
    feed_path: str | None = None,
    basemap: str | None = None,
    optimise: bool | None = None,
) -> FastAPI:
    """Build an app, optionally with a feed already loaded.

    A factory rather than a module-level instance so tests can create isolated
    apps, each with their own feed.

    `basemap` names a preset the interface knows ("openfreemap", "esri", "osm",
    "carto", "none"), or gives a raster tile template or vector style URL. It
    falls back to the GTFS_GARAGE_BASEMAP environment variable.

    `optimise` rewrites the feed as Parquet at load; see `GtfsFeed`. Falls back
    to GTFS_GARAGE_NO_PARQUET being unset.

    Both arguments fall back to environment variables so this works as a uvicorn
    factory, which is what `--reload` needs and so what the dev loop uses.
    """
    if optimise is None:
        optimise = not os.environ.get(NO_PARQUET_ENV_VAR)
    registry = FeedRegistry(optimise=optimise)
    feed_path = feed_path or os.environ.get(FEED_ENV_VAR) or None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        registry.close()  # release the DuckDB connection and any uploaded files

    app = FastAPI(title="GTFS Garage", version=__version__, lifespan=lifespan)
    # GeoJSON is repetitive text and compresses roughly sevenfold, which is the
    # difference between a large feed's map arriving and the tab dying.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.feeds = registry
    app.state.basemap = basemap or os.environ.get(BASEMAP_ENV_VAR) or DEFAULT_BASEMAP

    if feed_path:
        registry.load(feed_path)
        # A feed named on the command line finishes before the server accepts a
        # request, so nothing is in progress by the time anyone can ask.
        registry.finish_load()

    app.include_router(router)

    static_root = web_root()
    if static_root.is_dir():
        app.mount("/static", StaticFiles(directory=static_root), name="static")

    # response_model=None: the return type is a union of Response subclasses,
    # which FastAPI would otherwise try to turn into a response model.
    @app.get("/", include_in_schema=False, response_model=None)
    def index() -> Response:
        if not frontend_is_built():
            return HTMLResponse(FRONTEND_MISSING_PAGE, status_code=503)
        return FileResponse(static_root / "index.html")

    return app
