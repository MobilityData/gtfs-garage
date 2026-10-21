/**
 * Quality: a gtfs-validator report, read against the feed that is open.
 *
 * Three states. Without a report, the screen asks for one. With one, it lists
 * the findings - one per notice code - most severe first, narrowed by severity
 * and by file. A finding opens to what the validator says about it and its
 * samples, and every sample can be explained: the Quality assistant walks
 * through it in the table and on the map, step by step.
 *
 * The report never leaves the browser. It is read from a file the reader picks
 * and kept for the session under the feed's name; see `quality/store.ts`.
 */

import { loadCatalog, sampleText, type Catalog, type NoticeDescription } from "../../quality/catalog";
import { renderDescription } from "../../quality/description";
import type { GuideOrigin } from "../../quality/guide-store";
import { compareWithFeed, matches, ReportError, type ReportNotice, type ValidationReport } from "../../quality/report";
import type { TableInfo, ViewerSource } from "../../sources/types";
import { action, append, node, section, stat } from "../html";
import type { Screen, ScreenContext } from "./types";

/** What a screen needs to read and explain a report. Supplied by `mount`. */
export interface QualityContext {
  report(): ValidationReport | null;
  fileName(): string;
  /** Read a report from its text. Throws `ReportError`. */
  load(text: string, name: string): void;
  clear(): void;
  /** Start the Quality assistant on one sample of a notice. */
  explain(code: string, sample: number): void;
  tables(): TableInfo[];
  /** Where a notice's tour comes from. Without it, from the catalog alone. */
  origin?(code: string): GuideOrigin;
  /**
   * Open the tour editor on a notice, trying it on one of its samples:
   * from the open feed's report first, or from a demo feed. Without it, there
   * is no editor.
   */
  edit?(code: string, sample: number, prefer?: "report" | "demo"): void;
}

const SEVERITIES = ["ERROR", "WARNING", "INFO", "SYSTEM_ERROR"] as const;
const SEVERITY_LABEL: Record<string, string> = { ERROR: "Errors", WARNING: "Warnings", INFO: "Infos", SYSTEM_ERROR: "System errors" };
const SEVERITY_CLASS: Record<string, string> = { ERROR: "err", WARNING: "warn", INFO: "info", SYSTEM_ERROR: "err" };

/** Samples shown before the table is cut short; the report caps them anyway. */
const SAMPLES_SHOWN = 100;

function pill(severity: string): HTMLElement {
  return node("span", { class: `pill ${SEVERITY_CLASS[severity] ?? "info"}`, text: severity });
}

function originOf(quality: QualityContext, catalog: Catalog, code: string): GuideOrigin {
  return quality.origin?.(code) ?? (catalog.notices[code]?.guide ? "builtin" : "generic");
}

const ORIGIN_LABEL: Record<GuideOrigin, string> = { saved: "saved tour", builtin: "built-in tour", generic: "automatic" };
const ORIGIN_TITLE: Record<GuideOrigin, string> = {
  saved: "Explained by a tour saved here, over the built-in one if there is one",
  builtin: "Explained by the tour this viewer ships",
  generic: "No tour is written; explained from the fields of its samples",
};

function originTag(origin: GuideOrigin): HTMLElement {
  return node("span", { class: `quality-origin quality-origin-${origin}`, title: ORIGIN_TITLE[origin], text: ORIGIN_LABEL[origin] });
}

/** Edit tour, or Create tour for a notice with none written; null without an editor. */
function editButton(quality: QualityContext, code: string, origin: GuideOrigin, sample = 0): HTMLButtonElement | null {
  if (!quality.edit) return null;
  const element = node("button", {
    class: "quality-edit",
    title: origin === "generic" ? "Write a tour for this notice" : "Change this notice's tour, try it and save it",
    text: origin === "generic" ? "Create tour" : "Edit tour",
  });
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    quality.edit!(code, sample);
  });
  return element;
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en")} ${noun}${n === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ loading

