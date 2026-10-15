/**
 * How the derived views word things.
 *
 * Pure, so the wording is testable without a document - the split the rest of
 * this package uses, where a module decides and another draws. Everything here
 * is about turning a GTFS value into something an operator would say out loud:
 * `route_color` into a swatch you can read text on, `25:40:00` into a time that
 * admits it is after midnight, a count of 0 into "none" rather than "0".
 */

import type { RouteSummary, WeekdayProfile } from "../sources/types";

/** What to call a route. The short name is what is on the vehicle. */
export function routeLabel(route: { short_name?: string | null; long_name?: string | null; route_id: string }): string {
  return route.short_name?.trim() || route.long_name?.trim() || route.route_id;
}

/**
 * What goes on the coloured badge.
 *
 * The short name is what is on the vehicle. A feed that states none - common
 * for demand-responsive services - gets its id rather than its long name:
 * "Dial-A-Ride - general public" on a badge is not a badge, and the long name
 * is already the row beside it.
 */
export function routeBadge(route: { short_name?: string | null; route_id: string }): string {
  return route.short_name?.trim() || route.route_id;
}

/**
 * The second line: the long name, unless it is already the label.
 *
 * Returns empty rather than repeating itself - a route called only "Red Line"
 * would otherwise render as "Red Line / Red Line".
 */
export function routeSubtitle(route: {
  short_name?: string | null;
  long_name?: string | null;
  route_id: string;
}): string {
  const long = route.long_name?.trim() ?? "";
  return long && long !== routeLabel(route) ? long : "";
}

/**
 * `route_color` as CSS, or null.
 *
 * GTFS states it as six hex digits with no `#`, but feeds write `#FF0000`,
 * lowercase, and sometimes nothing at all. Anything that is not six hex digits
 * after that cleanup is treated as absent rather than passed to the browser,
 * which would otherwise silently accept `red` and reject `ff00` without saying
 * which it did.
 */
export function swatch(color: string | null | undefined): string | null {
  const value = (color ?? "").trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : null;
}

/**
 * Black or white, whichever can be read on that colour.
 *
 * The feed's own `route_text_color` wins when it has one; this is the fallback,
 * and it exists because a third of feeds set a dark `route_color` and no text
 * colour at all, which renders a black label on a navy badge.
 */
export function textOn(background: string | null): string {
  if (!background) return "inherit";
  const channel = (offset: number) => parseInt(background.slice(offset, offset + 2), 16) / 255;
  const linear = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  return luminance > 0.45 ? "#111" : "#fff";
}

/**
 * A GTFS time, shortened to the part people read.
 *
 * Hours past 24 are kept rather than wrapped: GTFS means them, and a trip shown
 * as leaving at 01:40 when the feed says 25:40 has been moved a day by the
 * display. `after midnight` is added so nobody reads 25:40 as a typo.
 */
export function clock(time: string | null | undefined): string {
  if (!time) return "–";
  const [hours, minutes] = time.split(":");
  const hour = Number(hours);
  if (!Number.isFinite(hour)) return time;
  const shown = `${String(hour).padStart(2, "0")}:${minutes ?? "00"}`;
  return hour >= 24 ? `${shown} (after midnight)` : shown;
}

/** "05:12 to 25:40 (after midnight)", or a dash when the feed has no times. */
export function span(first: string | null | undefined, last: string | null | undefined): string {
  if (!first && !last) return "No times in this feed";
  return `${clock(first)} to ${clock(last)}`;
}

export function count(value: number, singular: string, plural = `${singular}s`): string {
  if (!value) return `No ${plural}`;
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

/**
 * How long a feed has left, said the way someone would say it.
 *
 * The number people act on is "three weeks", not a date, and an expired feed
 * has to say so outright rather than reporting a negative.
 */
export function expiry(daysRemaining: number | null | undefined): { text: string; tone: "ok" | "warn" | "gone" } {
  if (daysRemaining === null || daysRemaining === undefined) return { text: "No end date", tone: "warn" };
  if (daysRemaining < 0) return { text: `Expired ${Math.abs(daysRemaining)} days ago`, tone: "gone" };
  if (daysRemaining === 0) return { text: "Ends today", tone: "gone" };
  if (daysRemaining <= 30) return { text: `${daysRemaining} days left`, tone: "warn" };
  return { text: `${daysRemaining} days left`, tone: "ok" };
}

/**
 * The weekday profile as bars, each a share of the busiest day.
 *
 * Relative rather than absolute: a reader is comparing Sunday to Tuesday, not
 * counting trips, and the figure is beside the bar for anyone who is.
 */
export function weekdayBars(profile: WeekdayProfile[]): { name: string; trips: number; share: number }[] {
  const busiest = Math.max(1, ...profile.map((day) => day.typical_trips));
  return profile.map((day) => ({
    name: day.name,
    trips: day.typical_trips,
    share: day.typical_trips / busiest,
  }));
}

/** Routes grouped by mode, each group in the order the list already had. */
export function byMode(routes: RouteSummary[]): { mode: string; routes: RouteSummary[] }[] {
  const groups = new Map<string, RouteSummary[]>();
  for (const route of routes) {
    const group = groups.get(route.mode) ?? [];
    group.push(route);
    groups.set(route.mode, group);
  }
  return [...groups.entries()]
    .map(([mode, grouped]) => ({ mode, routes: grouped }))
    .sort((a, b) => b.routes.length - a.routes.length || a.mode.localeCompare(b.mode));
}
