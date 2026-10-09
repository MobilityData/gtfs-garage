/**
 * The options menu: what this tool has put on your machine, and what to do
 * about it.
 *
 * Two sections behind one button. The workdir - where the server writes, what
 * it holds, and the actions that reopen or delete a feed - and the load report,
 * which was a panel of its own before this existed. They answer the same
 * question, so they are in the same place.
 *
 * What goes on screen is decided by the exported functions below and drawn by
 * the class, the same split as `values.ts` and `table.ts`: a decision can then
 * be tested without a document, and the tests here need no DOM at all.
 */

import { button, type Dom } from "../dom";
import type { AppConfig, LoadMetrics, Workspace, WorkspaceFeed } from "../sources/types";
import { formatBytes, renderMetrics } from "./feed-metrics";

/** What the source has to provide before the workdir section is worth drawing. */
export interface WorkspacePort {
  workspace(): Promise<Workspace>;
  reloadFeed(id: string): Promise<unknown>;
  removeFeed(id: string): Promise<Workspace>;
  clearWorkspace(): Promise<Workspace>;
}

/**
 * True when a source can answer for a workdir.
 *
 * All four methods together: a source offering some of them could not drive the
 * section, and the section is all-or-nothing rather than partly disabled.
 */
export function hasWorkspace(source: unknown): source is WorkspacePort {
  const candidate = source as Partial<WorkspacePort>;
  return (
    typeof candidate?.workspace === "function" &&
    typeof candidate?.reloadFeed === "function" &&
    typeof candidate?.removeFeed === "function" &&
    typeof candidate?.clearWorkspace === "function"
  );
}

/**
 * Whether to build the workdir section for this source.
 *
 * Two questions, and both have to be answered. `RestSource` always carries the
 * four methods, because it is written against the whole contract - so having
 * them says nothing about whether the thing at the other end of `baseUrl` is a
 * GTFS Garage server or somebody's own backend implementing the same spec. The
 * server declares it instead, in `GET /api/config`, and a backend that does not
 * answer these paths simply does not set it.
 *
 * A source with no `config` at all is taken at its word: a host that wrote the
 * four methods by hand meant them, and there is nothing to ask.
 *
 * Without this the section would be built and then discovered empty by a 404
 * on every open - working, but by accident, and a failed request each time.
 */
