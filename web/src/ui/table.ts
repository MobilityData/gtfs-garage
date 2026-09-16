/**
 * The row grid: the part that makes IDs navigable.
 *
 * A foreign-key column renders as a link to the referenced table, filtered to
 * the matching row. A table's own id column additionally offers "related"
 * buttons for the reverse direction (a route to its trips, say). The server
 * only reports links whose target exists in the loaded feed, so nothing here
 * leads to a file the feed does not contain.
 */

import { button, type Dom } from "../dom";
import type { ColumnInfo, Filter, PageResponse, RelatedLink, Row } from "../sources/types";
import { describeColumn, renderValue } from "./values";
import type { AppState } from "../state";

export interface RelatedButton {
  link: RelatedLink;
  label: string;
  title: string;
}

/**
 * How to label the reverse links under an id.
 *
 * A table can point at the same id from more than one column - `transfers` and
 * `pathways` each reference a stop as both `from_stop_id` and `to_stop_id` - so
 * labelling by table name alone renders two buttons that look identical and go
 * to different places. The column is added only where a table appears more than
 * once, which keeps the common label short, and the tooltip always names it.
 */
export function describeRelated(related: RelatedLink[]): RelatedButton[] {
  const perTable = new Map<string, number>();
  for (const link of related) perTable.set(link.table, (perTable.get(link.table) ?? 0) + 1);

  return related.map((link) => ({
    link,
    label: (perTable.get(link.table) ?? 0) > 1 ? `▸ ${link.table} ${link.column}` : `▸ ${link.table}`,
    title: `Rows in ${link.table} whose ${link.column} is this`,
  }));
}

export interface TableCallbacks {
  onNavigate: (table: string, filters: Filter[]) => void;
  onPage: (page: number) => void;
  onHighlightStop: (stopId: string) => void;
  onHighlightShape: (shapeId: string) => void;
  onHighlightRoute: (routeId: string) => void;
  onHighlightLocation: (locationId: string) => void;
}

export class TableView {
  /**
   * The page currently on screen, so that a display change can redraw without
   * asking the server again - on a large feed a refetch to toggle formatting
   * would be a needless round trip over millions of rows.
   */
  private lastPage: PageResponse | null = null;

  constructor(
    private readonly dom: Dom,
    private readonly state: AppState,
    private readonly callbacks: TableCallbacks,
  ) {
    this.dom.el<HTMLButtonElement>("prev-page").addEventListener("click", () => {
      if (this.state.view.page > 1) this.callbacks.onPage(this.state.view.page - 1);
    });
    this.dom.el<HTMLButtonElement>("next-page").addEventListener("click", () =>
      this.callbacks.onPage(this.state.view.page + 1),
    );
  }

  /** Draw the current page again, picking up a changed display preference. */
  redraw(): void {
    if (this.lastPage) this.render(this.lastPage);
  }

  showMessage(text: string): void {
    this.lastPage = null;
    const container = this.dom.el("table-scroll");
    container.innerHTML = "";
    const message = document.createElement("div");
    message.dataset.el = "empty-state";
    message.textContent = text;
    container.appendChild(message);
    this.dom.el("pager").style.display = "none";
  }

  render(page: PageResponse): void {
    this.lastPage = page;
    const table = document.createElement("table");

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th"));
    for (const column of page.columns) {
      const cell = document.createElement("th");
      cell.textContent = column;
      // What the schema knows that the column name does not show: the field
      // type, and why it may be required.
      const description = describeColumn(this.state.columnInfoByName[column]);
      if (description) cell.title = description;
      headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    for (const row of page.rows) {
      body.appendChild(this.buildRow(page.columns, row));
    }
    table.appendChild(body);

    const container = this.dom.el("table-scroll");
    container.innerHTML = "";
    container.appendChild(table);

    this.renderPager(page);
  }

  private buildRow(columns: string[], row: Row): HTMLTableRowElement {
    const tr = document.createElement("tr");
    const values: Record<string, string | null> = {};
    columns.forEach((column, index) => (values[column] = row[index]));

    const actions = document.createElement("td");
    actions.appendChild(this.buildRowActions(values));
    tr.appendChild(actions);

    columns.forEach((column, index) => {
      tr.appendChild(this.buildCell(column, row[index]));
    });
    return tr;
  }

  private buildCell(column: string, value: string | null): HTMLTableCellElement {
    const cell = document.createElement("td");
    const info = this.state.columnInfoByName[column];

    if (info?.fk_table && value) {
      const link = document.createElement("a");
      link.href = "#";
      link.className = "fk-link";
      link.textContent = value;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        this.callbacks.onNavigate(info.fk_table as string, [
          { column: info.fk_column as string, op: "eq", value },
        ]);
      });
      cell.appendChild(link);
    } else {
      this.renderValue(cell, value, info);
    }

