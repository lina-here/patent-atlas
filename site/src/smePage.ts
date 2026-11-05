// SMEs and patents page (`?view=smes`) and the dashboard's SMEs panel. Every fact, figure, label, date and link is read
// from sme/policies.json (hand-curated from the offices' and WIPO's own pages; data.ts SmePolicies); nothing is computed
// or typed here. Offices in data order, never ranked; the two share sources shown apart, never on one chart.
import { loadJson, type Config, type SmeFeeReduction, type SmeOffice, type SmePolicies, type SmeShare } from "./data";
import { h, type Child } from "./dom";
import { pageLink, viewLink, type Params } from "./params";

/** `?view=` value of the page (params.ts VIEWS). */
export const SME_VIEW = "smes";
const POLICIES_PATH = "sme/policies.json";
/** The dashboard panel's figure: this row of this share (EPO, applications by applicant category). */
export const SME_TILE_SHARE = "epo_applicant_category";
export const SME_TILE_ROW = "Individual inventors and SMEs";
export const SME_TITLE = "SMEs and patents";
const FEES_TITLE = "Fee reductions for SMEs at the IP5 offices";
const COMPARE_TEXT = "Compare SME fee reductions at the IP5 offices";
/** Visible marker for `as_published_lang` (the English `category` and `fees` carry the meaning). */
const LANGUAGE_NAMES: Record<string, string> = { ko: "Korean", zh: "Chinese" };
const FEE_HEADERS = ["Office", "Who qualifies", "Reduction (percent off the standard fee)", "Which fees", "Source"];
/** Card labels on phones (the table's headers, shorter). */
const CARD_LABELS = ["Office", "Who qualifies", "Reduction", "Which fees", "Source"];

type SmeContext = { cfg: Config; params: Params };

const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
/** Percent exactly as the data holds it (66.7 stays 66.7). */
const percent = (value: number): string => `${value}%`;
const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};
const sourceLink = (url: string): HTMLElement => h("a", { href: url, rel: "noopener" }, hostOf(url));

/** Runs of Hangul (ko) or Han (zh), spaces, digits and punctuation between them included. */
const SCRIPT_RUN = /[\uAC00-\uD7AF\u1100-\u11FF\u3400-\u4DBF\u4E00-\u9FFF]+(?:[\s\d,.·]+[\uAC00-\uD7AF\u1100-\u11FF\u3400-\u4DBF\u4E00-\u9FFF]+)*/g;
const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/;

