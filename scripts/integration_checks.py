"""Drive each way the viewer can be deployed, in a real browser.

The unit test suites cover the pieces. This covers the configurations, which is
where the defects have actually been: a Back button that only existed inside
the file browser was invisible in an embedded viewer the moment a derived view
was open, and no unit test could have seen it because nothing was wrong with
either piece on its own.

Four checks, one per integration:

    local      the standalone application: load dialog, options menu, map, and
               the browser's own history
    embedded   a host's page: the browse half alone, with a private back stack
    rest       a host mounting the REST source itself, with a map
    static     Parquet on a static host, read in the browser by DuckDB-WASM

Each one starts what it needs, drives it with Playwright, asserts what that
configuration promises, and tears everything down.

**Every check that starts a server passes it a workdir of its own.** A server
without one takes the shared directory under the platform cache - the user's
own - and evicts their feeds to stay within `--workdir-keep`. That is not
hypothetical; it happened while this file was being written.
"""

from __future__ import annotations

import argparse
import contextlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date as _date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE = REPO_ROOT / "tests" / "data" / "explore-gtfs"
# A demand-responsive feed, compared as well as the fixed-schedule one: routes
# named only by their long name, an empty stops.txt, zones instead of stops and
# booking windows instead of departure times. Three crashes came out of a real
# one, so both implementations are held to it.
FLEX_FIXTURE = REPO_ROOT / "tests" / "data" / "demand-gtfs"

# Ports are fixed rather than found, so a failed run leaves a port anyone can
# check by hand rather than one the next run has to guess.
API_PORT = 8821
DEV_PORT = 8822
STATIC_PORT = 8823

VIEWPORT = {"width": 1400, "height": 950}


@dataclass
class Result:
    name: str
    checks: list[tuple[str, bool, str]] = field(default_factory=list)

    def expect(self, label: str, condition: bool, detail: str = "") -> None:
        self.checks.append((label, bool(condition), detail))

    @property
    def ok(self) -> bool:
        return all(passed for _, passed, _ in self.checks)

    def report(self) -> None:
        print(f"\n{self.name}")
        for label, passed, detail in self.checks:
            mark = "  ok  " if passed else "  FAIL"
            print(f"{mark}  {label}{f' - {detail}' if detail else ''}")


def _free(port: int) -> bool:
    """Whether a port can be bound right now."""
    import socket

    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _require_ports() -> str | None:
    """Why this run cannot start, if something is already on its ports.

    The ports are fixed so that a failed run leaves one anyone can check by
    hand. The cost is that two runs cannot overlap - and when they do, what
    surfaces is a cascade of connection refusals and "address already in use"
    that looks like a dozen broken assertions. Said once, up front, instead.
    """
    taken = [port for port in (API_PORT, DEV_PORT, STATIC_PORT) if not _free(port)]
    if not taken:
        return None
    return (
        f"ports {', '.join(str(port) for port in taken)} are in use. "
        "These checks bind fixed ports, so only one run at a time - wait for the other to finish, "
        "or stop whatever is holding them."
    )


