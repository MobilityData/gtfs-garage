/**
 * View navigation and history.
 *
 * Every view change - table switch, filter change, page turn - goes through
 * `setView`, so the in-app Back button and the browser's own back/forward are
 * the same mechanism, and the URL always describes the current view.
 */

import type { Dom } from "../dom";
import type { Filter, TableInfo } from "../sources/types";
import { tableInfo, type AppState, type View } from "../state";

export type ViewListener = (view: View) => void;

/**
 * Where to land when a feed opens: what the feed says about itself, then who
 * runs it, then what it runs.
 */
export const PREFERRED_TABLES = ["feed_info", "agency", "routes"];

/**
 * Choose the first view of a feed.
 *
 * `restoreFrom` is only passed on page load, so a reloaded or shared URL comes
 * back to the same place. Opening a different feed deliberately ignores it: its
 * filters describe the previous feed's data and would either match nothing or,
 * worse, silently hide rows in a table that happens to share a name.
 */
export function initialView(tables: TableInfo[], restoreFrom?: View | null): View | null {
  if (restoreFrom && tables.some((t) => t.name === restoreFrom.table)) {
    return restoreFrom;
  }

  const landing =
    PREFERRED_TABLES.map((name) => tables.find((t) => t.name === name)).find(Boolean) ?? tables[0];

  return landing ? { table: landing.name, filters: [], page: 1 } : null;
}

interface HistoryEntry {
  gtfsView: View & { depth: number };
  /** Which feed the view describes. */
  feed: string;
}

export class Navigator {
  private depth = 0;
  private feed = "";

  constructor(
    private readonly dom: Dom,
    private readonly state: AppState,
    private readonly onChange: ViewListener,
  ) {
    window.addEventListener("popstate", (event) => {
      const entry = event.state as HistoryEntry | null;
      if (!entry?.gtfsView) return;

      // Entries from a previously opened feed cannot be honoured: only one feed
      // is loaded at a time, and their filters describe data that is no longer
      // here. Stay put and put the URL back rather than showing something that
      // does not match what is on screen.
      if (entry.feed !== this.feed) {
        history.replaceState(this.entryFor(this.state.view), "", Navigator.urlFor(this.state.view));
        return;
      }

      this.depth = entry.gtfsView.depth ?? 0;
      this.apply(entry.gtfsView, false);
    });

    this.dom.el<HTMLButtonElement>("back-btn").addEventListener("click", () => history.back());
  }

  private entryFor(view: View): HistoryEntry {
    return { gtfsView: { ...view, depth: this.depth }, feed: this.feed };
  }

  static urlFor(view: View): string {
    const params = new URLSearchParams({ table: view.table, page: String(view.page || 1) });
    if (view.filters.length) params.set("filters", JSON.stringify(view.filters));
    return `?${params}`;
  }

  /** Pure counterpart of `fromUrl`, so it can be tested without a document. */
  static parseUrl(search: string): View | null {
    const params = new URLSearchParams(search);
    const table = params.get("table");
    if (!table) return null;

    let filters: Filter[] = [];
    try {
      const parsed = JSON.parse(params.get("filters") || "[]") as unknown;
      filters = Array.isArray(parsed) ? (parsed as Filter[]) : [];
    } catch {
      filters = [];
    }
    return { table, filters, page: Number(params.get("page")) || 1 };
  }

  static fromUrl(): View | null {
    return Navigator.parseUrl(location.search);
  }

  current(): View {
    return this.state.view;
  }

  /**
   * Start a fresh history for a newly opened feed.
   *
   * `feed` identifies it, so entries left in the browser's history by an
   * earlier feed can be recognised and ignored.
   */
  reset(view: View, feed: string): void {
    this.depth = 0;
    this.feed = feed;
    history.replaceState(this.entryFor(view), "", Navigator.urlFor(view));
    this.apply(view, false);
  }

  go(view: View): void {
    this.apply(view, true);
  }

  selectTable(table: string, filters: Filter[] = []): void {
    this.go({ table, filters, page: 1 });
  }

  private apply(view: View, push: boolean): void {
    const info = tableInfo(this.state, view.table);
    if (!info) return;

    this.state.view = {
      table: view.table,
      filters: structuredClone(view.filters ?? []),
      page: view.page || 1,
    };
    this.state.columnInfoByName = Object.fromEntries(info.columns.map((c) => [c.name, c]));

    if (push) {
      this.depth += 1;
      history.pushState(this.entryFor(this.state.view), "", Navigator.urlFor(this.state.view));
    }

    this.dom.el<HTMLButtonElement>("back-btn").disabled = this.depth <= 0;
    this.onChange(this.state.view);
  }
}
