/**
 * One route's day, as stops by trips.
 *
 * The artefact an operator and a dispatcher actually work from, and the one
 * GTFS makes hardest to see: the times live in `stop_times.txt` keyed by trip,
 * the trips live in `trips.txt` keyed by service, and which services run on a
 * Tuesday is two more files away.
 *
 * Rows are stops, columns are trips, ordered by departure. A trip that does not
 * call somewhere leaves a blank rather than being dropped, so the short working
 * and the express are visible as holes in the grid - which is what someone
 * checking a schedule is looking for.
 *
 * The map above it is the other half of the view: selecting a trip column draws
 * that trip's stops in order, so "where does the 07:45 actually go" is one
 * click rather than a cross-reference.
 */

import type { RouteDetail, Timetable, TimetableTrip, ViewerSource } from "../../sources/types";
import { destinations, longDate, type Destination } from "../date-bar";
import { spine } from "../../sources/explore/derive";
import { clock, count, routeLabel } from "../explore-format";
import { action, append, node } from "../html";
import { mapControls } from "./routes";
import type { FocusResult, Screen, ScreenContext } from "./types";

/**
 * The directions present in a day's trips, in the order a reader expects.
 *
 * A feed that leaves `direction_id` empty has one unnamed direction, which is
 * the common case for a loop or a shuttle and must not render as "no data".
 */
function directionsOf(data: Timetable): (string | null)[] {
  const seen: (string | null)[] = [];
  for (const trip of data.trips) {
    const direction = trip.direction_id ?? null;
    if (!seen.some((entry) => entry === direction)) seen.push(direction);
  }
  return seen.length ? seen : [null];
}

/** Trip ids per lookup: keeps a REST request's URL short whatever the ids look like. */
const SHAPE_BATCH = 100;

/**
 * The shapes trips follow, read from trips.txt through the table query every
 * source answers - the timetable answer does not name shapes, and the API is
 * kept as it is.
 *
 * Remembered per trip, so a chip or a column clicked twice asks once. A trip
 * the feed gives no shape, or whose lookup fails, adds nothing: its stops are
 * still drawn.
 */
export class TripShapes {
  private readonly known = new Map<string, string | null>();

  constructor(private readonly source: ViewerSource) {}

  async of(tripIds: string[]): Promise<string[]> {
    const missing = [...new Set(tripIds.filter((id) => !this.known.has(id)))];
    for (let at = 0; at < missing.length; at += SHAPE_BATCH) {
      const batch = missing.slice(at, at + SHAPE_BATCH);
      for (const id of batch) this.known.set(id, null);
      try {
        const page = await this.source.query(
          "trips",
          [{ column: "trip_id", op: "in", value: batch.join(",") }],
          1,
          batch.length,
        );
        const trip = page.columns.indexOf("trip_id");
        const shape = page.columns.indexOf("shape_id");
        if (trip < 0 || shape < 0) continue;
        for (const row of page.rows) this.known.set(String(row[trip]), row[shape] || null);
      } catch {
        // Left as no shape: the map draws the stops rather than nothing.
      }
    }
    return [...new Set(tripIds.map((id) => this.known.get(id)).filter((id): id is string => Boolean(id)))];
  }
}

/**
 * Put part of this route on the map: the given paths and stops, then say in
 * words what was drawn. `frame: "stops"` frames on the stops rather than the
 * route's line, for a part as short as one trip.
 */
type FocusOn = (
  shapeIds: Promise<string[]>,
  stopIds: string[],
  describe: (drawn: FocusResult) => string,
  frame?: "stops",
) => void;

/**
 * A direction's destinations - its headsigns - most-run first, with how many
 * trips run to each.
 *
 * One direction is often several places: OC Transpo's 82 runs to Lincoln
 * Fields, to Tunney's Pasture, and twice to a school. Naming only one of them
 * on the direction's chip made a school run read as a trip to the terminus
 * that had somehow stopped short.
 */
function destinationsOf(data: Timetable, direction: string | null): { headsign: string | null; trips: number }[] {
  const counts = new Map<string | null, number>();
  for (const trip of data.trips) {
    if ((trip.direction_id ?? null) !== direction) continue;
    const headsign = trip.headsign || null;
    counts.set(headsign, (counts.get(headsign) ?? 0) + 1);
  }
  return [...counts]
    .map(([headsign, trips]) => ({ headsign, trips }))
    .sort((left, right) => right.trips - left.trips || String(left.headsign).localeCompare(String(right.headsign)));
}

