/**
 * Checking a guide before it is run or saved.
 *
 * The same rules as `check_guide` in `src/gtfs_garage/core/guides.py`, which
 * checks the guides in the repository and every guide saved to a server. The
 * action vocabulary is not restated here: it comes from the catalog, which the
 * build writes from that module. Both are run over `tests/data/guides/cases.json`
 * and must report the same first problem, in the same words.
 *
 * Where the server stops at the first problem, this reports all it finds, each
 * with the path of the value at fault, so the editor can put a message beside
 * the field it is about.
 */

import type { Vocabulary } from "./catalog";
import { placeholders, unreadable } from "./template";

export type ProblemPath = (string | number)[];

export interface Problem {
  /** Where in the guide, as keys and indexes: `["steps", 0, "actions", 1, "to"]`. */
  path: ProblemPath;
  /** The problem as the server would word it: "x: step 1: needs `text`". */
  text: string;
  /** The same without the place, for a message beside the field: "needs `text`". */
  message: string;
}

const GUIDE_KEYS = new Set(["code", "locators", "steps", "fix"]);
const LOCATOR_KEYS = new Set(["file", "line", "key"]);
const STEP_KEYS = new Set(["text", "actions", "clear", "point"]);

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness, which the server's checks are written in. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** What the server counts as a required argument left out: `in (None, "", [])`. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
}

/** A value as Python's `repr` writes it, so messages match the server's word for word. */
function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (isMapping(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${repr(key)}: ${repr(item)}`)
      .join(", ")}}`;
  return String(value);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)]);
  return [];
}

/** Every problem with a guide for `code`, whose samples have `fields`; none for a good one. */
export function validateGuide(code: string, guide: unknown, fields: Iterable<string>, vocabulary: Vocabulary): Problem[] {
  const known = new Set(fields);
  const formatters = new Set(vocabulary.formatters);
  const specs = vocabulary.action_specs;
  const problems: Problem[] = [];
  const add = (path: ProblemPath, where: string, message: string) => problems.push({ path, text: `${where}: ${message}`, message });

  const templates = (path: ProblemPath, where: string, value: unknown) => {
    for (const text of stringsIn(value)) {
      for (const braces of unreadable(text)) add(path, where, `${braces} is not a placeholder: write {{field}} or {{field|formatter}}`);
      for (const { field, formatter } of placeholders(text)) {
        if (!known.has(field)) add(path, where, `{{${field}}} is not a field of this notice (${sorted(known).join(", ")})`);
        else if (formatter && !formatters.has(formatter))
          add(path, where, `unknown formatter '|${formatter}' (known: ${sorted(formatters).join(", ")})`);
      }
    }
  };

  if (!isMapping(guide)) {
    add([], code, "a guide is a mapping");
    return problems;
  }
  if (guide.code !== code) add(["code"], `${code}.yaml`, `\`code\` must be ${repr(code)}, found ${repr(guide.code)}`);
  const unknownKeys = Object.keys(guide).filter((key) => !GUIDE_KEYS.has(key));
  if (unknownKeys.length) add([], code, `unknown keys ${repr(sorted(unknownKeys))}`);

  const locators = truthy(guide.locators) ? guide.locators : {};
  if (!isMapping(locators)) {
    add(["locators"], code, "`locators` must be a mapping");
  } else {
    for (const [name, locator] of Object.entries(locators)) {
      const where = `${code}: locator ${name}`;
      const path = ["locators", name];
      if (!isMapping(locator) || !truthy(locator.file)) {
        add([...path, "file"], where, "needs a `file`");
        continue;
      }
      const extra = Object.keys(locator).filter((key) => !LOCATOR_KEYS.has(key));
      if (extra.length) add(path, where, `unknown keys ${repr(sorted(extra))}`);
      templates(path, where, locator);
    }
  }
  const declared = isMapping(locators) ? locators : {};

  const steps = truthy(guide.steps) ? guide.steps : [];
  if (!Array.isArray(steps) || !steps.length) {
    add(["steps"], code, "needs at least one step");
  } else {
    steps.forEach((step: unknown, i) => {
      const where = `${code}: step ${i + 1}`;
      const path = ["steps", i];
      if (!isMapping(step) || typeof step.text !== "string" || !step.text) {
        add([...path, "text"], where, "needs `text`");
        return;
      }
      const extra = Object.keys(step).filter((key) => !STEP_KEYS.has(key));
      if (extra.length) add(path, where, `unknown keys ${repr(sorted(extra))}`);
      if (step.point !== undefined && step.point !== null && !vocabulary.points.includes(step.point as string))
        add([...path, "point"], where, `cannot point at ${repr(step.point)} (only ${repr(sorted(vocabulary.points))})`);
      templates([...path, "text"], where, step.text);

      const clear = truthy(step.clear) ? step.clear : [];
      if (!Array.isArray(clear)) add([...path, "clear"], where, "`clear` must be a list");
      else
        for (const surface of clear)
          if (!vocabulary.surfaces.includes(surface as string))
            add([...path, "clear"], where, `cannot clear ${repr(surface)} (only ${repr(sorted(vocabulary.surfaces))})`);

      const actions = truthy(step.actions) ? step.actions : [];
      if (!Array.isArray(actions)) {
        add([...path, "actions"], where, "`actions` must be a list");
        return;
      }
      let content = 0;
      actions.forEach((action: unknown, j) => {
        const at = [...path, "actions", j];
        const kind = isMapping(action) ? action.kind : undefined;
        const spec = typeof kind === "string" && Object.hasOwn(specs, kind) ? specs[kind] : undefined;
        if (!isMapping(action) || !spec) {
          add([...at, "kind"], where, `unknown action ${repr(kind)} (known: ${sorted(Object.keys(specs)).join(", ")})`);
          return;
        }
        const extra = Object.keys(action).filter((key) => key !== "kind" && !Object.hasOwn(spec.args, key));
        if (extra.length) add(at, where, `${kind} does not take ${repr(sorted(extra))}`);
        const missing = Object.entries(spec.args)
          .filter(([name, arg]) => arg.required && isEmpty(action[name]))
          .map(([name]) => name);
        if (missing.length) add([...at, missing[0]], where, `${kind} needs ${missing.join(", ")}`);
        for (const [name, arg] of Object.entries(spec.args)) {
          if (arg.type !== "locator" || !(name in action)) continue;
          const reference = action[name];
          if (typeof reference !== "string" || !Object.hasOwn(declared, reference))
            add([...at, name], where, `${kind}.${name} names undeclared locator ${repr(reference)}`);
        }
        if (spec.surface === "content") content += 1;
        const { kind: _kind, ...args } = action;
        templates(at, `${where} ${kind}`, args);
      });
      if (content > 1) add([...path, "actions"], where, `at most one action may change the table or screen; found ${content}`);
    });
  }

  const fix = truthy(guide.fix) ? guide.fix : [];
  if (!Array.isArray(fix)) add(["fix"], code, "`fix` must be a list");
  else
    fix.forEach((line: unknown, i) => {
      const where = `${code}: fix ${i + 1}`;
      if (typeof line !== "string") add(["fix", i], where, "needs to be a sentence");
      else templates(["fix", i], where, line);
    });
  return problems;
}
