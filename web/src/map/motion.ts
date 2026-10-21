/**
 * The timing of a `MapMotion`: where its marker is at each moment of a pass.
 *
 * Kept apart from the map so the arithmetic is testable without one. A pass
 * keeps the motion's pace - a leg twice as long in time takes twice as long on
 * screen - with two exceptions that keep it readable: a pause lasts a fixed
 * beat whatever its length, and no leg is quicker than a glimpse, so a leg
 * timed at nothing still shows the marker crossing it.
 */

import type { MapMotion } from "../mount";

/** One pause at a place lasts this long on screen. */
export const PAUSE_MS = 450;
/** No leg is quicker than this, so a jump timed at zero is still seen. */
export const MIN_LEG_MS = 400;
/** The marker rests at the end of a pass before it starts again. */
export const REST_MS = 1600;
export const DEFAULT_DURATION_MS = 7000;

export interface Leg {
  from: number;
  start: number;
  end: number;
}

export interface Schedule {
  legs: Leg[];
  /** One pass, rest included. */
  total: number;
}

const samePlace = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

export function schedule(motion: MapMotion): Schedule {
  const path = motion.path;
  const moving: number[] = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    if (!samePlace(path[i].at, path[i + 1].at)) moving.push(Math.max(0, path[i + 1].time - path[i].time));
  }
  const clock = moving.reduce((sum, seconds) => sum + seconds, 0);
  const scale = clock > 0 ? (motion.duration ?? DEFAULT_DURATION_MS) / clock : 0;

  const legs: Leg[] = [];
  let at = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const length = samePlace(path[i].at, path[i + 1].at)
      ? PAUSE_MS
      : Math.max(MIN_LEG_MS, Math.max(0, path[i + 1].time - path[i].time) * scale);
    legs.push({ from: i, start: at, end: at + length });
    at += length;
  }
  return { legs, total: at + REST_MS };
}

/** Where the marker is `elapsed` ms into a pass, and which entry it last left. */
export function positionAt(path: MapMotion["path"], plan: Schedule, elapsed: number): { at: [number, number]; from: number } {
  const t = elapsed % plan.total;
  for (const leg of plan.legs) {
    if (t < leg.end) {
      const a = path[leg.from].at;
      const b = path[leg.from + 1].at;
      const f = leg.end > leg.start ? (t - leg.start) / (leg.end - leg.start) : 1;
      return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], from: leg.from };
    }
  }
  const last = path.length - 1;
  return { at: path[last].at, from: last };
}
