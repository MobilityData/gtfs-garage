/**
 * The options menu: what this tool has put on your machine, and what to do
 * about it. The workdir and the load report answer the same question, so they
 * sit behind one button.
 *
 * The exported functions decide and the class draws, the same split as
 * `values.ts` and `table.ts`, so the decisions are testable without a document.
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
  /**
   * Name the feed a new server on this workdir opens, or clear it with null.
   *
   * Optional where the other four are not: it adds one control to a feed's
   * row rather than deciding whether the section is worth drawing, so a source
   * written before it exists keeps everything else.
   */
  setStartupFeed?(id: string | null): Promise<Workspace>;
}

/** True when a source can answer for a workdir. All four or none: a section
 * with half its buttons dead is worse than no section. */
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
 * Both questions have to be answered. `RestSource` carries the four methods
 * whatever is behind `baseUrl`, because it is written against the whole
 * contract - so the server declares it in `GET /api/config` instead, and a
 * backend that does not serve those paths does not set it. A source with no
 * `config` at all is taken at its word.
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

/** When a feed was last loaded. Relative, because the question is "which of
 * these is stale", not "what time was it". */
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
  /**
   * Whether it can be the feed a new server opens. The same Parquet question
   * as `reloadable`, but asked of the feed on screen too: wanting to come back
   * to what you are looking at is the ordinary reason to set this.
   */
  startable: boolean;
  /** Whether it is the feed a new server on this workdir opens. */
  startup: boolean;
}

/**
 * The part of a label that names the feed - its last segment, since a path or
 * URL is mostly prefix. The whole label stays in the row's tooltip.
 *
 * Not done in CSS: ellipsising from the front needs `direction: rtl`, which
 * reorders the slashes at the edges and renders `/srv/feeds` as `srv/feeds/`.
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
    startable: feed.reloadable,
    startup: feed.startup,
  }));
}

/**
 * The feeds worth offering as a one-click reopen: the ones with Parquet behind
 * them, capped, since a workdir kept with `--workdir-keep 0` holds dozens.
 */
export function offerableFeeds(workspace: Workspace, limit = 5, now = Date.now()): FeedRow[] {
  return feedRows(workspace, now)
    .filter((row) => row.reloadable)
    .slice(0, limit);
}

/** Why a feed's reload button is unavailable, or "" when it is not. */
export function reloadBlockedReason(row: FeedRow): string {
  if (row.current) return "This is the feed you are looking at.";
  if (!row.reloadable) return "No Parquet to reopen this from - it was loaded with --no-parquet.";
  return "";
}

/**
 * Whether the rows get a startup control at all.
 *
 * Two reasons they might not. A workdir that goes when the process does has no
 * later run to open anything, so the choice would be stored into a directory
 * about to be deleted. And a host's own source need not implement the call -
 * the rest of the section still works without it.
 */
export function showsStartup(
  workspace: Workspace,
  port: WorkspacePort | null,
): boolean {
  return workspace.persistent && typeof port?.setStartupFeed === "function";
}

/**
 * What the startup button says it will do, so the state is readable without
 * having to work out which of the rows is the marked one.
 */
export function startupTitle(row: FeedRow): string {
  if (!row.startable) return "No Parquet to open this from - it was loaded with --no-parquet.";
  if (row.startup) return "Opened when a server starts on this workdir. Click to stop.";
  return "Open this feed when a server starts on this workdir.";
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
   * Draw the load report for the feed now being served. Which feed is open has
   * just changed, so a menu already on screen is re-read rather than left
   * marking the previous one as current.
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

    actions.append(...this.startupButton(row), reload, remove);
    element.append(text, actions);
    return element;
  }

  /**
   * The "At startup" toggle, or nothing where there is nothing for it to do.
   *
   * A list rather than an element or null, so the caller appends it without a
   * branch of its own.
   */
  private startupButton(row: FeedRow): HTMLButtonElement[] {
    if (!this.workspace || !showsStartup(this.workspace, this.port)) return [];

    const element = button("At startup", startupTitle(row), () =>
      // Clicking the marked feed clears the choice: one button, and the state
      // it is in says which of the two it will do.
      void this.chooseStartup(row.startup ? null : row.id),
    );
    element.className = "workdir-startup" + (row.startup ? " on" : "");
    element.setAttribute("aria-pressed", String(row.startup));
    element.disabled = !row.startable;
    return [element];
  }

  private async chooseStartup(id: string | null): Promise<void> {
    const set = this.port?.setStartupFeed;
    if (!this.port || !set) return;
    await this.run(id ? "Setting…" : "Clearing…", async () => {
      this.workspace = await set.call(this.port, id);
      this.render();
    });
  }

  private async reload(id: string): Promise<void> {
    if (!this.port) return;
    await this.run("Reopening…", async () => {
      await this.port!.reloadFeed(id);
      // Lands the same way a freshly loaded feed does - sidebar, map, history -
      // and re-reads this list through `showMetrics`, moving the "open" marker.
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
    // The count is in the question because "empty the workdir" reads the same
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
   * Run an action with the buttons disabled, and say so if it fails. What it
   * returns replaces the busy line, so "Emptying…" is not left up for good.
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
