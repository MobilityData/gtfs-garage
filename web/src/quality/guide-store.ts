/**
 * Tours an analyst wrote or changed, over the ones the catalog ships.
 *
 * The catalog's guides are built into the viewer and never change at runtime.
 * A tour saved from the editor is kept by a `GuideStore` and wins over the
 * built-in one for its notice; removing it brings the built-in one back, or,
 * for a notice with none, the walkthrough derived from the sample's fields.
 *
 * `ServerGuideStore` keeps them in the server's workdir, where the Tour Studio
 * and every tab of the viewer read the same ones; `LocalGuideStore` keeps them
 * in this browser, for a viewer with no server behind it. Tabs tell each other
 * when one saves, so a tour saved in the studio is the one Explain plays.
 */

import { fallbackGuide, loadCatalog, type Catalog, type Guide } from "./catalog";
import type { Sample } from "./template";
import type { ViewerSource } from "../sources/types";

export interface SavedGuide {
  guide: Guide;
  /** The YAML as it was saved, comments and all, for exporting it as written. */
  yaml: string;
  /** When, as an ISO timestamp. */
  saved: string;
}

/** Where a notice's tour comes from: saved by an analyst, built in, or derived from its fields. */
export type GuideOrigin = "saved" | "builtin" | "generic";

export interface GuideStore {
  /** Where saved tours are kept, as the editor says it: "this browser". */
  readonly where: string;
  list(): Promise<Record<string, SavedGuide>>;
  save(code: string, saved: SavedGuide): Promise<void>;
  remove(code: string): Promise<void>;
}

const KEY = "gtfs-garage:guides";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Saved tours in `localStorage`: per browser, kept across sessions and feeds. */
export class LocalGuideStore implements GuideStore {
  readonly where = "this browser";
  /** Used when the browser keeps nothing (a private window, storage blocked), so a save still holds for the session. */
  private memory: Record<string, SavedGuide> = {};

  constructor(private readonly storage: Storage | null = browserStorage()) {}

  private read(): Record<string, SavedGuide> {
    try {
      const text = this.storage?.getItem(KEY);
      return text ? (JSON.parse(text) as Record<string, SavedGuide>) : { ...this.memory };
    } catch {
      return { ...this.memory };
    }
  }

  private write(all: Record<string, SavedGuide>): void {
    this.memory = all;
    try {
      this.storage?.setItem(KEY, JSON.stringify(all));
    } catch {
      // Full or blocked: the copy in memory holds until the page is closed.
    }
  }

  async list(): Promise<Record<string, SavedGuide>> {
    return this.read();
  }

  async save(code: string, saved: SavedGuide): Promise<void> {
    this.write({ ...this.read(), [code]: saved });
  }

  async remove(code: string): Promise<void> {
    const all = this.read();
    delete all[code];
    this.write(all);
  }
}

/** Saved tours in the server's workdir, checked by the server as they are saved. */
export class ServerGuideStore implements GuideStore {
  readonly where = "the workdir";

  constructor(private readonly source: Required<Pick<ViewerSource, "savedGuides" | "saveGuide" | "removeSavedGuide">>) {}

  async list(): Promise<Record<string, SavedGuide>> {
    const saved = await this.source.savedGuides();
    return Object.fromEntries(saved.map((entry) => [entry.code, { guide: entry.guide as unknown as Guide, yaml: entry.yaml, saved: entry.saved_at }]));
  }

  async save(code: string, saved: SavedGuide): Promise<void> {
    await this.source.saveGuide(code, saved.yaml);
  }

  async remove(code: string): Promise<void> {
    await this.source.removeSavedGuide(code);
  }
}

/** The store a source can back: the workdir when it has one, else this browser. */
export function guideStoreFor(source: ViewerSource): GuideStore {
  const { savedGuides, saveGuide, removeSavedGuide } = source;
  if (savedGuides && saveGuide && removeSavedGuide) {
    return new ServerGuideStore({
      savedGuides: savedGuides.bind(source),
      saveGuide: saveGuide.bind(source),
      removeSavedGuide: removeSavedGuide.bind(source),
    });
  }
  return new LocalGuideStore();
}

/**
 * Tours saved in this browser before there was a workdir to save them in,
 * moved there: once each, and only where the workdir has none of its own.
 */
export async function moveBrowserTours(from: LocalGuideStore, to: GuideStore): Promise<string[]> {
  if (to instanceof LocalGuideStore) return [];
  const [mine, theirs] = await Promise.all([from.list(), to.list()]);
  const moved: string[] = [];
  for (const [code, saved] of Object.entries(mine)) {
    if (theirs[code]) continue;
    try {
      await to.save(code, saved);
      moved.push(code);
    } catch {
      continue; // The server refused it; it stays in the browser, unused.
    }
  }
  for (const code of moved) await from.remove(code);
  return moved;
}

const CHANNEL = "gtfs-garage:guides";

/** The catalog with saved tours laid over it: what the assistant and the Quality screen read. */
export class GuideLibrary {
  private saved: Record<string, SavedGuide> = {};
  private catalog: Catalog | null = null;
  private loading: Promise<Catalog> | null = null;
  private readonly listeners = new Set<() => void>();

  /** Other tabs of this viewer, told when a tour is saved or removed here. */
  private readonly channel: BroadcastChannel | null;

  constructor(readonly store: GuideStore) {
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    this.channel?.addEventListener("message", () => void this.reload());
  }

  /** Read the saved tours again: another tab saved one. */
  async reload(): Promise<void> {
    this.saved = await this.store.list().catch(() => this.saved);
    this.emit();
  }

  private tell(): void {
    this.channel?.postMessage("changed");
  }

  /** The catalog, once the saved tours are read too. */
  ready(): Promise<Catalog> {
    this.loading ??= Promise.all([loadCatalog(), this.store.list().catch(() => ({}))]).then(([catalog, saved]) => {
      this.saved = saved;
      this.catalog = catalog;
      this.emit();
      return catalog;
    });
    return this.loading;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Where `code`'s tour comes from; before `ready`, only what is known so far. */
  origin(code: string): GuideOrigin {
    if (this.saved[code]) return "saved";
    return this.catalog?.notices[code]?.guide ? "builtin" : "generic";
  }

  savedGuide(code: string): SavedGuide | undefined {
    return this.saved[code];
  }

  /** The tour a notice is explained by: the saved one, else the built-in one, else none. */
  written(catalog: Catalog, code: string): Guide | undefined {
    return this.saved[code]?.guide ?? catalog.notices[code]?.guide;
  }

  /** Like `guideFor` in catalog.ts, with saved tours first. */
  guideFor(catalog: Catalog, code: string, sample: Sample): { guide: Guide; authored: boolean } {
    const written = this.written(catalog, code);
    return written ? { guide: written, authored: true } : { guide: fallbackGuide(code, catalog.notices[code], sample), authored: false };
  }

  async save(code: string, guide: Guide, yaml: string): Promise<void> {
    const saved = { guide, yaml, saved: new Date().toISOString() };
    await this.store.save(code, saved);
    this.saved = { ...this.saved, [code]: saved };
    this.emit();
    this.tell();
  }

  /** Forget the saved tour, so the built-in one, or the derived one, explains the notice again. */
  async remove(code: string): Promise<void> {
    await this.store.remove(code);
    const { [code]: _removed, ...rest } = this.saved;
    this.saved = rest;
    this.emit();
    this.tell();
  }
}
