/**
 * Filling a guide's `{{field}}` placeholders from one notice sample.
 *
 * Deliberately not an expression language: a placeholder names a field of the
 * sample and optionally one formatter, and that is all. A guide is data written
 * by people who should not need to read this code, and the build checks every
 * placeholder against the validator's own field names
 * (`check_guide` in `src/gtfs_garage/core/guides.py`).
 *
 * A placeholder whose field the sample does not have raises `UnfilledPlaceholder`, and
 * whoever is resolving the action skips it. The validator has renamed fields
 * between releases, and a walkthrough should lose a step rather than show
 * "{{stopName}}" to a reader.
 */

export type Sample = Record<string, unknown>;

/**
 * A placeholder that could not be filled because the sample has no such field.
 *
 * Generic to every guide and every notice: it says only that `{{field}}` had
 * nothing to fill it, so the action using it is left out.
 */
export class UnfilledPlaceholder extends Error {
  constructor(readonly field: string) {
    super(`No value for {{${field}}} in this sample`);
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}/g;
/** Anything in braces, to catch one PLACEHOLDER cannot read: it would be shown as typed. */
const BRACES = /\{\{.*?\}\}/g;

/** Text in double braces that is not a placeholder this can fill. */
export function unreadable(text: string): string[] {
  return [...text.matchAll(BRACES)].map((match) => match[0]).filter((braces) => !new RegExp(`^${PLACEHOLDER.source}$`).test(braces));
}
const WHOLE = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;

/** Every placeholder in `text`, with its formatter if it names one. */
export function placeholders(text: string): { field: string; formatter: string | null }[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => ({ field: match[1], formatter: match[2] ?? null }));
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The formatters a guide may name. Held to the catalog's `formatters` by validate.test.ts. */
export const FORMATTERS: Record<string, (value: unknown) => string> = {
  /** A distance in metres: "412 m", or to a tenth under ten metres: "0.5 m". */
  m: (value) => {
    const n = number(value);
    if (n === null) return String(value);
    return Math.abs(n) < 10 && Math.round(n) !== n ? `${n.toFixed(1)} m` : `${Math.round(n).toLocaleString("en")} m`;
  },
  /** A distance in kilometres: "1.24 km", or metres when under one. */
  km: (value) => {
    const n = number(value);
    if (n === null) return String(value);
    return n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(n < 10 ? 2 : 1)} km`;
  },
  /** A speed: "512 km/h". */
  kmh: (value) => {
    const n = number(value);
    return n === null ? String(value) : `${Math.round(n).toLocaleString("en")} km/h`;
  },
  /** A number with no unit, rounded for reading: "3900", "12.4", "0.53". For values whose unit the feed chooses. */
  round: (value) => {
    const n = number(value);
    if (n === null) return String(value);
    const abs = Math.abs(n);
    const digits = abs >= 100 || Number.isInteger(n) ? 0 : abs >= 10 ? 1 : 2;
    return n.toLocaleString("en", { maximumFractionDigits: digits });
  },
  /** A latitude or longitude, to about a metre: "45.5017", "-73.59". */
  coord: (value) => {
    const n = number(value);
    return n === null ? String(value) : String(Number(n.toFixed(5)));
  },
  /** true or false, as yes or no. */
  yesno: (value) => {
    const text = String(value).trim().toLowerCase();
    return text === "true" || text === "1" ? "yes" : text === "false" || text === "0" ? "no" : String(value);
  },
  /** A name the validator spells in capitals, in words: ACCESSIBLE_VIA_PATHWAYS as "accessible via pathways". */
  words: (value) => {
    const text = String(value);
    // Each of a list too: the validator gives route types as "BUS, RAIL".
    return text
      .split(/(\s*,\s*)/)
      .map((part) => (/^[A-Z0-9_]+$/.test(part) ? part.toLowerCase().replace(/_/g, " ") : part))
      .join("");
  },
  /** A position the validator counts from 0, counted from 1, as a reader counts: 0 is "1". */
  from1: (value) => {
    const n = number(value);
    return n === null ? String(value) : String(n + 1);
  },
  /** A duration in seconds, in minutes: 5400 as "90 min", 90 as "1.5 min". */
  min: (value) => {
    const n = number(value);
    if (n === null) return String(value);
    const minutes = n / 60;
    return `${minutes.toLocaleString("en", { maximumFractionDigits: Number.isInteger(minutes) ? 0 : 1 })} min`;
  },
  /** A number of days, with the right noun: "1 day", "5 days". */
  days: (value) => {
    const n = number(value);
    return n === null ? String(value) : `${n.toLocaleString("en")} ${Math.abs(n) === 1 ? "day" : "days"}`;
  },
  /** A GTFS date, YYYYMMDD, as YYYY-MM-DD. */
  date: (value) => {
    const text = String(value);
    return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text;
  },
};

/** How a value reads in a sentence. A coordinate pair is "lat, lon". */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(asText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function lookup(sample: Sample, field: string): unknown {
  if (!(field in sample) || sample[field] === null || sample[field] === undefined) throw new UnfilledPlaceholder(field);
  return sample[field];
}

/** Fill every placeholder in `text`. Throws `UnfilledPlaceholder`. */
export function fill(text: string, sample: Sample): string {
  return text.replace(PLACEHOLDER, (_, field: string, formatter?: string) => {
    const value = lookup(sample, field);
    const format = formatter ? FORMATTERS[formatter] : undefined;
    return format ? format(value) : asText(value);
  });
}

/**
 * Fill a whole action's arguments, recursively.
 *
 * A string that is exactly one placeholder becomes the field's own value rather
 * than its text, so `point: "{{match}}"` hands the action the coordinate pair
 * the validator reported, not the string "45.48, -73.57".
 */
export function fillValue(value: unknown, sample: Sample): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    return whole ? lookup(sample, whole[1]) : fill(value, sample);
  }
  // A list loses an item it cannot fill rather than failing as a whole: a
  // second key column the sample does not have should not cost the step its
  // first.
  if (Array.isArray(value)) {
    const filled: unknown[] = [];
    for (const item of value) {
      try {
        filled.push(fillValue(item, sample));
      } catch (error) {
        if (!(error instanceof UnfilledPlaceholder)) throw error;
      }
    }
    if (value.length && !filled.length) return fillValue(value[0], sample); // all failed: report the first
    return filled;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [fill(key, sample), fillValue(item, sample)]),
    );
  }
  return value;
}
