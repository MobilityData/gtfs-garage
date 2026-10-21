/**
 * What a screen is.
 *
 * A screen is one derived view of a feed: the overview, the calendar, a route.
 * They are a list rather than a fixed set so a host can add one of its own,
 * replace one of ours, reorder them or drop them entirely - and so the viewer
 * itself has no privileged access its consumers lack. The three built-ins are
 * ordinary members of `defaultScreens`.
 *
 * The split is deliberate: `fetch` gets the data and `render` draws it, so a
 * renderer is a pure function of its payload and testable with a fixture and no
 * network. `available` is what keeps a screen off the sidebar when the source
 * cannot answer it, which is how a source implementing only the table endpoints
 * shows the file browser alone rather than entries that lead to an error.
 */

import type { Filter, ViewerSource } from "../../sources/types";
import type { QualityContext } from "./quality";

/**
 * What a focus put on the map.
 *
 * Lines and points separately, because the difference is what a screen can
 * honestly say: a route with no shapes but with stops is not "nothing to
 * draw", and one total could not tell the two apart.
 *
 * Declared here rather than imported from the map module, which a screen never
 * reaches: a host supplies `focusRoutes` itself, and should not have to install
 * MapLibre to name what it returns.
 */
export interface FocusResult {
  lines: number;
  points: number;
}

export interface ScreenContext {
  /** Open a GTFS file in the raw browser, optionally filtered to some rows. */
  openTable(table: string, filters?: Filter[]): void;
  /**
   * Open another screen. `argument` is that screen's own parameter - a
   * `route_id` for the route screen - and ends up in the URL beside its id.
   */
  openScreen(id: string, argument?: string): void;
  /**
   * The source, for a screen that fetches again in response to a click.
   *
   * `fetch` covers opening a screen; this covers what happens inside it - the
   * calendar asking which routes run on the day someone just picked.
   */
  source: ViewerSource;
  /**
   * The service date every derived view reads, or null when the feed states
   * none. A screen that shows "what runs" reads this rather than asking for a
   * day of its own - the reader picked one already, in the toolbar.
   */
  date: string | null;
  /** Look at the same place on a different day. */
  setDate(date: string): void;
  /**
   * Whatever else this screen is showing - the facets a route list is narrowed
   * by - and how to change it.
   *
   * They live in the view, so a narrowed list is a shareable link and Back
   * undoes one filter at a time; and they are dropped when a screen is left,
   * so a filter never quietly follows a reader to a screen that never
   * mentioned it.
   */
  params: Record<string, string>;
  setParams(params: Record<string, string>): void;
  /**
   * Draw only these routes on the map, or pass null for the whole network.
   *
   * Filters the layers already drawn rather than fetching, so it is usable on
   * a feed whose geometry took half a minute to arrive. Absent when there is
   * no map pane, and when the source cannot build GeoJSON - a screen must
   * offer no map action rather than one that does nothing.
   *
   * `shapeIds` adds that route's own shapes, which matters for a single route:
   * the layer holds one representative shape per route, so a route with a
   * shape per direction would otherwise show half of itself.
   *
   * `isolate: false` keeps the rest of the network drawn behind the focus
   * instead of hiding it. The focused routes stay picked out either way -
   * showing their surroundings is not the same as deselecting them, and
   * passing null for that would lose the thing the reader is looking at.
   *
   * `stopIds` narrows the stops layer to that route's stops and emphasises
   * them. Without it, isolating hides every stop - right for a day's worth of
   * routes, where every stop in the city is noise, and wrong for one route,
   * whose stops are the point of looking at it.
   *
   * Resolves to what was drawn. **Zero is a real answer** - a route whose
   * trips name no shape has no lines in the feed - and a screen that claims to
   * be showing something should check rather than leave a blank map behind a
   * confident sentence.
   *
   * The pane resets this before every render, so a screen that wants a focus
   * sets one and a screen that does not need do nothing.
   */
  focusRoutes?(
    routeIds: string[] | null,
    options?: {
      shapeIds?: string[];
      stopIds?: string[];
      isolate?: boolean;
      /**
       * What to frame the viewport on. `"stops"` for a caller that has
       * narrowed to part of a route - one trip of it - where framing on the
       * whole line would leave the map exactly where it was.
       */
      frame?: "focus" | "stops";
    },
  ): Promise<FocusResult>;

  /**
   * Centre the map on one stop and mark it.
   *
   * For a screen whose rows are stops: the map is the answer to "where is
   * this", and a row that only links into `stops.txt` makes a reader find it
   * themselves. Resolves `false` when the stop has no position in the feed,
   * which is ordinary and worth saying rather than leaving as a click that did
   * nothing.
   *
   * Absent for the same reasons as `focusRoutes`: no map, or a source that
   * answers tables and not geometry.
   */
  focusStop?(stopId: string): Promise<boolean>;

  /**
   * The validation report being read and the Quality assistant, for the
   * Quality screen. Supplied by `mount` for every viewer; a host's own screen
   * can use it too.
   */
  quality?: QualityContext;
}

export interface Screen<T = unknown> {
  /** Stable, URL-safe, and what `?view=` carries. */
  id: string;
  /**
   * The sidebar entry's text. A screen with no label is reachable only from
   * another screen - the route card is opened from the route list, and a
   * sidebar entry for "a route" with no route in mind would mean nothing.
   */
  label?: string;
  /** The sidebar entry's tooltip. Say what the screen answers. */
  title?: string;
  /**
   * Whether this source can answer this screen at all. Called once per feed.
   */
  available(source: ViewerSource): boolean;
  /**
   * Where the map goes while this screen is showing.
   *
   * `beside` is the default and today's arrangement. `above` gives the screen
   * the full width and the map a band across the top, which is what a grid of
   * trip columns needs. `none` hides the map for a screen with nothing to put
   * on it.
   */
  layout?: "beside" | "above" | "none";
  /** `argument` is the value from the URL, and `date` the day in the toolbar. */
  fetch(source: ViewerSource, argument?: string, date?: string | null): Promise<T>;
  render(data: T, context: ScreenContext): HTMLElement;
}

/** Narrowed to the screens this source can actually answer, in order. */
export function availableScreens(screens: Screen[], source: ViewerSource): Screen[] {
  return screens.filter((screen) => {
    try {
      return screen.available(source);
    } catch {
      // A host's own predicate throwing is its bug, not grounds for failing the
      // whole feed: the screen is simply not offered.
      return false;
    }
  });
}

/** The screens that appear in the sidebar: the ones with something to label. */
export function listedScreens(screens: Screen[]): Screen[] {
  return screens.filter((screen) => Boolean(screen.label));
}
