import { describe, expect, it, vi } from "vitest";

import { decideDataset, type DatasetState, type DecisionContext } from "./dataset";
import type { ViewerSource } from "./sources/types";
import { progressLine } from "./ui/load-progress";

const SOURCE = {} as ViewerSource;

const context = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  description: "mdb-1210",
  canPrepare: true,
  asked: false,
  phrase: progressLine,
  ...overrides,
});

/**
 * A dataset behind an API does not exist until something converts it, which
 * takes seconds after a download. Before this, the viewer asked once and
 * rendered "Could not load the feed" - an error for the normal first
 * experience.
 */
describe("decideDataset", () => {
  it("opens the viewer once the host says ready", () => {
    const decision = decideDataset({ state: "ready", source: SOURCE }, context());
    expect(decision.source).toBe(SOURCE);
    expect(decision.settled).toBe(true);
    // Nothing to say: the viewer is taking the root over.
    expect(decision.line).toBeUndefined();
  });

  it("shows the host's reason for a failure, not a generic one", () => {
    const decision = decideDataset({ state: "failed", message: "Conversion ran out of memory" }, context());
    expect(decision).toMatchObject({ line: "Conversion ran out of memory", tone: "error", settled: true });
    expect(decision.source).toBeUndefined();
  });

  it("keeps polling while a dataset is being prepared", () => {
    const decision = decideDataset({ state: "preparing" }, context());
    expect(decision.settled).toBeFalsy();
    expect(decision.line).toBe("Loading mdb-1210…");
  });

  it("words progress with the viewer's own phrasing", () => {
    const decision = decideDataset(
      {
        state: "preparing",
        progress: { phase: "convert", done: 12, total: 32, detail: "stop_times", running: true },
      },
      context(),
    );
    expect(decision.line).toBe("Converting stop_times (12 of 32)");
  });

  /**
   * The rule that costs money if it is wrong: asked on every poll, this would
   * queue a conversion a second.
   */
  it("asks for preparation once and not again", () => {
    const absent: DatasetState = { state: "absent" };
    expect(decideDataset(absent, context({ asked: false })).prepare).toBe(true);
    expect(decideDataset(absent, context({ asked: true })).prepare).toBeFalsy();
  });

  it("keeps waiting after asking, rather than settling", () => {
    // Preparation has been requested; the next status will say `preparing`.
    expect(decideDataset({ state: "absent" }, context({ asked: true })).settled).toBeFalsy();
  });

  it("stops when nothing can prepare the dataset", () => {
    // A host with no `prepare` cannot make it appear, so waiting is pointless.
    const decision = decideDataset({ state: "absent" }, context({ canPrepare: false }));
    expect(decision).toMatchObject({ settled: true, line: "mdb-1210 has not been prepared yet." });
    expect(decision.prepare).toBeFalsy();
  });

  it("names the dataset the host gave it", () => {
    const decision = decideDataset({ state: "absent" }, context({ canPrepare: false, description: "the feed" }));
    expect(decision.line).toContain("the feed");
  });

  it("never both opens the viewer and shows a line", () => {
    const states: DatasetState[] = [
      { state: "ready", source: SOURCE },
      { state: "failed", message: "x" },
      { state: "absent" },
      { state: "preparing" },
    ];
    for (const state of states) {
      const decision = decideDataset(state, context());
      expect(Boolean(decision.source) && Boolean(decision.line)).toBe(false);
    }
  });

  it("does not call the host to work out what to show", () => {
    // The decision is a pure function of the reported state, which is what
    // makes every rule above testable without a server or a document.
    const phrase = vi.fn(() => "x");
    decideDataset({ state: "preparing" }, context({ phrase }));
    expect(phrase).toHaveBeenCalledOnce();
  });
});
