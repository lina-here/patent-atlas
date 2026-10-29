// Chart card: the frame every chart is shown in (overview, country and office pages, embed).
// Title, chart, source line (caption), WIPO query in words, and the "Show figures", "Cite this" and
// "Embed" tools. Compact mode (embed page): title, chart, source line and a link to the full page.
import { isListSource, type CardSource, type Config, type Manifest, type SourceBlock } from "./data";
import { h, formatCount } from "./dom";
import { PAGE_PARAMS, addressTheme, linkParams, shareUrl, withParams, type Params } from "./params";
import { citeText, listSourceLine, sourceLine } from "./provenance";

/** A cell with `href` is a link (the figures table must reach pages by keyboard); `target` opens a new tab (embed). */
export type TableCell = string | number | null | { text: string; href: string; target?: string };
/** `numeric[i]` right-aligns column i (counts, years, percentages); without it, columns whose cells are
 * all numbers or null are numeric. */
export type ChartTable = { headers: string[]; rows: TableCell[][]; numeric?: boolean[] };

export type ChartSpec = {
  id: string;
  title: string;
  /** A chart (SVG, labelled as an image by the card title) or another figure such as tiles. */
  visual: SVGElement | HTMLElement;
  table: ChartTable;
  /** Further tables in the same "Show figures" panel, each under its caption (map: former entities). */
  moreTables?: { caption: string; table: ChartTable }[];
  /** One block, or one per series for a card mixing series (tiles): each distinct source line and query shown. */
  source: CardSource | CardSource[];
  /** One line under the title: what is counted, thresholds. */
  note?: string;
  /** Lines under the chart, before the source line: years left out and why, items listed apart from the plot, caveats. */
  footnotes?: string[];
  /** Credits beside the source line other than WIPO's (map geometry). */
  credits?: string[];
  /** Credits of data behind the figures other than WIPO's (World Bank WDI): shown like `credits` and named in the
   * citation (final review I1). */
  dataCredits?: string[];
  /** The overview chart a dashboard tile links to (`CardContext.linkOverview`) when it is not the card itself (key figures). */
  overviewChart?: string;
};

/** `openNotes`: the card's sources-and-notes `<details>` starts open (the wallboard focus view, which shows the footnotes).
 * `idPrefix`: put before every id the card makes (card, title, tool panels), so a chart shown twice on one page (dashboard
 * carousel) keeps its ids unique; `data-chart` stays the chart id. `linkOverview`: a full card that links to its chart on the
 * overview, same tab (dashboard). */
export type CardContext = {
  cfg: Config; manifest: Manifest; params: Params; compact?: boolean; openNotes?: boolean; idPrefix?: string; linkOverview?: boolean;
};

/** Summary of the one `<details>` per card that holds footnotes and "To reproduce" lines (spec: Less clutter around charts). */
export const CARD_DETAILS_SUMMARY = "Sources, notes and how to reproduce";

const DATA_CENTER = "WIPO IP Statistics Data Center";
const COPIED_MESSAGE_MS = 2000;

/** Link to this chart with `theme` (undefined = no `?theme=`: the site default; never the raw address's, which
 * may be unknown); `page` `./` holds overview, country and office pages; the other keys from the checked params. */
function chartLink(id: string, params: Params, theme: string | undefined, page: string): string {
  return withParams({ ...linkParams(params), theme, chart: id, rotate: undefined }, page);
}

function cellContent(value: TableCell): string | HTMLElement {
  if (value === null) return "–";
  if (typeof value === "object") {
    return h("a", { href: value.href, ...(value.target ? { target: value.target, rel: "noopener" } : {}) }, value.text);
  }
  return typeof value === "number" ? formatCount(value) : value;
}

/** A table in its scroll box (figures panel; a card whose figure is a table: group members). */
export function dataTable(table: ChartTable, label: string, caption?: string): HTMLElement {
  const numeric = table.numeric ?? table.headers.map((_, column) =>
    table.rows.every((row) => typeof row[column] === "number" || row[column] === null));
  const cls = (column: number): Record<string, string> => (numeric[column] ? { class: "num" } : {});
  return h("div", { class: "table-scroll" },
    h("table", { class: "data-table", "aria-label": label },
      caption ? h("caption", {}, caption) : null,
      h("thead", {}, h("tr", {}, table.headers.map((header, column) => h("th", { scope: "col", ...cls(column) }, header)))),
      h("tbody", {}, table.rows.map((row) =>
        h("tr", {}, row.map((value, column) => h("td", cls(column), cellContent(value)))))),
    ),
  );
}

