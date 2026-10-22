# Embedding the viewer

`gtfs-garage-web` is the GTFS Garage interface — the table, the filters, the
foreign-key navigation and the map — packaged so it can be mounted in another
application. This page is how to do that, and what your side has to provide.

The HTTP contract itself is [`GtfsGarageAPI.yaml`](GtfsGarageAPI.yaml), which is
the source of truth: the server's models and the viewer's types are both
generated from it. Nothing below restates it.

- [Install](#install)
- [Mount it](#mount-it)
- [Options](#options)
- [Styling](#styling)
- [Where the data comes from](#where-the-data-comes-from) — the three ways
- [Serving the API yourself](#serving-the-api-yourself)
- [Implementing a source instead](#implementing-a-source-instead)
- [Datasets that have to be prepared first](#datasets-that-have-to-be-prepared-first)
- [A worked adapter](#a-worked-adapter)

## Install

```sh
npm install gtfs-garage-web
npm install maplibre-gl            # only if you want the map
```

**The package is ESM only.** There is no UMD or IIFE build, no `<script>`
drop-in and no custom element, so a host needs a bundler or native ES modules.

MapLibre is an *optional* peer and lives behind its own entry point. Nothing in
the main entry mentions it, so a viewer without a map neither downloads it nor
needs it installed to build. That is why the map arrives as an import rather
than a flag: a bundler resolves `import()` specifiers whether or not the branch
runs, so a flag would still have made MapLibre mandatory.

| Entry point | What it is |
|---|---|
| `gtfs-garage-web` | `mount`, `RestSource`, the history ports, the types |
| `gtfs-garage-web/react` | `GtfsGarage`, `GtfsGarageDataset` |
| `gtfs-garage-web/map` | `mapPart` — pass it as `map` to get a map pane |
| `gtfs-garage-web/dataset` | `mountDataset`, `DatasetProvider` |
| `gtfs-garage-web/parquet` | `ParquetSource`, for Parquet over HTTP range requests |
| `gtfs-garage-web/style.css` | the stylesheet, required |

## Mount it

```tsx
"use client";

import { GtfsGarage } from "gtfs-garage-web/react";
import { mapPart } from "gtfs-garage-web/map";
import "gtfs-garage-web/style.css";
import "maplibre-gl/dist/maplibre-gl.css";

export default function Feed() {
  return <GtfsGarage map={mapPart} baseUrl="https://example.org" style={{ height: "80vh" }} />;
}
```

Drop the two `map` imports and the MapLibre stylesheet for a table-only viewer.
`"use client"` is required: the viewer builds DOM and cannot render on a server.

Without React:

```ts
import { mount } from "gtfs-garage-web";
import "gtfs-garage-web/style.css";

const viewer = await mount(document.querySelector("#feed")!, {
  baseUrl: "https://example.org",
  // map: mapPart,   from "gtfs-garage-web/map"
});

viewer.destroy();
```

Two things that are not optional:

**Give the container a height.** The viewer fills whatever box it is given, and
a box with no height renders an invisible map.

**Call `destroy`.** It releases the map, the history subscription and the
markup. React remounts every effect once on mount in development, so a viewer
that cannot be taken down appears twice and holds two WebGL contexts, of which a
browser allows only a handful. The React components do this for you.

## Options

Both `mount` and `<GtfsGarage>` take the same options.

| Option | Default | What it does |
|---|---|---|
| `baseUrl` | the current origin | Where the built-in REST source sends its requests. |
| `source` | a REST source on `baseUrl` | Your own `ViewerSource`. Takes precedence over `baseUrl`. |
| `map` | none | `mapPart` from `gtfs-garage-web/map`. Omitted means no map pane — there is nothing to draw one with. |
| `basemap` | the server's setting | A preset (`openfreemap`, `esri`, `osm`, `carto`, `none`), a raster tile template, or a vector style URL. |
| `parts` | `{load: false, options: false}` | Which extra pieces to build. The feed-picker dialog and the options menu belong to the standalone application; an embedded viewer gets neither. |
| `history` | `memoryHistory()` | Where Back goes. The default is a stack the viewer keeps to itself, so **your address bar is left alone**. Pass `browserHistory()` to make a view a shareable link, which only makes sense if the viewer owns the page. |
| `report` | none | A gtfs-validator report for the dataset, as parsed JSON or text. The Quality screen opens with it instead of asking the reader for the file. See [QUALITY.md](QUALITY.md). |
| `qualityActions` | none | Handlers for `custom` actions in Quality guides, by name. The only way a guide runs code, and only code you supplied. |

`parts.options` builds the header's **Options** menu. It always holds the load
report. It additionally holds the server's workdir — what is on disk, and the
buttons that reopen or delete a feed — but only when two things are both true:
the source implements all four of `workspace`, `reloadFeed`, `removeFeed` and
`clearWorkspace`, **and** `GET /api/config` answers `workspace: true`.

Both, because either alone is the wrong test. `RestSource` always carries the
four methods, since it is written against the whole contract — so pointing
`baseUrl` at your own backend would otherwise build a section and discover it
empty with a 404 on every open. The server declares it instead, and a backend
that does not serve those paths simply does not set the flag. A source with no
`config` method at all is taken at its word: a host that wrote the four methods
by hand meant them.

The same gate governs the load dialog: with `parts.load`, a source that passes
it has the workdir's feeds listed at the top of the dialog as one-click
reopens, and a source that does not simply shows the dropzone, the pickers and
the path field as before.

One further method, `setStartupFeed`, is optional on its own: it adds the
**At startup** button to each feed's row, which names the feed a later server
on that workdir opens by itself. A source without it keeps the rest of the
section. The button is drawn only for a workdir that reports `persistent`,
which every GTFS Garage server's is — the flag exists for a backend whose
directory does not outlive the request that made it, where the choice would be
stored into something about to be deleted.

A workdir describes a local process's own disk, so there is normally nothing for
a hosted backend to put there.

Two side effects worth knowing about. The root element gets the class
`gtfs-viewer` and its contents are replaced; elements are tagged `data-el=…`
rather than `id`, so two viewers can coexist on a page. And whether the map pane
is showing is remembered in `localStorage` under `gtfs-garage.map-visible`.

## Styling

Every rule is scoped under `.gtfs-viewer`, so the stylesheet cannot reach your
page. The design tokens are declared on that class and are the theming API:

```css
/* The defaults. Override any of them on the same class. */
.gtfs-viewer {
  --bg: #f7f7f8;
  --panel: #ffffff;
  --border: #dcdde0;
  --text: #1c1e21;
  --muted: #6b7280;
  --accent: #2563eb;
  --accent-bg: #eef2ff;
  --chip-bg: #eef1f5;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

## Where the data comes from

Three ways, in increasing order of how much you have to build:

| | Build | Use it when |
|---|---|---|
| **A GTFS Garage server** | nothing — set `baseUrl` | You can run the Python server next to your app. |
| **Your own API** | [the endpoints](GtfsGarageAPI.yaml) | You already have a backend holding the feeds, and it can serve HTTP the viewer reaches directly. |
| **Your own source** | a TypeScript object | Your backend has a different shape, needs authentication, or there is no backend at all. |

## Serving the API yourself

Implement [`GtfsGarageAPI.yaml`](GtfsGarageAPI.yaml) and point `baseUrl` at it.
The document is OpenAPI 3.0, so you can generate your server's models from it
the way this repository generates its own — `scripts/api-gen.sh` is a worked
example of that.

Only `POST /api/load` is optional: it exists so the standalone application can
open a feed you choose, and an embedded viewer is built without the dialog that
calls it.

The four `explore` paths - `/api/overview`, `/api/calendar`, `/api/routes` and
`/api/routes/{route_id}` - are optional as a group. They compute rather than
report: nothing they return exists in the feed as a column. Omit them and the
viewer shows the file browser alone, which is the whole of what it did before
they existed. Implement them and three things are worth getting right:

**Keep them off `stop_times.txt`.** It is the file that makes a feed large, and
a summary that reads it stops answering on a real one. The first three are
answerable without it; a date's trip count is the per-service trip counts summed
over the services active that day. Only `/api/routes/{route_id}` needs it, and
only for one route's own trips.

**Expand the calendar in the right order.** A removal in `calendar_dates.txt`
applies to the weekly pattern, and additions are unioned in afterwards - GTFS
lets a feed remove a date from one service and add it to another, and doing it
the other way round silently drops the addition.

**Keep the ids.** Every figure the viewer draws is rendered as a link into the
rows behind it, which it can only do because the payloads carry the
`service_id`s, `route_id`s, `stop_id`s and `trip_id`s each figure came from. A
response that drops them still renders - and turns a summary a reader can check
into one they have to believe.

What the document cannot tell you, which is where integrations actually trip up:

**CORS is yours.** A GTFS Garage server serves the viewer from its own origin
and adds no CORS middleware at all. If your API is on a different origin from
the page, it must send the usual headers itself, or sit behind a proxy that
makes it same-origin.

**There is no authentication hook.** `RestSource` calls `fetch` with no headers
and no `credentials` option, which decides what does and does not work. A
same-origin session cookie is sent, because that is `fetch`'s default — an API
behind an ordinary session on your own origin needs nothing from you. Anything
else does not: no `Authorization` header, and no cookie on a cross-origin
request, which needs `credentials: "include"` on the call and
`Access-Control-Allow-Credentials` on the response. For a bearer token or a
credentialed cross-origin API, implement a source instead (see below), which is
a dozen lines and puts the whole request in your hands.

**Get the filter semantics right.** They are stated in the spec under
`FilterOperator`, and a reimplementation that differs will look right and behave
wrongly. The one that bites: an empty CSV field is loaded as NULL, so a filter
of `column = ''` matches nothing, and `eq` with an empty value therefore has to
be rewritten to "is NULL or is the empty string". Skipping that makes the
"(empty)" entry in a picklist report a count and then return no rows.

**Stream the map layers.** `GET /api/geojson/{layer}` without ids answers
`application/x-ndjson`: a header line, then batches. A large feed is about
411 MB of GeoJSON, which as three whole-document requests parsed on the main
thread crashed the tab outright. Sending it as it is read means the map paints
progressively and the browser never holds it all at once. With gzip the whole
geometry is about 45 MB on the wire.

## Implementing a source instead

`ViewerSource` is the interface the whole UI is written against, and it is not
an HTTP contract — it is four methods, a stream, and some optional extras:

```ts
import type { ViewerSource } from "gtfs-garage-web";

const source: ViewerSource = {
  tables,          // what the feed contains: tables, columns, missing files
  query,           // one page of a table, filtered
  distinct,        // a column's values with counts, for the picklist
  geojson,         // one layer, or named features from it
  geojsonStream,   // a whole layer, batch by batch
  config,          // optional: the basemap, if you do not pass one
  close,           // optional: release whatever the source holds

  // Optional: the derived views - the feed read as a network rather than as
  // files. Each screen asks for the one it needs, so a source implementing
  // some and not others simply offers fewer entries. `ParquetSource`
  // implements all four against Parquet in the browser.
  overview,        // who runs this feed, what they run, when it expires
  calendar,        // dates, service patterns, and a profile per weekday
  routes,          // every route, with its mode, operator and size - and
                   // optionally only those running on one `service_date`
  route,           // one route: directions, stop patterns, times, days - and
                   // optionally what it does on one `serviceDate`
  timetable,       // optional on its own: one route's day as stops by trips
  drawsGeometry,   // optional: false if `geojson` cannot answer, so no map
                   // (both sources that ship answer it, so both draw maps)
                   // action is offered rather than one that rejects

  // Optional, and all four together: the workdir the source writes into. Only
  // a local server has one, and the options menu simply omits that section for
  // a source that does not implement them.
  workspace,       // the directory, its size, and the feeds it holds
  reloadFeed,      // serve a stored feed again, without fetching it
  removeFeed,      // delete one feed's files
  clearWorkspace,  // delete every feed's files but the one being served

  // Optional on its own, and only alongside those four: which feed a later
  // server on this workdir opens by itself. Without it the workdir section is
  // unchanged but for the button that sets this.
  setStartupFeed,  // name that feed, or clear the choice with null
};

await mount(root, { source });
```

The payload types are exported from the package and generated from the same
spec, so your implementation is checked against the contract at compile time.

This is the path for anything unusual: authentication, a GraphQL backend, data
already in the browser, or a feed read from Parquet with no server at all —
which is what `ParquetSource` does, and it is an ordinary implementation of this
interface with no privileges the package does not give you.

What reimplementing buys you over reusing `gtfs_garage.core` from Python is
worth weighing: the parts that are easy to get subtly wrong are the
null-versus-empty filter semantics, resolving links only against files a feed
actually contains, and the cursor-per-request rule a shared DuckDB connection
otherwise breaks.

## Changing the derived views

The overview, the calendar and the route pages are **screens**, and the screens
are a list rather than a fixed set. Pass your own:

```ts
import { mount, defaultScreens, type Screen } from "gtfs-garage-web";

const fares: Screen<MyFares> = {
  id: "fares",                       // what `?view=` carries
  label: "Fares",                    // omit for a detail screen with no sidebar entry
  title: "What it costs to ride",
  available: (source) => true,       // asked once per feed
  fetch: (source, argument) => myApi.fares(argument),
  render: (data, context) => myPane(data, context),
};

mount(root, { screens: [...defaultScreens, fares] });            // add one
mount(root, { screens: defaultScreens.map(swapTheCalendar) });   // replace one
mount(root, { screens: [] });                                    // the file browser alone
```

A screen also says **where the map goes** while it is showing - `layout:
"beside"` (the default), `"above"` for a view that needs the full width, or
`"none"` for one with nothing to draw.

`render` is handed a `ScreenContext` with what a screen needs to be part of the
viewer rather than a panel inside it:

| | |
|---|---|
| `openTable(table, filters?)` | open a GTFS file in the raw browser, filtered to the rows behind a figure |
| `openScreen(id, argument?)` | open another screen - the route list opens the route card this way |
| `source` | the source itself, for a screen that fetches again on a click |
| `date` / `setDate(date)` | the service date every derived view reads, and how to change it. **Null by default** - nothing is filtered until a reader picks a day, so a screen that filters by it must behave when it is absent |
| `params` / `setParams(params)` | the screen's own URL parameters - the facets a list is narrowed by. Names are the screen's, except `view`, `arg`, `date`, `table`, `page` and `filters`, which the viewer owns; an empty value removes one. Setting them is a navigation, so Back undoes it, and opening another screen drops them |
| `focusRoutes(ids \| null, {shapeIds?, stopIds?, isolate?, frame?})` | draw those routes, or null for the whole network. Resolves to `{lines, points}` — what was actually drawn. `frame: "stops"` frames the viewport on the focused stops rather than the route's line, for a focus that is part of a route rather than all of it. Absent when there is no map, or the source cannot build GeoJSON |
| `focusStop(stopId)` | centre the map on one stop and mark it. Resolves `false` when the feed gives that stop no position. Absent on the same terms as `focusRoutes` |

The pane resets `focusRoutes` to the whole network before every render, so a
screen that wants one route in focus asks for it while rendering and a screen
that does not need say nothing.

Two things worth knowing if you draw on the map:

**The `routes` layer holds one representative shape per route** - the shape
most of the route's trips use, so a short working's shape does not stand in for
the whole line. That is right for a day's worth of routes and wrong for a single
one, whose directions and variants are several shapes. Pass `shapeIds` and those shapes are fetched and
drawn as well, so the whole route appears rather than half of it.

**Showing the surroundings is not deselecting.** `isolate: false` keeps the
rest of the network drawn behind the focus; the focused routes stay picked out
either way. Passing `null` to mean "show everything" would lose the one line
the reader is looking at.

**Pass the stops too.** Isolating hides every stop in the feed, which is right
for a day's worth of routes — every stop in the city is noise — and wrong for
one route, whose stops are the point of looking at it. `stopIds` narrows the
stops layer to that route's and emphasises them, by the same id-filter the
routes use, so there is no fetch and no limit on how many a route may have.

**Check what came back.** `focusRoutes` resolves to `{lines, points}`, and the
three cases read differently: a route with shapes, a route with none but with
stops (ordinary in a feed without `shapes.txt` — the stops are shown and framed
instead), and a route with neither. The built-in route card says which; a screen
that asserts it is showing something without checking leaves a blank map behind
a confident sentence.

The viewer's own helpers are exported for a screen to build on rather than
reimplement: `node`, `action`, `section`, `stat` and `append` from the same
module. They write through `textContent`, so feed-supplied text cannot inject
markup.

Two rules worth keeping if you write one:

**Link back to the rows.** Every figure the built-in screens draw is a link
into the file it was computed from. A derived number a reader cannot check is a
number they have to believe.

**Let `available` do the refusing.** A screen whose source cannot answer it
should report false rather than render an error, so the sidebar never offers an
entry that leads nowhere.

## Datasets that have to be prepared first

A dataset behind an API may not exist yet — it gets converted once, and that
takes seconds after a download. `mountDataset` waits for it, and **draws the
being-prepared, not-prepared and failed states itself**, so no host writes a
progress bar or an error box again:

```ts
import { mountDataset } from "gtfs-garage-web/dataset";

await mountDataset(root, {
  description: "mdb-1210",
  dataset: {
    async status(signal) { /* one of the four states below */ },
    async prepare(signal) { /* optional: start the conversion */ },
  },
});
```

You supply facts, never markup:

| `status` returns | The viewer does |
|---|---|
| `{state: "absent"}` | Calls `prepare` **once**, and says "Preparing …". Without `prepare`, says it has not been prepared and stops. |
| `{state: "preparing", progress}` | Phrases `progress` in its own load wording and keeps polling. |
| `{state: "ready", source}` | Mounts the viewer on your source and stops polling. |
| `{state: "failed", message}` | Shows your message, verbatim, as an error. |

`status` is polled every 500 ms (`pollMs`) while a dataset is being prepared,
and is passed an `AbortSignal` that fires if the viewer goes away mid-request.
`prepare` is called at most once, on the first `absent` — calling it per poll
would queue a conversion a second. A failed poll leaves the previous line up
rather than reporting a failure: one dropped request does not mean the dataset
has gone away.

`progress` is the same `LoadProgress` the spec declares, which is why the
wording is already written: `phase` is one of `start`, `download`, `upload`,
`extract`, `convert`, `summarise`, `done`; `done` and `total` are **bytes**
during `download` and counts otherwise, with `total` at `0` when it is not
knowable in advance.

### Serving the Parquet

`ParquetSource` reads a dataset with DuckDB-WASM over HTTP range requests, so
the page opens without downloading, unzipping or converting anything. Produce a
dataset with `gtfs-garage FEED --export DIR`, publish the directory, and point a
source at it:

```ts
import { ParquetSource } from "gtfs-garage-web/parquet";

const source = new ParquetSource({
  baseUrl: "https://files.example.org/mdb-1210/parquet",
  name: "mdb-1210",
  tables: ["agency", "routes", "stops", "trips", "stop_times"],
});
```

What the host serving those files must provide:

- **`{baseUrl}/{table}.parquet`**, one file per GTFS table, and
  `{baseUrl}/manifest.json` describing the set (the `DatasetManifest` schema in
  the spec).
- **Byte ranges** — `Accept-Ranges: bytes` and `206 Partial Content`. This is
  the whole point: only the parts of a file a query touches are ever fetched.
- **CORS, if the dataset is not same-origin.** DuckDB fetches from a *worker*,
  so you need `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers:
  Range`, and `Access-Control-Expose-Headers: Content-Length, Content-Range,
  Accept-Ranges`. Add `Timing-Allow-Origin` too, or the viewer's "kB fetched"
  figure reads zero and is suppressed rather than shown as a lie.
- **No query string on `baseUrl`.** The reader rebuilds each file's URL from the
  origin and path only, so a signed URL does not survive the round trip. The
  files have to be public.

Two things to know before you rely on it:

- **Publish the manifest, and then pass nothing.** `tables` and `manifest.json`
  answer the same question, and `tables` wins: pass it and the manifest is never
  fetched, so the sizes it carries go missing from the load report. It is there
  for a dataset that has no manifest — written by something else, or served from
  somewhere that will not answer for it. With neither, the reader has no choice
  but to probe every table GTFS defines, 123 range requests for a seven-table
  feed before its first row appears.
- **Pass `mapPart` if you want the map.** `ParquetSource` builds the map's four
  layers from the same Parquet it reads tables from, so a bucket with no server
  behind it still draws stops, routes, shapes and flex zones. It is the same
  geometry the server produces — same vertex budget, same thinning, same
  properties — and `scripts/integrations.sh conformance` diffs the two layer by
  layer over the same feed. The layers are built by DuckDB in its worker and the
  thinning happens in SQL, so a national feed is an aggregation rather than ten
  million rows crossing into JavaScript.

## A worked adapter

Most of a `DatasetProvider` is a rename. Suppose your API answers with a status
document of its own:

```
GET  /datasets/{id}/parquet   -> where it stands
POST /datasets/{id}/parquet   -> starts a conversion
```

carrying a `status` of `absent`, `preparing`, `ready` or `failed`, a `base_url`
once ready, `phase`/`done`/`total`/`detail` while preparing, and a `message` when
it failed. Name those progress fields after `LoadProgress` and the mapping is
almost mechanical:

```ts
import { ParquetSource } from "gtfs-garage-web/parquet";
import type { DatasetProvider, DatasetState } from "gtfs-garage-web/dataset";

const provider = (datasetId: string): DatasetProvider => ({
  async status(signal): Promise<DatasetState> {
    const response = await fetch(`${API}/datasets/${datasetId}/parquet`, { signal });
    const state = await response.json();

    switch (state.status) {
      case "absent":
        return { state: "absent" };
      case "failed":
        return { state: "failed", message: state.message };
      case "ready":
        return {
          state: "ready",
          // No `tables`: the reader reads `{base_url}/manifest.json` for them,
          // which is also where the sizes are. Passing a list here would skip
          // the manifest and lose them.
          source: new ParquetSource({ baseUrl: state.base_url, name: datasetId }),
        };
      default:
        return {
          state: "preparing",
          // `running` is the one field such an API has no reason to carry: it
          // answers only about a dataset being prepared, so reaching here is
          // itself the answer.
          progress: { ...state, running: true },
        };
    }
  },

  async prepare(signal) {
    await fetch(`${API}/datasets/${datasetId}/parquet`, { method: "POST", signal });
  },
});
```

Three things to get right on your side, none of them obvious:

- **`absent` is a `200`, not a `404`.** A `404` means the dataset does not
  exist, which is a different thing, and the interface has to tell them apart.
  Any API driving `mountDataset` needs that distinction.
- **The `GET` must never start work; the `POST` does.** That is what makes
  polling twice a second safe, and it is why `prepare` is a separate call rather
  than a side effect of asking.
- **A manifest is the table list, not an extra.** Write a version 2 manifest
  beside the files and the adapter needs no `tables` and the load report still
  shows sizes. Version 1 carries the table list and nothing else: it meant the
  *Parquet* size by `bytes` where version 2 means the source file's, so the
  reader branches on `version` and leaves version 1's sizes out rather than
  showing them under headings that would misdescribe them.
