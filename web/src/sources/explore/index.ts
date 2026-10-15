/**
 * The derived views, computed in the browser.
 *
 * What `core/service.py`, `core/overview.py` and `core/network.py` answer over
 * HTTP, assembled here from the same SQL against Parquet read by DuckDB-WASM.
 * This is what makes the static deployment - a bucket of `{table}.parquet` and
 * a manifest, with no server of ours anywhere - a first-class integration
 * rather than one that degrades to the file browser.
 *
 * `scripts/integrations.sh conformance` asks this and the Python implementation
 * for the same payloads over the same feed and diffs them. That is what keeps
 * two implementations of one answer honest - and it has already earned it,
 * catching a stop list that silently decoded to nothing and an `any_value`
 * that returned a different example trip on each run.
 */

import { schemaTables } from "../../schema";
import type {
  CalendarDay,
  CalendarSummary,
  Overview,
  RouteDetail,
  RouteSummary,
  Timetable,
} from "../types";
import {
  clockFromSeconds,
  MAX_DAYS,
  MAX_DAYS_RETURNED,
  MAX_TIMETABLE_TRIPS,
  secondsFromClock,
  servicePatterns,
  spine,
  weekdayProfile,
} from "./derive";
import {
  activeServicesSql,
  agenciesSql,
  agencyNameSql,
  boundsSql,
  countSql,
  dailyServiceSql,
  directionsSql,
  has,
  modesSql,
  NoCalendarError,
  routeListSql,
  routeRowSql,
  routeStopTimesSql,
  routeTimetableSql,
  timeColumns,
  stopNamesSql,
  type Catalogue,
} from "./sql";

export { NoCalendarError } from "./sql";
export type { Catalogue } from "./sql";

/** How many stop-sequence variants to describe. Mirrors `MAX_PATTERNS`. */
const MAX_PATTERNS = 12;

/**
 * What a feed can carry beyond the basics, and the evidence that it does.
 * Mirrors `FEATURES` in `core/overview.py`; `table.column` means the capability
 * is a column on a file every feed already has.
 */
const FEATURES: [string, string, string[]][] = [
  ["Route shapes", "Lines on the map rather than straight hops between stops.", ["shapes"]],
  ["Frequencies", "Service stated as a headway over a window instead of trip by trip.", ["frequencies"]],
  ["Fares v2", "Fares as products, media and leg rules.", ["fare_products", "fare_leg_rules", "fare_media"]],
  ["Fares v1", "The original fare model: attributes and rules.", ["fare_attributes", "fare_rules"]],
  ["Transfers", "Where and how riders change between services.", ["transfers"]],
  ["Pathways", "Walking connections inside stations.", ["pathways", "levels"]],
  ["Flex", "On-demand zones and booking rules.", ["locations", "booking_rules", "location_groups"]],
  ["Translations", "Names and descriptions in more than one language.", ["translations"]],
  [
    "Accessibility",
    "Whether a stop can be boarded and a trip ridden in a wheelchair.",
    ["stops.wheelchair_boarding", "trips.wheelchair_accessible"],
  ],
  ["Headsigns", "What the vehicle displays, which is what a rider looks for.", ["trips.trip_headsign"]],
];

/** Runs one statement and returns its rows. Supplied by the source. */
export type Run = (sql: string) => Promise<Record<string, unknown>[]>;

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * A column `to_json` produced, back as a value.
 *
 * Decoded already in one case and not the other: a `to_json` column arrives as
 * text, but one nested inside another `to_json` is embedded as a JSON value and
 * arrives decoded. Stringifying that would give `"a,b,c"`, which parses as
 * nothing and silently became an empty stop list.
 */
function parse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * What `route_type` names, spelled out.
 *
 * GTFS's own ten values come from the packaged schema - the same document the
 * Python side reads. The extended set, the 100s and 700s a European feed uses,
 * is not in the reference's enumeration, so those are reported by number rather
 * than guessed at.
 */
