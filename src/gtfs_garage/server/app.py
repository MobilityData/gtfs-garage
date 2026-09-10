"""Application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import resources
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from gtfs_garage import __version__
from gtfs_garage.server.routes import router
from gtfs_garage.server.state import FeedRegistry


def web_root() -> Path:
    """Directory holding the built frontend, resolved from the installed package."""
    return Path(str(resources.files("gtfs_garage").joinpath("web")))


def create_app(feed_path: str | None = None) -> FastAPI:
    """Build an app, optionally with a feed already loaded.

    A factory rather than a module-level instance so tests can create isolated
    apps, each with their own feed.
    """
    registry = FeedRegistry()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        registry.close()  # release the DuckDB connection and any uploaded files

    app = FastAPI(title="GTFS Garage", version=__version__, lifespan=lifespan)
    app.state.feeds = registry

    if feed_path:
        registry.load(feed_path)

    app.include_router(router)

    static_root = web_root()
    app.mount("/static", StaticFiles(directory=static_root), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(static_root / "index.html")

    return app
