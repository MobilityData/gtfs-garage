/**
 * The tour editor: write, try and save the tour for one notice.
 *
 * A panel beside the table and the map rather than over them, so a tour can be
 * run while it is being written: Run plays the working copy through the real
 * assistant, on the sample chosen here, and the editor stays open to change a
 * step and run it again.
 *
 * Two ways to edit the same guide. The form is the default: rows, steps and
 * fixes as fields, with the notice's fields to insert and each sentence shown
 * as this sample fills it. YAML is for whoever would rather write the file,
 * and keeps their comments while they stay in it. Both are checked by the
 * rules the server applies (`validate.ts`), with each problem shown beside the
 * field it is about.
 *
 * Saving goes to the library's store; see `guide-store.ts`.
 */

import type { TableInfo } from "../../sources/types";
import { HAND_TRIAL, type Trial, type TrialOption, type Trials } from "./trials";
import { append, node } from "../../ui/html";
import { tableOf, type Action, type ArgumentSpec, type Catalog, type Guide, type Locator, type NoticeDescription, type Step } from "../catalog";
import type { GuideLibrary } from "../guide-store";
import type { Sample } from "../template";
import { validateGuide, type Problem, type ProblemPath } from "../validate";
import {
  blankGuide,
  checkSteps,
  cleanGuide,
  copy,
  freshName,
  move,
  newAction,
  dropUnusedLocators,
  sameGuide,
  sampleFields,
  starterGuide,
  tableFor,
  type StepCheck,
} from "./model";
import {
  button,
  checkbox,
  choice,
  columnsInput,
  jsonInput,
  labelled,
  listInput,
  numberInput,
  templateInput,
  tool,
  type FormContext,
} from "./widgets";
import { guideToYaml, parseYaml } from "./yaml";

export interface EditorDeps {
  root: HTMLElement;
  library: GuideLibrary;
  /** Where samples come from: the open feed's report, the demo feeds, or one written by hand. */
  trials: Trials;
  /**
   * Play `guide` through the assistant on one sample of `trial`, from one of
   * the steps it runs. A demo's feed is opened first if it is not open.
   */
  run(code: string, trial: TrialOption, sample: number, guide: Guide, step: number): Promise<void>;
  /** The editor is done with its working copy: the assistant goes back to the saved tour. */
  release(code: string): void;
  /** The editor closed: go back to where the reader started. */
  closed(): void;
  /** The panel opened or closed, and the panes beside it changed size. */
  layoutChanged(): void;
}

const SURFACE_LABEL: Record<string, string> = { content: "Table", map: "Map", panel: "Card", any: "Host" };
const SURFACE_GROUP: Record<string, string> = {
  content: "Open in the table (one per step)",
  map: "Draw on the map",
  panel: "Show in the card",
  any: "Run a host action",
};
const SEVERITY_CLASS: Record<string, string> = { ERROR: "err", WARNING: "warn", INFO: "info", SYSTEM_ERROR: "err" };

const key = (path: ProblemPath) => JSON.stringify(path);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the form can draw `value`; YAML written by hand may be a shape it cannot. */
function formable(value: unknown): string | null {
  if (!isMapping(value)) return "The file has to be a mapping, with code, locators, steps and fix.";
  if (value.locators !== undefined && value.locators !== null && !isMapping(value.locators)) return "`locators` has to be a mapping of names to rows.";
  for (const locator of Object.values((value.locators as object) ?? {})) {
    if (!isMapping(locator)) return "Each locator has to be a mapping with a file.";
    if (locator.key !== undefined && !isMapping(locator.key)) return "A locator's `key` has to be a mapping of columns to values.";
  }
  if (!Array.isArray(value.steps)) return "`steps` has to be a list.";
  for (const step of value.steps) {
    if (!isMapping(step)) return "Each step has to be a mapping with a text.";
    if (step.actions !== undefined && step.actions !== null && !(Array.isArray(step.actions) && step.actions.every(isMapping)))
      return "A step's `actions` has to be a list of actions.";
    if (step.clear !== undefined && !Array.isArray(step.clear)) return "A step's `clear` has to be a list.";
  }
  if (value.fix !== undefined && value.fix !== null && !Array.isArray(value.fix)) return "`fix` has to be a list of sentences.";
  return null;
}

export class TourEditor {
  private code: string | null = null;
  private sample = 0;
  private trialOptions: TrialOption[] = [];
  private trial: Trial | null = null;
  /** The working copy; null while the reader chooses how to start one. */
  private guide: Guide | null = null;
  /** What is saved or built in, to tell whether there is anything to save. */
  private baseline: Guide | null = null;
  private mode: "form" | "yaml" = "form";
  private yamlText = "";
  private yamlBaseline = "";
  private yamlError: { message: string; line: number | null } | null = null;
  private catalog: Catalog | null = null;
  private problems: Problem[] = [];
  private checks: StepCheck[] = [];
  private status = "";
  private refreshers: (() => void)[] = [];
  private slots = new Map<string, HTMLElement>();
  /** Drawn per render and refreshed on every change. */
  private foot: HTMLElement | null = null;
  private summary: HTMLElement | null = null;

  constructor(private readonly deps: EditorDeps) {
    deps.root.classList.add("tour-editor");
  }

  isOpen(): boolean {
    return this.code !== null;
  }

