/**
 * The derived views as SQL, for a reader with no server.
 *
 * Ported from `core/service.py`, `core/overview.py` and `core/network.py`. The
 * SQL is the same SQL - both runtimes send it to DuckDB - with three
 * differences forced by where it runs:
 *
 * - **Tables are files.** `FROM trips` becomes `FROM 'https://…/trips.parquet'`,
 *   which `Catalogue.file` supplies.
 * - **Values are inlined, not bound.** DuckDB-WASM's query API takes a string.
 *   Nothing user-supplied reaches these except a `route_id`, which is escaped
 *   by `literal` the way `sources/parquet.ts` escapes a filter value.
 * - **Every result is a scalar or a string.** Lists come back as JSON text and
 *   are parsed by the caller, rather than as Arrow lists that each need
 *   unwrapping. Dates are formatted in SQL for the same reason.
 */

/** What the reader knows about the dataset it is querying. */
export interface Catalogue {
  /** The table's columns, or undefined when the dataset has no such table. */
  columns(table: string): string[] | undefined;
  /** The table as a quoted source DuckDB can read - `'https://…/stops.parquet'`. */
  file(table: string): string;
}

export function has(catalogue: Catalogue, table: string, ...columns: string[]): boolean {
  const present = catalogue.columns(table);
  return present !== undefined && columns.every((column) => present.includes(column));
}

/** A string as a SQL literal. Doubling quotes is the whole of the escaping. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `"column"`, or a NULL standing in for it when the dataset has no such column. */
export function column(catalogue: Catalogue, table: string, name: string, alias = name): string {
  return has(catalogue, table, name) ? `"${name}" AS ${alias}` : `NULL AS ${alias}`;
}

/**
 * GTFS times run past midnight - 25:10:00 is valid - so they are parsed as an
 * offset in seconds rather than a clock time, which is also what makes them
 * sortable. Mirrors `SECONDS` in `core/network.py`.
 */
function seconds(expression: string): string {
  return `(COALESCE(try_cast(split_part(${expression}, ':', 1) AS BIGINT), 0) * 3600
         + COALESCE(try_cast(split_part(${expression}, ':', 2) AS BIGINT), 0) * 60
         + COALESCE(try_cast(split_part(${expression}, ':', 3) AS BIGINT), 0))`;
}

/**
 * Where a call's times live, in the order they are preferred.
 *
 * A fixed-schedule feed states `arrival_time` and `departure_time`. A flex one
 * often states neither: a demand-responsive trip has a window it can be booked
 * in rather than a time it calls. The older spelling without the underscores is
 * in the wild and reads the same, so both are accepted. Mirrors `TIME_COLUMNS`
 * in `core/network.py`.
 */
const TIME_COLUMNS = {
  arrival: ["arrival_time", "start_pickup_drop_off_window", "start_pickup_dropoff_window"],
  departure: ["departure_time", "end_pickup_drop_off_window", "end_pickup_dropoff_window"],
};

/** SQL expressions, so a dataset stating none of them yields NULL not an error. */
export function timeColumns(catalogue: Catalogue): {
  arrival: string;
  departure: string;
  windows: boolean;
} {
  const first = (names: string[]) => names.find((name) => has(catalogue, "stop_times", name));
  const arrival = first(TIME_COLUMNS.arrival);
  const departure = first(TIME_COLUMNS.departure);
  const windows =
    (arrival !== undefined && arrival !== "arrival_time") ||
    (departure !== undefined && departure !== "departure_time");

  return {
    arrival: arrival ? `st."${arrival}"` : "NULL",
    departure: departure ? `st."${departure}"` : "NULL",
    windows: windows && Boolean(arrival ?? departure),
  };
}

export class NoCalendarError extends Error {}

