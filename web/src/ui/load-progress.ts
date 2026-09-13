/** Turns a load-progress reading into the line shown while a feed opens. */

import { formatBytes } from "./feed-metrics";
import type { LoadProgress } from "../sources/types";

const PHASE_VERBS: Record<LoadProgress["phase"], string> = {
  start: "Loading",
  download: "Downloading",
  upload: "Receiving",
  extract: "Unzipping",
  convert: "Converting",
  summarise: "Counting rows",
  done: "Loading",
};

/**
 * `description` is what the user asked for, used until the server reports a
 * phase - a load has to travel to the server before it can describe itself.
 */
export function progressLine(progress: LoadProgress | null, description: string): string {
  if (!progress || !progress.running) return `Loading ${description}…`;

  // Until the server reaches a phase it can name, keep describing what was
  // asked for: a local path never downloads, and saying so would be a lie.
  if (progress.phase === "start") return `Loading ${description}…`;

  const verb = PHASE_VERBS[progress.phase] ?? "Loading";
  if (progress.phase === "summarise") return `${verb}…`;

  if (progress.phase === "download") {
    // Bytes, and a total only when the server declared a Content-Length.
    const done = formatBytes(progress.done);
    return progress.total > 0 ? `${verb} ${done} of ${formatBytes(progress.total)}` : `${verb} ${done}`;
  }

  const detail = progress.detail ? ` ${progress.detail}` : "";
  if (progress.total > 0) return `${verb}${detail} (${progress.done} of ${progress.total})`;
  return `${verb}${detail}…`;
}
