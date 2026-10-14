"""What the load dialog offers on a start with no feed.

The feeds the workdir already holds are the cheapest answer there - already
Parquet, so no download, unzip or conversion - and that is the whole reason the
workdir is kept. Whether they are actually on screen is a question about built
markup, a config fetch and a workspace fetch agreeing with each other, which the
unit tests each answer separately and none answers together.

Marked `browser` and excluded from the default suite; see tests/browser/
test_map_memory.py for the setup it needs.
"""

from __future__ import annotations

import shutil
import socket
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

from gtfs_garage.server.app import create_app, frontend_is_built

pytestmark = pytest.mark.browser

FEED = Path(__file__).resolve().parents[1] / "data" / "mini-gtfs"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    """A workdir holding one feed, as a previous run would have left it."""
    directory = tmp_path / "work"
    copied = tmp_path / "montreal"
    shutil.copytree(FEED, copied)
    with TestClient(create_app(workdir=str(directory))) as client:
        client.post("/api/load", params={"path": str(copied)})
    return directory


@pytest.fixture()
def page(workdir: Path):
    """The app on a real port, started on that workdir with nothing loaded."""
    if not frontend_is_built():
        pytest.skip("the frontend has not been built; run `yarn build` in web/")
    playwright = pytest.importorskip("playwright.sync_api")

    port = free_port()
    # `--no-reopen`'s effect: the dialog is the subject, so the feed the workdir
    # names must not be opened out from under it.
    app = create_app(workdir=str(workdir), basemap="none", open_startup=False)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 60
    while not server.started and time.time() < deadline:
        time.sleep(0.1)
    assert server.started, "the server did not come up"

    with playwright.sync_playwright() as pw:
        browser = pw.chromium.launch()
        opened = browser.new_page(viewport={"width": 900, "height": 800})
        opened.goto(f"http://127.0.0.1:{port}", wait_until="networkidle")
        opened.wait_for_selector('[data-el="load-overlay"]:not(.hidden)', timeout=30_000)
        yield opened
        browser.close()

    server.should_exit = True
    thread.join(timeout=30)


def rows(page):
    return page.locator('[data-el="recent-feeds"] button')


def test_the_dialog_opens_by_itself_when_no_feed_is_loaded(page):
    assert page.locator('[data-el="load-overlay"]').is_visible()


def test_the_workdir_feeds_are_on_screen_above_the_ways_of_fetching_one(page):
    assert page.locator('[data-el="recent-section"]').is_visible()
    assert rows(page).count() == 1
    assert "montreal" in rows(page).first.inner_text()


def test_one_click_serves_a_stored_feed(page):
    rows(page).first.click()
    page.wait_for_selector('[data-el="load-overlay"]', state="hidden", timeout=30_000)
    # The feed is being browsed, not merely acknowledged.
    assert "montreal" in page.locator('[data-el="source-label"]').inner_text()
    assert page.locator('[data-el="sidebar"]').inner_text().strip()
