"use strict";

const state = {
  tables: [],
  currentTable: null,
  currentColumns: [],
  columnInfoByName: {},
  filters: [],
  page: 1,
  pageSize: 100,
  routesGeojson: null,
  mapDataLoaded: false,
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map setup
//
// Layer styling deliberately mirrors mobilitydatabase-web's GtfsVisualizationMap
// (Carto raster basemap, route color from route_color, width by route_type,
// white casing beneath the colored line) so this tool reads as the same map.
// It differs in one way: sources here are plain GeoJSON served by the local API
// rather than PMTiles, since building tiles would need Tippecanoe on every load.

const EMPTY_FC = { type: "FeatureCollection", features: [] };

const geojsonSource = () => ({ type: "geojson", data: EMPTY_FC });

const map = new maplibregl.Map({
  container: "map",
  center: [0, 20],
  zoom: 1,
  attributionControl: { compact: true },
  // Sources and layers are declared up front rather than added in a map.on("load")
  // handler: "load" only fires after the first paint, so in a background tab
  // (where requestAnimationFrame never runs) the layers would never exist and the
  // feed's data would silently never reach the map.
  style: {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
      routes: geojsonSource(),
      shapes: geojsonSource(),
      stops: geojsonSource(),
      highlight: geojsonSource(),
    },
    layers: [
      { id: "basemap", type: "raster", source: "basemap", minzoom: 0, maxzoom: 22 },
      // Shapes no route claims (feeds whose trips.txt has no shape_id) still need
      // to be drawn, otherwise those feeds render an empty map.
      {
        id: "shapes",
        type: "line",
        source: "shapes",
        paint: { "line-color": "#9ca3af", "line-width": 1.5, "line-opacity": 0.6 },
      },
      {
        id: "routes-white",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["match", ["get", "route_type"], "3", 5, "1", 10, 7],
          "line-opacity": 0.8,
        },
      },
      {
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["concat", "#", ["get", "route_color"]],
          "line-width": ["match", ["get", "route_type"], "3", 1, "1", 4, 3],
          "line-opacity": ["match", ["get", "route_type"], "1", 0.8, "3", 0.6, 0.7],
        },
      },
      {
        id: "stops",
        type: "circle",
        source: "stops",
        paint: {
          // Scaled by zoom rather than hidden below z12 as the web app does - in
          // an inspection tool you need to see stops before zooming in.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 12, 3, 16, 5],
          "circle-color": "#1c1e21",
          "circle-opacity": 0.45,
        },
      },
      {
        id: "highlight-line",
        type: "line",
        source: "highlight",
        filter: ["!=", ["geometry-type"], "Point"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ff0066", "line-width": 5, "line-opacity": 0.95 },
      },
      {
        id: "highlight-point-outer",
        type: "circle",
        source: "highlight",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 1 },
      },
      {
        id: "highlight-point",
        type: "circle",
        source: "highlight",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 6, "circle-color": "#ff0066", "circle-opacity": 1 },
      },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl());

map.on("click", "stops", (e) => {
  const p = e.features[0].properties;
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(`<strong>${p.stop_name || ""}</strong><br>${p.stop_id}`)
    .addTo(map);
});
for (const id of ["stops", "routes"]) {
  map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
}

// Resolves as soon as the style object exists, which happens without a paint.
const mapReady = new Promise((resolve) => {
  const poll = () => {
    if (map.getSource("stops")) resolve();
    else setTimeout(poll, 50);
  };
  poll();
});

function bboxOf(fc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      minX = Math.min(minX, coords[0]);
      maxX = Math.max(maxX, coords[0]);
      minY = Math.min(minY, coords[1]);
      maxY = Math.max(maxY, coords[1]);
    } else {
      coords.forEach(visit);
    }
  };
  for (const f of fc.features) if (f.geometry) visit(f.geometry.coordinates);
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

function fitTo(fc, maxZoom) {
  const bbox = bboxOf(fc);
  if (bbox) map.fitBounds(bbox, { padding: 40, maxZoom, duration: 600 });
}

async function setSourceData(id, data) {
  await mapReady;
  map.getSource(id).setData(data);
}

function highlightFeatureCollection(fc, { point } = {}) {
  if (!mapIsVisible()) setMapVisible(true); // asked to see it on the map, so show the map
  setSourceData("highlight", fc);
  if (fc.features.length) fitTo(fc, point ? 16 : 14);
}

// The map is optional, and its GeoJSON is the most expensive thing this tool
// fetches, so it is only built while the map is actually shown.
function mapIsVisible() {
  return !el("map-pane").hidden;
}

