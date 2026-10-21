/**
 * Building elements without writing markup into strings.
 *
 * The derived views assemble a fair amount of structure, and the alternative -
 * template strings and `innerHTML` - would put feed-supplied text (a stop name,
 * a headsign, an agency's own URL) into the parser. Everything here writes
 * through `textContent`, so a feed cannot inject markup no matter what it
 * contains.
 */

type Attributes = Record<string, string | undefined>;
type Child = Node | string | null | undefined | false;

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (name === "class") element.className = value;
    else if (name === "text") element.textContent = value;
    else if (name.startsWith("data-") || name === "title" || name === "href" || name === "hidden") {
      element.setAttribute(name, value);
    } else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/**
 * Append children, skipping the ones that were not built.
 *
 * Several sections render to nothing at all - a feed with no gaps in its
 * calendar, a route with no stop patterns - and returning null from the
 * builder is clearer at the call site than a conditional around every append.
 */
export function append(parent: HTMLElement, ...children: (Node | null)[]): HTMLElement {
  for (const child of children) if (child) parent.append(child);
  return parent;
}

/**
 * A link that goes somewhere in this application rather than to a URL.
 *
 * `href="#"` with the default prevented, because these navigate the viewer's
 * own history; a real href would reload the page and lose the loaded feed.
 */
export function action(label: string, title: string, run: () => void): HTMLAnchorElement {
  const anchor = node("a", { class: "explore-link", href: "#", title, text: label });
  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    run();
  });
  return anchor;
}

/** A labelled figure: the number big, the label under it. */
export function stat(label: string, value: string, title?: string): HTMLElement {
  return node("div", { class: "stat", title }, [
    node("div", { class: "stat-value", text: value }),
    node("div", { class: "stat-label", text: label }),
  ]);
}

/** A titled block with an optional one-line explanation under the heading. */
export function section(title: string, hint?: string, children: Child[] = []): HTMLElement {
  return node("section", { class: "explore-section" }, [
    node("h3", { text: title }),
    hint ? node("p", { class: "explore-hint", text: hint }) : null,
    ...children,
  ]);
}

/**
 * A sentence with its `code` spans drawn as code: how a tour names a file or a
 * column. Text only, like everything here, so a value from the feed inside the
 * backticks is still text.
 */
export function prose(text: string): (Node | string)[] {
  const parts = text.split(/`([^`\n]+)`/);
  return parts.map((part, index) => (index % 2 ? node("code", { class: "prose-code", text: part }) : part)).filter((part) => part !== "");
}
