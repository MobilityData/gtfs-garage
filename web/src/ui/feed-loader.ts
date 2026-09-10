/** The overlay for opening a feed: drop a zip, pick a file, or paste a path. */

import { el } from "../dom";
import type { RestSource } from "../sources/rest";
import type { TablesResponse } from "../sources/types";

export class FeedLoader {
  constructor(
    private readonly source: RestSource,
    private readonly onLoaded: (tables: TablesResponse) => void,
  ) {
    el("open-load-btn").addEventListener("click", () => this.open());

    const dropzone = el("dropzone");
    dropzone.addEventListener("click", () => el<HTMLInputElement>("file-input").click());

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
      if (file) void this.load(() => this.source.load({ file }));
    });

    el<HTMLInputElement>("file-input").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) void this.load(() => this.source.load({ file }));
    });

    el("load-path-btn").addEventListener("click", () => {
      const path = el<HTMLInputElement>("path-input").value.trim();
      if (path) void this.load(() => this.source.load({ path }));
    });
  }

  open(): void {
    el("load-overlay").classList.remove("hidden");
  }

  close(): void {
    el("load-overlay").classList.add("hidden");
  }

  private async load(loader: () => Promise<TablesResponse>): Promise<void> {
    el("load-error").textContent = "";
    try {
      this.onLoaded(await loader());
      this.close();
    } catch (error) {
      el("load-error").textContent = (error as Error).message;
    }
  }
}
