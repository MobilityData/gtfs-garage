"""The one performance property only a real browser can measure.

A user loading a 4.5 GB feed hit Chrome's "Aw, Snap!" - an out-of-memory kill -
after the map had drawn and they clicked a table. Nothing server-side can see
that: the payloads were already streamed, compressed and inside their vertex
budget. What killed the tab was the live JS heap, which is what MapLibre holds,
what the page holds, and whatever the page forgot to let go of.

So this drives a real Chromium against the real app and watches the heap. It is
marked `browser` and excluded from the default suite, because it needs a browser
binary and a built frontend:

    pip install -e ".[dev,perf]" && playwright install chromium
    (cd web && yarn install && yarn build)
    pytest -m browser
"""

from __future__ import annotations

import importlib.util
import socket
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from gtfs_garage.server.app import create_app, frontend_is_built

pytestmark = pytest.mark.browser

# Large enough to cross MAX_MAP_VERTICES so the thinning path runs, and to put
# enough on the map that a leak shows. Not an attempt to reproduce the largest
# real feeds - the guard is the shape of memory use, not its absolute size.
STOPS = 60_000
SHAPES = 12_000
ROUTES = 3_000
POINTS_PER_SHAPE = 60

# What drawing the map may add to the tab, over a baseline measured with the map
# hidden.
#
# A delta rather than a total, because a total is too blunt to fail: most of the
# tab is MapLibre, the basemap and the page, so doubling the geometry barely
# moves it. Measured against a 600 MB ceiling on total heap, every regression
# tried - doubling the vertex budget, adding two properties to every stop -
# still passed. Against the delta they are the majority of the number.
#
# Measured on this feed: drawing every layer adds about 130 MB. Doubling the
# geometry - by giving each layer its own vertex budget again - takes it to
# about 200 MB. The ceiling sits between the two, with room for the variance
# between runs and runners but not enough to sleep through a doubling.
MAX_MAP_HEAP_MB = 170

# Installed before any page script. The map is started hidden so the tab can be
# weighed without it - the app skips fetching layers entirely while hidden - and
# the sampler has to be running before the first frame, since a sampler attached
# after navigation misses the peak and reports zero.
PEAK_SAMPLER = """
try { localStorage.setItem('gtfs-garage.map-visible', '0'); } catch (e) {}
window.__peak = 0;
setInterval(() => {
  window.__peak = Math.max(window.__peak, Math.round(performance.memory.usedJSHeapSize / 1048576));
}, 200);
"""


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def load_write_feed():
    """The generated-feed helper from tests/conftest.py, without importing the
    whole test package."""
    spec = importlib.util.spec_from_file_location("_feed_builder", Path(__file__).resolve().parents[1] / "conftest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.write_feed


@pytest.fixture(scope="module")
def served_feed(tmp_path_factory):
    """The real app, serving a generated feed, on a real port."""
    if not frontend_is_built():
        pytest.skip("the frontend has not been built; run `yarn build` in web/")

    directory = load_write_feed()(tmp_path_factory.mktemp("perf") / "feed", STOPS, SHAPES, POINTS_PER_SHAPE, ROUTES)
    port = free_port()
    server = uvicorn.Server(
        uvicorn.Config(create_app(str(directory)), host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 120
    while not server.started and time.time() < deadline:
        time.sleep(0.2)
    assert server.started, "the server did not come up"

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=30)


@pytest.fixture()
def page(served_feed):
    playwright = pytest.importorskip("playwright.sync_api")
    with playwright.sync_playwright() as pw:
        # performance.memory only carries real numbers with precise info on.
        browser = pw.chromium.launch(args=["--enable-precise-memory-info"])
        opened = browser.new_page(viewport={"width": 1400, "height": 900})
        opened.crashes = []  # type: ignore[attr-defined]
        opened.on("crash", lambda _: opened.crashes.append(True))  # type: ignore[attr-defined]
        opened.add_init_script(PEAK_SAMPLER)
        opened.goto(served_feed, wait_until="domcontentloaded")
        yield opened
        browser.close()


def heap_mb(page) -> int:
    return page.evaluate("() => Math.round(performance.memory.usedJSHeapSize / 1048576)")


def baseline_then_draw(page) -> int:
    """Weigh the tab without the map, then draw it and return what it added."""
    page.wait_for_selector('[data-el="sidebar"] .table-tab')
    page.wait_for_timeout(1500)
    before = heap_mb(page)

    page.click('[data-el="toggle-map-btn"]')  # the app only fetches layers once shown
    wait_until_drawn(page)
    return peak_mb(page) - before


def wait_until_drawn(page) -> None:
    """Block until every map layer has finished arriving."""
    page.wait_for_function(
        """() => { const e = document.querySelector('[data-el="map-progress"]');
             return e.hidden || e.textContent.includes('simplified'); }""",
        timeout=300_000,
    )


def peak_mb(page) -> int:
    peak = page.evaluate("() => window.__peak")
    assert peak, "the heap sampler never ran"
    return peak


def test_drawing_the_whole_map_stays_inside_its_memory_budget(page):
    cost = baseline_then_draw(page)
    assert not page.crashes, "the tab crashed while drawing the map"
    assert cost < MAX_MAP_HEAP_MB, f"the map added {cost} MB, budget {MAX_MAP_HEAP_MB} MB"


def test_browsing_tables_with_the_map_drawn_does_not_exhaust_the_tab(page):
    """The exact sequence that produced "Aw, Snap!": draw everything, then open
    a table. It died because the map had left the tab no headroom."""
    cost = baseline_then_draw(page)
    for table in ("stops", "shapes", "trips", "stop_times"):
        page.click(f".table-tab:has-text('{table}')")
        page.wait_for_timeout(1500)
        assert not page.crashes, f"the tab crashed after opening {table}"

    assert cost < MAX_MAP_HEAP_MB, f"the map added {cost} MB, budget {MAX_MAP_HEAP_MB} MB"
