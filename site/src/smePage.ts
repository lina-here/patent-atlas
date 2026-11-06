// SMEs and patents page (`?view=smes`) and the dashboard's SMEs panel. Every fact, figure, label, date and link is read
// from sme/policies.json (hand-curated from the offices' and WIPO's own pages; data.ts SmePolicies); nothing is typed
// here, and the only computed figures are the other-offices counts (data list lengths). Offices in data order, never
// ranked; the two share sources shown apart, never on one chart. Layout: a contents list (sidebar on wide screens), then
// the sections; all but who files and the IP5 fee table sit in boxes closed by default (boxes.ts, as on the methods page).
import {
  loadJson, type Config, type SmeFeeReduction, type SmeOffice, type SmeOtherOffice, type SmeOtherOffices, type SmeOtherReduction,
  type SmePct, type SmePctAuthority, type SmePctInternational, type SmePctNational, type SmePolicies, type SmeShare,
} from "./data";
import { listenForBoxes } from "./boxes";
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
/** Sources named on the methods page, which reads no data file; e2e smes.spec checks them against policies.json
 * (`other_offices.source_index_url`, `pct.pct_wide_sme.source_url`). */
export const PCT_GUIDE_URL = "https://www.wipo.int/en/web/pct-system/guide/index";
export const PCT_SCHEDULE_URL = "https://www.wipo.int/en/web/pct-system/texts/rules/rtax";
const PCT_TITLE = "Fee reductions along the PCT route";
/** Office cell of the PCT Schedule of Fees rows (fees paid to WIPO). */
const PCT_WIPO_OFFICE = "WIPO";
const OTHER_TITLE = "Other PCT offices";
const OTHER_TABLE_LABEL = "Fee reductions at other PCT offices";
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

/** Id of the contents list; every section ends with a link back to it. */
const TOC_ID = "sme-contents";

/** A page section: its title and body, then "Back to contents". With a `line`, the body sits in a box (methods page
 * pattern, closed by default): the summary holds the title and the line. */
function smeSection(id: string, title: string, line: string | null, body: Child[]): HTMLElement {
  const back = h("p", { class: "sme-back" }, h("a", { href: `#${TOC_ID}` }, "Back to contents"));
  if (line === null) return h("section", { id, class: "sme-section" }, h("h2", {}, title), body, back);
  return h("section", { id, class: "sme-section sme-boxed" },
    h("details", { class: "prose-box sme-box" },
      h("summary", {}, h("h2", { class: "box-title" }, title), h("span", { class: "box-line" }, line)),
      h("div", { class: "sme-box-body" }, body, back)));
}

function feesSection(offices: SmeOffice[]): HTMLElement {
  return smeSection("sme-fees", FEES_TITLE, null, [
    h("p", { class: "sme-intro" }, "The reduction is the share of the standard fee the applicant does not pay. Under it is what the office's page states; ",
      "where no single percentage applies, that text is all the row shows. Text from a Korean or Chinese page is shown as published, with its language named."),
    h("div", { class: "sme-fee-table-wrap" },
      h("table", { class: "data-table sme-fee-table", "aria-label": FEES_TITLE },
        h("thead", {}, h("tr", {}, FEE_HEADERS.map((text) => h("th", { scope: "col" }, text)))),
        offices.map(feeGroup))),
    feeCards(offices)]);
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
  return smeSection("sme-shares", "Who files", null, [
    h("p", { class: "sme-intro" }, "Each source counts different applications, so each is shown on its own."),
    h("div", { class: "sme-shares" }, shares.map(shareBlock))]);
}

/** Per office: a heading and its entries, or the stand-in when it has none. */
function perOffice(id: string, title: string, line: string, intro: string, offices: SmeOffice[], entries: (office: SmeOffice) => HTMLElement | null): HTMLElement {
  return smeSection(id, title, line, [
    h("p", { class: "sme-intro" }, intro),
    offices.map((office) => h("div", { class: "sme-office-block", "data-office": office.code },
      h("h3", {}, office.name),
      entries(office) ?? h("p", { class: "sme-empty" }, notCovered(office))))]);
}

