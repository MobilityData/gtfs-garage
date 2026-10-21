/**
 * From a guide's locator to the filters the viewer already understands.
 *
 * Two addresses, tried in order. A line is what a report gives for most
 * notices and locates any row of any file; it is used when the table's line
 * numbers were checked against the file, or when there is nothing else. A key -
 * column values - works without line numbers at all, and wins when the line
 * numbers are only approximate.
 */

import { LINE_COLUMN, type Filter, type TableInfo } from "../sources/types";
import { tableOf, type Locator } from "./catalog";
import { asText } from "./template";

export interface Located {
  table: string;
  filters: Filter[];
  /** How the rows were found, which the panel says. */
  by: "line" | "key" | "file";
  /** The lines named, when found by line. */
  lines?: number[];
}

export interface Unlocatable {
  problem: string;
}

export function isLocated(value: Located | Unlocatable): value is Located {
  return "table" in value;
}

/** "4, 8" or [4, 8] or 4 as line numbers, or null when any part is not one. */
export function parseLines(value: unknown): number[] | null {
  const parts = (Array.isArray(value) ? value.map(asText) : asText(value).split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || !parts.every((part) => /^\d+$/.test(part))) return null;
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export interface LocateOptions {
  /** Widen a line locator by this many lines either side. */
  around?: number;
}

/**
 * A filled locator as filters on a table, or why it cannot be.
 *
 * The validator sometimes names a choice of files - a service is in
 * "calendar.txt or calendar_dates.txt" - and then the first of them this feed
 * has, with the columns the key names, is the one opened.
 */
export function locate(locator: Locator, tables: TableInfo[], options: LocateOptions = {}): Located | Unlocatable {
  const choices = asText(locator.file).split(/\s+or\s+/).map((file) => tableOf(file.trim())).filter(Boolean);
  if (choices.length > 1) {
    const keyColumns = Object.keys(locator.key ?? {});
    const fits = (name: string) => {
      const info = tables.find((entry) => entry.name === name);
      return info && keyColumns.every((column) => info.columns.some((entry) => entry.name === column));
    };
    const chosen = choices.find(fits) ?? choices.find((name) => tables.some((entry) => entry.name === name));
    if (!chosen) return { problem: `This feed has none of ${choices.map((name) => `${name}.txt`).join(" or ")}.` };
    return locate({ ...locator, file: chosen }, tables, options);
  }
  const table = tableOf(asText(locator.file));
  const info = tables.find((entry) => entry.name === table);
  if (!info) return { problem: `This feed has no ${table}.txt.` };

  const lines = locator.line !== undefined ? parseLines(locator.line) : null;
  const key = Object.entries(locator.key ?? {}).filter(([, value]) => asText(value) !== "");
  const columns = new Set(info.columns.map((column) => column.name));
  const keyUsable = key.length > 0 && key.every(([column]) => columns.has(column));
  const lineUsable = Boolean(lines?.length) && info.lines != null && (info.lines === "exact" || !keyUsable);

  if (lineUsable && lines) {
    const around = Math.max(0, Math.floor(options.around ?? 0));
    const wanted = around
      ? [...new Set(lines.flatMap((line) => Array.from({ length: around * 2 + 1 }, (_, i) => line - around + i)))]
          .filter((line) => line >= 2)
          .sort((a, b) => a - b)
      : lines;
    return {
      table,
      by: "line",
      lines,
      filters: [{ column: LINE_COLUMN, op: wanted.length > 1 ? "in" : "eq", value: wanted.join(",") }],
    };
  }
  if (keyUsable) {
    return {
      table,
      by: "key",
      filters: key.map(([column, value]) => ({ column, op: "eq", value: asText(value) })),
    };
  }
  if (key.length && !keyUsable) {
    const absent = key.map(([column]) => column).filter((column) => !columns.has(column));
    return { problem: `${table}.txt has no ${absent.join(", ")} column.` };
  }
  if (lines?.length) return { problem: `${table}.txt has no line numbers in this source.` };
  return { table, by: "file", filters: [] };
}