function setMapVisible(visible) {
  el("map-pane").hidden = !visible;
  el("toggle-map-btn").textContent = visible ? "Hide map" : "Show map";
  try {
    localStorage.setItem("gtfs-garage.map-visible", visible ? "1" : "0");
  } catch (err) {
    /* private browsing - the preference just won't persist */
  }
  if (!visible) return;
  map.resize();
  if (!state.mapDataLoaded) {
    refreshBaseMapLayers().catch((e) => console.error("Map layers failed to load:", e));
  }
}

el("toggle-map-btn").addEventListener("click", () => setMapVisible(!mapIsVisible()));

async function refreshBaseMapLayers() {
  if (!mapIsVisible()) return;
  const [routes, stops, shapes] = await Promise.all([
    fetchJson("/api/geojson/routes"),
    fetchJson("/api/geojson/stops"),
    fetchJson("/api/geojson/shapes"),
  ]);
  state.routesGeojson = routes;
  await setSourceData("routes", routes);
  await setSourceData("stops", stops);
  // Only draw the plain shapes layer for shapes no colored route covers.
  const routeShapeIds = new Set(routes.features.map((f) => f.properties.shape_id));
  await setSourceData("shapes", {
    type: "FeatureCollection",
    features: shapes.features.filter((f) => !routeShapeIds.has(f.properties.shape_id)),
  });
  await setSourceData("highlight", EMPTY_FC);
  fitTo(routes.features.length ? routes : shapes.features.length ? shapes : stops, 13);
  state.mapDataLoaded = true;
}

// ------------------------------------------------------------- fetch helpers

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ------------------------------------------------------------- feed loading

el("open-load-btn").addEventListener("click", () => el("load-overlay").classList.remove("hidden"));

const dropzone = el("dropzone");
dropzone.addEventListener("click", () => el("file-input").click());
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadFromFile(file);
});
el("file-input").addEventListener("change", (e) => {
  if (e.target.files[0]) loadFromFile(e.target.files[0]);
});
el("load-path-btn").addEventListener("click", () => {
  const path = el("path-input").value.trim();
  if (path) loadFromPath(path);
});

async function loadFromFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  await doLoad(() => fetchJson("/api/load", { method: "POST", body: formData }));
}

async function loadFromPath(path) {
  await doLoad(() =>
    fetchJson(`/api/load?path=${encodeURIComponent(path)}`, { method: "POST" })
  );
}

async function doLoad(loader) {
  el("load-error").textContent = "";
  try {
    const data = await loader();
    onFeedLoaded(data);
    el("load-overlay").classList.add("hidden");
  } catch (err) {
    el("load-error").textContent = err.message;
  }
}

function onFeedLoaded(data) {
  el("load-overlay").classList.add("hidden");
  el("source-label").textContent = data.source;
  state.tables = data.tables;
  state.mapDataLoaded = false;
  renderSidebar();
  refreshBaseMapLayers().catch((err) => console.error("Map layers failed to load:", err));

  const known = (name) => data.tables.some((t) => t.name === name);
  const fromUrl = viewFromUrl();
  const fallback = data.tables.find((t) => t.name === "routes") || data.tables[0];
  const initial = fromUrl && known(fromUrl.table) ? fromUrl : fallback && { table: fallback.name, filters: [], page: 1 };
  if (!initial) return;

  viewDepth = 0;
  history.replaceState({ gtfsView: { ...initial, depth: 0 } }, "", viewUrl(initial));
  setView(initial, { push: false });
}

function viewFromUrl() {
  const params = new URLSearchParams(location.search);
  const table = params.get("table");
  if (!table) return null;
  let filters = [];
  try {
    filters = JSON.parse(params.get("filters") || "[]");
  } catch (err) {
    filters = [];
  }
  return { table, filters, page: Number(params.get("page")) || 1 };
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const sidebar = el("sidebar");
  sidebar.innerHTML = "";
  for (const t of state.tables) {
    const div = document.createElement("div");
    div.className = "table-tab" + (t.name === state.currentTable ? " active" : "");
    div.innerHTML = `<span>${t.name}</span><span class="count">${t.row_count.toLocaleString()}</span>`;
    div.addEventListener("click", () => selectTable(t.name));
    sidebar.appendChild(div);
  }
}

// ------------------------------------------------------------- table logic

function currentTableInfo() {
  return state.tables.find((t) => t.name === state.currentTable);
}

