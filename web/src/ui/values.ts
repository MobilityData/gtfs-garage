/**
 * How to draw one cell's value, given what GTFS says the field holds.
 *
 * This decides; `table.ts` draws. Keeping the decision pure is what makes the
 * cases that matter testable at all, since vitest runs without a document and
 * the cases that matter are the malformed ones.
 *
 * Two rules govern everything here:
 *
 * 1. **A value that does not conform is shown as the string the feed contains.**
 *    Never blanked, never corrected, never allowed to throw. This is the
 *    project's existing principle - a feed with a malformed number still opens,
 *    because type errors are what an inspection tool exists to reveal - applied
 *    to rendering rather than to loading.
 *
 * 2. **A feed is untrusted input.** Only `http:`, `https:` and `mailto:` ever
 *    become a link; anything else is text. Before this module, no feed value
 *    was ever used as an `href`, so links are a new attack surface and
 *    `javascript:` in a URL field must not survive it.
 */

import type { ColumnInfo } from "../sources/types";

export interface Rendered {
  /** What to show. Always a string; never empty unless the value was. */
  text: string;
  kind: "plain" | "numeric" | "link" | "color";
  /** Only ever an http, https or mailto URL. */
  href?: string;
  /** Only ever `#RRGGBB`, from six hex digits. */
  swatch?: string;
  /** What was expected, when the value does not conform. Shown on hover. */
  malformed?: string;
}

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const plain = (text: string): Rendered => ({ text, kind: "plain" });
const wrong = (text: string, expected: string): Rendered => ({
  text,
  kind: "plain",
  malformed: expected,
});

/**
 * A link only for schemes that cannot execute.
 *
 * `javascript:`, `data:` and `vbscript:` are script execution when used as an
 * href, and a protocol-relative `//host` inherits the page's scheme, so all of
 * them stay text. `URL` throws on anything unparseable, which is the common
 * case for a hand-typed feed field, so the throw is the answer rather than an
 * error.
 */
function asLink(value: string, expected: string, base?: string): Rendered {
  const candidate = base && !value.includes(":") ? `${base}${value}` : value;
  try {
    const url = new URL(candidate);
    if (!LINK_SCHEMES.has(url.protocol)) return wrong(value, expected);
    return { text: value, kind: "link", href: url.href };
  } catch {
    return wrong(value, expected);
  }
}

function asNumber(value: string, expected: string, min?: number, max?: number): Rendered {
  // Number("") is 0 and Number(" ") is 0, neither of which is a number in a
  // feed; require something that looks numeric before trusting it.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    return wrong(value, expected);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return wrong(value, expected);
  if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
    return wrong(value, expected);
  }
  // The feed's own text, not a re-rendered number: reformatting would lose
  // trailing zeros and the precision the producer chose.
  return { text: value, kind: "numeric" };
}

/** `20260822` as a readable date, or the raw value. */
function asDate(value: string): Rendered {
  const expected = "a date as YYYYMMDD";
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return wrong(value, expected);

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects 20260231: the Date would roll over into March.
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    return wrong(value, expected);
  }
  return plain(date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
}

/** Six hex digits, and GTFS forbids the leading `#`. */
function asColor(value: string): Rendered {
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return wrong(value, "six hex digits, without a leading #");
  return { text: value, kind: "color", swatch: `#${value}` };
}

/**
 * An enumeration's label beside its code.
 *
 * An unknown code is shown raw and **not** marked as malformed. GTFS defines
 * extended route types from 100 to 1700 which the schema does not enumerate,
 * and feeds do use them, so an unrecognised code is normal rather than an
 * error. Flagging it would be both wrong and noisy.
 */
function asEnum(value: string, values: Record<string, string> | null | undefined): Rendered {
  const label = values?.[value];
  return label ? plain(`${label} (${value})`) : plain(value);
}

function decide(value: string, column: ColumnInfo): Rendered {
  switch (column.type) {
    case "ENUM":
      return asEnum(value, column.values);
    case "COLOR":
      return asColor(value);
    case "URL":
      return asLink(value, "a URL");
    case "EMAIL":
      return asLink(value, "an email address", "mailto:");
    case "DATE":
      return asDate(value);
    case "LATITUDE":
      return asNumber(value, "a latitude between -90 and 90", -90, 90);
    case "LONGITUDE":
      return asNumber(value, "a longitude between -180 and 180", -180, 180);
    case "INTEGER":
    case "FLOAT":
    case "CURRENCY_AMOUNT":
      return asNumber(value, "a number");
    // TIME is deliberately untouched: GTFS times legitimately exceed 24:00:00
    // for trips running past midnight, and a formatter that "corrected"
    // 25:30:00 would be worse than none.
    default:
      return plain(value);
  }
}

/**
 * The only entry point, and the one place that can fail safely.
 *
 * Every formatter above is total, so the catch should never fire. It is here so
 * that it cannot matter if a formatter added later is not - one malformed cell
 * in a sixty-million-row feed must not blank a page.
 *
 * `raw` turns all of it off and returns the characters the file contains.
 * Formatting is a reading aid, and a reading aid is the wrong thing when the
 * question is what a producer actually wrote: `Aug 22, 2026` is easier to read
 * than `20260822`, but only the second answers "is this field padded?". An
 * inspection tool has to be able to stop interpreting.
 */
export function renderValue(
  value: string | null,
  column: ColumnInfo | undefined,
  raw = false,
): Rendered {
  if (value === null || value === undefined) return plain("");
  if (raw || !column) return plain(value);
  try {
    return decide(value, column);
  } catch {
    return plain(value);
  }
}

/**
 * What to say about a column in its header tooltip.
 *
 * The schema knows more about a column than its name shows: what GTFS says it
 * holds, whether it must be filled in, and - for a conditionally required
 * field - the condition in words. "Conditionally required" on its own is not
 * something a reader can act on; the condition is.
 */
export function describeColumn(column: ColumnInfo | undefined): string {
  if (!column) return "";
  const parts: string[] = [];
  if (column.type) parts.push(column.type);
  if (column.required === "always") parts.push("Required");
  else if (column.required === "conditional") {
    parts.push(column.condition ? `Conditionally required - ${column.condition}` : "Conditionally required");
  }
  return parts.join(" · ");
}
