/**
 * The Quality catalog: what the validator says about each notice code, and the
 * guide the assistant follows for it.
 *
 * Built by `scripts/build_guides.py` from the validator's own `rules.json` and
 * `schema/guides/*.yaml`, and loaded on demand rather than bundled up front: it
 * is a couple of hundred kilobytes describing every notice the validator can
 * emit, and a reader who never opens Quality should not pay for it.
 */

import { asText, type Sample } from "./template";

export type Severity = "ERROR" | "WARNING" | "INFO" | "SYSTEM_ERROR";

export interface FieldDescription {
  type?: string | null;
  description: string;
}

/**
 * Where a notice's rows are, in terms of its sample's fields.
 *
 * `line` is the validator's `csvRowNumber`, which locates any row of any file;
 * `key` is a set of column values, which works where line numbers are not
 * available. Both may be given, and the more reliable one is used.
 */
export interface Locator {
  file: string;
  line?: string;
  key?: Record<string, string>;
}

export interface Action {
  kind: string;
  [argument: string]: unknown;
}

export interface Step {
  text: string;
  actions?: Action[];
  /** Surfaces to empty before this step, which otherwise keep what they show. */
  clear?: ("map" | "panel")[];
  /** What the step's card points at; by default the rows it opens, else the map it draws on. */
  point?: "rows" | "map";
}

export interface Guide {
  code: string;
  locators?: Record<string, Locator>;
  steps: Step[];
  fix?: string[];
}

export interface NoticeDescription {
  severity: Severity;
  summary: string;
  description: string;
  files: string[];
  best_practices_files: string[];
  sections: string[];
  urls: { label: string; url: string }[];
  fields: Record<string, FieldDescription>;
  deprecated: boolean;
  guide?: Guide;
}

/** How the editor asks for an action argument; see `ACTIONS` in `gtfs_garage/quality/guides.py`. */
export type ArgumentType =
  | "locator"
  | "column"
  | "columns"
  | "text"
  | "text_list"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "endpoint"
  | "point_list"
  | "edge"
  | "object";

export interface ArgumentSpec {
  type: ArgumentType;
  label: string;
  required: boolean;
  /** For `column` and `columns`: the locator argument whose file the columns are of. */
  of?: string;
  /** For `enum`. */
  values?: string[];
  min?: number;
}

export interface ActionSpec {
  label: string;
  /** What the action changes: the content pane (one per step), the map, the step's card, or whatever a host handler does. */
  surface: "content" | "map" | "panel" | "any";
  args: Record<string, ArgumentSpec>;
}

/** What a guide may say, as the build that wrote the catalog checked it. */
export interface Vocabulary {
  formatters: string[];
  action_specs: Record<string, ActionSpec>;
  surfaces: string[];
  points: string[];
}

export interface Catalog extends Vocabulary {
  validator: string | null;
  notices: Record<string, NoticeDescription>;
}

let loading: Promise<Catalog> | null = null;

/** The catalog, fetched once per page. */
export function loadCatalog(): Promise<Catalog> {
  loading ??= import("../../../src/gtfs_garage/data/guides.json").then(
    (module) => (module.default ?? module) as unknown as Catalog,
  );
  return loading;
}

/** A GTFS file name as the viewer's table name: `stops.txt` is `stops`. */
export function tableOf(file: string): string {
  return file.replace(/\.(txt|geojson)$/i, "");
}

/**
 * The validator's names for the ids the viewer knows how to open, and where.
 *
 * Matched after stripping a `from`/`to` prefix and a pair suffix, so
 * `fromStopId`, `stopId2` and `stopIdA` are all stops.
 */
const ID_FIELDS: Record<string, { table: string; column: string; map?: "stops" | "routes" | "shapes" }> = {
  stopId: { table: "stops", column: "stop_id", map: "stops" },
  routeId: { table: "routes", column: "route_id", map: "routes" },
  shapeId: { table: "shapes", column: "shape_id", map: "shapes" },
  tripId: { table: "trips", column: "trip_id" },
  serviceId: { table: "calendar", column: "service_id" },
  agencyId: { table: "agency", column: "agency_id" },
  blockId: { table: "trips", column: "block_id" },
  pathwayId: { table: "pathways", column: "pathway_id" },
  levelId: { table: "levels", column: "level_id" },
  fareMediaId: { table: "fare_media", column: "fare_media_id" },
  fareProductId: { table: "fare_products", column: "fare_product_id" },
  riderCategoryId: { table: "rider_categories", column: "rider_category_id" },
  attributionId: { table: "attributions", column: "attribution_id" },
  bookingRuleId: { table: "booking_rules", column: "booking_rule_id" },
  locationGroupId: { table: "location_groups", column: "location_group_id" },
  networkId: { table: "networks", column: "network_id" },
  // A GeoJSON zone, however the notice names it.
  locationId: { table: "locations", column: "id" },
  featureId: { table: "locations", column: "id" },
  geographyId: { table: "locations", column: "id" },
};

