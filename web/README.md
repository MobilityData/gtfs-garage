# @mobilitydata/gtfs-garage-web

Browse a GTFS feed: a table with filters and foreign-key navigation, and a map
of its stops, shapes and zones. The viewer of
[GTFS Garage](https://github.com/MobilityData/gtfs-garage), packaged so it can
be mounted in another application.

## Install

```sh
npm install @mobilitydata/gtfs-garage-web
```

The map is a separate entry point, and MapLibre an **optional** peer. Install
it only if you want one:

```sh
npm install maplibre-gl            # only with the map
```

Nothing in the main entry mentions MapLibre, so a viewer without a map neither
downloads it nor needs it installed to build. That is why the map arrives as an
import rather than a flag: a bundler resolves `import()` specifiers whether or
not the branch runs, so a flag would still have made MapLibre mandatory.

## React

```tsx
"use client";

import { GtfsGarage } from "@mobilitydata/gtfs-garage-web/react";
import { mapPart } from "@mobilitydata/gtfs-garage-web/map";
import "@mobilitydata/gtfs-garage-web/style.css";
import "maplibre-gl/dist/maplibre-gl.css";

export default function Feed() {
  return <GtfsGarage map={mapPart} baseUrl="https://example.org" style={{ height: "80vh" }} />;
}```

Drop the two `map` imports and the MapLibre stylesheet for a table-only viewer:

```tsx
<GtfsGarage baseUrl="https://example.org" style={{ height: "80vh" }} />
```

`"use client"` is required: the viewer builds DOM and cannot render on a server.

**Give the container a height.** The viewer fills whatever box it is given, and
a box with no height renders an invisible map.

## Without React

```ts
import { mount } from "@mobilitydata/gtfs-garage-web";
import "@mobilitydata/gtfs-garage-web/style.css";

const viewer = await mount(document.querySelector("#feed")!, {
  baseUrl: "https://example.org",
  // map: mapPart,   from "@mobilitydata/gtfs-garage-web/map"
});

viewer.destroy(); // releases the map, the history subscription and the markup
```

## Where the data comes from

By default the viewer talks to a GTFS Garage server at `baseUrl`. To drive it
from your own backend instead, pass a `source` implementing `ViewerSource` —
`GtfsSource` for the table, plus `geojsonStream` for the map, which draws a
large feed's shapes as they arrive rather than all at the end.

## Styling

Every rule is scoped under `.gtfs-viewer`, so the stylesheet cannot reach your
page. The design tokens are declared on that class and are the theming API:

```css
.gtfs-viewer {
  --accent: #2563eb;
  --font: "Inter", sans-serif;
}
```

## Licence

Apache-2.0
