/** The overlay for opening a feed: drop a zip, pick a file, or give a path or URL. */

import { el } from "../dom";
import type { RestSource } from "../sources/rest";
import type { TablesResponse } from "../sources/types";

const URL_PATTERN = /^https?:\/\//i;

export class FeedLoader {
  private busy = false;

  constructor(
    private readonly source: RestSource,
    private readonly onLoaded: (tables: TablesResponse, clientMs: number) => void,
    /** Whether there is a loaded feed to return to when cancelling. */
    private readonly canCancel: () => boolean,
  ) {
    el("open-load-btn").addEventListener("click", () => this.open());
    el("load-cancel-btn").addEventListener("click", () => this.close());

    const input = el<HTMLInputElement>("path-input");
    // Nothing to submit until something is typed, so the button says so rather
    // than looking available and failing.
    input.addEventListener("input", () => this.syncSubmitState());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submitTyped();
      if (event.key === "Escape" && this.canCancel()) this.close();
    });

    el("load-path-btn").addEventListener("click", () => this.submitTyped());

    const dropzone = el("dropzone");
    const fileInput = el<HTMLInputElement>("file-input");
    const folderInput = el<HTMLInputElement>("folder-input");

    dropzone.addEventListener("click", () => fileInput.click());
    el("pick-file-btn").addEventListener("click", () => fileInput.click());
    el("pick-folder-btn").addEventListener("click", () => folderInput.click());

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

    el<HTMLInputElement>("file-input").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.load(() => this.source.load({ file }), file.name);
    });
  }

  open(): void {
    el("load-overlay").classList.remove("hidden");
    el("load-error").textContent = "";
    this.syncSubmitState();
    el<HTMLInputElement>("path-input").focus();
  }

  close(): void {
    el("load-overlay").classList.add("hidden");
  }

  /**
   * A chosen folder arrives as its individual files. Only the feed's own files
   * are sent: a folder can also hold documentation, archives or editor cruft,
   * and uploading those would be slow for nothing.
   */
  private async loadFolder(chosen: File[]): Promise<void> {
    const files = chosen.filter((file) => /\.(txt|geojson)$/i.test(file.name));
    if (files.length === 0) {
      el("load-error").textContent = "That folder has no GTFS .txt files in it.";
      return;
    }

    // webkitRelativePath is "folder/stops.txt"; the first segment names the folder.
    const relative = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const name = relative?.split("/")[0] || "chosen folder";

    await this.load(() => this.source.load({ files, name }), name);
  }

  /** A path or URL is sent to a different parameter, so the server knows which. */
  private submitTyped(): void {
    const value = el<HTMLInputElement>("path-input").value.trim();
    if (!value || this.busy) return;

    const request = URL_PATTERN.test(value)
      ? () => this.source.load({ url: value })
      : () => this.source.load({ path: value });
    void this.load(request, value);
  }

  private syncSubmitState(): void {
    const empty = el<HTMLInputElement>("path-input").value.trim() === "";
    el<HTMLButtonElement>("load-path-btn").disabled = empty || this.busy;
    // Cancelling into an empty app would leave nothing to look at.
    el<HTMLButtonElement>("load-cancel-btn").hidden = !this.canCancel();
  }

  private async load(request: () => Promise<TablesResponse>, description: string): Promise<void> {
    this.busy = true;
    this.syncSubmitState();
    el("load-error").textContent = "";
    el("load-status").textContent = `Loading ${description}...`;

    try {
      // The only number the server cannot report: what the user actually
      // waited for, upload and response included.
      const started = performance.now();
      const tables = await request();
      this.onLoaded(tables, performance.now() - started);
      this.close();
    } catch (error) {
      el("load-error").textContent = (error as Error).message;
    } finally {
      this.busy = false;
      el("load-status").textContent = "";
      this.syncSubmitState();
    }
  }
}