  /**
   * Open the editor on `code`, trying it on one of its samples.
   *
   * `prefer` is where the samples come from first: the open feed's report,
   * for a tour opened from the Quality screen, or a demo, for one opened from
   * the Tours view. Whichever is not there, the other is used, and a sample
   * written by hand when neither has the notice.
   */
  async open(code: string, sample = 0, prefer: "report" | "demo" = "report"): Promise<void> {
    if (this.code && this.code !== code && !this.confirmLeave()) return;
    if (this.code && this.code !== code) this.deps.release(this.code);
    this.catalog = await this.deps.library.ready();
    const reopening = this.code === code;
    this.code = code;
    this.trialOptions = await this.deps.trials.options(code);
    const order: string[] = prefer === "demo" ? ["demo", "report", "hand"] : ["report", "demo", "hand"];
    const keep = reopening && this.trial ? this.trialOptions.find((option) => option.id === this.trial!.id) : undefined;
    const chosen = keep ?? order.map((kind) => this.trialOptions.find((option) => option.kind === kind)).find(Boolean)!;
    this.trial = await this.deps.trials.load(code, chosen);
    this.sample = Math.max(0, Math.min(sample, this.samples().length - 1));
    if (!reopening) {
      const written = this.deps.library.written(this.catalog, code);
      this.baseline = written ? copy(written) : null;
      this.guide = written ? copy(written) : null;
      this.mode = "form";
      this.status = "";
      const saved = this.deps.library.savedGuide(code);
      this.yamlBaseline = saved?.yaml ?? (written ? guideToYaml(written) : "");
    }
    const wasHidden = this.deps.root.hidden;
    this.deps.root.hidden = false;
    this.render();
    if (wasHidden) this.deps.layoutChanged();
  }

  /**
   * Read the sample sources again: the open feed changed - a demo opened to
   * run a tour, or the reader's own feed came back - and with it "this feed's
   * report". The chosen source and sample stay chosen where they still exist.
   */
  async refreshSources(): Promise<void> {
    const code = this.code;
    if (!code) return;
    this.trialOptions = await this.deps.trials.options(code);
    const current = this.trialOptions.find((option) => option.id === this.trial?.id) ?? this.trialOptions[0];
    if (current.id !== this.trial?.id || current.kind === "report") {
      this.trial = await this.deps.trials.load(code, current);
      this.sample = Math.min(this.sample, Math.max(0, this.samples().length - 1));
    }
    this.render();
  }

  /** Close, asking first when there are changes that would be lost. */
  close(): boolean {
    if (!this.code) return true;
    if (!this.confirmLeave()) return false;
    this.deps.release(this.code);
    this.code = null;
    this.guide = null;
    this.trial = null;
    this.deps.root.hidden = true;
    this.deps.root.replaceChildren();
    this.deps.layoutChanged();
    this.deps.closed();
    return true;
  }

  private confirmLeave(): boolean {
    return !this.dirty() || window.confirm("This tour has changes that are not saved. Leave without saving them?");
  }

  // ------------------------------------------------------------------ state

  private notice(): NoticeDescription | undefined {
    return this.code ? this.catalog?.notices[this.code] : undefined;
  }

  private samples(): Sample[] {
    return this.trial?.sampleList ?? [];
  }

  /** The files of the feed the samples come from. */
  private tables(): TableInfo[] {
    return this.trial?.tables ?? [];
  }

  private async chooseTrial(id: string): Promise<void> {
    const option = this.trialOptions.find((entry) => entry.id === id);
    if (!option || !this.code) return;
    this.trial = await this.deps.trials.load(this.code, option);
    this.sample = 0;
    this.render();
  }

  private currentSample(): Sample {
    return this.samples()[this.sample] ?? {};
  }

  private fields(): string[] {
    return Object.keys(this.notice()?.fields ?? {});
  }

  private dirty(): boolean {
    if (!this.guide) return false;
    if (this.mode === "yaml") return this.yamlText !== this.yamlBaseline;
    return !this.baseline || !sameGuide(this.guide, this.baseline);
  }

  /** The guide as it would be run and saved. */
  private cleaned(): Guide | null {
    if (!this.guide) return null;
    return this.mode === "yaml" ? (this.guide as Guide) : dropUnusedLocators(cleanGuide(this.guide), this.catalog!.action_specs);
  }

  private formContext(): FormContext {
    return {
      sample: () => this.currentSample(),
      fields: () => sampleFields(this.notice(), this.currentSample()),
      changed: () => this.changed(),
      rebuild: () => this.render(),
      refresh: (run) => this.refreshers.push(run),
      slot: (path) => this.slot(path),
    };
  }

  private slot(path: ProblemPath): HTMLElement {
    const element = node("div", { class: "editor-problems", "aria-live": "polite" });
    this.slots.set(key(path), element);
    return element;
  }

  /** Check the guide again and refresh everything that depends on it, without redrawing the form. */
  private changed(): void {
    const guide = this.cleaned();
    const catalog = this.catalog;
    if (!guide || !catalog || !this.code) return;
    this.problems = this.yamlError ? [] : validateGuide(this.code, guide, this.fields(), catalog);
    this.checks = this.problems.length || this.mode === "yaml" ? [] : checkSteps(guide, this.currentSample(), this.tables());

    for (const slot of this.slots.values()) slot.replaceChildren();
    const unplaced: Problem[] = [];
    for (const problem of this.problems) {
      let path = problem.path;
      let slot = this.slots.get(key(path));
      while (!slot && path.length) {
        path = path.slice(0, -1);
        slot = this.slots.get(key(path));
      }
      if (slot && path.length) slot.append(node("div", { class: "editor-problem", text: problem.message }));
      else unplaced.push(problem);
    }
    for (const run of this.refreshers) run();
    this.drawSummary(unplaced);
    this.drawFoot();
  }