function figuresTable(spec: ChartSpec): HTMLElement[] {
  return [dataTable(spec.table, spec.title),
    ...(spec.moreTables ?? []).map((more) => dataTable(more.table, `${spec.title}: ${more.caption}`, more.caption))];
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function themeSelect(cfg: Config, selected: string, label: string, onChange: (theme: string) => void): HTMLElement {
  const select = h("select", {},
    cfg.themes.map((theme) => h("option", { value: theme, ...(theme === selected ? { selected: "" } : {}) }, theme)));
  select.addEventListener("change", () => onChange(select.value));
  return h("label", { class: "theme-choice" }, `${label} `, select);
}

/** Copy button: clipboard when the browser allows it, else selects the text for Ctrl+C / Cmd+C. */
function copyButton(target: HTMLElement, label: string): HTMLElement {
  const button = h("button", { type: "button", class: "copy-button" }, label);
  const status = h("span", { class: "copy-status", role: "status" });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(target.textContent ?? "");
      status.textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren(target);
      status.textContent = "Selected: press Ctrl+C or Cmd+C to copy";
    }
    setTimeout(() => { status.textContent = ""; }, COPIED_MESSAGE_MS);
  });
  return h("span", { class: "copy-control" }, button, status);
}

function citePanel(spec: ChartSpec, ctx: CardContext): HTMLElement {
  const text = h("p", { class: "cite-text" });
  const show = (theme: string): void => {
    const url = shareUrl(ctx.cfg, chartLink(spec.id, ctx.params, theme, "./"));
    text.textContent = citeText(ctx.cfg, spec.title, url, ctx.manifest, spec.source, spec.dataCredits);
  };
  show(ctx.params.theme);
  return h("div", { class: "chart-panel chart-cite" },
    text,
    h("div", { class: "panel-controls" },
      themeSelect(ctx.cfg, ctx.params.theme, "Theme in link", show),
      copyButton(text, "Copy citation"),
    ),
  );
}

function embedPanel(spec: ChartSpec, ctx: CardContext): HTMLElement {
  const code = h("code", {});
  const show = (theme: string): void => {
    const src = shareUrl(ctx.cfg, chartLink(spec.id, ctx.params, theme, "embed.html"));
    code.textContent = `<iframe src="${escapeAttribute(src)}" title="${escapeAttribute(`${spec.title} – ${ctx.cfg.siteName}`)}" ` +
      `width="100%" height="${ctx.cfg.embedHeight}" loading="lazy"></iframe>`;
  };
  const initial = ctx.cfg.themes.includes(ctx.cfg.embedTheme) ? ctx.cfg.embedTheme : ctx.params.theme;
  show(initial);
  return h("div", { class: "chart-panel chart-embed" },
    h("p", {}, "Paste this into a web page to show the chart with its source line:"),
    h("pre", { class: "embed-snippet" }, code),
    h("div", { class: "panel-controls" },
      themeSelect(ctx.cfg, initial, "Theme", show),
      copyButton(code, "Copy code"),
    ),
  );
}

/** Toolbar buttons that each open one panel (one open at a time). */
function tools(spec: ChartSpec, ctx: CardContext): HTMLElement {
  const id = `${ctx.idPrefix ?? ""}${spec.id}`;
  const panels = [
    { name: "figures", show: "Show figures", hide: "Hide figures", panel: h("div", { class: "chart-panel chart-figures" }, ...figuresTable(spec)) },
    { name: "cite", show: "Cite this", hide: "Cite this", panel: citePanel(spec, ctx) },
    { name: "embed", show: "Embed", hide: "Embed", panel: embedPanel(spec, ctx) },
  ];
  const buttons = panels.map(({ name, show, panel }) => {
    panel.id = `${id}-${name}`;
    panel.hidden = true;
    return h("button", { type: "button", class: "tool-button", "aria-expanded": "false", "aria-controls": panel.id }, show);
  });
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => {
      const opening = button.getAttribute("aria-expanded") !== "true";
      panels.forEach((entry, other) => {
        const open = opening && other === index;
        entry.panel.hidden = !open;
        buttons[other].setAttribute("aria-expanded", String(open));
        buttons[other].textContent = open ? entry.hide : entry.show;
      });
    });
  });
  return h("div", { class: "chart-tools" },
    h("div", { class: "chart-toolbar" }, buttons),
    panels.map((entry) => entry.panel),
  );
}

// print shows every card's sources and notes: open the closed ones for the print, close them again after (the stylesheet
// does the same where the browser supports ::details-content; this covers the rest)
const openedForPrint = new Set<HTMLDetailsElement>();
window.addEventListener("beforeprint", () => {
  for (const details of document.querySelectorAll<HTMLDetailsElement>("details.card-details:not([open])")) {
    details.open = true;
    openedForPrint.add(details);
  }
});
window.addEventListener("afterprint", () => {
  for (const details of openedForPrint) details.open = false;
  openedForPrint.clear();
});

