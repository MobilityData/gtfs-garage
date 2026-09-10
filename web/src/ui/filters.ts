/** The filter bar: active filter chips, and the form that adds a new one. */

import { el } from "../dom";
import type { Filter, FilterOperator, GtfsSource } from "../sources/types";
import type { AppState } from "../state";

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "=",
  ne: "!=",
  contains: "contains",
  in: "in",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

const VALUELESS_OPERATORS: FilterOperator[] = ["is_empty", "is_not_empty"];

export class FilterBar {
  constructor(
    private readonly state: AppState,
    private readonly source: GtfsSource,
    private readonly onChange: (filters: Filter[]) => void,
  ) {
    el("add-filter-btn").addEventListener("click", () => {
      el("add-filter-form").classList.add("open");
      void this.updateValueInput();
    });
    el("filter-cancel-btn").addEventListener("click", () =>
      el("add-filter-form").classList.remove("open"),
    );
    el("filter-column").addEventListener("change", () => void this.updateValueInput());
    el("filter-op").addEventListener("change", () => void this.updateValueInput());
    el("filter-apply-btn").addEventListener("click", () => this.apply());
  }

  render(): void {
    const bar = el("filter-bar");
    bar.querySelectorAll(".chip").forEach((chip) => chip.remove());

    this.state.view.filters.forEach((filter, index) => {
      const chip = document.createElement("span");
      chip.className = "chip";

      const shown = filter.value === "" || filter.value == null ? "(empty)" : filter.value;
      const needsValue = !VALUELESS_OPERATORS.includes(filter.op);

      const label = document.createElement("span");
      label.textContent = `${filter.column} ${OPERATOR_LABELS[filter.op]} ${needsValue ? shown : ""}`.trim();

      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.addEventListener("click", () =>
        this.onChange(this.state.view.filters.filter((_, i) => i !== index)),
      );

      chip.append(label, remove);
      bar.appendChild(chip);
    });

    el<HTMLSelectElement>("filter-column").innerHTML = Object.keys(this.state.columnInfoByName)
      .map((column) => `<option value="${column}">${column}</option>`)
      .join("");
  }

  /**
   * Enumerated columns get a picklist of the values actually present, with
   * counts, so nobody has to guess what a feed uses.
   */
  private async updateValueInput(): Promise<void> {
    const column = el<HTMLSelectElement>("filter-column").value;
    const op = el<HTMLSelectElement>("filter-op").value as FilterOperator;
    const textInput = el<HTMLInputElement>("filter-value");
    const picker = el<HTMLSelectElement>("filter-value-picker");

    if (VALUELESS_OPERATORS.includes(op)) {
      textInput.style.display = "none";
      picker.style.display = "none";
      return;
    }

    const info = this.state.columnInfoByName[column];
    const usePicker = info?.enum_like && op !== "contains" && op !== "in";

    if (!usePicker) {
      textInput.style.display = "inline-block";
      picker.style.display = "none";
      return;
    }

    textInput.style.display = "none";
    picker.style.display = "inline-block";
    picker.innerHTML = "<option value=''>Loading...</option>";

    const values = await this.source.distinct(this.state.view.table, column, 100);
    picker.innerHTML = values
      .map(({ value, count }) => {
        const label = value === "" || value === null ? "(empty)" : value;
        return `<option value="${value ?? ""}">${label} (${count})</option>`;
      })
      .join("");
  }

  private apply(): void {
    const column = el<HTMLSelectElement>("filter-column").value;
    if (!column) return;

    const op = el<HTMLSelectElement>("filter-op").value as FilterOperator;
    const picker = el<HTMLSelectElement>("filter-value-picker");
    const textInput = el<HTMLInputElement>("filter-value");
    const value = picker.style.display !== "none" ? picker.value : textInput.value;

    el("add-filter-form").classList.remove("open");
    textInput.value = "";

    this.onChange([...this.state.view.filters, { column, op, value }]);
  }
}