function definitionsSection(offices: SmeOffice[]): HTMLElement {
  return perOffice("sme-definitions", "Who qualifies at each office", "Each IP5 office's own categories and definitions, with their sources.",
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
  return perOffice("sme-support", "Other support", "Help the IP5 offices list for smaller applicants, other than fee reductions.",
    "Other help each office lists for smaller applicants, beyond fee reductions.",
    offices, (office) => {
      const support = list(office.support);
      return support.length === 0 ? null : h("ul", { class: "sme-links" }, support.map((item) => h("li", {},
        h("a", { href: item.url, rel: "noopener" }, withLang(item.name)), h("span", { class: "sme-item-text" }, withLang(item.text)))));
    });
}

function resourcesSection(policies: SmePolicies): HTMLElement {
  return smeSection("sme-resources", "Resources for SMEs", "Guides and other publications for SMEs, each linked.", [
    h("ul", { class: "sme-links" }, list(policies.resources).map((item) => h("li", {},
      h("a", { href: item.url, rel: "noopener" }, item.title), ` (${item.publisher})`, h("span", { class: "sme-item-text" }, item.text))))]);
}

/** Percentage (when the data has one) and what the source states. */
function reductionWithText(reductionPct: number | null, published: string): Child[] {
  return [typeof reductionPct === "number" ? h("span", { class: "sme-pct" }, percent(reductionPct)) : null,
    h("span", { class: "sme-as-published", "data-published": "" }, withLang(published))];
}

/** Items grouped by `office`, in first-appearance order. */
function byOffice<T extends { office: string }>(items: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.office, [...(groups.get(item.office) ?? []), item]);
  return [...groups];
}

/** Whether the office's reduction applies on entry: data true / false / null (not confirmed). */
function entryStatus(value: boolean | null): string {
  return value === null ? "Not confirmed" : value ? "Applies on entry" : "Does not apply on entry";
}

/** PCT table columns; cards use the same labels. */
const PCT_HEADERS = ["Office", "Fee", "Reduction", "Who qualifies", "Source"];
const PCT_CELL_CLASSES = ["sme-fee-cell", "sme-reduction", "sme-qualifies", "sme-source"];
/** One row's cells after the office, built fresh for the table and again for its card. */
type PctRow = () => Child[][];

const secondLine = (className: string, text: string): HTMLElement => h("span", { class: className }, withLang(text));

function wipoRow(item: SmePctInternational): PctRow {
  return () => [
    [h("strong", {}, item.fee), secondLine("sme-set-in", `Set in: ${item.fee_table_or_item}`)],
    [item.reduction],
    [item.who_qualifies],
    [sourceLink(item.source_url), item.list_url ? [", ", h("a", { href: item.list_url, rel: "noopener" }, "list of eligible States")] : null],
  ];
}

function authorityRow(item: SmePctAuthority): PctRow {
  return () => [
    [h("strong", {}, `${item.role}: ${item.fee}`)],
    reductionWithText(item.reduction_pct, item.as_published),
    [h("strong", {}, withLang(item.category)), secondLine("sme-criteria-line", item.criteria)],
    [sourceLink(item.source_url)],
  ];
}

function nationalRow(item: SmePctNational): PctRow {
  return () => [
    [withLang(item.fees)],
    [h("strong", { class: "sme-entry-status" }, entryStatus(item.applies_on_entry)),
      typeof item.reduction_pct === "number" ? h("span", { class: "sme-pct" }, percent(item.reduction_pct)) : null],
    [h("strong", {}, withLang(item.category)), secondLine("sme-criteria-line", item.criteria)],
    [sourceLink(item.source_url)],
  ];
}

/** One phase: a table on wide screens (one row group per office), cards with labels on phones. */
function pctPhase(phase: string, title: string, intro: string, groups: [string, PctRow[]][]): HTMLElement {
  const headingId = `sme-pct-${phase}-title`;
  return h("div", { class: "sme-pct-phase", "data-phase": phase },
    h("h3", { id: headingId }, title),
    h("p", { class: "sme-intro" }, intro),
    h("div", { class: "sme-pct-table-wrap" },
      h("table", { class: "data-table sme-pct-table", "aria-labelledby": headingId },
        h("thead", {}, h("tr", {}, PCT_HEADERS.map((text) => h("th", { scope: "col" }, text)))),
        groups.map(([office, rows]) => h("tbody", { "data-office": office }, rows.map((row, index) => h("tr", {},
          index === 0 ? h("th", { scope: "rowgroup", rowspan: String(rows.length), class: "sme-office" }, office) : null,
          row().map((cell, at) => h("td", { class: PCT_CELL_CLASSES[at] }, cell)))))))),
    h("div", { class: "sme-pct-cards", "data-phase": phase }, groups.flatMap(([office, rows]) => rows.map((row) =>
      h("div", { class: "sme-pct-card", "data-office": office },
        h("dl", {}, [office, ...row()].map((value, index) => [h("dt", {}, PCT_HEADERS[index]), h("dd", {}, value)])))))));
}

