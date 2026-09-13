/**
 * The row grid: the part that makes IDs navigable.
 *
 * A foreign-key column renders as a link to the referenced table, filtered to
 * the matching row. A table's own id column additionally offers "related"
 * buttons for the reverse direction (a route to its trips, say). The server
 * only reports links whose target exists in the loaded feed, so nothing here
 * leads to a file the feed does not contain.
 */

import { button, el } from "../dom";
import type { Filter, PageResponse, RelatedLink, Row } from "../sources/types";
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
}

export class TableView {
  constructor(
    private readonly state: AppState,
    private readonly callbacks: TableCallbacks,
  ) {
    el<HTMLButtonElement>("prev-page").addEventListener("click", () => {
      if (this.state.view.page > 1) this.callbacks.onPage(this.state.view.page - 1);
    });
    el<HTMLButtonElement>("next-page").addEventListener("click", () =>
      this.callbacks.onPage(this.state.view.page + 1),
    );
  }

  showMessage(text: string): void {
    const container = el("table-scroll");
    container.innerHTML = "";
    const message = document.createElement("div");
    message.id = "empty-state";
    message.textContent = text;
    container.appendChild(message);
    el("pager").style.display = "none";
  }

  render(page: PageResponse): void {
    const table = document.createElement("table");

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th"));
    for (const column of page.columns) {
      const cell = document.createElement("th");
      cell.textContent = column;
      headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    for (const row of page.rows) {
      body.appendChild(this.buildRow(page.columns, row));
    }
    table.appendChild(body);

    const container = el("table-scroll");
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
      cell.textContent = value ?? "";
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
    return wrap;
  }

  private renderPager(page: PageResponse): void {
    el("pager").style.display = "flex";
    const totalPages = Math.max(1, Math.ceil(page.total / page.page_size));
    el("page-info").textContent = `Page ${page.page} / ${totalPages}`;
    el("row-count").textContent = `${page.total.toLocaleString()} rows`;
    el<HTMLButtonElement>("prev-page").disabled = page.page <= 1;
    el<HTMLButtonElement>("next-page").disabled = page.page >= totalPages;
  }
}
