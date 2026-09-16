import type { Dom } from "../dom";
import type { AppState } from "../state";
import type { MissingFile, TableInfo } from "../sources/types";

/**
 * Why a file the feed lacks is wanted.
 *
 * A required file needs no explanation. A conditionally required one does: the
 * condition, and what makes it apply to this feed, because "calendar.txt is
 * missing" is not actionable while "required unless calendar_dates.txt defines
 * every service date - calendar_dates is absent" is.
 */
export function describeMissing(file: MissingFile): string {
  if (file.presence !== "conditional") return "Required. This feed does not have it.";
  const condition = file.condition ?? "Conditionally required.";
  const because = file.condition_outcome ? ` Required here: ${file.condition_outcome.evidence}.` : "";
  return `${condition}${because}`;
}

/**
 * Why GTFS says this feed should not have this file.
 *
 * The other direction from `describeMissing`. Empty for the ordinary case, so
 * a caller can use the result as the test of whether to say anything.
 */
export function describeForbidden(table: TableInfo): string {
  const forbidden = table.forbidden;
  if (!forbidden) return "";
  return `${forbidden.condition} Forbidden here: ${forbidden.outcome.evidence}.`;
}

/** The list of the feed's files, with row counts, and any it is missing. */
export function renderSidebar(
  dom: Dom,
  state: AppState,
  onSelect: (table: string) => void,
): void {
  const sidebar = dom.el("sidebar");
  sidebar.innerHTML = "";

  for (const table of state.tables) {
    const row = document.createElement("div");
    row.className = "table-tab" + (table.name === state.view.table ? " active" : "");

    const name = document.createElement("span");
    name.textContent = table.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = table.row_count.toLocaleString();

    // Still clickable: the rows are there and worth reading. The marker says
    // GTFS did not want the file, not that it cannot be opened.
    const why = describeForbidden(table);
    if (why) {
      row.classList.add("forbidden");
      row.title = why;
      count.textContent = "forbidden";
    }

    row.append(name, count);
    row.addEventListener("click", () => onSelect(table.name));
    sidebar.appendChild(row);
  }

  // After the files the feed has, because they are the ones a reader came to
  // browse. Not clickable: there is nothing behind them to open.
  for (const file of state.missing) {
    const row = document.createElement("div");
    row.className = "table-tab missing";
    row.title = describeMissing(file);
    row.dataset.el = "missing-file";

    const name = document.createElement("span");
    name.textContent = file.name;
    const mark = document.createElement("span");
    mark.className = "count";
    mark.textContent = "missing";

    row.append(name, mark);
    sidebar.appendChild(row);
  }
}
