/**
 * The tour editor's working copy of a guide, and what it can say about one.
 *
 * Pure: no document, no map, no store. The form edits a `Guide` in place and
 * leaves blanks where a reader cleared a field; `cleanGuide` is what is
 * checked, run and saved, so a field left empty is the same as one left out.
 */

import type { TableInfo } from "../../sources/types";
import { fallbackGuide, tableOf, type Action, type ActionSpec, type Guide, type Locator, type NoticeDescription, type Step } from "../catalog";
import { isLocated } from "../locate";
import { fill, fillValue, UnfilledPlaceholder, type Sample } from "../template";
import { resolveWalkthrough } from "../walkthrough";

export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.every(isBlank);
  if (typeof value === "object") return Object.values(value as object).every(isBlank);
  return false;
}

/** A value with its blank parts left out: empty strings, empty lists, lists of blanks. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isBlank(item)).map(prune);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => !isBlank(item))
        .map(([key, item]) => [key, prune(item)]),
    );
  }
  return value;
}

/**
 * The guide as it would be saved: blank fields and arguments left out, keys in
 * the order the guides in the repository use.
 *
 * A step keeps its `text` even when empty, so the check can say it needs one,
 * and an action keeps its `kind`.
 */
export function cleanGuide(guide: Guide): Guide {
  const locators = Object.fromEntries(
    Object.entries(guide.locators ?? {})
      .filter(([name]) => name.trim())
      .map(([name, locator]) => [name.trim(), prune(locator) as Locator]),
  );
  const steps = (guide.steps ?? []).map((step) => {
    const cleaned: Step = { text: step.text ?? "" };
    if (step.point) cleaned.point = step.point;
    if (step.clear?.length) cleaned.clear = [...step.clear];
    const actions = (step.actions ?? []).map(({ kind, ...args }) => ({ kind, ...(prune(args) as Record<string, unknown>) }) as Action);
    if (actions.length) cleaned.actions = actions;
    return cleaned;
  });
  const fix = (guide.fix ?? []).filter((line) => typeof line !== "string" || line.trim());
  return {
    code: guide.code,
    ...(Object.keys(locators).length ? { locators } : {}),
    steps,
    ...(fix.length ? { fix } : {}),
  };
}

/** Two guides that would be saved the same. */
export function sameGuide(a: Guide | null | undefined, b: Guide | null | undefined): boolean {
  return JSON.stringify(a ? cleanGuide(a) : null) === JSON.stringify(b ? cleanGuide(b) : null);
}

/** Where an analyst starts a tour for a notice with none: the walkthrough derived from its fields. */
export function starterGuide(code: string, notice: NoticeDescription | undefined, sample: Sample): Guide {
  return copy(fallbackGuide(code, notice, sample));
}

export function blankGuide(code: string): Guide {
  return { code, steps: [{ text: "" }] };
}

/**
 * The sample fields an argument most likely wants, by its name: a trip is the
 * notice's `tripId`, `from` and `to` its first and second stop.
 */
const SUGGESTED: Record<string, RegExp[]> = {
  trip: [/^tripId$/, /^tripId1$/],
  route: [/^routeId$/, /^routeId1$/],
  from: [/^stopId1$/, /^fromStopId$/, /^stopId$/],
  to: [/^stopId2$/, /^toStopId$/],
  date: [/^date$/, /[Dd]ate$/],
  routes: [/^routeId\d?$/],
  shapes: [/^shapeId\d?$/],
  stops: [/^stopId\d?$/, /^(from|to)StopId$/],
  mark: [/^stopId\d?$/],
};

function suggested(name: string, fields: string[]): string[] {
  for (const pattern of SUGGESTED[name] ?? []) {
    const found = fields.filter((field) => pattern.test(field));
    if (found.length) return found.map((field) => `{{${field}}}`);
  }
  return [];
}

/**
 * A new action of `kind`, with every argument it takes present, and those the
 * notice's fields make obvious already filled: Play a trip on a notice with a
 * `tripId` plays that trip. Its required rows are `locators`, in order.
 */
