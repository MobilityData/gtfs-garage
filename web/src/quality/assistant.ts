/**
 * The Quality assistant: walks a reader through one notice, step by step.
 *
 * A step is one sentence and the actions that illustrate it. Each step is a
 * view in the history - its table or screen plus `assist` naming the step - so
 * it goes through the navigator like any other view, Back steps backwards, and
 * a link reopens the step it was copied from. What a view cannot carry (the
 * marks on the table, the annotation on the map, the panel) is applied here,
 * once the view's content has loaded:
 *
 *     go(step view) -> navigator -> prepare(view) -> loadPage(view) -> show(view)
 *
 * The walkthrough stays active while the reader wanders off - following a link
 * out of a step leaves the card docked in a corner, offering the way back -
 * until they exit it.
 *
 * The card floats beside what the step points at, over a dim with holes cut
 * for the rows and the map the step is using (see `tour.ts`). The arrow keys
 * step through, Escape leaves.
 */

import type { Dom } from "../dom";
import type { MapHandle } from "../mount";
import type { ViewerSource } from "../sources/types";
import type { AppState, View } from "../state";
import type { MapSelection } from "../ui/files-map";
import { node, prose } from "../ui/html";
import {
  contentDate,
  contentTarget,
  runMapActions,
  runPanelActions,
  serviceDay,
  tripRoute,
  type ActionContext,
  type CustomAction,
} from "./actions";
import { guideFor, loadCatalog, type Catalog, type Guide, type NoticeDescription } from "./catalog";
import type { GuideLibrary } from "./guide-store";
import type { QualityStore } from "./store";
import { intersect, TourLayer, union, type Rect, type Targets } from "./tour";
import { CONTENT_ACTIONS, MAP_ACTIONS, resolveWalkthrough, type ResolvedStep, type Walkthrough } from "./walkthrough";

export interface AssistantDeps {
  dom: Dom;
  state: AppState;
  source: ViewerSource;
  store: QualityStore;
  go(view: View): void;
  map?: MapHandle;
  pick?: (selection: MapSelection) => void;
  /** Redraw the table in place, for marks that arrive after it was drawn. */
  redrawTable(): void;
  customActions?: Record<string, CustomAction>;
  /** Saved tours, which win over the catalog's. Without it, only the catalog's are used. */
  library?: GuideLibrary;
  /**
   * Where a walkthrough that ended goes, if the host decides: true when it
   * did. Otherwise `exit` returns to the notice, as it always has.
   */
  onExit?(code: string, toNotice: boolean): boolean;
}

interface Active {
  code: string;
  sample: number;
  samples: number;
  walkthrough: Walkthrough;
  notice?: NoticeDescription;
  /** Resolved from a version of the tour that has since changed; resolved again when next shown. */
  stale?: boolean;
}

/** The screen the walkthrough was started from, and is left to. */
export const QUALITY_SCREEN = "quality";

const SEVERITY_CLASS: Record<string, string> = { ERROR: "err", WARNING: "warn", INFO: "info", SYSTEM_ERROR: "err" };

