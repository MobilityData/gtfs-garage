/**
 * What the viewer tab hands the Tour Studio when it opens it.
 *
 * A loaded report is kept per tab (`store.ts` keeps it in `sessionStorage`),
 * so the studio, in a tab of its own, cannot see the one the reader loaded.
 * "Edit tour" leaves it here, with the feed it is for, and the studio reads it
 * on start to offer "this feed's report" beside the demos. Kept rather than
 * taken, so reloading the studio still has it; the next "Edit tour" replaces it.
 */

import { parseReport, type ValidationReport } from "./report";

const KEY = "gtfs-garage:studio-hand-over";

export interface HandOver {
  /** The feed the report is for, as the viewer's toolbar names it. */
  feed: string;
  /** The report's file name. */
  name: string;
  /** The report, as JSON text, or null when the tab had none loaded. */
  report: string | null;
}

export function handOver(given: HandOver): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(given));
  } catch {
    // Storage blocked or full: the studio offers the demos alone.
  }
}

export function takeHandOver(): HandOver | null {
  try {
    const text = localStorage.getItem(KEY);
    const given = text ? (JSON.parse(text) as HandOver) : null;
    return given?.report ? given : null;
  } catch {
    return null;
  }
}

const parsed = new WeakMap<HandOver, ValidationReport | null>();

/** The handed-over report, read once. */
export function parseHandedOver(given: HandOver): ValidationReport | null {
  if (!parsed.has(given)) {
    try {
      parsed.set(given, given.report ? parseReport(given.report) : null);
    } catch {
      parsed.set(given, null);
    }
  }
  return parsed.get(given) ?? null;
}
