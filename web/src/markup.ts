/**
 * The viewer's own markup.
 *
 * Built here rather than written into a page, so a viewer can be mounted into
 * any root - which is what an embedded one needs. Elements are tagged with
 * `data-el` rather than `id`: two viewers on one page would otherwise put
 * duplicate ids into their host's document, which is invalid and can collide
 * with the host's own selectors. `createDom` looks them up by that attribute,
 * so nothing outside this file cares which it is.
 *
 * `browse` is the part worth embedding - the file list, the grid, the filters.
 * `load` and `report` belong to the local application: a host that already
 * knows which dataset it is showing has nothing to open and no load to explain.
 */

export interface ViewerParts {
  /** Opening a feed by drop, path or URL. Local application only. */
  load?: boolean;
  /** The load report in the header. Local application only. */
  report?: boolean;
  /** The map pane. */
  map?: boolean;
}

const EVERYTHING: Required<ViewerParts> = { load: true, report: true, map: true };

const header = (parts: Required<ViewerParts>) => `
  <header>
    <h1>GTFS Garage</h1>
    <div data-el="source-label">No feed loaded</div>
    ${parts.report ? `<button data-el="metrics-btn" title="What this feed cost to open" hidden></button>` : ""}
    ${parts.map ? `<button data-el="toggle-map-btn">Hide map</button>` : ""}
    ${parts.load ? `<button data-el="open-load-btn">Load feed</button>` : ""}
  </header>`;

const report = () => `
  <div data-el="metrics-panel" class="hidden">
    <div data-el="metrics-header">
      <strong>Load report</strong>
      <button data-el="metrics-close-btn" title="Close">&times;</button>
    </div>
    <div data-el="metrics-body"></div>
  </div>`;

const browse = (parts: Required<ViewerParts>) => `
  <div data-el="layout">
    <div data-el="sidebar"></div>
    <div data-el="content">
      <div data-el="table-pane">
        <div data-el="filter-bar">
          <button data-el="back-btn" title="Back to the previous view" disabled>&larr; Back</button>
          <button data-el="add-filter-btn">+ Filter</button>
        </div>
        <div data-el="add-filter-form">
          <select data-el="filter-column"></select>
          <select data-el="filter-op">
            <option value="eq">is</option>
            <option value="ne">is not</option>
            <option value="contains">contains</option>
            <option value="in">is one of (comma sep.)</option>
            <option value="is_empty">is empty</option>
            <option value="is_not_empty">is not empty</option>
          </select>
          <input data-el="filter-value" type="text" placeholder="value" />
          <select data-el="filter-value-picker" style="display:none"></select>
          <button data-el="filter-apply-btn" class="primary">Add</button>
          <button data-el="filter-cancel-btn">Cancel</button>
        </div>
        <div data-el="table-scroll">
          <div data-el="empty-state">Load a GTFS feed to start browsing.</div>
        </div>
        <div data-el="pager" style="display:none">
          <button data-el="prev-page">&laquo; Prev</button>
          <span data-el="page-info"></span>
          <button data-el="next-page">Next &raquo;</button>
          <span class="spacer"></span>
          <span data-el="row-count"></span>
        </div>
      </div>
      ${
        parts.map
          ? `<div data-el="map-pane">
        <div data-el="map"></div>
        <!-- Filled in while a layer streams; hidden the rest of the time. -->
        <div data-el="map-progress" hidden></div>
      </div>`
          : ""
      }
    </div>
  </div>`;

const loader = () => `
  <div data-el="load-overlay" class="hidden">
    <div data-el="load-panel">
      <h2>Load a GTFS feed</h2>
      <div data-el="dropzone">Drop a GTFS .zip here, or click to choose one</div>
      <input data-el="file-input" type="file" accept=".zip" style="display:none" />
      <!-- webkitdirectory turns this into a folder chooser. -->
      <input data-el="folder-input" type="file" webkitdirectory directory multiple style="display:none" />
      <div data-el="pick-row">
        <button data-el="pick-file-btn">Choose a .zip…</button>
        <button data-el="pick-folder-btn">Choose a folder…</button>
      </div>
      <div class="or">or</div>
      <label class="field-label">Local path or URL</label>
      <input
        data-el="path-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="/path/to/feed.zip, /path/to/extracted/folder, or https://example.org/gtfs.zip"
      />
      <div data-el="load-actions">
        <button data-el="load-path-btn" class="primary" disabled>Load</button>
        <button data-el="load-cancel-btn">Cancel</button>
      </div>
      <div data-el="load-status"></div>
      <div data-el="load-error"></div>
    </div>
  </div>`;

/** Replace `root`'s contents with the viewer's markup. */
export function buildViewer(root: Element, parts: ViewerParts = {}): void {
  const wanted = { ...EVERYTHING, ...parts };
  root.classList.add("gtfs-viewer");
  root.innerHTML = [
    header(wanted),
    wanted.report ? report() : "",
    browse(wanted),
    wanted.load ? loader() : "",
  ].join("\n");
}
