/**
 * The tour layer: the assistant's card, floating beside what a step points at.
 *
 * A step points at rows, at the map, or at nothing. The layer dims the rest of
 * the viewer, cuts a hole over each surface the step is using - both the rows
 * and the map when they move together - rings them, and places the card where
 * it covers neither, with an arrow at the one it is about. The dim takes no
 * clicks: the reader can still scroll the table or pan the map mid-step.
 *
 * Targets are looked up again on every placement rather than held, because the
 * table is redrawn and the panes resize under the card.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Side = "top" | "bottom" | "left" | "right";

export interface Placement {
  left: number;
  top: number;
  /** The side of the anchor the card sits on, or null when it points at nothing. */
  side: Side | null;
  /** Where along the card's facing edge the arrow sits, in pixels from its start. */
  arrow: number;
}

/** What a step points at, measured in the page's coordinates. */
export interface Targets {
  anchor: Rect | null;
  /** Every surface the step uses, holes in the dim; the anchor is usually one. */
  spots: Rect[];
  /** The anchor is a whole pane, not a thing in it: the card goes inside it. */
  inside?: boolean;
}

const GAP = 14;
const MARGIN = 8;
const ARROW_INSET = 18;
/** Narrower than this, the card docks at the bottom instead of floating. */
export const DOCK_BELOW_WIDTH = 640;

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function inset(r: Rect, fraction: number): Rect {
  return {
    left: r.left + r.width * fraction,
    top: r.top + r.height * fraction,
    width: r.width * (1 - 2 * fraction),
    height: r.height * (1 - 2 * fraction),
  };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * Where the card goes: beside the anchor, on the side where it fits and covers
 * the least of what the step is showing.
 *
 * Each side is tried with the card centred on the anchor and then held inside
 * the bounds. A side the card does not fit on loses to any side it does; among
 * those, the one covering the least of the spots wins. When the anchor fills
 * so much that no side fits - a map across the whole viewer - the card goes
 * inside it, beside its middle, where what a map step frames is drawn.
 */
export function placeCard(
  anchor: Rect | null,
  card: { width: number; height: number },
  bounds: Rect,
  spots: Rect[],
  inside = false,
): Placement {
  const maxLeft = bounds.left + bounds.width - card.width - MARGIN;
  const maxTop = bounds.top + bounds.height - card.height - MARGIN;
  if (!anchor || bounds.width < DOCK_BELOW_WIDTH) {
    // Nothing to point at: the middle, or the bottom of a narrow viewer.
    const middle = bounds.top + (bounds.height - card.height) / 2;
    return {
      left: clamp(bounds.left + (bounds.width - card.width) / 2, bounds.left + MARGIN, maxLeft),
      top: anchor || bounds.width < DOCK_BELOW_WIDTH ? maxTop : clamp(middle, bounds.top + MARGIN, maxTop),
      side: null,
      arrow: 0,
    };
  }

  const attempt = (target: Rect, avoid: Rect[]) => {
    const centreX = target.left + target.width / 2;
    const centreY = target.top + target.height / 2;
    const raw: Record<Side, [number, number]> = {
      bottom: [centreX - card.width / 2, target.top + target.height + GAP],
      top: [centreX - card.width / 2, target.top - GAP - card.height],
      right: [target.left + target.width + GAP, centreY - card.height / 2],
      left: [target.left - GAP - card.width, centreY - card.height / 2],
    };
    let best: (Placement & { score: number }) | null = null;
    for (const side of ["bottom", "right", "left", "top"] as Side[]) {
      const [x, y] = raw[side];
      const vertical = side === "bottom" || side === "top";
      // Centred on the anchor first, then slid along the anchor's edge clear
      // of each spot - beside a map, below the rows that share the step.
      const slides = [vertical ? x : y];
      for (const spot of avoid) {
        if (vertical) slides.push(spot.left + spot.width + GAP, spot.left - GAP - card.width);
        else slides.push(spot.top + spot.height + GAP, spot.top - GAP - card.height);
      }
      for (const slide of slides) {
        const left = clamp(vertical ? slide : x, bounds.left + MARGIN, maxLeft);
        const top = clamp(vertical ? y : slide, bounds.top + MARGIN, maxTop);
        // Fitting is about the axis the card moves away on: below the anchor
        // must not be pushed back up over it, beside it not back over it.
        const fits = vertical ? top === y : left === x;
        const box = { left, top, width: card.width, height: card.height };
        // The card must still reach the anchor along the edge it sits on.
        const reaches = vertical
          ? left < target.left + target.width && left + card.width > target.left
          : top < target.top + target.height && top + card.height > target.top;
        const covered = avoid.reduce((sum, spot) => sum + overlap(box, spot), 0) + overlap(box, target) * 4;
        const score = (fits && reaches ? 0 : 1e12) + covered;
        if (!best || score < best.score) {
          const along = vertical ? centreX - left : centreY - top;
          const length = vertical ? card.width : card.height;
          best = { left, top, side, arrow: clamp(along, ARROW_INSET, length - ARROW_INSET), score };
        }
      }
    }
    return best!;
  };

  if (!inside) {
    const outside = attempt(anchor, spots);
    if (outside.score < 1e12) return strip(outside);
  }
  // Inside: beside the middle of the anchor, which is what it frames.
  const middle = inset(anchor, 0.3);
  const others = spots.filter((spot) => overlap(spot, anchor) < area(spot) * 0.5);
  return strip(attempt(middle, others));
}

function strip(placement: Placement & { score: number }): Placement {
  return { left: placement.left, top: placement.top, side: placement.side, arrow: placement.arrow };
}

/** The smallest rectangle holding all of these, or null for none. */
export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** The part of `r` inside `within`, or null when they do not meet. */
export function intersect(r: Rect, within: Rect): Rect | null {
  const left = Math.max(r.left, within.left);
  const top = Math.max(r.top, within.top);
  const right = Math.min(r.left + r.width, within.left + within.width);
  const bottom = Math.min(r.top + r.height, within.top + within.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

const SVG = "http://www.w3.org/2000/svg";
const PAD = 4;

export class TourLayer {
  private find: (() => Targets) | null = null;
  private frame: number | null = null;
  private readonly observer: ResizeObserver | null;
  private readonly onChange = () => this.schedule();

  constructor(
    /** The element the layer covers and positions within. */
    private readonly host: HTMLElement,
    private readonly layer: HTMLElement,
    private readonly card: HTMLElement,
  ) {
    this.observer = typeof ResizeObserver === "function" ? new ResizeObserver(this.onChange) : null;
  }

  /** Float the card beside what `find` returns, and keep it there until `hide`. */
  point(find: () => Targets): void {
    this.find = find;
    this.card.hidden = false;
    this.card.classList.remove("assistant-docked");
    this.layer.hidden = false;
    this.listen();
    this.place();
  }

  /** The card alone, docked in a corner with nothing dimmed: for a detour or a missing report. */
  dock(): void {
    this.find = null;
    this.unlisten();
    this.layer.hidden = true;
    this.card.hidden = false;
    this.card.classList.add("assistant-docked");
    this.card.removeAttribute("data-side");
    this.card.style.left = "";
    this.card.style.top = "";
  }

  hide(): void {
    this.find = null;
    this.unlisten();
    this.layer.hidden = true;
    this.card.hidden = true;
  }

  /** Place again soon: the card's contents or a pane changed size. */
  schedule(): void {
    if (this.frame !== null || !this.find) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.place();
    });
  }

  private listening = false;

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("resize", this.onChange);
    // Capture, because the scroll that moves the rows is the table's own.
    this.host.addEventListener("scroll", this.onChange, true);
    this.observer?.observe(this.host);
    this.observer?.observe(this.card);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("resize", this.onChange);
    this.host.removeEventListener("scroll", this.onChange, true);
    this.observer?.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private place(): void {
    if (!this.find) return;
    const origin = this.host.getBoundingClientRect();
    const local = (r: Rect): Rect => ({ left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
    const bounds: Rect = { left: 0, top: 0, width: origin.width, height: origin.height };
    const found = this.find();
    const spots = found.spots.map(local);
    const anchor = found.anchor ? local(found.anchor) : null;

    this.drawDim(bounds, spots);
    const card = { width: this.card.offsetWidth, height: this.card.offsetHeight };
    const placement = placeCard(anchor, card, bounds, spots, found.inside);
    this.card.style.left = `${Math.round(placement.left)}px`;
    this.card.style.top = `${Math.round(placement.top)}px`;
    if (placement.side) {
      this.card.dataset.side = placement.side;
      this.card.style.setProperty("--arrow", `${Math.round(placement.arrow)}px`);
    } else {
      this.card.removeAttribute("data-side");
    }
  }

  /** The dim, with a hole and a ring over each spot. */
  private drawDim(bounds: Rect, spots: Rect[]): void {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "tour-dim");
    svg.setAttribute("width", String(bounds.width));
    svg.setAttribute("height", String(bounds.height));
    const holes = spots.map((spot) => ({
      left: spot.left - PAD,
      top: spot.top - PAD,
      width: spot.width + PAD * 2,
      height: spot.height + PAD * 2,
    }));
    const rect = (r: Rect) => `M${r.left},${r.top}h${r.width}v${r.height}h${-r.width}z`;
    const shade = document.createElementNS(SVG, "path");
    shade.setAttribute("d", [rect(bounds), ...holes.map(rect)].join(""));
    shade.setAttribute("fill-rule", "evenodd");
    shade.setAttribute("class", "tour-shade");
    svg.append(shade);
    for (const hole of holes) {
      const ring = document.createElementNS(SVG, "rect");
      for (const [name, value] of Object.entries({ x: hole.left, y: hole.top, width: hole.width, height: hole.height, rx: 6 })) {
        ring.setAttribute(name, String(value));
      }
      ring.setAttribute("class", "tour-ring");
      svg.append(ring);
    }
    this.layer.replaceChildren(svg);
  }
}