function loader(quality: QualityContext, error?: string): HTMLElement {
  const status = node("p", { class: error ? "explore-error" : "explore-hint", text: error ?? "" });
  const input = node("input", { type: "file", accept: ".json,application/json", hidden: "" }) as HTMLInputElement;

  const read = async (file: File) => {
    status.className = "explore-hint";
    status.textContent = `Reading ${file.name}…`;
    try {
      quality.load(await file.text(), file.name);
    } catch (failure) {
      status.className = "explore-error";
      status.textContent =
        failure instanceof ReportError ? failure.message : `Could not read ${file.name}: ${(failure as Error).message}`;
    }
  };

  const drop = node("div", { class: "quality-drop", role: "button", tabindex: "0" }, [
    node("strong", { text: "Drop a validation report here, or click to choose one" }),
    node("span", {
      class: "explore-hint",
      text: "The report.json that gtfs-validator writes, or that its web service and API return. It stays in this browser.",
    }),
  ]);
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") input.click();
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("drag");
    const file = event.dataTransfer?.files[0];
    if (file) void read(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void read(file);
  });

  return node("div", { class: "explore quality" }, [
    node("h2", { text: "Quality" }),
    node("p", {
      class: "explore-intro",
      text:
        "Load a gtfs-validator report for this feed to see what it found. Each finding links to the rows behind it, " +
        "and the Quality assistant can walk you through any of them in the table and on the map.",
    }),
    drop,
    input,
    status,
    node("p", { class: "explore-hint" }, [
      "No report yet? Validate the feed at ",
      node("a", { href: "https://gtfs-validator.mobilitydata.org", target: "_blank", rel: "noopener noreferrer", text: "gtfs-validator.mobilitydata.org" }),
      " or with the validator's command-line tool, then load its report.json here.",
    ]),
  ]);
}

// --------------------------------------------------------------------- list

function header(report: ValidationReport, quality: QualityContext, catalog: Catalog): HTMLElement {
  const summary = report.summary;
  const comparison = compareWithFeed(report, quality.tables());
  const differences: string[] = [
    ...comparison.onlyInReport.map((file) => `the report covers ${file}, which this feed does not have`),
    ...comparison.onlyInFeed.map((file) => `this feed has ${file}, which the report does not cover`),
    ...comparison.counts.map((entry) => `${entry.label}: ${entry.report} in the report, ${entry.feed} here`),
  ];
  const facts = [
    summary.validatorVersion ? `gtfs-validator ${summary.validatorVersion}` : "gtfs-validator",
    summary.validatedAt ? `run ${String(summary.validatedAt).slice(0, 10)}` : null,
    summary.dateForValidation ? `checked as of ${summary.dateForValidation}` : null,
    quality.fileName() || null,
  ].filter(Boolean);

  const replace = node("button", { title: "Read a different report", text: "Load another report" });
  replace.addEventListener("click", () => quality.clear());

  const versionNote =
    catalog.validator && summary.validatorVersion && summary.validatorVersion.split(".")[0] !== catalog.validator.split(".")[0]
      ? node("p", {
          class: "explore-hint",
          text: `These guides were written for gtfs-validator ${catalog.validator}. Notices this version does not know are explained from their fields alone.`,
        })
      : null;

  return node("div", { class: "quality-header" }, [
    node("div", { class: "quality-title" }, [node("h2", { text: "Quality" }), replace]),
    node("p", { class: "explore-hint", text: facts.join(" · ") }),
    matches(comparison)
      ? node("p", { class: "explore-hint", text: "The files and counts in the report match the open feed." })
      : node("p", {
          class: "quality-mismatch",
          text: `This report may describe another version of the feed: ${differences.join("; ")}. Rows may not line up.`,
        }),
    versionNote,
  ]);
}

function filesOf(notice: ReportNotice, description: NoticeDescription | undefined): string[] {
  const named = new Set<string>(description?.files ?? []);
  for (const sample of notice.sampleNotices.slice(0, 20)) {
    for (const key of ["filename", "childFilename", "parentFilename"]) {
      if (typeof sample[key] === "string") named.add(sample[key] as string);
    }
  }
  return [...named].sort();
}

