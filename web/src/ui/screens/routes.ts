/**
 * Routes, gathered back together.
 *
 * A route in GTFS is a row in `routes.txt` and nothing else; everything that
 * makes it recognisable - where it goes, how often, which days, how many
 * variants it has - is spread over three other files. The list is what an
 * operator expects to see when they open a feed, and the card behind each row
 * is the answer to "show me the 14".
 *
 * Opening a card puts that route alone on the map. A route drawn among every
 * other route in the city is not shown, it is hidden, so the rest of the
 * network is off until asked for.
 */

import type { RouteDetail, RoutePattern, RouteSummary, ViewerSource } from "../../sources/types";
import {
  byMode,
  clock,
  count,
  routeBadge,
  routeLabel,
  routeSubtitle,
  span,
  swatch,
  textOn,
  weekdayBars,
} from "../explore-format";
import { longDate } from "../date-bar";
import { anyOn, applyFilters, describeFilters, facets, isOn, onlyFacets, toggle } from "../route-filters";
import { action, append, node, section, stat } from "../html";
import type { Screen, ScreenContext } from "./types";

/** The coloured badge a route is recognised by, or its id when it has none. */
function badge(route: {
  route_id: string;
  short_name?: string | null;
  long_name?: string | null;
  color?: string | null;
  text_color?: string | null;
}): HTMLElement {
  const background = swatch(route.color);
  const foreground = swatch(route.text_color) ?? textOn(background);
  const element = node("span", { class: "route-badge", text: routeBadge(route) });
  if (background) {
    element.style.backgroundColor = background;
    element.style.color = foreground;
  }
  return element;
}

/**
 * Above this many routes, drawing "the day's network" is drawing the network.
 *
 * Focusing is a filter over every feature in the layer, so narrowing to two
 * thousand routes costs more than it says and shows the same map. Below it,
 * the list and the map are looking at the same thing - which is the point of
 * choosing a day.
 */
const FOCUS_LIMIT = 300;

/** What the list screen fetched: the routes, and the agency it was asked for. */
export interface RouteListing {
  routes: RouteSummary[];
  agency: string | null;
}

