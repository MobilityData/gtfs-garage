import { describe, expect, it } from "vitest";

import type { Workspace, WorkspaceFeed } from "../sources/types";
import {
  displayLabel,
  feedRows,
  formatAge,
  hasWorkspace,
  reloadBlockedReason,
  showsWorkspace,
  workspaceSummary,
} from "./options-menu";

const NOW = Date.parse("2026-10-09T12:00:00Z");

function feed(overrides: Partial<WorkspaceFeed> = {}): WorkspaceFeed {
  return {
    id: "montreal-zip-7f3a91c0",
    label: "montreal.zip",
    kind: "download",
    loaded_at: "2026-10-09T11:59:30Z",
    bytes: 2048,
    tables: 12,
    reloadable: true,
    current: false,
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    path: "/Users/sam/gtfs-work",
    persistent: true,
    keep: 3,
    total_bytes: 4096,
    feeds: [feed()],
    ...overrides,
  };
}

describe("formatAge", () => {
  it("says just now for the feed that has only been loaded", () => {
    expect(formatAge("2026-10-09T11:59:30Z", NOW)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(formatAge("2026-10-09T11:40:00Z", NOW)).toBe("20 min ago");
    expect(formatAge("2026-10-09T09:00:00Z", NOW)).toBe("3 h ago");
    expect(formatAge("2026-10-05T12:00:00Z", NOW)).toBe("4 d ago");
  });

  it("says nothing rather than something wrong when there is no date", () => {
    // A record written by a version that did not keep one, or a corrupted one.
    // An empty cell reads as "unknown"; "Invalid Date" reads as a bug.
    expect(formatAge(undefined, NOW)).toBe("");
    expect(formatAge("", NOW)).toBe("");
    expect(formatAge("not a date", NOW)).toBe("");
  });
});

describe("workspaceSummary", () => {
  it("counts the feeds and weighs them", () => {
    expect(workspaceSummary(workspace())).toBe("1 feed · 4.0 KB · kept · keeping 3");
  });

  it("pluralises", () => {
    expect(workspaceSummary(workspace({ feeds: [feed(), feed({ id: "b" })] }))).toContain("2 feeds");
  });

  it("says when nothing here will survive the session", () => {
    // The difference between the two modes, and the one thing someone reading
    // this line needs to know before relying on a feed still being there.
    expect(workspaceSummary(workspace({ persistent: false }))).toContain("removed on exit");
  });

  it("leaves the limit out when there is none", () => {
    expect(workspaceSummary(workspace({ keep: 0 }))).not.toContain("keeping");
  });

  it("describes an empty workdir rather than omitting the line", () => {
    expect(workspaceSummary(workspace({ feeds: [], total_bytes: 0 }))).toBe("0 feeds · 0 B · kept · keeping 3");
  });
});

describe("displayLabel", () => {
  it("leaves a filename alone", () => {
    expect(displayLabel("montreal.zip")).toBe("montreal.zip");
  });

  it("reduces a path to the file that names the feed", () => {
    // Five segments that are the same on every row, and one that is not.
    expect(displayLabel("/Users/sam/work/transit/2026/montreal.zip")).toBe("montreal.zip");
  });

  it("reduces a URL the same way", () => {
    expect(displayLabel("https://example.org/p/stm/latest/gtfs.zip")).toBe("gtfs.zip");
  });

  it("names a folder by the folder", () => {
    expect(displayLabel("/Users/sam/feeds/montreal/")).toBe("montreal");
  });

  it("falls back to the whole label rather than to nothing", () => {
    expect(displayLabel("/")).toBe("/");
    expect(displayLabel("")).toBe("");
  });
});

describe("feedRows", () => {
  it("describes a feed by size, tables and age", () => {
    const [row] = feedRows(workspace(), NOW);
    expect(row.label).toBe("montreal.zip");
    expect(row.detail).toBe("2.0 KB · 12 tables · just now");
  });

  it("names a feed loaded from a path by its file, and keeps the path for the tooltip", () => {
    const listed = workspace({ feeds: [feed({ label: "/Users/sam/feeds/montreal.zip" })] });
    const [row] = feedRows(listed, NOW);
    expect(row.label).toBe("montreal.zip");
    expect(row.source).toBe("/Users/sam/feeds/montreal.zip");
  });

  it("keeps the server's order, which is newest first", () => {
    const listed = workspace({ feeds: [feed({ id: "new" }), feed({ id: "old" })] });
    expect(feedRows(listed, NOW).map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("offers neither action on the feed being served", () => {
    // Its Parquet is what every query reads: deleting it would break the page,
    // and reopening it would be a no-op dressed as a button.
    const [row] = feedRows(workspace({ feeds: [feed({ current: true })] }), NOW);
    expect(row.removable).toBe(false);
    expect(row.reloadable).toBe(false);
  });

  it("offers both on a feed that is merely stored", () => {
    const [row] = feedRows(workspace(), NOW);
    expect(row.removable).toBe(true);
    expect(row.reloadable).toBe(true);
  });

  it("cannot reopen a feed with no Parquet, but can still delete it", () => {
    const [row] = feedRows(workspace({ feeds: [feed({ reloadable: false })] }), NOW);
    expect(row.reloadable).toBe(false);
    expect(row.removable).toBe(true);
  });
});

describe("reloadBlockedReason", () => {
  const row = (overrides: Partial<ReturnType<typeof feedRows>[number]>) => ({
    id: "a",
    label: "a.zip",
    source: "a.zip",
    detail: "",
    current: false,
    reloadable: true,
    removable: true,
    ...overrides,
  });

  it("is silent when the button works", () => {
    expect(reloadBlockedReason(row({}))).toBe("");
  });

  it("says which feed you are already looking at", () => {
    expect(reloadBlockedReason(row({ current: true, reloadable: false }))).toContain("looking at");
  });

  it("names the flag that left nothing to reopen from", () => {
    expect(reloadBlockedReason(row({ reloadable: false }))).toContain("--no-parquet");
  });
});

const port = {
  workspace: () => Promise.resolve(workspace()),
  reloadFeed: () => Promise.resolve({}),
  removeFeed: () => Promise.resolve(workspace()),
  clearWorkspace: () => Promise.resolve(workspace()),
};

describe("showsWorkspace", () => {
  const config = (overrides = {}) => ({ basemap: "none", version: "0.4.0", ...overrides });

  it("shows it for a server that says it has a workdir", () => {
    expect(showsWorkspace(port, config({ workspace: true }))).toBe(true);
  });

  it("hides it for a backend implementing the same endpoints without one", () => {
    // `RestSource` always carries the four methods - it is written against the
    // whole contract - so having them says nothing about what is behind
    // `baseUrl`. Only the server's own config settles it.
    expect(showsWorkspace(port, config())).toBe(false);
    expect(showsWorkspace(port, config({ workspace: false }))).toBe(false);
  });

  it("trusts a source that has no config to ask", () => {
    // A host that wrote the four methods by hand meant them.
    expect(showsWorkspace(port, null)).toBe(true);
    expect(showsWorkspace(port, undefined)).toBe(true);
  });

  it("hides it for a source that could not answer anyway", () => {
    expect(showsWorkspace({}, config({ workspace: true }))).toBe(false);
  });
});

describe("hasWorkspace", () => {
  it("recognises a source that can answer for one", () => {
    expect(hasWorkspace(port)).toBe(true);
  });

  it("rejects a source missing any of it", () => {
    // All four or none: a section with half its buttons dead is worse than no
    // section, and a browser reading Parquet has no workdir to describe.
    expect(hasWorkspace({ ...port, clearWorkspace: undefined })).toBe(false);
    expect(hasWorkspace({})).toBe(false);
    expect(hasWorkspace(undefined)).toBe(false);
    expect(hasWorkspace(null)).toBe(false);
  });
});