function pctSection(pct: SmePct | undefined): HTMLElement | null {
  if (!pct) return null;
  const wide = pct.pct_wide_sme;
  const international = pctPhase("international", "International phase",
    "WIPO's reductions come from the PCT Schedule of Fees and are open to any applicant who meets the conditions. Each office sets its own fees " +
      "for the work it does: the international search (ISA), the supplementary search (SISA) or the international preliminary examination (IPEA). " +
      "RO is the receiving Office, where the application is filed.",
    [[PCT_WIPO_OFFICE, list(pct.pct_international).map(wipoRow)],
      ...byOffice(list(pct.isa_ipea)).map(([office, items]): [string, PctRow[]] => [office, items.map(authorityRow)])]);
  const national = pctPhase("national", "National or regional phase",
    "Whether each IP5 office's reduction applies when a PCT application enters the national or regional phase there.",
    byOffice(list(pct.national_phase)).map(([office, items]): [string, PctRow[]] => [office, items.map(nationalRow)]));
  return smeSection("sme-pct", PCT_TITLE, "WIPO's fees, search and examination fees, and whether each IP5 office's reduction applies on entry.", [
    h("p", { class: "sme-intro" }, "A PCT application goes through two phases. In the international phase the applicant pays WIPO's fees, the receiving Office's ",
      "transmittal fee and the fees of the office that searches and examines the application. In the national or regional phase the applicant pays ",
      "each office where it wants a patent."),
    international,
    wide ? h("p", { class: "sme-pct-wide" }, h("strong", {}, "SME reductions in the PCT itself: "), wide.status, " Source: ", sourceLink(wide.source_url),
      wide.wg_source_url ? [", ", h("a", { href: wide.wg_source_url, rel: "noopener" }, "PCT Working Group record")] : null, ".") : null,
    national]);
}

/** `not_assessed` key of the IP5 offices: its own sentence, not a reason. */
const IP5_EXCLUDED = "ip5_excluded";
/** Plain words after "<n> office(s)" for the other `not_assessed` reason keys; an unknown key reads "not assessed for another reason". */
const NOT_ASSESSED_LABELS: Record<string, string> = {
  guide_refers_to_office_or_not_by_applicant: "where the Guide refers applicants to the office, or the reduction does not depend on the type of applicant",
  no_national_fee_section: "with no national fee section in the Guide, mostly because there is no national route and patents go through a regional office",
};
/** `category_groups` keys counted as SME-type in the counts line; `data-count` key of that count. */
const SME_GROUPS = ["sme", "micro"];
const SME_COUNT = "sme";
/** Table headers; the reduction header is the IP5 table's. Cards use the short labels. */
const OTHER_HEADERS = ["Who qualifies", FEE_HEADERS[2], "Which fees", "Criteria", "Source"];
const OTHER_CARD_LABELS = ["Who qualifies", "Reduction", "Which fees", "Criteria", "Source"];
const OTHER_CELL_CLASSES = ["sme-qualifies", "sme-reduction", "sme-fees", "sme-criteria", "sme-source"];

const groupsOf = (office: SmeOtherOffice): Set<string> => new Set(list(office.fee_reductions).flatMap((fee) => list(fee.category_group)));
const count = (key: string, value: number): HTMLElement => h("span", { "data-count": key }, String(value));
const verb = (value: number, one: string, many: string): string => (value === 1 ? one : many);

