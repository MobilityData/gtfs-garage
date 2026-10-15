import { describe, expect, it } from "vitest";
import { columnInfo, tableInfo } from "../sources/fixtures";

import type { Dom } from "../dom";
import type { TableInfo } from "../sources/types";
import { createState, type View } from "../state";
import { memoryHistory } from "./history";
import { initialView, Navigator } from "./navigation";
import type { Screen } from "./screens";

describe("urlFor", () => {
  it("always carries the table and page", () => {
    expect(Navigator.urlFor({ table: "stops", filters: [], page: 2 })).toBe("?table=stops&page=2");
  });

  it("omits filters when there are none", () => {
    expect(Navigator.urlFor({ table: "stops", filters: [], page: 1 })).not.toContain("filters");
  });

  it("encodes filters so a filtered view can be shared", () => {
    const url = Navigator.urlFor({
      table: "trips",
      filters: [{ column: "route_id", op: "eq", value: "R1" }],
      page: 1,
    });
    expect(Navigator.parseUrl(url)).toEqual({
      table: "trips",
      filters: [{ column: "route_id", op: "eq", value: "R1" }],
      page: 1,
    });
  });
});

describe("parseUrl", () => {
  it("returns null without a table", () => {
    expect(Navigator.parseUrl("?page=3")).toBeNull();
  });

  it("defaults the page to 1", () => {
    expect(Navigator.parseUrl("?table=stops")?.page).toBe(1);
  });

  it("defaults an unparseable page to 1", () => {
    expect(Navigator.parseUrl("?table=stops&page=abc")?.page).toBe(1);
  });

  it("falls back to no filters when the parameter is malformed", () => {
    expect(Navigator.parseUrl("?table=stops&filters=not-json")?.filters).toEqual([]);
  });

  it("ignores a filters parameter that is not a list", () => {
    expect(Navigator.parseUrl('?table=stops&filters={"column":"x"}')?.filters).toEqual([]);
  });
});

describe("initialView", () => {
  const tables = (...names: string[]) =>
    names.map((name) => tableInfo({ name }));

  it("returns null for a feed with no tables", () => {
    expect(initialView([])).toBeNull();
  });

  it("lands on feed_info when the feed has one", () => {
    expect(initialView(tables("routes", "agency", "feed_info"))?.table).toBe("feed_info");
  });

  it("falls back to agency, then routes, then whatever is first", () => {
    expect(initialView(tables("routes", "agency"))?.table).toBe("agency");
    expect(initialView(tables("stops", "routes"))?.table).toBe("routes");
    expect(initialView(tables("stop_times", "shapes"))?.table).toBe("stop_times");
  });

  it("starts with no filters", () => {
    expect(initialView(tables("feed_info"))?.filters).toEqual([]);
    expect(initialView(tables("feed_info"))?.page).toBe(1);
  });

  it("restores a view when asked and the table is present", () => {
    const saved = { table: "trips", filters: [{ column: "route_id", op: "eq" as const, value: "R1" }], page: 3 };
    expect(initialView(tables("trips", "routes"), saved)).toEqual(saved);
  });

  it("ignores a restored view whose table the feed does not have", () => {
    const saved = { table: "pathways", filters: [], page: 1 };
    expect(initialView(tables("agency", "routes"), saved)?.table).toBe("agency");
  });

  it("drops the previous feed's filters when not restoring", () => {
    // Opening a different feed: its filters describe data that is no longer loaded.
    const stale = { table: "trips", filters: [{ column: "route_id", op: "eq" as const, value: "R1" }], page: 2 };
    const view = initialView(tables("feed_info", "trips"), null);
    expect(view?.table).toBe("feed_info");
    expect(view?.filters).toEqual([]);
    expect(stale.filters).toHaveLength(1); // the caller's object is untouched
  });
});

/**
 * The property step 3 exists for: a viewer embedded in someone else's page must
 * navigate without touching the host's URL. Testable at all only because `Dom`
 * is an interface and the back stack is a port - neither a document nor a
 * browser history is needed here.
 */
describe("Navigator with a private back stack", () => {
  const table = (name: string): TableInfo =>
    tableInfo({ name, row_count: 1, columns: [columnInfo({ name: "id" })] });

  function harness(screens: string[] = []) {
    const backButton = { disabled: false, addEventListener: () => {} };
    const dom: Dom = { el: <T,>() => backButton as T };
    const state = createState();
    state.tables = [table("agency"), table("routes")];
    state.screens = screens.map((id) => ({
      id,
      available: () => true,
      fetch: async () => ({}),
      render: () => ({}) as HTMLElement,
    }));

    const seen: View[] = [];
    const navigator = new Navigator(dom, memoryHistory(), state, (view) => seen.push(view));
    return { navigator, seen, backButton };
  }

  it("navigates without any browser history", () => {
    const { navigator, seen } = harness();
    navigator.reset({ table: "agency", filters: [], page: 1 }, "feed-1");
    navigator.selectTable("routes");

    expect(seen.map((v) => v.table)).toEqual(["agency", "routes"]);
  });

  it("goes back through its own stack", () => {
    const { navigator, seen, backButton } = harness();
    navigator.reset({ table: "agency", filters: [], page: 1 }, "feed-1");
    navigator.selectTable("routes");
    expect(backButton.disabled).toBe(false);

    navigator.back();

    expect(seen.map((v) => v.table)).toEqual(["agency", "routes", "agency"]);
    expect(backButton.disabled).toBe(true);
  });

  /**
   * Narrowing a list is a navigation: it goes in the stack, so Back undoes it,
   * and leaving the screen drops it, so a list never opens already narrowed by
   * something the reader chose somewhere else.
   */
  it("records a screen's parameters, and Back undoes them", () => {
    const { navigator, seen } = harness(["routes"]);
    navigator.reset({ table: "", filters: [], page: 1, screen: "routes" }, "feed-1");
    navigator.setParams({ mode: "3" });
    expect(seen[seen.length - 1].params).toEqual({ mode: "3" });

    navigator.back();
    expect(seen[seen.length - 1].params).toBeUndefined();
  });

  it("treats an emptied parameter as a removal rather than a blank one", () => {
    const { navigator, seen } = harness(["routes"]);
    navigator.reset({ table: "", filters: [], page: 1, screen: "routes", params: { mode: "3" } }, "feed-1");
    navigator.setParams({ mode: "" });
    expect(seen[seen.length - 1].params).toBeUndefined();
  });

  it("opens the next screen unnarrowed", () => {
    const { navigator, seen } = harness(["routes", "route"]);
    navigator.reset({ table: "", filters: [], page: 1, screen: "routes", params: { mode: "3" } }, "feed-1");
    navigator.showScreen("route", "10");
    expect(seen[seen.length - 1].params).toBeUndefined();
  });

  it("offers no initial view, leaving the host's URL to the host", () => {
    const { navigator } = harness();
    expect(navigator.fromLocation()).toBeNull();
  });
});

