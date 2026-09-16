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
  /**
   * Set when the feed left this field empty and GTFS says what that means. The
   * text is the implied value, not something the producer wrote, so it must be
   * drawn in a way that cannot be mistaken for one.
   */
  implied?: string;
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

function asNumber(value: string, expected: string, column: ColumnInfo): Rendered {
  const min = column.minimum ?? undefined;
  const max = column.maximum ?? undefined;
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

/**
 * `20260822` as a readable date, or the raw value.
 *
 * Read by position rather than by a second regex: the schema's `^\d{8}$` has
 * already run. What is left is the check a pattern cannot make - 20260231 is
 * eight digits and not a date, and `Date` would quietly roll it into March.
 */
function asDate(value: string, expected: string): Rendered {
  const [year, month, day] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)].map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    return wrong(value, expected);
  }
  return plain(date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
}

/** A swatch. The six hex digits were guaranteed by the schema's pattern. */
function asColor(value: string): Rendered {
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
  // Some enumerations are named rather than numbered - a geometry is "Polygon",
  // not "3" - so the code is already the label and "Polygon (Polygon)" would be
  // noise.
  if (!label || label === value) return plain(value);
  return plain(`${label} (${value})`);
}

/**
 * Short wording for what a type expects, where it reads better than GTFS's own
 * sentence.
 *
 * Only the phrasing lives here; the rule is the schema's. A type with no entry
 * falls back to the published description, which is how TIME, CURRENCY_CODE and
 * TIMEZONE are explained without copy being invented for them.
 */
const EXPECTED: Record<string, string> = {
  COLOR: "six hex digits, without a leading #",
  DATE: "a date as YYYYMMDD",
  EMAIL: "an email address",
  URL: "a URL",
  LATITUDE: "a latitude",
  LONGITUDE: "a longitude",
  INTEGER: "a number",
  FLOAT: "a number",
  CURRENCY_AMOUNT: "a number",
};

function expectation(column: ColumnInfo): string {
  const phrase = EXPECTED[column.type ?? ""] ?? column.type_description ?? "a value GTFS recognises";
  // The bounds are quoted from the schema rather than written out here, so the
  // numbers do not end up with two homes.
  const { minimum, maximum } = column;
  return minimum !== null && maximum !== null ? `${phrase} between ${minimum} and ${maximum}` : phrase;
}

/**
 * Patterns compiled once and kept, never once per cell: a sixty-million-row
 * feed would otherwise rebuild the same expression for every value in a column.
 *
 * One that will not compile is remembered as null and its check skipped. Rule 1
 * of this module is that nothing throws and no value is blanked, so a document
 * newer than this build must not be able to empty the table.
 */
const compiled = new Map<string, RegExp | null>();

function matcher(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    try {
      compiled.set(pattern, new RegExp(pattern));
    } catch {
      compiled.set(pattern, null);
    }
  }
  return compiled.get(pattern) ?? null;
}

function decide(value: string, column: ColumnInfo): Rendered {
  // The schema's rule for the type, applied before anything is formatted. Every
  // formatter below can then assume the shape it needs, and none of them keeps
  // a second copy of the rule that establishes it.
  if (column.pattern) {
    const rule = matcher(column.pattern);
    if (rule && !rule.test(value)) return wrong(value, expectation(column));
  }

  switch (column.type) {
    case "ENUM":
      return asEnum(value, column.values);
    case "COLOR":
      return asColor(value);
    case "URL":
      return asLink(value, expectation(column));
    case "EMAIL":
      return asLink(value, expectation(column), "mailto:");
    case "DATE":
      return asDate(value, expectation(column));
    case "LATITUDE":
    case "LONGITUDE":
    case "INTEGER":
    case "FLOAT":
    case "CURRENCY_AMOUNT":
      return asNumber(value, expectation(column), column);
    // TIME has a pattern and so is checked above, but is deliberately not
    // reformatted: GTFS times legitimately exceed 24:00:00 for trips running
    // past midnight, and a formatter that "corrected" 25:30:00 would be worse
    // than none.
    default:
      return plain(value);
  }
}

/**
 * What GTFS implies when the field is empty.
 *
 * "0 or empty - Regularly scheduled pickup" means a blank cell carries a value;
 * it is just not written down. Showing it is the difference between a reader
 * knowing what a feed says and having to remember the specification - and the
 * implied code is not always 0, so remembering is genuinely hard: a blank
 * `pickup_type` means 0 and a blank `continuous_pickup` beside it means 1.
 */
function asImplied(column: ColumnInfo): Rendered {
  const implied = column.when_empty;
  if (!implied) return plain("");
  const text = implied.code ? `${implied.label} (${implied.code})` : implied.label;
  return {
    text,
    kind: "plain",
    implied: implied.code
      ? `Empty. GTFS implies ${implied.code} - ${implied.label}.`
      : `Empty. GTFS implies: ${implied.label}`,
  };
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
  // Raw mode shows the characters the file contains, and here it contains
  // nothing - so an implied value is suppressed for the same reason a link is.
  if (value === null || value === undefined) {
    return !raw && column ? asImplied(column) : plain("");
  }
  if (raw || !column) return plain(value);
  try {
    return decide(value, column);
  } catch {
    return plain(value);
  }
}

/**
 * Whether a column must be filled in, said as definitely as the feed allows.
 *
 * Most of GTFS's conditions turn on the row that carries them, and a reader
 * looking at the row can apply them. Some do not. "Required when the feed
 * contains more than one agency" is a question about agency.txt, and the server
 * has answered it for the feed on screen - so say the answer, and what it was
 * counted from. The condition itself stays either way: an answer that hides the
 * rule it came from cannot be argued with.
 *
 * Where no answer is possible the scope still distinguishes a condition a row
 * settles from one it does not, so the two do not read alike.
 */
function describeRequirement(column: ColumnInfo): string {
  if (column.required === "always") return "Required";
  if (column.required !== "conditional") return "";

  const outcome = column.condition_outcome;
  let lead: string;
  if (outcome) lead = `${outcome.holds ? "Required" : "Not required"} in this feed (${outcome.evidence})`;
  else if (column.condition_scope === "row_context") lead = "Conditionally required, row by row";
  else lead = "Conditionally required";

  return column.condition ? `${lead} - ${column.condition}` : lead;
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
  const requirement = describeRequirement(column);
  if (requirement) parts.push(requirement);
  if (column.when_empty) {
    const { code, label } = column.when_empty;
    parts.push(code ? `empty implies ${code} - ${label}` : `empty implies: ${label}`);
  }
  return parts.join(" · ");
}