def _wait_for(url: str, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except (urllib.error.URLError, OSError, ConnectionError) as exc:
            last = str(exc)
            time.sleep(0.3)
    raise RuntimeError(f"{url} never answered ({last})")


@contextlib.contextmanager
def api_server(feed: Path, workdir: Path, port: int = API_PORT):
    """A GTFS Garage server on a workdir of its own. See the module docstring."""
    import uvicorn

    from gtfs_garage.server.app import create_app

    app = create_app(str(feed), workdir=str(workdir))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        _wait_for(f"http://127.0.0.1:{port}/api/config")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@contextlib.contextmanager
def dev_server(port: int = DEV_PORT, api_port: int = API_PORT):
    """`yarn dev`, which serves the harness page and proxies /api."""
    process = subprocess.Popen(
        ["yarn", "dev", "--port", str(port), "--strictPort"],
        cwd=REPO_ROOT / "web",
        env={**_environment(), "GTFS_GARAGE_API_PORT": str(api_port)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # localhost, not 127.0.0.1: Vite binds the hostname, and on a machine
        # with IPv6 the two are not the same socket.
        _wait_for(f"http://localhost:{port}/integration-harness.html")
        yield f"http://localhost:{port}"
    finally:
        process.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)


class _BucketHandler(SimpleHTTPRequestHandler):
    """A file server that behaves the way the dataset bucket does.

    Two properties the viewer depends on, and `python -m http.server` has
    neither - which is why this exists rather than that:

    **CORS.** The bucket answers `GET` and `HEAD` from any origin with every
    header exposed, because a page on one origin reads Parquet from another.
    Serving the files without those headers tests nothing: the browser refuses
    the request before the reader sees it.

    **Range requests.** DuckDB-WASM reads a Parquet footer and then the row
    groups it needs, which is the whole reason a gigabyte file is openable in a
    tab. A server that answers `200` with the entire body instead lets the
    check pass while hiding that the reader fell back to downloading everything.
    """

    def log_message(self, *_args) -> None:  # noqa: D102 - quiet by design
        pass

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "*")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802 - the handler's own naming
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        wanted = self.headers.get("Range")
        if not wanted or not wanted.startswith("bytes="):
            return super().do_GET()

        path = Path(self.translate_path(self.path))
        if not path.is_file():
            return super().do_GET()

        size = path.stat().st_size
        first, _, last = wanted.removeprefix("bytes=").partition("-")
        try:
            start = int(first) if first else max(0, size - int(last))
            end = int(last) if first and last else size - 1
        except ValueError:
            return super().do_GET()
        end = min(end, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return

        with path.open("rb") as handle:
            handle.seek(start)
            body = handle.read(end - start + 1)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextlib.contextmanager
def static_server(directory: Path, port: int = STATIC_PORT):
    """An exported dataset served as the public bucket serves one."""
    handler = partial(_BucketHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _wait_for(f"http://127.0.0.1:{port}/manifest.json")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def _environment() -> dict[str, str]:
    import os

    return dict(os.environ)


@contextlib.contextmanager
def browser_page(record_errors: list[str]):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)
        page.on("pageerror", lambda error: record_errors.append(str(error)))
        page.on(
            "console",
            lambda message: record_errors.append(message.text) if message.type == "error" else None,
        )
        try:
            yield page
        finally:
            browser.close()


def _noise(errors: list[str]) -> list[str]:
    """Console output that is not the viewer's fault.

    A favicon this harness does not serve, and the 409 a server with no feed
    answers while the load dialog is open - which is the documented behaviour
    rather than a failure.
    """
    return [
        error
        for error in errors
        if "favicon" not in error and "409" not in error and "No GTFS feed loaded" not in error
    ]


def _appears(page, selector: str, timeout: float = 25_000) -> bool:
    """Wait for something to turn up, rather than sleeping and hoping.

    The browser-Parquet path starts a WebAssembly engine and reads Parquet over
    range requests, so the same click can take a hundred milliseconds or several
    seconds depending on what is already cached. Fixed sleeps make that a flake;
    waiting for the thing itself makes it a wait.
    """
    try:
        page.locator(selector).first.wait_for(timeout=timeout)
        return True
    except Exception:  # noqa: BLE001 - absence is the answer, not an error
        return False


def _open_screen(page, label: str) -> None:
    """Switch to Explore if needed, then open that screen."""
    if page.locator("[data-el='mode-explore']").count():
        page.locator("[data-el='mode-explore']").click()
        page.wait_for_timeout(400)
    page.get_by_text(label, exact=True).first.click()
    page.wait_for_timeout(1200)


def _open_file(page, name: str) -> None:
    """Switch to Files, then open that GTFS file in the raw browser."""
    if page.locator("[data-el='mode-files']").count():
        page.locator("[data-el='mode-files']").click()
        page.wait_for_timeout(400)
    page.get_by_text(name, exact=True).first.click()
    page.wait_for_timeout(1200)


def check_local(result: Result) -> None:
    """The standalone application, served from the Python package."""
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gg-local-") as workdir:
        with api_server(FIXTURE, Path(workdir)) as base:
            with browser_page(errors) as page:
                page.goto(base, wait_until="networkidle")
                page.wait_for_timeout(2000)

                result.expect("lands on the overview", "view=overview" in page.url, page.url)
                result.expect("offers the derived views", page.locator("[data-el='explore-tab']").count() == 3)
                result.expect(
                    "the two halves are a switch, not one mixed list",
                    page.locator("[data-el='mode-switch']").is_visible()
                    and page.locator(".table-tab:not(.explore-tab)").count() == 0,
                )
                # Nothing is filtered until someone asks. A page that arrives
                # already narrowed by a day nobody picked is the confusion this
                # control was rearranged to remove.
                result.expect(
                    "nothing is filtered by date to begin with",
                    page.locator("[data-el='date-chip']").is_hidden() and "date=" not in page.url,
                    page.url,
                )

                _open_file(page, "stops")
                result.expect("Files still lists every file", page.locator(".table-tab").count() >= 7)
                result.expect("and still browses rows", page.locator("[data-el='table-scroll'] tbody tr").count() > 0)
                result.expect("has the application's own parts",
                              page.locator("[data-el='open-load-btn']").count() == 1
                              and page.locator("[data-el='options-btn']").count() == 1)

                _open_screen(page, "Service days")
                result.expect(
                    "service periods are drawn as bands over the feed's range",
                    page.locator(".periods .period-bar").count() > 0,
                )
                result.expect(
                    "and the dates the schedule changes are listed",
                    page.locator(".change-list li").count() > 0,
                )
                result.expect("a view is a shareable link", "view=calendar" in page.url, page.url)

                # Picking a day sets the date every view reads, and says so.
                page.locator(".periods .period-bar").first.click()
                page.wait_for_timeout(1500)
                result.expect(
                    "picking a day moves the whole viewer to it",
                    page.locator("[data-el='date-chip']").is_visible() and "date=" in page.url,
                    page.url,
                )
                chosen = page.locator("[data-el='date-chip-day']").inner_text()
                result.expect("and the chip names the day in full", "20" in chosen, chosen)

                # And the chip carries its own way out.
                page.locator("[data-el='date-clear']").click()
                page.wait_for_timeout(1200)
                result.expect(
                    "clearing it stops filtering again",
                    page.locator("[data-el='date-chip']").is_hidden() and "date=" not in page.url,
                    page.url,
                )

                # The facets: counts first, filtering second. A reader learns
                # the feed has one rail route and one without a colour by
                # reading the row, before clicking anything in it.
                _open_screen(page, "Routes")
                result.expect(
                    "the route list offers facets, each option carrying a count",
                    page.locator(".facet-row").count() >= 3
                    and page.locator(".facet-chip .chip-count").count() >= 6,
                    f"{page.locator('.facet-row').count()} rows, {page.locator('.facet-chip').count()} chips",
                )
                before = page.locator(".route-row").count()
                page.locator(".facet-row", has_text="Mode").locator(".facet-chip").first.click()
                page.wait_for_timeout(1200)
                result.expect(
                    "choosing one narrows the list and says what is in force",
                    page.locator(".route-row").count() < before
                    and "of" in page.locator(".facet-summary").inner_text(),
                    page.locator(".facet-summary").inner_text().replace("\n", " ")[:90],
                )
                # Shareable, like every other state this viewer can be in.
                result.expect("and the filter is in the URL", "mode=" in page.url, page.url)
                page.locator(".facet-summary a.explore-link").click()
                page.wait_for_timeout(1200)
                result.expect(
                    "clearing it shows every route again",
                    page.locator(".route-row").count() == before and "mode=" not in page.url,
                    page.url,
                )

                page.locator(".route-row").first.click()
                page.wait_for_timeout(1500)
                result.expect("a route opens", page.locator(".route-card").count() == 1)
                result.expect("the route is in the URL", "view=route&arg=" in page.url, page.url)

                # The route's lines *and* its stops: a line with no stops on it
                # does not answer "where does it go", which is what the card is
                # for. Hiding every stop was the first version of this.
                focus = page.locator(".map-controls .explore-hint").inner_text()
                result.expect(
                    "the route takes the map on its own, with its stops",
                    "this route and its" in focus and "stops" in focus,
                    focus.replace("\n", " ")[:90],
                )
                # Showing the surroundings is not deselecting the route: the
                # line someone opened the card to look at has to stay picked
                # out, or the checkbox is a way of losing it.
                page.locator(".map-controls input[type=checkbox]").check()
                page.wait_for_timeout(2500)
                shown = page.locator(".map-controls .explore-hint").inner_text()
                result.expect(
                    "the rest of the network can be shown behind the route",
                    "picked out against the rest" in shown,
                    shown.replace("\n", " ")[:90],
                )
                page.locator(".map-controls input[type=checkbox]").uncheck()
                page.wait_for_timeout(2000)
                result.expect(
                    "and hidden again",
                    "this route and its" in page.locator(".map-controls .explore-hint").inner_text(),
                )

                result.expect(
                    "a stop pattern says how much of the route it is",
                    "of" in page.locator(".route-card .pattern-head").first.inner_text()
                    and "%" in page.locator(".route-card .pattern-head").first.inner_text(),
                    page.locator(".route-card .pattern-head").first.inner_text().replace("\n", " ")[:90],
                )

                # The bug this exists for: a route whose trips name no shape
                # has no geometry in the feed, and focusing it emptied the map
                # while the card went on claiming to show the route.
                page.goto(f"{base}/?view=route&arg=101", wait_until="networkidle")
                page.wait_for_timeout(4000)
                note = page.locator(".map-controls .explore-hint").inner_text()
                result.expect(
                    "a route with no shapes falls back to its stops and says so",
                    "no shapes in the feed" in note and "stops are shown instead" in note,
                    note.replace("\n", " ")[:90],
                )
                result.expect(
                    "and leaves the network drawn to orient by",
                    page.evaluate(
                        "() => !!document.querySelector('[data-el=map] canvas')"
                    ),
                )

                # The routes figure opens the routes view: someone clicking
                # "4 routes" is asking to see the routes, and routes.txt is a
                # row per route with none of what makes one recognisable.
                _open_screen(page, "Overview")
                page.locator(".stat-clickable").first.click()
                page.wait_for_timeout(1500)
                result.expect(
                    "the overview's routes figure opens the routes view",
                    "view=routes" in page.url and page.locator(".route-row").count() == 4,
                    page.url,
                )
                page.go_back()
                page.wait_for_timeout(1200)

                # An agency's route count filters, rather than landing on all of them.
                _open_screen(page, "Overview")
                page.locator(".agency-list a.explore-link").first.click()
                page.wait_for_timeout(1500)
                result.expect(
                    "an agency's routes are filtered to that agency",
                    page.locator(".routes h2").first.inner_text() == "City Transit",
                    page.locator(".routes h2").first.inner_text(),
                )
                result.expect("and the filter can be cleared", page.get_by_text("Show every route").count() == 1)

                # The timetable: the view a dispatcher works from. With no day
                # chosen it asks for one, offering dates the feed actually has.
                _open_screen(page, "Routes")
                page.locator(".route-row").nth(1).click()
                page.wait_for_timeout(1500)
                page.get_by_text("Timetable", exact=False).first.click()
                page.wait_for_timeout(2500)
                result.expect(
                    "with no day chosen, the timetable asks for one",
                    page.locator(".day-choice").count() > 0,
                )
                page.locator(".day-choice").first.click()
                page.wait_for_timeout(3000)
                result.expect(
                    "a timetable draws stops down and trips across",
                    page.locator("table.timetable .trip-head").count() > 1
                    and page.locator("table.timetable tbody tr").count() > 1,
                )
                result.expect(
                    "the map sits above it rather than beside",
                    page.locator("[data-el='content']").get_attribute("data-layout") == "above",
                )
                # Back and the chosen day stay at the top whichever way the map
                # is laid out. They used to live inside the browsing pane, which
                # put them halfway down the page under a map laid above it.
                result.expect(
                    "and Back stays above the map rather than under it",
                    page.evaluate(
                        "() => document.querySelector('[data-el=toolbar]').getBoundingClientRect().top"
                        " < document.querySelector('[data-el=map-pane]').getBoundingClientRect().top"
                    ),
                )
                # Selecting a trip frames the map on that trip rather than on
                # the whole route - a short working is a piece of the line, and
                # framing on all of it leaves the map where it was.
                page.locator("table.timetable .trip-head").nth(2).click()
                page.wait_for_timeout(2000)
                result.expect("selecting a trip picks it out", page.locator(".trip-head.selected").count() == 1)
                note = page.locator(".timetable .map-note").inner_text()
                result.expect(
                    "and says what the map is now showing",
                    "On the map" in note and "stop" in note,
                    note.replace("\n", " ")[:90],
                )

                # A stop row puts that stop on the map, which is the view's
                # other half: the grid says when, the map says where.
                page.locator("table.timetable .stop-name").nth(1).click()
                page.wait_for_timeout(2000)
                result.expect(
                    "a stop row centres the map on that stop and marks it",
                    page.locator(".stop-cell.selected").count() == 1
                    and page.evaluate("() => !!document.querySelector('.stop-mark')"),
                    page.locator(".timetable .map-note").inner_text().replace("\n", " ")[:90],
                )

                # Ids when they are wanted: the reason to want them is to go
                # and look something up with them somewhere else.
                names = page.locator("table.timetable .stop-name").first.inner_text()
                page.locator(".timetable-controls label", has_text="GTFS ids").locator("input").check()
                page.wait_for_timeout(800)
                ids = page.locator("table.timetable .stop-name").first.inner_text()
                result.expect("the grid can show GTFS ids instead of names", names != ids, f"{names} -> {ids}")
                page.locator(".timetable-controls label", has_text="GTFS ids").locator("input").uncheck()
                page.wait_for_timeout(800)

                # A cell is one row of stop_times.txt, and both ids that
                # identify it are in hand.
                page.locator("table.timetable .time-linked").first.click()
                page.wait_for_timeout(2000)
                result.expect(
                    "a time opens its own row in stop_times",
                    "table=stop_times" in page.url and "trip_id" in page.url and "stop_id" in page.url,
                    page.url[:120],
                )
                page.go_back()
                page.wait_for_timeout(2000)
                result.expect("the timetable is a shareable link", "view=timetable" in page.url, page.url)

                _open_file(page, "stop_times")
                result.expect("the raw file browser still works",
                              page.locator("[data-el='table-scroll'] tbody tr").count() > 0)
                result.expect("a file is a shareable link", "table=stop_times" in page.url, page.url)


                # Switching to Files is itself a navigation, so Back walks the
                # file views first and leaves Files on the step after - which is
                # what a reader who got there in two steps expects.
                opened = page.url
                page.go_back()
                page.wait_for_timeout(1500)
                result.expect(
                    "browser Back steps back through the files",
                    # Which file it lands on is not the point and is not fixed:
                    # switching to Files returns to the view left behind there,
                    # so the step before this one may be the same table under a
                    # different filter. Still in Files, and somewhere else, is
                    # what Back promises here.
                    "table=" in page.url
                    and page.url != opened
                    and page.locator("[data-el='table-pane']").is_visible(),
                    page.url,
                )
                page.go_back()
                page.wait_for_timeout(1500)
                result.expect(
                    "and then leaves Files behind",
                    page.locator("[data-el='table-pane']").is_hidden(),
                    page.url,
                )

# Filtering a file is a navigation like any other: it goes in
                # the stack, and it carries the day forward. Rebuilding the
                # view from scratch dropped the date, so a filter in Files
                # silently cleared what the Explore half was reading.
                page.goto(f"{base}/?table=trips&page=1&date=2026-01-01", wait_until="networkidle")
                page.wait_for_timeout(1500)
                page.locator("[data-el='add-filter-btn']").click()
                page.wait_for_timeout(400)
                page.locator("[data-el='filter-column']").select_option("route_id")
                page.locator("[data-el='filter-value']").fill("10")
                page.locator("[data-el='filter-apply-btn']").click()
                page.wait_for_timeout(1500)
                result.expect(
                    "filtering a file keeps the chosen day",
                    "date=2026-01-01" in page.url and "filters=" in page.url,
                    page.url[:110],
                )
                page.go_back()
                page.wait_for_timeout(1200)
                result.expect(
                    "and Back undoes the filter rather than the whole view",
                    "table=trips" in page.url and "filters=" not in page.url,
                    page.url,
                )

                # A hand-written link, which is what a shared one is.
                page.goto(f"{base}/?view=route&arg=RL", wait_until="networkidle")
                page.wait_for_timeout(1500)
                result.expect("a deep link opens its route",
                              "Regional Line" in page.locator(".explore h2").first.inner_text())

                result.expect("no console errors", not _noise(errors), "; ".join(_noise(errors))[:200])


def check_embedded(result: Result) -> None:
    """A host's own page: the browse half, and the host's address bar untouched."""
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gg-embedded-") as workdir:
        with api_server(FIXTURE, Path(workdir)), dev_server() as dev:
            url = f"{dev}/integration-harness.html?mode=embedded"
            with browser_page(errors) as page:
                page.goto(url, wait_until="networkidle")
                page.wait_for_timeout(2500)

                harness = page.evaluate("() => window.harness")
                result.expect("mounted as an embedded viewer",
                              harness and not harness["hasLoadDialog"] and not harness["hasOptionsMenu"])
                result.expect("builds none of the application's parts",
                              page.locator("[data-el='open-load-btn']").count() == 0
                              and page.locator("[data-el='options-btn']").count() == 0
                              and page.locator("[data-el='map-pane']").count() == 0)
                result.expect("offers the derived views", page.locator("[data-el='explore-tab']").count() == 3)

                _open_screen(page, "Service days")
                result.expect("the host's URL is untouched", page.url == url, page.url)
                result.expect("service days draws", page.locator(".periods .period-bar").count() > 0)

                # The regression this check exists for: with no browser history
                # behind it, the viewer's own Back is the only way back - and it
                # used to live inside the pane the derived views replace.
                result.expect("Back is reachable from a derived view",
                              page.locator("[data-el='back-btn']").is_visible())
                page.locator("[data-el='back-btn']").click()
                page.wait_for_timeout(1000)
                result.expect("Back returns to the overview",
                              "City Transit Authority" in page.locator(".explore h2").first.inner_text())

                _open_file(page, "stop_times")
                result.expect("the raw file browser still works",
                              page.locator("[data-el='table-scroll'] tbody tr").count() > 0)
                # Twice: switching to Files was itself a step, so Back walks
                # the files and then leaves them, which is what a reader who
                # got there in two steps expects.
                for _ in range(2):
                    page.locator("[data-el='back-btn']").click()
                    page.wait_for_timeout(1000)
                result.expect("Back returns from a file to a derived view",
                              page.locator(".explore").count() == 1)

                result.expect("no console errors", not _noise(errors), "; ".join(_noise(errors))[:200])


def check_rest(result: Result) -> None:
    """A host mounting the REST source itself, with a map."""
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gg-rest-") as workdir:
        with api_server(FIXTURE, Path(workdir)), dev_server() as dev:
            with browser_page(errors) as page:
                page.goto(f"{dev}/integration-harness.html?mode=rest", wait_until="networkidle")
                page.wait_for_timeout(3000)

                result.expect("the map is built", page.locator("[data-el='map-pane']").count() == 1)
                result.expect("offers the derived views", page.locator("[data-el='explore-tab']").count() == 3)

                _open_screen(page, "Routes")
                page.wait_for_timeout(1500)
                page.locator(".route-row").first.click()
                page.wait_for_timeout(4000)
                result.expect("a route opens", page.locator(".route-card").count() == 1)
                result.expect("the map is narrowed to that route",
                              page.locator(".map-controls").count() == 1)

                result.expect("no console errors", not _noise(errors), "; ".join(_noise(errors))[:200])


def check_static(result: Result) -> None:
    """Parquet on a static host, read in the browser. No server of ours at all."""
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gg-static-") as staging:
        dataset = Path(staging) / "dataset"
        export = subprocess.run(
            [sys.executable, "-m", "gtfs_garage.cli", "--export", str(dataset), str(FIXTURE)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        result.expect("the dataset exports", export.returncode == 0, export.stderr.strip()[:200])
        if export.returncode != 0:
            return

        manifest = dataset / "manifest.json"
        result.expect("a manifest is written beside the Parquet", manifest.exists())

        with static_server(dataset) as files, dev_server() as dev:
            url = f"{dev}/integration-harness.html?mode=static&dataset={files}"
            with browser_page(errors) as page:
                page.goto(url, wait_until="networkidle")
                # DuckDB-WASM is megabytes, fetched from a CDN on first use.
                page.wait_for_timeout(9000)

                result.expect("the derived views are offered", page.locator("[data-el='explore-tab']").count() == 3)
                _open_file(page, "stops")
                _appears(page, "[data-el='table-scroll'] tbody tr")
                result.expect(
                    "the file list is read from the Parquet",
                    page.locator(".table-tab").count() >= 7,
                )
                _open_screen(page, "Overview")

                # Everything below runs against Parquet over range requests,
                # with no server of ours anywhere. It is the same screen the
                # REST integration draws, computed in the tab instead.
                result.expect(
                    "the overview counts the feed",
                    "90" in page.locator(".overview .stat-row").first.inner_text(),
                    page.locator(".overview .stat-row").first.inner_text().replace("\n", " ")[:120],
                )

                _open_screen(page, "Service days")
                result.expect(
                    "service days is computed in the browser",
                    _appears(page, ".periods .period-bar"),
                )
                result.expect(
                    "kinds of day are named",
                    "Saturdays" in page.locator(".calendar").inner_text(),
                )

                _open_screen(page, "Routes")
                _appears(page, ".route-row")
                # The day's routes, not the feed's: on the fixture's weekdays
                # two of the four run, which is what a date-scoped list means.
                listed = page.locator(".route-row").count()
                result.expect(
                    "every route is listed, since no day has been chosen",
                    listed == 4,
                    f"{listed} of 4",
                )
                page.locator(".route-row").first.click()
                result.expect(
                    "a route card is computed in the browser",
                    _appears(page, ".route-card"),
                )
                result.expect(
                    "its stop patterns are found",
                    page.locator(".route-card details.pattern").count() == 2,
                )
                # The map, built from the same Parquet: there is no server in
                # this configuration to ask for GeoJSON, so a map here is the
                # browser having drawn one itself.
                focus = page.locator(".map-controls .explore-hint")
                result.expect(
                    "the route takes the map on its own, drawn from Parquet",
                    _appears(page, ".map-controls")
                    and "this route and its" in focus.inner_text(),
                    focus.inner_text().replace("\n", " ")[:90] if focus.count() else "no controls",
                )
                result.expect(
                    "and the map canvas is real",
                    page.evaluate("() => !!document.querySelector('[data-el=map] canvas')"),
                )
                drawn = page.evaluate(
                    "() => window.harness.source.geojson('routes').then(c => c.features.length)"
                )
                result.expect("every route's line is built in the browser", drawn == 3, str(drawn))

                page.get_by_text("Timetable", exact=False).first.click()
                result.expect("it asks which day", _appears(page, ".day-choice"))
                page.locator(".day-choice").first.click()
                result.expect(
                    "a timetable is computed in the browser too",
                    _appears(page, "table.timetable .trip-head")
                    and page.locator("table.timetable .trip-head").count() > 1,
                )

                _open_file(page, "stop_times")
                page.wait_for_timeout(2000)
                result.expect(
                    "rows are still readable over range requests",
                    page.locator("[data-el='table-scroll'] tbody tr").count() > 0,
                )

                result.expect("no console errors", not _noise(errors), "; ".join(_noise(errors))[:200])


# ---------------------------------------------------------------------------
# Conformance.
#
# The derived views exist twice: in `gtfs_garage.core`, served over HTTP, and in
# `web/src/sources/explore/`, computed in a browser against Parquet. Two
# implementations of one answer stay equivalent only if something checks, so
# this asks both for the same payloads and diffs them.
#
# The same diff serves a third-party backend: `--against <base-url>` compares
# what that backend returns with what the reference implementation produces for
# the feed it was given.
# ---------------------------------------------------------------------------

# Compared by value everywhere except here. `days_remaining` counts from today
# and both sides compute it the same way, but a run that straddles midnight
# would disagree by one and that is not a defect worth failing on.
VOLATILE = {("service", "days_remaining")}

# Two days of the fixture feed the conformance check compares timetables on: an
# ordinary weekday, and the Friday whose weekday service is removed and Sunday
# service added - which is where "which services run" can diverge.
TIMETABLE_DAY = _date(2026, 1, 1)
EXCEPTION_DAY = _date(2026, 4, 3)


def _reference(feed: Path, days: tuple = (TIMETABLE_DAY, EXCEPTION_DAY)) -> dict:
    """What `gtfs_garage.core` answers for a feed - the reference payloads."""
    from gtfs_garage.core import geojson as geo
    from gtfs_garage.core.feed import GtfsFeed
    from gtfs_garage.core.network import route_detail, route_list, route_timetable
    from gtfs_garage.core.overview import feed_overview
    from gtfs_garage.core.service import calendar_summary

    def whole(batches) -> dict:
        """A streamed layer as the one collection the browser answers with."""
        return {
            "type": "FeatureCollection",
            "features": [feature for batch in batches for feature in batch],
        }

    loaded = GtfsFeed(str(feed), optimise=False)
    try:
        routes = route_list(loaded)
        cursor = loaded.cursor()
        return {
            # The map's own layers, thinned the way the map receives them. Two
            # implementations of one geometry drift as readily as two of one
            # table - more so, since a wrong line looks like a feed's fault.
            "geojson:stops": geo.stops_geojson(cursor),
            "geojson:routes": whole(geo.iter_routes(cursor)),
            "geojson:shapes": whole(geo.iter_shapes(cursor)),
            "geojson:locations": whole(geo.iter_locations(cursor)),
            "overview": feed_overview(loaded),
            "calendar": calendar_summary(loaded),
            "routes": routes,
            **{f"route:{route['route_id']}": route_detail(loaded, route["route_id"]) for route in routes},
            **{
                f"route:{route['route_id']}:{days[0]}": route_detail(loaded, route["route_id"], days[0])
                for route in routes
            },
            # A weekday and an exception day: the second is where the two
            # implementations could disagree about which services run.
            **{
                f"timetable:{route['route_id']}:{day}": route_timetable(loaded, route["route_id"], day)
                for route in routes
                for day in days
            },
        }
    finally:
        loaded.close()


def _differences(expected, actual, path: tuple = ()) -> list[str]:
    """Every place two payloads disagree, named by where it is."""
    where = ".".join(str(part) for part in path) or "(root)"
    if path[-2:] in VOLATILE or (len(path) >= 2 and tuple(path[-2:]) in VOLATILE):
        return []

    if isinstance(expected, dict) and isinstance(actual, dict):
        found = []
        for key in sorted(set(expected) | set(actual)):
            if key not in expected:
                found.append(f"{where}.{key}: unexpected")
            elif key not in actual:
                found.append(f"{where}.{key}: missing")
            else:
                found.extend(_differences(expected[key], actual[key], (*path, key)))
        return found

    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{where}: {len(expected)} entries, got {len(actual)}"]
        return [
            difference
            for index, (left, right) in enumerate(zip(expected, actual))
            for difference in _differences(left, right, (*path, index))
        ]

    # JSON has one number type and Python has two; 3 and 3.0 are the same answer.
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return [] if float(expected) == float(actual) else [f"{where}: {expected!r} != {actual!r}"]

    return [] if expected == actual else [f"{where}: {expected!r} != {actual!r}"]


def check_conformance(result: Result) -> None:
    """The browser's derived views against the reference implementation's."""
    _conformance(result, FIXTURE, (TIMETABLE_DAY, EXCEPTION_DAY), "")
    _conformance(result, FLEX_FIXTURE, (TIMETABLE_DAY,), "flex ")


def _conformance(result: Result, fixture: Path, days: tuple, label: str) -> None:
    errors: list[str] = []
    expected = _reference(fixture, days)

    with tempfile.TemporaryDirectory(prefix="gg-conformance-") as staging:
        dataset = Path(staging) / "dataset"
        export = subprocess.run(
            [sys.executable, "-m", "gtfs_garage.cli", "--export", str(dataset), str(fixture)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        result.expect("the dataset exports", export.returncode == 0, export.stderr.strip()[:200])
        if export.returncode != 0:
            return

        with static_server(dataset) as files, dev_server() as dev:
            with browser_page(errors) as page:
                # `domcontentloaded`, not `networkidle`: this page fetches
                # DuckDB-WASM from a CDN and then reads Parquet over range
                # requests, so the network is never idle and waiting for it to
                # be is a timeout rather than a readiness check.
                page.goto(
                    f"{dev}/integration-harness.html?mode=static&dataset={files}",
                    wait_until="domcontentloaded",
                )
                page.wait_for_timeout(9000)

                def ask(call: str):
                    return page.evaluate(
                        f"async () => {{ const s = window.harness.source; return {call}; }}"
                    )

                actual = {
                    "overview": ask("await s.overview()"),
                    "calendar": ask("await s.calendar()"),
                    "routes": ask("await s.routes()"),
                    "geojson:stops": ask("await s.geojson('stops')"),
                    "geojson:routes": ask("await s.geojson('routes')"),
                    "geojson:shapes": ask("await s.geojson('shapes')"),
                    "geojson:locations": ask("await s.geojson('locations')"),
                }
                for route in expected["routes"]:
                    identifier = route["route_id"].replace("\\", "\\\\").replace("'", "\\'")
                    actual[f"route:{route['route_id']}"] = ask(f"await s.route('{identifier}')")
                    actual[f"route:{route['route_id']}:{days[0]}"] = ask(
                        f"await s.route('{identifier}', '{days[0].isoformat()}')"
                    )
                    for day in days:
                        actual[f"timetable:{route['route_id']}:{day}"] = ask(
                            f"await s.timetable('{identifier}', '{day.isoformat()}')"
                        )

                for name, reference in expected.items():
                    found = _differences(reference, actual.get(name), (name,))
                    result.expect(
                        f"{label}{name} matches the reference implementation",
                        not found,
                        "; ".join(found[:3]),
                    )

                result.expect(f"no {label}console errors", not _noise(errors), "; ".join(_noise(errors))[:200])


def check_against(result: Result, base_url: str) -> None:
    """A third-party backend's endpoints against the reference implementation.

    Point this at any implementation of `docs/GtfsGarageAPI.yaml` serving the
    fixture feed. It is the same comparison the browser gets, over HTTP.
    """
    import json

    expected = _reference(FIXTURE)

    def fetch(path: str):
        with urllib.request.urlopen(f"{base_url.rstrip('/')}{path}", timeout=30) as response:
            return json.load(response)

    try:
        actual = {
            "overview": fetch("/api/overview"),
            "calendar": fetch("/api/calendar"),
            "routes": fetch("/api/routes")["routes"],
        }
        for route in expected["routes"]:
            identifier = urllib.parse.quote(route["route_id"], safe="")
            actual[f"route:{route['route_id']}"] = fetch(f"/api/routes/{identifier}")
            actual[f"route:{route['route_id']}:{TIMETABLE_DAY}"] = fetch(
                f"/api/routes/{identifier}?service_date={TIMETABLE_DAY.isoformat()}"
            )
            for day in (TIMETABLE_DAY, EXCEPTION_DAY):
                actual[f"timetable:{route['route_id']}:{day}"] = fetch(
                    f"/api/routes/{identifier}/timetable?service_date={day.isoformat()}"
                )
    except Exception as exc:  # noqa: BLE001
        result.expect("the backend answered", False, f"{type(exc).__name__}: {exc}")
        return

    for name, reference in expected.items():
        found = _differences(reference, actual.get(name), (name,))
        result.expect(f"{name} matches the reference implementation", not found, "; ".join(found[:3]))


CHECKS = {
    "local": check_local,
    "embedded": check_embedded,
    "rest": check_rest,
    "static": check_static,
    "conformance": check_conformance,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # Validated below rather than with `choices`: argparse checks a `nargs="*"`
    # default against them as a whole, so an empty default - which is what
    # "run everything" looks like - is rejected before main() ever runs.
    parser.add_argument("checks", nargs="*", metavar="CHECK",
                        help=f"which integrations to drive: {', '.join(CHECKS)} (default: all)")
    parser.add_argument("--against", metavar="BASE_URL",
                        help="compare a third-party backend serving the fixture feed against the "
                             "reference implementation, and run nothing else")
    arguments = parser.parse_args(argv)

    if arguments.against:
        result = Result(f"against {arguments.against}")
        check_against(result, arguments.against)
        result.report()
        print()
        print("conforms" if result.ok else "FAILED")
        return 0 if result.ok else 1

    chosen = arguments.checks or ["all"]
    unknown = [name for name in chosen if name != "all" and name not in CHECKS]
    if unknown:
        print(f"error: no such check: {', '.join(unknown)}. Try: {', '.join(CHECKS)}", file=sys.stderr)
        return 1
    wanted = list(CHECKS) if "all" in chosen else chosen
    if not FIXTURE.exists():
        print(f"error: missing fixture feed at {FIXTURE}", file=sys.stderr)
        return 1
    if shutil.which("yarn") is None and {"embedded", "rest", "static"} & set(wanted):
        print("error: yarn is required for the browser-mounted integrations", file=sys.stderr)
        return 1

    blocked = _require_ports()
    if blocked:
        print(f"error: {blocked}", file=sys.stderr)
        return 1

    results = []
    for name in wanted:
        result = Result(name)
        try:
            CHECKS[name](result)
        except Exception as exc:  # noqa: BLE001 - a crashed check is a failed check
            result.expect("the check ran", False, f"{type(exc).__name__}: {exc}")
        result.report()
        results.append(result)

    failed = [result.name for result in results if not result.ok]
    print()
    if failed:
        print(f"FAILED: {', '.join(failed)}")
        return 1
    print(f"all {len(results)} integrations pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