/**
 * The derived views share the back stack and the address bar with the file
 * browser, which is what makes "look at the calendar, then go back to the rows
 * I was reading" work at all.
 */
describe("screens in the URL", () => {
  it("writes a screen rather than a table", () => {
    expect(Navigator.urlFor({ table: "", filters: [], page: 1, screen: "calendar" })).toBe("?view=calendar");
  });

  it("carries a screen's argument as its own parameter", () => {
    // Not a path segment: a route_id is any UTF-8 string and routinely
    // contains the characters a path would use as separators. Named `arg`
    // rather than `route` because a host's own screen takes its own kind.
    const url = Navigator.urlFor({ table: "", filters: [], page: 1, screen: "route", argument: "A/B" });
    expect(Navigator.parseUrl(url)).toEqual({
      table: "",
      filters: [],
      page: 1,
      screen: "route",
      argument: "A/B",
    });
  });

  it("still reads a file link, which is unchanged", () => {
    expect(Navigator.parseUrl("?table=stops&page=2")).toEqual({ table: "stops", filters: [], page: 2 });
  });

  /**
   * A screen's own parameters - the facets a route list is narrowed by - ride
   * in the URL under their own names, so a narrowed list is a shareable link
   * like every other state this viewer can be in.
   */
  it("carries a screen's own parameters under their own names", () => {
    const url = Navigator.urlFor({
      table: "",
      filters: [],
      page: 1,
      screen: "routes",
      params: { mode: "3", flag: "no-colour" },
    });
    expect(url).toBe("?view=routes&mode=3&flag=no-colour");
    expect(Navigator.parseUrl(url)?.params).toEqual({ mode: "3", flag: "no-colour" });
  });

  it("leaves a parameter with no value out of the link", () => {
    const url = Navigator.urlFor({ table: "", filters: [], page: 1, screen: "routes", params: { mode: "" } });
    expect(url).toBe("?view=routes");
  });

  it("will not let a screen shadow a name the viewer owns", () => {
    const url = Navigator.urlFor({
      table: "",
      filters: [],
      page: 1,
      screen: "routes",
      date: "2026-03-16",
      params: { date: "1999-01-01", arg: "nonsense" },
    });
    expect(Navigator.parseUrl(url)).toMatchObject({ date: "2026-03-16", argument: undefined, params: undefined });
  });

  it("reads a screen it has never heard of", () => {
    // Which screens exist depends on the source and on what the host passed,
    // neither of which this module can see; the navigator is what refuses one
    // the feed has no entry for.
    expect(Navigator.parseUrl("?view=fares")?.screen).toBe("fares");
  });
});

describe("initialView with screens available", () => {
  const tables = (...names: string[]) => names.map((name) => tableInfo({ name }));
  const screen = (id: string, label?: string): Screen => ({
    id,
    label,
    available: () => true,
    fetch: async () => ({}),
    render: () => ({}) as HTMLElement,
  });

  it("lands on the first listed screen, which is where someone who does not know the file names should start", () => {
    expect(initialView(tables("agency"), null, [screen("overview", "Overview")])?.screen).toBe("overview");
  });

  it("lands on whatever the host put first, not on ours", () => {
    const hosts = [screen("fares", "Fares"), screen("overview", "Overview")];
    expect(initialView(tables("agency"), null, hosts)?.screen).toBe("fares");
  });

  it("skips a detail screen, which has no sidebar entry to land on", () => {
    const only = [screen("route"), screen("overview", "Overview")];
    expect(initialView(tables("agency"), null, only)?.screen).toBe("overview");
  });

  it("lands on a file when there are no screens at all", () => {
    expect(initialView(tables("agency", "routes"), null, [])?.screen).toBeUndefined();
  });

  it("restores a screen from a shared link whatever the feed contains", () => {
    const saved: View = { table: "", filters: [], page: 1, screen: "calendar" };
    expect(initialView(tables("stop_times"), saved, [screen("calendar", "Calendar")])).toEqual(saved);
  });

  it("ignores a restored screen this source does not offer", () => {
    const saved: View = { table: "", filters: [], page: 1, screen: "calendar" };
    expect(initialView(tables("stop_times"), saved, [])?.table).toBe("stop_times");
  });
});