function renderList(report: ValidationReport, catalog: Catalog, context: ScreenContext, quality: QualityContext): HTMLElement {
  const params = context.params;
  const severity = params.severity ?? "";
  const file = params.file ?? "";
  const files = new Map<string, string[]>(report.notices.map((notice) => [notice.code, filesOf(notice, catalog.notices[notice.code])]));

  const totals = Object.fromEntries(
    SEVERITIES.map((level) => [level, report.notices.filter((notice) => notice.severity === level)]),
  ) as Record<string, ReportNotice[]>;
  const guided = report.notices.filter((notice) => originOf(quality, catalog, notice.code) !== "generic").length;

  const stats = node("div", { class: "stat-row" }, [
    ...SEVERITIES.filter((level) => totals[level].length).map((level) =>
      stat(
        SEVERITY_LABEL[level],
        totals[level].length.toLocaleString("en"),
        `${count(totals[level].reduce((sum, notice) => sum + notice.totalNotices, 0), "occurrence")} across ${count(totals[level].length, "finding")}`,
      ),
    ),
    stat("With a written tour", `${guided} / ${report.notices.length}`, "The rest are explained from their fields"),
  ]);

  const chip = (label: string, on: boolean, title: string, change: Record<string, string>) => {
    const element = node("button", { class: `chip facet-chip${on ? " active" : ""}`, title, text: label });
    element.addEventListener("click", () => context.setParams({ ...params, ...change }));
    return element;
  };
  const allFiles = [...new Set([...files.values()].flat())].sort();
  const chips = node("div", { class: "facets" }, [
    node("div", { class: "facet-row" }, [
      node("span", { class: "facet-label", text: "Severity" }),
      chip("All", !severity, "Show every finding", { severity: "" }),
      ...SEVERITIES.filter((level) => totals[level].length).map((level) =>
        chip(SEVERITY_LABEL[level], severity === level, `Only ${SEVERITY_LABEL[level].toLowerCase()}`, { severity: severity === level ? "" : level }),
      ),
    ]),
    allFiles.length
      ? node("div", { class: "facet-row" }, [
          node("span", { class: "facet-label", text: "File" }),
          ...allFiles.map((name) => chip(name, file === name, `Only findings about ${name}`, { file: file === name ? "" : name })),
        ])
      : null,
  ]);

  const shown = report.notices.filter(
    (notice) => (!severity || notice.severity === severity) && (!file || files.get(notice.code)?.includes(file)),
  );

  const table = node("table", { class: "quality-list" }, [
    node("thead", {}, [
      node("tr", {}, [
        node("th", { text: "Severity" }),
        node("th", { text: "Finding" }),
        node("th", { class: "value-numeric", text: "Total" }),
        node("th", { text: "Files" }),
        node("th", { text: "" }),
      ]),
    ]),
  ]);
  const body = node("tbody");
  for (const notice of shown) {
    const description = catalog.notices[notice.code];
    const origin = originOf(quality, catalog, notice.code);
    const open = () => context.openScreen("quality", notice.code);
    const explain = node("button", {
      class: "primary",
      title: origin !== "generic" ? "Walk through the first sample" : "Walk through the first sample, from its fields",
      text: "Explain",
    });
    explain.disabled = !notice.sampleNotices.length;
    explain.addEventListener("click", (event) => {
      event.stopPropagation();
      quality.explain(notice.code, 0);
    });
    const row = node("tr", { class: "quality-row", title: "Open this finding" }, [
      node("td", {}, [pill(notice.severity)]),
      node("td", {}, [
        node("div", { class: "quality-code", text: notice.code }),
        node("div", { class: "explore-hint", text: description?.summary ?? "Not in this viewer's catalog." }),
      ]),
      node("td", { class: "value-numeric", text: notice.totalNotices.toLocaleString("en") }),
      node("td", { class: "explore-hint", text: (files.get(notice.code) ?? []).join(", ") }),
      node("td", {}, [node("div", { class: "quality-buttons" }, [explain, editButton(quality, notice.code, origin)]), originTag(origin)]),
    ]);
    row.addEventListener("click", open);
    body.append(row);
  }
  table.append(body);

  return node("div", { class: "explore quality" }, [
    header(report, quality, catalog),
    stats,
    chips,
    shown.length
      ? node("div", { class: "quality-scroll" }, [table])
      : node("p", { class: "explore-hint", text: "No finding matches these filters." }),
  ]);
}

// ------------------------------------------------------------------- detail

/**
 * Values repeated across samples: a thousand notices are often one cause.
 *
 * A stop_id that appears in most samples of a foreign key violation is one
 * missing stop, not a thousand problems, and saying so is the most useful
 * thing a list of samples can do.
 */
export function repeatedValues(samples: Record<string, unknown>[], fields: string[]): { field: string; value: string; times: number }[] {
  const found: { field: string; value: string; times: number }[] = [];
  if (samples.length < 3) return found;
  for (const field of fields) {
    if (/CsvRowNumber|csvRowNumber|Index$/.test(field)) continue;
    const counts = new Map<string, number>();
    for (const sample of samples) {
      const value = sampleText(sample, field);
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const [value, times] of counts) {
      if (times >= 3 && times >= samples.length / 4 && counts.size > 1) found.push({ field, value, times });
    }
  }
  return found.sort((a, b) => b.times - a.times).slice(0, 5);
}