// Every view change (table switch, filter add/remove, paging) goes through
// setView so it lands in browser history - the in-app Back button and the
// browser's own back/forward are then the same mechanism, and the URL stays
// shareable/reloadable.
let viewDepth = 0;

function currentView() {
  return { table: state.currentTable, filters: state.filters, page: state.page };
}

function viewUrl(view) {
  const params = new URLSearchParams({ table: view.table, page: String(view.page || 1) });
  if (view.filters && view.filters.length) params.set("filters", JSON.stringify(view.filters));
  return `?${params}`;
}

function setView(view, { push = true } = {}) {
  if (!state.tables.some((t) => t.name === view.table)) return;
  state.currentTable = view.table;
  state.filters = view.filters ? JSON.parse(JSON.stringify(view.filters)) : [];
  state.page = view.page || 1;

  state.columnInfoByName = {};
  for (const c of currentTableInfo().columns) state.columnInfoByName[c.name] = c;

  renderSidebar();
  renderFilterBar();
  loadTableData();

  const entry = { gtfsView: { ...view, depth: push ? ++viewDepth : viewDepth } };
  if (push) history.pushState(entry, "", viewUrl(view));
  updateBackButton();
}

function updateBackButton() {
  el("back-btn").disabled = viewDepth <= 0;
}

window.addEventListener("popstate", (e) => {
  const view = e.state && e.state.gtfsView;
  if (!view) return;
  viewDepth = view.depth || 0;
  setView(view, { push: false });
});

el("back-btn").addEventListener("click", () => history.back());

function selectTable(name, presetFilters) {
  setView({ table: name, filters: presetFilters || [], page: 1 });
}

function renderFilterBar() {
  const bar = el("filter-bar");
  bar.querySelectorAll(".chip").forEach((c) => c.remove());
  state.filters.forEach((f, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const shown = f.value === "" || f.value == null ? "(empty)" : f.value;
    const needsValue = f.op !== "is_empty" && f.op !== "is_not_empty";
    chip.innerHTML = `<span>${f.column} ${opLabel(f.op)} ${needsValue ? shown : ""}</span>`;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      const filters = state.filters.filter((_, i) => i !== idx);
      setView({ table: state.currentTable, filters, page: 1 });
    });
    chip.appendChild(removeBtn);
    bar.appendChild(chip);
  });

  const colSelect = el("filter-column");
  colSelect.innerHTML = Object.keys(state.columnInfoByName)
    .map((c) => `<option value="${c}">${c}</option>`)
    .join("");
}

function opLabel(op) {
  return { eq: "=", ne: "!=", contains: "contains", in: "in", is_empty: "is empty", is_not_empty: "is not empty" }[op] || op;
}

el("add-filter-btn").addEventListener("click", () => {
  el("add-filter-form").classList.add("open");
  updateFilterValueInput();
});
el("filter-cancel-btn").addEventListener("click", () => el("add-filter-form").classList.remove("open"));
el("filter-column").addEventListener("change", updateFilterValueInput);
el("filter-op").addEventListener("change", updateFilterValueInput);

async function updateFilterValueInput() {
  const column = el("filter-column").value;
  const op = el("filter-op").value;
  const valueInput = el("filter-value");
  const valuePicker = el("filter-value-picker");

  if (op === "is_empty" || op === "is_not_empty") {
    valueInput.style.display = "none";
    valuePicker.style.display = "none";
    return;
  }

  const info = state.columnInfoByName[column];
  if (info && info.enum_like && op !== "contains" && op !== "in") {
    valueInput.style.display = "none";
    valuePicker.style.display = "inline-block";
    valuePicker.innerHTML = '<option value="">Loading...</option>';
    const data = await fetchJson(
      `/api/table/${state.currentTable}/distinct/${column}?limit=100`
    );
    valuePicker.innerHTML = data.values
      .map((v) => `<option value="${v.value ?? ""}">${v.value === "" || v.value === null ? "(empty)" : v.value} (${v.count})</option>`)
      .join("");
  } else {
    valueInput.style.display = "inline-block";
    valuePicker.style.display = "none";
  }
}

el("filter-apply-btn").addEventListener("click", () => {
  const column = el("filter-column").value;
  const op = el("filter-op").value;
  const valuePicker = el("filter-value-picker");
  const value = valuePicker.style.display !== "none" ? valuePicker.value : el("filter-value").value;
  if (!column) return;
  el("add-filter-form").classList.remove("open");
  el("filter-value").value = "";
  setView({
    table: state.currentTable,
    filters: [...state.filters, { column, op, value }],
    page: 1,
  });
});

