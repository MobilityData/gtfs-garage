import { describe, expect, it } from "vitest";

import { tableInfo } from "../sources/fixtures";
import type { MissingFile } from "../sources/types";
import { describeForbidden, describeMissing } from "./sidebar";

const missing = (overrides: Partial<MissingFile> = {}): MissingFile => ({
  name: "stop_times",
  presence: "required",
  condition: null,
  condition_outcome: null,
  ...overrides,
});

/**
 * A missing file used to be indistinguishable from one GTFS never asked for:
 * the tab was absent either way. Naming it is only half of it - the reader also
 * has to know why it is wanted, or there is nothing to act on.
 */
describe("describeMissing", () => {
  it("says plainly that a required file is absent", () => {
    expect(describeMissing(missing())).toBe("Required. This feed does not have it.");
  });

  it("gives the condition for a conditionally required file", () => {
    const file = missing({
      name: "calendar_dates",
      presence: "conditional",
      condition: "Required if calendar.txt is omitted.",
      condition_outcome: { holds: true, evidence: "calendar is absent" },
    });
    expect(describeMissing(file)).toBe(
      "Required if calendar.txt is omitted. Required here: calendar is absent.",
    );
  });

  it("states the condition alone when nothing settled it", () => {
    // Nothing in the viewer can tell whether pathways describe elevators, so
    // levels.txt carries its sentence and no verdict.
    const file = missing({
      name: "levels",
      presence: "conditional",
      condition: "Required when describing pathways with elevators.",
    });
    expect(describeMissing(file)).toBe("Required when describing pathways with elevators.");
  });

  it("does not go blank when a conditional file has no stated condition", () => {
    expect(describeMissing(missing({ presence: "conditional" }))).toBe("Conditionally required.");
  });
});

/**
 * The other direction: present, and not wanted. Kept apart from a missing file
 * because a forbidden file whose condition holds means the opposite of a
 * required one whose condition holds.
 */
describe("describeForbidden", () => {
  it("names the condition and what makes it apply here", () => {
    const table = tableInfo({
      name: "networks",
      forbidden: {
        condition: "Forbidden if network_id exists in routes.txt.",
        outcome: { holds: true, evidence: "routes.network_id is present" },
      },
    });
    expect(describeForbidden(table)).toBe(
      "Forbidden if network_id exists in routes.txt. Forbidden here: routes.network_id is present.",
    );
  });

  it("says nothing about an ordinary table", () => {
    // Empty rather than a sentence, so the caller can use it as the test of
    // whether there is anything to say at all.
    expect(describeForbidden(tableInfo({ name: "routes" }))).toBe("");
  });
});
