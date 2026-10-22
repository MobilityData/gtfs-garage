/**
 * Tours: every notice the validator can report, and the tour for each.
 *
 * Where tours are written, apart from any report. The Quality screen lists
 * what one report found, which is the wrong list to write tours from: a
 * notice the open feed does not raise would have no way in. This lists all of
 * them, from the validator's own rules, with where each one's tour comes from
 * and which demo feeds raise it, so a tour can be tried on a real sample.
 *
 * Reached from the options menu, not the sidebar: it is a tool for whoever
 * writes tours, not a view of the feed.
 */

import { loadCatalog, type Catalog } from "../../quality/catalog";
import type { GuideOrigin } from "../../quality/guide-store";
import type { Demo, ViewerSource, WorkspaceFeed } from "../../sources/types";
import { node, section, stat } from "../html";
import type { Screen, ScreenContext } from "./types";

const SEVERITIES = ["ERROR", "WARNING", "INFO", "SYSTEM_ERROR"] as const;
const SEVERITY_LABEL: Record<string, string> = { ERROR: "Errors", WARNING: "Warnings", INFO: "Infos", SYSTEM_ERROR: "System errors" };
const SEVERITY_CLASS: Record<string, string> = { ERROR: "err", WARNING: "warn", INFO: "info", SYSTEM_ERROR: "err" };
const ORIGIN_LABEL: Record<GuideOrigin, string> = { saved: "saved tour", builtin: "built-in tour", generic: "automatic" };
const ORIGIN_FILTERS: [string, string, (origin: GuideOrigin) => boolean][] = [
  ["all", "All", () => true],
  ["written", "With a tour", (origin) => origin !== "generic"],
  ["saved", "Saved here", (origin) => origin === "saved"],
  ["none", "No tour yet", (origin) => origin === "generic"],
];

interface ToursData {
  catalog: Catalog;
  demos: Demo[];
  /** Workdir feeds a demo of your own can be made from; null without a workdir. */
  feeds: WorkspaceFeed[] | null;
}

function demoChips(code: string, demos: Demo[]): HTMLElement {
  const having = demos.filter((demo) => demo.available && demo.notices[code]);
  if (!having.length) return node("span", { class: "explore-hint", text: "none" });
  return node(
    "div",
    { class: "tours-demos" },
    having.map((demo) => node("span", { class: "chip tours-demo-chip", title: `${demo.notices[code]} in ${demo.title}`, text: `${demo.title} ×${demo.notices[code]}` })),
  );
}

function renderDemos(data: ToursData, context: ScreenContext): HTMLElement {
  const source = context.source;
  const rows = data.demos.map((demo) => {
    const remove =
      !demo.builtin && source.removeDemo
        ? (() => {
            const element = node("button", { title: "Forget this demo; its feed stays in the workdir", text: "Remove" });
            element.addEventListener("click", async () => {
              if (!window.confirm(`Forget the demo "${demo.title}"? Its feed stays in the workdir.`)) return;
              await source.removeDemo!(demo.id);
              context.openScreen("tours");
            });
            return element;
          })()
        : null;
    return node("tr", {}, [
      node("td", {}, [node("strong", { text: demo.title }), node("div", { class: "explore-hint", text: demo.description })]),
      node("td", { class: "value-numeric", text: String(Object.keys(demo.notices).length) }),
      node("td", { class: "explore-hint", text: demo.builtin ? "built in" : demo.available ? "yours" : "yours, feed removed" }),
      node("td", {}, [remove]),
    ]);
  });

  const add = data.feeds && source.addDemo ? renderAddDemo(data.feeds, context) : null;
  return section(
    "Demo feeds",
    "Feeds to try tours on, each with the report gtfs-validator wrote for it. The Tour Studio reads them beside your feed, never in its place.",
    [
      data.demos.length
        ? node("table", { class: "quality-list tours-demo-list" }, [
            node("thead", {}, [node("tr", {}, [node("th", { text: "Demo" }), node("th", { class: "value-numeric", text: "Notices" }), node("th", { text: "" }), node("th", { text: "" })])]),
            node("tbody", {}, rows),
          ])
        : node("p", { class: "explore-hint", text: "This viewer has no demo feeds." }),
      add,
    ],
  );
}

