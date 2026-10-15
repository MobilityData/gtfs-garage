/**
 * The part of the derived views that is not SQL.
 *
 * Ported from `core/service.py`, function for function, because a browser
 * reading Parquet has no server to ask. The port is deliberate duplication and
 * the only duplication in the feature: everything else here is SQL, which both
 * runtimes send to the same engine.
 *
 * What keeps the two honest is `scripts/integrations.sh conformance`, which
 * asks both for the same payloads over the same feed and diffs them. Change
 * either side alone and it fails until they agree again.
 *
 * Pure, so all of it is testable without DuckDB.
 */

import type { CalendarDay, ServicePattern, WeekdayProfile } from "../types";

/** DuckDB's dayofweek() is 0 = Sunday, which is also what the payload carries. */
export const WEEKDAY_COLUMNS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Monday-first, which is how a timetable is read. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const WEEKDAY_NAMES: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

/**
 * Spelled out rather than taken from a locale: `toLocaleDateString` would give
 * a different pattern name on a French browser than on an English one, and the
 * payload is data rather than display. `core/service.py` spells them out for
 * the same reason.
 */
export const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** How far past the first service date to expand. See `core/service.py`. */
export const MAX_DAYS = 1100;
export const MAX_DAYS_RETURNED = 1200;

/**
 * What to call a group of dates that share a set of services.
 *
 * Named from the days it falls on rather than from the services in it: a reader
 * recognises "Saturdays" and has never seen `S_SAT_2024B`. A group of one date
 * is named by the date, because that is what an exception is.
 */
export function patternName(dates: string[], weekdays: Map<number, number>, services: string[]): string {
  if (!services.length) return "No service";
  if (dates.length === 1) {
    const [year, month, day] = dates[0].split("-").map(Number);
    return `${day} ${MONTH_ABBREVIATIONS[month - 1]} ${year}`;
  }

  const covered = new Set([...weekdays.entries()].filter(([, count]) => count).map(([day]) => day));
  const exactly = (...days: number[]) => days.length === covered.size && days.every((day) => covered.has(day));

  if (exactly(1, 2, 3, 4, 5)) return "Weekdays";
  if (exactly(0, 6)) return "Weekends";
  if (covered.size === 1) return `${WEEKDAY_NAMES[[...covered][0]]}s`;
  if (exactly(1, 2, 3, 4, 5, 6)) return "Monday to Saturday";
  if (covered.size === 7) return "Every day";
  return WEEKDAY_ORDER.filter((day) => covered.has(day))
    .map((day) => WEEKDAY_NAMES[day].slice(0, 3))
    .join(", ");
}

/**
 * Dates grouped by the exact set of services running on them.
 *
 * The transformation that makes a calendar legible: a feed with fourteen
 * service ids usually has four or five genuinely different days in it, and
 * every date is one of them.
 */
export function servicePatterns(days: CalendarDay[]): ServicePattern[] {
  interface Group {
    services: string[];
    dates: string[];
    weekdays: Map<number, number>;
    trips: number;
    routes: number;
  }
  const groups = new Map<string, Group>();

  for (const day of days) {
    // JSON rather than a join on a separator: a service_id is any UTF-8 string,
    // and one containing the separator would merge two distinct groups.
    const key = JSON.stringify(day.services);
    let group = groups.get(key);
    if (!group) {
      group = { services: [...day.services], dates: [], weekdays: new Map(), trips: 0, routes: 0 };
      groups.set(key, group);
    }
    group.dates.push(day.service_date);
    group.weekdays.set(day.weekday, (group.weekdays.get(day.weekday) ?? 0) + 1);
    // Identical for every date in a group: the same services run, so the same
    // trips do. Assigned rather than summed for that reason.
    group.trips = day.trips;
    group.routes = day.routes;
  }

  const patterns: ServicePattern[] = [];
  for (const group of groups.values()) {
    const dates = [...group.dates].sort();
    patterns.push({
      name: patternName(dates, group.weekdays, group.services),
      services: group.services,
      trips: group.trips,
      routes: group.routes,
      days: dates.length,
      weekdays: [...group.weekdays.entries()]
        .filter(([, count]) => count)
        .map(([day]) => day)
        .sort((a, b) => a - b),
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      sample_dates: dates.slice(0, 5),
    });
  }

  // Most of the year first: the pattern covering the most dates is the one
  // someone means by "the schedule", and one-off exceptions come after.
  return patterns.sort((a, b) => b.days - a.days || b.trips - a.trips || compare(a.name, b.name));
}

