/**
 * The tour editor's model, its YAML, and where it saves: everything the form
 * relies on that can be checked without a document.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import catalogJson from "../../../../src/gtfs_garage/data/guides.json";
import type { TableInfo, ViewerSource } from "../../sources/types";
import type { Catalog, Guide } from "../catalog";
import { GuideLibrary, LocalGuideStore } from "../guide-store";
import { parseReport } from "../report";
import { validateGuide } from "../validate";
import { checkSteps, cleanGuide, dropUnusedLocators, newAction, sameGuide, starterGuide, tableFor } from "./model";
import { HAND_TRIAL, Trials } from "./trials";
import { guideToYaml, parseYaml } from "./yaml";

const catalog = catalogJson as unknown as Catalog;
const DATA = join(__dirname, "../../../../src/gtfs_garage/data/demos");

function tablesOf(feed: string): TableInfo[] {
  return readdirSync(join(DATA, feed))
    .filter((file) => file.endsWith(".txt"))
    .map((file) => {
      const header = readFileSync(join(DATA, feed, file), "utf-8").replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
      return {
        name: file.replace(/\.txt$/, ""),
        row_count: 1,
        lines: "exact",
        forbidden: null,
        columns: header.split(",").map((name) => ({ name: name.trim(), related: [], enum_like: false })),
      } as unknown as TableInfo;
    });
}

const report = parseReport(readFileSync(join(DATA, "main.report.json"), "utf-8"));
const sampleOf = (code: string) => report.notices.find((notice) => notice.code === code)!.sampleNotices[0];

/** A Storage that keeps its items in a map, as a browser's does. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("cleanGuide", () => {
  it("leaves out what the form left blank, and keeps what the check needs to see", () => {
    const guide: Guide = {
      code: "x",
      locators: { stop: { file: "stops", line: "", key: { stop_id: "{{stopId}}" } }, " ": { file: "" } },
      steps: [
        { text: "", actions: [{ kind: "open_rows", at: "stop", highlight: [], mark: "", around: undefined }] },
        { text: "t", clear: [], actions: [] },
      ],
      fix: ["", "Fix it."],
    };
    expect(cleanGuide(guide)).toEqual({
      code: "x",
      locators: { stop: { file: "stops", key: { stop_id: "{{stopId}}" } } },
      steps: [{ text: "", actions: [{ kind: "open_rows", at: "stop" }] }, { text: "t" }],
      fix: ["Fix it."],
    });
  });

  it("changes nothing in a guide the catalog ships", () => {
    for (const notice of Object.values(catalog.notices)) {
      if (notice.guide) expect(sameGuide(notice.guide, JSON.parse(JSON.stringify(notice.guide)))).toBe(true);
      if (notice.guide) expect(cleanGuide(notice.guide)).toEqual(notice.guide);
    }
  });
});

describe("YAML", () => {
  it("reads back every shipped guide exactly as written", () => {
    for (const [code, notice] of Object.entries(catalog.notices)) {
      if (!notice.guide) continue;
      const parsed = parseYaml(guideToYaml(notice.guide));
      expect(parsed.ok, code).toBe(true);
      if (parsed.ok) expect(parsed.value, code).toEqual(notice.guide);
    }
  });

  it("writes each action and locator on one line, as the files in schema/guides do", () => {
    const yaml = guideToYaml(catalog.notices.stop_too_far_from_shape.guide!);
    expect(yaml).toContain('  stop: { file: stops, key: { stop_id: "{{stopId}}" } }');
    expect(yaml).toMatch(/\n {6}- \{ kind: open_rows, at: stop, highlight: \[ stop_lat, stop_lon \] \}\n/);
  });

  it("says on which line it cannot be read", () => {
    const parsed = parseYaml("code: x\nsteps:\n  - text: [unclosed\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.line).toBeGreaterThan(0);
  });
});

describe("editing", () => {
  it("drops the rows no action opens any more", () => {
    const guide: Guide = {
      code: "x",
      locators: { stop: { file: "stops", line: "{{csvRowNumber}}" }, gone: { file: "trips", line: "1" } },
      steps: [{ text: "t", actions: [{ kind: "open_rows", at: "stop" }] }],
    };
    expect(Object.keys(dropUnusedLocators(guide, catalog.action_specs).locators!)).toEqual(["stop"]);
    expect(dropUnusedLocators({ ...guide, steps: [{ text: "t" }] }, catalog.action_specs).locators).toBeUndefined();
    for (const notice of Object.values(catalog.notices)) {
      if (notice.guide) expect(dropUnusedLocators(notice.guide, catalog.action_specs)).toEqual(notice.guide);
    }
  });

  it("gives each set of rows a new action needs its own", () => {
    const compare = newAction("compare_records", catalog.action_specs.compare_records, ["a", "b"]);
    expect([compare.a, compare.b]).toEqual(["a", "b"]);
  });

  it("fills a new action's arguments from the fields that obviously fit", () => {
    const fields = Object.keys(catalog.notices.fast_travel_between_consecutive_stops.fields);
    const play = cleanGuide({ code: "x", steps: [{ text: "t", actions: [newAction("map_play", catalog.action_specs.map_play, [], fields)] }] });
    expect(play.steps[0].actions![0]).toEqual({ kind: "map_play", trip: "{{tripId}}", from: "{{stopId1}}", to: "{{stopId2}}", mark: ["{{stopId1}}", "{{stopId2}}"] });
    const measure = newAction("map_measure", catalog.action_specs.map_measure, [], ["stopId", "match"]);
    expect(measure.from).toEqual({ stop: "{{stopId}}" });
    expect(measure.to).toEqual({ stop: "" });
  });

  it("finds the file a locator names through the sample, for its columns", () => {
    const tables = tablesOf("main");
    expect(tableFor({ file: "{{filename}}", line: "1" }, { filename: "stops.txt" }, tables)?.name).toBe("stops");
    expect(tableFor({ file: "nowhere", line: "1" }, {}, tables)).toBeUndefined();
  });
});

describe("checkSteps", () => {
  const tables = tablesOf("main");

  it("says which steps run on a sample, and what each loses", () => {
    const sample = sampleOf("stop_too_far_from_shape");
    const guide: Guide = {
      code: "stop_too_far_from_shape",
      locators: { stop: { file: "stops", key: { stop_id: "{{stopId}}" } }, ghost: { file: "nowhere", line: "{{tripCsvRowNumber}}" } },
      steps: [
        { text: "{{stopName}}.", actions: [{ kind: "open_rows", at: "stop" }] },
        { text: "Never: {{notAField}}." },
        { text: "Rows that are not there.", actions: [{ kind: "open_rows", at: "ghost" }, { kind: "map_focus", stops: ["{{notAField}}"] }] },
      ],
    };
    const checks = checkSteps(guide, sample, tables);
    expect(checks.map((check) => check.runs)).toEqual([0, null, 1]);
    expect(checks[1].dropped).toMatch(/no notAField/);
    expect(checks[2].notes.join(" ")).toMatch(/map focus" is left out/);
    expect(checks[2].notes.length).toBe(2);
  });

  it("finds nothing wrong with the automatic tour of every notice the main feed raises", () => {
    for (const notice of report.notices) {
      const description = catalog.notices[notice.code];
      if (!description) continue;
      const sample = notice.sampleNotices[0];
      const guide = starterGuide(notice.code, description, sample);
      expect(validateGuide(notice.code, cleanGuide(guide), Object.keys(description.fields), catalog), notice.code).toEqual([]);
      expect(checkSteps(guide, sample, tables).every((check) => check.dropped === null), notice.code).toBe(true);
    }
  });
});

describe("saved tours", () => {
  it("are kept in the browser and win over the built-in one until removed", async () => {
    const storage = memoryStorage();
    const library = new GuideLibrary(new LocalGuideStore(storage));
    await library.ready();
    const code = "stop_too_far_from_shape";
    expect(library.origin(code)).toBe("builtin");
    // Every notice the validator knows has a tour; one it does not is explained from its fields.
    expect(library.origin("a_notice_from_a_newer_validator")).toBe("generic");

    const mine: Guide = { code, steps: [{ text: "Mine." }] };
    await library.save(code, mine, "code: stop_too_far_from_shape\n# mine\nsteps: [{ text: Mine. }]\n");
    expect(library.origin(code)).toBe("saved");
    expect(library.guideFor(catalog, code, {}).guide).toEqual(mine);

    // Another viewer in the same browser reads it back, comments and all.
    const again = new GuideLibrary(new LocalGuideStore(storage));
    await again.ready();
    expect(again.savedGuide(code)?.yaml).toContain("# mine");

    await library.remove(code);
    expect(library.origin(code)).toBe("builtin");
    expect(library.guideFor(catalog, code, {}).guide).toEqual(catalog.notices[code].guide);
  });

  it("hold for the session when the browser keeps nothing", async () => {
    const library = new GuideLibrary(new LocalGuideStore(null));
    await library.ready();
    await library.save("unused_shape", { code: "unused_shape", steps: [{ text: "t" }] }, "");
    expect(library.origin("unused_shape")).toBe("saved");
  });
});

describe("where a tour is tried", () => {
  const mainReport = readFileSync(join(DATA, "main.report.json"), "utf-8");
  const source = {
    demos: async () => [
      { id: "main", title: "Main network", description: "", builtin: true, available: true, notices: { stop_too_far_from_shape: 5, unused_shape: 1 } },
      { id: "gone", title: "Gone", description: "", builtin: false, available: false, notices: { stop_too_far_from_shape: 9 } },
    ],
    demoReport: async () => mainReport,
    demoTables: async () => [{ name: "stops", columns: ["stop_id", "stop_name", "stop_lat", "stop_lon"] }],
  } as unknown as ViewerSource;
  const trials = (loaded: boolean) =>
    new Trials({ source, report: () => (loaded ? report : null), tables: () => tablesOf("main"), feedName: () => "my feed" });

  it("offers the open feed's report first, then each demo that raises the notice, then a sample by hand", async () => {
    const options = await trials(true).options("stop_too_far_from_shape");
    expect(options.map((option) => option.id)).toEqual(["report", "demo:main", "hand"]);
    expect(options[1].samples).toBe(5);
  });

  it("offers a sample by hand alone for a notice nothing raises", async () => {
    expect((await trials(false).options("i_o_error")).map((option) => option.kind)).toEqual(["hand"]);
  });

  it("reads a demo's samples and files without opening it", async () => {
    const given = trials(false);
    const demo = (await given.options("stop_too_far_from_shape"))[0];
    const trial = await given.load("stop_too_far_from_shape", demo);
    expect(trial.kind).toBe("demo");
    expect(trial.sampleList[0].stopId).toBeTruthy();
    expect(trial.tables.map((table) => table.name)).toEqual(["stops"]);
  });

  it("keeps a sample written by hand for as long as the page is open", async () => {
    const given = trials(false);
    given.handSample("i_o_error").exception = "disk full";
    const trial = await given.load("i_o_error", { id: HAND_TRIAL, kind: "hand", label: "", samples: 0 });
    expect(trial.sampleList).toEqual([{ exception: "disk full" }]);
  });
});
