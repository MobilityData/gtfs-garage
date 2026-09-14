import { describe, expect, it } from "vitest";

import { buildViewer } from "./markup";

/**
 * These need a document, which vitest does not give us - so they assert what
 * can be checked on the generated HTML itself. The rendering is verified by
 * driving the real application.
 */
describe("buildViewer markup", () => {
  const html = (parts = {}) => {
    const root = { classList: { add: () => {} }, innerHTML: "" } as unknown as Element;
    buildViewer(root, parts);
    return (root as unknown as { innerHTML: string }).innerHTML;
  };

  it("tags elements with data-el and never with id", () => {
    const markup = html();
    expect(markup).toContain('data-el="table-scroll"');
    // An id would collide with the host's document once two viewers exist.
    expect(markup).not.toMatch(/\sid=/);
  });

  it("includes the local tool's parts by default", () => {
    const markup = html();
    expect(markup).toContain('data-el="load-overlay"');
    expect(markup).toContain('data-el="metrics-panel"');
    expect(markup).toContain('data-el="map-pane"');
  });

  it("leaves out what an embedded viewer has no use for", () => {
    // A host showing a known dataset has nothing to open and no load to explain.
    const markup = html({ load: false, report: false, map: false });
    expect(markup).not.toContain("load-overlay");
    expect(markup).not.toContain("metrics-panel");
    expect(markup).not.toContain("map-pane");
    // The part worth embedding survives.
    expect(markup).toContain('data-el="table-scroll"');
    expect(markup).toContain('data-el="filter-bar"');
  });

  it("drops the buttons for the parts it leaves out", () => {
    const markup = html({ load: false, map: false });
    expect(markup).not.toContain("open-load-btn");
    expect(markup).not.toContain("toggle-map-btn");
  });
});
