/**
 * View navigation and history.
 *
 * Every view change - table switch, filter change, page turn - goes through
 * `setView`, so the in-app Back button and the browser's own back/forward are
 * the same mechanism, and the URL always describes the current view.
 */

import { el } from "../dom";
import type { Filter } from "../sources/types";
import { tableInfo, type AppState, type View } from "../state";

export type ViewListener = (view: View) => void;

interface HistoryEntry {
  gtfsView: View & { depth: number };
}

export class Navigator {
  private depth = 0;

  constructor(
    private readonly state: AppState,
    private readonly onChange: ViewListener,
  ) {
    window.addEventListener("popstate", (event) => {
      const entry = (event.state as HistoryEntry | null)?.gtfsView;
      if (!entry) return;
      this.depth = entry.depth ?? 0;
      this.apply(entry, false);
    });

    el<HTMLButtonElement>("back-btn").addEventListener("click", () => history.back());
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

  /** Start a fresh history for a newly loaded feed. */
  reset(view: View): void {
    this.depth = 0;
    history.replaceState({ gtfsView: { ...view, depth: 0 } } satisfies HistoryEntry, "", Navigator.urlFor(view));
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
      history.pushState(
        { gtfsView: { ...this.state.view, depth: this.depth } } satisfies HistoryEntry,
        "",
        Navigator.urlFor(this.state.view),
      );
    }

    el<HTMLButtonElement>("back-btn").disabled = this.depth <= 0;
    this.onChange(this.state.view);
  }
}