/** The query that finds the first and last date the feed describes. */
export function boundsSql(catalogue: Catalogue): string {
  const pieces: string[] = [];
  if (has(catalogue, "calendar", "start_date", "end_date")) {
    pieces.push(`SELECT try_strptime(start_date, '%Y%m%d') AS d FROM ${catalogue.file("calendar")}`);
    pieces.push(`SELECT try_strptime(end_date, '%Y%m%d') AS d FROM ${catalogue.file("calendar")}`);
  }
  if (has(catalogue, "calendar_dates", "date")) {
    pieces.push(`SELECT try_strptime(date, '%Y%m%d') AS d FROM ${catalogue.file("calendar_dates")}`);
  }
  if (!pieces.length) {
    throw new NoCalendarError("This feed has no calendar.txt and no calendar_dates.txt.");
  }
  return `
    SELECT strftime(min(d), '%Y-%m-%d') AS first_date, strftime(max(d), '%Y-%m-%d') AS last_date
    FROM (${pieces.join(" UNION ALL ")}) WHERE d IS NOT NULL
  `;
}

/**
 * One (service_id, date) row per day a service runs.
 *
 * The two halves are not symmetrical: a removal is applied to the weekly
 * pattern before additions are unioned in, because GTFS lets a feed remove a
 * date from one service and add it to another, and the other order drops the
 * addition.
 */
function expansionSql(catalogue: Catalogue, first: string, last: string): string {
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  let weekly = "";
  if (has(catalogue, "calendar", "service_id", "start_date", "end_date", ...weekdays)) {
    const runs = weekdays.map((day, index) => `WHEN ${index} THEN c.${day}`).join(" ");
    weekly = `
      SELECT c.service_id, CAST(day AS DATE) AS date
      FROM ${catalogue.file("calendar")} c,
           UNNEST(generate_series(
               greatest(try_strptime(c.start_date, '%Y%m%d'), CAST(${literal(first)} AS TIMESTAMP)),
               least(try_strptime(c.end_date, '%Y%m%d'), CAST(${literal(last)} AS TIMESTAMP)),
               INTERVAL 1 DAY)) AS series(day)
      WHERE (CASE dayofweek(day) ${runs} END) = '1'
    `;
  }

  let added = "";
  let removed = "";
  if (has(catalogue, "calendar_dates", "service_id", "date", "exception_type")) {
    const both = (kind: string) => `
      SELECT service_id, CAST(try_strptime(date, '%Y%m%d') AS DATE) AS date
      FROM ${catalogue.file("calendar_dates")}
      WHERE exception_type = '${kind}' AND try_strptime(date, '%Y%m%d') IS NOT NULL
    `;
    added = both("1");
    removed = both("2");
  }

  if (!weekly && !added) throw new NoCalendarError("This feed's calendar has no usable rows.");
  if (weekly && removed) weekly = `SELECT * FROM (${weekly}) EXCEPT SELECT * FROM (${removed})`;
  if (weekly && added) return `SELECT * FROM (${weekly}) UNION SELECT * FROM (${added})`;
  return weekly || added;
}

/**
 * Per service: how many trips run, and which routes they belong to.
 *
 * The route list travels with the count because "how many routes run that day"
 * is the other half of what a calendar is asked, and joining dates to trips
 * directly would fan the trip count out by route.
 */
function tripsPerService(catalogue: Catalogue, routeId?: string): string {
  const empty = "SELECT NULL AS service_id, 0 AS trips, [] AS routes WHERE FALSE";
  if (!has(catalogue, "trips", "service_id")) return empty;
  if (routeId !== undefined && !has(catalogue, "trips", "route_id")) return empty;

  const routes = has(catalogue, "trips", "route_id") ? "list(DISTINCT route_id)" : "[]";
  const where = routeId === undefined ? "" : `WHERE route_id = ${literal(routeId)}`;
  return `SELECT service_id, COUNT(*) AS trips, ${routes} AS routes
          FROM ${catalogue.file("trips")} ${where} GROUP BY service_id`;
}

/**
 * Every date in the window with the services active and trips running.
 *
 * Dates with no service are included: a day nothing runs is the most useful
 * thing a calendar can show, and omitting it makes it indistinguishable from a
 * date outside the feed.
 */
