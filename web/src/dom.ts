/** Small DOM helpers shared by the UI modules. */

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

export function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.title = title;
  element.addEventListener("click", onClick);
  return element;
}