/** Text with each Korean or Chinese run in a `lang` span (markup only, text unchanged), so a screen reader switches voice. */
function withLang(text: string): Child[] {
  const parts: Child[] = [];
  let last = 0;
  for (const match of text.matchAll(SCRIPT_RUN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(h("span", { lang: HANGUL.test(match[0]) ? "ko" : "zh" }, match[0]));
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** The policies file; an Error when it cannot be loaded (the page and panel then say why). */
export async function loadPolicies(): Promise<SmePolicies | Error> {
  try {
    return await loadJson<SmePolicies>(POLICIES_PATH);
  } catch (error) {
    console.warn(error); // detail for the console; the page shows the sentence
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The office's own page for "see its website": its first linked page. */
function officeUrl(office: SmeOffice): string | undefined {
  return list(office.definitions)[0]?.source_url ?? list(office.fee_reductions)[0]?.source_url ?? list(office.support)[0]?.url;
}

/** Stand-in for an empty list: never a blank, which would read as "this office offers nothing". */
function notCovered(office: SmeOffice): Child[] {
  const url = officeUrl(office);
  return ["Not covered in this version; see ", url ? h("a", { href: url, rel: "noopener" }, `${office.short}'s website`) : `${office.short}'s website`, "."];
}

function officeCell(office: SmeOffice): Child[] {
  return [h("strong", {}, office.short), h("span", { class: "sme-office-name" }, office.name)];
}

/** Category and its definition (exact `category` match), else a link to the row's source. */
function qualifiesCell(office: SmeOffice, fee: SmeFeeReduction): Child[] {
  const definition = list(office.definitions).find((item) => item.category === fee.category);
  return [h("strong", {}, withLang(fee.category)),
    definition ? h("span", { class: "sme-definition" }, withLang(definition.text))
      : h("span", { class: "sme-definition" }, h("a", { href: fee.source_url, rel: "noopener" }, "See source"))];
}

function reductionCell(fee: SmeFeeReduction): Child[] {
  const lang = fee.as_published_lang;
  const language = lang ? LANGUAGE_NAMES[lang] ?? lang : null;
  return [
    typeof fee.reduction_pct === "number" ? h("span", { class: "sme-pct" }, percent(fee.reduction_pct)) : null,
    h("span", { class: "sme-as-published" },
      h("span", { "data-published": "", ...(lang ? { lang } : {}) }, fee.as_published),
      language ? ` (${language})` : null),
  ];
}

function feesCell(fee: SmeFeeReduction): Child[] {
  return [withLang(fee.fees), fee.since ? h("span", { class: "sme-since" }, `Since ${fee.since}`) : null];
}

/** One row group per office: its name heads every row of the group (`th scope=rowgroup`). */
function feeGroup(office: SmeOffice): HTMLElement {
  const fees = list(office.fee_reductions);
  const head = (span: number) => h("th", { scope: "rowgroup", rowspan: String(span), class: "sme-office" }, officeCell(office));
  if (fees.length === 0) {
    return h("tbody", { "data-office": office.code }, h("tr", {}, head(1), h("td", { colspan: "4", class: "sme-empty" }, notCovered(office))));
  }
  return h("tbody", { "data-office": office.code }, fees.map((fee, index) => h("tr", {},
    index === 0 ? head(fees.length) : null,
    h("td", { class: "sme-qualifies" }, qualifiesCell(office, fee)),
    h("td", { class: "sme-reduction" }, reductionCell(fee)),
    h("td", { class: "sme-fees" }, feesCell(fee)),
    h("td", { class: "sme-source" }, sourceLink(fee.source_url)))));
}

/** Phone layout: one card per row, labels visible (CSS shows these below its breakpoint, the table above it). */
function feeCards(offices: SmeOffice[]): HTMLElement {
  const card = (office: SmeOffice, entries: [string, Child[]][]) => h("div", { class: "sme-fee-card", "data-office": office.code },
    h("dl", {}, entries.map(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])));
  return h("div", { class: "sme-fee-cards" }, offices.flatMap((office) => {
    const fees = list(office.fee_reductions);
    if (fees.length === 0) return [card(office, [[CARD_LABELS[0], officeCell(office)], ["Fee reductions", notCovered(office)]])];
    return fees.map((fee) => card(office, [officeCell(office), qualifiesCell(office, fee), reductionCell(fee), feesCell(fee), [sourceLink(fee.source_url)]]
      .map((value, index): [string, Child[]] => [CARD_LABELS[index], value])));
  }));
}

function feesSection(offices: SmeOffice[]): HTMLElement {
  return h("section", { id: "sme-fees", class: "sme-section" },
    h("h2", {}, FEES_TITLE),
    h("p", {}, "The reduction is the share of the standard fee the applicant does not pay. Under it is what the office's page states; ",
      "where no single percentage applies, that text is all the row shows. Text from a Korean or Chinese page is shown as published, with its language named."),
    h("div", { class: "sme-fee-table-wrap" },
      h("table", { class: "data-table sme-fee-table", "aria-label": FEES_TITLE },
        h("thead", {}, h("tr", {}, FEE_HEADERS.map((text) => h("th", { scope: "col" }, text)))),
        offices.map(feeGroup))),
    feeCards(offices));
}

function shareBlock(share: SmeShare): HTMLElement {
  return h("div", { class: "card sme-share", "data-share": share.id },
    h("table", { class: "data-table sme-share-table" },
      h("caption", {}, `${share.scope} (${share.year})`),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Applicants"), h("th", { scope: "col", class: "num" }, "Share of applications"))),
      h("tbody", {}, list(share.rows).map((row) => {
        const fill = h("span", { class: "sme-bar-fill" });
        fill.style.width = percent(row.pct);
        return h("tr", {},
          h("th", { scope: "row" }, row.label),
          h("td", { class: "sme-share-cell" },
            h("span", { class: "sme-share-value" }, percent(row.pct)),
            h("span", { class: "sme-bar", "aria-hidden": "true" }, fill)));
      }))),
    share.note ? h("p", { class: "sme-share-note" }, share.note) : null,
    h("p", { class: "source-line sme-share-source" }, "Source: ", h("a", { href: share.url, rel: "noopener" }, share.citation), `, ${share.page}.`));
}

function sharesSection(shares: SmeShare[]): HTMLElement {
  return h("section", { id: "sme-shares", class: "sme-section" },
    h("h2", {}, "Who files"),
    h("p", {}, "Each source counts different applications, so each is shown on its own."),
    h("div", { class: "sme-shares" }, shares.map(shareBlock)));
}

/** Per office: a heading and its entries, or the stand-in when it has none. */
function perOffice(id: string, title: string, intro: string, offices: SmeOffice[], entries: (office: SmeOffice) => HTMLElement | null): HTMLElement {
  return h("section", { id, class: "sme-section" },
    h("h2", {}, title),
    h("p", {}, intro),
    offices.map((office) => h("div", { class: "sme-office-block", "data-office": office.code },
      h("h3", {}, office.name),
      entries(office) ?? h("p", { class: "sme-empty" }, notCovered(office)))));
}

function definitionsSection(offices: SmeOffice[]): HTMLElement {
  return perOffice("sme-definitions", "Who qualifies at each office",
    "Summarised from each office's own pages. The definitions differ between offices, so no single definition of an SME applies.",
    offices, (office) => {
      const definitions = list(office.definitions);
      return definitions.length === 0 ? null : h("dl", { class: "sme-definitions" }, definitions.flatMap((item) => [
        h("dt", {}, withLang(item.category)),
        h("dd", {}, withLang(item.text), " ", h("span", { class: "sme-cite" }, "Source: ", sourceLink(item.source_url))),
      ]));
    });
}

function supportSection(offices: SmeOffice[]): HTMLElement {
  return perOffice("sme-support", "Other support", "Other help each office lists for smaller applicants, beyond fee reductions.",
    offices, (office) => {
      const support = list(office.support);
      return support.length === 0 ? null : h("ul", { class: "sme-links" }, support.map((item) => h("li", {},
        h("a", { href: item.url, rel: "noopener" }, withLang(item.name)), h("span", { class: "sme-item-text" }, withLang(item.text)))));
    });
}

function resourcesSection(policies: SmePolicies): HTMLElement {
  return h("section", { id: "sme-resources", class: "sme-section" },
    h("h2", {}, "Resources for SMEs"),
    h("ul", { class: "sme-links" }, list(policies.resources).map((item) => h("li", {},
      h("a", { href: item.url, rel: "noopener" }, item.title), ` (${item.publisher})`, h("span", { class: "sme-item-text" }, item.text)))));
}

/** "A, B, C and D" */
function joinNames(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Renders the SMEs page into `el`. */
export async function renderSmePage(el: HTMLElement, ctx: SmeContext): Promise<void> {
  document.title = `${SME_TITLE} – ${ctx.cfg.siteName}`;
  const loaded = await loadPolicies();
  const policies = loaded instanceof Error ? null : loaded;
  const offices = list(policies?.offices);
  const header = h("header", { class: "page-intro" },
    h("h1", {}, SME_TITLE),
    h("p", { class: "lede" },
      "What the IP5 offices offer small and medium-sized enterprises (SMEs) and individual inventors: fee reductions, other support and ",
      "resources, with published figures on who files patent applications. ",
      offices.length ? `IP5 is the forum in which the five largest intellectual property offices work together: ${joinNames(offices.map((office) => office.short))}. ` : "",
      "Each office defines SMEs its own way, so the page shows each office's own categories and definitions.",
      policies ? ` Every fact links to the office's or WIPO's page it comes from; all were checked on ${policies.checked_on}.` : ""));
  if (!policies) {
    el.replaceChildren(header, h("p", { class: "notice sme-missing" }, `The SMEs data could not be loaded: ${(loaded as Error).message}`));
    return;
  }
  const methodsLink = `${pageLink(ctx.cfg, ctx.params, "methods.html")}#smes`;
  el.replaceChildren(header,
    h("div", { class: "sme-page" },
      sharesSection(list(policies.shares)),
      feesSection(offices),
      definitionsSection(offices),
      supportSection(offices),
      resourcesSection(policies),
      h("p", { class: "sme-checked" },
        `Fees and rules change, so the office's own page is the reference. Everything here was checked on ${policies.checked_on}. `,
        "Sources and method: ", h("a", { href: methodsLink }, "SMEs and patents on the methods page"), ".")));
}

/** The dashboard's SMEs panel (its own row, not a chart card): the EPO share row with its scope, year and source, and a
 * link to the page. Filled when the file loads; a load failure reads "–" with its reason, the other tiles unaffected. */
export function smePanel(cfg: Config, params: Params): { element: HTMLElement; ready: Promise<void> } {
  const figure = h("dl", { class: "tiles key-figures" });
  const details = h("div", { class: "sme-tile-details" });
  const element = h("section", { class: "card dashboard-sme", "aria-labelledby": "dashboard-sme-title" },
    h("h2", { id: "dashboard-sme-title" }, SME_TITLE),
    figure, details,
    h("p", { class: "chart-link sme-tile-link" }, h("a", { href: viewLink(cfg, params, SME_VIEW) }, COMPARE_TEXT)));
  const tile = (label: string, value: string, reason?: string) => h("div", { class: "tile", "data-figure": "sme-share" },
    h("dt", { class: "tile-label" }, label), h("dd", { class: "tile-value" }, value), reason ? h("dd", { class: "tile-reason" }, reason) : null);
  const ready = loadPolicies().then((loaded) => {
    if (loaded instanceof Error) {
      figure.replaceChildren(tile(SME_TILE_ROW, "–", `The SMEs data could not be loaded: ${loaded.message}`));
      return;
    }
    const share = list(loaded.shares).find((item) => item.id === SME_TILE_SHARE);
    const row = share && list(share.rows).find((item) => item.label === SME_TILE_ROW);
    if (!share || !row) {
      figure.replaceChildren(tile(SME_TILE_ROW, "–", "This figure is not in the SMEs data."));
      return;
    }
    figure.replaceChildren(tile(row.label, percent(row.pct)));
    details.replaceChildren(
      h("p", { class: "chart-note sme-tile-scope" }, `${share.scope} (${share.year})`),
      h("p", { class: "source-line sme-tile-source" }, "Source: ", h("a", { href: share.url, rel: "noopener" }, share.citation), "."));
  });
  return { element, ready };
}
