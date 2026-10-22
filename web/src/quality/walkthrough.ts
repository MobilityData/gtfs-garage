/**
 * One walkthrough: a guide filled in from one sample, step by step.
 *
 * Resolved up front and kept pure, so what the assistant will do for a given
 * notice is testable without a document, a map or a server. Each step keeps its
 * sentence and the actions that illustrate it; each action keeps its filled
 * arguments, with any locator it names already turned into filters.
 *
 * Nothing here fails a walkthrough. An action whose fields the sample lacks is
 * dropped and noted, a step whose sentence cannot be filled is dropped, and a
 * locator that cannot be resolved stays in the action as the reason, which the
 * panel shows in place of the rows.
 */

import type { TableInfo } from "../sources/types";
import type { Action, Guide, Locator, NoticeDescription } from "./catalog";
import { locate, type Located, type Unlocatable } from "./locate";
import { firstSentence } from "./description";
import { fill, fillValue, UnfilledPlaceholder, type Sample } from "./template";

/** Arguments that name a locator rather than carry a value, per action kind. */
export const LOCATOR_ARGUMENTS: Record<string, string[]> = {
  open_rows: ["at", "mark"],
  show_record: ["at"],
  compare_records: ["a", "b"],
  follow_link: ["from", "to"],
  chart: ["at"],
};

/** Action kinds that change what the content pane shows. One per step at most. */
export const CONTENT_ACTIONS = new Set(["open_rows", "follow_link", "timetable", "calendar"]);

/** Action kinds drawn on the map. */
export const MAP_ACTIONS = new Set(["map_focus", "map_measure", "map_sequence", "map_play", "map_race"]);

export interface ResolvedAction {
  kind: string;
  args: Record<string, unknown>;
  /** Each locator argument, resolved. */
  located: Record<string, Located | Unlocatable>;
}

export interface ResolvedStep {
  text: string;
  actions: ResolvedAction[];
  clear: string[];
  /** What the card points at: the rows the step opened, the map, or neither. */
  point: "rows" | "map" | null;
  /** Actions left out because the sample lacked a field they need. */
  skipped: { kind: string; field: string }[];
  /**
   * The rows an earlier step opened, still shown: a step that opens nothing
   * of its own is about the same rows, and they stay open, lit and outlined,
   * until a step opens something else or says `clear: [rows]`.
   */
  carried?: ResolvedAction;
}

export interface Walkthrough {
  code: string;
  authored: boolean;
  steps: ResolvedStep[];
}

function resolveAction(
  action: Action,
  locators: Record<string, Locator>,
  sample: Sample,
  tables: TableInfo[],
): ResolvedAction {
  const { kind, ...rest } = action;
  const args = fillValue(rest, sample) as Record<string, unknown>;
  const located: Record<string, Located | Unlocatable> = {};
  for (const name of LOCATOR_ARGUMENTS[kind] ?? []) {
    const reference = rest[name];
    if (typeof reference !== "string") continue;
    const locator = locators[reference];
    if (!locator) {
      located[name] = { problem: `The guide names no locator called ${reference}.` };
      continue;
    }
    located[name] = locate(fillValue(locator, sample) as Locator, tables, {
      around: kind === "open_rows" ? Number(args.around) || 0 : 0,
    });
  }
  return { kind, args, located };
}


/**
 * The last step every walkthrough ends on: what to do about it.
 *
 * Added here rather than written into each guide, so a fallback walkthrough
 * ends the same way an authored one does. Its sentence is the first fix, or,
 * for a notice with none written, the rule in the validator's words; the rest
 * follow in the card, with the spec and best-practice links.
 */
function closingStep(guide: Guide, sample: Sample, notice: NoticeDescription | undefined): ResolvedStep {
  const fixes: string[] = [];
  for (const line of guide.fix ?? []) {
    try {
      fixes.push(fill(line, sample));
    } catch (error) {
      if (!(error instanceof UnfilledPlaceholder)) throw error;
    }
  }
  const rule = firstSentence(notice?.description || notice?.summary || "") || guide.code;
  const [text, ...more] = fixes.length ? fixes : [rule];
  return {
    text,
    actions: [
      ...(more.length ? [{ kind: "fix", args: { lines: more }, located: {} }] : []),
      { kind: "reference", args: { said: text }, located: {} },
    ],
    clear: [],
    point: null,
    skipped: [],
  };
}

/** Where a step's card points when the guide does not say. */
function defaultPoint(actions: ResolvedAction[]): ResolvedStep["point"] {
  if (actions.some((action) => CONTENT_ACTIONS.has(action.kind))) return "rows";
  if (actions.some((action) => MAP_ACTIONS.has(action.kind))) return "map";
  return null;
}

export function resolveWalkthrough(
  guide: Guide,
  authored: boolean,
  sample: Sample,
  tables: TableInfo[],
  notice?: NoticeDescription,
): Walkthrough {
  const locators = guide.locators ?? {};
  const steps: ResolvedStep[] = [];

  for (const step of guide.steps) {
    let text: string;
    try {
      text = fill(step.text, sample);
    } catch (error) {
      if (error instanceof UnfilledPlaceholder) continue;
      throw error;
    }
    const actions: ResolvedAction[] = [];
    const skipped: ResolvedStep["skipped"] = [];
    for (const action of step.actions ?? []) {
      try {
        actions.push(resolveAction(action, locators, sample, tables));
      } catch (error) {
        if (!(error instanceof UnfilledPlaceholder)) throw error;
        skipped.push({ kind: action.kind, field: error.field });
      }
    }
    steps.push({ text, actions, clear: step.clear ?? [], point: step.point ?? defaultPoint(actions), skipped });
  }

  const closing = closingStep(guide, sample, notice);
  carryRows(steps);
  // A rule already said, with no fix to add, is not a step of its own: its
  // links go on the last step instead.
  if (steps.length && !guide.fix?.length && steps.some((step) => step.text.includes(closing.text))) {
    steps[steps.length - 1].actions.push(...closing.actions);
  } else {
    steps.push(closing);
    carryRows(steps);
  }
  return { code: guide.code, authored, steps };
}

/** Give each step that opens nothing the rows the step before it showed. */
function carryRows(steps: ResolvedStep[]): void {
  let shown: ResolvedAction | undefined;
  for (const step of steps) {
    const own = step.actions.find((action) => CONTENT_ACTIONS.has(action.kind));
    if (own) shown = own;
    else if (step.clear.includes("rows")) shown = undefined;
    step.carried = own ? undefined : shown;
    // Where the card points, by default: at the rows it is still about.
    if (!own && shown && step.point === null) step.point = "rows";
  }
}
