/**
 * The validator's description of a rule, as blocks: paragraphs, and tables.
 *
 * The build turns the HTML tables a few descriptions carry into lines of cells
 * separated by " | " (see `plain` in `scripts/build_guides.py`), one row per
 * line, the first row the header. Shown as text those read as a run of pipes;
 * these blocks are what lets the card and the Quality screen draw them as the
 * tables they were.
 */

import { node } from "../ui/html";

export type DescriptionBlock = { kind: "paragraph"; text: string } | { kind: "table"; header: string[]; rows: string[][] };

const CELL = " | ";

function isTableLine(line: string): boolean {
  return line.includes(CELL);
}

export function descriptionBlocks(text: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length > 1 && lines.every(isTableLine)) {
      const [header, ...rows] = lines.map((line) => line.split(CELL).map((cell) => cell.trim()));
      blocks.push({ kind: "table", header, rows });
    } else {
      blocks.push({ kind: "paragraph", text: lines.join("\n") });
    }
  }
  return blocks;
}

export function renderBlock(block: DescriptionBlock): HTMLElement {
  if (block.kind === "paragraph") return node("p", { class: "assistant-description", text: block.text });
  return node("div", { class: "assistant-scroll" }, [
    node("table", { class: "assistant-compare rule-table" }, [
      node("thead", {}, [node("tr", {}, block.header.map((cell) => node("th", { text: cell })))]),
      node("tbody", {}, block.rows.map((row) => node("tr", {}, row.map((cell) => node("td", { text: cell }))))),
    ]),
  ]);
}

/** A description drawn as its blocks. */
export function renderDescription(text: string): HTMLElement[] {
  return descriptionBlocks(text).map(renderBlock);
}

/**
 * The first sentence of a description, for a step that has to say it in one.
 *
 * Within the first paragraph only: a sentence that introduces a table ends at
 * its colon, and the table is shown under it rather than run into it.
 */
export function firstSentence(text: string): string {
  const paragraph = text.trim().split(/\n\s*\n/)[0] ?? "";
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(paragraph);
  return (match ? match[0] : paragraph).replace(/\s*\n\s*/g, " ").trim();
}
