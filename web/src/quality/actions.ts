/**
 * What each action kind does.
 *
 * Every kind drives one surface. Content actions decide which table or screen
 * the step shows; map actions add to one annotation the step draws in a single
 * pass; panel actions return a block for the assistant panel. A step runs its
 * content action first, because the screen it opens resets the map, and then
 * the rest together; the step is shown when all of them have settled, so the
 * table, the map and the narration never arrive out of step with each other.
 *
 * The kinds are a closed list, implemented once here and checked by the build
 * (`ACTIONS` in `src/gtfs_garage/quality/guides.py`). `custom` is the escape hatch: it
 * calls a handler the host registered, and is the only kind that is code.
 */

import type { MapAnnotation, MapHandle, MapLabel, MapMotion } from "../mount";
import type { Filter, GeoFeature, TableInfo, ViewerSource } from "../sources/types";
import type { TableMarks, View } from "../state";
import { node, prose } from "../ui/html";
import type { MapSelection } from "../ui/files-map";
import { bestPracticesUrl, sectionUrl, tableOf, type NoticeDescription } from "./catalog";
import { isLocated, type Located, type Unlocatable } from "./locate";
import { asText } from "./template";
import type { ResolvedAction, ResolvedStep } from "./walkthrough";
import { descriptionBlocks, renderBlock } from "./description";
import { showColors, showColumns, showFiles, showValue, timeline } from "./explainers";

/** A host's own action. Returns a block for the panel, or nothing. */
export type CustomAction = (
  args: Record<string, unknown>,
  context: ActionContext,
) => HTMLElement | null | void | Promise<HTMLElement | null | void>;

export interface ActionContext {
  source: ViewerSource;
  tables: TableInfo[];
  notice?: NoticeDescription;
  map?: MapHandle;
  /** Draw these routes, shapes and stops alone; see `FilesMap.pick`. */
  pick?: (selection: MapSelection) => void;
  /** Point the table at the row read from this line, or at none; for a motion passing calls. */
  followLine?: (line: number | null) => void;
  customActions: Record<string, CustomAction>;
}

// ------------------------------------------------------------------ content

/** What a step puts in the content pane: a table view or a screen, with marks for a table. */
export interface ContentTarget {
  view: Omit<View, "date" | "assist">;
  marks: TableMarks | null;
}