  // ------------------------------------------------------------------ frame

  private render(): void {
    const code = this.code;
    const catalog = this.catalog;
    if (!code || !catalog) return;
    const scroll = this.deps.root.querySelector(".editor-body")?.scrollTop ?? 0;
    this.refreshers = [];
    this.slots = new Map();
    const notice = this.notice();

    const origin = this.deps.library.origin(code);
    const originText = { saved: `Saved in ${this.deps.library.store.where}`, builtin: "Built-in tour", generic: "No tour written yet" }[origin];
    const head = node("div", { class: "editor-head" }, [
      notice ? node("span", { class: `pill ${SEVERITY_CLASS[notice.severity] ?? "info"}`, text: notice.severity }) : null,
      node("strong", { class: "editor-code", text: code, title: code }),
      node("span", { class: `editor-origin editor-origin-${origin}`, text: originText }),
      node("span", { class: "assistant-spacer" }),
      tool("×", "Close the editor", () => this.close()),
    ]);

    const samples = this.samples();
    const trialChoice = choice(
      this.trial?.id ?? HAND_TRIAL,
      this.trialOptions.map((option) => [
        option.id,
        option.kind === "hand" ? option.label : `${option.label} \u2014 ${option.samples} ${option.samples === 1 ? "sample" : "samples"}`,
      ]),
      (value) => void this.chooseTrial(value),
      this.formContext(),
      "Where the sample comes from",
    );
    const sampleChoice =
      this.trial?.kind !== "hand" && samples.length > 1
        ? choice(
            String(this.sample),
            samples.slice(0, 100).map((_, i) => [String(i), `Sample ${i + 1} of ${samples.length}`]),
            (value) => {
              this.sample = Number(value);
              this.render();
            },
            this.formContext(),
            "The sample to try the tour on",
          )
        : null;

    const modes = node("div", { class: "editor-modes", role: "tablist", "aria-label": "How to edit" }, [
      this.modeButton("form", "Form", "Edit the tour as fields (recommended)"),
      this.modeButton("yaml", "YAML", "Advanced: edit the tour's YAML file directly"),
    ]);

    this.summary = node("div", { class: "editor-summary" });
    const body = node("div", { class: "editor-body" });
    if (!this.guide) body.append(this.renderStart());
    else if (this.mode === "yaml") body.append(this.renderYaml());
    else body.append(...this.renderForm());
    this.foot = node("div", { class: "editor-foot" });

    this.deps.root.replaceChildren();
    append(
      this.deps.root,
      head,
      notice?.summary ? node("p", { class: "editor-intro", text: notice.summary }) : null,
      node("div", { class: "editor-bar" }, [
        labelled("Try it on", node("div", { class: "editor-row" }, [trialChoice, sampleChoice])),
        node("span", { class: "assistant-spacer" }),
        this.guide ? modes : null,
      ]),
      this.summary,
      body,
      this.foot,
    );
    body.scrollTop = scroll;
    this.changed();
    if (!this.guide) this.drawFoot();
  }

  private modeButton(mode: "form" | "yaml", label: string, title: string): HTMLButtonElement {
    const element = button(label, title, () => this.switchMode(mode), `editor-mode${this.mode === mode ? " active" : ""}`);
    element.setAttribute("role", "tab");
    element.setAttribute("aria-selected", String(this.mode === mode));
    return element;
  }

  private switchMode(mode: "form" | "yaml"): void {
    if (mode === this.mode || !this.guide) return;
    if (mode === "yaml") {
      this.yamlText = guideToYaml(cleanGuide(this.guide));
      this.yamlError = null;
      // Unchanged from what was saved: keep the saved text, comments and all.
      if (this.baseline && sameGuide(this.guide, this.baseline) && this.yamlBaseline) this.yamlText = this.yamlBaseline;
      else if (!this.baseline || !this.yamlBaseline) this.yamlBaseline = this.baseline ? guideToYaml(this.baseline) : "";
    } else {
      if (this.yamlError) {
        this.status = "Fix the YAML first: the form cannot read it as it is.";
        this.drawFoot();
        return;
      }
      const problem = formable(this.guide);
      if (problem) {
        this.status = `The form cannot show this yet. ${problem}`;
        this.drawFoot();
        return;
      }
    }
    this.mode = mode;
    this.status = "";
    this.render();
  }

  private drawSummary(unplaced: Problem[]): void {
    const summary = this.summary;
    if (!summary) return;
    summary.replaceChildren();
    if (this.yamlError) {
      summary.append(
        node("div", { class: "editor-problem" }, [
          this.yamlError.line ? `Line ${this.yamlError.line}: ` : "",
          this.yamlError.message,
        ]),
      );
      return;
    }
    if (!this.problems.length) return;
    summary.append(
      node("div", { class: "editor-summary-title", text: `${this.problems.length} ${this.problems.length === 1 ? "thing" : "things"} to fix before this tour can run or be saved` }),
      ...(this.mode === "yaml" ? this.problems : unplaced).map((problem) => node("div", { class: "editor-problem", text: problem.text })),
    );
  }

