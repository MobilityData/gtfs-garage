/**
 * What is in this feed, for someone who has not read it.
 *
 * The file list answers which files are here. This answers the question people
 * arrive with - who runs this, what do they run, when does it run, what will
 * this feed be able to tell me - without naming a file until the reader asks
 * for one.
 *
 * Every figure is a link into the rows it came from. That is the rule the whole
 * explore half follows: nothing is asserted that cannot be checked one click
 * later, in the raw file view this tool has always had.
 */

import type { Overview, OverviewAgency, ViewerSource } from "../../sources/types";
import { count, expiry } from "../explore-format";
import { action, node, section, stat } from "../html";
import type { Screen, ScreenContext } from "./types";

/**
 * Agencies shown before the list is collapsed.
 *
 * An aggregator's feed carries hundreds, and a page that renders all of them
 * buries everything below it. Ten is enough to recognise the feed; the rest
 * are one click away, and searchable once they are open.
 */
const AGENCIES_SHOWN = 10;

export function renderOverview(data: Overview, context: ScreenContext): HTMLElement {
  const root = node("div", { class: "explore overview" });

  root.append(
    header(data, context),
    counts(data, context),
    agencies(data, context),
    modes(data, context),
    features(data, context),
  );
  return root;
}

function header(data: Overview, context: ScreenContext): HTMLElement {
  const published = data.published ?? {};
  const publisher = published.feed_publisher_name;
  const version = published.feed_version;
  const remaining = expiry(data.service?.days_remaining);

  // The badge opens the calendar: "when does this run" is the question the
  // dates provoke, and the answer is one view away rather than in the files.
  const badge = node(
    "button",
    { class: `window-badge window-${remaining.tone}`, title: "Open the service calendar" },
    [
      node("div", { class: "window-dates", text: serviceRange(data) }),
      node("div", { class: "window-remaining", text: remaining.text }),
    ],
  );
  badge.addEventListener("click", () => context.openScreen("calendar"));

  return node("div", { class: "overview-header" }, [
    node("div", {}, [
      node("h2", { text: publisher || "This feed" }),
      node("div", {
        class: "explore-hint",
        text: version ? `Version ${version}` : "No feed_info.txt, so no published version",
      }),
    ]),
    badge,
  ]);
}

function serviceRange(data: Overview): string {
  const window = data.service;
  if (!window?.first_date || !window.last_date) return window?.note ?? "No service dates";
  return `${window.first_date} to ${window.last_date}`;
}

function counts(data: Overview, context: ScreenContext): HTMLElement {
  const totals = data.counts;
  const row = node("div", { class: "stat-row" });

  const tiles: [string, number, string | null, string][] = [
    // The routes count is the one figure with a view of its own behind it, so
    // it opens that rather than the file: someone clicking "207 routes" is
    // asking to see the routes, and routes.txt is a row per route with none of
    // what makes one recognisable. Every other tile opens its file, which is
    // still the way to the rows behind any number here.
    ["Routes", totals.routes, null, "Lines as the operator names them"],
    ["Stops", totals.stops, "stops", "Places a rider boards - stations and entrances excluded"],
    ["Stations", totals.stations, "stops", "Parent stations holding the platforms above"],
    ["Zones", totals.zones ?? 0, "locations", "On-demand areas a rider is picked up in"],
    ["Zone groups", totals.location_groups ?? 0, "location_groups", "Named groups of those zones"],
    ["Trips", totals.trips, "trips", "One vehicle running a route once"],
    ["Stop times", totals.stop_times, "stop_times", "Every call at every stop - the biggest file in a feed"],
    ["Services", totals.services, "calendar", "Distinct service_ids the trips use"],
    ["Shapes", totals.shapes, "shapes", "Distinct drawn paths"],
  ];

  // A feed built on zones has no stops and no shapes, and a row of noughts
  // makes a working flex feed read as an empty one. The counts that belong to
  // the other model are dropped when they are zero rather than reported as
  // absences the feed never claimed.
  const demandResponsive = (totals.zones ?? 0) > 0;
  const onlyWhenPresent = demandResponsive
    ? ["Stations", "Stops", "Shapes"]
    : ["Stations", "Zones", "Zone groups"];

  for (const [label, value, table, explanation] of tiles) {
    if (!value && onlyWhenPresent.includes(label)) continue;

    const tile = stat(label, value.toLocaleString(), explanation);
    if (label === "Routes") {
      tile.classList.add("stat-clickable");
      tile.title = `${explanation}. Opens the routes view.`;
      tile.addEventListener("click", () => context.openScreen("routes"));
    } else if (table) {
      tile.classList.add("stat-clickable");
      tile.title = `${explanation}. Opens ${table}.txt.`;
      tile.addEventListener("click", () => context.openTable(table));
    }
    row.append(tile);
  }

  return section(
    "Contents",
    "Routes opens the routes view; every other tile opens the file it was counted from.",
    [row],
  );
}

