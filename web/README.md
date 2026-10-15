# gtfs-garage-web

Browse a GTFS feed: an overview of what is in it, a calendar of the days it
runs, a page per route - and under all of that, a table with filters and
foreign-key navigation, and a map of its stops, shapes and zones. The viewer of
[GTFS Garage](https://github.com/MobilityData/gtfs-garage), packaged so it can
be mounted in another application.

## Install

```sh
npm install gtfs-garage-web
npm install maplibre-gl            # only with the map
```

ESM only — a bundler or native ES modules, no `<script>` drop-in. MapLibre is an
**optional** peer behind its own entry point, so a viewer without a map neither
downloads it nor needs it installed to build.

## React

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

**Give the container a height.** The viewer fills whatever box it is given, and
a box with no height renders an invisible map.

## Without React

```ts
import { mount } from "gtfs-garage-web";
import "gtfs-garage-web/style.css";

const viewer = await mount(document.querySelector("#feed")!, {
  baseUrl: "https://example.org",
  // map: mapPart,   from "gtfs-garage-web/map"
});

viewer.destroy(); // releases the map, the history subscription and the markup
```

## A dataset that is still being prepared

`GtfsGarageDataset` waits for one, and draws the being-prepared, not-prepared
and failed states itself — so no host writes a progress bar:

```tsx
import { GtfsGarageDataset } from "gtfs-garage-web/react";

<GtfsGarageDataset dataset={provider} description="mdb-1210" style={{ height: "80vh" }} />
```

## Where the data comes from

By default the viewer talks to a GTFS Garage server at `baseUrl`. To drive it
from your own backend, either serve the same API — specified in
[`docs/GtfsGarageAPI.yaml`](https://github.com/MobilityData/gtfs-garage/blob/main/docs/GtfsGarageAPI.yaml)
— or pass a `source` implementing `ViewerSource`, which is the escape hatch for
a backend of any other shape, for authentication, or for reading Parquet in the
browser with no server at all.

The derived views - the overview, the calendar and the route pages - are four
optional methods on that interface. `ParquetSource` implements all four against
Parquet in the browser, so a dataset on a static host gets them with no server
anywhere; a source that omits them shows the file browser alone, with no
Explore entries in the sidebar and nothing else changed.

## Changing what it shows

The derived views are **screens**, and the screens are a list:

```ts
import { mount, defaultScreens } from "gtfs-garage-web";

mount(root, { screens: [...defaultScreens, myScreen] });   // add one
mount(root, { screens: [] });                              // the file browser alone
```

A screen is an id, an optional sidebar label, an `available` predicate, a
`fetch` and a `render`. See
[`docs/INTEGRATION.md`](https://github.com/MobilityData/gtfs-garage/blob/main/docs/INTEGRATION.md)
for the whole interface and the helpers a screen can build on.

## Styling

Every rule is scoped under `.gtfs-viewer`, so the stylesheet cannot reach your
page. The design tokens are declared on that class and are the theming API:

```css
.gtfs-viewer {
  --accent: #2563eb;
  --font: "Inter", sans-serif;
}
```

## Documentation

**[Embedding the viewer](https://github.com/MobilityData/gtfs-garage/blob/main/docs/INTEGRATION.md)**
— every option, the three ways to supply data, what your server has to provide
(including CORS and authentication, which the API document deliberately leaves
to you), the dataset-preparation lifecycle, and a worked adapter for driving the
viewer from an API of your own.

## Licence

Apache-2.0