async function loadTableData() {
  const params = new URLSearchParams({
    page: state.page,
    page_size: state.pageSize,
    filters: JSON.stringify(state.filters),
  });
  try {
    const data = await fetchJson(`/api/table/${state.currentTable}?${params}`);
    state.currentColumns = data.columns;
    renderTable(data);
  } catch (err) {
    showTableMessage(`Could not load ${state.currentTable}: ${err.message}`);
  }
}

function showTableMessage(text) {
  const container = el("table-scroll");
  container.innerHTML = "";
  const div = document.createElement("div");
  div.id = "empty-state";
  div.textContent = text;
  container.appendChild(div);
  el("pager").style.display = "none";
}

const SPECIAL_ID_COLUMNS = ["stop_id", "shape_id", "route_id"];

function renderTable(data) {
  const container = el("table-scroll");
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th></th>" + data.columns.map((c) => `<th>${c}</th>`).join("");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of data.rows) {
    const tr = document.createElement("tr");
    const rowObj = {};
    data.columns.forEach((c, i) => (rowObj[c] = row[i]));

    const actionsTd = document.createElement("td");
    actionsTd.appendChild(buildRowActions(rowObj));
    tr.appendChild(actionsTd);

    data.columns.forEach((col, i) => {
      const td = document.createElement("td");
      const value = row[i];
      const info = state.columnInfoByName[col];
      if (info && info.fk_table && value) {
        const a = document.createElement("a");
        a.href = "#";
        a.className = "fk-link";
        a.textContent = value;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          selectTable(info.fk_table, [{ column: info.fk_column, op: "eq", value }]);
        });
        td.appendChild(a);
      } else {
        td.textContent = value ?? "";
      }
      if (info && info.related && info.related.length && value) {
        const relRow = document.createElement("div");
        relRow.className = "related-row";
        for (const rel of info.related) {
          const btn = document.createElement("button");
          btn.className = "related-btn";
          btn.textContent = `▸ ${rel.table}`;
          btn.addEventListener("click", () =>
            selectTable(rel.table, [{ column: rel.column, op: "eq", value }])
          );
          relRow.appendChild(btn);
        }
        td.appendChild(relRow);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.innerHTML = "";
  container.appendChild(table);

  el("pager").style.display = "flex";
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  el("page-info").textContent = `Page ${data.page} / ${totalPages}`;
  el("row-count").textContent = `${data.total.toLocaleString()} rows`;
  el("prev-page").disabled = data.page <= 1;
  el("next-page").disabled = data.page >= totalPages;
}

function buildRowActions(rowObj) {
  const wrap = document.createElement("span");
  if (rowObj.stop_id) {
    wrap.appendChild(mapButton("📍", async () => {
      const fc = await fetchJson(`/api/geojson/stops?stop_ids=${encodeURIComponent(rowObj.stop_id)}`);
      highlightFeatureCollection(fc, { point: true });
    }));
  }
  if (rowObj.shape_id) {
    wrap.appendChild(mapButton("🧭", async () => {
      const fc = await fetchJson(`/api/geojson/shapes?shape_ids=${encodeURIComponent(rowObj.shape_id)}`);
      highlightFeatureCollection(fc);
    }));
  }
  if (rowObj.route_id && state.routesGeojson) {
    wrap.appendChild(mapButton("🚌", () => {
      const feature = state.routesGeojson.features.find((f) => f.properties.route_id === rowObj.route_id);
      highlightFeatureCollection({ type: "FeatureCollection", features: feature ? [feature] : [] });
    }));
  }
  return wrap;
}

function mapButton(label, onClick) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.marginRight = "2px";
  btn.title = "Show on map";
  btn.addEventListener("click", onClick);
  return btn;
}

el("prev-page").addEventListener("click", () => {
  if (state.page > 1) setView({ ...currentView(), page: state.page - 1 });
});
el("next-page").addEventListener("click", () => {
  setView({ ...currentView(), page: state.page + 1 });
});

// -------------------------------------------------------------- bootstrap

(async function init() {
  let savedMapVisible = null;
  try {
    savedMapVisible = localStorage.getItem("gtfs-garage.map-visible");
  } catch (err) {
    /* storage unavailable - fall back to showing the map */
  }
  setMapVisible(savedMapVisible !== "0");

  try {
    const data = await fetchJson("/api/tables");
    onFeedLoaded(data);
  } catch (err) {
    el("load-overlay").classList.remove("hidden");
  }
})();
