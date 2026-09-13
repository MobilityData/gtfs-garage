/**
 * Reading newline-delimited JSON as it arrives.
 *
 * A whole-feed map layer is far too large to wait for in one piece, so the
 * server sends a header line and then batches of features. Splitting is its own
 * pure function because chunk boundaries fall wherever the network puts them,
 * almost never on a newline, and that is the part worth testing directly.
 */

/** A message per line: one header, then any number of feature batches. */
export type NdjsonMessage =
  | { type: "header"; total: number; step: number }
  | { type: "batch"; features: GeoFeatureLike[] };

/** Loose on purpose: this layer does not care what is inside a feature. */
export interface GeoFeatureLike {
  type: string;
  geometry: unknown;
  properties: Record<string, string>;
}

export interface SplitResult {
  lines: string[];
  /** The trailing partial line, to be prefixed onto the next chunk. */
  rest: string;
}

export function splitLines(buffer: string): SplitResult {
  const parts = buffer.split("\n");
  // Whatever follows the last newline is incomplete until more arrives - or,
  // if the buffer ended exactly on one, it is the empty string and harmless.
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.length > 0), rest };
}

/**
 * Read a response body as NDJSON, invoking `onMessage` per line.
 *
 * A line that will not parse is skipped rather than thrown: losing one batch of
 * a map layer should not abandon the rest of the feed.
 */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: NdjsonMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { lines, rest } = splitLines(buffer);
    buffer = rest;
    for (const line of lines) {
      try {
        onMessage(JSON.parse(line) as NdjsonMessage);
      } catch {
        /* a malformed line costs one batch, not the whole layer */
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      onMessage(JSON.parse(tail) as NdjsonMessage);
    } catch {
      /* same again for a truncated final line */
    }
  }
}
