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

import type { Timetable, TimetableTrip, ViewerSource } from "../../sources/types";
import { destinations, longDate, type Destination } from "../date-bar";
import { spine } from "../../sources/explore/derive";
import { clock, count, routeLabel } from "../explore-format";
import { action, append, node } from "../html";
import type { Screen, ScreenContext } from "./types";

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

/** One direction's trips, and a stop order covering just those. */
function forDirection(data: Timetable, direction: string | null) {
  const trips = data.trips.filter((trip) => (trip.direction_id ?? null) === direction);

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
  | { kind: "choose"; routeId: string; options: Destination[] };

export function renderTimetableView(view: TimetableView, context: ScreenContext): HTMLElement {
  return view.kind === "grid" ? renderTimetable(view.data, context) : chooseDay(view, context);
}

/** Which day? - answered with days this feed has, not a blank date box. */
function chooseDay(view: { routeId: string; options: Destination[] }, context: ScreenContext): HTMLElement {
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
    choices,
  ]);
}

export function renderTimetable(data: Timetable, context: ScreenContext): HTMLElement {
  const root = node("div", { class: "explore timetable" });
  const directions = directionsOf(data);
  let chosen = directions[0];
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

  const draw = () => {
    const { trips, stops, rows } = forDirection(data, chosen);
    grid.replaceChildren(
      trips.length
        ? table(stops, trips, rows, data, context, rawIds, say)
        : node("p", { class: "explore-hint", text: "No trips in this direction on this day." }),
    );
    // The map band exists to show what the grid is about, so it starts on the
    // whole direction: this route, and every stop it calls at today. Selecting
    // a column narrows it to one trip.
    void context.focusRoutes?.([data.route_id], {
      stopIds: stops.map((stop) => stop.stop_id),
      isolate: true,
    });
    say(
      context.focusStop
        ? "On the map: this route and the stops it calls at today. Pick a trip column or a stop to narrow it."
        : "",
    );
  };

  const toggle = node("div", { class: "chip-row" });
  if (directions.length > 1) {
    for (const direction of directions) {
      const headsigns = [
        ...new Set(
          data.trips
            .filter((trip) => (trip.direction_id ?? null) === direction)
            .map((trip) => trip.headsign)
            .filter(Boolean),
        ),
      ];
      const running = data.trips.filter((trip) => (trip.direction_id ?? null) === direction).length;
      const chip = node("button", { class: "chip" });
      chip.append(
        node("span", {
          class: "chip-label",
          text: headsigns.length ? `to ${headsigns[0]}` : `Direction ${direction ?? "—"}`,
        }),
        node("span", { class: "chip-count", text: String(running) }),
      );
      chip.addEventListener("click", () => {
        chosen = direction;
        for (const other of toggle.querySelectorAll(".chip")) other.classList.remove("active");
        chip.classList.add("active");
        draw();
      });
      if (direction === chosen) chip.classList.add("active");
      toggle.append(chip);
    }
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
    node("div", { class: "timetable-controls" }, [directions.length > 1 ? toggle : null, ids]),
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
  say: (text: string) => void,
): HTMLElement {
  const head = node("tr", {}, [node("th", { class: "stop-head", text: rawIds ? "stop_id" : "Stop" })]);

  trips.forEach((trip, column) => {
    const cell = node("th", {
      class: "trip-head",
      title: [trip.trip_id, trip.headsign, trip.block_id && `block ${trip.block_id}`, trip.service_id]
        .filter(Boolean)
        .join(" · "),
    });
    const first = rows[column].find((call) => call?.departure ?? call?.arrival);
    cell.append(
      node("div", {
        class: "trip-time",
        text: clock(data.times_are_windows ? first?.arrival : (first?.departure ?? first?.arrival)),
      }),
    );
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
      const called = stops.filter((_, index) => rows[column][index]).map((stop) => stop.stop_id);
      // Framed on the trip's own stops rather than the route's line: a short
      // working is a piece of the route, and framing on the whole of it would
      // leave the map exactly where it was.
      void context
        .focusRoutes?.([data.route_id], { stopIds: called, isolate: true, frame: "stops" })
        .then(({ points }) =>
          say(
            points
              ? `On the map: ${trip.trip_id}, calling at ${count(points, "stop")}.`
              : `${trip.trip_id} calls at ${count(called.length, "stop")}, none of which the feed gives a position.`,
          ),
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
    const calendar = await source.calendar?.().catch(() => null);
    const today = new Date().toISOString().slice(0, 10);
    return {
      kind: "choose",
      routeId,
      options: calendar ? destinations(calendar.days, calendar.patterns, today) : [],
    };
  },
  render: renderTimetableView,
};