/**
 * One direction's trips - narrowed to one destination when `headsign` is
 * given - and a stop order covering just those. `undefined` means every
 * destination, since a headsign can itself be empty.
 */
function forDirection(data: Timetable, direction: string | null, headsign?: string | null) {
  const trips = data.trips.filter(
    (trip) =>
      (trip.direction_id ?? null) === direction && (headsign === undefined || (trip.headsign || null) === headsign),
  );

  // Re-spined per direction rather than reusing the response's combined order:
  // a route's two directions are the same stops in opposite sequence, and one
  // order holding both reads as neither. `spine` is the same function the
  // server builds its order with, so the two cannot drift.
  const sequences = trips.map((trip) =>
    data.stops.map((stop, index) => (trip.calls[index] ? stop.stop_id : null)).filter((id): id is string => Boolean(id)),
  );
  const order = spine(sequences);

  const byId = new Map(data.stops.map((stop, index) => [stop.stop_id, index]));
  const stops = order.map((stopId) => data.stops[byId.get(stopId) ?? 0]);

  const rows = trips.map((trip) => order.map((stopId) => trip.calls[byId.get(stopId) ?? -1] ?? null));
  return { trips, stops, rows };
}

/**
 * What the screen has to draw.
 *
 * A timetable is one route on one day, and nothing is filtered by day until
 * someone asks - so arriving here without a date is the ordinary case, not an
 * error. It asks, offering dates the feed actually has rather than an empty
 * field.
 */
export type TimetableView =
  | { kind: "grid"; data: Timetable }
  | { kind: "choose"; routeId: string; options: Destination[]; detail: RouteDetail | null };

export function renderTimetableView(view: TimetableView, context: ScreenContext): HTMLElement {
  return view.kind === "grid" ? renderTimetable(view.data, context) : chooseDay(view, context);
}

/** Which day? - answered with days this feed has, not a blank date box. */
function chooseDay(
  view: { routeId: string; options: Destination[]; detail: RouteDetail | null },
  context: ScreenContext,
): HTMLElement {
  const choices = node("div", { class: "day-choices" });

  for (const option of view.options) {
    const button = node("button", { class: "day-choice", title: option.note ?? option.date });
    button.append(
      node("span", { class: "day-choice-label", text: option.label }),
      node("span", { class: "day-choice-date", text: longDate(option.date) }),
    );
    button.addEventListener("click", () => context.setDate(option.date));
    choices.append(button);
  }

  if (!view.options.length) {
    choices.append(
      node("p", { class: "explore-hint", text: "This feed states no service dates, so it has no timetable." }),
    );
  }

  return node("div", { class: "explore timetable" }, [
    node("div", { class: "overview-header" }, [
      node("div", {}, [
        node("h2", { text: "Which day?" }),
        node("div", {
          class: "explore-hint",
          text: "A timetable is one route on one day. Pick one and it will be drawn - and the rest of the viewer will show that day too.",
        }),
      ]),
      node("div", { class: "route-actions" }, [
        action("Back to the route", "The route's directions, patterns and days", () =>
          context.openScreen("route", view.routeId),
        ),
      ]),
    ]),
    // The route on the map while a day is picked, drawn the way its card
    // draws it - alone, with the rest of the network off until asked for.
    // Without it the band above showed the whole city, as if no route had
    // been chosen.
    view.detail ? mapControls(view.routeId, view.detail, context) : null,
    choices,
  ]);
}

