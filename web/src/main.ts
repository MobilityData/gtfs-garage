/**
 * The standalone application.
 *
 * Everything the viewer does lives in `mount`; this is only the part that is
 * true of the application and not of an embedded viewer. It owns the page, so
 * it takes the load dialog and the load report, and its back stack is the
 * browser's own history - which is what makes a view a shareable link.
 */

import "maplibre-gl/dist/maplibre-gl.css";

import "./app.css";

import { mapPart } from "./map-part";
import { mount } from "./mount";
import { browserHistory } from "./ui/history";

const root = document.getElementById("gtfs-garage");
if (!root) throw new Error("Missing #gtfs-garage to mount into");

void mount(root, {
  // The application always shows a map, so it takes the part unconditionally.
  // An embedded viewer imports it only if its host wants one.
  map: mapPart,
  parts: { load: true, report: true },
  history: browserHistory(),
});
