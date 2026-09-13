import { describe, expect, it, vi } from "vitest";

import { readNdjson, splitLines, type NdjsonMessage } from "./ndjson";

/** Feeds bytes through the reader in whatever chunks a test asks for. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

describe("splitLines", () => {
  it("returns whole lines and keeps the partial tail back", () => {
    expect(splitLines('{"a":1}\n{"b":2}\n{"c":')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c":',
    });
  });

  it("leaves nothing behind when the buffer ends on a newline", () => {
    expect(splitLines('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: "" });
  });

  it("holds everything back when no line is complete yet", () => {
    expect(splitLines('{"a"')).toEqual({ lines: [], rest: '{"a"' });
  });

  it("drops blank lines rather than passing them on as parse failures", () => {
    expect(splitLines("a\n\nb\n").lines).toEqual(["a", "b"]);
  });
});

describe("readNdjson", () => {
  it("reassembles messages split across chunk boundaries", async () => {
    const seen: NdjsonMessage[] = [];
    // The newline falls mid-chunk twice, which is the normal case on a socket.
    await readNdjson(
      streamOf(['{"type":"header","to', 'tal":2,"step":1}\n{"type":"batch","fea', 'tures":[1,2]}\n']),
      (m) => seen.push(m),
    );
    expect(seen).toEqual([
      { type: "header", total: 2, step: 1 },
      { type: "batch", features: [1, 2] },
    ]);
  });

  it("reads a final line that arrived without a trailing newline", async () => {
    const seen: NdjsonMessage[] = [];
    await readNdjson(streamOf(['{"type":"header","total":7,"step":4}']), (m) => seen.push(m));
    expect(seen).toEqual([{ type: "header", total: 7, step: 4 }]);
  });

  it("skips a malformed line instead of abandoning the layer", async () => {
    const seen: NdjsonMessage[] = [];
    await readNdjson(streamOf(['{"type":"header","total":1}\n', "not json\n", '{"type":"batch","features":[]}\n']), (m) =>
      seen.push(m),
    );
    expect(seen.map((m) => m.type)).toEqual(["header", "batch"]);
  });

  it("delivers each batch as it arrives, not all at the end", async () => {
    const onMessage = vi.fn();
    const chunks = ['{"type":"header","total":2}\n', '{"type":"batch","features":[1]}\n'];
    await readNdjson(streamOf(chunks), onMessage);
    // Two calls, not one combined delivery: the map redraws per batch.
    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});
