/**
 * The Tour Studio's source: one feed at a time, switched between the server's
 * own and a demo's, without the server switching anything.
 *
 * The server answers the reading API for each demo beside its own feed (see
 * `server/demo_feeds.py`), so the studio reads a demo through a second REST
 * source rather than asking the server to load it. The viewer is mounted once,
 * on this; `use` points the reading methods at another feed, and the host
 * reloads what it shows. What is about the server rather than a feed - the
 * workdir, the demos, the saved tours, the config - is always asked of the
 * server's own source.
 */

import type { ViewerSource } from "../sources/types";

/** Methods answered by the server itself, whichever feed is being read. */
const SERVER: ReadonlySet<string> = new Set([
  "config",
  "workspace",
  "reloadFeed",
  "removeFeed",
  "clearWorkspace",
  "setStartupFeed",
  "demos",
  "demoReport",
  "demoTables",
  "demoSource",
  "addDemo",
  "removeDemo",
  "savedGuides",
  "saveGuide",
  "removeSavedGuide",
  "loadProgress",
  "load",
]);

export interface StudioSource extends ViewerSource {
  /** Read from `feed` from now on: the server's own (null) or a demo's. */
  use(feed: string | null): void;
  /** The demo being read, or null for the server's own feed. */
  readonly reading: string | null;
}

export function studioSource(home: ViewerSource): StudioSource {
  let current: ViewerSource = home;
  let reading: string | null = null;
  const target = (key: string) => (SERVER.has(key) ? home : current);
  return new Proxy({} as StudioSource, {
    get(_, key) {
      if (key === "use") {
        return (feed: string | null) => {
          if (feed && !home.demoSource) throw new Error("This server has no demo feeds.");
          current = feed ? home.demoSource!(feed) : home;
          reading = feed;
        };
      }
      if (key === "reading") return reading;
      if (typeof key !== "string") return undefined;
      const owner = target(key) as unknown as Record<string, unknown>;
      const value = owner[key];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(owner) : value;
    },
    has(_, key) {
      return typeof key === "string" && (key === "use" || key === "reading" || key in target(key));
    },
  });
}
