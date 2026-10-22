// Theme = one stylesheet `themes/<name>.css` of custom properties. base.css hides the body until
// `html.theme-ready`, so a page never flashes unstyled; revealPage() is the fallback when loading fails.

let loaded: Promise<void> = Promise.resolve();

/** Settles when the theme stylesheet has loaded (or failed): charts read its custom properties and
 * measure the themed layout, so they draw after this. */
export function themeLoaded(): Promise<void> {
  return loaded;
}

export function applyTheme(name: string): void {
  const root = document.documentElement;
  let link = document.getElementById("theme") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "theme";
    link.rel = "stylesheet";
    document.head.append(link);
  }
  const target = link;
  loaded = new Promise((resolve) => {
    const done = (): void => { revealPage(); resolve(); };
    target.addEventListener("load", done, { once: true });
    target.addEventListener("error", done, { once: true });
  });
  link.href = `themes/${name}.css`;
  root.dataset.theme = name;
}

export function revealPage(): void {
  document.documentElement.classList.add("theme-ready");
}
