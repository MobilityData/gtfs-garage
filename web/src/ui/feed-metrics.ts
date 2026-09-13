/**
 * The load report: what opening the current feed cost, per phase and per file.
 *
 * The numbers come from the server, with one exception - the round trip the
 * browser waited for, which only the browser can see. Formatting and ordering
 * live in exported functions so they can be tested without a document, the
 * same arrangement as `Navigator.parseUrl`.
 */

import { el } from "../dom";
import type { FileMetrics, LoadMetrics } from "../sources/types";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** How the feed reached the server, in words for the report. */
const KIND_LABELS: Record<LoadMetrics["kind"], string> = {
  path: "Local path",
  upload: "Upload",
  folder: "Folder upload",
  download: "Download",
};

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes are whole things; larger units read better with one decimal.
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  // Sub-10ms is the normal case for view creation, where rounding to zero
  // would read as "not measured" rather than "fast".
  return `${ms.toFixed(1)} ms`;
}

/**
 * Uncompressed bytes, which is what was read and what the per-file shares are
 * taken of. `total_bytes` is the source's own size - for a zip the two differ
 * by the compression ratio, so mixing them would not add up on screen.
 */
function dataBytes(metrics: LoadMetrics): number {
  return metrics.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** The one-line summary shown in the header. */
export function summaryLine(metrics: LoadMetrics, clientMs?: number): string {
  const parts = [
    `${metrics.files.length} ${metrics.files.length === 1 ? "file" : "files"}`,
    formatBytes(dataBytes(metrics)),
    `${formatMs(metrics.total_ms)} server`,
  ];
  if (clientMs !== undefined) parts.push(`${formatMs(clientMs)} round trip`);
  return parts.join(" · ");
}

/** The phases that actually happened, in the order they happened. */
export function phaseRows(metrics: LoadMetrics): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (metrics.acquire_ms !== null) {
    const bytes = metrics.acquire_bytes === null ? "" : ` · ${formatBytes(metrics.acquire_bytes)}`;
    rows.push([KIND_LABELS[metrics.kind], `${formatMs(metrics.acquire_ms)}${bytes}`]);
  }
  if (metrics.extract_ms !== null) {
    rows.push(["Unzip", `${formatMs(metrics.extract_ms)} · ${formatBytes(metrics.total_bytes)} archive`]);
  }
  rows.push(["Read headers", formatMs(metrics.register_ms)]);
  if (metrics.convert_ms !== null) {
    // Worth showing what the conversion bought, not just what it cost.
    const stored = metrics.stored_bytes === null ? "" : ` · ${formatBytes(metrics.stored_bytes)} stored`;
    rows.push(["Convert to Parquet", `${formatMs(metrics.convert_ms)}${stored}`]);
  }
  rows.push(["Count rows", formatMs(metrics.count_ms)]);
  return rows;
}

export interface FileRow {
  name: string;
  bytes: string;
  /** Share of the feed's uncompressed size, as a whole percentage. */
  share: number;
  compressed: string;
  /** Size as Parquet; an em dash when the feed was not converted. */
  stored: string;
  /**
   * What this file cost: converting it, or counting it when the feed was left
   * as CSV. One number rather than two, because the two the report used to show
   * were measured against different storage - the header read happens on the
   * CSV before conversion and the row count on the Parquet after it - so
   * reading them side by side told you nothing.
   */
  costMs: string;
  rows: string;
  columns: number;
}

/**
 * Largest file first: the point of the report is to name the file that
 * dominated the load, and on a real feed that is almost always stop_times.txt.
 */
export function fileRows(metrics: LoadMetrics): FileRow[] {
  const total = dataBytes(metrics);
  return [...metrics.files]
    .sort((a, b) => b.bytes - a.bytes)
    .map((file) => ({
      name: file.name,
      bytes: formatBytes(file.bytes),
      share: total === 0 ? 0 : Math.round((file.bytes / total) * 100),
      compressed: file.compressed_bytes === null ? "—" : formatBytes(file.compressed_bytes),
      stored: file.parquet_bytes === null ? "—" : formatBytes(file.parquet_bytes),
      costMs: formatCost(metrics, file),
      rows: file.row_count === null ? "—" : file.row_count.toLocaleString(),
      columns: file.columns,
    }));
}

/** True when the feed was rewritten as Parquet rather than read as CSV. */
function converted(metrics: LoadMetrics): boolean {
  return metrics.convert_ms !== null;
}

function formatCost(metrics: LoadMetrics, file: FileMetrics): string {
  // A file that would not convert inside an otherwise converted feed keeps its
  // CSV view and so has no conversion time to show.
  const cost = converted(metrics) ? file.convert_ms : file.count_ms;
  return cost === null ? "—" : formatMs(cost);
}

interface Column {
  label: string;
  /** Shown on hover: these are timings whose meaning is not self-evident. */
  title?: string;
  value: (row: FileRow) => string;
}

/**
 * The last column depends on what the load actually did to each file, so the
 * set is built per report rather than held as a constant.
 */
function fileColumns(metrics: LoadMetrics): Column[] {
  const cost: Column = converted(metrics)
    ? {
        label: "Convert",
        title: "Time to rewrite this file as Parquet, which is what every query then reads.",
        value: (row) => row.costMs,
      }
    : {
        label: "Count",
        title: "Time to read this file end to end to count its rows.",
        value: (row) => row.costMs,
      };

  return [
    { label: "File", value: (row) => row.name },
    { label: "Size", title: "Uncompressed, and its share of the feed", value: (row) => `${row.bytes} (${row.share}%)` },
    { label: "Zipped", title: "Size inside the archive", value: (row) => row.compressed },
    { label: "Stored", title: "Size as Parquet, which is what queries read", value: (row) => row.stored },
    { label: "Rows", value: (row) => row.rows },
    { label: "Cols", value: (row) => String(row.columns) },
    cost,
  ];
}

function phaseList(metrics: LoadMetrics): HTMLElement {
  const list = document.createElement("dl");
  list.id = "metrics-phases";
  for (const [label, value] of phaseRows(metrics)) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(term, detail);
  }
  return list;
}

function fileTable(metrics: LoadMetrics): HTMLElement {
  const columns = fileColumns(metrics);
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.textContent = column.label;
    if (column.title) cell.title = column.title;
    head.appendChild(cell);
  }
  table.appendChild(head);

  for (const row of fileRows(metrics)) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("td");
      cell.textContent = column.value(row);
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }
  return table;
}

/**
 * Fills the header summary and the panel it expands into. The panel starts
 * closed: a load report should be there when wanted, not in the way.
 */
export function renderMetrics(metrics: LoadMetrics, clientMs?: number): void {
  const button = el<HTMLButtonElement>("metrics-btn");
  button.textContent = summaryLine(metrics, clientMs);
  button.hidden = false;

  const body = el("metrics-body");
  body.innerHTML = "";
  body.append(phaseList(metrics), fileTable(metrics));
  el("metrics-panel").classList.add("hidden");
}

/** Wires the summary button to the panel it opens. Called once, at startup. */
export function initMetricsPanel(): void {
  const panel = el("metrics-panel");
  el("metrics-btn").addEventListener("click", () => panel.classList.toggle("hidden"));
  el("metrics-close-btn").addEventListener("click", () => panel.classList.add("hidden"));
}