export function dailyServiceSql(
  catalogue: Catalogue,
  first: string,
  last: string,
  limit: number,
  routeId?: string,
): string {
  return `
    WITH spine AS (
        SELECT CAST(day AS DATE) AS date
        FROM UNNEST(generate_series(
            CAST(${literal(first)} AS TIMESTAMP), CAST(${literal(last)} AS TIMESTAMP), INTERVAL 1 DAY)) AS series(day)
    ),
         dates AS (${expansionSql(catalogue, first, last)}),
         counts AS (${tripsPerService(catalogue, routeId)})
    SELECT strftime(s.date, '%Y-%m-%d') AS service_date,
           CAST(dayofweek(s.date) AS INTEGER) AS weekday,
           to_json(COALESCE(
               list_sort(list(DISTINCT d.service_id) FILTER (WHERE d.service_id IS NOT NULL)),
               [])) AS services,
           CAST(COALESCE(SUM(COALESCE(c.trips, 0)), 0) AS BIGINT) AS trips,
           CAST(length(list_distinct(COALESCE(flatten(list(c.routes)), []))) AS BIGINT) AS routes
    FROM spine s
    LEFT JOIN dates d ON d.date = s.date
    LEFT JOIN counts c ON c.service_id = d.service_id
    GROUP BY s.date
    ORDER BY s.date
    LIMIT ${limit}
  `;
}

/** A scalar count, for a table the dataset may not have. */
export function countSql(catalogue: Catalogue, table: string, where = ""): string | null {
  if (!catalogue.columns(table)) return null;
  return `SELECT COUNT(*) AS n FROM ${catalogue.file(table)} ${where}`;
}

export function agenciesSql(catalogue: Catalogue): string | null {
  if (!has(catalogue, "agency", "agency_name")) return null;
  const hasId = has(catalogue, "agency", "agency_id");

  let join = "";
  if (hasId && has(catalogue, "routes", "agency_id")) {
    join = `LEFT JOIN (SELECT agency_id, COUNT(*) AS n FROM ${catalogue.file("routes")} GROUP BY agency_id)
            r USING (agency_id)`;
  } else if (has(catalogue, "routes", "route_id")) {
    join = `LEFT JOIN (SELECT COUNT(*) AS n FROM ${catalogue.file("routes")}) r ON TRUE`;
  }

  return `
    SELECT ${hasId ? "agency_id" : "NULL"} AS agency_id,
           agency_name,
           ${has(catalogue, "agency", "agency_timezone") ? "agency_timezone" : "NULL"} AS tz,
           ${has(catalogue, "agency", "agency_url") ? "agency_url" : "NULL"} AS url,
           COALESCE(${join ? "r.n" : "0"}, 0) AS routes
    FROM ${catalogue.file("agency")} ${join}
    ORDER BY agency_name
  `;
}

export function modesSql(catalogue: Catalogue): string | null {
  if (!has(catalogue, "routes", "route_type")) return null;
  return `SELECT route_type, COUNT(*) AS n FROM ${catalogue.file("routes")}
          GROUP BY route_type ORDER BY 2 DESC`;
}

/** Every route with what it is, who runs it and how much of it there is. */
/** The services running on one date - the narrow question behind a day view. */
export function activeServicesSql(catalogue: Catalogue, first: string, last: string, on: string): string {
  return `SELECT DISTINCT service_id FROM (${expansionSql(catalogue, first, last)})
          WHERE date = CAST(${literal(on)} AS DATE)`;
}

