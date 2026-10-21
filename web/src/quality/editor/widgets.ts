/**
 * The tour editor's form fields.
 *
 * Each edits one value of the working guide in place and calls `changed`, which
 * re-checks the guide and refreshes previews without rebuilding the form, so
 * typing never loses focus. A change of shape - a row added or removed - calls
 * `rebuild` instead.
 *
 * A template field offers the notice's fields to insert, each with this
 * sample's value, so an analyst picks `{{stopId}}` rather than typing it, and
 * sees under the field what the reader will see.
 */

import type { ArgumentSpec } from "../catalog";
import type { ProblemPath } from "../validate";
import { node, prose } from "../../ui/html";
import type { Sample } from "../template";
import { preview } from "./model";

export interface FieldInfo {
  field: string;
  value: string;
  type: string | null;
}

export interface FormContext {
  sample(): Sample;
  fields(): FieldInfo[];
  /** A value changed: check again and refresh previews. */
  changed(): void;
  /** The form's shape changed: draw it again. */
  rebuild(): void;
  /** Run on every `changed`, to keep previews current. */
  refresh(run: () => void): void;
  /** Where the problems found at `path`, or under it, are shown. */
  slot(path: ProblemPath): HTMLElement;
}

let ids = 0;
export function uid(prefix: string): string {
  ids += 1;
  return `${prefix}-${ids}`;
}

export function button(label: string, title: string, run: () => void, className?: string): HTMLButtonElement {
  const element = node("button", { type: "button", class: className, title, text: label });
  element.addEventListener("click", (event) => {
    event.preventDefault();
    run();
  });
  return element;
}

/** An icon-sized button: move, duplicate, remove. */
export function tool(label: string, title: string, run: () => void, disabled = false): HTMLButtonElement {
  const element = button(label, title, run, "editor-tool");
  element.setAttribute("aria-label", title);
  element.disabled = disabled;
  return element;
}

export function labelled(label: string, control: HTMLElement, hint?: string, required = false): HTMLElement {
  const id = control.id || uid("field");
  const target = control.matches("input, select, textarea") ? control : control.querySelector("input, select, textarea");
  if (target && !target.id) target.id = id;
  return node("div", { class: "editor-field" }, [
    node("label", { class: "editor-label", for: target?.id ?? id }, [label, required ? node("span", { class: "editor-required", text: " *", title: "Required" }) : null]),
    control,
    hint ? node("div", { class: "editor-hint", text: hint }) : null,
  ]);
}

const NUMERIC = new Set(["number", "double", "float", "integer", "long"]);

/** Formatted forms worth offering for a field, by its type and name. */
function formatted(field: FieldInfo): { token: string; label: string }[] {
  const out: { token: string; label: string }[] = [];
  if (field.type && NUMERIC.has(field.type) && /distance|Distance|Km|km|Meters|meters|Speed|speed|Kph/.test(field.field)) {
    if (/Speed|speed|Kph/.test(field.field)) out.push({ token: `{{${field.field}|kmh}}`, label: `${field.field} as km/h` });
    else out.push({ token: `{{${field.field}|m}}`, label: `${field.field} in metres` }, { token: `{{${field.field}|km}}`, label: `${field.field} in km` });
  }
  if (/date|Date/.test(field.field) && /^\d{8}$/.test(field.value)) out.push({ token: `{{${field.field}|date}}`, label: `${field.field} as a date` });
  return out;
}

/** A menu of the notice's fields; choosing one hands its placeholder to `pick`. */
export function fieldPicker(context: FormContext, pick: (token: string) => void, title = "Insert a field of the sample"): HTMLSelectElement {
  const select = node("select", { class: "editor-insert", title, "aria-label": title });
  const fill = () => {
    const fields = context.fields();
    const plain = fields.map((field) =>
      node("option", { value: `{{${field.field}}}`, text: field.value ? `${field.field}  =  ${field.value.slice(0, 40)}` : `${field.field}  (not in this sample)` }),
    );
    const extra = fields.flatMap(formatted).map((entry) => node("option", { value: entry.token, text: entry.label }));
    select.replaceChildren(node("option", { value: "", text: "+ field" }), node("optgroup", { label: "Fields of this notice" }, plain));
    if (extra.length) select.append(node("optgroup", { label: "Formatted" }, extra));
  };
  fill();
  select.addEventListener("focus", fill);
  select.addEventListener("change", () => {
    if (select.value) pick(select.value);
    select.value = "";
  });
  return select;
}

/**
 * A text with placeholders: a sentence, a value, a line number.
 *
 * With `showPreview`, the text as this sample fills it is shown underneath,
 * or which field the sample lacks.
 */
