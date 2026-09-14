import { describe, expect, it, vi } from "vitest";

import type { View } from "../state";
import { memoryHistory, parseUrl, urlFor } from "./history";

const view = (table: string, page = 1): View => ({ table, filters: [], page });
const entry = (table: string, depth = 0, feed = "f") => ({ view: view(table), depth, feed });

describe("urlFor", () => {
  it("names the table and page", () => {
    expect(urlFor(view("stops", 3))).toBe("?table=stops&page=3");
  });

  it("omits filters when there are none, rather than sending an empty list", () => {
    expect(urlFor(view("stops"))).not.toContain("filters");
  });

  it("round-trips through parseUrl", () => {
    const original: View = { table: "trips", filters: [{ column: "route_id", op: "eq", value: "R1" }], page: 2 };
    expect(parseUrl(urlFor(original))).toEqual(original);
  });
});

describe("parseUrl", () => {
  it("returns nothing when no table is named", () => {
    expect(parseUrl("?page=2")).toBeNull();
  });

  it("survives filters that are not valid JSON", () => {
    // A hand-edited or truncated link should open the table, not fail.
    expect(parseUrl("?table=stops&filters=not-json")).toEqual({ table: "stops", filters: [], page: 1 });
  });

  it("ignores filters that are not a list", () => {
    expect(parseUrl('?table=stops&filters={"a":1}')?.filters).toEqual([]);
  });
});

/**
 * The port an embedded viewer uses. The property that matters is the one that
 * cannot be asserted directly here - it touches neither `history` nor
 * `location` - so these cover the behaviour a host would notice instead.
 */
describe("memoryHistory", () => {
  it("offers no initial view unless given one", () => {
    expect(memoryHistory().initialView()).toBeNull();
    expect(memoryHistory(view("stops")).initialView()).toEqual(view("stops"));
  });

  it("goes back to the previous entry", () => {
    const popped = vi.fn();
    const history = memoryHistory();
    history.onPop(popped);

    history.replace(entry("agency"));
    history.push(entry("routes", 1));
    history.back();

    expect(popped).toHaveBeenCalledWith(entry("agency"));
  });

  it("does not go back past the first entry", () => {
    const popped = vi.fn();
    const history = memoryHistory();
    history.onPop(popped);
    history.replace(entry("agency"));

    history.back();

    // Nothing behind it, so nothing happens - the viewer stays put.
    expect(popped).not.toHaveBeenCalled();
  });

  it("starts a fresh stack when a new feed replaces the old", () => {
    const popped = vi.fn();
    const history = memoryHistory();
    history.onPop(popped);

    history.replace(entry("agency"));
    history.push(entry("routes", 1));
    history.replace(entry("stops", 0, "other-feed"));
    history.back();

    // The previous feed's entries went with it, so there is nowhere back to.
    expect(popped).not.toHaveBeenCalled();
  });
});
