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
 * `load` and `options` belong to the local application: a host that already
 * knows which dataset it is showing has nothing to open, no load to explain and
 * no workdir of its own.
 */

export interface ViewerParts {
  /** Opening a feed by drop, path or URL. Local application only. */
  load?: boolean;
  /**
   * The options menu: the load report, and the workdir when the source has one.
   * Local application only.
   */
  options?: boolean;
  /** The map pane. */
  map?: boolean;
}

const EVERYTHING: Required<ViewerParts> = { load: true, options: true, map: true };

/**
 * Explore or Files, as a top-level choice rather than two groups in one list.
 *
 * They answer different questions - what this feed means, and what it literally
 * contains - and a sidebar that mixed them made an entry ambiguous. Hidden
 * entirely when the source offers no derived views, which is the case where
 * there is nothing to switch to.
 */
const modes = () => `
    <div data-el="mode-switch" hidden>
      <button data-el="mode-explore" class="mode active">Explore</button>
      <button data-el="mode-files" class="mode">Files</button>
    </div>`;

const header = (parts: Required<ViewerParts>) => `
  <header>
    <h1>GTFS Garage</h1>
    ${modes()}
    <div data-el="source-label">No feed loaded</div>
    ${parts.options ? `<button data-el="options-btn" title="Workdir and load report">⚙ Options</button>` : ""}
    ${parts.map ? `<button data-el="toggle-map-btn">Hide map</button>` : ""}
    ${parts.load ? `<button data-el="open-load-btn">Load feed</button>` : ""}
  </header>`;

/**
 * The options menu, anchored under its button.
 *
 * Two sections, in the order someone reaches for them: what is on disk and what
 * can be done about it, then what the current feed cost to open. The second was
 * a panel of its own until the first existed; they answer the same question -
 * what this tool has put on your machine - and belong behind one button.
 *
 * The workdir section is emptied and hidden when the source has no workdir to
 * describe, which is every source but a local server.
 */
const options = () => `
  <div data-el="options-panel" class="hidden">
    <div data-el="options-header">
      <strong>Options</strong>
      <button data-el="options-close-btn" title="Close">&times;</button>
    </div>

    <section data-el="workdir-section" hidden>
      <div data-el="options-section-title">Workdir</div>
      <div data-el="workdir-path" title="Where this server writes. Click to copy."></div>
      <div data-el="workdir-summary"></div>
      <div data-el="workdir-feeds"></div>
      <div data-el="workdir-actions">
        <button data-el="workdir-clear-btn">Empty workdir</button>
      </div>
      <div data-el="workdir-status"></div>
    </section>

    <section data-el="metrics-section" hidden>
      <div data-el="options-section-title">Load report</div>
      <div data-el="metrics-summary"></div>
      <div data-el="metrics-body"></div>
    </section>
  </div>`;

const browse = (parts: Required<ViewerParts>) => `
  <div data-el="layout">
    <div data-el="sidebar"></div>
    <div data-el="content">
      <!--
        Back and the day sit above *both* panes - outside the pane wrapper, not
        inside the browsing half - because a screen can ask for the map above it
        rather than beside it, and a toolbar nested in one pane slides under the
        map when it does. It is also the only back control an embedded viewer
        has: that one keeps its host's address bar to itself, so there is no
        browser Back behind it, and a control that moves down the page as the
        layout changes is one a reader has to go looking for.
      -->
      <div data-el="toolbar">
        <button data-el="back-btn" title="Back to the previous view" disabled>&larr; Back</button>
        <!--
          The chosen day, and only when there is one. Nothing is filtered by
          date until someone asks for it, so on an untouched feed there is no
          control here at all - and when there is, it sits above the content
          it governs rather than floating in a toolbar beside Back.
        -->
        <div data-el="date-chip" class="date-chip" hidden>
          <span data-el="date-chip-day"></span>
          <span data-el="date-chip-note" class="explore-hint"></span>
          <button data-el="date-prev" title="The day before">&lsaquo;</button>
          <button data-el="date-next" title="The day after">&rsaquo;</button>
          <button data-el="date-jump" title="Go to a particular day">Jump to&hellip;</button>
          <button data-el="date-clear" title="Stop filtering by day">&times;</button>
        </div>
        <div data-el="date-menu" class="date-menu" hidden></div>
      </div>
      <div data-el="panes">
      <div data-el="browse-pane">
        <!--
          The derived views. Hidden whenever the file browser is showing, which
          is the arrangement the whole feature rests on: they are a second way
          into the same rows, never a replacement for them.
        -->
        <div data-el="screen-pane" hidden></div>
        <div data-el="table-pane">
          <div data-el="filter-bar">
            <button data-el="add-filter-btn">+ Filter</button>
            <label data-el="raw-values" class="raw-toggle"
                   title="Show the characters the feed contains, without formatting">
              <input data-el="raw-values-input" type="checkbox" /> Raw values
            </label>
            <label data-el="files-network" class="raw-toggle" hidden
                   title="Draw every other route behind what this view selects">
              <input data-el="files-network-input" type="checkbox" /> Show the rest of the network
            </label>
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
    </div>
  </div>`;

const loader = () => `
  <div data-el="load-overlay" class="hidden">
    <div data-el="load-panel">
      <h2>Load a GTFS feed</h2>
      <!--
        Feeds the workdir already holds, offered before the ways of fetching
        one: reopening is instant and needs no network, so when it is on the
        table it is almost always the answer. Hidden unless the source has a
        workdir, which is what tells a local run from a hosted one.
      -->
      <section data-el="recent-section" hidden>
        <label class="field-label">In the workdir</label>
        <div data-el="recent-feeds"></div>
        <div class="or">or</div>
      </section>
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
    wanted.options ? options() : "",
    browse(wanted),
    wanted.load ? loader() : "",
  ].join("\n");
}
