/**
 * Where a viewer's back stack lives.
 *
 * The application owns its page, so its stack is the browser's own history and
 * the URL describes the current view - that is what makes a view reloadable and
 * shareable. A viewer embedded in someone else's page must not do that: writing
 * to `history` from a component fights the host's router, and the host may well
 * want the view in its URL under a different scheme, or not at all.
 *
 * So the browser is one implementation of this port rather than an assumption
 * baked into `Navigator`. `memoryHistory` is the other, and is what an embedded
 * viewer uses: the same back behaviour, kept to itself.
 */

import type { Filter } from "../sources/types";
import type { View } from "../state";

export interface HistoryEntry {
  view: View;
  /** How deep into the stack this entry is, so Back knows when to stop. */
  depth: number;
  /** Which feed the view describes; entries from an older feed are ignored. */
  feed: string;
}

export interface HistoryPort {
  push(entry: HistoryEntry): void;
  replace(entry: HistoryEntry): void;
  back(): void;
  /**
   * Called when the user navigates back or forward. Returns a disposer: an
   * embedded viewer is unmounted and remounted by its host, and a listener left
   * on `window` would drive a viewer that no longer exists.
   */
  onPop(handler: (entry: HistoryEntry | null) => void): () => void;
  /** The view this viewer should open on, if the location names one. */
  initialView(): View | null;
}

/** `?table=stops&page=2&filters=[…]` - the shape a shared link has. */
export function urlFor(view: View): string {
  const params = new URLSearchParams({ table: view.table, page: String(view.page || 1) });
  if (view.filters.length) params.set("filters", JSON.stringify(view.filters));
  return `?${params}`;
}

/** Pure counterpart of reading `location.search`, so it is testable. */
export function parseUrl(search: string): View | null {
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

/** What the state of a browser history entry looks like, namespaced. */
interface BrowserState {
  gtfsView: View & { depth: number };
  feed: string;
}

/** The back stack of an application that owns its page. */
export function browserHistory(): HistoryPort {
  const toState = (entry: HistoryEntry): BrowserState => ({
    gtfsView: { ...entry.view, depth: entry.depth },
    feed: entry.feed,
  });

  return {
    push: (entry) => history.pushState(toState(entry), "", urlFor(entry.view)),
    replace: (entry) => history.replaceState(toState(entry), "", urlFor(entry.view)),
    back: () => history.back(),
    onPop(handler) {
      const listener = (event: PopStateEvent) => {
        const state = event.state as BrowserState | null;
        if (!state?.gtfsView) return handler(null);
        const { depth, ...view } = state.gtfsView;
        handler({ view, depth: depth ?? 0, feed: state.feed });
      };
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    initialView: () => parseUrl(location.search),
  };
}

/**
 * A back stack the viewer keeps to itself, for an embedded one.
 *
 * Nothing here touches the URL or `window`, so the host keeps control of its
 * own address bar, and can still mirror the view there by listening for view
 * changes.
 */
export function memoryHistory(initial: View | null = null): HistoryPort {
  const stack: HistoryEntry[] = [];
  let handler: (entry: HistoryEntry | null) => void = () => {};

  return {
    push: (entry) => void stack.push(entry),
    replace(entry) {
      stack.length = 0;
      stack.push(entry);
    },
    back() {
      if (stack.length <= 1) return;
      stack.pop();
      handler(stack[stack.length - 1]);
    },
    onPop(next) {
      handler = next;
      return () => {
        handler = () => {};
      };
    },
    initialView: () => initial,
  };
}