/** Make a demo of a feed in the workdir and a report for it. */
function renderAddDemo(feeds: WorkspaceFeed[], context: ScreenContext): HTMLElement {
  const own = feeds.filter((feed) => feed.kind !== "demo" && feed.reloadable);
  const feedChoice = node(
    "select",
    { "aria-label": "Feed" },
    own.length ? own.map((feed) => node("option", { value: feed.id, text: feed.label })) : [node("option", { value: "", text: "No feed in the workdir yet" })],
  );
  const title = node("input", { type: "text", placeholder: "What to call it", "aria-label": "Title" });
  const report = node("input", { type: "file", accept: ".json,application/json", "aria-label": "Its report.json" });
  const status = node("span", { class: "explore-hint" });
  const button = node("button", { class: "primary", text: "Add demo" });
  button.disabled = !own.length;
  button.addEventListener("click", async () => {
    const file = report.files?.[0];
    if (!feedChoice.value || !file) {
      status.textContent = "Choose a feed and its report.json.";
      return;
    }
    button.disabled = true;
    status.textContent = "Adding…";
    try {
      await context.source.addDemo!(feedChoice.value, file, title.value.trim() || undefined);
      context.openScreen("tours");
    } catch (error) {
      status.textContent = (error as Error).message;
      button.disabled = false;
    }
  });
  return node("div", { class: "tours-add" }, [
    node("h4", { text: "Add one of your own" }),
    node("p", { class: "explore-hint", text: "A feed already in the workdir, and the report.json gtfs-validator wrote for it. Its feed is then never evicted from the workdir." }),
    node("div", { class: "tours-add-row" }, [feedChoice, title, report, button]),
    status,
  ]);
}

/**
 * The list's filters, kept for the page rather than per render: a tour saved
 * in the studio draws this list again, and the reader's search should survive it.
 */
const kept = { text: "", severity: "", origin: "all", demo: false };