export function renderRouteList(listing: RouteListing, context: ScreenContext): HTMLElement {
  const { routes } = listing;
  const root = node("div", { class: "explore routes" });

  // What the list is showing, on the map beside it.
  void context.focusRoutes?.(
    routes.length && routes.length <= FOCUS_LIMIT ? routes.map((route) => route.route_id) : null,
    { isolate: true },
  );

  // Asked for, not inferred. Guessing "every route has the same operator, so
  // this must be filtered" is true of every single-agency feed, which then
  // showed its own name as a heading and a link to clear a filter nobody set.
  const filtered = Boolean(listing.agency);
  const agency = filtered ? (routes[0]?.agency_name ?? listing.agency) : null;

  const search = node("input", {
    class: "route-search",
    type: "search",
    placeholder: "Find a route by number or name",
    "aria-label": "Find a route",
  }) as HTMLInputElement;

  const chips = node("div", { class: "facets" });
  const summary = node("div", { class: "facet-summary" });
  const results = node("div", { class: "route-groups" });

  /**
   * The facets, each carrying how many routes it would leave.
   *
   * Counted against the list narrowed by every *other* facet, so a number says
   * what clicking would actually give you rather than what the unfiltered feed
   * holds - and an option that would leave nothing is still shown, at zero,
   * rather than vanishing as you narrow.
   */
  const drawFacets = () => {
    const filters = onlyFacets(context.params);
    chips.replaceChildren();

    for (const facet of facets(routes, filters)) {
      const row = node("div", { class: "facet-row" }, [
        node("span", { class: "facet-label", text: facet.label }),
      ]);

      for (const option of facet.options) {
        const on = isOn(filters, facet.key, option.value);
        const chip = node("button", {
          // Dimmed rather than removed when it would leave nothing: an option
          // that disappears as you narrow makes the row jump under the cursor.
          class: `chip facet-chip${on ? " active" : ""}${option.count ? "" : " facet-empty"}`,
          title: on ? `Stop filtering by ${option.label}` : `Show only ${option.label}`,
        });
        chip.append(
          node("span", { class: "chip-label", text: option.label }),
          node("span", { class: "chip-count", text: option.count.toLocaleString() }),
        );
        chip.addEventListener("click", () =>
          context.setParams({ ...context.params, ...emptied(filters, facet.key, option.value) }),
        );
        row.append(chip);
      }
      chips.append(row);
    }
  };

  /** The next parameters, with this option flipped and the rest untouched. */
  const emptied = (filters: Record<string, string>, key: string, value: string) => {
    const next = toggle(filters, key, value);
    // A key that emptied has to be removed rather than left blank, or the URL
    // carries `&mode=` and the list reads as filtered by nothing.
    const cleared = Object.fromEntries(
      Object.keys(filters)
        .filter((name) => !(name in next))
        .map((name) => [name, ""]),
    );
    return { ...next, ...cleared };
  };

  /** The list itself: the facets, then the search box, then the groups. */
  const draw = (term: string) => {
    results.replaceChildren();
    const filters = onlyFacets(context.params);
    const narrowed = applyFilters(routes, filters);

    const needle = term.trim().toLowerCase();
    const matching = needle
      ? narrowed.filter((route) =>
          [route.short_name, route.long_name, route.route_id, route.agency_name].some((field) =>
            (field ?? "").toLowerCase().includes(needle),
          ),
        )
      : narrowed;

    drawSummary(matching.length, filters, term);

    if (!matching.length) {
      results.append(
        node("p", {
          class: "explore-hint",
          text: needle
            ? `No route matches "${term}" among the ${narrowed.length.toLocaleString()} shown.`
            : "No route matches these filters.",
        }),
      );
      return;
    }

    for (const group of byMode(matching)) {
      results.append(
        node("div", { class: "route-group" }, [
          node("div", { class: "route-group-label", text: `${group.mode} — ${count(group.routes.length, "route")}` }),
          node("div", { class: "explore-scroll" }, [routeTable(group.routes, context)]),
        ]),
      );
    }
  };

  /** What is in force, and the way out of it. */
  const drawSummary = (shown: number, filters: Record<string, string>, term: string) => {
    summary.replaceChildren();
    if (!anyOn(filters) && !term.trim()) return;

    const words = [describeFilters(routes, filters), term.trim() ? `"${term.trim()}"` : null]
      .filter(Boolean)
      .join(" · ");

    summary.append(
      node("span", {
        text: `${shown.toLocaleString()} of ${routes.length.toLocaleString()} routes`,
      }),
      node("span", { class: "explore-hint", text: words }),
    );

    if (anyOn(filters)) {
      summary.append(
        action("Clear filters", "Show every route again", () => {
          const cleared = Object.fromEntries(Object.keys(filters).map((key) => [key, ""]));
          context.setParams({ ...context.params, ...cleared });
        }),
      );
    }
  };

  search.addEventListener("input", () => draw(search.value));

  root.append(
    node("div", { class: "overview-header" }, [
      node("div", {}, [
        node("h2", { text: filtered && agency ? agency : "Routes" }),
        node("div", {
          class: "explore-hint",
          // Says which list this is. Unfiltered is the default, and a count
          // with no qualifier is a count of the whole feed.
          text: [
            `${routes.length.toLocaleString()} ${filtered ? "operated by this agency" : "in this feed"}`,
            context.date ? `running on ${longDate(context.date)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        }),
      ]),
      search,
    ]),
  );

  if (filtered) {
    const all = node("div", { class: "day-actions" });
    all.append(action("Show every route", "Clear the agency filter", () => context.openScreen("routes")));
    root.append(all);
  }

  root.append(chips, summary, results);
  drawFacets();
  draw("");
  return root;
}

function routeTable(routes: RouteSummary[], context: ScreenContext): HTMLElement {
  const body = node("tbody");

  for (const route of routes) {
    const row = node("tr", { class: "route-row" }, [
      node("td", {}, [badge(route)]),
      node("td", {}, [
        node("div", { class: "route-name", text: routeSubtitle(route) || routeLabel(route) }),
        node("div", { class: "explore-hint", text: route.agency_name ?? "" }),
      ]),
      node("td", { class: "numeric", text: route.trips.toLocaleString(), title: "Trips in the whole feed" }),
      node("td", { class: "numeric", text: String(route.services), title: "Distinct service_ids" }),
    ]);
    row.addEventListener("click", () => context.openScreen("route", route.route_id));
    body.append(row);
  }

  return node("table", { class: "explore-table route-table" }, [
    node("thead", {}, [
      node("tr", {}, [
        node("th", { text: "Route" }),
        node("th", { text: "Name" }),
        node("th", { class: "numeric", text: "Trips" }),
        node("th", { class: "numeric", text: "Services" }),
      ]),
    ]),
    body,
  ]);
}

export function renderRoute(detail: RouteDetail, context: ScreenContext): HTMLElement {
  const route = detail.route as Record<string, string | null>;
  const summary = {
    route_id: route.route_id ?? "",
    short_name: route.route_short_name,
    long_name: route.route_long_name,
    color: route.route_color,
    text_color: route.route_text_color,
  };

  const root = node("div", { class: "explore route-card" });
  const controls = mapControls(summary.route_id, detail, context);
  append(
    root,
    node("div", { class: "overview-header" }, [
      node("div", { class: "route-title" }, [
        badge(summary),
        node("div", {}, [
          node("h2", { text: routeSubtitle(summary) || routeLabel(summary) }),
          node("div", {
            class: "explore-hint",
            text: [detail.mode, detail.agency_name].filter(Boolean).join(" · "),
          }),
        ]),
      ]),
      node("div", { class: "route-actions" }, [
        action("Open its trips", "Open trips.txt filtered to this route", () =>
          context.openTable("trips", [{ column: "route_id", op: "eq", value: summary.route_id }]),
        ),
        action("Open its row", "Open routes.txt filtered to this route", () =>
          context.openTable("routes", [{ column: "route_id", op: "eq", value: summary.route_id }]),
        ),
        // Always offered, with or without a day chosen: the timetable asks for
        // one itself when there is none, so hiding the link behind a date the
        // reader has not picked yet put the view out of reach.
        context.source.timetable
          ? action(
              context.date ? `Timetable for ${context.date}` : "Timetable",
              context.date
                ? "This route's departures on the chosen day"
                : "This route's departures on a day you choose",
              () => context.openScreen("timetable", summary.route_id),
            )
          : null,
      ]),
    ]),
    controls,
    summarySection(detail),
    directions(detail),
    patterns(detail, context),
    week(detail),
    hours(detail),
  );
  return root;
}

/**
 * Put this route on the map alone, and say what actually happened.
 *
 * A route is drawn from its own shapes rather than from the one representative
 * the `routes` layer holds, so a route with a shape per direction shows both.
 * A route whose trips name no shape has nothing to draw at all - which is
 * ordinary in feeds without `shapes.txt` - and saying so is the whole reason
 * this waits for an answer instead of asserting one.
 */
function mapControls(routeId: string, detail: RouteDetail, context: ScreenContext): HTMLElement | null {
  if (!context.focusRoutes) return null;

  const shapeIds = [...new Set(detail.directions.flatMap((direction) => direction.shape_ids))];
  // Every stop the route calls at, across its patterns - which is what makes
  // the map answer "where does it go" rather than only "what shape is it".
  const stopIds = [
    ...new Set(detail.patterns.flatMap((pattern) => pattern.stops.map((stop) => stop.stop_id))),
  ];
  const status = node("span", { class: "explore-hint", text: "Drawing this route on the map…" });

  /**
   * Showing the surroundings is not deselecting the route.
   *
   * The route stays drawn and picked out in both states; the checkbox only
   * decides whether everything else is drawn behind it. Clearing the focus
   * instead would lose the one line the reader opened the card to look at.
   */
  const draw = (isolate: boolean) => {
    void context.focusRoutes?.([routeId], { shapeIds, stopIds, isolate }).then(({ lines, points }) => {
      if (!lines && !points) {
        status.textContent =
          "This route has no shapes or placeable stops in the feed, so there is nothing to draw for it. The rest of the network is shown instead.";
      } else if (!lines) {
        // Ordinary in a feed with no shapes.txt, and worth saying: the stops
        // are the route, and a reader should know the line between them is
        // missing rather than wonder where it went.
        status.textContent = `This route has no shapes in the feed. Its ${points} stops are shown instead.`;
      } else {
        status.textContent = isolate
          ? `On the map: this route and its ${points} stops.`
          : "On the map: this route, picked out against the rest of the network.";
      }
    });
  };

  const toggle = node("label", { class: "raw-toggle", title: "Draw every other route behind this one" });
  const input = node("input", { type: "checkbox" }) as HTMLInputElement;
  input.addEventListener("change", () => draw(!input.checked));
  toggle.append(input, document.createTextNode(" Show the rest of the network"));

  draw(true);
  return node("div", { class: "map-controls" }, [status, toggle]);
}

function summarySection(detail: RouteDetail): HTMLElement {
  const row = node("div", { class: "stat-row" });

  // The day first when one is being looked at: it is the number the reader
  // asked for, and the feed-wide total is the context for it rather than the
  // other way round.
  if (detail.day) {
    row.append(
      stat(
        `On ${detail.day.service_date}`,
        detail.day.trips.toLocaleString(),
        detail.day.trips
          ? "Trips this route makes on the day in the toolbar"
          : "This route does not run on the day in the toolbar",
      ),
    );
  }

  row.append(
    stat("Trips", detail.trips.toLocaleString(), "Every trip this route runs, across all service days"),
    stat("First departure", clock(detail.timetable.first_departure), "Earliest departure from any trip's first stop"),
    stat("Last arrival", clock(detail.timetable.last_arrival), "Latest arrival at any trip's last stop"),
    stat(
      "Days running",
      (detail.days_running ?? 0).toLocaleString(),
      "Dates in the feed's window with at least one trip",
    ),
  );
  return section("Summary", span(detail.timetable.first_departure, detail.timetable.last_arrival), [row]);
}

function directions(detail: RouteDetail): HTMLElement {
  const list = node("div", { class: "direction-list" });

  for (const direction of detail.directions) {
    list.append(
      node("div", { class: "direction" }, [
        node("div", {
          class: "direction-label",
          text:
            direction.direction_id === null || direction.direction_id === undefined
              ? "No direction stated"
              : `Direction ${direction.direction_id}`,
        }),
        node("div", { class: "explore-hint", text: direction.headsigns.join(" · ") || "No headsigns in this feed" }),
        node("div", { class: "numeric", text: count(direction.trips, "trip") }),
      ]),
    );
  }

  if (!detail.directions.length) {
    list.append(node("p", { class: "explore-hint", text: "No trips reference this route." }));
  }
  return section("Directions", "What the vehicle displays, and how much runs each way.", [list]);
}

function patterns(detail: RouteDetail, context: ScreenContext): HTMLElement | null {
  if (!detail.patterns.length) return null;

  const total = detail.patterns.reduce((sum, pattern) => sum + pattern.trips, 0);
  const list = node("div", { class: "pattern-list" });
  detail.patterns.forEach((pattern, index) => {
    list.append(patternCard(pattern, index + 1, total, context));
  });

  return section(
    "Stop patterns",
    `The route's trips follow ${count(detail.patterns.length, "different stop sequence")}. One followed by a single trip is usually a short working - or a mistake.`,
    [list],
  );
}

function patternCard(
  pattern: RoutePattern,
  position: number,
  total: number,
  context: ScreenContext,
): HTMLElement {
  const share = total ? Math.round((pattern.trips / total) * 100) : 0;

  const facts = [
    `${pattern.trips.toLocaleString()} of ${total.toLocaleString()} trips (${share}%)`,
    count(pattern.stops.length, "stop"),
    pattern.direction_id === null || pattern.direction_id === undefined
      ? null
      : `direction ${pattern.direction_id}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const header = node("div", { class: "pattern-head" }, [
    node("span", { class: "pattern-name", text: `Pattern ${position}` }),
    node("span", { class: "pattern-headsign", text: pattern.headsign ? `to ${pattern.headsign}` : "" }),
    node("span", { class: "explore-hint", text: facts }),
  ]);

  const stops = node("ol", { class: "stop-sequence" });
  for (const stop of pattern.stops) {
    stops.append(
      node("li", {}, [
        action(stop.stop_name || stop.stop_id, `Open ${stop.stop_id} in stops.txt`, () =>
          context.openTable("stops", [{ column: "stop_id", op: "eq", value: stop.stop_id }]),
        ),
      ]),
    );
  }

  const body = node("div", { class: "pattern-body" }, [stops]);
  if (pattern.example_trip_id) {
    body.append(
      node("div", { class: "pattern-links" }, [
        action(
          `See one of these trips (${pattern.example_trip_id})`,
          "Open this trip's stop_times, with its times",
          () =>
            context.openTable("stop_times", [
              { column: "trip_id", op: "eq", value: pattern.example_trip_id as string },
            ]),
        ),
      ]),
    );
  }

  // Collapsed by default: a sixty-stop sequence is the detail behind a
  // pattern, not the pattern itself, and four of them open at once is a wall.
  const details = node("details", { class: "pattern" });
  details.append(node("summary", {}, [header]), body);
  return details;
}

function week(detail: RouteDetail): HTMLElement {
  const chart = node("div", { class: "weekday-chart" });
  for (const bar of weekdayBars(detail.weekdays)) {
    chart.append(
      node("div", { class: "weekday-row" }, [
        node("span", { class: "weekday-name", text: bar.name }),
        node("span", { class: "weekday-track" }, [
          node("span", { class: "weekday-bar", style: `width:${Math.round(bar.share * 100)}%` }),
        ]),
        node("span", { class: "weekday-value", text: bar.trips.toLocaleString() }),
      ]),
    );
  }

  const list = node("ul", { class: "gap-list" });
  for (const pattern of detail.service_patterns.slice(0, 6)) {
    list.append(
      node("li", {}, [
        node("strong", { text: pattern.name }),
        node("span", { text: ` — ${count(pattern.trips, "trip")} on each of ${pattern.days} days` }),
      ]),
    );
  }

  return section(
    "Service days",
    "Trips on a representative day of each kind, and the patterns this route appears in.",
    [chart, detail.service_patterns.length ? list : null],
  );
}

function hours(detail: RouteDetail): HTMLElement | null {
  const data = detail.timetable.hours;
  if (!data.length) return null;

  const busiest = Math.max(...data.map((hour) => hour.trips));
  const chart = node("div", { class: "hour-chart" });

  // Every hour between the first and the last, including empty ones: a midday
  // gap is a fact about the service, and a chart that omits it reads as
  // continuous.
  const first = data[0].hour;
  const last = data[data.length - 1].hour;
  const byHour = new Map(data.map((hour) => [hour.hour, hour.trips]));

  for (let hour = first; hour <= last; hour += 1) {
    const trips = byHour.get(hour) ?? 0;
    chart.append(
      node("div", { class: "hour", title: `${String(hour).padStart(2, "0")}:00 — ${count(trips, "trip")}` }, [
        node("span", { class: "hour-bar", style: `height:${Math.round((trips / busiest) * 100)}%` }),
        node("span", { class: "hour-label", text: hour % 3 === 0 ? String(hour) : "" }),
      ]),
    );
  }

  return section(
    "Departures by hour",
    "Each trip counted once, at the hour it leaves its first stop. Hours past 23 are the service day running into the next one.",
    [chart],
  );
}

/**
 * Every route, or one agency's.
 *
 * The argument is an `agency_id`, which is what the overview's agency rows
 * link with - a reader clicking "42 routes" beside an operator means that
 * operator's forty-two.
 */
export const routeListScreen: Screen<RouteListing> = {
  id: "routes",
  label: "Routes",
  title: "Every route, with its stops, days and times",
  available: (source: ViewerSource) => typeof source.routes === "function",
  fetch: async (source: ViewerSource, argument?: string, date?: string | null): Promise<RouteListing> => {
    // The day in the toolbar, not every route the feed has ever had: a list of
    // what runs is what someone with a date in mind is asking for.
    const routes = await source.routes!(date ?? undefined);
    return {
      routes: argument ? routes.filter((route) => route.agency_id === argument) : routes,
      agency: argument ?? null,
    };
  },
  render: renderRouteList,
};

/**
 * One route.
 *
 * No label, so it has no sidebar entry: it is opened from the route list with
 * a route in hand, and an entry for "a route" with none in mind would mean
 * nothing.
 */
export const routeScreen: Screen<RouteDetail> = {
  id: "route",
  available: (source: ViewerSource) => typeof source.route === "function",
  fetch: (source: ViewerSource, argument?: string, date?: string | null) =>
    source.route!(argument ?? "", date ?? undefined),
  render: renderRoute,
};
