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
- [Worked example: the Mobility Feed API](#worked-example-the-mobility-feed-api)

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
| `parts` | `{load: false, report: false}` | Which extra pieces to build. The feed-picker dialog and the load report belong to the standalone application; an embedded viewer gets neither. |
| `history` | `memoryHistory()` | Where Back goes. The default is a stack the viewer keeps to itself, so **your address bar is left alone**. Pass `browserHistory()` to make a view a shareable link, which only makes sense if the viewer owns the page. |

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

What the document cannot tell you, which is where integrations actually trip up:

**CORS is yours.** A GTFS Garage server serves the viewer from its own origin
and adds no CORS middleware at all. If your API is on a different origin from
the page, it must send the usual headers itself, or sit behind a proxy that
makes it same-origin.

**There is no authentication hook.** `RestSource` never sets a request header —
no `Authorization`, no cookies, no custom `fetch`. If your API needs a bearer
token you cannot reach it by setting `baseUrl`; implement a source instead (see
below), which is a dozen lines and puts the whole request in your hands.

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
an HTTP contract — it is four methods and a stream:

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
- **`ParquetSource` cannot draw a map yet.** `geojson` and `geojsonStream` both
  reject, so mount it without the map part. Building the layers means porting
  the vertex budget and the thinning that the server does.

## Worked example: the Mobility Feed API

One host's API, not part of the contract — shown because it is the first real
one and the shape is a reasonable model. The
[Mobility Feed API](https://mobilitydatabase.org) exposes:

```
GET  /v1/operations/gtfs_datasets/{id}/parquet   -> ParquetDatasetState
POST /v1/operations/gtfs_datasets/{id}/parquet   -> starts a conversion
```

`ParquetDatasetState` carries `status` (`absent`, `preparing`, `ready`,
`failed`), `base_url` when ready, `phase`/`done`/`total`/`detail` while
preparing, and `message` when failed. It does not repeat the table list:
`manifest.json` is where that lives, along with the sizes, and the reader
fetches it itself. Those progress fields are named after `LoadProgress`
deliberately, so most of the adapter is a rename:

```ts
import { ParquetSource } from "gtfs-garage-web/parquet";
import type { DatasetProvider, DatasetState } from "gtfs-garage-web/dataset";

const provider = (datasetId: string): DatasetProvider => ({
  async status(signal): Promise<DatasetState> {
    const response = await fetch(`${API}/v1/operations/gtfs_datasets/${datasetId}/parquet`, { signal });
    const state = await response.json();

    switch (state.status) {
      case "absent":
        return { state: "absent" };
      case "failed":
        return { state: "failed", message: state.message };
      case "ready":
        return {
          state: "ready",
          // No `tables`: the reader reads `{base_url}/manifest.json` for
          // them, which is also where the sizes are. Passing a list here
          // would skip the manifest and lose them.
          source: new ParquetSource({
            baseUrl: state.base_url,
            name: state.dataset_stable_id,
          }),
        };
      default:
        return {
          state: "preparing",
          // `running` is the one field the API does not carry: it answers only
          // about a dataset that is being prepared, so reaching here is itself
          // the answer.
          progress: { ...state, running: true },
        };
    }
  },

  async prepare(signal) {
    await fetch(`${API}/v1/operations/gtfs_datasets/${datasetId}/parquet`, { method: "POST", signal });
  },
});
```

Three details that generalise:

- **`absent` is a `200`, not a `404`.** A `404` means the dataset does not
  exist, which is a different thing, and the interface has to tell them apart.
  Any API driving `mountDataset` needs the same distinction.
- **The `GET` never starts work; the `POST` does.** That is what makes polling
  twice a second safe, and it is why `prepare` is a separate call rather than a
  side effect of asking.
- **A manifest is the table list, not an extra.** Its builder writes a version 2
  manifest beside the files, which is why the adapter above passes no `tables`
  and the load report still shows sizes. A host still on version 1 gets the
  table list and nothing else: version 1 meant the *Parquet* size by `bytes`
  where version 2 means the source file's, so the reader branches on `version`
  and leaves version 1's sizes out rather than showing them under headings that
  would misdescribe them.
