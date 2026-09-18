/**
 * Mounting a dataset, including the part before there is one.
 *
 * `mount` browses a dataset that exists. A dataset behind an API may not exist
 * yet: it is converted once, and that takes seconds after a download. This
 * waits for it and renders being-prepared, not-prepared and failed in the
 * viewer's own design, so no host writes those three states again.
 *
 * The host supplies facts through `DatasetProvider` and nothing else.
 */

import { decideDataset, type DatasetProvider, type DatasetState } from "./dataset";
import { mount, type Viewer, type ViewerOptions } from "./mount";
import type { ViewerSource } from "./sources/types";
import { progressLine } from "./ui/load-progress";

export type { DatasetProvider, DatasetState } from "./dataset";

const DEFAULT_POLL_MS = 500;

export interface DatasetOptions extends ViewerOptions {
  dataset: DatasetProvider;
  /** How often to ask while the dataset is being prepared. */
  pollMs?: number;
  /** Named in the waiting line - "Loading mdb-1210…". */
  description?: string;
}

/**
 * Which mount currently owns a root.
 *
 * React mounts every effect twice in development, and `mountDataset` resolves a
 * tick after the cleanup that discards the first one. That teardown therefore
 * lands *after* the second mount has drawn into the same node, and clearing the
 * root unconditionally would wipe the live viewer and leave an empty box. A
 * mount only tears down the root it still owns.
 */
const owner = new WeakMap<Element, object>();

/** The waiting states, drawn in the viewer's own colours rather than a host's. */
function statusPanel(root: Element): (text: string, tone?: "normal" | "error") => void {
  root.classList.add("gtfs-viewer");
  root.innerHTML = `<div data-el="dataset-status"><div data-el="empty-state"></div></div>`;
  const line = root.querySelector('[data-el="empty-state"]') as HTMLElement;
  return (text, tone = "normal") => {
    line.textContent = text;
    line.classList.toggle("is-error", tone === "error");
  };
}

/**
 * Returns as soon as there is something to tear down - not when the dataset is
 * ready.
 *
 * A host must be able to abandon a viewer that is still waiting: React unmounts
 * every effect once on mount in development, and a dataset that never becomes
 * ready would otherwise leave a poll running against a viewer nobody can reach.
 */
export async function mountDataset(root: Element, options: DatasetOptions): Promise<Viewer> {
  const { dataset, pollMs = DEFAULT_POLL_MS, description = "the dataset", ...viewer } = options;

  const say = statusPanel(root);
  const claim = {};
  owner.set(root, claim);
  const controller = new AbortController();
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let destroyed = false;
  let mounted: Viewer | undefined;
  /** The source obtained from the provider, which this wrapper must release. */
  let opened: ViewerSource | undefined;
  let asked = false;

  const settle = async (source: ViewerSource) => {
    // Nothing is drawn into a root this mount no longer owns. `mount` replaces
    // the root's contents and its `destroy` clears them again, so a late
    // arrival here would wipe whichever viewer is actually on screen - which
    // showed up as "Missing element table-scroll" from the live one.
    if (destroyed || owner.get(root) !== claim) return void source.close?.();

    // This wrapper asked the provider for the source, so this wrapper closes
    // it. Nothing else can: the host never sees it.
    opened = source;
    const viewerHandle = await mount(root, { ...viewer, source });

    // The host may have given up, or another mount taken the root, while the
    // viewer was opening.
    if (destroyed || owner.get(root) !== claim) viewerHandle.destroy();
    else mounted = viewerHandle;
  };

  const follow = async () => {
    say(`Loading ${description}…`);

    while (!destroyed) {
      let status: DatasetState;
      try {
        status = await dataset.status(controller.signal);
      } catch {
        // A missed poll leaves the previous line up, as a missed load poll
        // does: one failed request does not mean the dataset has gone away.
        await wait(pollMs);
        continue;
      }
      if (destroyed) return;

      const decision = decideDataset(status, {
        description,
        canPrepare: Boolean(dataset.prepare),
        asked,
        phrase: progressLine,
      });

      if (decision.line) say(decision.line, decision.tone === "error" ? "error" : "normal");
      if (decision.prepare && dataset.prepare) {
        asked = true;
        void dataset.prepare(controller.signal).catch((error: Error) => say(error.message, "error"));
      }
      if (decision.source) return settle(decision.source);
      if (decision.settled) return;

      await wait(pollMs);
    }
  };

  void follow();

  return {
    destroy() {
      destroyed = true;
      controller.abort();
      mounted?.destroy();
      // Fire and forget: a caller tearing down a component cannot await, and a
      // failure to release a worker is not something it could act on.
      void opened?.close?.();
      // A later mount has taken the root over: it is drawing there now, so
      // this one leaves the DOM alone and only stops its own polling.
      if (owner.get(root) !== claim) return;
      owner.delete(root);
      root.replaceChildren();
      root.classList.remove("gtfs-viewer");
    },
  };
}