/** Which file a `...CsvRowNumber` field counts the lines of. */
const ROW_FIELDS: Record<string, string> = {
  tripCsvRowNumber: "trips",
  stopTimeCsvRowNumber: "stop_times",
  routeCsvRowNumber: "routes",
};

/** `fromStopId` -> `stopId`, `stopId2` -> `stopId`, `routeIds` -> `routeId`. */
function idKind(field: string): string | null {
  const base = field
    .replace(/^(from|to|prev|next)([A-Z])/, (_, __, first: string) => first.toLowerCase())
    .replace(/(Id)(s|1|2|A|B)$/, "$1");
  return base in ID_FIELDS ? base : null;
}

/** Every value an id field holds; `routeIds` is a comma-separated list. */
function idValues(sample: Sample, field: string): string[] {
  return asText(sample[field])
    .split(field.endsWith("Ids") ? "," : "\u0000")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The file a notice's bare `csvRowNumber` counts.
 *
 * The sample names it when the rule applies to many files. When it does not,
 * the rule is about one file, and the validator's own rules list it first among
 * the files the rule reads.
 */
function rowFile(sample: Sample, notice: NoticeDescription | undefined, code: string): string | null {
  for (const field of ["filename", "childFilename", "fileNameA"]) {
    if (typeof sample[field] === "string" && sample[field]) return `{{${field}}}`;
  }
  if (notice?.files.length) return notice.files[0];
  if (code.startsWith("missing_feed_") || code.startsWith("feed_")) return "feed_info.txt";
  return null;
}

/**
 * A walkthrough for a notice nobody has written a guide for.
 *
 * Built from the names of the fields its sample carries, which say a great deal
 * on their own: a row number locates a row, `fieldName` names the cell, a
 * `stopId` is a point on the map, two of anything are a pair to compare, a
 * latitude and longitude are a place. It answers where the problem is, and
 * leaves why to the validator's own description, which the last step shows.
 */
export function fallbackGuide(code: string, notice: NoticeDescription | undefined, sample: Sample): Guide {
  const has = (field: string) => sample[field] !== undefined && sample[field] !== null && sample[field] !== "";
  const fields = Object.keys(sample).filter(has);
  const locators: Record<string, Locator> = {};
  const steps: Step[] = [];
  const file = rowFile(sample, notice, code);
  const cell = has("fieldName") ? ["{{fieldName}}"] : has("childFieldName") ? ["{{childFieldName}}"] : [];

  // 1. The rows the notice is about, by line: one, or a pair side by side.
  const pairRows = fields.filter((field) => /^csvRowNumber(1|2|A|B)$/.test(field)).sort();
  if (file && has("csvRowNumber")) {
    locators.row = { file, line: "{{csvRowNumber}}" };
    steps.push({
      text: has("fieldName") ? `Line {{csvRowNumber}} of ${file}, field {{fieldName}}.` : `Line {{csvRowNumber}} of ${file}.`,
      actions: [
        { kind: "open_rows", at: "row", highlight: cell },
        ...(cell.length ? [{ kind: "show_record", at: "row", fields: cell }] : []),
      ],
    });
  } else if (file && pairRows.length >= 1) {
    locators.rows = { file, line: pairRows.map((field) => `{{${field}}}`).join(",") };
    const actions: Action[] = [{ kind: "open_rows", at: "rows" }];
    if (pairRows.length === 2) {
      locators.a = { file, line: `{{${pairRows[0]}}}` };
      locators.b = { file, line: `{{${pairRows[1]}}}` };
      actions.push({ kind: "compare_records", a: "a", b: "b" });
    }
    steps.push({ text: `Lines ${pairRows.map((field) => `{{${field}}}`).join(" and ")} of ${file}.`, actions });
  } else if (has("oldCsvRowNumber") && has("newCsvRowNumber") && file) {
    locators.rows = { file, line: "{{oldCsvRowNumber}},{{newCsvRowNumber}}" };
    steps.push({ text: `Lines {{oldCsvRowNumber}} and {{newCsvRowNumber}} of ${file}.`, actions: [{ kind: "open_rows", at: "rows" }] });
  }

  // 2. A reference that resolves to nothing: the parent lookup is the evidence.
  if (has("parentFilename") && has("parentFieldName") && has("fieldValue")) {
    locators.parent = { file: "{{parentFilename}}", key: { "{{parentFieldName}}": "{{fieldValue}}" } };
    steps.push({
      text: "Nothing in {{parentFilename}} has {{parentFieldName}} = {{fieldValue}}.",
      actions: [{ kind: "open_rows", at: "parent", expect: "empty" }],
    });
  }

  // 3. Rows in another file, named by their own row-number field.
  for (const [rowField, table] of Object.entries(ROW_FIELDS)) {
    if (!has(rowField) || steps.length >= 4) continue;
    locators[`${table}_row`] = { file: table, line: `{{${rowField}}}` };
    steps.push({ text: `Line {{${rowField}}} of ${table}.txt.`, actions: [{ kind: "open_rows", at: `${table}_row` }] });
  }

  // 4. What the map can draw: stops, routes and shapes by id, zones, places.
  const drawn: Record<"stops" | "routes" | "shapes", string[]> = { stops: [], routes: [], shapes: [] };
  const opened: { field: string; kind: string }[] = [];
  for (const field of fields) {
    const kind = idKind(field);
    if (!kind) continue;
    const target = ID_FIELDS[kind];
    if (target.map) {
      for (let i = 0; i < idValues(sample, field).length; i += 1) {
        drawn[target.map].push(field.endsWith("Ids") ? idValues(sample, field)[i] : `{{${field}}}`);
      }
    }
    opened.push({ field, kind });
  }
  const points: unknown[] = [];
  if (has("latFieldValue") && has("lonFieldValue")) points.push(["{{latFieldValue}}", "{{lonFieldValue}}"]);
  for (const field of fields) if (/^match(1|2)?$/.test(field)) points.push(`{{${field}}}`);

  const anyDrawn = drawn.stops.length || drawn.routes.length || drawn.shapes.length || points.length;
  if (anyDrawn) {
    const focus: Action = { kind: "map_focus" };
    for (const [kind, values] of Object.entries(drawn)) if (values.length) focus[kind] = values;
    if (points.length) focus.points = points;
    const actions: Action[] = [focus];
    if (drawn.stops.length === 2) actions.push({ kind: "map_measure", from: { stop: drawn.stops[0] }, to: { stop: drawn.stops[1] } });
    else if (drawn.stops.length && has("match")) actions.push({ kind: "map_measure", from: { stop: drawn.stops[0] }, to: { point: "{{match}}" } });
    if (steps.length) {
      // The map goes with the rows, in the same step: the reader sees the row
      // and where it is at once, rather than one and then the other.
      steps[0].actions = [...(steps[0].actions ?? []), ...actions];
    } else {
      // With no row opened yet, open the first thing the map is drawing.
      const first = opened[0];
      if (first) {
        const target = ID_FIELDS[first.kind];
        locators.entity = { file: target.table, key: { [target.column]: `{{${first.field}}}` } };
        actions.unshift({ kind: "open_rows", at: "entity" });
      }
      // The validator's summary, added below, is the sentence; the card
      // points at the map, which is where the answer is.
      steps.push({ text: "", actions, point: "map" });
    }
  } else if (!steps.length && opened.length) {
    // 5. An id with no geometry: open its rows by key.
    const { field, kind } = opened[0];
    const target = ID_FIELDS[kind];
    locators.entity = { file: target.table, key: { [target.column]: `{{${field}}}` } };
    steps.push({ text: `${target.table}.txt, ${target.column} = {{${field}}}.`, actions: [{ kind: "open_rows", at: "entity" }] });
  }

  // 6. A file named without a row: open the file.
  if (!steps.length && file && /\{\{|\.txt$/.test(file)) {
    locators.file = { file, key: {} };
    steps.push({ text: `The file ${file}.`, actions: [{ kind: "open_rows", at: "file" }] });
  }

  // 7. Dates with nothing else to go on: the calendar.
  if (!steps.length && fields.some((field) => /Date$|^date/.test(field))) {
    steps.push({ text: "The days the feed runs on.", actions: [{ kind: "calendar" }] });
  }

  if (!steps.length) steps.push({ text: notice?.summary || code });
  // The validator's one-line summary says what is wrong; the steps say where.
  else if (notice?.summary) steps[0].text = `${notice.summary.replace(/\.?$/, ".")} ${steps[0].text}`.trim();
  for (const step of steps) step.text ||= code;
  return { code, locators, steps };
}

/** The guide for a code: the authored one, or one derived from the sample. */
export function guideFor(catalog: Catalog, code: string, sample: Sample): { guide: Guide; authored: boolean } {
  const authored = catalog.notices[code]?.guide;
  return authored ? { guide: authored, authored: true } : { guide: fallbackGuide(code, catalog.notices[code], sample), authored: false };
}

/** A sample field's value as a reader sees it, for tables of samples. */
export function sampleText(sample: Sample, field: string): string {
  return asText(sample[field]);
}

/** Where the spec explains a section the validator cites. */
export function sectionUrl(section: string): string {
  return `https://gtfs.org/documentation/schedule/reference/#${encodeURIComponent(section)}`;
}

/** The best practices page for a file the validator cites. */
export function bestPracticesUrl(file: string): string {
  return `https://gtfs.org/documentation/schedule/schedule-best-practices/#${encodeURIComponent(file.replace(/\./g, ""))}`;
}
