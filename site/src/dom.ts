// Small DOM builder. Text always goes in as text nodes (never innerHTML), so data and URL params
// cannot inject markup.

/** Nested arrays are flattened, so `list.map(...)` can go straight in. */
export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  appendChildren(element, children);
  return element;
}

function appendChildren(element: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(element, child);
    else element.append(typeof child === "number" ? String(child) : child);
  }
}

/** Integer with thousands separators; null -> "–" (missing data is never shown as 0). */
export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : value.toLocaleString("en-US");
}
