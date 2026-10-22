import type {
  CalendarDay,
  ColumnInfo,
  Filter,
  MissingFile,
  ServicePattern,
  TableInfo,
} from "./sources/types";
import type { Screen } from "./ui/screens";

/**
 * Which step of which walkthrough a view belongs to.
 *
 * Part of the view, so each step is a history entry: Back steps back through a
 * walkthrough, and a link reopens the step it was copied from.
 */
export interface Assist {
  /** The notice code. */
  code: string;
  /** Which of the report's samples for that code, from 0. */
  sample: number;
  /** Which step, from 0. */
  step: number;
}

/** One browsable view: a table, its filters and which page of it. */
export interface View {
  /** The GTFS file being browsed. Empty while a screen is showing. */
  table: string;
  filters: Filter[];
  page: number;
  /**
   * A screen's id, or undefined for the file browser - which is the view this
   * tool started as, and still the only one that shows a feed exactly as it is
   * written. A plain string rather than a union of ours, because the screens
   * are a list a host can add to.
   */
  screen?: string;
  /** That screen's own parameter - a `route_id` for the route screen. */
  argument?: string;
  /**
   * Whatever else the screen is showing: the facets a route list is narrowed
   * by, say.
   *
   * In the view rather than in the screen, so a narrowed list is a shareable
   * link and Back undoes one filter at a time - and so it goes away when you
   * leave, which is what keeps a filter from quietly following you to a screen
   * that never mentioned it.
   */
  params?: Record<string, string>;
  /**
   * The service date every derived view reads, as `YYYY-MM-DD`.
   *
   * Part of the view rather than a preference: it changes what is on screen, so
   * it belongs in the back stack and in a shared link. Carried across
   * navigation, so picking a day once survives moving between screens.
   */
  date?: string;
  /** The walkthrough step this view is showing, when the Quality assistant opened it. */
  assist?: Assist;
}

/**
 * What the table should point at while a walkthrough step is showing it: the
 * rows are tinted and these columns outlined.
 */
export interface TableMarks {
  fields: string[];
  /** The rows to mark among those shown, by line; every row when neither this nor `key` is given. */
  lines?: number[];
  /** The rows to mark among those shown, by column values. */
  key?: { column: string; value: string }[];
}

/**
 * Which half of the tool is showing.
 *
 * Derived from the view rather than stored: a view with a screen is Explore, a
 * view with a table is Files. That keeps every existing link working, since
 * the mode is implied by what the link already says.
 */
export type Mode = "explore" | "files";

export function modeOf(view: View): Mode {
  return view.screen ? "explore" : "files";
}

export interface AppState {
  tables: TableInfo[];
  /**
   * The screens this source can answer, in sidebar order.
   *
   * Narrowed per feed from whatever `mount` was given, so a source that
   * implements only the table endpoints leaves this empty and the interface
   * shows the file browser alone rather than entries that lead nowhere.
   */
  screens: Screen[];
  /** Files GTFS says this feed needs and it does not have. */
  missing: MissingFile[];
  columnInfoByName: Record<string, ColumnInfo>;
  view: View;
  pageSize: number;
  /**
   * Which shape draws each route, so a row's route can be highlighted.
   *
   * Just the two ids, not the geometry: holding the whole routes collection to
   * answer one lookup cost hundreds of megabytes on a large feed, and the
   * shape is a cheap fetch when it is actually wanted.
   */
  routeShapes: Map<string, string>;
  mapDataLoaded: boolean;
  /**
   * Show the characters the feed contains instead of formatted values.
   *
   * A display preference, not part of the view: it is deliberately kept out of
   * `View` so that toggling it does not push a history entry, and out of the
   * URL so that Back still means the previous table rather than the previous
   * rendering.
   */
  rawValues: boolean;
  /**
   * Where the reader was in each mode, so switching returns them there rather
   * than resetting to the top of a list they had already moved on from.
   */
  lastView: Partial<Record<Mode, View>>;
  /** Every date the feed covers, in order - what the date control steps along. */
  days: CalendarDay[];
  /** Which half is showing. Derived from the view on every navigation. */
  mode: Mode;
  /** Date -> the name of the kind of day it is, for the chip's summary. */
  patterns: Map<string, string>;
  /** The kinds of day themselves, which the jump list offers one of each. */
  jumpPatterns: ServicePattern[];
  /**
   * Show the line of the file each row was read from. A display preference
   * like `rawValues`, and turned on for the length of a walkthrough, whose
   * steps are written in line numbers.
   */
  showLines: boolean;
  /** What a walkthrough step wants the table to point at, or null. */
  marks: TableMarks | null;
}

export function createState(): AppState {
  return {
    tables: [],
    screens: [],
    missing: [],
    columnInfoByName: {},
    view: { table: "", filters: [], page: 1 },
    pageSize: 100,
    routeShapes: new Map(),
    mapDataLoaded: false,
    rawValues: false,
    lastView: {},
    days: [],
    mode: "files",
    patterns: new Map(),
    jumpPatterns: [],
    showLines: false,
    marks: null,
  };
}

export function tableInfo(state: AppState, name: string): TableInfo | undefined {
  return state.tables.find((t) => t.name === name);
}