export function showsWorkspace(
  source: unknown,
  config: AppConfig | null | undefined,
): source is WorkspacePort {
  if (!hasWorkspace(source)) return false;
  if (!config) return true;
  return config.workspace === true;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When a feed was last loaded, in words.
 *
 * Relative rather than absolute because the question being asked of this
 * column is "which of these is stale", not "what time was it".
 */
export function formatAge(loadedAt: string | undefined, now = Date.now()): string {
  if (!loadedAt) return "";
  const at = Date.parse(loadedAt);
  if (Number.isNaN(at)) return "";
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  return `${Math.floor(elapsed / DAY)} d ago`;
}

/** The one-line summary above the feed list. */
export function workspaceSummary(workspace: Workspace): string {
  const count = workspace.feeds.length;
  const parts = [
    `${count} ${count === 1 ? "feed" : "feeds"}`,
    formatBytes(workspace.total_bytes),
    // The difference that decides whether anything here survives the session,
    // so it is said on the same line rather than left to be inferred.
    workspace.persistent ? "kept" : "removed on exit",
  ];
  if (workspace.keep > 0) parts.push(`keeping ${workspace.keep}`);
  return parts.join(" · ");
}

export interface FeedRow {
  id: string;
  /** What names the feed, which for a path or URL is its last segment. */
  label: string;
  /** The whole label it came from, shown on hover. */
  source: string;
  detail: string;
  current: boolean;
  /** Whether there is Parquet to reopen it from. */
  reloadable: boolean;
  /** The served feed's files are open, so they cannot be deleted. */
  removable: boolean;
}

/**
 * The part of a label that names the feed.
 *
 * A label is a filename, a folder name, a URL or an absolute path, and the last
 * three are mostly prefix: `/Users/sam/work/transit/2026/montreal.zip` is one
 * useful word behind five that are the same on every row. The whole label stays
 * in the row's tooltip, so nothing is lost - only moved out of the way.
 *
 * Truncating in CSS instead was tried and is worse: ellipsising a path from the
 * front needs `direction: rtl`, which reorders the slashes at the string's
 * edges and renders `/srv/feeds` as `srv/feeds/` - a trailing slash that says
 * "directory" about a file.
 */
export function displayLabel(label: string): string {
  const trimmed = label.replace(/[/\\]+$/, "");
  const segment = trimmed.split(/[/\\]/).pop();
  return segment || label;
}

/** One row per feed, in the order the server listed them: newest first. */
export function feedRows(workspace: Workspace, now = Date.now()): FeedRow[] {
  return workspace.feeds.map((feed: WorkspaceFeed) => ({
    id: feed.id,
    label: displayLabel(feed.label),
    /** The whole label, for the tooltip. */
    source: feed.label,
    detail: [formatBytes(feed.bytes), `${feed.tables} tables`, formatAge(feed.loaded_at, now)]
      .filter(Boolean)
      .join(" · "),
    current: feed.current,
    reloadable: feed.reloadable && !feed.current,
    removable: !feed.current,
  }));
}

/** Why a feed's reload button is unavailable, or "" when it is not. */
export function reloadBlockedReason(row: FeedRow): string {
  if (row.current) return "This is the feed you are looking at.";
  if (!row.reloadable) return "No Parquet to reopen this from - it was loaded with --no-parquet.";
  return "";
}

export class OptionsMenu {
  private workspace: Workspace | null = null;

  constructor(
    private readonly dom: Dom,
    private readonly port: WorkspacePort | null,
    /** Hands a reloaded feed back to the application, as a load would. */
    private readonly onReloaded: () => Promise<void>,
  ) {
    const panel = this.dom.el("options-panel");
    this.dom.el("options-btn").addEventListener("click", () => {
      const opening = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      // Read on open rather than kept in step: the sizes change with every
      // load, and a stale number here is worse than a moment's wait.
      if (opening) void this.refresh();
    });
    this.dom.el("options-close-btn").addEventListener("click", () => panel.classList.add("hidden"));

    if (this.port) {
      this.dom.el("workdir-clear-btn").addEventListener("click", () => void this.clear());
      this.dom.el("workdir-path").addEventListener("click", () => this.copyPath());
    }
  }

  /**
   * Draw the load report for the feed now being served.
   *
   * Called on every load, including one started from this menu. Which feed is
   * open has just changed, so a menu that is on screen is re-read rather than
   * left showing the previous feed as the current one.
   */
  showMetrics(metrics: LoadMetrics, clientMs?: number): void {
    this.dom.el("metrics-section").hidden = false;
    renderMetrics(this.dom, metrics, clientMs);
    if (!this.dom.el("options-panel").classList.contains("hidden")) void this.refresh();
  }

  /** Re-read the workdir, if the menu is showing one. */
  async refresh(): Promise<void> {
    if (!this.port) return;
    try {
      this.workspace = await this.port.workspace();
    } catch {
      // A source that turned out not to have one, or a server that went away.
      // The section stays hidden rather than showing an error for something
      // nobody asked about.
      this.dom.el("workdir-section").hidden = true;
      return;
    }
    this.render();
  }

  private render(): void {
    const workspace = this.workspace;
    if (!workspace) return;

    this.dom.el("workdir-section").hidden = false;
    const path = this.dom.el("workdir-path");
    path.textContent = workspace.path;
    path.title = "Click to copy.";
    this.dom.el("workdir-summary").textContent = workspaceSummary(workspace);

    const list = this.dom.el("workdir-feeds");
    list.innerHTML = "";
    const rows = feedRows(workspace);
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "workdir-empty";
      empty.textContent = "Nothing stored yet.";
      list.appendChild(empty);
    }
    for (const row of rows) {
      list.appendChild(this.feedElement(row));
    }

    this.dom.el<HTMLButtonElement>("workdir-clear-btn").disabled = !rows.some((row) => row.removable);
  }

  private feedElement(row: FeedRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "workdir-feed" + (row.current ? " current" : "");
    element.dataset.el = "workdir-feed";

    const text = document.createElement("div");
    text.className = "workdir-feed-text";
    const label = document.createElement("div");
    label.className = "workdir-feed-label";
    label.textContent = row.label;
    label.title = row.source;
    const detail = document.createElement("div");
    detail.className = "workdir-feed-detail";
    detail.textContent = row.current ? `${row.detail} · open` : row.detail;
    text.append(label, detail);

    const actions = document.createElement("div");
    actions.className = "workdir-feed-actions";

    const reload = button("Reload", "Reopen this feed from the workdir", () => void this.reload(row.id));
    const blocked = reloadBlockedReason(row);
    if (blocked) {
      reload.disabled = true;
      reload.title = blocked;
    }

    const remove = button("×", "Delete this feed's files", () => void this.remove(row.id));
    remove.className = "workdir-remove";
    if (!row.removable) {
      remove.disabled = true;
      remove.title = "This feed is open. Load another one first.";
    }

    actions.append(reload, remove);
    element.append(text, actions);
    return element;
  }

  private async reload(id: string): Promise<void> {
    if (!this.port) return;
    await this.run("Reopening…", async () => {
      await this.port!.reloadFeed(id);
      // The application reloads from the server, so a reopened feed lands the
      // same way a freshly loaded one does - sidebar, map and history included.
      // That also re-reads this list through `showMetrics`, which is what moves
      // the "open" marker onto the row just clicked.
      await this.onReloaded();
    });
  }

  private async remove(id: string): Promise<void> {
    if (!this.port) return;
    await this.run("Removing…", async () => {
      this.workspace = await this.port!.removeFeed(id);
      this.render();
    });
  }

  private async clear(): Promise<void> {
    if (!this.port || !this.workspace) return;
    const removable = feedRows(this.workspace).filter((row) => row.removable);
    if (removable.length === 0) return;
    // Deleting files is not undoable, so it is asked rather than assumed. The
    // count is in the question because "empty the workdir" reads the same
    // whether it means one feed or nine.
    const feeds = `${removable.length} ${removable.length === 1 ? "feed" : "feeds"}`;
    if (!window.confirm(`Delete ${feeds} from the workdir? The feed you are looking at is kept.`)) return;

    await this.run("Emptying…", async () => {
      const before = this.workspace!.total_bytes;
      this.workspace = await this.port!.clearWorkspace();
      this.render();
      const freed = before - this.workspace.total_bytes;
      return freed > 0 ? `Freed ${formatBytes(freed)}.` : "";
    });
  }

  /**
   * Run an action with the buttons disabled, and say so if it fails.
   *
   * What the action returns replaces the busy line, so one with something to
   * report - how much deleting freed - says it, and one with nothing to report
   * clears the line rather than leaving "Emptying…" up for good.
   */
  private async run(busyMessage: string, action: () => Promise<string | void>): Promise<void> {
    this.setBusy(true);
    this.say(busyMessage);
    try {
      this.say((await action()) || "");
    } catch (error) {
      this.say((error as Error).message);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    const section = this.dom.el("workdir-section");
    section.classList.toggle("busy", busy);
    for (const control of section.querySelectorAll("button")) {
      (control as HTMLButtonElement).disabled = busy;
    }
    if (!busy) this.render();
  }

  private say(message: string): void {
    this.dom.el("workdir-status").textContent = message;
  }

  private copyPath(): void {
    const path = this.workspace?.path;
    if (!path) return;
    // Best effort: the clipboard is permissioned, and a path that will not copy
    // is still on screen to be read.
    void navigator.clipboard?.writeText(path).then(
      () => this.say("Path copied."),
      () => undefined,
    );
  }
}