export function routeListSql(catalogue: Catalogue, services?: string[]): string | null {
  if (!catalogue.columns("routes")) return null;

  // A day's routes: those with a trip on one of that day's services. Absent
  // rather than present with a zero, so a day view shows what runs.
  let running = "";
  if (services !== undefined) {
    if (!has(catalogue, "trips", "route_id", "service_id") || !services.length) return null;
    running = `WHERE r.route_id IN (SELECT DISTINCT route_id FROM ${catalogue.file("trips")}
                WHERE service_id IN (${services.map(literal).join(", ")}))`;
  }

  const trips = has(catalogue, "trips", "route_id")
    ? `LEFT JOIN (SELECT route_id, COUNT(*) AS n, COUNT(DISTINCT service_id) AS services
                  FROM ${catalogue.file("trips")} GROUP BY route_id) t USING (route_id)`
    : "";
  const agency =
    has(catalogue, "routes", "agency_id") && has(catalogue, "agency", "agency_id", "agency_name")
      ? `LEFT JOIN (SELECT agency_id, agency_name FROM ${catalogue.file("agency")}) a USING (agency_id)`
      : "";
  const stated = has(catalogue, "routes", "route_sort_order")
    ? "try_cast(r.route_sort_order AS BIGINT) NULLS LAST,"
    : "";

  // GTFS requires a short name *or* a long one, not both, so neither column can
  // be named unconditionally. Ordering by one the dataset does not have is a
  // binder error that takes the whole route list down.
  const byName = has(catalogue, "routes", "route_short_name")
    ? "try_cast(regexp_extract(COALESCE(r.route_short_name, ''), '^[0-9]+') AS BIGINT) NULLS LAST," +
      " COALESCE(r.route_short_name, ''),"
    : has(catalogue, "routes", "route_long_name")
      ? "COALESCE(r.route_long_name, ''),"
      : "";

  return `
    SELECT r.route_id,
           ${column(catalogue, "routes", "route_short_name", "short_name")},
           ${column(catalogue, "routes", "route_long_name", "long_name")},
           ${column(catalogue, "routes", "route_type", "route_type")},
           ${column(catalogue, "routes", "route_color", "color")},
           ${column(catalogue, "routes", "route_text_color", "text_color")},
           ${column(catalogue, "routes", "agency_id", "agency_id")},
           ${agency ? "a.agency_name" : "NULL"} AS agency_name,
           COALESCE(${trips ? "t.n" : "0"}, 0) AS trips,
           COALESCE(${trips ? "t.services" : "0"}, 0) AS services
    FROM ${catalogue.file("routes")} r ${trips} ${agency}
    ${running}
    ORDER BY ${stated} ${byName} r.route_id
  `;
}

export function routeRowSql(catalogue: Catalogue, routeId: string): string | null {
  const columns = catalogue.columns("routes");
  if (!columns?.length) return null;
  const selected = columns.map((name) => `"${name}"`).join(", ");
  return `SELECT ${selected} FROM ${catalogue.file("routes")} WHERE route_id = ${literal(routeId)}`;
}

export function directionsSql(catalogue: Catalogue, routeId: string): string | null {
  if (!has(catalogue, "trips", "route_id")) return null;

  // COALESCE around each: a FILTER excluding every row makes `list()` return
  // NULL, and a route whose trips all leave shape_id empty is ordinary.
  const headsigns = has(catalogue, "trips", "trip_headsign")
    ? `COALESCE(list_sort(list(DISTINCT trip_headsign)
        FILTER (WHERE trip_headsign IS NOT NULL AND trip_headsign != '')), [])`
    : "[]";
  const shapes = has(catalogue, "trips", "shape_id")
    ? `COALESCE(list_sort(list(DISTINCT shape_id)
        FILTER (WHERE shape_id IS NOT NULL AND shape_id != '')), [])`
    : "[]";
  const direction = has(catalogue, "trips", "direction_id") ? '"direction_id"' : "NULL";

  return `
    SELECT ${direction} AS direction_id, COUNT(*) AS trips,
           to_json(${headsigns}) AS headsigns, to_json(${shapes}) AS shapes
    FROM ${catalogue.file("trips")} WHERE route_id = ${literal(routeId)}
    GROUP BY 1 ORDER BY 1
  `;
}

