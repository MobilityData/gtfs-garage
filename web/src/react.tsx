/**
 * The viewer as a React component.
 *
 * A thin wrapper, deliberately: the viewer itself stays framework-agnostic so
 * that one implementation serves both the standalone application and a host
 * that happens to use React. Nothing here knows what the viewer does.
 */

import { useEffect, useRef } from "react";

import { mount, type Viewer, type ViewerOptions } from "./mount";

export type { ViewerOptions, Viewer, ViewerParts, ViewerSource, GtfsSource } from "./mount";

export interface GtfsGarageProps extends ViewerOptions {
  className?: string;
  /**
   * The viewer fills its container, and a container with no height renders an
   * invisible map. The host decides the box, so it has to give it a size.
   */
  style?: React.CSSProperties;
}

export function GtfsGarage({ className, style, ...options }: GtfsGarageProps) {
  const container = useRef<HTMLDivElement>(null);
  // Held in a ref so that changing an option does not tear the viewer down: the
  // effect below deliberately runs once, and re-running it would drop the map
  // and the user's place in the feed.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    let viewer: Viewer | undefined;
    let cancelled = false;

    // `mount` is asynchronous - it fetches a basemap style and the feed's
    // tables - and React unmounts every effect once on mount in development.
    // Without the flag, the viewer created by the discarded first run would
    // survive the cleanup that was supposed to remove it.
    void mount(root, latest.current).then(
      (mounted) => (cancelled ? mounted.destroy() : (viewer = mounted)),
      (error) => console.error("GTFS Garage failed to mount:", error),
    );

    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, []);

  return <div ref={container} className={className} style={{ height: "100%", ...style }} />;
}