/** Counts from the data's lists: offices with an SME-type group, with other groups only, with none listed, the IP5, not assessed per reason. */
function otherCounts(other: SmeOtherOffices): HTMLElement {
  const offices = list(other.offices);
  const withSme = offices.filter((office) => SME_GROUPS.some((key) => groupsOf(office).has(key))).length;
  const otherOnly = offices.length - withSme;
  const none = list(other.no_reduction_listed).length;
  const notAssessed = other.not_assessed ?? {};
  const ip5 = notAssessed[IP5_EXCLUDED];
  const reasons = Object.entries(notAssessed).filter(([key]) => key !== IP5_EXCLUDED);
  return h("p", { class: "sme-other-counts" },
    count(SME_COUNT, withSme), ` ${verb(withSme, "office lists", "offices list")} a reduction for SMEs, small entities or micro-entities. `,
    count("other", otherOnly), ` ${verb(otherOnly, "office lists", "offices list")} reductions only for other applicants, such as individual inventors or universities. `,
    "For ", count("none", none), ` ${verb(none, "office", "offices")} the Guide lists no reduction by type of applicant.`,
    ip5 ? [" The ", count(IP5_EXCLUDED, list(ip5).length), " IP5 offices are covered above."] : null,
    reasons.length ? [" Not assessed: ", reasons.map(([key, codes], index) => {
      const value = list(codes).length;
      return [index ? "; " : "", count(key, value), ` ${verb(value, "office", "offices")} `, NOT_ASSESSED_LABELS[key] ?? "not assessed for another reason"];
    }), "."] : null);
}

function otherWho(fee: SmeOtherReduction, groups: Record<string, string>): Child[] {
  return [h("strong", {}, withLang(fee.category)),
    h("span", { class: "sme-group-tags" }, "Shown under: ", list(fee.category_group).map((key) => groups[key] ?? key).join("; "))];
}

function otherValues(fee: SmeOtherReduction, groups: Record<string, string>): Child[][] {
  return [otherWho(fee, groups), reductionWithText(fee.reduction_pct, fee.as_published), [withLang(fee.fees)], [withLang(fee.criteria)], [sourceLink(fee.source_url)]];
}

function otherSupport(office: SmeOtherOffice): HTMLElement | null {
  const support = list(office.support);
  return support.length === 0 ? null : h("div", { class: "sme-other-support" }, "Other support: ",
    h("ul", { class: "sme-links" }, support.map((item) => h("li", {},
      h("a", { href: item.url, rel: "noopener" }, withLang(item.name)), h("span", { class: "sme-item-text" }, withLang(item.text))))));
}

const officeHead = (office: SmeOtherOffice): Child[] =>
  [h("strong", {}, office.name), h("span", { class: "sme-guide-updated" }, `Guide updated ${office.guide_updated}`)];

function otherTable(offices: SmeOtherOffice[], groups: Record<string, string>): HTMLElement {
  return h("div", { class: "sme-other-table-wrap" },
    h("table", { class: "data-table sme-other-table", "aria-label": OTHER_TABLE_LABEL },
      h("thead", {}, h("tr", {}, OTHER_HEADERS.map((text) => h("th", { scope: "col" }, text)))),
      offices.map((office) => {
        const support = otherSupport(office);
        return h("tbody", { "data-office": office.code },
          h("tr", { class: "sme-other-head" }, h("th", { scope: "rowgroup", colspan: String(OTHER_HEADERS.length), class: "sme-office" }, officeHead(office))),
          list(office.fee_reductions).map((fee) => h("tr", { class: "sme-other-row", "data-groups": list(fee.category_group).join(" ") },
            otherValues(fee, groups).map((value, index) => h("td", { class: OTHER_CELL_CLASSES[index] }, value)))),
          support ? h("tr", { class: "sme-other-support-row" }, h("td", { colspan: String(OTHER_HEADERS.length) }, support)) : null);
      })));
}

/** Phone layout: one block per office, one card per reduction (CSS shows these below its breakpoint). */
function otherCards(offices: SmeOtherOffice[], groups: Record<string, string>): HTMLElement {
  return h("div", { class: "sme-other-cards" }, offices.map((office) => h("div", { class: "sme-other-card-office", "data-office": office.code },
    h("h3", { class: "sme-other-card-title" }, officeHead(office)),
    list(office.fee_reductions).map((fee) => h("div", { class: "sme-other-card", "data-groups": list(fee.category_group).join(" ") },
      h("dl", {}, otherValues(fee, groups).map((value, index) => [h("dt", {}, OTHER_CARD_LABELS[index]), h("dd", {}, value)])))),
    otherSupport(office))));
}

/** Shows rows (and cards) with at least one ticked group; an office without one is hidden whole. The status names the
 * offices shown and the rows hidden inside them; nothing ticked -> a hint. */
