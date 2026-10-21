/**
 * Every tour in schema/guides/, tried on every demo sample of its notice.
 *
 * The build checks a tour is well formed; this checks it works on real data:
 * that no step is left out on a demo sample, no action is dropped for a field
 * the sample lacks, and every set of rows a step opens is really there - by
 * line, or by column values - in the demo's own files. A tour pointing at the
 * wrong file passes every other check and fails this one.
 *
 * Reads the YAML files directly, so it needs no build. To narrow it:
 *
 *     TOUR_CODES=unused_shape,expired_calendar npx vitest run src/quality/tours.test.ts
 *
 * TOUR_PRINT=<path> also writes every tour as a reader would read it on each
 * sample, step by step, for a person to review.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import catalogJson from "../../../src/gtfs_garage/data/guides.json";
import type { TableInfo } from "../sources/types";
import type { Catalog, Guide } from "./catalog";
import { isLocated, type Located } from "./locate";
import { parseReport, type ValidationReport } from "./report";
import type { Sample } from "./template";
import { validateGuide } from "./validate";
import { resolveWalkthrough } from "./walkthrough";

const catalog = catalogJson as unknown as Catalog;
const GUIDES = join(__dirname, "../../../schema/guides");
const DEMOS = join(__dirname, "../../../src/gtfs_garage/data/demos");
const SAMPLES_PER_DEMO = 3;

interface CsvRecord {
  values: Record<string, string>;
  /** The line the record ends on, header = 1: what the validator calls csvRowNumber. */
  line: number;
}

/** A CSV file's records, each with the line it ends on. Enough for the demo feeds. */
function readCsv(text: string): { header: string[]; records: CsvRecord[] } {
  const rows: { fields: string[]; line: number }[] = [];
  let field = "";
  let fields: string[] = [];
  let quoted = false;
  let line = 1;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else {
        if (char === "\n") line += 1;
        field += char;
      }
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      fields.push(field);
      rows.push({ fields, line });
      fields = [];
      field = "";
      line += 1;
    } else field += char;
  }
  if (field || fields.length) {
    fields.push(field);
    rows.push({ fields, line });
  }
  const [head, ...rest] = rows;
  const header = (head?.fields ?? []).map((name) => name.trim());
  // As the loader reads them: blank lines and rows with the wrong number of
  // fields are not rows of the table.
  const records = rest
    .filter((row) => row.fields.some((value) => value.trim() !== "") && row.fields.length === header.length)
    .map((row) => ({ line: row.line, values: Object.fromEntries(header.map((name, i) => [name, (row.fields[i] ?? "").trim()])) }));
  return { header, records };
}

interface Demo {
  id: string;
  report: ValidationReport;
  tables: TableInfo[];
  files: Map<string, { header: string[]; records: CsvRecord[] }>;
}

function feedDirectory(root: string): string {
  if (readdirSync(root).some((file) => file.endsWith(".txt"))) return root;
  const inner = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return inner.length === 1 ? join(root, inner[0].name) : root;
}

function loadDemos(): Demo[] {
  const listed = JSON.parse(readFileSync(join(DEMOS, "demos.json"), "utf-8")).demos as { id: string }[];
  return listed.map(({ id }) => {
    const directory = feedDirectory(join(DEMOS, id));
    const files = new Map<string, { header: string[]; records: CsvRecord[] }>();
    const tables: TableInfo[] = [];
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".txt"))) {
      const parsed = readCsv(readFileSync(join(directory, file), "utf-8"));
      const name = file.replace(/\.txt$/, "");
      files.set(name, parsed);
      tables.push({
        name,
        row_count: parsed.records.length,
        lines: "exact",
        forbidden: null,
        columns: parsed.header.map((column) => ({ name: column, related: [], enum_like: false })),
      } as unknown as TableInfo);
    }
    if (existsSync(join(directory, "locations.geojson"))) {
      tables.push({ name: "locations", row_count: 1, lines: null, forbidden: null, columns: [{ name: "id", related: [], enum_like: false }] } as unknown as TableInfo);
    }
    // The validator's own failures are kept apart, in <id>.system_errors.json.
    const report = parseReport(readFileSync(join(DEMOS, `${id}.report.json`), "utf-8"));
    const errors = join(DEMOS, `${id}.system_errors.json`);
    if (existsSync(errors)) report.notices.push(...parseReport(readFileSync(errors, "utf-8")).notices);
    return { id, report, tables, files };
  });
}