  private drawFoot(): void {
    const foot = this.foot;
    const code = this.code;
    const catalog = this.catalog;
    if (!foot || !code || !catalog) return;
    foot.replaceChildren();
    const guide = this.cleaned();
    const blocked = !guide || this.problems.length > 0 || this.yamlError !== null;
    const origin = this.deps.library.origin(code);

    const run = button("▶ Run tour", "Play this version of the tour on the chosen sample", () => this.run(0), "primary");
    const runnable = this.trial?.kind !== "hand" && this.samples().length > 0;
    run.disabled = blocked || !runnable;
    if (!runnable) run.title = "A sample written by hand has no rows to run on. Choose a report or a demo feed to run the tour.";
    const save = button("Save", `Save this tour in ${this.deps.library.store.where}`, () => void this.save());
    save.disabled = blocked || !this.dirty();
    const discard = button("Discard changes", "Go back to the tour as it was saved", () => this.discard());
    discard.disabled = !this.dirty();
    const revert =
      origin === "saved"
        ? button(
            catalog.notices[code]?.guide ? "Use built-in tour" : "Delete saved tour",
            catalog.notices[code]?.guide ? "Forget the saved tour and use the one this viewer ships" : "Forget the saved tour; the notice is explained from its fields again",
            () => void this.revert(),
          )
        : null;

    const exportButtons =
      this.mode === "yaml" && guide
        ? [
            button("Copy", "Copy the YAML", () => void navigator.clipboard?.writeText(this.yamlText).then(() => this.say("Copied."))),
            button("Download", `Download ${code}.yaml, to add to schema/guides/`, () => this.download()),
          ]
        : [];

    append(
      foot,
      node("div", { class: "editor-foot-row" }, [run, save, discard, node("span", { class: "assistant-spacer" }), ...exportButtons, revert]),
      this.status || (this.dirty() && guide) ? node("div", { class: "editor-status", text: this.status || "Not saved yet." }) : null,
    );
  }

  private say(text: string): void {
    this.status = text;
    this.drawFoot();
  }

  // ---------------------------------------------------------------- actions

  private run(stepIndex: number): void {
    const guide = this.cleaned();
    if (!guide || !this.code || this.problems.length) return;
    const runs = this.checks[stepIndex]?.runs ?? 0;
    if (!this.trial || this.trial.kind === "hand") return;
    void this.deps.run(this.code, this.trial, this.sample, guide, runs).catch((error) => this.say(`Could not run it: ${(error as Error).message}`));
  }

  private async save(): Promise<void> {
    const guide = this.cleaned();
    if (!guide || !this.code || this.problems.length) return;
    const yaml = this.mode === "yaml" ? this.yamlText : guideToYaml(guide);
    try {
      await this.deps.library.save(this.code, guide, yaml);
    } catch (error) {
      this.say(`Could not save: ${(error as Error).message}`);
      return;
    }
    this.baseline = copy(guide);
    this.yamlBaseline = yaml;
    this.status = `Saved in ${this.deps.library.store.where}.`;
    this.render();
  }

  private discard(): void {
    if (!window.confirm("Discard the changes to this tour?")) return;
    this.guide = this.baseline ? copy(this.baseline) : null;
    this.yamlText = this.yamlBaseline;
    this.yamlError = null;
    this.mode = "form";
    this.status = "";
    this.render();
  }

  private async revert(): Promise<void> {
    const code = this.code;
    const catalog = this.catalog;
    if (!code || !catalog) return;
    const builtin = catalog.notices[code]?.guide;
    const question = builtin
      ? "Forget the saved tour and use the built-in one?"
      : "Delete the saved tour? The notice will be explained from its fields again.";
    if (!window.confirm(question)) return;
    await this.deps.library.remove(code);
    this.baseline = builtin ? copy(builtin) : null;
    this.guide = builtin ? copy(builtin) : null;
    this.yamlBaseline = builtin ? guideToYaml(builtin) : "";
    this.mode = "form";
    this.status = builtin ? "Using the built-in tour." : "Saved tour deleted.";
    this.render();
  }