/**
 * The distinct stop sequences a route's trips follow, and when its trips run.
 *
 * One query rather than the server's two. The server reads `stop_times` twice
 * because at thirty-eight milliseconds it did not matter; here each pass is a
 * filtered scan over range requests, so the patterns and the timetable are
 * computed from the same CTE.
 */
export function routeStopTimesSql(catalogue: Catalogue, routeId: string, maxPatterns: number): string | null {
  if (!has(catalogue, "stop_times", "trip_id", "stop_id", "stop_sequence")) return null;
  if (!has(catalogue, "trips", "route_id")) return null;

  const direction = has(catalogue, "trips", "direction_id") ? "t.direction_id" : "NULL";
  const headsign = has(catalogue, "trips", "trip_headsign") ? "t.trip_headsign" : "NULL";
  // Scheduled times only, deliberately - *not* the flex windows that
  // `routeTimetableSql` falls back to. "First departure 15:00, last arrival
  // 09:00" is what you get from running min and max over a booking window, and
  // a demand-responsive route genuinely has no first departure. The card says
  // so; the timetable shows the windows properly. `core/network.py` draws the
  // same line in `_timetable_shape`, and the conformance check is what caught
  // these two disagreeing.
  const hasDeparture = has(catalogue, "stop_times", "departure_time");
  const arrivalColumn = has(catalogue, "stop_times", "arrival_time") ? "arrival_time" : "departure_time";

  const guarded = (column: string) =>
    `CASE WHEN st.${column} IS NULL OR st.${column} = '' THEN NULL ELSE ${seconds(`st.${column}`)} END`;
  const departs = hasDeparture ? guarded("departure_time") : "NULL";
  const arrives = hasDeparture || has(catalogue, "stop_times", "arrival_time") ? guarded(arrivalColumn) : "NULL";

  return `
    WITH route_trips AS (
        SELECT trip_id, ${direction} AS direction_id, ${headsign} AS headsign
        FROM ${catalogue.file("trips")} t WHERE route_id = ${literal(routeId)}
    ),
    calls AS (
        SELECT st.trip_id,
               try_cast(st.stop_sequence AS BIGINT) AS seq,
               st.stop_id,
               ${departs} AS departs,
               ${arrives} AS arrives
        FROM ${catalogue.file("stop_times")} st
        WHERE st.trip_id IN (SELECT trip_id FROM route_trips)
    ),
    per_trip AS (
        SELECT trip_id,
               list(stop_id ORDER BY seq) AS stops,
               min_by(departs, seq) FILTER (WHERE departs IS NOT NULL) AS first_departure,
               max_by(arrives, seq) FILTER (WHERE arrives IS NOT NULL) AS last_arrival
        FROM calls GROUP BY trip_id
    ),
    patterns AS (
        -- min() rather than any_value(): the latter picks whichever row the engine
        -- reached first, so the same feed produced a different example trip on
        -- each run and in each implementation. A payload that changes without
        -- the data changing cannot be cached, diffed or checked.
        SELECT to_json(p.stops) AS stops,
               min(rt.direction_id) AS direction_id,
               min(rt.headsign) AS headsign,
               COUNT(*) AS trips,
               min(p.trip_id) AS example_trip
        FROM per_trip p JOIN route_trips rt USING (trip_id)
        GROUP BY p.stops
        ORDER BY trips DESC, len(p.stops) DESC
        LIMIT ${maxPatterns}
    )
    SELECT
      (SELECT to_json(list(patterns)) FROM patterns) AS patterns,
      (SELECT min(first_departure) FROM per_trip) AS first_departure,
      (SELECT max(last_arrival) FROM per_trip) AS last_arrival,
      (SELECT to_json(list(first_departure) FILTER (WHERE first_departure IS NOT NULL)) FROM per_trip)
        AS departures
  `;
}

