"""Application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib import resources
from pathlib import Path

from fastapi import FastAPI, Response
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