  private download(): void {
    const link = node("a", {
      href: URL.createObjectURL(new Blob([this.yamlText], { type: "application/yaml" })),
      download: `${this.code}.yaml`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ------------------------------------------------------------------ start

  private renderStart(): HTMLElement {
    const code = this.code!;
    const start = (guide: Guide) => {
      this.guide = guide;
      this.render();
    };
    return node("div", { class: "editor-start" }, [
      node("p", { text: "No tour is written for this notice yet. The assistant explains it from the fields of its samples." }),
      node("div", { class: "editor-start-choice" }, [
        button("Start from the automatic tour", "Begin with the steps the assistant builds from the sample's fields", () =>
          start(starterGuide(code, this.notice(), this.currentSample())), "primary"),
        node("p", { class: "editor-hint", text: "Recommended. The walkthrough readers see today, as a tour you can change." }),
      ]),
      node("div", { class: "editor-start-choice" }, [
        button("Start from an empty tour", "Begin with one empty step", () => start(blankGuide(code))),
        node("p", { class: "editor-hint", text: "One empty step, and nothing else." }),
      ]),
    ]);
  }

  // ------------------------------------------------------------------- yaml

  private renderYaml(): HTMLElement {
    const area = node("textarea", { class: "editor-input editor-code editor-yaml", spellcheck: "false", "aria-label": "The tour as YAML" });
    area.value = this.yamlText;
    area.addEventListener("input", () => {
      this.yamlText = area.value;
      const parsed = parseYaml(area.value);
      if (parsed.ok) {
        this.yamlError = null;
        this.guide = (parsed.value ?? {}) as Guide;
      } else {
        this.yamlError = { message: parsed.message, line: parsed.line };
      }
      this.changed();
    });
    area.addEventListener("keydown", (event) => {
      // Tab indents, as an editor does, rather than leaving the field.
      if (event.key !== "Tab" || event.shiftKey) return;
      event.preventDefault();
      area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
      area.dispatchEvent(new Event("input"));
    });
    return node("div", { class: "editor-yaml-wrap" }, [
      node("p", { class: "editor-hint" }, [
        "The tour's file, as it would be saved in schema/guides/",
        node("code", { text: `${this.code}.yaml` }),
        ". Comments are kept while you stay here; going back to the form writes the file again without them. See docs/QUALITY.md for every action and its arguments.",
      ]),
      area,
    ]);
  }

  // ------------------------------------------------------------------- form

  private renderForm(): HTMLElement[] {
    const guide = this.guide!;
    const context = this.formContext();
    guide.steps ??= [];
    guide.locators ??= {};
    return [this.trial?.kind === "hand" ? this.renderHandSample(context) : null, this.renderSteps(guide, context), this.renderFix(guide, context)].filter(
      (element): element is HTMLElement => element !== null,
    );
  }

  /** The values of a sample written by hand, one per field of the notice. */
  private renderHandSample(context: FormContext): HTMLElement {
    const sample = this.trial!.sampleList[0];
    const fields = Object.entries(this.notice()?.fields ?? {});
    const rows = fields.map(([field, description]) => {
      const input = node("input", { class: "editor-input", type: "text", placeholder: description.type ?? "", "aria-label": field });
      input.value = sample[field] === undefined ? "" : String(sample[field]);
      input.addEventListener("input", () => {
        const text = input.value;
        const numeric = description.type && /^(number|integer|double|float|long)$/.test(description.type) && text.trim() !== "" && Number.isFinite(Number(text));
        if (text === "") delete sample[field];
        else sample[field] = numeric ? Number(text) : text;
        context.changed();
      });
      return labelled(field, input, description.description || undefined);
    });
    return this.section(
      "Sample values",
      "No feed at hand raises this notice, so write the values a sample would have. Sentences are shown as these fill them; there are no rows to run the tour on.",
      fields.length ? rows : [node("p", { class: "editor-hint", text: "This notice's samples have no fields." })],
      ["sample"],
    );
  }

  private section(title: string, hint: string, children: (Node | null)[], path: ProblemPath): HTMLElement {
    return node("section", { class: "editor-section" }, [
      node("h3", { text: title }),
      node("p", { class: "editor-hint", text: hint }),
      this.slot(path),
      ...children,
    ]);
  }

  private fileChoices(current: string): [string, string][] {
    const tables = this.tables().map((table) => table.name);
    const notice = this.notice();
    const sample = this.currentSample();
    const fromFields = sampleFields(notice, sample)
      .filter((field) => /\.(txt|geojson)$/.test(field.value) || /[Ff]ile[Nn]ame/.test(field.field))
      .map((field) => [`{{${field.field}}}`, `The file the sample names in ${field.field}${field.value ? ` (here ${field.value})` : ""}`] as [string, string]);
    const listed = [...new Set([...(notice?.files ?? []).map(tableOf), ...tables])];
    const options: [string, string][] = [["", "Choose a file…"], ...fromFields, ...listed.map((name) => [name, `${name}.txt`] as [string, string])];
    if (current && !options.some(([value]) => value === current)) options.push([current, current]);
    return options;
  }

  /** Where `name`'s rows are used, as "step 2", for a locator two actions share. */
  private usersOf(guide: Guide, name: string): { step: number; action: number }[] {
    const specs = this.catalog!.action_specs;
    const users: { step: number; action: number }[] = [];
    guide.steps.forEach((step, i) =>
      (step.actions ?? []).forEach((action, j) => {
        const args = specs[action.kind]?.args ?? {};
        if (Object.entries(args).some(([arg, spec]) => spec.type === "locator" && action[arg] === name)) users.push({ step: i, action: j });
      }),
    );
    return users;
  }

  /** Rows in a phrase, for choosing among those the tour already opens: "stops.txt, stop_id = {{stopId}}". */
  private describeRows(locator: Locator): string {
    const file = locator.file ? (/^\{\{/.test(locator.file) ? locator.file : `${locator.file}.txt`) : "no file yet";
    const how = [
      locator.line ? `line ${locator.line}` : "",
      ...Object.entries(locator.key ?? {}).filter(([column]) => column).map(([column, value]) => `${column} = ${value}`),
    ].filter(Boolean);
    return how.length ? `${file}, ${how.join(", ")}` : `${file}, every row`;
  }

  private newRows(guide: Guide, file?: string): string {
    const table = file ?? tableOf(this.notice()?.files?.[0] ?? "");
    const name = freshName(Object.keys(guide.locators ?? {}), table.replace(/[^A-Za-z0-9_]/g, "") || "rows");
    guide.locators = { ...(guide.locators ?? {}), [name]: { file: table, line: "", key: {} } as Locator };
    return name;
  }

  /**
   * The rows one action opens or shows: which file, and how to find them in it.
   *
   * Edited where they are used, inside the action. They are a named locator
   * in the file, so two actions can share them; when they do, this says so,
   * and offers a copy to change on its own.
   */
  private renderRows(guide: Guide, action: Action, argument: string, at: { step: number; action: number }, context: FormContext): HTMLElement {
    const name = String(action[argument] ?? "");
    const locator = guide.locators![name];
    const path = ["locators", name];
    const table = tableFor(locator, this.currentSample(), this.tables());
    const columns = table?.columns.map((column) => column.name) ?? null;
    locator.key ??= {};
    const keyRows = Object.entries(locator.key).map(([column, value], index) => {
      const setColumn = (next: string) => {
        const entries = Object.entries(locator.key ?? {});
        entries[index] = [next, entries[index][1]];
        locator.key = Object.fromEntries(entries);
      };
      const columnInput = columns
        ? choice(column, [["", "column\u2026"], ...columns.map((c) => [c, c] as [string, string])], setColumn, context, "Column")
        : templateInput(context, { value: column, placeholder: "column", onChange: setColumn, label: "Column" });
      return node("div", { class: "editor-key-row" }, [
        columnInput,
        node("span", { class: "editor-equals", text: "=" }),
        templateInput(context, {
          value: String(value ?? ""),
          placeholder: "{{field}}",
          label: "Value",
          onChange: (next) => {
            const entries = Object.entries(locator.key ?? {});
            entries[index] = [entries[index][0], next];
            locator.key = Object.fromEntries(entries);
          },
        }),
        tool("\u00d7", "Remove this column", () => {
          const entries = Object.entries(locator.key ?? {});
          entries.splice(index, 1);
          locator.key = Object.fromEntries(entries);
          this.render();
        }),
      ]);
    });

    const others = this.usersOf(guide, name).filter((user) => user.step !== at.step || user.action !== at.action);
    const shared = others.length
      ? node("div", { class: "editor-shared" }, [
          `The same rows as ${[...new Set(others.map((user) => `step ${user.step + 1}`))].join(", ")}: a change here changes ${others.length === 1 ? "it" : "them"} too. `,
          button("Change these on their own", "Give this action its own copy of the rows", () => {
            const copyName = freshName(Object.keys(guide.locators ?? {}), name);
            guide.locators = { ...guide.locators, [copyName]: copy(locator) };
            action[argument] = copyName;
            this.render();
          }, "editor-link"),
        ])
      : null;

    return node("div", { class: "editor-rows" }, [
      shared,
      labelled(
        "File",
        choice(locator.file ?? "", this.fileChoices(locator.file ?? ""), (value) => {
          locator.file = value;
          this.render();
        }, context),
      ),
      labelled(
        "Line",
        templateInput(context, { value: locator.line ?? "", placeholder: "{{csvRowNumber}}", onChange: (value) => (locator.line = value) }),
        "The validator's row number. Several may be given, separated by commas.",
      ),
      node("div", { class: "editor-field" }, [
        node("div", { class: "editor-label", text: "Or find them by column values" }),
        ...keyRows,
        button("+ Column", "Match rows on a column's value", () => {
          const entries = Object.entries(locator.key ?? {});
          const next = (columns ?? []).find((column) => !entries.some(([c]) => c === column)) ?? "";
          if (entries.some(([c]) => c === next)) return;
          locator.key = Object.fromEntries([...entries, [next, ""]]);
          this.render();
        }, "editor-add"),
      ]),
      node("div", { class: "editor-hint", text: "With no line and no column, the whole file opens." }),
      table || !locator.file ? null : node("div", { class: "editor-hint", text: "This feed has no such file, so its columns cannot be offered." }),
      this.slot(path),
    ]);
  }

  private renderSteps(guide: Guide, context: FormContext): HTMLElement {
    const steps = guide.steps;
    const cards = steps.map((step, index) => this.renderStep(guide, step, index, context));
    return this.section(
      "Steps",
      "Each step is one sentence about this sample and what illustrates it. A last step, how to fix it, is added for you.",
      [
        ...cards,
        button("+ Step", "Add a step at the end", () => {
          steps.push({ text: "" });
          this.render();
        }, "editor-add"),
      ],
      ["steps"],
    );
  }

  private renderStep(guide: Guide, step: Step, index: number, context: FormContext): HTMLElement {
    const steps = guide.steps;
    const path = ["steps", index];
    step.actions ??= [];
    const actions = step.actions;
    const specs = this.catalog!.action_specs;

    const check = node("span", { class: "editor-check-badge" });
    const notes = node("div", { class: "editor-notes" });
    const runHere = tool("▶", "Run the tour from this step", () => this.run(index));
    context.refresh(() => {
      const result = this.checks[index];
      runHere.disabled = !result || result.runs === null || this.trial?.kind === "hand" || !this.samples().length;
      check.textContent = result ? (result.runs === null ? "left out on this sample" : "") : "";
      check.className = `editor-check-badge${result?.runs === null ? " editor-check-dropped" : ""}`;
      notes.replaceChildren(...[result?.dropped, ...(result?.notes ?? [])].filter(Boolean).map((text) => node("div", { class: "editor-note", text: text! })));
    });

    const hasContent = actions.some((action) => specs[action.kind]?.surface === "content");
    const groups = ["content", "map", "panel", "any"].map((surface) =>
      node(
        "optgroup",
        { label: SURFACE_GROUP[surface] },
        Object.entries(specs)
          .filter(([, spec]) => spec.surface === surface)
          .map(([kind, spec]) => {
            const option = node("option", { value: kind, text: spec.label });
            if (surface === "content" && hasContent) {
              option.disabled = true;
              option.textContent = `${spec.label} (this step already opens something)`;
            }
            return option;
          }),
      ),
    );
    const add = node("select", { class: "editor-insert editor-add-action", "aria-label": "Add an action" }, [node("option", { value: "", text: "+ Action…" }), ...groups]);
    add.addEventListener("change", () => {
      const kind = add.value;
      if (!kind) return;
      // Rows it needs are new rows of their own, in the file the notice is about.
      const fresh = Object.entries(specs[kind].args)
        .filter(([, arg]) => arg.type === "locator" && arg.required)
        .map(() => this.newRows(guide));
      actions.push(newAction(kind, specs[kind], fresh, this.fields()));
      this.render();
    });

    const clearsMap = (step.clear ?? []).includes("map");
    return node("div", { class: "editor-card editor-step" }, [
      node("div", { class: "editor-card-head" }, [
        node("strong", { text: `Step ${index + 1}` }),
        check,
        node("span", { class: "assistant-spacer" }),
        runHere,
        tool("↑", "Move up", () => {
          move(steps, index, -1);
          this.render();
        }, index === 0),
        tool("↓", "Move down", () => {
          move(steps, index, 1);
          this.render();
        }, index === steps.length - 1),
        tool("⧉", "Duplicate this step", () => {
          steps.splice(index + 1, 0, copy(step));
          this.render();
        }),
        tool("×", "Remove this step", () => {
          if ((step.text || actions.length) && !window.confirm(`Remove step ${index + 1}?`)) return;
          steps.splice(index, 1);
          this.render();
        }),
      ]),
      labelled(
        "What it says",
        templateInput(context, {
          value: step.text ?? "",
          multiline: true,
          showPreview: true,
          placeholder: "One sentence about this sample, e.g. {{stopName}} is {{geoDistanceToShape|m}} from the line.",
          onChange: (value) => (step.text = value),
        }),
      ),
      this.slot([...path, "text"]),
      notes,
      node("div", { class: "editor-actions" }, [
        ...actions.map((action, j) => this.renderAction(guide, step, action, index, j, context)),
        this.slot([...path, "actions"]),
        add,
      ]),
      node("div", { class: "editor-step-options" }, [
        labelled(
          "Card points at",
          choice(step.point ?? "", [["", "Automatic"], ["rows", "The rows"], ["map", "The map"]], (value) => {
            if (value) step.point = value as Step["point"];
            else delete step.point;
          }, context),
        ),
        checkbox(clearsMap, "Clear the map first", (on) => {
          const rest = (step.clear ?? []).filter((surface) => surface !== "map");
          step.clear = on ? ["map", ...rest] : rest;
        }, context),
      ]),
      this.slot([...path, "point"]),
      this.slot([...path, "clear"]),
      this.slot(path),
    ]);
  }

  private renderAction(guide: Guide, step: Step, action: Action, stepIndex: number, index: number, context: FormContext): HTMLElement {
    const actions = step.actions!;
    const spec = this.catalog!.action_specs[action.kind];
    const path = ["steps", stepIndex, "actions", index];
    const head = node("div", { class: "editor-card-head" }, [
      node("span", { class: `editor-surface editor-surface-${spec?.surface ?? "any"}`, text: SURFACE_LABEL[spec?.surface ?? "any"] }),
      node("strong", { text: spec?.label ?? action.kind }),
      node("span", { class: "assistant-spacer" }),
      tool("↑", "Move up", () => {
        move(actions, index, -1);
        this.render();
      }, index === 0),
      tool("↓", "Move down", () => {
        move(actions, index, 1);
        this.render();
      }, index === actions.length - 1),
      tool("×", "Remove this action", () => {
        actions.splice(index, 1);
        this.render();
      }),
    ]);
    if (!spec) return node("div", { class: "editor-action" }, [head, this.slot([...path, "kind"]), this.slot(path)]);
    const fields = Object.entries(spec.args).map(([name, arg]) =>
      node("div", {}, [labelled(arg.label, this.argument(guide, action, name, arg, { step: stepIndex, action: index }, context), undefined, arg.required), this.slot([...path, name])]),
    );
    return node("div", { class: "editor-action" }, [head, ...fields, this.slot([...path, "kind"]), this.slot(path)]);
  }

  /** The form field for one argument of one action, by the argument's type. */
  private argument(guide: Guide, action: Action, name: string, arg: ArgumentSpec, at: { step: number; action: number }, context: FormContext): HTMLElement {
    const set = (value: unknown) => {
      if (value === undefined) delete action[name];
      else action[name] = value;
    };
    const value = action[name];
    const list = (): string[] => {
      if (!Array.isArray(action[name])) action[name] = value === undefined || value === "" ? [] : [value];
      return action[name] as string[];
    };
    const sample = this.currentSample();

    switch (arg.type) {
      case "locator": {
        // Rows are part of the action: chosen here, and edited right below.
        const names = Object.keys(guide.locators ?? {});
        const current = typeof value === "string" && guide.locators?.[value] ? value : "";
        const options: [string, string][] = [
          ...(arg.required ? [] : ([["", "None"]] as [string, string][])),
          ...(current ? ([[current, "These rows"]] as [string, string][]) : arg.required ? ([["", "Choose rows\u2026"]] as [string, string][]) : []),
          ["__new", "New rows"],
          ...names
            .filter((n) => n !== current)
            .map((n) => {
              const users = this.usersOf(guide, n).map((user) => user.step + 1);
              const where = users.length ? ` (step ${[...new Set(users)].join(", ")})` : "";
              return [n, `Same as ${this.describeRows(guide.locators![n])}${where}`] as [string, string];
            }),
        ];
        const select = choice(current, options, (next) => {
          set(next === "__new" ? this.newRows(guide) : next || undefined);
          this.render();
        }, context, arg.label);
        if (!current) return select;
        return node("div", { class: "editor-rows-wrap" }, [select, this.renderRows(guide, action, name, at, context)]);
      }
      case "column":
      case "columns": {
        const of = arg.of ? (action[arg.of] as string | undefined) : undefined;
        const table = tableFor(of ? guide.locators?.[of] : undefined, sample, this.tables());
        const columns = table?.columns.map((column) => column.name) ?? null;
        if (arg.type === "columns") return columnsInput(context, list(), columns);
        return columns
          ? choice(String(value ?? ""), [["", "Choose a column…"], ...columns.map((c) => [c, c] as [string, string])], (next) => set(next || undefined), context)
          : templateInput(context, { value: String(value ?? ""), placeholder: "column", onChange: (next) => set(next) });
      }
      case "text":
        return templateInput(context, { value: value === undefined ? "" : String(value), placeholder: "{{field}}", onChange: (next) => set(next) });
      case "text_list":
        return listInput(context, list(), { placeholder: "{{field}}" });
      case "integer":
      case "number":
        return numberInput(value, set, context, arg);
      case "boolean":
        return checkbox(Boolean(value), "Yes", (on) => set(on || undefined), context);
      case "enum":
        return choice(String(value ?? ""), [["", "None"], ...(arg.values ?? []).map((v) => [v, v === "empty" ? "Empty: finding no rows is the point" : v] as [string, string])], (next) => set(next || undefined), context);
      case "endpoint": {
        const end = (isMapping(value) ? value : {}) as { stop?: string; point?: string };
        const which = end.point !== undefined ? "point" : "stop";
        return node("div", { class: "editor-endpoint" }, [
          choice(which, [["stop", "Stop"], ["point", "Point"]], (next) => {
            const current = (isMapping(action[name]) ? action[name] : {}) as Record<string, string>;
            set({ [next]: current.stop ?? current.point ?? "" });
          }, context, "Stop or point"),
          templateInput(context, {
            value: String((which === "point" ? end.point : end.stop) ?? ""),
            placeholder: which === "point" ? "{{match}}" : "{{stopId}}",
            onChange: (next) => {
              const current = (isMapping(action[name]) ? action[name] : {}) as Record<string, string>;
              set({ [current.point !== undefined ? "point" : "stop"]: next });
            },
          }),
        ]);
      }
      case "point_list": {
        const points = list() as unknown as (string | [string, string])[];
        return node("div", { class: "editor-list" }, [
          ...points.map((point, i) =>
            node("div", { class: "editor-list-row" }, [
              ...(Array.isArray(point)
                ? [
                    templateInput(context, { value: point[0] ?? "", placeholder: "{{latFieldValue}}", label: "Latitude", onChange: (next) => (point[0] = next) }),
                    templateInput(context, { value: point[1] ?? "", placeholder: "{{lonFieldValue}}", label: "Longitude", onChange: (next) => (point[1] = next) }),
                  ]
                : [templateInput(context, { value: point, placeholder: "{{match}}", onChange: (next) => (points[i] = next) })]),
              tool("×", "Remove", () => {
                points.splice(i, 1);
                this.render();
              }),
            ]),
          ),
          node("div", { class: "editor-row" }, [
            button("+ Field with a place", "A field holding [lat, lon]", () => {
              points.push("");
              this.render();
            }, "editor-add"),
            button("+ Latitude and longitude", "Two fields", () => {
              points.push(["", ""]);
              this.render();
            }, "editor-add"),
          ]),
        ]);
      }
      case "edge": {
        const edge = (isMapping(value) ? value : {}) as { from?: string; to?: string };
        const update = (part: "from" | "to") => (next: string) => {
          const current = (isMapping(action[name]) ? action[name] : {}) as Record<string, string>;
          set({ ...current, [part]: next });
        };
        return node("div", { class: "editor-endpoint" }, [
          templateInput(context, { value: edge.from ?? "", placeholder: "file.field it is in", label: "From", onChange: update("from") }),
          node("span", { class: "editor-equals", text: "→" }),
          templateInput(context, { value: edge.to ?? "", placeholder: "file.field it refers to", label: "To", onChange: update("to") }),
        ]);
      }
      case "object":
        return jsonInput(value, set, context);
    }
  }

  private renderFix(guide: Guide, context: FormContext): HTMLElement {
    guide.fix ??= [];
    const fix = guide.fix;
    const rows = fix.map((line, index) =>
      node("div", {}, [
        node("div", { class: "editor-list-row" }, [
          templateInput(context, {
            value: typeof line === "string" ? line : String(line),
            multiline: true,
            showPreview: true,
            placeholder: index === 0 ? "What to change, e.g. Correct stop_lat and stop_lon for {{stopId}}." : "Another way to fix it.",
            onChange: (value) => (fix[index] = value),
          }),
          tool("×", "Remove", () => {
            fix.splice(index, 1);
            this.render();
          }),
        ]),
        this.slot(["fix", index]),
      ]),
    );
    return this.section(
      "How to fix it",
      "The first line is the tour's last step; the others are listed under it. Left empty, the last step is the rule in the validator's words.",
      [
        ...rows,
        button("+ Fix", "Add a way to fix it", () => {
          fix.push("");
          this.render();
        }, "editor-add"),
      ],
      ["fix"],
    );
  }
}