export function templateInput(
  context: FormContext,
  options: { value: string; onChange(value: string): void; multiline?: boolean; placeholder?: string; showPreview?: boolean; label?: string },
): HTMLElement {
  const input = options.multiline
    ? node("textarea", { class: "editor-input editor-text", rows: "2", placeholder: options.placeholder, "aria-label": options.label })
    : node("input", { class: "editor-input", type: "text", placeholder: options.placeholder, "aria-label": options.label });
  input.value = options.value ?? "";
  input.spellcheck = Boolean(options.multiline);
  const grow = () => {
    if (input instanceof HTMLTextAreaElement) {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight + 2}px`;
    }
  };
  input.addEventListener("input", () => {
    options.onChange(input.value);
    grow();
    context.changed();
  });
  requestAnimationFrame(grow);

  const picker = fieldPicker(context, (token) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + token + input.value.slice(end);
    input.focus();
    input.setSelectionRange(start + token.length, start + token.length);
    input.dispatchEvent(new Event("input"));
  });

  const shown = options.showPreview ? node("div", { class: "editor-preview" }) : null;
  if (shown) {
    context.refresh(() => {
      const text = input.value;
      if (!text.trim()) {
        shown.textContent = "";
        shown.className = "editor-preview";
        return;
      }
      const result = preview(text, context.sample());
      shown.className = "missing" in result ? "editor-preview editor-preview-missing" : "editor-preview";
      shown.replaceChildren(...("missing" in result ? [`This sample has no ${result.missing}.`] : prose(result.text)));
      shown.title = "As the reader sees it, for this sample";
    });
  }
  return node("div", { class: "editor-template" }, [node("div", { class: "editor-template-row" }, [input, picker]), shown]);
}

/** Several values, one per line, each with fields to insert. */
export function listInput(context: FormContext, values: string[], options: { placeholder?: string; add?: string } = {}): HTMLElement {
  const rows = values.map((value, index) =>
    node("div", { class: "editor-list-row" }, [
      templateInput(context, { value, placeholder: options.placeholder, onChange: (next) => (values[index] = next) }),
      tool("×", "Remove", () => {
        values.splice(index, 1);
        context.rebuild();
      }),
    ]),
  );
  return node("div", { class: "editor-list" }, [
    ...rows,
    button(options.add ?? "+ Add", "Add another", () => {
      values.push("");
      context.rebuild();
    }, "editor-add"),
  ]);
}

/** A choice among `options`, as [value, label]. */
export function choice(value: string, options: [string, string][], onChange: (value: string) => void, context: FormContext, label?: string): HTMLSelectElement {
  const select = node("select", { class: "editor-input", "aria-label": label }, options.map(([v, text]) => node("option", { value: v, text })));
  select.value = value;
  if (select.value !== value && value) {
    // A value the list does not offer, from YAML written by hand: keep it rather than lose it.
    select.prepend(node("option", { value, text: `${value} (not offered here)` }));
    select.value = value;
  }
  select.addEventListener("change", () => {
    onChange(select.value);
    context.changed();
  });
  return select;
}

/** Columns of a file, as chips to switch on and off, plus fields of the sample for a column a notice names. */
export function columnsInput(context: FormContext, values: string[], columns: string[] | null): HTMLElement {
  if (!columns) return listInput(context, values, { placeholder: "column name", add: "+ Column" });
  const chips = columns.map((column) => {
    const chip = button(column, `Outline ${column}`, () => {
      const at = values.indexOf(column);
      if (at >= 0) values.splice(at, 1);
      else values.push(column);
      chip.classList.toggle("active", values.includes(column));
      chip.setAttribute("aria-pressed", String(values.includes(column)));
      context.changed();
    }, `chip editor-chip${values.includes(column) ? " active" : ""}`);
    chip.setAttribute("aria-pressed", String(values.includes(column)));
    return chip;
  });
  // Placeholders, and names this file does not have, stay listed and removable.
  const others = values
    .filter((value) => !columns.includes(value))
    .map((value) =>
      node("span", { class: "chip editor-chip active" }, [
        value,
        tool("×", `Remove ${value}`, () => {
          values.splice(values.indexOf(value), 1);
          context.rebuild();
        }),
      ]),
    );
  const picker = fieldPicker(context, (token) => {
    values.push(token);
    context.rebuild();
  }, "Add the column a field of the sample names");
  return node("div", { class: "editor-chips" }, [...chips, ...others, picker]);
}

export function numberInput(value: unknown, onChange: (value: number | undefined) => void, context: FormContext, spec: ArgumentSpec): HTMLInputElement {
  const input = node("input", { class: "editor-input editor-number", type: "number", step: spec.type === "integer" ? "1" : "any", min: spec.min?.toString() });
  input.value = value === undefined || value === null ? "" : String(value);
  input.addEventListener("input", () => {
    onChange(input.value === "" ? undefined : Number(input.value));
    context.changed();
  });
  return input;
}

export function checkbox(value: boolean, label: string, onChange: (value: boolean) => void, context: FormContext): HTMLElement {
  const input = node("input", { type: "checkbox" });
  input.checked = value;
  input.addEventListener("change", () => {
    onChange(input.checked);
    context.changed();
  });
  return node("label", { class: "editor-check" }, [input, label]);
}

/** Free-form JSON, for a host action's arguments. */
export function jsonInput(value: unknown, onChange: (value: unknown) => void, context: FormContext): HTMLElement {
  const input = node("textarea", { class: "editor-input editor-code", rows: "3", spellcheck: "false" });
  input.value = value === undefined ? "" : JSON.stringify(value, null, 2);
  const error = node("div", { class: "editor-problem" });
  input.addEventListener("input", () => {
    try {
      onChange(input.value.trim() ? JSON.parse(input.value) : undefined);
      error.textContent = "";
    } catch {
      error.textContent = "Not JSON yet.";
    }
    context.changed();
  });
  return node("div", {}, [input, error]);
}
