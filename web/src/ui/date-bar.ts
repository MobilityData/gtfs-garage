/**
 * The service day, when there is one.
 *
 * Nothing is filtered until a day is chosen. That is the rule the whole control
 * follows: on an untouched feed there is no date, no chip and no filtering, and
 * the route list shows every route the feed has. A date arrives only because
 * someone asked for one, and while it is set it is stated above the content it
 * governs rather than left to be inferred.
 *
 * The stepping is deliberately concrete. "Next change" was a button that did
 * something abstract; what replaces it is a list of destinations that each name
 * a real date - today, a Saturday, the day the schedule changes - so choosing
 * one is choosing a day rather than invoking a rule.
 *
 * Pure, so the arithmetic and the wording are testable without a document.
 */

import type { CalendarDay, ServicePattern } from "../sources/types";

/** A day's services as a comparable key. JSON, because an id may contain anything. */
function key(day: CalendarDay): string {
  return JSON.stringify(day.services);
}

/** Pattern name per date, by the set of services running - "Weekdays", "Sundays". */
export function patternNames(days: CalendarDay[], patterns: ServicePattern[]): Map<string, string> {
  const byServices = new Map(patterns.map((pattern) => [JSON.stringify(pattern.services), pattern.name]));
  const named = new Map<string, string>();
  for (const day of days) {
    const name = byServices.get(key(day));
    if (name) named.set(day.service_date, name);
  }
  return named;
}

/** One day along, within the feed. Returns the same date at either end. */
export function stepDate(days: CalendarDay[], current: string, delta: number): string {
  const index = days.findIndex((day) => day.service_date === current);
  if (index < 0) return current;
  const wanted = Math.min(days.length - 1, Math.max(0, index + delta));
  return days[wanted].service_date;
}

/** Somewhere worth going, named by what it is and dated by what it means. */
export interface Destination {
  label: string;
  date: string;
  /** The kind of day it turns out to be, where that is known. */
  note?: string;
}

/**
 * The days worth offering, each with its real date attached.
 *
 * One per kind of day the feed has - the next Saturday rather than "a
 * Saturday" - plus today where the feed covers it, the next date the schedule
 * changes, and the feed's own two edges. A reader picking from this is picking
 * a day; the old single button asked them to trust a rule instead.
 */
export function destinations(
  days: CalendarDay[],
  patterns: ServicePattern[],
  today: string,
  from?: string,
): Destination[] {
  if (!days.length) return [];

  const found: Destination[] = [];
  const names = patternNames(days, patterns);
  const after = from ?? today;
  const running = days.filter((day) => day.trips);

  const add = (label: string, date: string | undefined) => {
    if (!date || found.some((entry) => entry.date === date)) return;
    found.push({ label, date, note: names.get(date) });
  };

  if (days.some((day) => day.service_date === today && day.trips)) add("Today", today);

  // The next date of each kind, so "show me a Saturday" is one click and the
  // date it lands on is visible before the click.
  for (const pattern of patterns) {
    if (!pattern.trips) continue;
    const next =
      running.find((day) => day.service_date >= after && names.get(day.service_date) === pattern.name) ??
      running.find((day) => names.get(day.service_date) === pattern.name);
    // The pattern's own name, not lower-cased: "Next mon, tue, wed, fri" is
    // harder to read than the name the rest of the viewer uses for it.
    add(`Next ${pattern.name}`, next?.service_date);
  }

  add("First day of the feed", running[0]?.service_date ?? days[0].service_date);
  add("Last day of the feed", running[running.length - 1]?.service_date ?? days[days.length - 1].service_date);
  return found;
}

/** What the chip says: the day, and what kind of day it turned out to be. */
export function describeDate(day: CalendarDay | undefined, pattern: string | undefined): string {
  if (!day) return "That date is outside this feed";
  if (!day.trips) return `${pattern ?? "No service"} — nothing runs`;
  const routes = `${day.routes.toLocaleString()} route${day.routes === 1 ? "" : "s"}`;
  const trips = `${day.trips.toLocaleString()} trip${day.trips === 1 ? "" : "s"}`;
  return [pattern, routes, trips].filter(Boolean).join(" · ");
}

/** "Thursday 19 March 2026" - spelled out, and not from a locale. */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}`;
}