const gtfsDate = (value: unknown) => {
  const text = asText(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text || undefined;
};

/**
 * Which of the rows an `open_rows` shows it points at: those its `mark`
 * locator finds, the lines it was widened `around`, or all of them.
 */
function rowsToMark(action: ResolvedAction, shown: Located): Pick<TableMarks, "lines" | "key"> {
  const mark = action.located.mark;
  if (mark && isLocated(mark)) {
    if (mark.by === "line" && mark.lines) return { lines: mark.lines };
    if (mark.by === "key") return { key: mark.filters.map(({ column, value }) => ({ column, value: asText(value) })) };
  }
  if (Number(action.args.around) > 0 && shown.by === "line" && shown.lines) return { lines: shown.lines };
  return {};
}

/** Where a step's content action takes the reader, or null to stay where they are. */
export function contentTarget(step: ResolvedStep): ContentTarget | null {
  for (const action of step.carried ? [...step.actions, step.carried] : step.actions) {
    if (action.kind === "open_rows" || action.kind === "follow_link") {
      const located = action.located[action.kind === "open_rows" ? "at" : "to"];
      if (!located || !isLocated(located)) continue;
      // A composite key arrives as one name, "service_id,date".
      const highlight = (Array.isArray(action.args.highlight) ? action.args.highlight.map(asText) : [])
        .flatMap((name) => name.split(","))
        .map((name) => name.trim())
        .filter(Boolean);
      return {
        view: { table: located.table, filters: located.filters, page: 1 },
        marks: { fields: highlight, ...rowsToMark(action, located) },
      };
    }
    if (action.kind === "timetable" && action.args.route) {
      const params: Record<string, string> = {};
      if (action.args.trip) params.trip = asText(action.args.trip);
      return {
        view: { table: "", filters: [], page: 1, screen: "timetable", argument: asText(action.args.route), params },
        marks: null,
      };
    }
    if (action.kind === "calendar") {
      return { view: { table: "", filters: [], page: 1, screen: "calendar" }, marks: null };
    }
  }
  return null;
}

/** A day a content action asks for, as YYYY-MM-DD, or undefined to keep the current one. */
export function contentDate(step: ResolvedStep): string | undefined {
  const action = step.actions.find((entry) => (entry.kind === "calendar" || entry.kind === "timetable") && entry.args.date);
  return action ? gtfsDate(action.args.date) : undefined;
}

/** The first rows matching, as column -> value records. */
async function records(context: ActionContext, table: string, filters: Filter[]): Promise<Record<string, string | null>[]> {
  if (!context.tables.some((entry) => entry.name === table)) return [];
  const page = await context.source.query(table, filters, 1, 500).catch(() => null);
  return page ? page.rows.map((row) => Object.fromEntries(page.columns.map((column, i) => [column, row[i]]))) : [];
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const fromGtfs = (value: string | null | undefined) => (value && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : null);

/**
 * A day a trip runs, as YYYY-MM-DD: `prefer` if it runs then, else the first
 * day from `today` on, else its first day at all; null when the feed says it
 * never runs. A timetable step needs one to show the trip, and the sample
 * rarely names it.
 */
export async function serviceDay(context: ActionContext, trip: string, today: string, prefer?: string): Promise<string | null> {
  const [found] = await records(context, "trips", [{ column: "trip_id", op: "eq", value: trip }]);
  const service = found?.service_id;
  if (!service) return null;
  const [calendar] = await records(context, "calendar", [{ column: "service_id", op: "eq", value: service }]);
  const exceptions = await records(context, "calendar_dates", [{ column: "service_id", op: "eq", value: service }]);
  const added = new Set(exceptions.filter((row) => row.exception_type === "1").map((row) => fromGtfs(row.date)));
  const removed = new Set(exceptions.filter((row) => row.exception_type === "2").map((row) => fromGtfs(row.date)));
  const start = fromGtfs(calendar?.start_date);
  const end = fromGtfs(calendar?.end_date);
  const runs = (day: string) => {
    if (removed.has(day)) return false;
    if (added.has(day)) return true;
    if (!calendar || !start || !end || day < start || day > end) return false;
    return calendar[WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]] === "1";
  };
  if (prefer && runs(prefer)) return prefer;
  const days = [...added].filter((day): day is string => day !== null && runs(day)).sort();
  const first = (from: string): string | null => {
    const candidates = days.filter((day) => day >= from);
    if (start && end) {
      const cursor = new Date(`${from > start ? from : start}T00:00:00Z`);
      for (let i = 0; i < 400 && isoDay(cursor) <= end; i += 1, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        if (runs(isoDay(cursor))) {
          candidates.push(isoDay(cursor));
          break;
        }
      }
    }
    return candidates.sort()[0] ?? null;
  };
  return first(today) ?? first("0000-00-00");
}

// --------------------------------------------------------------------- map

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres between two [lon, lat] points. */
export function distanceMetres(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10_000 ? 2 : 1)} km`;
}

/** A validator coordinate pair, `[lat, lon]`, as a map position `[lon, lat]`. */
function fromLatLon(value: unknown): [number, number] | null {
  const pair = Array.isArray(value) ? value.map(Number) : asText(value).split(",").map(Number);
  if (pair.length !== 2 || pair.some((n) => !Number.isFinite(n))) return null;
  return [pair[1], pair[0]];
}

/**
 * Ids, from a list or one value. The validator sometimes packs several into one
 * string - "R10, RR1" - so each value is split on commas.
 */
const ids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((item) => asText(item).split(/\s*,\s*/))
    .filter(Boolean);

async function stopPositions(source: ViewerSource, stopIds: string[]): Promise<Map<string, [number, number]>> {
  const positions = new Map<string, [number, number]>();
  if (!stopIds.length) return positions;
  const collection = await source.geojson("stops", [...new Set(stopIds)]).catch(() => null);
  for (const feature of collection?.features ?? []) {
    const id = (feature.properties as { stop_id?: string } | null)?.stop_id;
    const coordinates = (feature.geometry as { coordinates?: [number, number] } | null)?.coordinates;
    if (id && coordinates) positions.set(id, coordinates);
  }
  return positions;
}

/** One end of a measured line: a stop by id, or a point the validator reported. */
async function endpoint(
  value: unknown,
  source: ViewerSource,
): Promise<{ at: [number, number]; name: string } | null> {
  const end = (value ?? {}) as { stop?: unknown; point?: unknown };
  if (end.point !== undefined) {
    const at = fromLatLon(end.point);
    return at ? { at, name: "the matched point" } : null;
  }
  if (end.stop !== undefined) {
    const id = asText(end.stop);
    const at = (await stopPositions(source, [id])).get(id);
    return at ? { at, name: id } : null;
  }
  return null;
}

interface MapWork {
  features: GeoFeature[];
  labels: MapLabel[];
  notes: string[];
  motion?: MapMotion;
  motions?: MapMotion[];
}

/** One call of a trip, with its times in seconds after midnight of the service day. */
export interface Call {
  stop: string;
  sequence: number;
  arrival: number | null;
  departure: number | null;
  line: number | null;
}

/** A GTFS time, which may run past 24:00, in seconds; null when empty or malformed. */
export function gtfsSeconds(value: string | null | undefined): number | null {
  const match = /^\s*(\d{1,3}):([0-5]\d):([0-5]\d)\s*$/.exec(value ?? "");
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/** Seconds after midnight as HH:MM:SS, the way the feed writes them. */
export function clock(seconds: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(seconds / 3600)}:${pad((seconds % 3600) / 60)}:${pad(seconds % 60)}`;
}

/** A trip's calls in stop_sequence order. */
async function tripCalls(context: ActionContext, trip: string): Promise<Call[]> {
  if (!trip || !context.tables.some((table) => table.name === "stop_times")) return [];
  const page = await context.source
    .query("stop_times", [{ column: "trip_id", op: "eq", value: trip }], 1, 500, { lines: true })
    .catch(() => null);
  if (!page) return [];
  const at = (column: string) => page.columns.indexOf(column);
  return page.rows
    .map((row, index) => ({
      stop: row[at("stop_id")] ?? "",
      sequence: Number(row[at("stop_sequence")]),
      arrival: gtfsSeconds(row[at("arrival_time")]),
      departure: gtfsSeconds(row[at("departure_time")]),
      line: page.lines?.[index] ?? null,
    }))
    .filter((call) => call.stop)
    .sort((a, b) => a.sequence - b.sequence);
}

/** The way from one call to the next: how far, how long, how fast. */
export interface TripLeg {
  from: number;
  metres: number;
  /** Departure from one to arrival at the next, as the validator counts it; null when either time is missing. */
  seconds: number | null;
  /** km/h; Infinity for a distance covered in no time, null when a time is missing. */
  kmh: number | null;
}