export function renderTimetable(data: Timetable, context: ScreenContext): HTMLElement {
  const root = node("div", { class: "explore timetable" });
  const directions = directionsOf(data);
  // A trip asked for by the link - the Quality assistant opens a timetable on
  // the trip a notice is about - decides the direction shown first.
  const wantedTrip = context.params.trip ? data.trips.find((trip) => trip.trip_id === context.params.trip) : undefined;
  let chosen = wantedTrip ? (wantedTrip.direction_id ?? null) : directions[0];
  // The destination within it, or undefined for all of them; see forDirection.
  let destination: string | null | undefined = undefined;
  // Local to the view rather than the URL: it is how someone is reading this
  // grid right now, not what the grid is of, and a link that carried it would
  // hand the next reader ids instead of names.
  let rawIds = false;

  const grid = node("div", { class: "timetable-grid-wrap" });
  // What the map is showing, in words - the same contract the route card
  // keeps, because "nothing happened" and "there was nothing to show" look
  // identical on a map otherwise.
  const status = node("div", { class: "explore-hint map-note" });
  const say = (text: string) => void (status.textContent = text);

  // Whether the rest of the network is drawn behind the route. Off by default:
  // the map is here to show what the grid is about, and two hundred other
  // routes around it bury the one being read.
  let showNetwork = false;
  // The last thing put on the map, so the network toggle can redraw it as it
  // was rather than resetting a selected trip back to the whole direction.
  let refocus = () => {};
  const shapes = new TripShapes(context.source);
  // Which selection is the latest. Shapes are looked up before drawing, and a
  // slow lookup must not draw over a chip or column picked after it.
  let latest = 0;

  const focus: FocusOn = (shapeIds, stopIds, describe, frame) => {
    const ticket = (latest += 1);
    void shapeIds.then((found) => {
      if (ticket !== latest) return;
      refocus = () =>
        void context
          .focusRoutes?.([data.route_id], { shapeIds: found, stopIds, isolate: !showNetwork, frame })
          .then((drawn) => say(describe(drawn)));
      refocus();
    });
  };

  const draw = () => {
    const { trips, stops, rows } = forDirection(data, chosen, destination);
    grid.replaceChildren(
      trips.length
        ? table(stops, trips, rows, data, context, rawIds, focus, say, shapes)
        : node("p", { class: "explore-hint", text: "No trips in this direction on this day." }),
    );
    // The map band exists to show what the grid is about, so it draws exactly
    // the trips in it: the paths they follow today and every stop they call
    // at. Every path rather than the longest, so a branch is not lost to the
    // trunk, and only these trips' paths, so a destination chip shows that
    // destination. Selecting a column narrows it to one trip.
    focus(
      shapes.of(trips.map((trip) => trip.trip_id)),
      stops.map((stop) => stop.stop_id),
      ({ lines, points }) =>
        !lines && points
          ? `This route has no shapes in the feed. The ${count(points, "stop")} it calls at today are shown instead.`
          : "On the map: this route and the stops it calls at today. Pick a trip column or a stop to narrow it.",
    );
  };

  const network = node("label", { class: "raw-toggle", title: "Draw every other route behind this one" });
  const networkInput = node("input", { type: "checkbox" }) as HTMLInputElement;
  networkInput.addEventListener("change", () => {
    showNetwork = networkInput.checked;
    refocus();
  });
  network.append(networkInput, document.createTextNode(" Show the rest of the network"));

  // One chip per destination, grouped by direction. A direction with several
  // destinations leads with "All", which keeps the whole direction in one grid
  // - where a short working shows as the holes it leaves - and each
  // destination after it narrows the grid to the trips running there.
  const toggle = node("div", { class: "chip-row destination-chips" });
  const select = (chip: HTMLElement, direction: string | null, headsign: string | null | undefined) => {
    chosen = direction;
    destination = headsign;
    for (const other of toggle.querySelectorAll(".chip")) other.classList.remove("active");
    chip.classList.add("active");
    draw();
  };
  const chipFor = (label: string, trips: number, title: string, direction: string | null, headsign?: string | null) => {
    const chip = node("button", { class: "chip", title });
    chip.append(
      node("span", { class: "chip-label", text: label }),
      node("span", { class: "chip-count", text: String(trips) }),
    );
    chip.addEventListener("click", () => select(chip, direction, headsign));
    if (direction === chosen && headsign === destination) chip.classList.add("active");
    return chip;
  };
  const named = (headsign: string | null, direction: string | null) =>
    headsign ? `to ${headsign}` : `Direction ${direction ?? "—"}, no headsign`;

  let choices = 0;
  for (const direction of directions) {
    const places = destinationsOf(data, direction);
    const group = node("div", { class: "chip-group" });
    if (places.length > 1) {
      const running = places.reduce((sum, place) => sum + place.trips, 0);
      group.append(
        chipFor(
          "All",
          running,
          `Every trip in this direction: ${places.map((place) => place.headsign ?? "no headsign").join(", ")}`,
          direction,
        ),
      );
    }
    for (const place of places) {
      group.append(
        chipFor(
          named(place.headsign, direction),
          place.trips,
          `Only the trips running ${place.headsign ? `to ${place.headsign}` : "with no headsign"}`,
          direction,
          // A direction with one destination is that destination: its chip
          // shows the whole direction rather than narrowing to it.
          places.length > 1 ? place.headsign : undefined,
        ),
      );
    }
    choices += group.childElementCount;
    toggle.append(group);
  }

  // Named for what they are in the feed, because the reason to want them is
  // to go and look something up with them somewhere else.
  const ids = node("label", { class: "raw-toggle", title: "Show stop_id and trip_id instead of names" });
  const idsInput = node("input", { type: "checkbox" }) as HTMLInputElement;
  idsInput.addEventListener("change", () => {
    rawIds = idsInput.checked;
    draw();
  });
  ids.append(idsInput, document.createTextNode(" GTFS ids"));

  append(
    root,
    header(data, context),
    node("div", { class: "timetable-controls" }, [
      choices > 1 ? toggle : null,
      context.focusRoutes ? network : null,
      ids,
    ]),
    context.focusStop ? status : null,
    grid,
    data.truncated
      ? node("p", {
          class: "explore-hint",
          text: "More trips run this day than the grid draws; the busiest columns are shown.",
        })
      : null,
  );
  draw();
  // Select the linked trip as a click would, once the grid is in the page, so
  // its column is tinted and the map narrows to it.
  if (wantedTrip) {
    const cell = [...grid.querySelectorAll<HTMLElement>(".trip-head")].find((head) => head.dataset.trip === wantedTrip.trip_id);
    if (cell) {
      cell.click();
      requestAnimationFrame(() => cell.scrollIntoView({ block: "nearest", inline: "center" }));
    }
  }
  return root;
}

