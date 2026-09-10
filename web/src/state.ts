import type { ColumnInfo, FeatureCollection, Filter, TableInfo } from "./sources/types";

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
  /** Kept so a row's route can be highlighted without refetching. */
  routesGeojson: FeatureCollection | null;
  mapDataLoaded: boolean;
}

export function createState(): AppState {
  return {
    tables: [],
    columnInfoByName: {},
    view: { table: "", filters: [], page: 1 },
    pageSize: 100,
    routesGeojson: null,
    mapDataLoaded: false,
  };
}

export function tableInfo(state: AppState, name: string): TableInfo | undefined {
  return state.tables.find((t) => t.name === name);
}