/** The legs between consecutive placed calls. `placed[i]` is the position of `calls[i]`. */
export function tripLegs(calls: Call[], placed: [number, number][]): TripLeg[] {
  const legs: TripLeg[] = [];
  for (let i = 0; i + 1 < calls.length; i += 1) {
    const metres = distanceMetres(placed[i], placed[i + 1]);
    const leave = calls[i].departure ?? calls[i].arrival;
    const reach = calls[i + 1].arrival ?? calls[i + 1].departure;
    // Times given to the minute may hide up to a minute, so gtfs-validator
    // allows one more, and so does this, or the speed shown here would not be
    // the speed in the report (12 km from 06:00:00 to 06:01:00: 360 km/h).
    const rounded = leave !== null && reach !== null && leave % 60 === 0 && reach % 60 === 0 ? 60 : 0;
    const seconds = leave !== null && reach !== null ? reach - leave + rounded : null;
    const kmh = seconds === null ? null : seconds > 0 ? (metres / seconds) * 3.6 : metres > 0 ? Infinity : 0;
    legs.push({ from: i, metres, seconds, kmh });
  }
  return legs;
}

export function formatSpeed(kmh: number | null): string {
  if (kmh === null) return "";
  return Number.isFinite(kmh) ? `${Math.round(kmh).toLocaleString("en")} km/h` : "no time allowed";
}

/**
 * Times for calls the feed leaves blank - the stops between timepoints - by
 * distance between the nearest timed ones, so a motion can pass them.
 */
function interpolatedTimes(calls: Call[], placed: [number, number][]): { arrival: number; departure: number }[] | null {
  const known = calls.map((call) => call.arrival ?? call.departure);
  if (known.filter((value) => value !== null).length < 2) return null;
  const along = [0];
  for (let i = 1; i < placed.length; i += 1) along.push(along[i - 1] + distanceMetres(placed[i - 1], placed[i]));
  const times: { arrival: number; departure: number }[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    if (known[i] !== null) {
      const arrival = calls[i].arrival ?? calls[i].departure!;
      times.push({ arrival, departure: Math.max(arrival, calls[i].departure ?? arrival) });
      continue;
    }
    let before = i - 1;
    while (before >= 0 && known[before] === null) before -= 1;
    let after = i + 1;
    while (after < calls.length && known[after] === null) after += 1;
    const anchor = before >= 0 ? before : after;
    if (before < 0 || after >= calls.length) {
      times.push({ arrival: known[anchor]!, departure: known[anchor]! });
      continue;
    }
    const leave = calls[before].departure ?? known[before]!;
    const span = along[after] - along[before];
    const value = leave + (span > 0 ? ((along[i] - along[before]) / span) * (known[after]! - leave) : 0);
    times.push({ arrival: value, departure: value });
  }
  return times;
}

/**
 * The calls of a trip a step is about, placed on the map.
 *
 * `from` and `to` name the stops of interest; the window is the leg between
 * them and `around` calls either side, or the whole trip when neither is given.
 */
async function placedCalls(
  context: ActionContext,
  args: Record<string, unknown>,
  work: MapWork,
): Promise<{ calls: Call[]; placed: [number, number][]; numbers: number[]; focus: [number, number] | null } | null> {
  const trip = asText(args.trip);
  const all = await tripCalls(context, trip);
  if (!all.length) {
    work.notes.push(`Trip ${trip} has no calls in stop_times.txt to draw.`);
    return null;
  }
  const from = asText(args.from);
  const to = asText(args.to);
  let first = from ? all.findIndex((call, i) => call.stop === from && (!to || all[i + 1]?.stop === to)) : -1;
  if (from && first < 0) first = all.findIndex((call) => call.stop === from);
  let last = to ? all.findIndex((call, i) => call.stop === to && i > first) : -1;
  if (first < 0 && last >= 0) first = last;
  if (last < 0) last = first;
  const around = Math.max(0, Math.floor(Number(args.around ?? 2)) || 0);
  const [start, end] = first < 0 ? [0, all.length - 1] : [Math.max(0, first - around), Math.min(all.length - 1, last + around)];

  const positions = await stopPositions(context.source, all.slice(start, end + 1).map((call) => call.stop));
  const calls: Call[] = [];
  const placed: [number, number][] = [];
  const numbers: number[] = [];
  for (let i = start; i <= end; i += 1) {
    const position = positions.get(all[i].stop);
    if (!position) continue;
    calls.push(all[i]);
    placed.push(position);
    numbers.push(i + 1);
  }
  if (!calls.length) {
    work.notes.push(`None of trip ${trip}'s stops has a position in this feed.`);
    return null;
  }
  const focus = first >= 0 ? [first, last].map((i) => numbers.indexOf(i + 1)).filter((i) => i >= 0) : [];
  return { calls, placed, numbers, focus: focus.length === 2 ? [focus[0], focus[1]] : null };
}

/** Lines and labels for the legs: each leg's speed at its middle, over the limit or on the focused leg in the warning colour. */
function drawLegs(
  work: MapWork,
  legs: TripLeg[],
  placed: [number, number][],
  over: (leg: TripLeg) => boolean,
  speeds: boolean,
): void {
  for (const leg of legs) {
    const a = placed[leg.from];
    const b = placed[leg.from + 1];
    // Only the leg at fault in the warning colour; the rest are the comparison.
    const tone = over(leg) ? "over" : "leg";
    work.features.push({ type: "Feature", properties: { tone }, geometry: { type: "LineString", coordinates: [a, b] } } as GeoFeature);
    if (speeds && leg.kmh !== null && leg.metres > 0) {
      work.labels.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], text: formatSpeed(leg.kmh), tone });
    }
  }
}

