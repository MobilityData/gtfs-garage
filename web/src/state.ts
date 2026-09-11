import type { ColumnInfo, Filter, TableInfo } from "./sources/types";

/** One browsable view: a table, its filters and which page of it. */
export interface View {
  table: string;
  filters: Filter[];
  page: number;
}

export interface AppState {
  tables: TableInfo[];
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
}

export function createState(): AppState {
  return {
    tables: [],
    columnInfoByName: {},
    view: { table: "", filters: [], page: 1 },
    pageSize: 100,
    routeShapes: new Map(),
    mapDataLoaded: false,
  };
}

export function tableInfo(state: AppState, name: string): TableInfo | undefined {
  return state.tables.find((t) => t.name === name);
}
