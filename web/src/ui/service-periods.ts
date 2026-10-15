/**
 * When each kind of day is in force, and where the schedule changes.
 *
 * A year grid cannot be the answer: a feed declaring service to 2100 is
 * twenty-eight thousand cells, and the thing a reader wants out of it is not
 * "which Tuesdays" but "when did this stop being the schedule". So the axis is
 * time rather than days - one band per kind of day across the feed's whole
 * range, however long that is - and the dates where a band starts or stops are
 * listed outright, because those are the moments something changed.
 *
 * Pure: the geometry and the wording are decided here and drawn by
 * `screens/calendar.ts`, so both are testable without a document.
 */

import type { ServicePattern } from "../sources/types";

/** One kind of day, placed on the feed's timeline. */
export interface Period {
  name: string;
  /** Inclusive, as the pattern states them. */
  from: string;
  to: string;
  days: number;
  routes: number;
  trips: number;
  /** Where the band sits, 0 to 1 of the feed's window. */
  start: number;
  width: number;
}

const DAY = 24 * 60 * 60 * 1000;

function at(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * The patterns as bands, longest-running first.
 *
 * A pattern with no trips - the "No service" group - is left out: it is the
 * absence of the others rather than a period of its own, and a band for it
 * would cover every gap in every other band.
 */
export function periods(patterns: ServicePattern[], first: string, last: string): Period[] {
  const begins = at(first);
  const span = Math.max(DAY, at(last) - begins);

  return patterns
    .filter((pattern) => pattern.trips > 0)
    .map((pattern) => {
      const from = Math.max(begins, at(pattern.first_date));
      const to = Math.min(at(last), at(pattern.last_date));
      return {
        name: pattern.name,
        from: pattern.first_date,
        to: pattern.last_date,
        days: pattern.days,
        routes: pattern.routes,
        trips: pattern.trips,
        start: (from - begins) / span,
        // A pattern covering a single date would otherwise be invisible.
        width: Math.max(0.004, (to - from) / span),
      };
    })
    .sort((left, right) => right.days - left.days || left.from.localeCompare(right.from));
}

/** A date on which the schedule became something else. */
export interface Change {
  date: string;
  begins: string[];
  ends: string[];
}

/**
 * The dates a kind of day starts or stops being in force.
 *
 * Deliberately not "every date whose services differ from yesterday's" - that
 * is every Saturday, and a list of every weekend in three years is not a list
 * of changes. A period's own boundaries are the moments the timetable was
 * actually replaced.
 *
 * `ends` is dated the day *after* the last one, because that is the first day
 * the old schedule no longer applies - which is the date someone is looking
 * for when they ask when it changed.
 */
export function changes(patterns: ServicePattern[], first: string, last: string): Change[] {
  const byDate = new Map<string, Change>();
  const record = (date: string, kind: "begins" | "ends", name: string) => {
    const entry = byDate.get(date) ?? { date, begins: [], ends: [] };
    entry[kind].push(name);
    byDate.set(date, entry);
  };

  for (const pattern of patterns) {
    if (!pattern.trips) continue;
    // The feed's own first and last day are not changes - they are its edges.
    if (pattern.first_date > first) record(pattern.first_date, "begins", pattern.name);
    if (pattern.last_date < last) {
      record(new Date(at(pattern.last_date) + DAY).toISOString().slice(0, 10), "ends", pattern.name);
    }
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/** "Weekdays begins", "Weekends ends", or both on one date. */
export function describeChange(change: Change): string {
  const parts: string[] = [];
  if (change.begins.length) parts.push(`${change.begins.join(", ")} begins`);
  if (change.ends.length) parts.push(`${change.ends.join(", ")} ends`);
  return parts.join(" · ");
}