async function mapAction(action: ResolvedAction, context: ActionContext, work: MapWork): Promise<void> {
  const { args } = action;
  if (action.kind === "map_focus") {
    const selection = { routeIds: ids(args.routes), shapeIds: ids(args.shapes), stopIds: ids(args.stops) };
    if (selection.routeIds.length || selection.shapeIds.length || selection.stopIds.length) context.pick?.(selection);
    // A shape the map cannot draw is worth saying, or the reader looks for a
    // line that is not there. One point, or none, is not a line.
    if (selection.shapeIds.length) {
      const drawn = await context.source.geojson("shapes", selection.shapeIds).catch(() => null);
      const found = new Set((drawn?.features ?? []).map((feature) => (feature.properties as { shape_id?: string } | null)?.shape_id));
      const missing = selection.shapeIds.filter((id) => !found.has(id));
      if (drawn && missing.length) {
        work.notes.push(`Shape ${missing.join(", ")} has fewer than two points in shapes.txt, so there is no line to draw.`);
      }
    }
    // Zones of locations.geojson, drawn as the areas they are; two that are
    // about the same thing - overlapping, or one inside the other - both show.
    const zones = ids(args.locations);
    if (zones.length) {
      const drawn = await context.source.geojson("locations", zones).catch(() => null);
      const found = drawn?.features ?? [];
      for (const feature of found) work.features.push({ ...feature, properties: { ...(feature.properties ?? {}), tone: zones.indexOf(String((feature as { id?: unknown }).id ?? (feature.properties as { id?: unknown } | null)?.id)) > 0 ? "over" : undefined } } as GeoFeature);
      if (!found.length) work.notes.push(`Zone ${zones.join(", ")} could not be drawn: locations.geojson has no such zone this viewer can read.`);
    }
    for (const point of Array.isArray(args.points) ? args.points : []) {
      const at = fromLatLon(point);
      if (at) work.features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: at } } as GeoFeature);
    }
    return;
  }

  if (action.kind === "map_measure") {
    const [from, to] = await Promise.all([endpoint(args.from, context.source), endpoint(args.to, context.source)]);
    if (!from || !to) {
      work.notes.push("One end of the distance has no position in this feed, so it cannot be drawn.");
      return;
    }
    const metres = distanceMetres(from.at, to.at);
    const threshold = Number(args.threshold);
    const over = Number.isFinite(threshold) && threshold > 0 && metres > threshold;
    const tone = over ? "over" : undefined;
    work.features.push(
      { type: "Feature", properties: { tone }, geometry: { type: "LineString", coordinates: [from.at, to.at] } } as GeoFeature,
      { type: "Feature", properties: { tone }, geometry: { type: "Point", coordinates: to.at } } as GeoFeature,
    );
    const middle: [number, number] = [(from.at[0] + to.at[0]) / 2, (from.at[1] + to.at[1]) / 2];
    work.labels.push({
      at: middle,
      text: over ? `${formatDistance(metres)} (limit ${formatDistance(threshold)})` : formatDistance(metres),
      tone,
    });
    return;
  }

  if (action.kind === "map_race") {
    await race(action, context, work);
    return;
  }

  if (action.kind === "map_sequence" || action.kind === "map_play") {
    const window = await placedCalls(context, action.kind === "map_sequence" ? { trip: args.trip } : args, work);
    if (!window) return;
    const { calls, placed, numbers, focus } = window;
    // The trip alone: the rest of the network is not what the step is about.
    context.pick?.({ routeIds: [], shapeIds: [], stopIds: [...new Set(calls.map((call) => call.stop))] });
    const marked = new Set(ids(args.mark ?? [args.from, args.to].filter(Boolean)));
    const limit = Number(args.limit);
    const legs = tripLegs(calls, placed);
    const over = (leg: TripLeg) =>
      (focus !== null && leg.from >= focus[0] && leg.from < focus[1]) ||
      (marked.has(calls[leg.from].stop) && marked.has(calls[leg.from + 1].stop)) ||
      (Number.isFinite(limit) && limit > 0 && leg.kmh !== null && leg.kmh > limit);
    drawLegs(work, legs, placed, over, action.kind === "map_play" || Boolean(args.speeds));
    calls.forEach((call, i) => {
      work.labels.push({ at: placed[i], text: String(numbers[i]), tone: marked.has(call.stop) ? "marked" : "sequence" });
    });
    if (action.kind !== "map_play") return;

    const times = interpolatedTimes(calls, placed);
    if (!times) {
      work.notes.push("Too few of these calls have times to play the trip.");
      return;
    }
    // Arrive, wait out the dwell, leave: each leg's text rides with the
    // marker, and reaching a call points the table at its row.
    const path: MapMotion["path"] = [];
    const lineAt: (number | null)[] = [];
    calls.forEach((call, i) => {
      const leg = legs[i];
      const next = times[i + 1];
      const moving = leg && next ? `${clock(times[i].departure)} \u2192 ${clock(next.arrival)}  ${formatSpeed(leg.kmh)}`.trim() : clock(times[i].arrival);
      const tone = leg && over(leg) ? ("over" as const) : undefined;
      if (times[i].departure > times[i].arrival) {
        path.push({ at: placed[i], time: times[i].arrival, text: `${clock(times[i].arrival)} at stop ${numbers[i]}` });
        lineAt.push(call.line);
      }
      path.push({ at: placed[i], time: times[i].departure, text: moving, tone });
      lineAt.push(call.line);
    });
    work.motion = {
      path,
      onReach: (index) => context.followLine?.(index < 0 ? null : (lineAt[index] ?? null)),
    };
  }
}