function distinct<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** A WIPO statistics table (release, Data Center query), not a published list. */
const isTable = (src: CardSource): src is SourceBlock => !isListSource(src);

function queryLine(src: SourceBlock): HTMLElement {
  const words = [src.query, src.entity ? `entity: ${src.entity}` : null, `years ${src.years}`].filter(Boolean).join("; ");
  return h("p", { class: "chart-query" },
    "To reproduce: ", h("a", { href: src.url, rel: "noopener" }, DATA_CENTER), ", ", words, ".");
}

function labelChart(svg: SVGElement, titleId: string): void {
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-labelledby", titleId);
}

/** Swaps a rendered card's chart for a redraw (e.g. new width), keeping open panels and choices. */
export function replaceChart(el: HTMLElement, svg: SVGElement): void {
  const current = el.querySelector(".chart-figure > svg");
  if (!current) return;
  labelChart(svg, current.getAttribute("aria-labelledby") ?? "");
  current.replaceWith(svg);
}

/** The message of a card that needs the continents' display names (groups data) when they are missing (page and embed). */
export const CONTINENT_NAMES_PROBLEM = "The continent names could not be loaded.";

/** A card that cannot show its chart: the title and the reason in the card, never a silent gap in the grid. */
export function renderProblemCard(el: HTMLElement, id: string, title: string, message: string, idPrefix = ""): void {
  const titleId = `${idPrefix}${id}-title`;
  el.id = `${idPrefix}${id}`;
  el.dataset.chart = id;
  el.classList.add("card", "chart-card", "chart-card--problem");
  el.setAttribute("aria-labelledby", titleId);
  el.replaceChildren(h("h2", { id: titleId }, title), h("p", { class: "notice card-problem", role: "alert" }, message));
}

/** Link to `chart` on the overview: the theme kept (none when it is the default), nothing else of this page's address. */
function overviewLink(chart: string, ctx: CardContext): string {
  const theme = ctx.params.theme !== ctx.cfg.defaultTheme ? ctx.params.theme : undefined;
  return withParams({ ...PAGE_PARAMS, theme, chart }, "./");
}

export function renderChartCard(el: HTMLElement, spec: ChartSpec, ctx: CardContext): void {
  const titleId = `${ctx.idPrefix ?? ""}${spec.id}-title`;
  el.id = `${ctx.idPrefix ?? ""}${spec.id}`;
  el.dataset.chart = spec.id;
  el.classList.add("card", "chart-card");
  el.setAttribute("aria-labelledby", titleId);
  if (spec.visual instanceof SVGElement) labelChart(spec.visual, titleId);
  const sources = [spec.source].flat();
  const parts: Node[] = [h("h2", { id: titleId }, spec.title)];
  if (spec.note) parts.push(h("p", { class: "chart-note" }, spec.note));
  // compact (embed, wallboard slide): footnotes stay under the chart; a full card folds them into its details
  const footnotes = (spec.footnotes ?? []).map((line) => h("p", { class: "chart-footnote" }, line));
  parts.push(h("figure", { class: "chart-figure" },
    spec.visual,
    ctx.compact ? footnotes : [],
    h("figcaption", {}, distinct(sources.filter(isTable).map((src) => sourceLine(src, ctx.manifest)))
      .map((line) => h("p", { class: "source-line" }, line)),
      sources.filter(isListSource).map((src) => h("p", { class: "source-line" }, listSourceLine(src, ctx.manifest, ctx.compact))),
      [...(spec.credits ?? []), ...(spec.dataCredits ?? [])].map((line) => h("p", { class: "chart-credit" }, line))),
  ));
  if (ctx.compact) {
    // _blank: the card sits in a host page's iframe, which a link must not navigate away
    const fullPage = shareUrl(ctx.cfg, chartLink(spec.id, ctx.params, addressTheme(ctx.cfg), "./"));
    parts.push(h("p", { class: "chart-link" },
      h("a", { href: fullPage, target: "_blank", rel: "noopener" }, `Figures, citation and sources on ${ctx.cfg.siteName}`)));
  } else {
    const queries = new Map(sources.filter(isTable).map((src) => [`${src.query}|${src.entity}|${src.years}`, src]));
    const lines = [...footnotes, ...[...queries.values()].map(queryLine)];
    if (lines.length > 0) {
      parts.push(h("details", { class: "card-details", ...(ctx.openNotes ? { open: "" } : {}) },
        h("summary", {}, CARD_DETAILS_SUMMARY), lines));
    }
    parts.push(tools(spec, ctx));
    if (ctx.linkOverview) {
      parts.push(h("p", { class: "chart-link" }, h("a", { href: overviewLink(spec.overviewChart ?? spec.id, ctx) }, "Full chart on the overview")));
    }
  }
  el.replaceChildren(...parts);
}
