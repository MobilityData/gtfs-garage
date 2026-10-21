/**
 * Card actions that show a problem rather than the rows it is in.
 *
 * Some findings are not about a row a reader can look at: a file the feed
 * lacks, a column in a header, spaces nobody can see, two colours that are
 * hard to read together, a date range that has run out. Each of these draws
 * that one thing, in plain words, so a tour can show it to someone who has
 * never opened a GTFS file.
 *
 * All of them read only their arguments and the feed's own description of
 * itself (`context.tables`): nothing here queries rows.
 */

import { node } from "../ui/html";
import type { ActionContext } from "./actions";
import { tableOf } from "./catalog";
import { asText } from "./template";
import type { ResolvedAction } from "./walkthrough";

function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value]).map(asText).filter(Boolean);
}

function block(title: string, children: (Node | null)[]): HTMLElement {
  return node("div", { class: "assistant-block" }, [node("div", { class: "assistant-block-title", text: title }), ...children]);
}

function chip(text: string, kind: "plain" | "marked" | "missing", title?: string): HTMLElement {
  return node("span", { class: `explain-chip explain-chip-${kind}`, title, text });
}

/** A table's file name, as the feed has it: locations is GeoJSON, the rest CSV. */
export function fileName(table: string): string {
  return table === "locations" ? "locations.geojson" : `${table}.txt`;
}

/** The feed's files, with those it lacks and those in question picked out. */
export function showFiles(action: ResolvedAction, context: ActionContext): HTMLElement {
  const missing = list(action.args.missing).map(tableOf);
  const marked = new Set(list(action.args.mark).map(tableOf));
  const present = context.tables.map((table) => table.name);
  const chips = [
    ...present.map((name) => chip(fileName(name), marked.has(name) ? "marked" : "plain")),
    ...missing.filter((name) => !present.includes(name)).map((name) => chip(fileName(name), "missing", "Not in this feed")),
  ];
  const legend = [
    missing.length ? "Dashed: a file the feed does not have." : "",
    marked.size ? "Highlighted: the file this is about." : "",
  ].filter(Boolean);
  return block("The files in this feed", [
    node("div", { class: "explain-chips" }, chips),
    legend.length ? node("p", { class: "assistant-hint", text: legend.join(" ") }) : null,
  ]);
}

/** A file's header row: its columns in order, with those it lacks and those in question picked out. */
export function showColumns(action: ResolvedAction, context: ActionContext): HTMLElement {
  const table = tableOf(asText(action.args.file));
  const missing = list(action.args.missing);
  const info = context.tables.find((entry) => entry.name === table);
  const columns = info?.columns.map((column) => column.name) ?? [];
  // A column may be named by its position, counted from 1, as the validator
  // names one with no name: the empty one is the fourth.
  const marked = new Set(list(action.args.mark).map((entry) => (/^\d+$/.test(entry) && !columns.includes(entry) ? (columns[Number(entry) - 1] ?? `column ${entry}`) : entry)));
  const chips = [
    ...columns.map((name) => chip(name || "(no name)", marked.has(name) ? "marked" : "plain")),
    // A column the notice names but the loaded file does not show: a duplicate, or one dropped on load.
    ...[...marked].filter((name) => !columns.includes(name)).map((name) => chip(name, "marked")),
    ...missing.filter((name) => !columns.includes(name)).map((name) => chip(name, "missing", "Not in this file")),
  ];
  const legend = [
    missing.length ? "Dashed: a column the file does not have." : "",
    marked.size ? "Highlighted: the column this is about." : "",
  ].filter(Boolean);
  return block(`The columns of ${fileName(table)}, in order`, [
    info ? null : node("p", { class: "assistant-hint", text: `This feed has no readable ${fileName(table)}, so only the columns this is about are shown.` }),
    node("div", { class: "explain-chips" }, chips),
    legend.length ? node("p", { class: "assistant-hint", text: legend.join(" ") }) : null,
  ]);
}

/** A character a reader cannot see, as what it is. */
function visible(char: string): { text: string; title: string } | null {
  if (char === " ") return null;
  if (char === "\t") return { text: "→", title: "A tab" };
  if (char === "\n") return { text: "↵", title: "A line break" };
  if (char === "\r") return { text: "␍", title: "A carriage return" };
  const code = char.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  if (code === 0xa0) return { text: "␣", title: `A non-breaking space (${hex})` };
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return { text: hex, title: `An invisible control character (${hex})` };
  if (code === 0x200b || code === 0xfeff) return { text: hex, title: `An invisible zero-width character (${hex})` };
  if (code > 0x7e) return { text: char, title: `Not a plain letter or digit (${hex})` };
  return null;
}

/**
 * A value with what cannot be seen made visible: spaces at either end, line
 * breaks, tabs, non-breaking spaces, control characters and letters outside
 * plain ASCII, each marked and named on hover.
 */