/**
 * Names for the places a trip calls at, wherever the feed keeps them.
 *
 * `stop_times.stop_id` is three things at once in GTFS-Flex: a stop, a zone
 * from `locations.geojson`, or a group of zones from `location_groups.txt`.
 * Looking in only the first leaves a demand-responsive route listing raw ids,
 * which is what a real flex feed did - its `stops.txt` is empty.
 *
 * `min_by(name, rank)` is the first source that has a name, which is the order
 * `_stop_names` in `core/network.py` resolves them in.
 */
export function stopNamesSql(catalogue: Catalogue, stopIds: string[]): string | null {
  if (!stopIds.length) return null;
  const values = stopIds.map(literal).join(", ");

  const sources: [string, string, string][] = [
    ["stops", "stop_id", "stop_name"],
    ["location_groups", "location_group_id", "location_group_name"],
    ["locations", "id", "stop_name"],
  ];

  const parts = sources
    .filter(([table, key, label]) => has(catalogue, table, key, label))
    .map(
      ([table, key, label], rank) =>
        `SELECT "${key}" AS stop_id, "${label}" AS stop_name, ${rank} AS rank
         FROM ${catalogue.file(table)} WHERE "${key}" IN (${values})`,
    );
  if (!parts.length) return null;

  return `
    SELECT stop_id, min_by(stop_name, rank) AS stop_name
    FROM (${parts.join(" UNION ALL ")})
    WHERE stop_name IS NOT NULL
    GROUP BY stop_id
  `;
}

export function agencyNameSql(catalogue: Catalogue, agencyId: string | null): string | null {
  if (!has(catalogue, "agency", "agency_name")) return null;
  if (agencyId && has(catalogue, "agency", "agency_id")) {
    return `SELECT agency_name FROM ${catalogue.file("agency")} WHERE agency_id = ${literal(agencyId)}`;
  }
  // A single-agency feed may omit agency_id everywhere, and then the one
  // agency is the answer. Two rows means the question is unanswerable.
  return `SELECT agency_name FROM ${catalogue.file("agency")} LIMIT 2`;
}

/**
 * One route's calls on one day.
 *
 * Mirrors `route_timetable` in `core/network.py`, including the shape the
 * performance guard there pins: the trips are a CTE named `route_trips`,
 * narrowed by service and direction *inside* it, and `stop_times` is reached
 * only through `trip_id IN (SELECT trip_id FROM route_trips)` naming five
 * columns rather than all of them.
 */
export function routeTimetableSql(
  catalogue: Catalogue,
  routeId: string,
  services: string[],
  directionId?: string | null,
): string | null {
  if (!has(catalogue, "stop_times", "trip_id", "stop_id", "stop_sequence")) return null;
  if (!has(catalogue, "trips", "route_id", "service_id") || !services.length) return null;

  const conditions = [
    `route_id = ${literal(routeId)}`,
    `service_id IN (${services.map(literal).join(", ")})`,
  ];
  if (directionId !== undefined && directionId !== null && has(catalogue, "trips", "direction_id")) {
    conditions.push(`direction_id = ${literal(directionId)}`);
  }

  const { arrival, departure } = timeColumns(catalogue);

  return `
    WITH route_trips AS (
        SELECT trip_id,
               ${column(catalogue, "trips", "direction_id")},
               ${column(catalogue, "trips", "trip_headsign", "headsign")},
               ${column(catalogue, "trips", "service_id")},
               ${column(catalogue, "trips", "block_id")}
        FROM ${catalogue.file("trips")} WHERE ${conditions.join(" AND ")}
    ),
    calls AS (
        SELECT st.trip_id,
               st.stop_id,
               try_cast(st.stop_sequence AS BIGINT) AS seq,
               ${arrival} AS arrives,
               ${departure} AS departs
        FROM ${catalogue.file("stop_times")} st
        WHERE st.trip_id IN (SELECT trip_id FROM route_trips)
    )
    SELECT c.trip_id, rt.direction_id, rt.headsign, rt.service_id, rt.block_id,
           c.stop_id, c.seq, c.arrives, c.departs
    FROM calls c JOIN route_trips rt USING (trip_id)
    ORDER BY c.trip_id, c.seq
  `;
}