/**
 * The speeds gtfs-validator allows, by route type: the table in the
 * description of fast_travel_between_consecutive_stops. Anything else, 200.
 */
const SPEED_LIMITS: Record<string, { kmh: number; vehicle: string }> = {
  "0": { kmh: 100, vehicle: "a tram" },
  "1": { kmh: 150, vehicle: "a subway train" },
  "2": { kmh: 500, vehicle: "a train" },
  "3": { kmh: 150, vehicle: "a bus" },
  "4": { kmh: 80, vehicle: "a ferry" },
  "5": { kmh: 30, vehicle: "a cable tram" },
  "6": { kmh: 50, vehicle: "an aerial lift" },
  "7": { kmh: 50, vehicle: "a funicular" },
  "11": { kmh: 150, vehicle: "a trolleybus" },
  "12": { kmh: 150, vehicle: "a monorail" },
};

/** The fastest a trip's vehicle could go, from its route's type. */
async function speedLimit(context: ActionContext, trip: string): Promise<{ kmh: number; vehicle: string }> {
  const route = await tripRoute(context, trip).catch(() => null);
  const row = route ? await firstRow({ table: "routes", by: "key", filters: [{ column: "route_id", op: "eq", value: route }] }, context) : null;
  return SPEED_LIMITS[String(row?.route_type ?? "")] ?? { kmh: 200, vehicle: "a vehicle" };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function minutes(seconds: number): string {
  const value = seconds / 60;
  return `${value.toLocaleString("en", { maximumFractionDigits: value < 10 ? 1 : 0 })} min`;
}

/** How long one race takes on screen, for the slower of the two. */
const RACE_MS = 6000;

/**
 * The trip as scheduled, racing a vehicle at the fastest speed its kind could
 * keep, over the stretch from one stop to another.
 *
 * Both leave the first stop together; the scheduled one arrives in the time
 * the timetable gives, the other in the time the distance really needs. One
 * arriving long before the other is the finding, seen rather than read. The
 * card says it in numbers, for a reader who asked for reduced motion too.
 */
async function race(action: ResolvedAction, context: ActionContext, work: MapWork): Promise<void> {
  const { args } = action;
  const trip = asText(args.trip);
  const window = await placedCalls(context, { trip, from: args.from, to: args.to, around: 0 }, work);
  if (!window) return;
  const { calls, placed, focus } = window;
  if (!focus || focus[1] <= focus[0]) {
    work.notes.push(`The two stops are not both on trip ${trip} in this order, so there is no stretch to race on.`);
    return;
  }
  const legs = tripLegs(calls, placed).filter((leg) => leg.from >= focus[0] && leg.from < focus[1]);
  const metres = legs.reduce((sum, leg) => sum + leg.metres, 0);
  const scheduled = legs.every((leg) => leg.seconds !== null) ? legs.reduce((sum, leg) => sum + (leg.seconds ?? 0), 0) : null;
  if (scheduled === null || metres <= 0) {
    work.notes.push("These calls have no times to race on.");
    return;
  }
  const given = Number(args.limit);
  const limit = given > 0 ? { kmh: given, vehicle: "a vehicle" } : await speedLimit(context, trip);
  const needed = metres / (limit.kmh / 3.6);
  const kmh = scheduled > 0 ? (metres / scheduled) * 3.6 : Infinity;

  context.pick?.({ routeIds: [], shapeIds: [], stopIds: [...new Set(calls.map((call) => call.stop))] });
  // No speed label on the leg: the racing markers say it, and a label there would sit under them.
  drawLegs(work, legs, placed, () => true, false);
  work.labels.push({ at: placed[focus[0]], text: "1", tone: "marked" }, { at: placed[focus[1]], text: "2", tone: "marked" });

  // One clock for both: the slower takes RACE_MS, the faster its share of it.
  const longest = Math.max(scheduled, needed, 1);
  const cycle = RACE_MS + 1800;
  const along = (seconds: number, text: string, arrived: string) => {
    let travelled = 0;
    const path: MapMotion["path"] = [{ at: placed[focus[0]], time: 0, text }];
    for (const leg of legs) {
      travelled += leg.metres;
      path.push({ at: placed[leg.from + 1], time: (travelled / metres) * seconds, text });
    }
    path[path.length - 1] = { ...path[path.length - 1], text: arrived };
    return path;
  };
  work.motions = [
    {
      path: along(scheduled, `As scheduled: ${formatSpeed(kmh)}`, `Arrives after ${minutes(scheduled)}`),
      duration: (RACE_MS * scheduled) / longest,
      cycle,
    },
    {
      path: along(needed, `${capital(limit.vehicle)} at ${limit.kmh} km/h`, `Needs ${minutes(needed)}`).map((entry) => ({ ...entry, tone: undefined })),
      duration: (RACE_MS * needed) / longest,
      cycle,
      look: "ghost",
    },
  ];
  // Times to the minute may hide up to a minute, which gtfs-validator allows
  // for, and so does the race: say so, or "2 min" reads as a mistake beside 06:00 to 06:01.
  const rounded = legs.some((leg) => {
    const leave = calls[leg.from].departure ?? calls[leg.from].arrival;
    const reach = calls[leg.from + 1].arrival ?? calls[leg.from + 1].departure;
    return leave !== null && reach !== null && leave % 60 === 0 && reach % 60 === 0;
  });
  work.notes.push(
    `${rounded ? "Even allowing for times rounded to the minute, the timetable gives at most" : "The timetable gives"} ` +
      `${minutes(scheduled)} for ${formatDistance(metres)}, ${formatSpeed(kmh)}. ` +
      `At ${limit.kmh} km/h, the most gtfs-validator allows ${limit.vehicle}, it takes ${minutes(needed)}.`,
  );
}

/** Run a step's map actions together and draw what they produce as one annotation. */
export async function runMapActions(step: ResolvedStep, context: ActionContext): Promise<string[]> {
  const mapped = step.actions.filter((action) => action.kind.startsWith("map_"));
  if (!mapped.length || !context.map) return [];
  const work: MapWork = { features: [], labels: [], notes: [] };
  await Promise.all(mapped.map((action) => mapAction(action, context, work).catch(() => undefined)));
  const annotation: MapAnnotation = {
    features: { type: "FeatureCollection", features: work.features },
    labels: work.labels,
    motion: work.motion,
    motions: work.motions,
  };
  const drawn = work.features.length || work.labels.length;
  await context.map.annotate(drawn ? annotation : null, { frame: Boolean(drawn) });
  return work.notes;
}

// ------------------------------------------------------------------- panel

/** The first row a locator finds, as column -> value, or null. */
/**
 * The route a trip belongs to, from trips.txt: what a timetable step needs
 * when the notice names only the trip, as most about one trip do.
 */
export async function tripRoute(context: ActionContext, trip: string): Promise<string | null> {
  const row = await firstRow({ table: "trips", by: "key", filters: [{ column: "trip_id", op: "eq", value: trip }] }, context);
  return row?.route_id ?? null;
}

async function firstRow(located: Located, context: ActionContext): Promise<Record<string, string | null> | null> {
  const page = await context.source.query(located.table, located.filters, 1, 1).catch(() => null);
  if (!page?.rows.length) return null;
  return Object.fromEntries(page.columns.map((column, index) => [column, page.rows[0][index]]));
}

function problem(located: Located | Unlocatable | undefined): string | null {
  if (!located) return "This action names no rows.";
  return isLocated(located) ? null : located.problem;
}

function note(text: string): HTMLElement {
  return node("p", { class: "assistant-note", text });
}

function describeField(table: string, column: string, tables: TableInfo[]): string {
  const info = tables.find((entry) => entry.name === table)?.columns.find((entry) => entry.name === column);
  if (!info) return "Not a field GTFS defines.";
  const parts = [
    info.type ? `Type ${info.type}.` : null,
    info.required === "always" ? "Required." : info.required === "conditional" ? `Conditionally required: ${info.condition ?? ""}` : "Optional.",
    info.condition_outcome ? `In this feed: ${info.condition_outcome.holds ? "required" : "not required"} (${info.condition_outcome.evidence}).` : null,
    info.when_empty ? `Empty means ${info.when_empty.label}.` : null,
    info.values && Object.keys(info.values).length
      ? `Allowed: ${Object.entries(info.values)
          .map(([code, label]) => `${code} (${label})`)
          .join(", ")}.`
      : null,
  ];
  return parts.filter(Boolean).join(" ");
}

async function showRecord(action: ResolvedAction, context: ActionContext): Promise<HTMLElement> {
  const located = action.located.at;
  const why = problem(located);
  if (why) return note(why);
  const where = located as Located;
  const row = await firstRow(where, context);
  if (!row) return note(`No row of ${where.table}.txt matches, so there is nothing to show.`);
  const fields = (Array.isArray(action.args.fields) ? action.args.fields.map(asText) : []).filter(Boolean);
  const list = node("dl", { class: "assistant-record" });
  for (const field of fields.length ? fields : Object.keys(row)) {
    const value = row[field];
    list.append(
      node("dt", { text: field }),
      node("dd", {}, [
        node("code", { class: value === null || value === "" ? "assistant-empty" : undefined, text: value === null || value === "" ? "(empty)" : value }),
        node("span", { class: "assistant-hint", text: describeField(where.table, field, context.tables) }),
      ]),
    );
  }
  return node("div", { class: "assistant-block" }, [node("div", { class: "assistant-block-title", text: `${where.table}.txt` }), list]);
}

async function compareRecords(action: ResolvedAction, context: ActionContext): Promise<HTMLElement> {
  const why = problem(action.located.a) ?? problem(action.located.b);
  if (why) return note(why);
  const [a, b] = await Promise.all([
    firstRow(action.located.a as Located, context),
    firstRow(action.located.b as Located, context),
  ]);
  if (!a || !b) return note("One of the two rows could not be read, so they cannot be compared.");
  const wanted = Array.isArray(action.args.fields) ? action.args.fields.map(asText) : [];
  const fields = wanted.length ? wanted : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const describe = (located: Located) => (located.lines?.length ? `line ${located.lines.join(", ")}` : located.filters.map((f) => f.value).join(", "));
  const table = node("table", { class: "assistant-compare" }, [
    node("thead", {}, [
      node("tr", {}, [
        node("th", { text: "field" }),
        node("th", { text: describe(action.located.a as Located) }),
        node("th", { text: describe(action.located.b as Located) }),
      ]),
    ]),
  ]);
  const body = node("tbody");
  for (const field of fields) {
    const same = (a[field] ?? "") === (b[field] ?? "");
    body.append(
      node("tr", { class: same ? "assistant-same" : "assistant-differs" }, [
        node("td", { text: field }),
        node("td", { text: a[field] ?? "" }),
        node("td", { text: b[field] ?? "" }),
      ]),
    );
  }
  table.append(body);
  return node("div", { class: "assistant-block" }, [
    node("div", { class: "assistant-block-title", text: "Side by side. Equal values are dimmed." }),
    node("div", { class: "assistant-scroll" }, [table]),
  ]);
}

/**
 * The part of the GTFS model a notice involves: its files and how they link.
 *
 * Read from the loaded feed's own column metadata, so only links that exist in
 * this feed are drawn, and the edge a notice is about is picked out.
 */
function showModel(action: ResolvedAction, context: ActionContext): HTMLElement {
  const files = ids(action.args.files).map(tableOf);
  const edge = (action.args.edge ?? {}) as { from?: unknown; to?: unknown };
  const strip = (value: unknown) => asText(value).replace(/\.txt\./, ".").replace(/\.geojson\./, ".");
  const wanted = edge.from ? `${strip(edge.from)}->${strip(edge.to)}` : null;
  const list = node("ul", { class: "assistant-model" });
  const seen = new Set<string>();
  for (const name of files) {
    const info = context.tables.find((table) => table.name === name);
    if (!info) {
      list.append(node("li", { class: "assistant-differs", text: `${name}.txt is not in this feed.` }));
      continue;
    }
    for (const column of info.columns) {
      // A file pointing at itself (a stop's parent station) is not how the
      // files connect, which is what this is drawing.
      if (!column.fk_table || column.fk_table === name || !files.includes(column.fk_table)) continue;
      const key = `${name}.${column.name}->${column.fk_table}.${column.fk_column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.append(
        node("li", { class: key === wanted ? "assistant-edge" : undefined }, [
          node("code", { text: `${name}.${column.name}` }),
          " refers to ",
          node("code", { text: `${column.fk_table}.${column.fk_column}` }),
        ]),
      );
    }
  }
  if (wanted && !seen.has(wanted)) {
    const [from, to] = wanted.split("->");
    list.prepend(node("li", { class: "assistant-edge" }, [node("code", { text: from }), " refers to ", node("code", { text: to })]));
  }
  if (!list.childElementCount) list.append(node("li", { text: files.map((file) => `${file}.txt`).join(", ") }));
  return node("div", { class: "assistant-block" }, [node("div", { class: "assistant-block-title", text: "How the files connect" }), list]);
}

/** Most rows a chart reads, in pages of 500. */
const CHART_ROWS = 2000;

async function chart(action: ResolvedAction, context: ActionContext): Promise<HTMLElement> {
  const why = problem(action.located.at);
  if (why) return note(why);
  const where = action.located.at as Located;
  const x = asText(action.args.x);
  const y = asText(action.args.y);
  const marked = new Set(ids(action.args.mark).map(Number));
  const points: { x: number; y: number; line: number | null }[] = [];
  let total = 0;
  for (let page = 1; points.length < CHART_ROWS; page += 1) {
    const result = await context.source.query(where.table, where.filters, page, 500, { lines: true }).catch(() => null);
    if (!result) break;
    total = result.total;
    const xi = result.columns.indexOf(x);
    const yi = result.columns.indexOf(y);
    if (xi < 0 || yi < 0) return note(`${where.table}.txt has no ${xi < 0 ? x : y} column to chart.`);
    result.rows.forEach((row, index) => {
      const px = Number(row[xi]);
      const py = Number(row[yi]);
      if (Number.isFinite(px) && Number.isFinite(py) && row[yi] !== null && row[yi] !== "") {
        points.push({ x: px, y: py, line: result.lines?.[index] ?? null });
      }
    });
    if (page * 500 >= result.total) break;
  }
  if (points.length < 2) return note(`Fewer than two rows have both ${x} and ${y}, so there is nothing to chart.`);
  points.sort((a, b) => a.x - b.x);

  const width = 520;
  const height = 160;
  const pad = { left: 48, right: 12, top: 10, bottom: 24 };
  const [minX, maxX] = [points[0].x, points[points.length - 1].x];
  const ys = points.map((point) => point.y);
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const sx = (value: number) => pad.left + ((value - minX) / (maxX - minX || 1)) * (width - pad.left - pad.right);
  const sy = (value: number) => height - pad.bottom - ((value - minY) / (maxY - minY || 1)) * (height - pad.top - pad.bottom);
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "assistant-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${y} by ${x}`);
  const add = (tag: string, attributes: Record<string, string>, text?: string) => {
    const element = document.createElementNS(svgNs, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (text) element.textContent = text;
    svg.append(element);
  };
  add("line", { x1: String(pad.left), y1: String(height - pad.bottom), x2: String(width - pad.right), y2: String(height - pad.bottom), class: "chart-axis" });
  add("polyline", { points: points.map((point) => `${sx(point.x)},${sy(point.y)}`).join(" "), class: "chart-line" });
  for (const point of points) {
    if (point.line !== null && marked.has(point.line)) add("circle", { cx: String(sx(point.x)), cy: String(sy(point.y)), r: "4.5", class: "chart-mark" });
  }
  add("text", { x: String(pad.left - 6), y: String(sy(maxY) + 4), "text-anchor": "end", class: "chart-label" }, String(maxY));
  add("text", { x: String(pad.left - 6), y: String(sy(minY)), "text-anchor": "end", class: "chart-label" }, String(minY));
  add("text", { x: String(pad.left), y: String(height - 6), class: "chart-label" }, String(minX));
  add("text", { x: String(width - pad.right), y: String(height - 6), "text-anchor": "end", class: "chart-label" }, String(maxX));

  return node("div", { class: "assistant-block" }, [
    node("div", {
      class: "assistant-block-title",
      text: `${y} by ${x}${total > points.length && total > CHART_ROWS ? `, first ${CHART_ROWS.toLocaleString("en")} rows` : ""}`,
    }),
    svg,
  ]);
}

function fix(action: ResolvedAction): HTMLElement {
  const lines = Array.isArray(action.args.lines) ? action.args.lines.map(asText) : [];
  return node("div", { class: "assistant-block assistant-fixes" }, [
    node("div", { class: "assistant-block-title", text: "Also check" }),
    node("ol", {}, lines.map((line) => node("li", {}, prose(line)))),
  ]);
}

/** Where in `full` the text `said` ends, matching whitespace loosely. */
function skipTo(full: string, said: string): number {
  let at = 0;
  for (const char of said.replace(/\s+/g, " ")) {
    if (char === " ") {
      while (at < full.length && /\s/.test(full[at])) at += 1;
    } else if (full[at] === char) {
      at += 1;
    } else {
      return 0;
    }
  }
  return at;
}

function reference(action: ResolvedAction, context: ActionContext): HTMLElement | null {
  const notice = context.notice;
  if (!notice) return null;
  const links: HTMLElement[] = [
    ...notice.sections.map((section) => node("a", { href: sectionUrl(section), target: "_blank", rel: "noopener noreferrer", text: `Spec: ${section}` })),
    ...notice.best_practices_files.map((file) =>
      node("a", { href: bestPracticesUrl(file), target: "_blank", rel: "noopener noreferrer", text: `Best practices: ${file}` }),
    ),
    ...notice.urls.map((url) => node("a", { href: url.url, target: "_blank", rel: "noopener noreferrer", text: url.label })),
  ];
  // What the step's sentence already said is not said again; whitespace is
  // compared loosely, since the sentence was joined onto one line.
  const said = asText(action.args.said);
  const full = (notice.description || notice.summary).trim();
  const loose = (text: string) => text.replace(/\s+/g, " ");
  const rest = said && loose(full).startsWith(loose(said)) ? full.slice(skipTo(full, said)).trim() : full;
  const blocks = descriptionBlocks(rest);
  // A sentence ending on a colon introduces what follows - the speed limits
  // per route type - which is shown under it rather than folded away.
  const shown = said.trimEnd().endsWith(":") && blocks[0]?.kind === "table" ? blocks.shift()! : null;
  if (!blocks.length && !links.length) return shown ? renderBlock(shown) : null;
  const folded = node("details", { class: "assistant-block assistant-reference" }, [
    node("summary", { class: "assistant-block-title", text: "The rule, in the validator's words" }),
    ...blocks.map(renderBlock),
    links.length ? node("div", { class: "assistant-links" }, links) : null,
  ]);
  return shown ? node("div", {}, [renderBlock(shown), folded]) : folded;
}

/**
 * What an `open_rows` action adds to the panel: the finding when it expects
 * nothing, or why the rows could not be found.
 */
async function rowsNote(action: ResolvedAction, context: ActionContext): Promise<HTMLElement | null> {
  const located = action.located.at;
  const why = problem(located);
  if (why) return note(why);
  const where = located as Located;
  // "any": no rows is a fine answer, and nothing to say about it.
  if (action.args.expect === "any") return null;
  if (action.args.expect !== "empty") {
    if (where.by === "line" && context.tables.find((table) => table.name === where.table)?.lines === "approximate") {
      return note(`Line numbers in ${where.table}.txt could not be checked against the file, so these rows may be off by a few lines.`);
    }
    return null;
  }
  const page = await context.source.query(where.table, where.filters, 1, 1).catch(() => null);
  if (!page) return null;
  return note(
    page.total === 0
      ? `No row of ${where.table}.txt matches. That empty result is the finding.`
      : `${page.total.toLocaleString("en")} rows of ${where.table}.txt match now, though the validator found none. The feed may have changed since the report was made.`,
  );
}

async function panelAction(action: ResolvedAction, context: ActionContext): Promise<HTMLElement | null> {
  switch (action.kind) {
    case "open_rows":
      return rowsNote(action, context);
    case "follow_link": {
      const why = problem(action.located.from) ?? problem(action.located.to);
      if (why) return note(why);
      const [from, to] = [action.located.from as Located, action.located.to as Located];
      return note(`From ${from.table}.txt to ${to.table}.txt, by ${to.filters.map((f) => `${f.column} = ${f.value}`).join(" and ")}.`);
    }
    case "show_record":
      return showRecord(action, context);
    case "compare_records":
      return compareRecords(action, context);
    case "show_model":
      return showModel(action, context);
    case "chart":
      return chart(action, context);
    case "show_files":
      return showFiles(action, context);
    case "show_columns":
      return showColumns(action, context);
    case "show_value":
      return showValue(action);
    case "show_colors":
      return showColors(action);
    case "timeline":
      return timeline(action);
    case "fix":
      return fix(action);
    case "reference":
      return reference(action, context);
    case "custom": {
      const handler = context.customActions[asText(action.args.handler)];
      if (!handler) return note(`This viewer has no action called ${asText(action.args.handler)}.`);
      return (await handler((action.args.args ?? {}) as Record<string, unknown>, context)) ?? null;
    }
    default:
      return action.kind.startsWith("map_") || action.kind === "timetable" || action.kind === "calendar"
        ? null
        : note(`This viewer does not know how to ${action.kind.replace(/_/g, " ")}; the step is shown without it.`);
  }
}

/** Build every panel block for a step, together, in the order the guide lists them. */
export async function runPanelActions(step: ResolvedStep, context: ActionContext): Promise<HTMLElement[]> {
  const built = await Promise.all(
    step.actions.map((action) =>
      panelAction(action, context).catch((error: Error) => note(`Could not ${action.kind.replace(/_/g, " ")}: ${error.message}`)),
    ),
  );
  return built.filter((block): block is HTMLElement => block !== null);
}

/** The filters a step's table view should match, for checking that the reader is still on it. */
export function sameRows(a: Filter[], b: Filter[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
