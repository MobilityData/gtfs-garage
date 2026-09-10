import { el } from "../dom";
import type { AppState } from "../state";

/** The list of the feed's files, with row counts. */
export function renderSidebar(state: AppState, onSelect: (table: string) => void): void {
  const sidebar = el("sidebar");
  sidebar.innerHTML = "";

  for (const table of state.tables) {
    const row = document.createElement("div");
    row.className = "table-tab" + (table.name === state.view.table ? " active" : "");

    const name = document.createElement("span");
    name.textContent = table.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = table.row_count.toLocaleString();

    row.append(name, count);
    row.addEventListener("click", () => onSelect(table.name));
    sidebar.appendChild(row);
  }
}