export function showValue(action: ResolvedAction): HTMLElement {
  const value = asText(action.args.value);
  const label = asText(action.args.label);
  const expect = asText(action.args.expect);
  const start = value.length - value.trimStart().length;
  const end = value.trimEnd().length;
  const box = node("div", { class: "explain-value" });
  let odd = 0;
  [...value].forEach((char, index) => {
    const edge = char.trim() === "" && (index < start || index >= end);
    if (edge && char === " ") {
      box.append(node("span", { class: "explain-odd", title: index < start ? "A space at the start" : "A space at the end", text: "·" }));
      odd += 1;
      return;
    }
    const shown = visible(char);
    if (shown) {
      box.append(node("span", { class: "explain-odd", title: shown.title, text: shown.text }));
      odd += 1;
      if (char === "\n") box.append(node("br"));
    } else {
      box.append(char);
    }
  });
  if (!value) box.append(node("span", { class: "assistant-empty", text: "(empty)" }));
  return block(label || "The value, as the feed has it", [
    box,
    odd ? node("p", { class: "assistant-hint", text: "Marked: characters a rider's app would show, or trip over, that are hard to see. Hover one to see what it is." }) : null,
    expect ? node("p", { class: "explain-expect" }, [node("span", { class: "assistant-hint", text: "A correct value looks like, for example, " }), node("code", { text: expect })]) : null,
  ]);
}

function hexColor(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

/** Relative luminance as WCAG defines it. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** A route's colours as a rider sees them: the label, and how readable it is. */
export function showColors(action: ResolvedAction): HTMLElement {
  const background = hexColor(asText(action.args.color));
  const foreground = hexColor(asText(action.args.text)) ?? (action.args.text ? null : "#000000");
  const label = asText(action.args.label) || "Route";
  if (!background) {
    return block("The colour", [
      node("p", { class: "assistant-text", text: `"${asText(action.args.color)}" is not a colour an app can draw: a colour is six hexadecimal digits, such as 0055A4.` }),
    ]);
  }
  const children: HTMLElement[] = [
    node("div", { class: "explain-swatch", style: `background:${background};color:${foreground ?? "#000000"}`, text: label }),
  ];
  if (foreground) {
    const ratio = contrastRatio(background, foreground);
    const verdict =
      ratio >= 7 ? "easy to read" : ratio >= 4.5 ? "readable" : ratio >= 3 ? "hard to read for some riders" : "hard to read for most riders";
    children.push(
      node("p", { class: "assistant-text", text: `Contrast ${ratio.toFixed(1)} : 1, ${verdict}.` }),
      node("p", { class: "assistant-hint", text: `Background ${background}, text ${foreground}. Accessibility guidelines ask for at least 4.5 : 1.` }),
    );
  }
  return block("How the route's label looks", children);
}

/** A point on a timeline: a day, or a time of day in seconds since midnight. */
interface Moment {
  at: number;
  kind: "date" | "time";
  text: string;
}

const DAY = 86_400_000;

/** A GTFS date (20261015), an ISO one (2026-10-15), or a time of day (06:00:00, 25:10). */
function moment(value: unknown): Moment | null {
  const text = asText(value).trim();
  const date = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (date) {
    const at = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (Number.isNaN(at)) return null;
    return { at, kind: "date", text: new Date(at).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) };
  }
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (time) {
    const at = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3] ?? 0);
    return { at, kind: "time", text: `${time[1].padStart(2, "0")}:${time[2]}${Number(time[1]) >= 24 ? " (the next day)" : ""}` };
  }
  return null;
}

function days(n: number): string {
  return `${Math.abs(n).toLocaleString("en")} day${Math.abs(n) === 1 ? "" : "s"}`;
}

function duration(from: Moment, to: Moment, count: string): string {
  if (from.kind === "time") {
    const minutes = Math.round(Math.abs(to.at - from.at) / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""].filter(Boolean).join(" ");
  }
  const span = Math.round(Math.abs(to.at - from.at) / DAY);
  return days(count === "between" ? Math.max(0, span - 1) : span + 1);
}

/**
 * A range on a line - of days, or of times in one day - against the day the
 * validator checked it, and against a second range when two overlap.
 *
 * "Checked on" rather than today, since a report is read after it was made.
 * `count` says what the length is: the days it covers, both ends included (a
 * service period), the days strictly between (a gap between two service days),
 * or nothing.
 */
