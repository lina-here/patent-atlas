// Sections in native <details class="prose-box"> boxes, closed by default (methods page, SMEs page). A #hash, a hash change
// or an in-page link opens the box holding its target; print opens every box and closes, after, only the ones it opened.

/** Opens every box holding the element with this id, or the box that is its own first level (a section wrapping its box);
 * scrolls to it when asked. */
export function openTo(id: string, scroll: boolean): void {
  const target = document.getElementById(id);
  if (!target) return;
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  for (const own of target.querySelectorAll<HTMLDetailsElement>(":scope > details.prose-box")) own.open = true;
  if (scroll) target.scrollIntoView();
}

export function hashId(hash: string): string {
  try { return decodeURIComponent(hash.slice(1)); } catch { return hash.slice(1); }
}

/** Window listeners (hash, print) are added once per document, never at import: every page loads this module. */
let windowListening = false;

// print shows every box (sections, and the SMEs page's amounts boxes): open the closed ones for the print, close them again after (the stylesheet does the same where
// the browser supports ::details-content)
const boxesOpenedForPrint = new Set<HTMLDetailsElement>();
function openBoxesForPrint(): void {
  for (const details of document.querySelectorAll<HTMLDetailsElement>("details.prose-box:not([open]), details.sme-amounts-box:not([open])")) {
    details.open = true;
    boxesOpenedForPrint.add(details);
  }
}
function closeBoxesAfterPrint(): void {
  for (const details of boxesOpenedForPrint) details.open = false;
  boxesOpenedForPrint.clear();
}

/** Call after the page's boxes are drawn into `el`: links in it, the address's #hash, hash changes and print open boxes. */
export function listenForBoxes(el: HTMLElement): void {
  // a link into a closed box opens it first; the browser's own fragment scroll then finds the target drawn
  el.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    if (link) openTo(hashId(link.getAttribute("href") ?? "#"), false);
  });
  if (!windowListening) {
    windowListening = true;
    window.addEventListener("hashchange", () => openTo(hashId(location.hash), true));
    window.addEventListener("beforeprint", openBoxesForPrint);
    window.addEventListener("afterprint", closeBoxesAfterPrint);
  }
  // the page draws after its data loads, past the browser's own scroll to the #hash
  if (location.hash.length > 1) openTo(hashId(location.hash), true);
}