export class QualityAssistant {
  private active: Active | null = null;
  private catalog: Catalog | null = null;
  /** A tour being written, played in place of the saved one for its notice until it is let go. */
  private draft: { code: string; guide: Guide } | null = null;
  /** Which `show` is the latest, so a slow step cannot draw over a newer one. */
  private token = 0;
  private readonly panel: HTMLElement;
  private readonly tour: TourLayer;
  /** What the arrow keys and Escape do while a step is showing; null otherwise. */
  private keys: { previous(): void; next(): void } | null = null;
  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.keys || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName))) return;
    const run = { ArrowLeft: this.keys.previous, ArrowRight: this.keys.next, Escape: () => this.exit(true) }[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  constructor(private readonly deps: AssistantDeps) {
    this.panel = deps.dom.el("assistant-panel");
    this.tour = new TourLayer(deps.dom.el("content"), deps.dom.el("tour-layer"), this.panel);
    document.addEventListener("keydown", this.onKey);
    // A different report makes the active walkthrough's samples meaningless.
    deps.store.subscribe(() => {
      if (this.active) this.exit(false);
    });
  }

  /** Let go of the page: the viewer is being unmounted. */
  destroy(): void {
    document.removeEventListener("keydown", this.onKey);
    this.tour.hide();
  }

  /** Start a walkthrough of one sample of one notice, at its first step or at `step`. */
  async start(code: string, sample = 0, step = 0): Promise<void> {
    const active = await this.activate(code, sample);
    if (active) this.go(step);
  }

  /**
   * Play `guide` for `code` instead of its saved tour, until `null` lets it go.
   *
   * How the editor runs a tour that is not saved. It stays in place while the
   * reader changes sample, steps back or follows a link out of a step.
   */
  setDraft(code: string, guide: Guide | null): void {
    if (guide) this.draft = { code, guide };
    else if (this.draft?.code === code) this.draft = null;
    // The walkthrough on screen was resolved from the other version.
    if (this.active?.code === code) this.active.stale = true;
  }

  /** Leave the walkthrough. `toNotice` returns to the notice it explained. */
  exit(toNotice = true): void {
    const code = this.active?.code;
    this.active = null;
    this.deps.state.marks = null;
    this.hidePanel();
    void this.deps.map?.annotate(null);
    if (code && this.deps.onExit?.(code, toNotice)) return;
    if (toNotice && code) this.deps.go({ table: "", filters: [], page: 1, screen: QUALITY_SCREEN, argument: code });
  }

  /**
   * Before a view loads: what the table should point at.
   *
   * Synchronous, because it has to be in place when the table draws. On a
   * reload the walkthrough is not resolved yet; `show` sets the marks then and
   * redraws.
   */
  prepare(view: View): void {
    const step = this.stepFor(view);
    this.deps.state.marks = step && !view.screen ? (contentTarget(step)?.marks ?? null) : null;
  }

  /** After a view loaded: the map, the panel, and anything `prepare` could not know. */
  async show(view: View): Promise<void> {
    const ticket = (this.token += 1);
    const assist = view.assist;

    if (!assist) {
      if (this.active) this.renderDetached();
      else this.hidePanel();
      return;
    }

    const active = this.matches(assist) ? this.active : await this.activate(assist.code, assist.sample);
    if (ticket !== this.token) return;
    if (!active) return; // activate drew why

    const step = active.walkthrough.steps[Math.min(assist.step, active.walkthrough.steps.length - 1)];
    if (!view.screen) {
      const marks = contentTarget(step)?.marks ?? null;
      if (JSON.stringify(marks) !== JSON.stringify(this.deps.state.marks)) {
        this.deps.state.marks = marks;
        this.deps.redrawTable();
      }
    }

    this.renderStep(active, assist.step, step, null, []);
    const context = this.context(active);
    if (step.clear.includes("map")) await this.deps.map?.annotate(null);
    const [notes, blocks] = await Promise.all([
      runMapActions(step, context).catch(() => [] as string[]),
      runPanelActions(step, context),
    ]);
    if (ticket !== this.token) return;
    this.renderStep(active, assist.step, step, blocks, notes);
  }

  // ---------------------------------------------------------------- moving

  /** The view a step of the active walkthrough shows. */
  private stepView(index: number): View | null {
    const active = this.active;
    if (!active) return null;
    const steps = active.walkthrough.steps;
    const at = Math.max(0, Math.min(index, steps.length - 1));
    const step = steps[at];
    const target = contentTarget(step);
    const current = this.deps.state.view;
    // A step with no content action stays on whatever the reader is looking
    // at: its point is on the map or in the panel.
    const base = target?.view ?? {
      table: current.table,
      filters: current.filters,
      page: current.page,
      screen: current.screen,
      argument: current.argument,
      params: current.params,
    };
    return { ...base, date: contentDate(step) ?? current.date, assist: { code: active.code, sample: active.sample, step: at } };
  }

  private go(index: number): void {
    // A timetable step that names only its trip opens that trip's route,
    // found first; the step is then like any other.
    const pending = this.active?.walkthrough.steps[Math.max(0, Math.min(index, this.active.walkthrough.steps.length - 1))];
    const bare = pending?.actions.find((action) => action.kind === "timetable" && !action.args.route && action.args.trip);
    if (bare && this.active) {
      void tripRoute(this.context(this.active), String(bare.args.trip))
        .catch(() => null)
        .then((route) => {
          bare.args.route = route ?? undefined;
          if (!route) delete bare.args.route;
          // Not again: without a route the step stays on what is open.
          if (!route) bare.args.trip = undefined;
          this.go(index);
        });
      return;
    }
    const view = this.stepView(index);
    if (!view) return;
    // A timetable shows one day, and a step about a trip needs one it runs on.
    const step = this.active?.walkthrough.steps[view.assist!.step];
    const timetable = step?.actions.find((action) => action.kind === "timetable");
    const trip = timetable && !timetable.args.date ? String(timetable.args.trip ?? "") : "";
    if (!trip || !this.active) {
      this.deps.go(view);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    void serviceDay(this.context(this.active), trip, today, view.date ?? undefined)
      .catch(() => null)
      .then((day) => this.deps.go(day ? { ...view, date: day } : view));
  }

  private matches(assist: NonNullable<View["assist"]>): boolean {
    return Boolean(
      this.active && !this.active.stale && this.active.code === assist.code && this.active.sample === assist.sample,
    );
  }

  private stepFor(view: View): ResolvedStep | null {
    if (!view.assist || !this.matches(view.assist) || !this.active) return null;
    return this.active.walkthrough.steps[view.assist.step] ?? null;
  }

  /** Resolve a walkthrough, or draw why it cannot be and return null. */
  private async activate(code: string, sample: number): Promise<Active | null> {
    const report = this.deps.store.report();
    if (!report) {
      this.renderMissing(`This link is a step of a walkthrough of ${code}. Load the validation report again to continue it.`);
      return null;
    }
    const notice = report.notices.find((entry) => entry.code === code);
    if (!notice || !notice.sampleNotices.length) {
      this.renderMissing(`The loaded report has no samples of ${code}.`);
      return null;
    }
    this.catalog ??= await (this.deps.library?.ready() ?? loadCatalog());
    const index = Math.max(0, Math.min(sample, notice.sampleNotices.length - 1));
    const chosen = notice.sampleNotices[index];
    const { guide, authored } =
      this.draft?.code === code
        ? { guide: this.draft.guide, authored: true }
        : (this.deps.library?.guideFor(this.catalog, code, chosen) ?? guideFor(this.catalog, code, chosen));
    const description = this.catalog.notices[code];
    this.active = {
      code,
      sample: index,
      samples: notice.sampleNotices.length,
      walkthrough: resolveWalkthrough(guide, authored, chosen, this.deps.state.tables, description),
      notice: description,
    };
    return this.active;
  }

  private context(active: Active): ActionContext {
    return {
      source: this.deps.source,
      tables: this.deps.state.tables,
      notice: active.notice,
      map: this.deps.map,
      pick: this.deps.pick,
      followLine: (line) => this.followLine(line),
      customActions: this.deps.customActions ?? {},
    };
  }

  /** Light the table row read from `line`, as something on the map reaches it. */
  private followLine(line: number | null): void {
    const scroll = this.maybe("table-scroll");
    if (!scroll) return;
    for (const row of scroll.querySelectorAll("tr.row-playing")) row.classList.remove("row-playing");
    if (line !== null) scroll.querySelector(`tr[data-line="${line}"]`)?.classList.add("row-playing");
  }

  private maybe(name: string): HTMLElement | null {
    try {
      return this.deps.dom.el(name);
    } catch {
      return null;
    }
  }

  /**
   * What a step's card points at, measured now: the rows it opened, the map
   * it draws on, or nothing.
   */
  private targets(step: ResolvedStep): Targets {
    const shown = (element: HTMLElement | null) => (element && !element.hidden && element.getClientRects().length ? element : null);
    const box = (element: Element): Rect => element.getBoundingClientRect();
    const screen = shown(this.maybe("screen-pane"));
    const pane = screen ?? shown(this.maybe("table-pane"));
    const mapPane = shown(this.maybe("map-pane"));

    let rows: Rect | null = null;
    let opened: Rect | null = null;
    let whole = false;
    if (pane && (step.carried || step.actions.some((action) => CONTENT_ACTIONS.has(action.kind)))) {
      const viewport = box(screen ?? this.maybe("table-scroll") ?? pane);
      // The card points at the marked rows, or a timetable's selected trip,
      // and the dim leaves the whole table they are in: the rows around them
      // are context, and a motion on the map lights them as it passes.
      const marked = [...pane.querySelectorAll("tr.row-marked, .trip-head.selected, .col-selected")];
      const tables = [...new Set(marked.map((element) => element.closest("table")).filter((table) => table !== null))];
      rows = union(marked.map(box));
      rows = rows && intersect(rows, viewport);
      opened = union(tables.map(box));
      opened = (opened && intersect(opened, viewport)) ?? rows;
      whole = !rows;
      rows ??= box(pane);
    }
    const map = mapPane && step.actions.some((action) => MAP_ACTIONS.has(action.kind)) ? box(mapPane) : null;
    const anchor = step.point === "map" ? (map ?? rows) : step.point === "rows" ? (rows ?? map) : null;
    return {
      anchor,
      spots: [opened ?? rows, map].filter((spot): spot is Rect => spot !== null),
      inside: whole && anchor === rows,
    };
  }

  // ----------------------------------------------------------------- card

  private hidePanel(): void {
    this.keys = null;
    this.tour.hide();
    this.panel.replaceChildren();
  }

  private button(label: string, title: string, run: () => void, primary = false): HTMLButtonElement {
    const element = node("button", { class: primary ? "primary" : undefined, title, text: label });
    element.addEventListener("click", run);
    return element;
  }

  private close(title: string, run: () => void): HTMLButtonElement {
    const element = node("button", { class: "assistant-close", title, "aria-label": title, text: "\u00d7" });
    element.addEventListener("click", run);
    return element;
  }

  private renderMissing(text: string): void {
    this.keys = null;
    this.panel.replaceChildren(
      node("div", { class: "assistant-head" }, [
        node("strong", { text: "Quality assistant" }),
        node("span", { class: "assistant-spacer" }),
        this.close("Close", () => this.hidePanel()),
      ]),
      node("p", { class: "assistant-text", text }),
      node("div", { class: "assistant-foot" }, [
        node("span", { class: "assistant-spacer" }),
        this.button(
          "Open Quality",
          "Load a report",
          () => {
            this.hidePanel();
            this.deps.go({ table: "", filters: [], page: 1, screen: QUALITY_SCREEN });
          },
          true,
        ),
      ]),
    );
    this.tour.dock();
  }

  private renderDetached(): void {
    const active = this.active;
    if (!active) return;
    this.keys = null;
    this.panel.replaceChildren(
      node("div", { class: "assistant-head" }, [
        node("strong", { text: "Quality assistant" }),
        node("span", { class: "assistant-code", text: active.code }),
        node("span", { class: "assistant-spacer" }),
        this.close("Leave the walkthrough", () => this.exit(false)),
      ]),
      node("p", { class: "assistant-hint", text: `You left step ${this.lastStep + 1}.` }),
      node("div", { class: "assistant-foot" }, [
        node("span", { class: "assistant-spacer" }),
        this.button("Return to it", "Go back to the step you left", () => this.go(this.lastStep), true),
      ]),
    );
    this.tour.dock();
  }

  /** The step last shown, for returning to it. */
  private lastStep = 0;

  private renderStep(active: Active, index: number, step: ResolvedStep, blocks: HTMLElement[] | null, notes: string[]): void {
    const steps = active.walkthrough.steps;
    const at = Math.min(index, steps.length - 1);
    this.lastStep = at;
    const next = steps[at + 1];
    this.keys = {
      previous: () => at > 0 && this.go(at - 1),
      next: () => (next ? this.go(at + 1) : this.exit(true)),
    };

    const severity = active.notice?.severity ?? "INFO";
    const dots = node(
      "div",
      { class: "assistant-dots", "aria-label": `Step ${at + 1} of ${steps.length}` },
      steps.map((_, i) => {
        const dot = node("button", {
          class: `assistant-dot${i === at ? " current" : i < at ? " done" : ""}`,
          title: `Step ${i + 1}: ${steps[i].text}`,
          "aria-label": `Step ${i + 1}`,
        });
        dot.addEventListener("click", () => this.go(i));
        return dot;
      }),
    );

    const extra: HTMLElement[] = [];
    for (const text of notes) extra.push(node("p", { class: "assistant-note", text }));
    for (const skipped of step.skipped) {
      extra.push(
        node("p", {
          class: "assistant-note",
          text: `Left out "${skipped.kind.replace(/_/g, " ")}": this sample has no ${skipped.field}.`,
        }),
      );
    }

    const previous = this.button("Back", "The step before (left arrow)", () => this.go(at - 1));
    previous.disabled = at === 0;
    const sample =
      active.samples > 1
        ? node("span", { class: "assistant-sample" }, [
            this.button("\u2039", "The previous sample of this notice", () => void this.start(active.code, active.sample - 1)),
            node("span", { text: `Sample ${active.sample + 1}/${active.samples}` }),
            this.button("\u203a", "The next sample of this notice", () => void this.start(active.code, active.sample + 1)),
          ])
        : null;
    if (sample) {
      (sample.children[0] as HTMLButtonElement).disabled = active.sample <= 0;
      (sample.children[2] as HTMLButtonElement).disabled = active.sample >= active.samples - 1;
    }

    this.panel.replaceChildren(
      node("div", { class: "assistant-head" }, [
        node("span", { class: `pill ${SEVERITY_CLASS[severity] ?? "info"}`, text: severity }),
        node("span", { class: "assistant-code", text: active.code }),
        node("span", { class: "assistant-spacer" }),
        this.close("Leave the walkthrough (Escape)", () => this.exit(true)),
      ]),
      node("div", { class: "assistant-progress" }, [dots, node("span", { text: `${at + 1} of ${steps.length}` })]),
      node("p", { class: "assistant-text" }, prose(step.text)),
      node("div", { class: "assistant-content" }, [
        ...extra,
        ...(blocks ?? (step.actions.length ? [node("p", { class: "assistant-hint", text: "Reading the feed\u2026" })] : [])),
      ]),
      node("div", { class: "assistant-foot" }, [
        sample,
        node("span", { class: "assistant-spacer" }),
        previous,
        next
          ? this.button("Next", `Next: ${next.text} (right arrow)`, () => this.go(at + 1), true)
          : this.button("Done", "Finish and return to the notice", () => this.exit(true), true),
      ]),
      node("span", { class: "assistant-arrow", "aria-hidden": "true" }),
    );
    this.tour.point(() => this.targets(step));
  }
}
