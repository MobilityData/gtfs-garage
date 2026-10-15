/**
 * Narrowing a route list, from what the list already carries.
 *
 * Every facet here is computed from the rows already fetched, so filtering is
 * instant, needs no request, and behaves identically in the embedded viewer
 * reading Parquet in a browser. Anything that would need a second look at the
 * feed - which routes call at a stop, which run after midnight - is not here,
 * because it would turn a click into a round trip.
 *
 * The counts are the point as much as the filtering is. A reader learns the
 * feed has eight rail routes and fourteen without a colour by reading the
 * filter, before clicking anything.
 *
 * Pure, so the arithmetic and the wording are testable without a document.
 */

import type { RouteSummary } from "../sources/types";

/** One thing a list can be narrowed by. */
export interface Facet {
  /** What it is called in the URL. */
  key: string;
  label: string;
  options: FacetOption[];
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Trip-count bands, as chips rather than a slider.
 *
 * A slider asks for a number nobody has in mind and hides the distribution; a
 * band says how many routes are in it before you choose. The edges are where
 * operators tend to draw them - a handful of trips, a normal route, a trunk.
 */
export const TRIP_BANDS: { value: string; label: string; min: number; max: number }[] = [
  { value: "none", label: "No trips", min: 0, max: 0 },
  { value: "few", label: "Under 10", min: 1, max: 9 },
  { value: "some", label: "10 to 49", min: 10, max: 49 },
  { value: "many", label: "50 to 199", min: 50, max: 199 },
  { value: "most", label: "200 or more", min: 200, max: Number.MAX_SAFE_INTEGER },
];

/**
 * Things worth noticing about a route, each derivable from its own row.
 *
 * Deliberately not "problems": a route with no colour is not wrong, it is
 * unstyled, and a feed's author is usually the one asking which ones they
 * missed. Only `no-trips` is a finding on its own.
 */
export const FLAGS: { value: string; label: string; holds: (route: RouteSummary) => boolean }[] = [
  { value: "no-colour", label: "No colour", holds: (route) => !route.color?.trim() },
  { value: "no-short-name", label: "No short name", holds: (route) => !route.short_name?.trim() },
  { value: "no-long-name", label: "No long name", holds: (route) => !route.long_name?.trim() },
  { value: "no-trips", label: "No trips at all", holds: (route) => route.trips === 0 },
  { value: "one-service", label: "One service only", holds: (route) => route.services === 1 },
];

/** The filters in force, as the URL carries them: comma-separated values. */
export type RouteFilters = Record<string, string>;

function chosen(filters: RouteFilters, key: string): string[] {
  const raw = filters[key];
  return raw ? raw.split(",").filter(Boolean) : [];
}

function bandOf(trips: number): string {
  return TRIP_BANDS.find((band) => trips >= band.min && trips <= band.max)?.value ?? "most";
}

/** Whether one route survives the filters, ignoring one facet if asked.
 *
 * `except` is what makes the counts honest: a facet's own options are counted
 * against the list narrowed by *every other* facet, so the numbers say what
 * clicking would actually give you rather than what the unfiltered feed holds.
 */
function matches(route: RouteSummary, filters: RouteFilters, except?: string): boolean {
  const wanted = (key: string) => (key === except ? [] : chosen(filters, key));

  const modes = wanted("mode");
  if (modes.length && !modes.includes(route.route_type ?? "")) return false;

  const agencies = wanted("agency");
  if (agencies.length && !agencies.includes(route.agency_id ?? "")) return false;

  const bands = wanted("trips");
  if (bands.length && !bands.includes(bandOf(route.trips))) return false;

  // Flags are an "and": asking for no colour *and* no short name means both.
  for (const value of wanted("flag")) {
    const flag = FLAGS.find((entry) => entry.value === value);
    if (flag && !flag.holds(route)) return false;
  }
  return true;
}

/** The routes a reader is actually looking at. */
export function applyFilters(routes: RouteSummary[], filters: RouteFilters): RouteSummary[] {
  return routes.filter((route) => matches(route, filters));
}

/** Count an option against everything *except* its own facet. See `matches`. */
function countBy(
  routes: RouteSummary[],
  filters: RouteFilters,
  key: string,
  holds: (route: RouteSummary) => boolean,
): number {
  return routes.filter((route) => holds(route) && matches(route, filters, key)).length;
}

/**
 * The facets worth offering for this feed.
 *
 * A facet with one option is left out: "Bus 152" on a feed of only buses is a
 * control that cannot change anything, and a row of them is noise in front of
 * the list.
 */
export function facets(routes: RouteSummary[], filters: RouteFilters): Facet[] {
  const found: Facet[] = [];

  const modes = new Map<string, string>();
  for (const route of routes) modes.set(route.route_type ?? "", route.mode);
  if (modes.size > 1) {
    found.push({
      key: "mode",
      label: "Mode",
      options: [...modes.entries()]
        .map(([value, label]) => ({
          value,
          label,
          count: countBy(routes, filters, "mode", (route) => (route.route_type ?? "") === value),
        }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    });
  }

  const agencies = new Map<string, string>();
  for (const route of routes) {
    if (route.agency_id) agencies.set(route.agency_id, route.agency_name ?? route.agency_id);
  }
  if (agencies.size > 1) {
    found.push({
      key: "agency",
      label: "Agency",
      options: [...agencies.entries()]
        .map(([value, label]) => ({
          value,
          label,
          count: countBy(routes, filters, "agency", (route) => route.agency_id === value),
        }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    });
  }

  const bands = TRIP_BANDS.map((band) => ({
    value: band.value,
    label: band.label,
    count: countBy(routes, filters, "trips", (route) => bandOf(route.trips) === band.value),
  })).filter((band) => band.count > 0);
  if (bands.length > 1) found.push({ key: "trips", label: "Trips per day", options: bands });

  const flags = FLAGS.map((flag) => ({
    value: flag.value,
    label: flag.label,
    count: countBy(routes, filters, "flag", flag.holds),
  })).filter((flag) => flag.count > 0);
  if (flags.length) found.push({ key: "flag", label: "Worth noticing", options: flags });

  return found;
}

/** Turning one option on or off, as the next set of filters. */
export function toggle(filters: RouteFilters, key: string, value: string): RouteFilters {
  const current = chosen(filters, key);
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];

  const updated = { ...filters };
  if (next.length) updated[key] = next.join(",");
  else delete updated[key];
  return updated;
}

export function isOn(filters: RouteFilters, key: string, value: string): boolean {
  return chosen(filters, key).includes(value);
}

export function anyOn(filters: RouteFilters): boolean {
  return facetKeys.some((key) => chosen(filters, key).length > 0);
}

const facetKeys = ["mode", "agency", "trips", "flag"];

/** Only the keys this screen owns, so unrelated parameters are left alone. */
export function onlyFacets(filters: RouteFilters): RouteFilters {
  return Object.fromEntries(Object.entries(filters).filter(([key]) => facetKeys.includes(key)));
}

/** "Rail · City Transit · No colour" - what is currently in force, in words. */
export function describeFilters(routes: RouteSummary[], filters: RouteFilters): string {
  const names: string[] = [];
  for (const facet of facets(routes, {})) {
    for (const option of facet.options) {
      if (isOn(filters, facet.key, option.value)) names.push(option.label);
    }
  }
  return names.join(" · ");
}
