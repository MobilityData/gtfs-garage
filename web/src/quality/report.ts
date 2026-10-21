/**
 * A gtfs-validator report, read and checked against the open feed.
 *
 * The shape is the validator's `report.json`, which the validator API returns
 * unchanged (`ValidationReport` in GTFSValidatorAPI.yaml): a `summary` and a
 * list of `notices`, one per code, each with its severity, how many times it
 * fired and a capped list of samples. The samples are shaped per code; what
 * each code carries is in the catalog (`catalog.ts`).
 *
 * The Mobility Database stores the same report with each notice's samples as a
 * JSON string rather than an array, so that is accepted too.
 */

import type { Severity } from "./catalog";
import type { Sample } from "./template";

export interface ReportNotice {
  code: string;
  severity: Severity;
  totalNotices: number;
  sampleNotices: Sample[];
}

export interface ReportSummary {
  validatorVersion?: string;
  validatedAt?: string;
  gtfsInput?: string;
  countryCode?: string;
  dateForValidation?: string;
  files?: string[];
  counts?: Record<string, number>;
  [other: string]: unknown;
}

export interface ValidationReport {
  summary: ReportSummary;
  notices: ReportNotice[];
}

export class ReportError extends Error {}

const SEVERITIES = new Set(["ERROR", "WARNING", "INFO", "SYSTEM_ERROR"]);

/** Most severe first, then most frequent: the order a reader fixes things in. */
const RANK: Record<string, number> = { SYSTEM_ERROR: 0, ERROR: 1, WARNING: 2, INFO: 3 };

/**
 * Read a report from its JSON text, or from an already-parsed object.
 *
 * Says what is wrong in words a reader can act on, because the commonest
 * mistake is handing it the HTML report or the system errors file instead.
 */
export function parseReport(input: string | unknown): ValidationReport {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new ReportError("This file is not JSON. Choose the report.json the validator wrote, not report.html.");
    }
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as { notices?: unknown }).notices)) {
    throw new ReportError("This JSON has no list of notices, so it is not a validation report. Choose report.json.");
  }

  const raw = data as { summary?: unknown; notices: unknown[] };
  const notices: ReportNotice[] = [];
  for (const entry of raw.notices) {
    if (!entry || typeof entry !== "object") continue;
    const notice = entry as Record<string, unknown>;
    if (typeof notice.code !== "string") continue;
    let samples = notice.sampleNotices;
    if (typeof samples === "string") {
      try {
        samples = JSON.parse(samples);
      } catch {
        samples = [];
      }
    }
    const severity = String(notice.severity ?? "").toUpperCase();
    notices.push({
      code: notice.code,
      severity: (SEVERITIES.has(severity) ? severity : "INFO") as Severity,
      totalNotices: Number(notice.totalNotices) || (Array.isArray(samples) ? samples.length : 0),
      sampleNotices: Array.isArray(samples) ? (samples.filter((s) => s && typeof s === "object") as Sample[]) : [],
    });
  }

  notices.sort(
    (a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || b.totalNotices - a.totalNotices || (a.code < b.code ? -1 : 1),
  );
  const summary = raw.summary && typeof raw.summary === "object" ? (raw.summary as ReportSummary) : {};
  return { summary, notices };
}

export interface FeedComparison {
  /** Files the validator read that the open feed does not have. */
  onlyInReport: string[];
  /** Files the open feed has that the validator did not read. */
  onlyInFeed: string[];
  /** Entity counts that differ, where the report states them. */
  counts: { label: string; report: number; feed: number }[];
}

/** The report's count names, and the table whose rows they count. */
const COUNTED: Record<string, string> = { Agencies: "agency", Routes: "routes", Trips: "trips" };

/**
 * Whether this report describes the feed that is open.
 *
 * A report belongs to one version of a dataset. Pointing its row numbers at a
 * different version lands on the wrong rows with total confidence, so the
 * screen says when the two disagree rather than leaving the reader to notice.
 */
export function compareWithFeed(
  report: ValidationReport,
  tables: { name: string; row_count: number }[],
): FeedComparison {
  const fileOf = (table: string) => (table === "locations" ? "locations.geojson" : `${table}.txt`);
  const feedFiles = new Set(tables.map((table) => fileOf(table.name)));
  const reportFiles = new Set(report.summary.files ?? []);
  const counts: FeedComparison["counts"] = [];
  for (const [label, table] of Object.entries(COUNTED)) {
    const stated = report.summary.counts?.[label];
    const actual = tables.find((entry) => entry.name === table)?.row_count;
    if (typeof stated === "number" && typeof actual === "number" && stated !== actual) {
      counts.push({ label, report: stated, feed: actual });
    }
  }
  return {
    onlyInReport: reportFiles.size ? [...reportFiles].filter((file) => !feedFiles.has(file)).sort() : [],
    onlyInFeed: reportFiles.size ? [...feedFiles].filter((file) => !reportFiles.has(file)).sort() : [],
    counts,
  };
}

export function matches(comparison: FeedComparison): boolean {
  return !comparison.onlyInReport.length && !comparison.onlyInFeed.length && !comparison.counts.length;
}
