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
import { modeOf, tableInfo, type AppState, type Mode, type View } from "../state";
import type { Screen } from "./screens";
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
export function initialView(
  tables: TableInfo[],
  restoreFrom?: View | null,
  screens: Screen[] = [],
): View | null {
  if (restoreFrom?.screen) {
    // A screen describes the feed rather than one of its files, so it is
    // restorable whatever this feed contains - unless this source has no such
    // screen, in which case it falls through to the file browser rather than
    // opening a pane that would only report the screen is missing.
    if (screens.some((screen) => screen.id === restoreFrom.screen)) return restoreFrom;
  } else if (restoreFrom && tables.some((t) => t.name === restoreFrom.table)) {
    return restoreFrom;
  }

  // The first listed screen is where someone who does not know the file names
  // should land - ours is the overview, a host's is whatever it put first. The
  // file browser is one click away and unchanged; this only decides which of
  // the two opens first.
  const landing_screen = screens.find((screen) => screen.label);
  if (landing_screen) return { table: "", filters: [], page: 1, screen: landing_screen.id };

  const landing =
    PREFERRED_TABLES.map((name) => tables.find((t) => t.name === name)).find(Boolean) ?? tables[0];

  return landing ? { table: landing.name, filters: [], page: 1 } : null;
}

export class Navigator {
  private depth = 0;
  private feed = "";
  /** Undoes the history subscription taken in the constructor. */
  private readonly stopListening: () => void;

  constructor(
    private readonly dom: Dom,
    private readonly history: HistoryPort,
    private readonly state: AppState,
    private readonly onChange: ViewListener,
  ) {
    this.stopListening = this.history.onPop((entry) => {
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

  /** Stop responding to the host's history. See `mount`'s `destroy`. */
  destroy(): void {
    this.stopListening();
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
    // Where the reader was in the other mode described the previous feed's
    // data; carrying it over would switch them to a table or a route that is
    // no longer there, for the same reason an older feed's history entries are
    // ignored below.
    this.state.lastView = {};
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
    // The date comes along: it is the day being looked at, not a property of
    // the screen that was open when it was chosen.
    this.go({ table, filters, page: 1, date: this.state.view.date });
  }

  /** Open a screen by id. `argument` is that screen's own parameter. */
  showScreen(screen: string, argument?: string): void {
    // No params: a screen opens unnarrowed, and the filters of the one being
    // left do not follow. Coming back through Back restores them, because the
    // entry they belong to is still in the stack.
    this.go({ table: "", filters: [], page: 1, screen, argument, date: this.state.view.date });
  }

  /**
   * Change what the current screen is showing - the facets a list is narrowed by.
   *
   * An empty value is a removal rather than a parameter: a caller turning its
   * last chip off says so by passing `""`, and keeping that would leave
   * `&mode=` in the link and a view that reads as narrowed by nothing.
   */
  setParams(params: Record<string, string>): void {
    const kept = Object.fromEntries(Object.entries(params).filter(([, value]) => value));
    this.go({ ...this.state.view, params: Object.keys(kept).length ? kept : undefined });
  }

  /**
   * Look at the same view on a different day.
   *
   * `replace` is for the day the viewer picks for itself when a feed opens:
   * the reader did not choose it, so Back should not undo it and land them on
   * a view with no date at all.
   */
  setDate(date: string | undefined, options: { replace?: boolean } = {}): void {
    if (date === this.state.view.date) return;
    const next = { ...this.state.view, date };

    if (options.replace) {
      this.history.replace({ view: next, depth: this.depth, feed: this.feed });
      this.apply(next, false);
      return;
    }
    this.go(next);
  }

  /**
   * Switch halves, returning to where the reader was in the other one.
   *
   * Falls back to that mode's landing view the first time, which is the first
   * listed screen for Explore and the preferred table for Files.
   */
  switchMode(mode: Mode): void {
    if (modeOf(this.state.view) === mode) return;
    this.state.lastView[modeOf(this.state.view)] = this.state.view;

    const remembered = this.state.lastView[mode];
    if (remembered) return this.go({ ...remembered, date: this.state.view.date });

    const landing = initialView(this.state.tables, null, mode === "explore" ? this.state.screens : []);
    if (landing) this.go({ ...landing, date: this.state.view.date });
  }

  private apply(view: View, push: boolean): void {
    // A screen is a reading of the whole feed rather than of one file, so it
    // is checked against the screens this source offers instead of against the
    // feed's tables. Both refusals exist for the same reason: a stale or
    // hand-written link should leave the current view alone rather than show an
    // empty pane with nothing to explain it.
    const info = view.screen ? undefined : tableInfo(this.state, view.table);
    if (view.screen && !this.state.screens.some((screen) => screen.id === view.screen)) return;
    if (!view.screen && !info) return;

    this.state.view = {
      table: view.table,
      filters: structuredClone(view.filters ?? []),
      page: view.page || 1,
      screen: view.screen,
      argument: view.argument,
      date: view.date,
      params: view.params ? { ...view.params } : undefined,
    };
    this.state.columnInfoByName = info
      ? Object.fromEntries(info.columns.map((c) => [c.name, c]))
      : {};

    this.state.lastView[modeOf(this.state.view)] = this.state.view;

    if (push) {
      this.depth += 1;
      this.history.push(this.entryFor(this.state.view));
    }

    this.dom.el<HTMLButtonElement>("back-btn").disabled = this.depth <= 0;
    this.onChange(this.state.view);
  }
}