function header(data: Timetable, context: ScreenContext): HTMLElement {
  const label = routeLabel({
    route_id: data.route_id,
    short_name: data.route_short_name,
    long_name: data.route_long_name,
  });

  /**
   * When the day starts and when it ends.
   *
   * Earliest arrival to latest departure rather than min and max of one field:
   * for a booking window the departure *is* the end of the window, so taking
   * both from it reported a day that ran from 19:45 to 19:45.
   */
  const spanOf = (): string => {
    const starts = data.trips
      .flatMap((trip) => trip.calls.map((call) => call?.arrival ?? call?.departure ?? null))
      .filter((time): time is string => Boolean(time));
    const ends = data.trips
      .flatMap((trip) => trip.calls.map((call) => call?.departure ?? call?.arrival ?? null))
      .filter((time): time is string => Boolean(time));

    if (!starts.length && !ends.length) return "No times in this feed";
    const first = starts.reduce((a, b) => (a < b ? a : b), starts[0] ?? ends[0]);
    const last = ends.reduce((a, b) => (a > b ? a : b), ends[0] ?? starts[0]);
    return `${clock(first)} to ${clock(last)}`;
  };

  return node("div", { class: "overview-header" }, [
    append(
      node("div", {}),
      node("h2", { text: `${label} — ${data.service_date}` }),
      node("div", {
        class: "explore-hint",
        // Both directions, which is what the day holds; each chip carries its
        // own count, so the two numbers cannot be read as contradicting.
        text: `${count(data.trips.length, "trip")} across the day · ${spanOf()}`,
      }),
      // Said once, at the top, rather than left for a reader to infer from
      // cells that hold a range where they expected a departure.
      data.times_are_windows
        ? node("div", {
            class: "explore-hint",
            text: "This service runs on demand: the times are the windows it can be booked in, not scheduled departures.",
          })
        : null,
    ),
    node("div", { class: "route-actions" }, [
      action("Back to the route", "The route's directions, patterns and days", () =>
        context.openScreen("route", data.route_id),
      ),
      action("Open its trips", "Open trips.txt filtered to this route", () =>
        context.openTable("trips", [{ column: "route_id", op: "eq", value: data.route_id }]),
      ),
    ]),
  ]);
}

/**
 * What one cell says.
 *
 * A scheduled call is a time. A demand-responsive one is a window it can be
 * booked in, and showing only its start would read as a departure that does
 * not exist.
 */
type Call = NonNullable<TimetableTrip["calls"][number]>;

