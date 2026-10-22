/**
 * The tour session: while a tour is being written or played, the viewer is
 * locked to it.
 *
 * Without this, everything around a tour still navigates - the sidebar, the
 * Explore/Files switch, a link in a table cell, a click on the map - and one
 * click leaves the tour with no clear way back. So while a session is open:
 *
 * - the header is replaced by a bar saying what is open, with one way out:
 *   Back to Tours, or back to the finding the tour was started from;
 * - the sidebar, menus, toolbar and filter bar are put away (`tour-locked` on
 *   the viewer's root, see style.css), and the host's navigation callbacks ask
 *   `allows` before they move;
 * - what is left is reading: the table scrolls, the map pans and zooms, and
 *   the tour card steps.
 *
 * Two kinds. `edit` is the tour editor; a tour played from it ends back in the
 * editor. `play` is a tour played from Explain; it ends where it was started.
 *
 * The Tour Studio is locked all the time: between tours its bar offers the
 * list of notices and a way to close the studio.
 */

import type { View } from "../state";
import { node } from "../ui/html";

export type SessionKind = "edit" | "play";

export interface Session {
  kind: SessionKind;
  code: string;
  /** Where leaving goes: the screen the session was started from. */
  returnTo: View;
}

export interface SessionDeps {
  /** The viewer's root element, which carries `tour-locked`. */
  root: HTMLElement;
  /** Where the bar is drawn, in the header. */
  bar: HTMLElement;
  /** Leave the session the reader is in, by the bar's button. */
  leave(session: Session): void;
  /** The demo feed being read, if any, for the bar to say. */
  demo(): string | null;
  /** This is the Tour Studio, locked whether or not a tour is open. */
  studio?: boolean;
  /** Leave the studio. */
  closeStudio?(): void;
  /** The lock was taken or let go: what depends on it is drawn again. */
  changed?(): void;
}

export class TourSession {
  private current: Session | null = null;

  constructor(private readonly deps: SessionDeps) {}

  get session(): Session | null {
    return this.current;
  }

  /** Whether the viewer is locked now: a tour is open, or this is the studio. */
  get locked(): boolean {
    return this.current !== null || Boolean(this.deps.studio);
  }

  /** Open a session, or move the open one to another notice. An edit session is not turned into a play one. */
  begin(kind: SessionKind, code: string, returnTo: View): void {
    if (this.current?.kind === "edit" && kind === "play") {
      this.current = { ...this.current, code };
    } else if (this.current) {
      this.current = { ...this.current, kind, code };
    } else {
      this.current = { kind, code, returnTo };
    }
    this.draw();
  }

  end(): Session | null {
    const was = this.current;
    this.current = null;
    this.draw();
    return was;
  }

  /**
   * Whether a navigation may happen now. Nothing moves the viewer during a
   * session but the tour itself, except, while writing one, going between
   * notices in Tours.
   */
  allows(screen?: string): boolean {
    if (!this.current) return !this.deps.studio || screen === "tours";
    return this.current.kind === "edit" && screen === "tours";
  }

  /** Draw the bar again: the demo feed it names changed. */
  draw(): void {
    const session = this.current;
    const studio = Boolean(this.deps.studio);
    this.deps.root.classList.toggle("tour-locked", session !== null || studio);
    this.deps.root.classList.toggle("tour-studio", studio);
    this.deps.bar.hidden = session === null && !studio;
    this.deps.changed?.();
    if (!session) {
      this.deps.bar.replaceChildren();
      if (studio) this.drawStudioHome();
      return;
    }
    const back = node("button", {
      class: "tour-bar-back",
      title: session.kind === "edit" ? "Close the editor and go back to the list of tours" : "Leave the tour",
      text: `← ${this.backLabel(session)}`,
    });
    back.addEventListener("click", () => this.deps.leave(session));
    const demo = this.deps.demo();
    this.deps.bar.replaceChildren(
      back,
      node("span", { class: "tour-bar-kind", text: session.kind === "edit" ? "Editing the tour for" : "Playing the tour for" }),
      node("strong", { class: "tour-bar-code", text: session.code }),
    );
    if (demo) this.deps.bar.append(node("span", { class: "tour-bar-demo", text: `on the demo feed "${demo}"` }));
    if (studio) this.deps.bar.prepend(node("strong", { class: "tour-bar-title", text: "Tour Studio" }));
  }

  private drawStudioHome(): void {
    const close = node("button", { class: "tour-bar-back", title: "Close the Tour Studio", text: "Close studio" });
    close.addEventListener("click", () => this.deps.closeStudio?.());
    this.deps.bar.append(
      node("strong", { class: "tour-bar-title", text: "Tour Studio" }),
      node("span", { class: "tour-bar-kind", text: "Choose a notice to write or change its tour." }),
      node("span", { class: "assistant-spacer" }),
      close,
    );
  }

  private backLabel(session: Session): string {
    if (session.returnTo.screen === "tours") return "Back to Tours";
    if (session.returnTo.screen === "quality") return session.returnTo.argument ? "Back to the finding" : "Back to the findings";
    return session.kind === "edit" ? "Close the editor" : "Leave the tour";
  }
}
