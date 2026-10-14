/**
 * The overlay for opening a feed: one the workdir already holds, a dropped zip,
 * a chosen file or folder, or a path or URL.
 *
 * The workdir list is first because it is the cheapest answer - the feed is
 * already Parquet - and the only part that exists locally only: `port` is null
 * unless the source has a workdir, and the section is then not shown.
 */

import { button, type Dom } from "../dom";
import type { RestSource } from "../sources/rest";
import type { TablesResponse } from "../sources/types";
import { progressLine } from "./load-progress";
import { offerableFeeds, type WorkspacePort } from "./options-menu";

const URL_PATTERN = /^https?:\/\//i;

/** How often the server is asked where the load has got to. */
const PROGRESS_POLL_MS = 400;

export class FeedLoader {
  private busy = false;

  constructor(
    private readonly dom: Dom,
    private readonly source: RestSource,
    private readonly onLoaded: (tables: TablesResponse, clientMs: number) => void,
    /** Whether there is a loaded feed to return to when cancelling. */
    private readonly canCancel: () => boolean,
    /** The workdir to offer feeds from, or null where there is none. */
    private readonly port: WorkspacePort | null = null,
  ) {
    this.dom.el("open-load-btn").addEventListener("click", () => this.open());
    this.dom.el("load-cancel-btn").addEventListener("click", () => this.close());

    const input = this.dom.el<HTMLInputElement>("path-input");
    // Nothing to submit until something is typed, so the button says so rather
    // than looking available and failing.
    input.addEventListener("input", () => this.syncSubmitState());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submitTyped();
      if (event.key === "Escape" && this.canCancel()) this.close();
    });

    this.dom.el("load-path-btn").addEventListener("click", () => this.submitTyped());

    const dropzone = this.dom.el("dropzone");
    const fileInput = this.dom.el<HTMLInputElement>("file-input");
    const folderInput = this.dom.el<HTMLInputElement>("folder-input");

    dropzone.addEventListener("click", () => fileInput.click());
    this.dom.el("pick-file-btn").addEventListener("click", () => fileInput.click());
    this.dom.el("pick-folder-btn").addEventListener("click", () => folderInput.click());

    folderInput.addEventListener("change", (event) => {
      const chosen = Array.from((event.target as HTMLInputElement).files ?? []);
      if (chosen.length) void this.loadFolder(chosen);
    });

    for (const event of ["dragenter", "dragover"]) {
      dropzone.addEventListener(event, (e) => {
        e.preventDefault();
        dropzone.classList.add("drag");
      });
    }
    for (const event of ["dragleave", "drop"]) {
      dropzone.addEventListener(event, (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag");
      });
    }
    dropzone.addEventListener("drop", (event) => {
      const file = (event as DragEvent).dataTransfer?.files[0];
      if (file) void this.load(() => this.source.load({ file }), file.name);
    });

    this.dom.el<HTMLInputElement>("file-input").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.load(() => this.source.load({ file }), file.name);
    });
  }

  open(): void {
    this.dom.el("load-overlay").classList.remove("hidden");
    this.dom.el("load-error").textContent = "";
    this.syncSubmitState();
    void this.showRecent();
    this.dom.el<HTMLInputElement>("path-input").focus();
  }

  /**
   * Offer the feeds already in the workdir. Read on every open: one can have
   * been deleted or evicted since the last time anyone looked.
   */
  private async showRecent(): Promise<void> {
    const section = this.dom.el("recent-section");
    if (!this.port) return;

    let rows;
    try {
      rows = offerableFeeds(await this.port.workspace());
    } catch {
      // Every other way of opening a feed is still on screen and still works.
      section.hidden = true;
      return;
    }

    const list = this.dom.el("recent-feeds");
    list.innerHTML = "";
    section.hidden = rows.length === 0;
    for (const row of rows) {
      const entry = button(row.label, `${row.source}\n${row.detail}`, () => void this.reopen(row.id));
      entry.className = "recent-feed";
      const detail = document.createElement("span");
      detail.className = "recent-feed-detail";
      detail.textContent = row.detail;
      entry.appendChild(detail);
      list.appendChild(entry);
    }
  }

  /** Reopen a stored feed, through the same path as any other load. */
  private async reopen(id: string): Promise<void> {
    if (!this.port || this.busy) return;
    await this.load(() => this.port!.reloadFeed(id) as Promise<TablesResponse>, "from the workdir");
  }

  close(): void {
    this.dom.el("load-overlay").classList.add("hidden");
  }

  /**
   * A chosen folder arrives as its individual files. Only the feed's own files
   * are sent: a folder can also hold documentation, archives or editor cruft,
   * and uploading those would be slow for nothing.
   */
  private async loadFolder(chosen: File[]): Promise<void> {
    const files = chosen.filter((file) => /\.(txt|geojson)$/i.test(file.name));
    if (files.length === 0) {
      this.dom.el("load-error").textContent = "That folder has no GTFS .txt files in it.";
      return;
    }

    // webkitRelativePath is "folder/stops.txt"; the first segment names the folder.
    const relative = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const name = relative?.split("/")[0] || "chosen folder";

    await this.load(() => this.source.load({ files, name }), name);
  }

  /** A path or URL is sent to a different parameter, so the server knows which. */
  private submitTyped(): void {
    const value = this.dom.el<HTMLInputElement>("path-input").value.trim();
    if (!value || this.busy) return;

    const request = URL_PATTERN.test(value)
      ? () => this.source.load({ url: value })
      : () => this.source.load({ path: value });
    void this.load(request, value);
  }

  private syncSubmitState(): void {
    const empty = this.dom.el<HTMLInputElement>("path-input").value.trim() === "";
    this.dom.el<HTMLButtonElement>("load-path-btn").disabled = empty || this.busy;
    // Cancelling into an empty app would leave nothing to look at.
    this.dom.el<HTMLButtonElement>("load-cancel-btn").hidden = !this.canCancel();
  }

  /**
   * Poll the server for the load's phase until it is told to stop.
   *
   * Only answerable because the load runs in a worker thread: on the event
   * loop it would block every other request, including this poll.
   */
  private pollProgress(description: string): () => void {
    let stopped = false;
    const tick = async (): Promise<void> => {
      while (!stopped) {
        try {
          const progress = await this.source.loadProgress();
          if (!stopped) this.dom.el("load-status").textContent = progressLine(progress, description);
        } catch {
          /* a missed poll just leaves the previous line up */
        }
        await new Promise((resolve) => window.setTimeout(resolve, PROGRESS_POLL_MS));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }

  private async load(request: () => Promise<TablesResponse>, description: string): Promise<void> {
    this.busy = true;
    this.syncSubmitState();
    this.dom.el("load-error").textContent = "";
    this.dom.el("load-status").textContent = `Loading ${description}…`;
    const stopPolling = this.pollProgress(description);

    try {
      // The only number the server cannot report: what the user actually
      // waited for, upload and response included.
      const started = performance.now();
      const tables = await request();
      this.onLoaded(tables, performance.now() - started);
      this.close();
    } catch (error) {
      this.dom.el("load-error").textContent = (error as Error).message;
    } finally {
      stopPolling();
      this.busy = false;
      this.dom.el("load-status").textContent = "";
      this.syncSubmitState();
    }
  }
}
