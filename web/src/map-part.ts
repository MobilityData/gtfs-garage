/**
 * The map, as a separately imported part.
 *
 * This is the only module that reaches MapLibre. A host that imports it wants a
 * map and installs the peer dependency; a host that does not never mentions
 * either, so nothing about MapLibre appears in its build.
 */

import { MapController } from "./map/map";
import type { MapPart } from "./mount";

export const mapPart: MapPart = {
  create: (dom, state, source, basemap) => MapController.create(dom, state, source, basemap),
};

export type { MapPart, MapHandle } from "./mount";
