/**
 * The pane one screen is drawn in.
 *
 * One screen is showing at a time, or none - and when none is, the file
 * browser is, unchanged and complete. That is the arrangement the whole
 * feature rests on: the derived views are a second way in, never a
 * replacement, and each links back into the rows it was computed from.
 *
 * Fetching lives here rather than in a screen's `render`, so every renderer
 * stays a pure function of its payload - testable with a fixture and no
 * network, whether it is one of ours or a host's.
 */

import type { Dom } from "../dom";
import type { ViewerSource } from "../sources/types";
import type { AppState, View } from "../state";
import { node } from "./html";
import type { Screen, ScreenContext } from "./screens";

export class ScreenPane {
  /**
   * Which render is the current one.
   *
   * A reader clicking through routes faster than the source answers would
   * otherwise see an earlier route land on top of a later one. Each render
   * takes a ticket and draws only if it still holds the latest.
   */
  private token = 0;

  constructor(
    private readonly dom: Dom,
    private readonly state: AppState,
    private readonly source: ViewerSource,
    private readonly context: ScreenContext,
    private readonly onLayout?: () => void,
  ) {}

  /**
   * Put the map where this screen wants it.
   *
   * A data attribute rather than classes, so the stylesheet owns the
   * arrangement and this owns only the choice. `onLayout` lets the map resize
   * itself: nothing fires on a pure CSS reflow, so a canvas whose box changed
   * keeps the old one until it is told.
   */
  private applyLayout(layout: Screen["layout"]): void {
    const content = this.dom.el("content");
    const wanted = layout ?? "beside";
    if (content.dataset.layout === wanted) return;
    content.dataset.layout = wanted;
    this.onLayout?.();
  }

  /** Hand the pane back to the file browser. */
  hide(): void {
    this.token += 1;
    this.applyLayout("beside");
    void this.context.focusRoutes?.(null);
    const pane = this.dom.el("screen-pane");
    pane.hidden = true;
    pane.replaceChildren();
    this.dom.el("table-pane").hidden = false;
  }

  /**
   * Draw the screen a view names.
   *
   * Returns having drawn either the screen or the reason it could not, so a
   * caller never has to decide what an error looks like.
   */
  async show(view: View): Promise<void> {
    if (!view.screen) return this.hide();

    const ticket = (this.token += 1);
    this.applyLayout(this.find(view.screen)?.layout);
    // Every screen starts from the whole network. A screen that wants one
    // route in focus asks for it while rendering; one that does not need say
    // nothing, and cannot inherit the last screen's focus by forgetting to.
    void this.context.focusRoutes?.(null);
    this.dom.el("table-pane").hidden = true;
    // Resolved before the fetch, not after: a host can unmount the viewer while
    // this is in flight - React does exactly that on every development remount
    // - and looking the element up afterwards would throw into a promise nobody
    // is holding. Writing into a detached element is harmless.
    const pane = this.dom.el("screen-pane");
    pane.hidden = false;
    pane.replaceChildren(node("div", { class: "explore-loading", text: "Reading the feed…" }));

    try {
      const content = await this.build(view);
      if (ticket !== this.token) return;
      pane.replaceChildren(content);
      pane.scrollTop = 0;
    } catch (error) {
      if (ticket !== this.token) return;
      pane.replaceChildren(
        node("div", { class: "explore-error" }, [
          node("strong", { text: "Could not read this view. " }),
          node("span", { text: (error as Error).message }),
        ]),
      );
    }
  }

  private async build(view: View): Promise<HTMLElement> {
    const screen = this.find(view.screen);
    if (!screen) {
      // A hand-written URL, or a host that changed its screens between one
      // visit and the next. A sentence beats a blank pane.
      return node("div", { class: "explore-error", text: `No view called "${view.screen}".` });
    }
    const data = await screen.fetch(this.source, view.argument, view.date ?? this.context.date);
    return screen.render(data, this.context);
  }

  private find(id: string | undefined): Screen | undefined {
    return this.state.screens.find((screen) => screen.id === id);
  }
}