export function newAction(kind: string, spec: ActionSpec, locators: string[], fields: string[] = []): Action {
  const action: Action = { kind };
  const rows = [...locators];
  for (const [name, arg] of Object.entries(spec.args)) {
    const guess = suggested(name, fields);
    if (arg.type === "locator") action[name] = arg.required ? (rows.shift() ?? "") : undefined;
    else if (arg.type === "text_list") action[name] = guess;
    else if (arg.type === "columns" || arg.type === "point_list") action[name] = [];
    else if (arg.type === "text") action[name] = guess[0] ?? "";
    else if (arg.type === "endpoint") {
      const stop = suggested(name, fields)[0];
      if (arg.required || stop) action[name] = { stop: stop ?? "" };
    }
  }
  return action;
}

/** A name for a new locator that the guide does not use yet. */
export function freshName(taken: string[], base = "rows"): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.includes(`${base}${i}`)) return `${base}${i}`;
}

/**
 * The guide without the rows no action uses any more.
 *
 * In the form, rows live inside the actions that open them; removing the
 * action removes them, and nothing else would show them to remove.
 */
export function dropUnusedLocators(guide: Guide, specs: Record<string, ActionSpec>): Guide {
  const used = new Set<string>();
  for (const step of guide.steps) {
    for (const action of step.actions ?? []) {
      for (const [name, arg] of Object.entries(specs[action.kind]?.args ?? {})) {
        if (arg.type === "locator" && typeof action[name] === "string") used.add(action[name] as string);
      }
    }
  }
  const locators = Object.fromEntries(Object.entries(guide.locators ?? {}).filter(([name]) => used.has(name)));
  const { code, steps, fix } = guide;
  return { code, ...(Object.keys(locators).length ? { locators } : {}), steps, ...(fix ? { fix } : {}) };
}

export function move<T>(list: T[], index: number, by: number): void {
  const to = index + by;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
}

/** The table a locator's file names in this sample, if the feed has it. */
export function tableFor(locator: Locator | undefined, sample: Sample, tables: TableInfo[]): TableInfo | undefined {
  if (!locator?.file) return undefined;
  let file: string;
  try {
    file = String(fillValue(locator.file, sample) ?? "");
  } catch {
    return undefined;
  }
  return tables.find((table) => table.name === tableOf(file));
}

/** The fields a sample offers, as the validator names them, with this sample's value of each. */
export function sampleFields(notice: NoticeDescription | undefined, sample: Sample): { field: string; value: string; type: string | null }[] {
  const names = Object.keys(notice?.fields ?? {});
  return names.map((field) => {
    const value = sample[field];
    return {
      field,
      value: value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value),
      type: notice?.fields[field]?.type ?? null,
    };
  });
}

/** A sentence filled from the sample, or why it cannot be. */
export function preview(text: string, sample: Sample): { text: string } | { missing: string } {
  try {
    return { text: fill(text, sample) };
  } catch (error) {
    if (error instanceof UnfilledPlaceholder) return { missing: error.field };
    throw error;
  }
}

/** What one step loses on this sample, in the words the editor shows beside it. */
export interface StepCheck {
  /** The step is left out of the walkthrough: its sentence needs a field the sample lacks. */
  dropped: string | null;
  notes: string[];
  /** Its index among the steps the walkthrough runs, when it is not dropped. */
  runs: number | null;
}

/**
 * Each step of `guide` tried on one sample: whether it runs, and what of it
 * does not. The same resolver the assistant uses, one step at a time.
 */
export function checkSteps(guide: Guide, sample: Sample, tables: TableInfo[]): StepCheck[] {
  let runs = 0;
  return guide.steps.map((step) => {
    const filled = preview(step.text ?? "", sample);
    if ("missing" in filled) return { dropped: `This sample has no ${filled.missing}, so the step is left out.`, notes: [], runs: null };
    const resolved = resolveWalkthrough({ ...guide, steps: [step], fix: [] }, true, sample, tables).steps[0];
    const notes = resolved.skipped.map(
      (skipped) => `"${skipped.kind.replace(/_/g, " ")}" is left out: this sample has no ${skipped.field}.`,
    );
    for (const action of resolved.actions) {
      for (const located of Object.values(action.located)) if (!isLocated(located)) notes.push(located.problem);
    }
    return { dropped: null, notes, runs: runs++ };
  });
}
