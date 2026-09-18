/** Small DOM helpers shared by the UI modules. */

/**
 * Element lookup scoped to one viewer.
 *
 * Every lookup goes through a root rather than `document`, so two viewers can
 * exist on one page without reaching into each other's markup, and a viewer
 * embedded in a host cannot match the host's own elements.
 */
export interface Dom {
  el<T extends HTMLElement = HTMLElement>(name: string): T;
}

export function createDom(root: ParentNode): Dom {
  return {
    el<T extends HTMLElement = HTMLElement>(name: string): T {
      // `data-el` rather than `id`: two viewers on one page would otherwise put
      // duplicate ids into the host's document. See markup.ts.
      const found = root.querySelector(`[data-el="${CSS.escape(name)}"]`);
      if (!found) throw new Error(`Missing element ${name}`);
      return found as T;
    },
  };
}

/**
 * The whole document, for the application that owns the page.
 *
 * Embedded viewers build their own with `createDom(root)`; this is the one case
 * where taking the document is correct rather than an assumption. A function
 * rather than a constant so that merely importing this module does not require
 * a document - the tests run without one, which is what keeps the UI's pure
 * logic testable.
 */
export function documentDom(): Dom {
  return createDom(document);
}

export function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.title = title;
  element.addEventListener("click", onClick);
  return element;
}