/**
 * Ordering that agrees with Python's.
 *
 * `localeCompare` orders by the reader's locale; Python compares code points.
 * A payload whose order depends on the reader's browser could not be compared
 * with the other implementation's, so this compares code points too.
 */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * What runs on a Monday, a Tuesday, and so on.
 *
 * `typical_trips` is the most common value rather than the mean, because the
 * mean of fifty-two Mondays and two public holidays is a number that happens on
 * no Monday at all.
 */
export function weekdayProfile(days: CalendarDay[]): WeekdayProfile[] {
  const byWeekday = new Map<number, number[]>(WEEKDAY_ORDER.map((day) => [day, []]));
  for (const day of days) byWeekday.get(day.weekday)?.push(day.trips);

  return WEEKDAY_ORDER.map((weekday) => {
    const counts = byWeekday.get(weekday) ?? [];
    const running = counts.filter((count) => count);

    // Insertion-ordered, so a tie goes to the value seen first - which is what
    // `Counter.most_common(1)` does on the other side.
    const seen = new Map<number, number>();
    for (const count of running) seen.set(count, (seen.get(count) ?? 0) + 1);
    let typical = 0;
    let best = 0;
    for (const [value, times] of seen) {
      if (times > best) {
        best = times;
        typical = value;
      }
    }

    return {
      weekday,
      name: WEEKDAY_NAMES[weekday],
      dates: counts.length,
      dates_with_service: running.length,
      typical_trips: typical,
      max_trips: counts.length ? Math.max(...counts) : 0,
    };
  });
}

/** Seconds since the service day began, back as GTFS would write them. */
export function clockFromSeconds(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** How many trips a timetable draws as columns. Mirrors `MAX_TIMETABLE_TRIPS`. */
export const MAX_TIMETABLE_TRIPS = 400;

/**
 * One stop order covering every trip, built from the longest of them.
 *
 * Ported from `_spine` in `core/network.py`. A route's trips do not all call
 * everywhere: the short working stops early, the express skips the middle. A
 * grid needs one row order holding all of them, and the honest way to build it
 * is to start from the longest sequence and weave the rest in after the stop
 * they follow - not to append the odd ones at the bottom, where they would
 * read as the end of the line.
 *
 * A stop a trip calls at twice gets one row rather than two. That is a real
 * limitation of a stops-by-trips grid rather than something this can fix, and
 * it is enforced on the seed as well as on the weave.
 */
export function spine(sequences: string[][]): string[] {
  if (!sequences.length) return [];

  let longest = sequences[0];
  for (const sequence of sequences) if (sequence.length > longest.length) longest = sequence;

  // Deduped as it is seeded, not only as it is woven: a loop whose longest trip
  // passes its own terminus would otherwise get two rows for one stop, both
  // showing the same times.
  const order: string[] = [];
  for (const stop of longest) if (!order.includes(stop)) order.push(stop);
  let positions = new Map(order.map((stop, index) => [stop, index]));

  for (const sequence of sequences) {
    let previous = -1;
    for (const stop of sequence) {
      const known = positions.get(stop);
      if (known !== undefined) {
        previous = known;
        continue;
      }
      const at = previous + 1;
      order.splice(at, 0, stop);
      positions = new Map(order.map((name, index) => [name, index]));
      previous = at;
    }
  }
  return order;
}

/**
 * A GTFS time as seconds since the service day began, or null.
 *
 * Past 24:00:00 is ordinary and kept: a trip leaving at 25:10 belongs to the
 * service day before, and wrapping it would sort it to the front of a
 * timetable it ends. Mirrors `_seconds` in `core/network.py`.
 */
export function secondsFromClock(time: string | null | undefined): number | null {
  if (!time) return null;
  const parts = time.split(":").slice(0, 3).map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) return null;
  while (parts.length < 3) parts.push(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