/** What is wrong with the rows a step would open, in the demo's own files; null when they are there. */
function rowsProblem(located: Located, demo: Demo, expectEmpty: boolean, around: boolean): string | null {
  const file = demo.files.get(located.table);
  if (located.table === "locations") return null; // GeoJSON: features, not lines; not checked here.
  if (!file) return `${located.table}.txt is not in the demo feed`;
  if (located.by === "file") return null;
  let matching: CsvRecord[];
  if (located.by === "line") {
    // With `around`, the lines shown are in the filter; `lines` is the row itself.
    const shown = around ? String(located.filters[0]?.value ?? "").split(",").map(Number) : (located.lines ?? []);
    const lines = new Set(shown);
    matching = file.records.filter((record) => lines.has(record.line));
    const missing = [...lines].filter((line) => !file.records.some((record) => record.line === line));
    // Lines either side of a row are context: some may be missing, the row itself among them.
    if (missing.length && !expectEmpty && !(around && matching.length)) return `${located.table}.txt has no record ending on line ${missing.join(", ")}`;
  } else {
    matching = file.records.filter((record) => located.filters.every((filter) => record.values[filter.column] === String(filter.value)));
  }
  if (expectEmpty) return matching.length ? `${located.table}.txt has ${matching.length} matching rows, but the step says none should match` : null;
  if (!matching.length) return `no row of ${located.table}.txt has ${located.filters.map((f) => `${f.column} = ${f.value}`).join(" and ")}`;
  return null;
}

interface Written {
  code: string;
  guide: Guide;
}

function readGuides(): Written[] {
  const wanted = (process.env.TOUR_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean);
  return readdirSync(GUIDES)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => ({ code: file.replace(/\.yaml$/, ""), guide: parse(readFileSync(join(GUIDES, file), "utf-8")) as Guide }))
    .filter((entry) => !wanted.length || wanted.includes(entry.code));
}

describe("every written tour, on the demo feeds", () => {
  const demos = loadDemos();
  const guides = readGuides();
  const print = process.env.TOUR_PRINT;
  if (print) writeFileSync(print, "");

  it.each(guides.map((entry) => [entry.code, entry] as const))("%s", (code, { guide }) => {
    const notice = catalog.notices[code];
    expect(notice, `${code} is not a notice the validator emits`).toBeTruthy();
    const problems = validateGuide(code, guide, Object.keys(notice.fields), catalog).map((problem) => problem.text);
    expect(problems, "The tour does not pass the check").toEqual([]);

    const failures: string[] = [];
    let tried = 0;
    for (const demo of demos) {
      const samples: Sample[] = demo.report.notices.find((entry) => entry.code === code)?.sampleNotices.slice(0, SAMPLES_PER_DEMO) ?? [];
      samples.forEach((sample, index) => {
        tried += 1;
        const where = `${demo.id} sample ${index + 1}`;
        const walkthrough = resolveWalkthrough(guide, true, sample, demo.tables, notice);
        const authored = walkthrough.steps.slice(0, guide.steps.length);
        if (authored.length < guide.steps.length || walkthrough.steps.length < guide.steps.length) {
          failures.push(`${where}: ${guide.steps.length - Math.min(authored.length, walkthrough.steps.length)} step(s) left out, their sentence needs a field the sample lacks`);
        }
        for (const [n, step] of walkthrough.steps.entries()) {
          for (const skipped of step.skipped) failures.push(`${where} step ${n + 1}: ${skipped.kind} left out, the sample has no ${skipped.field}`);
          for (const action of step.actions) {
            for (const located of Object.values(action.located)) {
              const expectEmpty = action.kind === "open_rows" && action.args.expect === "empty";
              if (!isLocated(located)) {
                // No such file is the emptiest result there is, for a step showing that nothing matches.
                if (!(expectEmpty && /^This feed has no(ne of)? /.test(located.problem))) failures.push(`${where} step ${n + 1}: ${located.problem}`);
                continue;
              }
              if (action.kind === "open_rows" && action.args.expect === "any") continue;
              const problem = rowsProblem(located, demo, action.kind === "open_rows" && action.args.expect === "empty", Number(action.args.around) > 0);
              if (problem) failures.push(`${where} step ${n + 1} ${action.kind}: ${problem}`);
            }
          }
        }
        if (print) {
          const lines = walkthrough.steps.map((step, n) => `  ${n + 1}. ${step.text}${step.actions.length ? `   [${step.actions.map((action) => action.kind).join(", ")}]` : ""}`);
          appendFileSync(print, `\n## ${code} (${notice.severity}) - ${where}\n${lines.join("\n")}\n`);
        }
      });
    }
    if (print && !tried) appendFileSync(print, `\n## ${code} (${notice.severity}) - no demo sample\n${guide.steps.map((step, n) => `  ${n + 1}. ${step.text}`).join("\n")}\n`);
    expect(failures, "On the demo feeds").toEqual([]);
  });
});