function agencyRow(agency: OverviewAgency, context: ScreenContext): HTMLElement {
  return node("li", {}, [
    node("span", { class: "agency-name", text: agency.name }),
    node("span", { class: "explore-hint", text: agency.timezone ?? "" }),
    // Filtered, not the whole list: a reader clicking "42 routes" beside an
    // agency means that agency's forty-two, and landing on every route in an
    // aggregator's feed is the opposite of an answer.
    action(count(agency.routes, "route"), `Show only ${agency.name}'s routes`, () =>
      context.openScreen("routes", agency.agency_id ?? undefined),
    ),
  ]);
}

function agencies(data: Overview, context: ScreenContext): HTMLElement {
  const all = data.agencies;
  const list = node("ul", { class: "agency-list" });

  if (!all.length) {
    list.append(node("li", { class: "explore-hint", text: "This feed has no agency.txt." }));
    return section("Agencies", undefined, [list]);
  }

  const draw = (term: string, limit: number) => {
    list.replaceChildren();
    const needle = term.trim().toLowerCase();
    const matching = needle
      ? all.filter((agency) => agency.name.toLowerCase().includes(needle))
      : all;

    for (const agency of matching.slice(0, limit)) list.append(agencyRow(agency, context));
    if (!matching.length) {
      list.append(node("li", { class: "explore-hint", text: `No agency matches "${term}".` }));
    } else if (matching.length > limit) {
      const more = node("button", {
        class: "chip",
        text: `Show all ${matching.length.toLocaleString()}`,
      });
      more.addEventListener("click", () => draw(term, matching.length));
      list.append(node("li", { class: "agency-more" }, [more]));
    }
  };

  const children: (HTMLElement | null)[] = [list];
  // A search box only once there are enough agencies for scrolling to be worse
  // than typing.
  if (all.length > AGENCIES_SHOWN) {
    const search = node("input", {
      class: "route-search",
      type: "search",
      placeholder: "Find an agency",
      "aria-label": "Find an agency",
    }) as HTMLInputElement;
    search.addEventListener("input", () => draw(search.value, AGENCIES_SHOWN));
    children.unshift(search);
  }

  draw("", AGENCIES_SHOWN);
  return section(
    "Agencies",
    all.length === 1 ? undefined : `${all.length.toLocaleString()} operators in this feed.`,
    children,
  );
}

function modes(data: Overview, context: ScreenContext): HTMLElement {
  const row = node("div", { class: "chip-row" });

  for (const mode of data.modes) {
    const chip = node("button", {
      class: "chip",
      title: `route_type ${mode.route_type ?? "(empty)"} - open these rows in routes.txt`,
    });
    chip.append(
      node("span", { class: "chip-label", text: mode.label }),
      node("span", { class: "chip-count", text: mode.routes.toLocaleString() }),
    );
    chip.addEventListener("click", () =>
      context.openTable(
        "routes",
        mode.route_type ? [{ column: "route_type", op: "eq", value: mode.route_type }] : [],
      ),
    );
    row.append(chip);
  }

  if (!data.modes.length) row.append(node("span", { class: "explore-hint", text: "No routes.txt in this feed." }));
  return section("Modes", "Routes by vehicle type. A chip opens routes.txt filtered to it.", [row]);
}

function features(data: Overview, context: ScreenContext): HTMLElement {
  const list = node("div", { class: "feature-grid" });

  for (const feature of data.features) {
    const card = node("div", { class: `feature ${feature.present ? "feature-on" : "feature-off"}` }, [
      node("div", { class: "feature-name" }, [
        node("span", { text: feature.present ? "✓ " : "— " }),
        node("span", { text: feature.name }),
      ]),
      node("div", { class: "explore-hint", text: feature.description }),
    ]);

    if (feature.present && feature.tables.length) {
      const links = node("div", { class: "feature-links" });
      for (const table of feature.tables) {
        links.append(action(table, `Open ${table}`, () => context.openTable(table)));
      }
      card.append(links);
    }
    list.append(card);
  }

  return section(
    "Optional GTFS data",
    "Parts of the specification a feed may or may not use. Checked either way, so a missing one reads as absent rather than unexamined.",
    [list],
  );
}

/** The landing screen: what is in this feed, for someone who has not read it. */
export const overviewScreen: Screen<Overview> = {
  id: "overview",
  label: "Overview",
  // Nothing here goes on a map; the width is better spent on the cards.
  layout: "none",
  title: "What is in this feed",
  available: (source: ViewerSource) => typeof source.overview === "function",
  fetch: (source: ViewerSource) => source.overview!(),
  render: renderOverview,
};