    if (info?.related.length && value) {
      const related = document.createElement("div");
      related.className = "related-row";
      for (const { link, label, title } of describeRelated(info.related)) {
        const btn = button(label, title, () =>
          this.callbacks.onNavigate(link.table, [{ column: link.column, op: "eq", value }]),
        );
        btn.className = "related-btn";
        related.appendChild(btn);
      }
      cell.appendChild(related);
    }

    return cell;
  }

  /**
   * Draw what `renderValue` decided.
   *
   * Every path here writes through `textContent`, never `innerHTML`, so a feed
   * cannot inject markup - and an `href` is only ever set from a URL that
   * module already restricted to http, https and mailto.
   */
  private renderValue(cell: HTMLElement, value: string | null, info: ColumnInfo | undefined): void {
    const rendered = renderValue(value, info, this.state.rawValues);

    if (rendered.kind === "link" && rendered.href) {
      const link = document.createElement("a");
      link.href = rendered.href;
      link.textContent = rendered.text;
      link.className = "value-link";
      // A feed's link is someone else's site; do not hand it this page.
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      cell.appendChild(link);
      return;
    }

    if (rendered.kind === "color" && rendered.swatch) {
      const swatch = document.createElement("span");
      swatch.className = "value-swatch";
      swatch.style.backgroundColor = rendered.swatch;
      cell.append(swatch, document.createTextNode(rendered.text));
      return;
    }

    if (rendered.implied) {
      // Muted, because it is not what the producer wrote. An inspection tool
      // that let an implied value pass for a real one would be worse than one
      // that showed nothing.
      cell.classList.add("value-implied");
      cell.title = rendered.implied;
    }
    if (rendered.kind === "numeric") cell.classList.add("value-numeric");
    if (rendered.malformed) {
      // Shown exactly as the feed has it, with what was expected on hover. The
      // class is a hook for a visible marker, deliberately unstyled for now.
      cell.classList.add("value-malformed");
      cell.title = `Expected ${rendered.malformed}`;
    }
    cell.textContent = rendered.text;
  }

  private buildRowActions(values: Record<string, string | null>): HTMLElement {
    const wrap = document.createElement("span");
    const add = (label: string, title: string, onClick: () => void) => {
      const btn = button(label, title, onClick);
      btn.className = "map-btn";
      wrap.appendChild(btn);
    };

    if (values.stop_id) {
      const stopId = values.stop_id;
      add("📍", "Show this stop on the map", () => this.callbacks.onHighlightStop(stopId));
    }
    if (values.shape_id) {
      const shapeId = values.shape_id;
      add("🧭", "Show this shape on the map", () => this.callbacks.onHighlightShape(shapeId));
    }
    if (values.route_id && this.state.routeShapes.size) {
      const routeId = values.route_id;
      add("🚌", "Show this route on the map", () => this.callbacks.onHighlightRoute(routeId));
    }
    // Keyed on the table rather than the column: "id" is too generic a name to
    // treat as a zone wherever it appears.
    if (values.id && this.state.view.table === "locations") {
      const locationId = values.id;
      add("🗺️", "Show this zone on the map", () => this.callbacks.onHighlightLocation(locationId));
    }
    return wrap;
  }

  private renderPager(page: PageResponse): void {
    this.dom.el("pager").style.display = "flex";
    const totalPages = Math.max(1, Math.ceil(page.total / page.page_size));
    this.dom.el("page-info").textContent = `Page ${page.page} / ${totalPages}`;
    this.dom.el("row-count").textContent = `${page.total.toLocaleString()} rows`;
    this.dom.el<HTMLButtonElement>("prev-page").disabled = page.page <= 1;
    this.dom.el<HTMLButtonElement>("next-page").disabled = page.page >= totalPages;
  }
}
