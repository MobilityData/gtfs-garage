/**
 * The viewer as a React component.
 *
 * A thin wrapper, deliberately: the viewer itself stays framework-agnostic so
 * that one implementation serves both the standalone application and a host
 * that happens to use React. Nothing here knows what the viewer does.
 */

import { useEffect, useRef } from "react";

import type { DatasetOptions } from "./mount-dataset";
import { mountDataset } from "./mount-dataset";
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

export type { DatasetProvider, DatasetState } from "./dataset";

export interface GtfsGarageDatasetProps extends DatasetOptions {
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The viewer, including the wait for a dataset that is still being prepared.
 *
 * The host supplies a `dataset` that reports where things stand; the progress,
 * failure and not-prepared states are drawn here rather than in every host.
 */
export function GtfsGarageDataset({ className, style, ...options }: GtfsGarageDatasetProps) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    let viewer: Viewer | undefined;
    let cancelled = false;

    // `mountDataset` resolves as soon as there is something to tear down, not
    // when the dataset is ready - so an unmount during a long conversion stops
    // the polling rather than leaving it running.
    void mountDataset(root, latest.current).then(
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