function renderDetail(code: string, report: ValidationReport, catalog: Catalog, context: ScreenContext, quality: QualityContext): HTMLElement {
  const notice = report.notices.find((entry) => entry.code === code);
  const description = catalog.notices[code];
  const root = node("div", { class: "explore quality" });
  const back = action("All findings", "Back to the list of findings", () => context.openScreen("quality"));
  if (!notice) {
    root.append(back, node("p", { class: "explore-error", text: `The loaded report has no finding called ${code}.` }));
    return root;
  }

  const fields = [
    ...new Set([...Object.keys(description?.fields ?? {}), ...notice.sampleNotices.flatMap((sample) => Object.keys(sample))]),
  ].filter((field) => notice.sampleNotices.some((sample) => sample[field] !== undefined));

  const samples = notice.sampleNotices.slice(0, SAMPLES_SHOWN);
  const table = node("table", { class: "quality-samples" }, [
    node("thead", {}, [
      node("tr", {}, [
        node("th", { text: "#" }),
        ...fields.map((field) => node("th", { text: field, title: description?.fields[field]?.description })),
        node("th", { text: "" }),
      ]),
    ]),
  ]);
  const body = node("tbody");
  samples.forEach((sample, index) => {
    const explain = node("button", { class: "primary", title: "Walk through this sample", text: "Explain" });
    explain.addEventListener("click", () => quality.explain(code, index));
    body.append(
      node("tr", {}, [
        node("td", { class: "explore-hint", text: String(index + 1) }),
        ...fields.map((field) => node("td", { text: sampleText(sample, field) })),
        node("td", {}, [explain]),
      ]),
    );
  });
  table.append(body);

  const repeated = repeatedValues(samples, fields);
  const origin = originOf(quality, catalog, code);
  const told = {
    saved: "Explained by a tour saved here.",
    builtin: "Explained by a written tour.",
    generic: "No tour is written for this notice yet, so it is explained from its fields.",
  }[origin];

  append(
    root,
    back,
    node("div", { class: "quality-title" }, [pill(notice.severity), node("h2", { class: "quality-code", text: code }), originTag(origin), editButton(quality, code, origin)]),
    node("p", { class: "explore-intro", text: description?.summary ?? "This notice is not in this viewer's catalog." }),
    node("p", {
      class: "explore-hint",
      text: `${count(notice.totalNotices, "occurrence")} in the feed; the report keeps ${count(notice.sampleNotices.length, "sample")}. ${told}`,
    }),
    description?.description
      ? section("What the validator checks", undefined, [node("div", { class: "quality-description" }, renderDescription(description.description))])
      : null,
    repeated.length
      ? section(
          "Repeated across samples",
          "Many occurrences often share one cause.",
          [node("ul", {}, repeated.map((entry) => node("li", { text: `${entry.field} = ${entry.value} in ${entry.times} of ${samples.length} samples` })))],
        )
      : null,
    section(
      "Samples",
      notice.sampleNotices.length > SAMPLES_SHOWN ? `The first ${SAMPLES_SHOWN} of ${notice.sampleNotices.length}.` : undefined,
      [node("div", { class: "quality-scroll" }, [table])],
    ),
  );
  return root;
}

// ------------------------------------------------------------------- screen

export function renderQuality(catalog: Catalog, context: ScreenContext, argument?: string): HTMLElement {
  const quality = context.quality;
  if (!quality) return node("div", { class: "explore-error", text: "This viewer was mounted without a Quality context." });
  const report = quality.report();
  if (!report) return loader(quality);
  return argument ? renderDetail(argument, report, catalog, context, quality) : renderList(report, catalog, context, quality);
}

export const qualityScreen: Screen<{ catalog: Catalog; argument?: string }> = {
  id: "quality",
  label: "Quality",
  title: "Read a gtfs-validator report against this feed, and walk through what it found",
  available: () => true,
  fetch: async (_source: ViewerSource, argument?: string) => ({ catalog: await loadCatalog(), argument }),
  render: ({ catalog, argument }, context) => renderQuality(catalog, context, argument),
};
