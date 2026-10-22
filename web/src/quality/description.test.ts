import { describe, expect, it } from "vitest";

import catalogJson from "../../../src/gtfs_garage/data/guides.json";
import type { Catalog } from "./catalog";
import { fallbackGuide } from "./catalog";
import { descriptionBlocks, firstSentence } from "./description";
import { resolveWalkthrough } from "./walkthrough";

const catalog = catalogJson as unknown as Catalog;

describe("a rule's description", () => {
  const speeds = catalog.notices.fast_travel_between_consecutive_stops;

  it("reads its tables back as tables, header first", () => {
    const blocks = descriptionBlocks(speeds.description);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table"]);
    const table = blocks[1] as Extract<(typeof blocks)[number], { kind: "table" }>;
    expect(table.header).toEqual(["Route type", "Description", "Threshold, km/h"]);
    expect(table.rows[3]).toEqual(["3", "Bus", "150"]);
    expect(table.rows.at(-1)).toEqual(["-", "Unknown", "200"]);
  });

  it("gives its first sentence alone, never the table after it", () => {
    expect(firstSentence(speeds.description)).toBe("The speed threshold depends on route type:");
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("A line\nwrapped. Then more.")).toBe("A line wrapped.");
  });

  it("ends a walkthrough with no fix written on that sentence, not on the table", () => {
    const sample = { tripId: "T1", csvRowNumber1: 2, csvRowNumber2: 3, stopId1: "A", stopId2: "B" };
    const guide = { ...fallbackGuide("fast_travel_between_consecutive_stops", speeds, sample), fix: [] };
    const steps = resolveWalkthrough(guide, false, sample, [], speeds).steps;
    expect(steps.at(-1)!.text).toBe("The speed threshold depends on route type:");
  });

  it("keeps every catalog description's tables square", () => {
    for (const [code, notice] of Object.entries(catalog.notices)) {
      for (const block of descriptionBlocks(notice.description)) {
        if (block.kind === "table") for (const row of block.rows) expect(row.length, code).toBe(block.header.length);
      }
    }
  });
});

describe("a step that opens nothing", () => {
  const tables = [
    { name: "stops", row_count: 1, lines: "exact", forbidden: null, columns: [{ name: "stop_id", related: [], enum_like: false }] },
  ] as unknown as Parameters<typeof resolveWalkthrough>[3];
  const guide = {
    code: "x",
    locators: { stop: { file: "stops", key: { stop_id: "{{stopId}}" } } },
    steps: [
      { text: "The row.", actions: [{ kind: "open_rows", at: "stop", highlight: ["stop_id"] }] },
      { text: "Still about it." },
      { text: "Something else.", clear: ["rows" as const] as unknown as ("map" | "panel")[] },
    ],
    fix: ["Fix it."],
  };

  it("keeps the rows the step before opened, and points at them", () => {
    const steps = resolveWalkthrough(guide, true, { stopId: "S1" }, tables).steps;
    expect(steps[1].carried?.kind).toBe("open_rows");
    expect(steps[1].point).toBe("rows");
  });

  it("lets them go when it says clear: [rows], and so does every step after", () => {
    const steps = resolveWalkthrough(guide, true, { stopId: "S1" }, tables).steps;
    expect(steps[2].carried).toBeUndefined();
    expect(steps[3].carried).toBeUndefined();
  });

  it("keeps them for the closing step, which is about the same rows", () => {
    const short = { ...guide, steps: guide.steps.slice(0, 2) };
    const steps = resolveWalkthrough(short, true, { stopId: "S1" }, tables).steps;
    expect(steps.at(-1)!.carried?.kind).toBe("open_rows");
  });
});
