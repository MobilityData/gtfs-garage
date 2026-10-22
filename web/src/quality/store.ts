/**
 * The report being read, for the feed that is open.
 *
 * One per viewer. Kept in session storage under the feed's name as well as in
 * memory, so reloading the page - or following a link to a walkthrough step -
 * does not ask for the file again. Session storage is a convenience: a report
 * too large for it, or a browser that refuses it, still works for the life of
 * the page.
 */

import { parseReport, type ValidationReport } from "./report";

const KEY = "gtfs-garage.quality-report:";

type Listener = (report: ValidationReport | null) => void;

export class QualityStore {
  private current: ValidationReport | null = null;
  private feed = "";
  private name = "";
  private readonly listeners = new Set<Listener>();

  report(): ValidationReport | null {
    return this.current;
  }

  /** The file the report was read from, for the screen to say. */
  fileName(): string {
    return this.name;
  }

  /** A new feed opened: its own report if this session read one, else none. */
  useFeed(feed: string): void {
    if (feed === this.feed) return;
    this.feed = feed;
    this.current = null;
    this.name = "";
    try {
      const saved = sessionStorage.getItem(KEY + feed);
      if (saved) {
        const { name, report } = JSON.parse(saved) as { name: string; report: unknown };
        this.current = parseReport(report);
        this.name = name;
      }
    } catch {
      /* nothing saved, or storage refused: start without a report */
    }
    this.emit();
  }

  /** Read a report. Throws `ReportError` with a sentence a reader can act on. */
  load(input: string | unknown, name = "report.json"): ValidationReport {
    const report = parseReport(input);
    this.current = report;
    this.name = name;
    try {
      sessionStorage.setItem(KEY + this.feed, JSON.stringify({ name, report }));
    } catch {
      /* too large for session storage, or refused: kept in memory only */
    }
    this.emit();
    return report;
  }

  clear(): void {
    this.current = null;
    this.name = "";
    try {
      sessionStorage.removeItem(KEY + this.feed);
    } catch {
      /* nothing to remove */
    }
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}
