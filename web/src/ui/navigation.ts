/**
 * View navigation.
 *
 * Every view change - table switch, filter change, page turn - goes through
 * `apply`, so the in-app Back button and whatever the host uses for back are
 * the same mechanism. Where the back stack lives is `HistoryPort`'s business:
 * the browser's own history for the application, a private stack for a viewer
 * embedded in someone else's page.
 */

import type { Dom } from "../dom";
import type { Filter, TableInfo } from "../sources/types";
import { tableInfo, type AppState, type View } from "../state";
import { parseUrl, urlFor, type HistoryEntry, type HistoryPort } from "./history";

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

export class Navigator {
  private depth = 0;
  private feed = "";

  constructor(
    private readonly dom: Dom,
    private readonly history: HistoryPort,
    private readonly state: AppState,
    private readonly onChange: ViewListener,
  ) {
    this.history.onPop((entry) => {
      if (!entry) return;

      // Entries from a previously opened feed cannot be honoured: only one feed
      // is loaded at a time, and their filters describe data that is no longer
      // here. Stay put and put the entry back rather than showing something
      // that does not match what is on screen.
      if (entry.feed !== this.feed) {
        this.history.replace(this.entryFor(this.state.view));
        return;
      }

      this.depth = entry.depth;
      this.apply(entry.view, false);
    });

    this.dom.el<HTMLButtonElement>("back-btn").addEventListener("click", () => this.back());
  }

  private entryFor(view: View): HistoryEntry {
    return { view, depth: this.depth, feed: this.feed };
  }

  /** Re-exported so callers need not know where the URL shape is defined. */
  static urlFor = urlFor;
  static parseUrl = parseUrl;

  /** The view named by the current location, for an app that owns its page. */
  fromLocation(): View | null {
    return this.history.initialView();
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
    this.history.replace(this.entryFor(view));
    this.apply(view, false);
  }

  go(view: View): void {
    this.apply(view, true);
  }

  /** Step back one view. Public so an embedding host can offer its own control. */
  back(): void {
    this.history.back();
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
      this.history.push(this.entryFor(this.state.view));
    }

    this.dom.el<HTMLButtonElement>("back-btn").disabled = this.depth <= 0;
    this.onChange(this.state.view);
  }
}
