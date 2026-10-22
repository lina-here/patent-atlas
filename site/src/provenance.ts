// Source lines, citation text and the footer: provenance shown in every theme.
import type { Config, Manifest, SourceBlock } from "./data";
import { h } from "./dom";
import { pageLink, viewLink, type Params } from "./params";

/** How the site was made, verbatim (Lina, 2026-10-21): shown on the methods page. */
export const AI_METHODS_LINE = "Built with the help of AI coding tools. No AI runs on this site or produces its figures; every figure comes from WIPO or the World Bank and is checked against WIPO's published values.";

// WIPO terms of use: verbatim on every derived work.
export const DISCLAIMER =
  "The Secretariat of WIPO assumes no liability or responsibility with regard to the transformation or translation of the original content.";

const RELEASE_PREFIX = /^Last updated:\s*/i;

/** "Last updated: May 2026" -> "May 2026". Any other wording is shown whole, never cut. */
export function releaseLabel(release: string | undefined): string {
  if (!release) return "not recorded";
  const label = release.replace(RELEASE_PREFIX, "").trim();
  return label || release;
}

/** ", data version 2026-10-21"; empty when the manifest names none (never "undefined"). */
function versionSuffix(m: Manifest): string {
  return typeof m.version === "string" && m.version ? `, data version ${m.version}` : "";
}

export function sourceLine(src: SourceBlock, m: Manifest): string {
  return `Source: ${src.name} (release ${releaseLabel(m.releases[src.tab])}, retrieved ${m.retrieved}${versionSuffix(m)}); analysis: Patent Atlas`;
}

/** APA-like plain text, naming the data version when the manifest has one. Year = retrieval year (the data snapshot the chart shows). Several sources (a card
 * mixing patent and PCT figures): each distinct source and release named once. `dataCredits`: other data sources'
 * credit lines (World Bank WDI, CC BY 4.0: attribution travels with the copied citation), each one sentence after. */
export function citeText(cfg: Config, chartTitle: string, url: string, m: Manifest, src: SourceBlock | SourceBlock[],
  dataCredits: string[] = []): string {
  const year = m.retrieved.slice(0, 4);
  const data = [...new Set([src].flat().map((block) => `${block.name}, ${releaseLabel(m.releases[block.tab])}`))].join("; ");
  return `${cfg.author} (${year}). ${chartTitle}. ${cfg.siteName}. ${url}. Data: ${data}, retrieved ${m.retrieved}${versionSuffix(m)}.` +
    dataCredits.map((line) => ` ${line}.`).join("");
}

/** Without `cfg` (config.json failed to load) the byline names nobody and the links carry no theme; the
 * disclaimer always shows. */
export function renderFooter(el: HTMLElement, cfg?: Config, params?: Params): void {
  el.replaceChildren(
    h("div", { class: "footer-byline" },
      h("p", {}, cfg ? [h("strong", {}, cfg.siteName), ` by ${cfg.author}. `] : null,
        "Independent analysis; not affiliated with or endorsed by WIPO."),
      h("nav", { class: "footer-links", "aria-label": "About this site" },
        h("a", { href: pageLink(cfg, params, "about.html") }, "About and citing"),
        h("a", { href: pageLink(cfg, params, "methods.html") }, "Methods and sources"),
        h("a", { href: viewLink(cfg, params, "releases") }, "Data versions"),
        h("a", { href: viewLink(cfg, params, "wallboard") }, "Conference wallboard"),
      ),
    ),
    h("p", { class: "disclaimer" }, DISCLAIMER),
  );
}
