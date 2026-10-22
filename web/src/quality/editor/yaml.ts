/**
 * A guide as YAML, the way the guides in `schema/guides/` are written.
 *
 * Steps are blocks; each locator and each action is one line in flow style, so
 * a step reads top to bottom as a sentence and what illustrates it. Parsing
 * keeps the line of a syntax error, for the advanced editor to point at.
 */

import { Document, isMap, isSeq, parse, YAMLParseError, type Node as YamlNode } from "yaml";
import type { Guide } from "../catalog";
import { cleanGuide } from "./model";

export function guideToYaml(guide: Guide): string {
  const doc = new Document(cleanGuide(guide));
  const root = doc.contents;
  if (isMap(root)) {
    root.items.forEach((pair, index) => {
      if (index > 0) (pair.key as YamlNode).spaceBefore = true;
      const key = String((pair.key as { value?: unknown }).value);
      if (key === "locators" && isMap(pair.value)) {
        for (const locator of pair.value.items) if (isMap(locator.value)) locator.value.flow = true;
      }
      if (key === "steps" && isSeq(pair.value)) {
        pair.value.items.forEach((step, i) => {
          if (!isMap(step)) return;
          if (i > 0) step.spaceBefore = true;
          for (const entry of step.items) {
            const name = String((entry.key as { value?: unknown }).value);
            if ((name === "actions" || name === "clear") && isSeq(entry.value)) {
              if (name === "clear") entry.value.flow = true;
              else for (const action of entry.value.items) if (isMap(action)) action.flow = true;
            }
          }
        });
      }
    });
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}

export type ParsedYaml = { ok: true; value: unknown } | { ok: false; message: string; line: number | null };

export function parseYaml(text: string): ParsedYaml {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const line = error.linePos?.[0]?.line ?? null;
      return { ok: false, message: error.message.split("\n")[0], line };
    }
    return { ok: false, message: (error as Error).message, line: null };
  }
}