export function timeline(action: ResolvedAction): HTMLElement {
  const start = moment(action.args.start);
  const end = moment(action.args.end);
  const checked = moment(action.args.checked);
  const otherStart = moment(action.args.other_start);
  const otherEnd = moment(action.args.other_end);
  const count = asText(action.args.count) || "inclusive";
  const startLabel = asText(action.args.start_label) || "Starts";
  const endLabel = asText(action.args.end_label) || "Ends";
  const otherLabel = asText(action.args.other_label) || "The other";
  const title = start?.kind === "time" ? "When in the day" : "When it runs";
  if (!start || !end || start.kind !== end.kind) {
    return block(title, [node("p", { class: "assistant-hint", text: "One of the values is not a date or a time an app can read, so it cannot be drawn." })]);
  }
  const other = otherStart && otherEnd && otherStart.kind === start.kind ? { start: otherStart, end: otherEnd } : null;
  const backwards = end.at < start.at;
  const marks = [start, end, ...(other ? [other.start, other.end] : []), ...(checked && checked.kind === start.kind ? [checked] : [])].map((m) => m.at);
  const low = Math.min(...marks);
  const high = Math.max(...marks);
  const span = Math.max(high - low, start.kind === "date" ? DAY : 60);
  const at = (value: number) => `${(((value - low) / span) * 100).toFixed(2)}%`;
  const bar = (from: number, to: number, className: string, label?: string) =>
    node("div", { class: className, style: `left:${at(Math.min(from, to))};width:calc(${at(Math.max(from, to))} - ${at(Math.min(from, to))})`, title: label });

  const rows: HTMLElement[] = [
    node("div", { class: "explain-track" }, [
      bar(start.at, end.at, `explain-range${backwards ? " explain-range-backwards" : ""}`),
      checked && checked.kind === start.kind ? node("div", { class: "explain-today", style: `left:${at(checked.at)}`, title: `Checked on ${checked.text}` }) : null,
    ]),
  ];
  const facts: string[] = [];
  if (backwards) facts.push(`It ends ${start.kind === "date" ? days(Math.round((start.at - end.at) / DAY)) : duration(end, start, "between")} before it starts, so it never applies.`);
  else if (start.at === end.at) facts.push(start.kind === "date" ? "It starts and ends on the same day." : "It starts and ends at the same time, so it lasts no time at all.");
  else if (count !== "none") facts.push(count === "between" ? `${duration(start, end, "between")} between them.` : `It lasts ${duration(start, end, count)}.`);

  if (other) {
    const [a, b] = [Math.min(start.at, end.at), Math.max(start.at, end.at)];
    const [c, d] = [Math.min(other.start.at, other.end.at), Math.max(other.start.at, other.end.at)];
    rows.push(node("div", { class: "explain-track" }, [bar(other.start.at, other.end.at, "explain-range explain-range-other")]));
    const from = Math.max(a, c);
    const to = Math.min(b, d);
    if (to > from) {
      // On the second bar only: shading both hides the first when one range holds the other.
      rows[rows.length - 1].append(bar(from, to, "explain-overlap", "Where they overlap"));
      const text = (value: number) =>
        start.kind === "time"
          ? moment(`${Math.floor(value / 3600)}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}`)!.text
          : moment(new Date(value).toISOString().slice(0, 10))!.text;
      const [fromText, toText] = [text(from), text(to)];
      facts.push(`They overlap from ${fromText} to ${toText}.`);
      // What the second leaves out of the first, which is usually the point:
      // the feed covers to the 20th, and should cover to the 22nd.
      if (start.kind === "date" && d < b) facts.push(`${otherLabel}: ${days(Math.round((b - d) / DAY))} short.`);
    } else {
      facts.push("They do not overlap.");
    }
  }

  // Checked on the day it starts, or ends: said once, by the label already there.
  const checkedApart = checked && checked.kind === start.kind && checked.at !== start.at && checked.at !== end.at ? checked : null;
  if (checked && checked.kind === start.kind && !backwards && start.kind === "date") {
    const toEnd = Math.round((end.at - checked.at) / DAY);
    const toStart = Math.round((start.at - checked.at) / DAY);
    if (toEnd < 0) facts.push(`It had ended ${days(toEnd)} before it was checked.`);
    else if (toStart > 0) facts.push(`It starts ${days(toStart)} after it was checked.`);
    else facts.push(toEnd === 0 ? "It ends on the day it was checked." : `When checked, it had ${days(toEnd)} left.`);
  }

  return block(title, [
    ...rows,
    node("div", { class: "explain-dates" }, [
      node("span", { text: `${startLabel}: ${start.text}` }),
      checkedApart ? node("span", { class: "explain-today-label", text: `Checked on ${checkedApart.text}` }) : null,
      node("span", { text: `${endLabel}: ${end.text}` }),
    ]),
    other ? node("div", { class: "explain-dates explain-dates-other" }, [node("span", { text: `${otherLabel}: ${other.start.text} to ${other.end.text}` })]) : null,
    node("p", { class: "assistant-text", text: facts.join(" ") }),
  ]);
}
