/**
 * What a tour is tried on: a sample of its notice, and the feed it was found in.
 *
 * A tour is written for a notice, not for a report, so the samples come from
 * wherever there are some:
 *
 * - the report loaded for the open feed, when it has this notice;
 * - each demo feed whose report has it (see `core/demos.py`);
 * - a sample written by hand, for a notice no feed at hand raises. Its
 *   sentences can be previewed, but there are no rows to run it on.
 *
 * A demo's report and files are read without opening its feed, which is
 * enough to fill sentences and check which rows a step would find. Running a
 * tour on a demo opens its feed; that is the host's part (`mount.ts`).
 */

import { parseReport, type ValidationReport } from "../report";
import type { Demo, DemoTable, TableInfo, ViewerSource } from "../../sources/types";
import type { Sample } from "../template";

export type TrialKind = "report" | "demo" | "hand";

/** One choice in "Try it on", before its samples are read. */
export interface TrialOption {
  id: string;
  kind: TrialKind;
  label: string;
  /** How many samples it has of the notice; 0 for a hand-written one. */
  samples: number;
  demoId?: string;
}

export interface Trial extends TrialOption {
  sampleList: Sample[];
  tables: TableInfo[];
}

export interface TrialDeps {
  source: ViewerSource;
  /** The report loaded for the open feed, if any. */
  report(): ValidationReport | null;
  /** The tables of the feed the report is for. */
  tables(): TableInfo[] | Promise<TableInfo[]>;
  /** The open feed's name, as the toolbar shows it. */
  feedName(): string;
}

/** A demo's files as the viewer describes a table, enough for locating rows in it. */
export function demoTableInfo(tables: DemoTable[]): TableInfo[] {
  return tables.map(
    (table) =>
      ({
        name: table.name,
        row_count: 1,
        lines: "exact",
        forbidden: null,
        columns: table.columns.map((name) => ({ name, related: [], enum_like: false })),
      }) as unknown as TableInfo,
  );
}

export const HAND_TRIAL = "hand";

export class Trials {
  private demosLoading: Promise<Demo[]> | null = null;
  private readonly reports = new Map<string, Promise<ValidationReport>>();
  private readonly demoTables = new Map<string, Promise<TableInfo[]>>();
  /** Hand-written samples, per notice, kept while the page is open. */
  private readonly hand = new Map<string, Sample>();

  constructor(private readonly deps: TrialDeps) {}

  /** Read the demos again: one was added or removed. */
  refresh(): void {
    this.demosLoading = null;
  }

  demos(): Promise<Demo[]> {
    this.demosLoading ??= this.deps.source.demos?.().catch(() => []) ?? Promise.resolve([]);
    return this.demosLoading;
  }

  /** Every way to try a tour for `code`, the ones with the most samples first after the open feed's. */
  async options(code: string): Promise<TrialOption[]> {
    const options: TrialOption[] = [];
    const loaded = this.deps.report()?.notices.find((notice) => notice.code === code);
    if (loaded?.sampleNotices.length) {
      options.push({ id: "report", kind: "report", label: `This feed's report (${this.deps.feedName()})`, samples: loaded.sampleNotices.length });
    }
    const demos = (await this.demos())
      .filter((demo) => demo.available && demo.notices[code])
      .sort((a, b) => (b.notices[code] ?? 0) - (a.notices[code] ?? 0));
    for (const demo of demos) {
      options.push({ id: `demo:${demo.id}`, kind: "demo", label: `Demo: ${demo.title}`, samples: demo.notices[code], demoId: demo.id });
    }
    options.push({ id: HAND_TRIAL, kind: "hand", label: "A sample I write", samples: 0 });
    return options;
  }

  async load(code: string, option: TrialOption): Promise<Trial> {
    if (option.kind === "report") {
      const notice = this.deps.report()?.notices.find((entry) => entry.code === code);
      return { ...option, sampleList: notice?.sampleNotices ?? [], tables: await this.deps.tables() };
    }
    if (option.kind === "demo" && option.demoId) {
      const id = option.demoId;
      const source = this.deps.source;
      if (!this.reports.has(id)) this.reports.set(id, source.demoReport!(id).then(parseReport));
      if (!this.demoTables.has(id)) this.demoTables.set(id, source.demoTables!(id).then(demoTableInfo));
      const [report, tables] = await Promise.all([this.reports.get(id)!, this.demoTables.get(id)!]);
      const notice = report.notices.find((entry) => entry.code === code);
      return { ...option, sampleList: notice?.sampleNotices ?? [], tables };
    }
    return { ...option, sampleList: [this.handSample(code)], tables: await this.deps.tables() };
  }

  /** The hand-written sample for `code`, made on first use; edited in place. */
  handSample(code: string): Sample {
    let sample = this.hand.get(code);
    if (!sample) {
      sample = {};
      this.hand.set(code, sample);
    }
    return sample;
  }
}