export function renderTours(data: ToursData, context: ScreenContext): HTMLElement {
  const quality = context.quality;
  const catalog = data.catalog;
  const origin = (code: string): GuideOrigin => quality?.origin?.(code) ?? (catalog.notices[code]?.guide ? "builtin" : "generic");
  const codes = Object.keys(catalog.notices).sort((a, b) => {
    const rank = (code: string) => SEVERITIES.indexOf(catalog.notices[code].severity as (typeof SEVERITIES)[number]);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const filter = kept;
  const body = node("tbody");
  const shownCount = node("span", { class: "explore-hint" });

  const draw = () => {
    const test = ORIGIN_FILTERS.find(([id]) => id === filter.origin)![2];
    const text = filter.text.trim().toLowerCase();
    const shown = codes.filter((code) => {
      const notice = catalog.notices[code];
      if (filter.severity && notice.severity !== filter.severity) return false;
      if (!test(origin(code))) return false;
      if (filter.demo && !data.demos.some((demo) => demo.available && demo.notices[code])) return false;
      if (text && !`${code} ${notice.summary} ${notice.files.join(" ")}`.toLowerCase().includes(text)) return false;
      return true;
    });
    shownCount.textContent = `${shown.length} of ${codes.length} notices`;
    body.replaceChildren(
      ...shown.map((code) => {
        const notice = catalog.notices[code];
        const from = origin(code);
        const edit = node("button", {
          class: from === "generic" ? undefined : "primary",
          title: from === "generic" ? "Write a tour for this notice" : "Change this notice's tour, try it and save it",
          text: from === "generic" ? "Create tour" : "Edit tour",
        });
        edit.disabled = !quality?.edit;
        edit.addEventListener("click", () => quality?.edit?.(code, 0, "demo"));
        return node("tr", {}, [
          node("td", {}, [node("span", { class: `pill ${SEVERITY_CLASS[notice.severity] ?? "info"}`, text: notice.severity })]),
          node("td", {}, [
            node("div", { class: "quality-code", text: code }),
            node("div", { class: "explore-hint", text: notice.summary }),
            notice.deprecated ? node("div", { class: "explore-hint", text: "Deprecated by the validator." }) : null,
          ]),
          node("td", {}, [node("span", { class: `quality-origin quality-origin-${from}`, text: ORIGIN_LABEL[from] })]),
          node("td", {}, [demoChips(code, data.demos)]),
          node("td", {}, [edit]),
        ]);
      }),
    );
  };

  const search = node("input", { type: "search", class: "tours-search", placeholder: "Find a notice by code, words or file", "aria-label": "Find a notice" });
  search.value = filter.text;
  search.addEventListener("input", () => {
    filter.text = search.value;
    draw();
  });
  const chips = (label: string, options: [string, string][], current: () => string, set: (value: string) => void) => {
    const row = node("div", { class: "facet-row" }, [node("span", { class: "facet-label", text: label })]);
    const buttons = options.map(([value, text]) => {
      const element = node("button", { class: `chip facet-chip${current() === value ? " active" : ""}`, text });
      element.addEventListener("click", () => {
        set(value);
        for (const other of buttons) other.classList.toggle("active", other === element);
        draw();
      });
      return element;
    });
    row.append(...buttons);
    return row;
  };
  const demoOnly = node("input", { type: "checkbox" });
  demoOnly.checked = filter.demo;
  demoOnly.addEventListener("change", () => {
    filter.demo = demoOnly.checked;
    draw();
  });

  const counts = { builtin: 0, saved: 0, generic: 0 };
  for (const code of codes) counts[origin(code)] += 1;
  const covered = codes.filter((code) => data.demos.some((demo) => demo.available && demo.notices[code])).length;

  draw();
  return node("div", { class: "explore quality tours" }, [
    node("div", { class: "quality-title" }, [node("h2", { text: "Tours" })]),
    node("p", {
      class: "explore-intro",
      text:
        "Every notice gtfs-validator can report, and the tour the Quality assistant plays for it. Write or change a tour here, " +
        "try it on a demo feed that raises the notice, and save it.",
    }),
    node("div", { class: "stat-row" }, [
      stat("Notices", String(codes.length), "Every code in the validator's rules"),
      stat("Built-in tours", String(counts.builtin), "Shipped with this viewer"),
      stat("Saved here", String(counts.saved), "Written or changed in this browser"),
      stat("In a demo feed", `${covered} / ${codes.length}`, "Notices a demo feed raises, so their tours can be run"),
    ]),
    node("div", { class: "facets" }, [
      node("div", { class: "facet-row" }, [search, shownCount]),
      chips("Severity", [["", "All"], ...SEVERITIES.map((level) => [level, SEVERITY_LABEL[level]] as [string, string])], () => filter.severity, (value) => (filter.severity = value)),
      chips("Tour", ORIGIN_FILTERS.map(([id, text]) => [id, text] as [string, string]), () => filter.origin, (value) => (filter.origin = value)),
      node("label", { class: "raw-toggle tours-demo-toggle" }, [demoOnly, " Only notices a demo feed raises"]),
    ]),
    node("div", { class: "quality-scroll" }, [
      node("table", { class: "quality-list tours-list" }, [
        node("thead", {}, [
          node("tr", {}, [
            node("th", { text: "Severity" }),
            node("th", { text: "Notice" }),
            node("th", { text: "Tour" }),
            node("th", { text: "Demo feeds" }),
            node("th", { text: "" }),
          ]),
        ]),
        body,
      ]),
    ]),
    renderDemos(data, context),
  ]);
}

export const toursScreen: Screen<ToursData> = {
  id: "tours",
  // No label: reached from the options menu, not the sidebar.
  title: "Write and try the Quality assistant's tours, for every notice",
  // A long list of notices: the width a map would take is better spent on it.
  layout: "none",
  available: () => true,
  fetch: async (source: ViewerSource) => {
    const [catalog, demos, workspace] = await Promise.all([
      loadCatalog(),
      source.demos?.().catch(() => [] as Demo[]) ?? Promise.resolve([] as Demo[]),
      source.workspace?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    return { catalog, demos, feeds: workspace?.feeds ?? null };
  },
  render: (data, context) => renderTours(data, context),
};