function applyFilter(section: HTMLElement, status: HTMLElement, total: number): void {
  const ticked = new Set([...section.querySelectorAll<HTMLInputElement>(".sme-filter input:checked")].map((box) => box.value));
  const matches = (item: Element) => (item.getAttribute("data-groups") ?? "").split(" ").some((key) => ticked.has(key));
  for (const item of section.querySelectorAll<HTMLElement>(".sme-other-row, .sme-other-card")) item.hidden = !matches(item);
  let shown = 0;
  let hiddenRows = 0;
  for (const group of section.querySelectorAll<HTMLElement>(".sme-other-table tbody")) {
    group.hidden = !group.querySelector(".sme-other-row:not([hidden])");
    if (group.hidden) continue;
    shown += 1;
    hiddenRows += group.querySelectorAll(".sme-other-row[hidden]").length;
  }
  for (const block of section.querySelectorAll<HTMLElement>(".sme-other-card-office")) block.hidden = !block.querySelector(".sme-other-card:not([hidden])");
  if (ticked.size === 0) {
    status.textContent = "Tick at least one group to see offices.";
    return;
  }
  status.textContent = `Showing ${shown} of ${total} offices` +
    (hiddenRows ? `, with ${hiddenRows} ${verb(hiddenRows, "row", "rows")} hidden that ${verb(hiddenRows, "matches", "match")} no ticked group.` : ".");
}

function otherSection(policies: SmePolicies): HTMLElement | null {
  const other = policies.other_offices;
  if (!other) return null;
  const groups = policies.category_groups ?? {};
  const offices = list(other.offices);
  const status = h("p", { class: "sme-filter-status", "aria-live": "polite" });
  const filter = h("fieldset", { class: "sme-filter" },
    h("legend", {}, "Show reductions for"),
    Object.entries(groups).map(([key, label]) => {
      const box = h("input", { type: "checkbox", value: key });
      box.checked = true;
      return h("label", {}, box, " ", label);
    }));
  const section = smeSection("sme-other", OTHER_TITLE, "Fee reductions at PCT offices outside the IP5, with a filter by type of applicant.", [
    h("p", { class: "sme-intro" }, "Fee reductions by type of applicant at PCT offices outside the IP5, mostly from the national chapters of the ",
      h("a", { href: other.source_index_url, rel: "noopener" }, "PCT Applicant's Guide"),
      ". These are national or regional phase fees. Each row links its source, and the criteria note any limits, such as a reduction only for ",
      "applications first filed in that country."),
    otherCounts(other),
    filter, status,
    otherTable(offices, groups),
    otherCards(offices, groups)]);
  filter.addEventListener("change", () => applyFilter(section, status, offices.length));
  applyFilter(section, status, offices.length);
  return section;
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
      "What patent offices offer small and medium-sized enterprises (SMEs) and individual inventors, from fee reductions along the PCT route to ",
      "other support, with published figures on who files patent applications; each office defines SMEs its own way. ",
      offices.length ? `IP5 is the forum in which the five largest intellectual property offices work together: ${joinNames(offices.map((office) => office.short))}. ` : "",
      policies ? `Every fact links to the page it comes from; all were checked on ${policies.checked_on}.` : ""));
  if (!policies) {
    el.replaceChildren(header, h("p", { class: "notice sme-missing" }, `The SMEs data could not be loaded: ${(loaded as Error).message}`));
    return;
  }
  const methodsLink = `${pageLink(ctx.cfg, ctx.params, "methods.html")}#smes`;
  const sections = [
    sharesSection(list(policies.shares)),
    pctSection(policies.pct),
    feesSection(offices),
    definitionsSection(offices),
    supportSection(offices),
    otherSection(policies),
    resourcesSection(policies),
  ].filter((section): section is HTMLElement => section !== null);
  const contents = h("nav", { class: "toc sme-toc", id: TOC_ID, "aria-label": "On this page" },
    h("p", { class: "toc-title", "aria-hidden": "true" }, "On this page"),
    h("ul", {}, sections.map((section) => h("li", {}, h("a", { href: `#${section.id}` }, section.querySelector("h2")?.textContent ?? section.id)))));
  el.replaceChildren(header,
    h("div", { class: "sme-layout" },
      contents,
      h("div", { class: "sme-page" },
        sections,
        h("p", { class: "sme-checked" },
          `Fees and rules change, so the office's own page is the reference. Everything here was checked on ${policies.checked_on}. `,
          "Sources and method: ", h("a", { href: methodsLink }, "SMEs and patents on the methods page"), "."))));
  listenForBoxes(el);
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
