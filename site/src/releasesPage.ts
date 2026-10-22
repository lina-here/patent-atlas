// Data versions page (`?view=releases`): every published data version from data/releases.json, newest first, with the
// WIPO releases and WDI vintages behind it, what changed and the pipeline commit. Nothing is computed here.
import { loadJson, type Manifest, type Release } from "./data";
import type { Config } from "./data";
import { h } from "./dom";
import { GENDER_TITLES } from "./genderText";
import { SERIES_TITLES, TAB_TITLES, WORLD_TITLES } from "./methods";
import type { Params } from "./params";
import { RATIO_TITLES } from "./ratioText";
import { releaseLabel } from "./provenance";

/** `?view=` value of the page (params.ts VIEWS). */
export const RELEASES_VIEW = "releases";

export const NO_VERSIONS_TEXT = "No data versions recorded yet.";
const NOT_RECORDED = "not recorded";
const NO_VERSION_TEXT = "(entry without version)";

/** Labels of the ids pipeline/releases.py writes besides series, ratio and gender ids. */
const SPECIAL_LABELS: Record<string, string> = {
  all: "Everything (first version)",
  pct_monthly: "PCT monthly figures",
  method: "Methods text",
  entities: "List of countries and offices",
  groups: "Regions and continents",
  wipo_release: "WIPO release label",
  wdi: "World Bank WDI denominators",
  pipeline: "Pipeline code",
  pct_publications: "PCT publications (women inventors)",
  manifest: "Data manifest",
  overview: "Overview figures",
};

const LABELS: Record<string, string> = {
  ...SERIES_TITLES, ...WORLD_TITLES, ...RATIO_TITLES, ...GENDER_TITLES, ...SPECIAL_LABELS,
};

/** A changed id as a label; an id with no label (a file stem) is shown raw. */
export function changedLabel(id: string): string {
  return Object.hasOwn(LABELS, id) ? LABELS[id] : id;
}

/** `table[key]` when `key` is its own key (never an inherited one such as "constructor"), else `key`. */
function labelOf(table: Record<string, string>, key: string): string {
  return Object.hasOwn(table, key) ? table[key] : key;
}

/** WDI indicator key -> WDI's own indicator name (manifest.wdi_denominators, as the per-capita and per-GDP cards cite it);
 * a key the manifest does not name stays raw. */
function wdiLabel(manifest: Manifest, indicator: string): string {
  const denominators = (manifest.wdi_denominators ?? {}) as Record<string, { name?: unknown } | undefined>;
  const name = Object.hasOwn(denominators, indicator) ? denominators[indicator]?.name : undefined;
  return typeof name === "string" && name ? name : indicator;
}

/** First 7 hex digits; a "-dirty" mark (pipeline code not committed when the data were written) is kept. Any other
 * text is shown as given. */
export function shortCommit(sha: unknown): string {
  return typeof sha === "string" && sha ? sha.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1") : NOT_RECORDED;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** WIPO releases of one version: "Patent tab: May 2026; PCT tab: October 2026". */
function wipoText(release: Release): string {
  const entries = isRecord(release.wipo_releases) ? Object.entries(release.wipo_releases) : [];
  if (entries.length === 0) return NOT_RECORDED;
  return entries.map(([tab, text]) =>
    `${labelOf(TAB_TITLES, tab)}: ${releaseLabel(typeof text === "string" ? text : undefined)}`).join("; ");
}

/** WDI vintages of one version: "<WDI indicator name>: 2026-10-08; ..." (null = WDI gave none). */
function wdiText(release: Release, manifest: Manifest): string {
  const entries = isRecord(release.wdi_last_updated) ? Object.entries(release.wdi_last_updated) : [];
  if (entries.length === 0) return NOT_RECORDED;
  return entries.map(([indicator, date]) => `${wdiLabel(manifest, indicator)}: ${typeof date === "string" && date ? date : NOT_RECORDED}`).join("; ");
}

function row(release: Release, manifest: Manifest): HTMLElement {
  const version = typeof release.version === "string" && release.version ? release.version : null;
  const changed = Array.isArray(release.changed) ? release.changed.map(String) : [];
  return h("tr", version ? { "data-version": version } : {},
    h("th", { scope: "row" }, version ?? NO_VERSION_TEXT),
    h("td", {}, wipoText(release)),
    h("td", {}, wdiText(release, manifest)),
    h("td", {}, changed.length ? h("ul", { class: "release-changed" }, changed.map((id) => h("li", {}, changedLabel(id)))) : NOT_RECORDED),
    h("td", {}, h("code", {}, shortCommit(release.pipeline_sha))),
  );
}

/** The releases file as a list; null when it is missing, unreadable or empty. */
async function loadReleases(): Promise<Release[] | null> {
  try {
    const releases = await loadJson<unknown>("data/releases.json");
    const entries = Array.isArray(releases) ? releases.filter(isRecord) : [];
    return entries.length > 0 ? (entries as unknown as Release[]) : null;
  } catch (error) {
    console.warn(error); // detail for the console; the page shows the sentence
    return null;
  }
}

/** Renders the data versions page into `el`. */
export async function renderReleases(el: HTMLElement, ctx: { cfg: Config; manifest: Manifest; params: Params }): Promise<void> {
  document.title = `Data versions – ${ctx.cfg.siteName}`;
  const header = h("header", { class: "page-intro" },
    h("h1", {}, "Data versions"),
    h("p", { class: "lede" },
      "Each time the data, or the code or method that writes them, change, the data get a new version. Cite the version with a " +
      "figure: it names the WIPO Statistics Database releases and World Bank WDI vintages behind it, and the pipeline commit " +
      "that produced it. Each version is kept as the git tag data-<version> in the repository.",
      ctx.manifest.version ? ` The data on this site are version ${ctx.manifest.version}.` : ""));
  const releases = await loadReleases();
  if (!releases) {
    el.replaceChildren(header, h("p", { class: "notice releases-empty" }, NO_VERSIONS_TEXT));
    return;
  }
  el.replaceChildren(header,
    h("div", { class: "table-scroll" },
      h("table", { class: "data-table releases-table", "aria-label": "Data versions, newest first" },
        h("thead", {}, h("tr", {}, ["Version", "WIPO releases", "WDI vintages", "What changed", "Pipeline commit"].map((text) => h("th", { scope: "col" }, text)))),
        h("tbody", {}, releases.map((release) => row(release, ctx.manifest))))));
}
