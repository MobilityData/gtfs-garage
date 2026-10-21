/**
 * The viewer's check of a guide, held to the server's.
 *
 * `tests/data/guides/cases.json` is also run by `tests/test_guides.py` against
 * `check_guide`, so a rule changed on one side and not the other fails here or
 * there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import catalogJson from "../../../src/gtfs_garage/data/guides.json";
import { fallbackGuide, type Catalog } from "./catalog";
import { parseReport } from "./report";
import { FORMATTERS } from "./template";
import { validateGuide } from "./validate";
import { CONTENT_ACTIONS, LOCATOR_ARGUMENTS, MAP_ACTIONS } from "./walkthrough";

const catalog = catalogJson as unknown as Catalog;
const DATA = join(__dirname, "../../../tests/data");
const DEMOS = join(__dirname, "../../../src/gtfs_garage/data/demos");
const FEEDS = ["main", "future", "no-calendar", "parse-errors", "crash", "subfolder"];

interface Case {
  name: string;
  guide: unknown;
  error: string | null;
}
const cases = JSON.parse(readFileSync(join(DATA, "guides/cases.json"), "utf-8")) as { code: string; fields: string[]; cases: Case[] };

describe("validateGuide", () => {
  it.each(cases.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const problems = validateGuide(cases.code, entry.guide, cases.fields, catalog);
    if (entry.error === null) expect(problems).toEqual([]);
    else expect(problems[0]?.text).toBe(entry.error);
  });

  it("reports every problem, each where it is", () => {
    const guide = {
      code: "x",
      steps: [
        { text: "{{nope}}", actions: [{ kind: "open_rows", at: "missing" }] },
        { text: "t", point: "sidebar" },
      ],
      fix: [3],
    };
    const problems = validateGuide("x", guide, cases.fields, catalog);
    expect(problems.map((problem) => problem.path)).toEqual([
      ["steps", 0, "text"],
      ["steps", 0, "actions", 0, "at"],
      ["steps", 1, "point"],
      ["fix", 0],
    ]);
    expect(problems[1].message).toBe("open_rows.at names undeclared locator 'missing'");
  });

  it("passes every guide the catalog ships", () => {
    for (const [code, notice] of Object.entries(catalog.notices)) {
      if (notice.guide) expect(validateGuide(code, notice.guide, Object.keys(notice.fields), catalog), code).toEqual([]);
    }
  });

  // An analyst's tour usually starts as the one derived from a sample's fields,
  // so that one has to be a guide the editor and the server accept as it is.
  it("passes every walkthrough derived from a sample's fields", () => {
    for (const feed of FEEDS) {
      const report = parseReport(readFileSync(join(DEMOS, `${feed}.report.json`), "utf-8"));
      for (const notice of report.notices) {
        const description = catalog.notices[notice.code];
        if (!description) continue;
        for (const sample of notice.sampleNotices.slice(0, 3)) {
          const guide = fallbackGuide(notice.code, description, sample);
          expect(validateGuide(notice.code, guide, Object.keys(description.fields), catalog), `${feed} ${notice.code}`).toEqual([]);
        }
      }
    }
  });
});

describe("the viewer's own lists of actions and formatters", () => {
  const specs = Object.entries(catalog.action_specs);

  it("format exactly what the catalog allows", () => {
    expect(Object.keys(FORMATTERS).sort()).toEqual(catalog.formatters);
  });

  it("name the actions the catalog does", () => {
    expect([...CONTENT_ACTIONS].sort()).toEqual(specs.filter(([, spec]) => spec.surface === "content").map(([kind]) => kind).sort());
    expect([...MAP_ACTIONS].sort()).toEqual(specs.filter(([, spec]) => spec.surface === "map").map(([kind]) => kind).sort());
    const locators = Object.fromEntries(
      specs
        .map(([kind, spec]) => [kind, Object.entries(spec.args).filter(([, arg]) => arg.type === "locator").map(([name]) => name)] as const)
        .filter(([, names]) => names.length),
    );
    expect(LOCATOR_ARGUMENTS).toEqual(locators);
  });
});
