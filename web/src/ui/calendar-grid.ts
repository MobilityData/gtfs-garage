/**
 * Laying a feed's service dates out as a calendar.
 *
 * The grid is the one view that answers "when does this feed not run" without
 * anyone having to ask: a year of dates, each shaded by how much runs on it,
 * shows holidays, seasonal service, the week the data thins out and the day the
 * feed stops - none of which is visible in `calendar.txt`.
 *
 * Pure. The shape of the grid, the shading and the wording are decided here and
 * drawn by `calendar-view.ts`, so all of it can be tested without a document.
 */

import type { CalendarDay } from "../sources/types";

/** Monday first, which is how a timetable is read. */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** How many shades the grid has, empty aside. */
export const LEVELS = 4;

export interface GridCell {
  day: CalendarDay | null;
  level: number;
}

export interface MonthGrid {
  /** "March 2026". */
  label: string;
  year: number;
  month: number;
  /** Seven cells per row, Monday first, padded with nulls at both ends. */
  weeks: GridCell[][];
}

/**
 * Monday-first column for an ISO date.
 *
 * The API numbers weekdays Sunday-first, as `strftime('%w')` does; a calendar
 * is read Monday-first. Converting here rather than in the payload keeps the
 * numbering in the contract the same as the one GTFS and SQL both use.
 */
export function column(weekday: number): number {
  return (weekday + 6) % 7;
}

/**
 * Which shade a day gets, 0 for none at all.
 *
 * Banded against the busiest day rather than scaled linearly: service is not
 * evenly distributed, and a linear scale against a feed with one enormous
 * special-event day flattens every ordinary day to the same shade.
 */
export function level(trips: number, busiest: number): number {
  if (trips <= 0) return 0;
  if (busiest <= 0) return 1;
  const share = trips / busiest;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The days grouped into months of weeks.
 *
 * Padding is produced rather than left to CSS so that the first of the month
 * sits under its own weekday: a grid that starts every month at column one is
 * a heat strip, not a calendar, and cannot be read against a real one.
 */
export function monthGrids(days: CalendarDay[]): MonthGrid[] {
  const busiest = Math.max(0, ...days.map((day) => day.trips));
  const months = new Map<string, MonthGrid>();

  for (const day of days) {
    const [year, month] = day.service_date.split("-").map(Number);
    const key = `${year}-${month}`;
    let grid = months.get(key);
    if (!grid) {
      grid = { label: `${MONTHS[month - 1]} ${year}`, year, month, weeks: [] };
      months.set(key, grid);
    }

    const target = column(day.weekday);
    let week = grid.weeks[grid.weeks.length - 1];
    // A new week starts when the column goes backwards, and the first week of
    // the month is padded up to the day it begins on.
    if (!week || target <= lastFilled(week)) {
      week = Array.from({ length: 7 }, () => ({ day: null, level: 0 }) as GridCell);
      grid.weeks.push(week);
    }
    week[target] = { day, level: level(day.trips, busiest) };
  }

  return [...months.values()];
}

function lastFilled(week: GridCell[]): number {
  for (let index = week.length - 1; index >= 0; index -= 1) {
    if (week[index].day) return index;
  }
  return -1;
}

/** What a day's tooltip says: the date, what runs, and under which services. */
export function describeDay(day: CalendarDay): string {
  if (!day.trips) return `${day.service_date}: no service`;
  const services = day.services.length
    ? ` (${day.services.slice(0, 4).join(", ")}${day.services.length > 4 ? ", …" : ""})`
    : "";
  return `${day.service_date}: ${day.trips.toLocaleString()} trips${services}`;
}

/**
 * The gaps worth pointing at: runs of consecutive dates with nothing running.
 *
 * A single quiet Sunday is a schedule; eleven quiet days in July is either a
 * seasonal shutdown or a mistake, and either way it is the thing to look at
 * first. Runs shorter than `minimum` are left alone.
 */
export function gaps(days: CalendarDay[], minimum = 2): { from: string; to: string; days: number }[] {
  const found: { from: string; to: string; days: number }[] = [];
  let start: CalendarDay | null = null;
  let previous: CalendarDay | null = null;

  for (const day of days) {
    if (!day.trips) {
      start ??= day;
      previous = day;
      continue;
    }
    if (start && previous) found.push({ from: start.service_date, to: previous.service_date, days: run(start, previous) });
    start = null;
  }
  if (start && previous) found.push({ from: start.service_date, to: previous.service_date, days: run(start, previous) });

  return found.filter((gap) => gap.days >= minimum).sort((a, b) => b.days - a.days);
}

function run(from: CalendarDay, to: CalendarDay): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(to.service_date) - Date.parse(from.service_date)) / day) + 1;
}