function modeLabel(routeType: string | null): string {
  const values = schemaTables.routes?.fields?.route_type?.values as Record<string, string> | undefined;
  if (routeType && values?.[routeType]) return values[routeType];
  return routeType ? `Type ${routeType}` : "Unspecified";
}

/** Today, as the service window's `days_remaining` counts from. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function daysBetween(from: Date, to: string): number {
  const target = Date.parse(`${to}T00:00:00Z`);
  return Math.round((target - from.getTime()) / 86_400_000);
}

export interface Explore {
  overview(): Promise<Overview>;
  calendar(): Promise<CalendarSummary>;
  routes(serviceDate?: string): Promise<RouteSummary[]>;
  route(routeId: string, serviceDate?: string): Promise<RouteDetail>;
  timetable(routeId: string, serviceDate: string, directionId?: string | null): Promise<Timetable>;
}

export class UnknownRouteError extends Error {}
export class UnknownDirectionError extends Error {}

export function createExplore(run: Run, catalogue: Catalogue): Explore {
  const one = async (sql: string | null): Promise<Record<string, unknown> | null> => {
    if (!sql) return null;
    const rows = await run(sql);
    return rows[0] ?? null;
  };

  const count = async (table: string, where = ""): Promise<number> => {
    const row = await one(countSql(catalogue, table, where));
    return row ? num(row.n) : 0;
  };

  /** The feed's window, clamped the way `core/service.py` clamps it. */
  const bounds = async (): Promise<{ first: string; last: string; truncated: boolean }> => {
    const row = await one(boundsSql(catalogue));
    if (!row?.first_date) throw new NoCalendarError("No readable dates in this feed's calendar.");

    const first = String(row.first_date);
    let last = String(row.last_date);
    const span = daysBetween(new Date(Date.parse(`${first}T00:00:00Z`)), last);
    const truncated = span > MAX_DAYS;
    if (truncated) {
      last = new Date(Date.parse(`${first}T00:00:00Z`) + MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
    }
    return { first, last, truncated };
  };

  /** The services running on one date, or none when it is outside the feed. */
  const activeServices = async (serviceDate: string): Promise<string[]> => {
    try {
      const { first, last } = await bounds();
      if (serviceDate < first || serviceDate > last) return [];
      const rows = await run(activeServicesSql(catalogue, serviceDate, serviceDate, serviceDate));
      return rows.map((row) => String(row.service_id)).sort();
    } catch (error) {
      if (error instanceof NoCalendarError) return [];
      throw error;
    }
  };

  const dailyService = async (routeId?: string): Promise<{ days: CalendarDay[]; truncated: boolean }> => {
    const { first, last, truncated } = await bounds();
    const rows = await run(dailyServiceSql(catalogue, first, last, MAX_DAYS_RETURNED, routeId));
    const days: CalendarDay[] = rows.map((row) => ({
      service_date: String(row.service_date),
      weekday: num(row.weekday),
      services: parse<string[]>(row.services, []),
      trips: num(row.trips),
      routes: num(row.routes),
    }));
    if (truncated && days.length) days[days.length - 1].truncated = true;
    return { days, truncated };
  };

  return {
    async overview(): Promise<Overview> {
      const published: Record<string, string | null> = {};
      const wanted = [
        "feed_publisher_name",
        "feed_publisher_url",
        "feed_lang",
        "feed_version",
        "feed_start_date",
        "feed_end_date",
      ].filter((name) => has(catalogue, "feed_info", name));
      if (wanted.length) {
        const row = await one(
          `SELECT ${wanted.map((name) => `"${name}"`).join(", ")} FROM ${catalogue.file("feed_info")} LIMIT 1`,
        );
        for (const name of wanted) published[name] = text(row?.[name]);
      }

      // Stops only, not stations: counting a station's own node alongside its
      // platforms inflates every feed that models stations.
      const boarding = has(catalogue, "stops", "location_type")
        ? "WHERE location_type IS NULL OR location_type IN ('', '0')"
        : "";

      const [routes, stops, stations, trips, stopTimes, shapes, services, zones, groups] = await Promise.all([
        count("routes"),
        catalogue.columns("stops") ? count("stops", boarding) : 0,
        has(catalogue, "stops", "location_type") ? count("stops", "WHERE location_type = '1'") : 0,
        count("trips"),
        count("stop_times"),
        has(catalogue, "shapes", "shape_id")
          ? one(`SELECT COUNT(DISTINCT shape_id) AS n FROM ${catalogue.file("shapes")}`).then((row) => num(row?.n))
          : 0,
        has(catalogue, "trips", "service_id")
          ? one(`SELECT COUNT(DISTINCT service_id) AS n FROM ${catalogue.file("trips")}`).then((row) => num(row?.n))
          : 0,
        // A demand-responsive feed has no stops and no shapes; it has zones a
        // rider is picked up in, and groups of them.
        catalogue.columns("locations") ? count("locations") : 0,
        has(catalogue, "location_groups", "location_group_id")
          ? one(
              `SELECT COUNT(DISTINCT location_group_id) AS n FROM ${catalogue.file("location_groups")}`,
            ).then((row) => num(row?.n))
          : 0,
      ]);

      const agencySql = agenciesSql(catalogue);
      const agencies = agencySql
        ? (await run(agencySql)).map((row) => ({
            agency_id: text(row.agency_id),
            name: String(row.agency_name),
            timezone: text(row.tz),
            url: text(row.url),
            routes: num(row.routes),
          }))
        : [];

      const modeQuery = modesSql(catalogue);
      const modes = modeQuery
        ? (await run(modeQuery)).map((row) => ({
            route_type: text(row.route_type),
            label: modeLabel(text(row.route_type)),
            routes: num(row.n),
          }))
        : [];

      let service: Overview["service"];
      try {
        const { first, last, truncated } = await bounds();
        service = {
          first_date: first,
          last_date: last,
          days_remaining: daysBetween(today(), last),
          truncated,
        };
      } catch (error) {
        service = {
          first_date: null,
          last_date: null,
          days_remaining: null,
          note: (error as Error).message,
        };
      }

      const features = FEATURES.map(([name, description, evidence]) => {
        const tables = [
          ...new Set(
            evidence
              .map((item) => {
                const [table, column] = item.split(".");
                return has(catalogue, table, ...(column ? [column] : [])) ? table : null;
              })
              .filter((table): table is string => Boolean(table)),
          ),
        ].sort();
        return { name, description, present: tables.length > 0, tables };
      });

      return {
        published,
        agencies,
        modes,
        counts: {
          routes,
          stops,
          stations,
          trips,
          stop_times: stopTimes,
          shapes,
          services,
          zones,
          location_groups: groups,
        },
        service,
        features,
      };
    },

    async calendar(): Promise<CalendarSummary> {
      const { days, truncated } = await dailyService();
      return {
        first_date: days.length ? days[0].service_date : null,
        last_date: days.length ? days[days.length - 1].service_date : null,
        days,
        patterns: servicePatterns(days),
        weekdays: weekdayProfile(days),
        truncated,
      };
    },

    async routes(serviceDate?: string): Promise<RouteSummary[]> {
      let services: string[] | undefined;
      if (serviceDate) {
        services = await activeServices(serviceDate);
        if (!services.length) return [];
      }
      const sql = routeListSql(catalogue, services);
      if (!sql) return [];
      return (await run(sql)).map((row) => ({
        route_id: String(row.route_id),
        short_name: text(row.short_name),
        long_name: text(row.long_name),
        route_type: text(row.route_type),
        mode: modeLabel(text(row.route_type)),
        color: text(row.color),
        text_color: text(row.text_color),
        agency_id: text(row.agency_id),
        agency_name: text(row.agency_name),
        trips: num(row.trips),
        services: num(row.services),
      }));
    },

    async route(routeId: string, serviceDate?: string): Promise<RouteDetail> {
      const row = await one(routeRowSql(catalogue, routeId));
      if (!row) throw new UnknownRouteError(`Unknown route '${routeId}'`);
      const route: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(row)) route[name] = text(value);

      const directionQuery = directionsSql(catalogue, routeId);
      const directions = directionQuery
        ? (await run(directionQuery)).map((entry) => ({
            direction_id: text(entry.direction_id),
            trips: num(entry.trips),
            headsigns: parse<string[]>(entry.headsigns, []).slice(0, 6),
            // Capped: a route whose every trip has its own shape would hand the
            // map thousands of ids to fetch at once.
            shape_ids: parse<string[]>(entry.shapes, []).slice(0, 40),
          }))
        : [];

      const stopTimes = await one(routeStopTimesSql(catalogue, routeId, MAX_PATTERNS));
      const rawPatterns = parse<
        { stops: string; direction_id: string | null; headsign: string | null; trips: number; example_trip: string | null }[]
      >(stopTimes?.patterns, []);

      const stopIds = [...new Set(rawPatterns.flatMap((pattern) => parse<string[]>(pattern.stops, [])))];
      const namesQuery = stopNamesSql(catalogue, stopIds);
      const names = new Map<string, string>();
      if (namesQuery) {
        for (const entry of await run(namesQuery)) names.set(String(entry.stop_id), String(entry.stop_name));
      }

      const patterns = rawPatterns.map((pattern) => ({
        direction_id: pattern.direction_id ?? null,
        headsign: pattern.headsign ?? null,
        trips: num(pattern.trips),
        example_trip_id: pattern.example_trip ?? null,
        stops: parse<string[]>(pattern.stops, []).map((stopId) => ({
          stop_id: stopId,
          stop_name: names.get(stopId) ?? null,
        })),
      }));

      const histogram = new Map<number, number>();
      for (const departure of parse<number[]>(stopTimes?.departures, [])) {
        const hour = Math.floor(num(departure) / 3600);
        histogram.set(hour, (histogram.get(hour) ?? 0) + 1);
      }

      let days: CalendarDay[] = [];
      try {
        days = (await dailyService(routeId)).days;
      } catch (error) {
        if (!(error instanceof NoCalendarError)) throw error;
      }
      const running = days.filter((day) => day.trips);

      let agencyName: string | null = null;
      const agencyQuery = agencyNameSql(catalogue, route.agency_id ?? null);
      if (agencyQuery) {
        const rows = await run(agencyQuery);
        agencyName = rows.length === 1 || route.agency_id ? text(rows[0]?.agency_name) : null;
      }

      // What the route does on the day being looked at, beside what it does
      // across the feed. Null when no day was named, and zero - rather than
      // null - on a day it does not run, which is an answer.
      const chosen = serviceDate ? days.find((day) => day.service_date === serviceDate) : undefined;

      return {
        day: chosen ? { service_date: chosen.service_date, trips: chosen.trips } : null,
        route,
        mode: modeLabel(route.route_type ?? null),
        agency_name: agencyName,
        trips: directions.reduce((total, direction) => total + direction.trips, 0),
        directions,
        patterns,
        timetable: {
          first_departure: clockFromSeconds(
            stopTimes?.first_departure === null || stopTimes?.first_departure === undefined
              ? null
              : num(stopTimes.first_departure),
          ),
          last_arrival: clockFromSeconds(
            stopTimes?.last_arrival === null || stopTimes?.last_arrival === undefined
              ? null
              : num(stopTimes.last_arrival),
          ),
          hours: [...histogram.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([hour, trips]) => ({ hour, trips })),
        },
        weekdays: weekdayProfile(days),
        service_patterns: servicePatterns(days).filter((pattern) => pattern.trips),
        first_date: running.length ? running[0].service_date : null,
        last_date: running.length ? running[running.length - 1].service_date : null,
        days_running: running.length,
      };
    },

    async timetable(routeId: string, serviceDate: string, directionId?: string | null): Promise<Timetable> {
      const row = await one(routeRowSql(catalogue, routeId));
      if (!row) throw new UnknownRouteError(`Unknown route '${routeId}'`);

      const empty: Timetable = {
        route_id: routeId,
        direction_id: directionId ?? null,
        service_date: serviceDate,
        route_short_name: text(row.route_short_name),
        route_long_name: text(row.route_long_name),
        stops: [],
        trips: [],
        truncated: false,
        times_are_windows: false,
      };

      const services = await activeServices(serviceDate);
      if (!services.length) return empty;

      const sql = routeTimetableSql(catalogue, routeId, services, directionId);
      if (!sql) return empty;

      const rows = await run(sql);
      if (!rows.length) {
        if (directionId !== undefined && directionId !== null) {
          throw new UnknownDirectionError(
            `Route '${routeId}' has no trips in direction '${directionId}' on ${serviceDate}.`,
          );
        }
        return empty;
      }

      interface Call {
        arrival: string | null;
        departure: string | null;
        stop_sequence: number | null;
      }
      interface Building {
        trip_id: string;
        direction_id: string | null;
        headsign: string | null;
        service_id: string | null;
        block_id: string | null;
        sequence: string[];
        calls: Map<string, Call>;
      }
      const building = new Map<string, Building>();

      for (const entry of rows) {
        const tripId = String(entry.trip_id);
        let trip = building.get(tripId);
        if (!trip) {
          trip = {
            trip_id: tripId,
            direction_id: text(entry.direction_id),
            headsign: text(entry.headsign),
            service_id: text(entry.service_id),
            block_id: text(entry.block_id),
            sequence: [],
            calls: new Map(),
          };
          building.set(tripId, trip);
        }
        const stopId = String(entry.stop_id);
        trip.sequence.push(stopId);
        trip.calls.set(stopId, {
          arrival: text(entry.arrives) || null,
          departure: text(entry.departs) || null,
          stop_sequence: entry.seq === null || entry.seq === undefined ? null : num(entry.seq),
        });
      }

      const order = spine([...building.values()].map((trip) => trip.sequence));

      /**
       * Seconds at a trip's first call, for ordering the columns.
       *
       * The earliest of the two times rather than the departure: for a booking
       * window the departure *is* the end of the window, so ordering by it put
       * a trip bookable 09:00-15:00 before one bookable from 05:45.
       *
       * Trips with no time at all sort last rather than first: a feed with
       * empty times should not put its unusable columns at the front of every
       * timetable.
       */
      const leaves = (trip: Building): number => {
        for (const stopId of trip.sequence) {
          const call = trip.calls.get(stopId);
          const known = [secondsFromClock(call?.arrival), secondsFromClock(call?.departure)].filter(
            (value): value is number => value !== null,
          );
          if (known.length) return Math.min(...known);
        }
        return 2 ** 30;
      };

      const ordered = [...building.values()].sort(
        (left, right) => leaves(left) - leaves(right) || (left.trip_id < right.trip_id ? -1 : 1),
      );

      const namesQuery = stopNamesSql(catalogue, order);
      const names = new Map<string, string>();
      if (namesQuery) {
        for (const entry of await run(namesQuery)) names.set(String(entry.stop_id), String(entry.stop_name));
      }

      return {
        ...empty,
        // True when the times are booking windows rather than scheduled calls,
        // so a reader is not shown "05:45" for a service that runs on demand
        // between 05:45 and 19:45.
        times_are_windows: timeColumns(catalogue).windows,
        stops: order.map((stopId) => ({ stop_id: stopId, stop_name: names.get(stopId) ?? null })),
        trips: ordered.slice(0, MAX_TIMETABLE_TRIPS).map((trip) => ({
          trip_id: trip.trip_id,
          direction_id: trip.direction_id,
          headsign: trip.headsign,
          service_id: trip.service_id,
          block_id: trip.block_id,
          // Aligned to `stops`, so a cell is a column index away and a trip
          // that does not call somewhere leaves a hole rather than being
          // squeezed out of the grid.
          calls: order.map((stopId) => trip.calls.get(stopId) ?? null),
        })),
        truncated: ordered.length > MAX_TIMETABLE_TRIPS,
      };
    },
  };
}