/**
 * Where a trip starts: its call with the lowest `stop_sequence` that has a
 * time, and that call's row.
 *
 * By sequence, not by the topmost row it calls at: one stop order serves every
 * trip in a direction, so a trip can call at a row high in the grid late in
 * its run - OC Transpo's 82 reaches Pinecrest Mall, the second row, 46 stops
 * after leaving Baseline - and the heading then showed that later time. Calls
 * without a sequence fall back to grid order. The same start the columns are
 * ordered by, so a heading and its column's place agree.
 */
export function departure(calls: (Call | null)[]): { call: Call; index: number } | null {
  let best: { call: Call; index: number } | null = null;
  calls.forEach((call, index) => {
    if (!call || !(call.departure ?? call.arrival)) return;
    if (!best) {
      best = { call, index };
      return;
    }
    const sequence = call.stop_sequence;
    const current = best.call.stop_sequence;
    if (sequence !== null && sequence !== undefined && (current === null || current === undefined || sequence < current)) {
      best = { call, index };
    }
  });
  return best;
}

function cellText(call: TimetableTrip["calls"][number], windows: boolean): string {
  if (!call) return "·";
  const from = call.arrival ?? call.departure;
  const to = call.departure ?? call.arrival;
  if (!from) return "·";
  if (windows && to && to !== from) return `${clock(from)}–${clock(to)}`;
  return clock(call.departure ?? call.arrival);
}

function table(
  stops: Timetable["stops"],
  trips: TimetableTrip[],
  rows: (TimetableTrip["calls"][number] | null)[][],
  data: Timetable,
  context: ScreenContext,
  rawIds: boolean,
  focus: FocusOn,
  say: (text: string) => void,
  shapes: TripShapes,
): HTMLElement {
  // The heading says what the two lines over each column are. Unlabelled, a
  // bare time and a code read as a filter or a clock rather than as a trip.
  const head = node("tr", {}, [
    node("th", { class: "stop-head" }, [
      node("div", { text: rawIds ? "stop_id" : "Stop" }),
      node("div", { class: "trip-block", text: `Each column is a trip: departs · ${rawIds ? "trip_id" : "block"}` }),
    ]),
  ]);

  trips.forEach((trip, column) => {
    const start = departure(rows[column]);
    const leaves = clock(data.times_are_windows ? start?.call.arrival : (start?.call.departure ?? start?.call.arrival));
    const from = start ? stops[start.index].stop_name || stops[start.index].stop_id : null;
    const cell = node("th", {
      class: "trip-head",
      "data-trip": trip.trip_id,
      title: [
        `Trip ${trip.trip_id}${trip.headsign ? ` to ${trip.headsign}` : ""}`,
        from && `departs ${leaves} from ${from}`,
        trip.block_id && `block ${trip.block_id}`,
        trip.service_id && `service ${trip.service_id}`,
      ]
        .filter(Boolean)
        .join(" · ")
        .concat(". Click to show this trip on the map."),
    });
    cell.append(node("div", { class: "trip-time", text: leaves }));
    // The id when it is asked for, the block otherwise: both are the small
    // second line, and a column carrying both reads as two labels for one
    // thing. The time stays the heading either way - it is what orders the
    // columns, and a grid headed by ids cannot be read as a timetable.
    if (rawIds) cell.append(node("div", { class: "trip-block", text: trip.trip_id }));
    else if (trip.block_id) cell.append(node("div", { class: "trip-block", text: trip.block_id }));

    // Selecting a column draws that trip's stops on the map, in the order it
    // calls at them - the question the grid provokes and cannot answer itself.
    cell.addEventListener("click", () => {
      for (const other of head.querySelectorAll(".trip-head")) other.classList.remove("selected");
      cell.classList.add("selected");
      // The whole column, not just its heading: a tinted cell at the top of a
      // long grid is easy to lose once it has scrolled out of view.
      for (const other of body.querySelectorAll(".col-selected")) other.classList.remove("col-selected");
      for (const row of body.rows) row.cells[column + 1]?.classList.add("col-selected");
      const called = stops.filter((_, index) => rows[column][index]).map((stop) => stop.stop_id);
      // Drawn along the trip's own shape, not the route's representative one,
      // which a short working or a branch may not follow. Framed on the trip's
      // own stops rather than the route's line: a short working is a piece of
      // the route, and framing on the whole of it would leave the map exactly
      // where it was.
      focus(
        shapes.of([trip.trip_id]),
        called,
        ({ points }) =>
          points
            ? `On the map: ${trip.trip_id}, calling at ${count(points, "stop")}.`
            : `${trip.trip_id} calls at ${count(called.length, "stop")}, none of which the feed gives a position.`,
        "stops",
      );
    });
    head.append(cell);
  });

  const body = node("tbody");
  stops.forEach((stop, index) => {
    const name = stop.stop_name || stop.stop_id;
    const primary = rawIds ? stop.stop_id : name;
    const secondary = rawIds ? (stop.stop_name ?? "") : stop.stop_id;

    // The map is directly above this grid, so a stop row's first job is to
    // put the stop on it. The file is one click further, on the other label.
    const label = node("button", { class: "stop-name", title: `Show ${primary} on the map` });
    label.append(document.createTextNode(primary));
    label.addEventListener("click", () => {
      for (const other of body.querySelectorAll(".stop-cell")) other.classList.remove("selected");
      label.closest(".stop-cell")?.classList.add("selected");
      void context.focusStop?.(stop.stop_id).then((found) =>
        say(
          found
            ? `On the map: ${name}.`
            : `${name} has no position in this feed, so it cannot be shown on the map.`,
        ),
      );
    });

    const cell = node("td", { class: "stop-cell" }, [label]);
    if (context.focusStop === undefined) {
      // No map to put it on, so the label is the link into the file instead.
      cell.replaceChildren(
        action(primary, `Open ${stop.stop_id} in stops.txt`, () =>
          context.openTable("stops", [{ column: "stop_id", op: "eq", value: stop.stop_id }]),
        ),
      );
    } else {
      cell.append(
        action(secondary || "stops.txt", `Open ${stop.stop_id} in stops.txt`, () =>
          context.openTable("stops", [{ column: "stop_id", op: "eq", value: stop.stop_id }]),
        ),
      );
    }

    const row = node("tr", {}, [cell]);
    trips.forEach((trip, column) => {
      const call = rows[column][index];
      const text = cellText(call, Boolean(data.times_are_windows));
      const blank = text === "·";
      const time = node("td", {
        class: blank ? "time-cell time-blank" : "time-cell",
        title: blank
          ? "This trip does not call here"
          : `${name} · ${text} · open this call in stop_times.txt`,
        text,
      });
      // A cell is one row of stop_times.txt, and the two ids that identify it
      // are both in hand. Blank cells are not: there is no row behind them,
      // which is the whole point of drawing them as holes.
      if (!blank) {
        time.classList.add("time-linked");
        time.addEventListener("click", () =>
          context.openTable("stop_times", [
            { column: "trip_id", op: "eq", value: trip.trip_id },
            { column: "stop_id", op: "eq", value: stop.stop_id },
          ]),
        );
      }
      row.append(time);
    });
    body.append(row);
  });

  return node("div", { class: "timetable-scroll" }, [
    node("table", { class: "timetable" }, [node("thead", {}, [head]), body]),
  ]);
}

/**
 * The timetable screen.
 *
 * Unlisted: it is opened from a route with a route in hand, like the route card
 * is opened from the route list. `layout: "above"` because a grid of trip
 * columns needs the width, and a map beside it would leave room for four.
 */
export const timetableScreen: Screen<TimetableView> = {
  id: "timetable",
  layout: "above",
  available: (source: ViewerSource) => typeof source.timetable === "function",
  fetch: async (source: ViewerSource, argument?: string, date?: string | null): Promise<TimetableView> => {
    const routeId = argument ?? "";
    if (date) return { kind: "grid", data: await source.timetable!(routeId, date) };

    // No day chosen, which is the default state: ask, with dates drawn from
    // the feed's own calendar so every option is a day that exists.
    const [calendar, detail] = await Promise.all([
      source.calendar?.().catch(() => null),
      // Only for the map: a route that cannot be described still has days to
      // choose from, so a failure here leaves the map alone rather than the
      // screen.
      source.route?.(routeId).catch(() => null),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return {
      kind: "choose",
      routeId,
      options: calendar ? destinations(calendar.days, calendar.patterns, today) : [],
      detail: detail ?? null,
    };
  },
  render: renderTimetableView,
};
