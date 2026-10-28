// Methods page: static explanations + every number read from manifest.json, overview.json and
// entity/CH.json (no figure typed into the page). Formulas restate pipeline/derive.py in words.
import type { GroupNullReason, GroupsFile } from "./atlas";
import type { Config, Entities, EntityFile, EntityKind, GenderMeasure, Manifest, Overview, RatioCheck, RatioDenominator, RatioMethod, SeriesId, SourceBlock, WipoRatioId, WorldId } from "./data";
import { h, formatCount, type Child } from "./dom";
import { fixedHalfAway, fixedPercent } from "./format";
import { GENDER_BASIS_LABEL, GENDER_TITLES, coverageFloorText, formatShare, genderCaveat, genderDecimals, genderNullText, unlistedMembersText } from "./genderText";
import { PCT_UNLISTED_ORIGIN_GROUPS, nullReasonText, wipoTotalCounts, wipoTotalGapCause } from "./groupText";
import { MAP_CREDIT, MAP_DISCLAIMER, MAP_STATE_LABELS, binLabel, continuingText, groupPageTarget, labelOfEntities, membershipNullText } from "./map";
import { mapScale } from "./mapScale";
import { isPauseMovePixels, isRotationSeconds, viewLink, type Params } from "./params";
import { AI_METHODS_LINE, DISCLAIMER, sourceLine } from "./provenance";
import { BOARD_CONTRAST_COLOURS, BOARD_ESCAPE_NOTE, BOARD_MIN_CONTRAST, boardFacts, keyTableRows } from "./wallboard";
import { RATIO_BASIS_LABEL, RATIO_TITLES, amountWords, decimalsWords, gdpBasisLabel, ratioNullText, thresholdWords, wdiCredit } from "./ratioText";

export const SERIES_TITLES: Record<SeriesId, string> = {
  origin_apps: "Patent applications by applicant's origin",
  office_apps: "Patent applications by filing office",
  pct_origin: "PCT applications by applicant's origin",
};

/** What each series' rank is computed among (pipeline/write.py `is_ranked`: entities classified country, per
 * series and year, non-null values only): origin series rank countries of origin, office series national
 * offices. Regional offices, former states and groups are never ranked. */
export const RANK_BASIS: Record<SeriesId, string> = {
  origin_apps: "countries of origin",
  office_apps: "national offices",
  pct_origin: "countries of origin",
};

export const WORLD_TITLES: Record<WorldId, string> = {
  world_office: "Patent applications worldwide",
  pct_world: "PCT applications worldwide",
};

/** Late-filing caveat wherever the newest PCT year shows (overview PCT card, country PCT card and tiles,
 * Revisions below): a "complete" PCT year still grows as late filings are processed. */
export const PCT_LATE_FILINGS = "Recent PCT years still rise as late filings are processed.";

/** Note on every overview card that counts by origin: WIPO's by-origin data hold almost no "Abroad" filings before
 * `method.origin_abroad_from` (pipeline/groups.py ORIGIN_ABROAD_FROM); the year is read from overview.json. */
export function originAbroadNote(overview: Overview): string {
  return `Before ${overview.method.origin_abroad_from}, WIPO's by-origin data hold almost no filings abroad: ` +
    "origin “Abroad” is near-empty, so earlier origin figures are not comparable with later ones.";
}

export const TAB_TITLES = { ips: "Patent tab", pmh: "PCT tab" } as const;

/** Source of the map geometry (site/geo/points.json `sources`, written by scripts/build_geo.py). */
export type GeoSource = { name: string; url: string; licence: string; method?: string };

export type MethodsData = {
  cfg: Config; params: Params; manifest: Manifest; overview: Overview; entities: Entities; swiss: EntityFile | null;
  groups: GroupsFile; geoSources: GeoSource[];
};

type Section = { id: string; title: string; body: Child[] };

/** Ratio as a percentage; null -> "–" (never 0). */
function percent(ratio: number | null, decimals: number): string {
  return ratio === null ? "–" : `${fixedPercent(ratio, decimals)}%`;
}

function list(items: string[], empty: string): HTMLElement {
  if (items.length === 0) return h("p", { class: "muted" }, empty);
  return h("ul", { class: "check-lines" }, items.map((item) => h("li", {}, h("code", {}, item))));
}

function labelsOf(entities: Entities, kind: EntityKind): string {
  return entities.filter((entity) => entity.kind === kind).map((entity) => entity.label).join(", ");
}

/** First 12 hex digits; a "-dirty" mark (pipeline code not committed when the data were written) is kept. */
function shortSha(sha: string): string {
  return sha.replace(/^([0-9a-f]{12})[0-9a-f]*/, "$1");
}

function decimals(count: number): string {
  return `${count} ${count === 1 ? "decimal" : "decimals"}`;
}

/** Series with a source block in the overview, in display order (origin, office, PCT). */
export function presentSources(overview: Overview): [SeriesId, SourceBlock][] {
  return (Object.keys(SERIES_TITLES) as SeriesId[]).flatMap((id) => {
    const src = overview.sources[id];
    return src ? [[id, src] as [SeriesId, SourceBlock]] : [];
  });
}

function sourcesSection({ cfg, params, manifest, overview }: MethodsData): Section {
  const sources = presentSources(overview);
  const dataCenterUrl = sources.length ? sources[0][1].url : null;
  const dataCenter = "WIPO IP Statistics Data Center";
  return {
    id: "sources",
    title: "Sources",
    body: [
      h("p", {}, "All figures come from the ",
        dataCenterUrl ? h("a", { href: dataCenterUrl, rel: "noopener" }, dataCenter) : dataCenter,
        " (WIPO Statistics Database). Patent Atlas computes growth, shares, ranks and world comparisons from them. ",
        "Patent and PCT statistics are released on different cycles, so each carries its own release date."),
      h("dl", { class: "facts" },
        (Object.keys(manifest.releases) as (keyof typeof TAB_TITLES)[]).map((tab) => [
          h("dt", {}, `${TAB_TITLES[tab] ?? tab} release`), h("dd", {}, manifest.releases[tab]),
        ]),
        h("dt", {}, "Retrieved"), h("dd", {}, `${manifest.retrieved} (UTC)`),
        manifest.version ? [h("dt", {}, "Data version"), h("dd", {}, manifest.version, " (",
          h("a", { href: viewLink(cfg, params, "releases") }, "all data versions"), ")")] : null,
        h("dt", {}, "Pipeline version"), h("dd", {}, h("code", {}, shortSha(manifest.pipeline_sha))),
      ),
      sources.map(([id, src]) => {
        return h("div", { class: "series-source" },
          h("h3", {}, SERIES_TITLES[id]),
          h("dl", { class: "facts" },
            h("dt", {}, "Data Center query"), h("dd", {}, src.query),
            h("dt", {}, "Years"), h("dd", {}, src.years),
            h("dt", {}, "Last complete year"), h("dd", {}, String(manifest.last_year[id])),
            h("dt", {}, "Rows WIPO returned empty"),
            h("dd", {}, `${formatCount(manifest.absent_rows[id])} (entity and type pairs with no row: shown as no data reported)`),
          ),
          h("p", { class: "source-line" }, sourceLine(src, manifest)),
        );
      }),
    ],
  };
}

function definitionsSection({ manifest, entities, swiss }: MethodsData): Section {
  const regionalOffices = labelsOf(entities, "regional_office");
  const formerStates = labelsOf(entities, "historical");
  const body: Child[] = [
    h("dl", { class: "terms" },
      h("dt", {}, "Origin"),
      h("dd", {}, "Where the first-named applicant resides. Origin figures count applications by a country's residents at any office. ",
        "Origin figures are absolute counts (WIPO 'total count'): an application at a regional office counts once. ",
        "A filing at a regional office counts as a resident filing for applicants from that office's member states."),
      h("dt", {}, "Filing office"),
      h("dd", {}, "The office that received the application: a national office or a regional one",
        regionalOffices ? ` (${regionalOffices}).` : "."),
      h("dt", {}, "Resident / non-resident"),
      h("dd", {}, "At an office: applications from applicants residing in that office's country or region, and from everyone else."),
      h("dt", {}, "Abroad"),
      h("dd", {}, "By origin: applications a country's residents filed at foreign offices."),
      h("dt", {}, "Former states and territories"),
      h("dd", {}, formerStates ? `${formerStates}: ` : "", "they keep their historical data, marked former, and are never ranked."),
      h("dt", {}, "WIPO aggregates"),
      h("dd", {}, "Totals WIPO reports for sets of countries, such as the EU or LDCs: left out of ranks, sums and top lists. ",
        "They are not the regions and continents below, which are built from member countries."),
    ),
  ];
  const year = String(manifest.last_year.origin_apps);
  const origin = swiss?.series.origin_apps;
  const office = swiss?.series.office_apps;
  const originSource = swiss?.sources.origin_apps;
  if (swiss && origin && office && originSource) {
    body.push(
      h("div", { class: "example", id: "origin-vs-office" },
        h("h3", {}, `Why origin and office differ: ${swiss.label}, ${year}`),
        h("p", {},
          `Origin data count applications by residents of ${swiss.label} at any office, and count their filings at a regional office `,
          `such as the EPO as resident filings. The resident count of the office of ${swiss.label} covers only filings made at that office. `,
          `By origin, residents of ${swiss.label} filed `, h("strong", {}, formatCount(origin.types.resident?.[year])),
          ` resident applications; the office of ${swiss.label} received `, h("strong", {}, formatCount(office.types.resident?.[year])),
          ` applications from residents. Most of the difference reflects residents of ${swiss.label} filing at other offices, chiefly the EPO.`),
        h("p", { class: "source-line" }, sourceLine(originSource, manifest)),
      ),
    );
  }
  return { id: "definitions", title: "Definitions", body };
}

function worldSection({ manifest, overview }: MethodsData): Section {
  const ratios = manifest.checks.world_sum_ratio;
  return {
    id: "world-totals",
    title: "World totals and shares",
    body: [
      h("p", {}, "World figures are WIPO's own totals, not our sums: the patent world total (code WD) and the PCT total (code ZZ). ",
        "WD includes WIPO's estimates for offices that did not report; ZZ counts the applications recorded in WIPO's database at retrieval. ",
        "WIPO's published figures for the latest PCT year are estimates and can differ slightly."),
      h("ul", {},
        presentSources(overview).filter(([id]) => overview.share_denominator[id]).map(([id]) =>
          h("li", {}, `${SERIES_TITLES[id]}: share of ${overview.share_denominator[id]}.`)),
      ),
      h("p", {}, "We also add up all reporting entities as a check. A sum above WIPO's total is treated as a data error and stops publication, ",
        "except in years where WIPO's own data are known to show this (listed below as warnings)."),
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "World total"), h("th", {}, "Years"), h("th", {}, "Our sum ÷ WIPO total, lowest"), h("th", {}, "highest"))),
        h("tbody", {}, (Object.keys(ratios) as WorldId[]).map((id) =>
          h("tr", {}, h("td", {}, WORLD_TITLES[id] ?? id), h("td", {}, ratios[id].years ?? "–"),
            h("td", { class: "num" }, percent(ratios[id].min, 2)), h("td", { class: "num" }, percent(ratios[id].max, 2))))),
      ),
      h("h3", {}, "Known WIPO years where the office sum exceeds the world total"),
      list(manifest.checks.world, "None in this release."),
    ],
  };
}

/** Series-break notes of one chart: a country (`code`), a group (`group`: M49 region id or continent slug) or the world,
 * the series charted and its first and last year. */
/** `growth` false: no "Growth … not computed" sentence on a country's note (scale cards show no growth). */
export type BreakScope = { code?: string; group?: string; world?: boolean; series: SeriesId; first: number; last: number; growth?: false };

/** Author and year of a citation: the text before its first ".". */
function citationShort(citation: string): string {
  const end = citation.indexOf(".");
  return end < 0 ? citation : citation.slice(0, end);
}

/** Footnotes for the breaks (overview `series_breaks`, pipeline/breaks.py) a chart spans: year - 1 and year both charted,
 * its series affected, and the break's country is the chart's country, in its group, or the chart is the world. Only the
 * country's own growth exists to withhold (yoy null); world and groups publish none. No `series_breaks` = no notes. */
export function seriesBreakNotes(overview: Overview, scope: BreakScope): string[] {
  return (overview.series_breaks ?? [])
    .filter((entry) => scope.first <= entry.year - 1 && scope.last >= entry.year && entry.series.includes(scope.series)
      && (scope.code !== undefined ? scope.code === entry.code
        : scope.group !== undefined ? entry.groups.includes(scope.group) : scope.world === true))
    .map((entry) => {
      const text = `Series break ${entry.year}: ${entry.note} (summarised from WIPO, ${citationShort(entry.citation)}, ${entry.page}).`;
      if (scope.code !== undefined && scope.growth === false) return text;
      return scope.code !== undefined
        ? `${text} Growth from ${entry.year - 1} to ${entry.year} is not computed.`
        : `Includes ${entry.label}: ${text}`;
    });
}

/** Breaks WIPO publishes (overview `series_breaks`); no section when the data list none. */
function seriesBreaksSection({ overview }: MethodsData): Section | null {
  const listed = overview.series_breaks ?? [];
  if (listed.length === 0) return null;
  return {
    id: "series-breaks",
    title: "Series breaks",
    body: [
      h("p", {}, "WIPO marks years where a country's data are not comparable with the year before. ",
        "That country's growth into the year is not computed: its data hold no figure for it, with the reason. ",
        "Charts that span the break carry a note: the country's own, and the world, region and continent charts that include it. ",
        "Each note below is our summary of WIPO's, not a quotation."),
      h("ul", { class: "series-breaks" }, listed.map((entry) => h("li", {},
        h("strong", {}, `${entry.label}, ${entry.year}`), `: ${entry.note}. `,
        `Series: ${entry.series.map((id) => SERIES_TITLES[id] ?? id).join("; ")}. `,
        "Summarised from WIPO: ", h("a", { href: entry.url, rel: "noopener" }, entry.citation), `, ${entry.page}.`))),
    ],
  };
}

function yearsSection({ manifest, overview }: MethodsData): Section {
  const rule = overview.coverage_rule;
  const worldRows = (Object.keys(overview.world_last_year) as WorldId[]).map((id) => {
    const last = overview.world_last_year[id];
    const coverage = overview.coverage[id];
    const provisional = Object.keys(coverage).filter((year) => Number(year) > last);
    return h("tr", {},
      h("td", {}, WORLD_TITLES[id] ?? id),
      h("td", { class: "num" }, String(last)),
      h("td", { class: "num" }, formatCount(coverage[String(last)])),
      h("td", {}, provisional.length
        ? provisional.map((year) => `${year} (${formatCount(coverage[year])} reporting)`).join(", ")
        : "none"));
  });
  return {
    id: "years",
    title: "Complete and provisional years",
    body: [
      h("p", {}, "Only complete calendar years are shown: the current year is always dropped, and a PCT year is dropped while WIPO's monthly report shows it incomplete. ",
        `Last complete year: patents by origin ${manifest.last_year.origin_apps}, patents by office ${manifest.last_year.office_apps}, PCT ${manifest.last_year.pct_origin}.`),
      h("p", {}, "Offices report late, so the newest year can be thin. ",
        `A latest year is provisional when fewer entities report than ${percent(rule.min_ratio, 0)} of the most that reported in any of the ${rule.lookback_years} years before it. `,
        "Provisional years stay in each country's own figures but are left out of world trends, shares, ranks and top lists."),
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "World series"), h("th", {}, "Complete through"), h("th", {}, "Entities reporting"), h("th", {}, "Provisional years"))),
        h("tbody", {}, worldRows),
      ),
    ],
  };
}

/** Terms of the overview views: what each plots and how it is computed (all figures from overview.json). */
function viewTerms(overview: Overview): [string, string][] {
  const { rank_race: race, method } = overview;
  const share = overview.continent_share.origin_apps;
  return [
    ["Rank race", `One line per country that ranked ${race.top} or better by origin in any year from ${race.first_year} to ${overview.top_year}; ` +
      `the height is its rank that year (see Rank). A year where the country ranks below ${race.top} is not drawn, so its line breaks.`],
    ["Region share of world", `Patent applications by origin only. For each continent and year: the continent's total ÷ the world total × 100. ` +
      `The band at the top (“${share.unallocated_label}”) is the world total minus the sum of the continents' totals. ` +
      `Continent totals of a member-sum series count only years where the grouped countries together account for at least ${Math.round(method.group_attribution_min * 100)}% of the series' world total (the attribution floor). ` +
      `A year with a negative band, or with no continent total (reason named under the chart), is left out; the figures table shows the real values.`],
    ["Size versus growth", `Horizontal: applications by origin in ${overview.top_year}, on a log scale. Vertical: the ${method.cagr_years}-year compound annual growth. ` +
      `Countries with at least ${formatCount(overview.grower_min)} applications that year; a country whose growth cannot be computed ` +
      "(no value, or zero, " + method.cagr_years + " years earlier) is listed under the chart, not plotted. Marker colour and shape = continent."],
    ["PCT monthly heat strip", "PCT applications by filing month, WIPO world total (all receiving offices): one cell per month and year, " +
      "shaded in equal steps between the lowest and the highest month shown. A month WIPO has no figure for is hatched, never shaded as the lowest. " +
      PCT_LATE_FILINGS],
  ];
}

function formulasSection({ overview }: MethodsData): Section {
  const { cagr_years: years, rounding } = overview.method;
  const places = rounding.decimals;
  const formulas: [string, string][] = [
    ["Year-on-year growth", `(value this year − value last year) ÷ value last year × 100, ${decimals(places.yoy)}.`],
    [`${years}-year compound annual growth`,
      `((value in the end year ÷ value ${years} years earlier) ^ (1 ÷ ${years}) − 1) × 100, ${decimals(places.cagr)}.`],
    ["Share of world", `value ÷ WIPO world total for the same year × 100, ${decimals(places.share)}.`],
    ["Rank", "Position in a year, 1 = most applications. " +
      `${(Object.keys(RANK_BASIS) as SeriesId[]).map((series) => `${SERIES_TITLES[series]}: ranked among ${RANK_BASIS[series]}.`).join(" ")} ` +
      "Regional offices, former states and groups are not ranked. Equal values share a rank and the next rank is skipped."],
    ["Resident share", `resident applications ÷ all applications at an office × 100, ${decimals(places.resident_share)}.`],
  ];
  return {
    id: "formulas",
    title: "Figures and formulas",
    body: [
      h("dl", { class: "terms" }, formulas.map(([name, text]) => [h("dt", {}, name), h("dd", {}, text)])),
      h("p", {}, `Percentages are rounded ${rounding.mode}. `,
        "A figure is left empty when an input year has no data, the base is zero or the two years straddle a series break",
        (overview.series_breaks ?? []).length > 0 ? [" (see ", h("a", { href: "#series-breaks" }, "Series breaks"), ")"] : "",
        "; it is never filled with an estimate."),
      h("p", {}, "Missing data shows as “–” or “no data reported”, never as 0. A 0 on the site is a 0 WIPO reported."),
      h("h3", { id: "top-lists" }, "Top lists"),
      h("p", {}, `Top origins: the ${overview.top_n} countries with the most patent applications by origin in ${overview.top_year}. `,
        `Fastest growers: the ${overview.top_n} countries with the highest ${years}-year compound annual growth to ${overview.top_year}, `,
        `among countries with at least ${formatCount(overview.grower_min)} applications that year, so small numbers do not dominate.`),
      h("h3", { id: "overview-views" }, "Overview views"),
      h("dl", { class: "terms" }, viewTerms(overview).map(([name, text]) => [h("dt", {}, name), h("dd", {}, text)])),
      h("p", {}, originAbroadNote(overview)),
    ],
  };
}

/** Every group null reason (atlas.ts GroupNullReason; the Record keeps the list in step with the type). */
const NULL_REASONS: Record<GroupNullReason, true> = {
  no_wipo_regional_total: true, no_wipo_world_total: true, none_reported: true, attribution_floor: true,
};

/** The one band label that is not a series' own (pipeline/groups.py GENERIC_UNALLOCATED_LABEL): PCT falls back to it
 * when ZZ − sum(R) differs from WIPO's “Unknown” row in some year (`unallocated_label`). */
const GENERIC_UNALLOCATED_LABEL = "unallocated";

type TextContext = { overview: Overview; groups: GroupsFile; label: (code: string) => string };

/** Codes counted in a series' WIPO regional totals beyond the member countries (overview `method.group_crosscheck_assignment`). */
function addedCodes(series: SeriesId, { overview, label }: TextContext): string[] {
  const added = Object.values(overview.method.group_crosscheck_assignment[series] ?? {}).flat();
  return [...new Set(added)].map((code) => `${label(code)} (${code})`);
}

/** What a group basis (overview `method.group_basis`) means for a series; null = the kind is not offered for the series.
 * WIPO-total wording comes from groupText (shared with the region pages). */
function basisText(series: SeriesId, value: string | null, context: TextContext): string {
  if (value === null) return "not offered";
  if (value === "member_sum") return "sum of the member countries that reported";
  if (value !== "wipo_total") return value;
  return `WIPO's own regional total (${wipoTotalCounts(series, addedCodes(series, context), unlistedGroups(context))})`;
}

/** Labels of the groups whose PCT total also counts unlisted origins. */
function unlistedGroups({ groups }: TextContext): string[] {
  return PCT_UNLISTED_ORIGIN_GROUPS.flatMap((id) => groups.items.find((item) => item.id === id)?.label ?? []);
}

/** What the band under each series' continents holds (its label is `continent_share[series].unallocated_label`). */
function bandText(series: SeriesId, context: TextContext): string {
  const { overview } = context;
  const label = overview.continent_share[series].unallocated_label;
  if (series === "office_apps") return "the world total minus the continents' WIPO totals";
  if (series === "pct_origin") {
    return "the world total minus the continents' WIPO totals. When that equals WIPO's own “Unknown” origin row in every year it is labelled “origin unknown”; " +
      `if it differs in any year the band is labelled “${GENERIC_UNALLOCATED_LABEL}”. In this release: ` +
      (label === GENERIC_UNALLOCATED_LABEL ? "it differs in at least one year." : "it equals the Unknown row in every year.");
  }
  return "the world total minus the sum of the continents' totals: origin not attributable to a listed country.";
}

function wholePercent(ratio: number): string {
  const value = Math.round(ratio * 100);
  return `${value > 0 ? "+" : ""}${value}%`;
}

/** Why a WIPO regional total can exceed the sum of its members, per series that has one (`method.group_basis` continent kind). */
function gapCauses(context: TextContext): string {
  const { overview } = context;
  const series = (Object.keys(overview.method.group_basis) as SeriesId[]).filter((id) => overview.method.group_basis[id]?.continent === "wipo_total");
  const causes = series.map((id) => `${SERIES_TITLES[id]}: ${wipoTotalGapCause(id, unlistedGroups(context).length > 0)}`);
  return causes.length ? `The causes: ${causes.join("; ")}.` : "";
}

function groupingsSection({ overview, entities, groups }: MethodsData): Section {
  const { method } = overview;
  const kinds = (kind: "continent" | "region") => groups.items.filter((item) => item.kind === kind);
  const label = labelOfEntities(entities);
  const groupLabel = (id: string): string => groups.items.find((item) => item.id === id)?.label ?? id;
  const context: TextContext = { overview, groups, label };
  const memberSumGroups = (Object.keys(SERIES_TITLES) as SeriesId[]).flatMap((series) => {
    const kindsOf = (["continent", "region"] as const).filter((kind) => method.group_basis[series]?.[kind] === "member_sum");
    return kindsOf.length ? [`${SERIES_TITLES[series]}: ${kindsOf.map((kind) => `${kind}s`).join(" and ")}`] : [];
  }).join("; ");
  const regionCount = kinds("region").filter((item) => groupPageTarget(groups.items, item).kind === "region").length;
  const [low, high] = method.group_crosscheck_range;
  const assignments = (Object.keys(method.group_crosscheck_assignment) as SeriesId[]).flatMap((series) =>
    Object.entries(method.group_crosscheck_assignment[series] ?? {}).map(([group, codes]) =>
      h("li", {}, `${SERIES_TITLES[series]}, ${groupLabel(group)}: ${codes.map((code) => `${label(code)} (${code})`).join(", ")}`)));
  return {
    id: "groupings",
    title: "Regions and continents",
    body: [
      h("p", {}, `Countries are grouped by the UN's M49 standard into ${kinds("continent").length} continents `,
        `(${kinds("continent").map((item) => item.label).join(", ")}) and ${regionCount} regions (M49 sub-regions and intermediate regions; a region with the same members as its continent is counted as that continent). `,
        "Each country belongs to one region and one continent. ",
        "Aggregates WIPO reports, regional offices and former states belong to no group and are never counted as members."),
      h("dl", { class: "facts" }, groups.sources.groupings.map((source) => [
        h("dt", {}, "Grouping source"), h("dd", {}, h("a", { href: source.url, rel: "noopener" }, source.name)),
        h("dt", {}, "Retrieved"), h("dd", {}, source.retrieved),
        h("dt", {}, "Use"), h("dd", {}, source.use),
      ])),
      h("h3", {}, "No group"),
      Object.keys(groups.no_group).length
        ? h("ul", {}, Object.entries(groups.no_group).map(([code, reason]) => h("li", {}, h("code", {}, code), `: ${reason}.`)))
        : h("p", { class: "muted" }, "Every country is in a group."),
      h("p", {}, "A map area in this list has no group (it is also not a WIPO country, so it is grey on the map)."),
      h("h3", {}, "Basis of a group total"),
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Series"), h("th", {}, "Continent"), h("th", {}, "Region"))),
        h("tbody", {}, (Object.keys(SERIES_TITLES) as SeriesId[]).map((series) => h("tr", {},
          h("td", {}, SERIES_TITLES[series]),
          h("td", {}, basisText(series, method.group_basis[series]?.continent ?? null, context)),
          h("td", {}, basisText(series, method.group_basis[series]?.region ?? null, context))))),
      ),
      h("h3", {}, "Coverage"),
      h("p", {}, "There is no minimum count of reporting members. A WIPO regional total is shown for every complete year WIPO publishes it, with “n of m”: ",
        "n members reported, m members WIPO lists for the series (members WIPO does not list are named on the page). ",
        "A year WIPO has no regional total for shows the reason (no WIPO regional total). ",
        "A member-sum total is left empty when no member reported, when the WIPO world total is missing or provisional, or when the attribution floor fails: ",
        "the countries that belong to a group account for less than ",
        `${Math.round(method.group_attribution_min * 100)}% of the series' world total that year. `,
        `The floor is tested once per series and year on all grouped countries together, so a failing year empties every member-sum group of that series (${memberSumGroups}).`),
      h("h3", {}, "Why a group year is empty"),
      h("dl", { class: "terms" }, (Object.keys(NULL_REASONS) as GroupNullReason[]).map((reason) => [
        h("dt", {}, h("code", {}, reason)), h("dd", {}, nullReasonText(reason, overview)),
      ])),
      h("h3", {}, "Band under the continents"),
      h("p", {}, "The region-share chart is drawn for origin only. It ends with one band that no continent holds; the other series carry the same band in the published data (overview.json) only. Its label depends on the series:"),
      h("dl", { class: "terms" }, (Object.keys(overview.continent_share) as SeriesId[]).map((series) => [
        h("dt", {}, `${SERIES_TITLES[series]}: “${overview.continent_share[series].unallocated_label}”`),
        h("dd", {}, bandText(series, context)),
      ])),
      h("h3", {}, "Fixed panel"),
      h("p", {}, "A member-sum group compared with a country (country page) is drawn as a fixed panel: ",
        `the members that reported in every one of the last ${method.panel_years} years (fewer where the series or the attribution floor starts later). `,
        "Its line then does not move when a member starts or stops reporting."),
      h("h3", {}, "Cross-check of WIPO totals"),
      h("p", {}, "For a continent shown as WIPO's total, the page draws the sum of its member countries beside it. ",
        "Codes that WIPO counts in the continent's total but that are no member (regional offices, former entities) are added to the sum, so the two compare like with like. ",
        `The gap, (WIPO total − sum) ÷ WIPO total, is expected between ${wholePercent(low)} and ${wholePercent(high)}. `,
        gapCauses(context),
        " A year outside that range is a warning, never a stop."),
      assignments.length ? h("ul", { class: "crosscheck-assignment" }, assignments) : null,
    ],
  };
}

function mapSection({ cfg, groups, entities, geoSources }: MethodsData): Section {
  const { scale } = mapScale(cfg.map);
  const label = labelOfEntities(entities);
  const bins = Array.from({ length: scale.bins }, (_, index) => binLabel(index + 1, scale.logBase, scale.bins));
  const successorRows = Object.entries(groups.successors).map(([former, successors]) => {
    const windows = new Map<string, string[]>();
    for (const successor of successors) {
      const window = `${successor.from_year}–${successor.to_year}`;
      windows.set(window, [...(windows.get(window) ?? []), label(successor.code)]);
    }
    const named = windows.size
      ? [...windows].map(([window, names]) => `${window} → ${names.join(", ")}`).join("; ")
      : "none: the successor reports itself";
    return h("tr", {}, h("td", {}, `${label(former)} (${former})`), h("td", {}, named));
  });
  return {
    id: "map",
    title: "World map",
    body: [
      h("p", {}, `Each area is coloured by its value in the chosen year, in ${scale.bins} bins that are powers of ${scale.logBase} wide `,
        `(${bins.join("; ")}). The bins are the same in every year, so the year slider compares like with like. `,
        "In region and continent mode each member is coloured by its group's total."),
      h("dl", { class: "terms" },
        h("dt", {}, MAP_STATE_LABELS.zero), h("dd", {}, "Dotted: WIPO reported 0."),
        h("dt", {}, MAP_STATE_LABELS.null),
        h("dd", {}, "Hatched, never the lightest colour: WIPO has no figure for that year (or, for a group, the total is empty for a reason named in the tooltip)."),
        h("dt", {}, MAP_STATE_LABELS.former),
        h("dd", {}, "Hatched the other way, on its own ground: the successor has no figure of its own that year and the former entity reported (successor rule below)."),
        h("dt", {}, MAP_STATE_LABELS.neutral),
        h("dd", {}, "Grey and hatched, unlabelled, no link, whatever the data: disputed areas and areas WIPO does not list as a country."),
      ),
      h("h3", {}, "Successor rule"),
      h("p", {}, "A country is marked “reported under <former entity>” in a year when it has no data of its own, the former entity covered it that year ",
        "(the years in the table) and reported, and only if the country reports in that series in some year. ",
        "The former entity's own figures are in the map's figures table, not on the map; a member-sum group total does not include them."),
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Former entity"), h("th", {}, "Successors"))),
        h("tbody", {}, successorRows),
      ),
      groups.sources.former_entities.map((source) => h("p", { class: "muted" },
        `Table built from ${source.name}, ${source.section} (retrieved ${source.retrieved}); WIPO's labels, not ISO codes.`)),
      h("h3", {}, "Shapes and dots"),
      h("p", {}, "Countries too small to see at world scale are drawn as dots. A country with data and neither shape nor dot is listed under the map as not drawn. ",
        geoSources.map((source) => [`Geometry: ${source.name}, `, h("a", { href: source.url, rel: "noopener" }, source.url), ` (${source.licence}). `])),
      h("p", { class: "disclaimer" }, MAP_DISCLAIMER),
      h("p", { class: "muted" }, MAP_CREDIT),
    ],
  };
}

/** PCT membership layer: both WIPO documents, the member rule, territories, former entities, successor and continuing
 * States; every date and count from overview `pct_membership`. */
function pctMembershipSection({ overview, entities }: MethodsData): Section | null {
  const block = overview.pct_membership;
  if (!block) return null; // data written before v2a
  return {
    id: "pct-membership",
    title: "PCT membership",
    body: [
      h("p", {}, "The world map's PCT membership layer shows which countries are PCT Contracting States, year by year. ",
        "Each State's code, name and the date on which it became bound by the PCT come from WIPO's page ",
        h("a", { href: block.source_url, rel: "noopener" }, "PCT Contracting States"),
        "; the count and the status date come from WIPO's list ",
        h("a", { href: block.count_check_url, rel: "noopener" }, "PCT Contracting States and Two-letter Codes"),
        ` (PDF): ${block.count[String(block.last_year)]} States on ${block.status_on}, retrieved ${block.retrieved}.`),
      h("p", {}, `A country is a member in a year when it was bound by the PCT by 31 December of that year; the latest year, ${block.last_year}, `,
        `shows the list as of ${block.status_on}. The year slider starts in ${block.first_year}, the year the PCT entered into force. `,
        "The card's count is of today's Contracting States bound by 31 December of each year; territories and former entities are not counted."),
      h("p", {}, "A territory is not a Contracting State. Where a footnote on WIPO's page says the PCT applies to a territory through a ",
        "Contracting State, the map gives the territory the member fill from that date (the footnote's date; where it gives none, the date ",
        `the State became bound): ${block.territories.map((t) => `${t.name} (${t.code}) through ${t.state} since ${t.from}`).join("; ")}. `,
        "Other territories with their own WIPO code are not on the list and show as not a PCT member."),
      h("p", {}, `WIPO's list names today's States only. A former entity (${labelsOf(entities, "historical")}) is never shown as a non-member: `,
        `it has no data, with the reason “${membershipNullText("not_on_current_list")}”. `,
        "Nor is a successor State before its own date (the date it became bound by the PCT, or the day it left a State that continues): ",
        "the map shows no data for those years, hatched, because WIPO's current list gives no dates for former States, so neither member nor ",
        "non-member can be claimed. Successor States follow ISO 3166-3 (former country codes); a new State that left a continuing one, ISO 3166-1:"),
      h("ul", { class: "pct-successors" }, block.successors.map((entry) => h("li", {},
        `${entry.name} (${entry.source}): ${entry.codes.map((code) => `${labelOfEntities(entities)(code)} (${code})` +
          (entry.own_dates[code] ? `, own date ${entry.own_dates[code]}` : "")).join(", ")}.${entry.note ? ` ${entry.note}` : ""}`))),
      block.continuing.length ? h("p", {}, continuingText(block)) : null,
      h("p", {}, "WIPO's PDF list prints the code MT for Mauritius as well as for Malta; WIPO's page gives Mauritius MU, which this site uses."),
      h("p", {}, `Codes on the list with no WIPO statistics entity are named under the map: ${block.unmatched.length ? block.unmatched.join(", ") : "none"}.`),
      h("p", {}, "The list is updated by hand when WIPO publishes a new one: the rows transcribed from the page, the count and status date ",
        "from the PDF; nothing reads either document automatically."),
    ],
  };
}

/** Countries listed per ratio with the largest median ours/WIPO factor (the dry-run line prints the same number). */
const VINTAGE_SHOWN = 5;
const WDI_URL = "https://datatopics.worldbank.org/world-development-indicators/";

/** A constant ratio as a percentage without trailing zeros (0.005 -> "0.5", 0.1 -> "10"). */
function limitPercent(ratio: number): string {
  return String(Number(fixedPercent(ratio, 3)));
}

/** "Label (CODE), …" of the countries without any WDI value for `denominator` (overview `ratio_no_denominator`). */
function noDenominatorLabels(overview: Overview, entities: Entities, denominator: RatioDenominator): string {
  const codes = overview.ratio_no_denominator?.[denominator];
  if (!codes) return "not recorded";
  if (codes.length === 0) return "none";
  const labels = new Map(entities.map((entity) => [entity.code, entity.label]));
  return codes.map((code) => `${labels.get(code) ?? code} (${code})`).join(", ");
}

/** First year of PCT per million (pipeline/write.py `ratio_years`: the PCT series' first year when after `ratio_from`). */
function pctRatioFirst(overview: Overview): number | null {
  const years = Object.keys(overview.world_ratios?.pct_per_million ?? {}).map(Number);
  return years.length > 0 ? Math.min(...years) : null;
}

function scaleSection({ manifest, overview, entities }: MethodsData): Section | null {
  const method = overview.method.ratios;
  if (!method) return null;
  const pctFirst = pctRatioFirst(overview);
  const groupFloor = limitPercent(overview.method.group_attribution_min);
  const denominatorName = { population: manifest.wdi_denominators?.population.name, gdp_ppp: manifest.wdi_denominators?.gdp_ppp.name };
  const formulas = method.ratio_ids.map((id) => {
    const numerator = method.numerator[id];
    const denominator = method.denominator[id];
    return h("li", { "data-formula": id },
      h("strong", {}, RATIO_TITLES[id]), `: ${SERIES_TITLES[numerator.series]}, ${numerator.type} applications ÷ `,
      denominator === "population" ? "population" : "GDP (PPP)", ` × ${amountWords(method.scale[id])}`,
      ` (denominator: ${denominatorName[denominator] ?? "not recorded"}).`);
  });
  return {
    id: "scale",
    title: "Per capita and per GDP",
    body: [
      h("p", {}, "Applications are put in proportion to population and to economic size so that small and large economies can be compared. ",
        "Wherever WIPO publishes the figure, Patent Atlas shows WIPO's value as published and labels it ", h("strong", {}, RATIO_BASIS_LABEL.wipo),
        ". Where WIPO publishes none, the figure is computed and labelled exactly “", h("strong", {}, RATIO_BASIS_LABEL.computed), "”."),
      h("h3", {}, "WIPO's own indicators"),
      h("ul", { class: "ratio-labels" }, (method.wipo_ratio_ids as WipoRatioId[]).map((id) => h("li", {},
        h("strong", {}, RATIO_TITLES[id]), ": WIPO's label “", manifest.ratio_labels?.[id] ?? "not recorded", "”. ",
        overview.sources[id] ? sourceLine(overview.sources[id], manifest) : ""))),
      h("p", { class: "gdp-base" }, `WIPO's per-GDP label, as published: “${manifest.ratio_labels?.per_gdp ?? "not recorded"}”. `,
        `Computed figures use constant ${manifest.wdi_denominators?.gdp_ppp.gdp_base ?? "not recorded"} PPP GDP, the base in WDI's own indicator name `,
        `(${manifest.wdi_denominators?.gdp_ppp.name ?? "not recorded"}), never the base in WIPO's label. `,
        "WIPO's own values may rest on an earlier WDI release (see ", h("a", { href: "#ratio-check" }, "Cross-check with WIPO"), ")."),
      h("h3", {}, "Formulas and scales"),
      h("ul", {}, formulas),
      h("p", { class: "ratio-years" }, `Every ratio is rounded to ${decimalsWords(method.decimals)}, half away from zero. `,
        `A computed figure that rounds to 0 from a count above 0 is left empty with the reason “${ratioNullText("below_precision", "per_million", overview)}” ` +
          `(PCT and group figures: “${ratioNullText("below_precision", "pct_per_million", overview)}”); `,
        "a count of 0 gives 0. ",
        `Ratios start in ${method.ratio_from}, the first year WIPO publishes them`,
        pctFirst !== null && pctFirst > method.ratio_from ? `; PCT per million starts in ${pctFirst}, the first year of WIPO's PCT applications by origin` : "",
        ". Each ends at the latest complete year of its numerator."),
      h("h3", {}, "Numerators"),
      h("p", {}, "Countries: applications by applicant's origin of WIPO's “resident” type, which counts a filing at a regional office such as the EPO as resident. ",
        "World: WIPO's own World row, whose numerator is the residents' applications at all offices (World, WD). ",
        "PCT per million: WIPO's PCT applications by origin (total), with WIPO's PCT world total over WDI's world population for the World figure."),
      h("h3", {}, "Computed cases"),
      h("ul", {},
        h("li", {}, h("strong", {}, "A country-year WIPO publishes no value for"), ": computed with the formula above, with WIPO's thresholds applied."),
        h("li", {}, h("strong", {}, "Regions and continents"), ": the sum of the members' numerators ÷ the sum of their denominators, over the members that have both values that year, ",
          "shown with “n of m”: n members counted of m members. The attribution floor of the numerator series applies (",
          `the grouped countries must cover at least ${groupFloor}% of its world total), so a year it empties stays empty. `,
          `A group year is empty when the summed denominator is at or below the threshold, with the reason “${ratioNullText("below_wipo_threshold", "per_million", overview, "group")}”.`),
        h("li", {}, h("strong", {}, "PCT per million"), ": WIPO publishes no PCT figure per population. The population threshold WIPO uses for its per-million figures is applied; ",
          "groups sum their members' PCT counts ÷ the sum of their population, regions and continents alike."),
        h("li", { "data-no-denominator": "" }, h("strong", {}, "No denominator"), ": a country without a WDI value gets no computed figure; WIPO's own value is still shown where it exists. ",
          `Without WDI population in any year: ${noDenominatorLabels(overview, entities, "population")}; their empty years give the reason “${ratioNullText("no_population", "per_million", overview)}”. `,
          `Without WDI GDP in any year: ${noDenominatorLabels(overview, entities, "gdp_ppp")}; reason “${ratioNullText("no_gdp", "per_gdp", overview)}”. `,
          `Former entities (${labelsOf(entities, "historical")}) have no per-capita or per-GDP figures: ratios are given for current countries only, `,
          "and any WIPO value for a code without a country entity is listed under ", h("a", { href: "#ratio-check" }, "Cross-check with WIPO"), "."),
      ),
      h("h3", {}, "Thresholds"),
      h("p", {}, "A computed figure is left empty when its denominator is at or below WIPO's threshold:"),
      h("dl", { class: "facts" },
        (method.wipo_ratio_ids as WipoRatioId[]).flatMap((id) => [
          h("dt", {}, method.denominator[id] === "population" ? "Per million" : "Per GDP"), h("dd", {}, thresholdWords(id, overview)),
        ])),
      h("h3", {}, "GDP basis"),
      h("p", {}, gdpBasisLabel(manifest), ". WDI revises its GDP series, so computed per-GDP figures can move between data releases."),
      h("h3", {}, "World Bank WDI"),
      h("p", {}, wdiCredit(manifest), ". ", h("a", { href: WDI_URL, rel: "noopener" }, WDI_URL)),
    ],
  };
}

/** One blocking-test sentence: what the test measures and its limit (every number from overview.method.ratios). */
function blockingTestText(test: "cell_share" | "country_factor" | undefined, method: RatioMethod): string {
  if (test === "cell_share") return `the share of compared cells outside tolerance must not exceed ${limitPercent(method.fail_share_max)}% of the compared cells.`;
  if (test === "country_factor") {
    return `the share of compared countries whose median ours/WIPO factor is more than ${limitPercent(method.country_factor_max)}% from 1 must not exceed ` +
      `${limitPercent(method.country_share_max)}% of the compared countries.`;
  }
  return "not recorded.";
}

function ratioCheckPart(id: WipoRatioId, block: RatioCheck | undefined, method: RatioMethod): HTMLElement | null {
  if (!block) return null;
  const blocking = method.blocking_test[id];
  const other = blocking === "country_factor" ? "cell_share" : "country_factor";
  const shown = block.vintage_factors.slice(0, VINTAGE_SHOWN);
  return h("div", { class: "series-source", "data-ratio-check": id },
    h("h3", {}, RATIO_TITLES[id]),
    h("p", { class: "ratio-counts" },
      `${formatCount(block.compared)} compared, ${formatCount(block.failing_count)} outside tolerance. World row: ${block.world}.`),
    h("p", { class: "ratio-blocking" }, h("strong", {}, "Blocking test"), `: ${blockingTestText(blocking, method)}`),
    h("p", { class: "ratio-warning-only" }, h("strong", {}, "Warning only"), `: ${blockingTestText(blocking === undefined ? undefined : other, method)}`),
    block.warnings.length > 0 && h("div", { class: "ratio-warnings" }, h("p", {}, "Warnings:"), list(block.warnings, "")),
    block.world_failing.length > 0 && h("div", {}, h("p", {}, "World row outside tolerance:"), list(block.world_failing, "")),
    h("p", { class: "ratio-vintage" },
      `${formatCount(block.vintage_factors.length)} ${block.vintage_factors.length === 1 ? "country has" : "countries have"} a median ours/WIPO factor off by more than ${limitPercent(method.vintage_note_min)}% (WDI vintage)`,
      shown.length > 0 ? `; the largest: ${shown.map((item) => `${item.code} ${item.median_factor}`).join(", ")}. ` : ". ",
      `For countries with very small values, rounding to ${decimalsWords(method.decimals)} alone can move this factor far from 1.`),
    block.unlisted.length > 0 && h("p", { class: "ratio-unlisted" },
      `WIPO values for codes with no country entity (not shown, not compared): ${block.unlisted.map((item) => `${item.code} (${item.years})`).join(", ")}.`),
    h("div", { class: "ratio-failing" },
      h("p", {}, block.failing.length < block.failing_count
        ? `Cells outside tolerance, the first ${formatCount(block.failing.length)} of ${formatCount(block.failing_count)}:`
        : "Cells outside tolerance:"),
      list(block.failing, "None.")),
  );
}

function ratioCheckSection({ manifest, overview }: MethodsData): Section | null {
  const method = overview.method.ratios;
  const ratios = manifest.checks.ratios;
  if (!method || !ratios) return null;
  return {
    id: "ratio-check",
    title: "Cross-check with WIPO",
    body: [
      h("p", {}, "For every WIPO ratio value whose inputs Patent Atlas also has, the computation is compared with WIPO's published figure. WIPO's value is always the one shown; the comparison never overrides it. ",
        `A cell passes when the two differ by at most ${method.abs_tolerance} + ${limitPercent(method.rel_tolerance)}% of WIPO's value.`),
      h("p", {}, "Each ratio has its own blocking test, never pooled with the other. The other test only warns. ",
        "The World row always blocks: a World cell outside tolerance, or no World cell compared, stops the update. ",
        `WDI's World row must also have a value within ${method.wdi_max_lag} years of the last year requested, or the update stops.`),
      h("p", {}, "Known drift: the World Bank revises GDP and population after WIPO's release, so a country's whole series can differ from WIPO's by one factor. It is listed here as a warning, not an error."),
      (method.wipo_ratio_ids as WipoRatioId[]).map((id) => ratioCheckPart(id, ratios[id], method)),
    ],
  };
}

function regressionBlock({ manifest }: MethodsData): Child[] {
  const regression = manifest.checks.regression;
  return [
    h("h3", { id: "check-regression" }, "Against the data already published"),
    h("p", {}, "Before anything is written, the new data are compared with the data now online. A series whose last year moves back, or a country, office or group that is no longer published, ",
      "stops the update (a local run can accept it on purpose). Earlier years that WIPO has revised are listed as warnings."),
    regression === undefined
      ? h("p", { class: "muted" }, "Not recorded in this release.")
      : [
        h("p", {}, `Warning threshold: a past year changed by more than ${limitPercent(regression.warn_pct / 100)}% `,
          `(or a figure that is now gone). ${formatCount(regression.revision_count)} ${regression.revision_count === 1 ? "revision" : "revisions"}`,
          regression.revisions.length > 0 ? `, the first ${formatCount(regression.revisions.length)} listed:` : "."),
        regression.revisions.length > 0 && list(regression.revisions, ""),
        h("p", {}, "Accepted blocking lines:"),
        list(regression.accepted, "None."),
      ],
  ];
}

/** "warn" has no colour of its own: the warnings listed under it carry the meaning. */
const RESULT_CLASS: Record<Manifest["checks"]["wdi"], string> = { pass: "result-pass", warn: "", fail: "result-fail" };

function checksSection(data: MethodsData): Section {
  const { manifest, overview } = data;
  const checks = manifest.checks;
  return {
    id: "cross-checks",
    title: "Cross-checks",
    body: [
      h("p", {}, "Every monthly update is checked before anything is published. If a blocking check fails, the update stops and the previous data stay online."),
      h("h3", {}, "World Bank WDI, exact match (blocking)"),
      h("p", {}, "The World Bank republishes WIPO's office data (indicators IP.PAT.RESD and IP.PAT.NRES). Resident and non-resident applications must match exactly. ",
        "The latest year is skipped because the World Bank takes up a WIPO release months later. ",
        "If the World Bank last updated its data before the month of WIPO's patent release, WIPO may since have revised past years: differences are then listed as warnings. ",
        "Once the World Bank data are as recent as the release, or the World Bank gives no update date, any difference stops the update."),
      h("dl", { class: "facts" },
        h("dt", {}, "Scope"), h("dd", {}, checks.wdi_scope),
        h("dt", {}, "World Bank data last updated"), h("dd", {}, checks.wdi_last_updated ?? "not recorded"),
        h("dt", {}, "Last result"), h("dd", { class: RESULT_CLASS[checks.wdi] }, checks.wdi),
      ),
      checks.wdi_warnings.length > 0 && [
        h("p", { class: "wdi-warning-reason" }, checks.wdi_warning_reason ?? ""),
        list(checks.wdi_warnings, ""),
      ],
      h("h3", {}, "Published WIPO figures (blocking)"),
      h("p", {}, `Headline figures from WIPO's World Intellectual Property Indicators and PCT Yearly Review must agree within ${overview.method.golden_tolerance_pct}%. Last result:`),
      list(checks.golden, "No figures compared."),
      h("p", {}, "Where each figure is published:"),
      h("ul", { class: "golden-sources" }, checks.golden_sources.map((src) => h("li", {},
        h("code", {}, src.id), `: ${src.citation}. ${src.page}. `, h("a", { href: src.url, rel: "noopener" }, src.url)))),
      h("h3", {}, "World totals (blocking)"),
      h("p", {}, "Our sum of reporting entities against WIPO's totals: see ", h("a", { href: "#world-totals" }, "World totals and shares"), "."),
      h("h3", {}, "OECD trend (warning only)"),
      h("p", {}, "OECD patent statistics (PATSTAT, priority date) are counted differently, so only the direction of yearly change for the largest PCT origins is compared. Differences are logged, never blocking."),
      list(checks.oecd, "No differences in direction flagged."),
      h("h3", { id: "check-pct-monthly" }, "PCT months against the yearly total (warning only)"),
      h("p", {}, "The twelve monthly PCT figures of a year must add up to WIPO's yearly PCT total. A year with months WIPO has no figure for is noted, not compared. Differences are logged, never blocking."),
      checks.pct_monthly === undefined
        ? h("p", { class: "muted" }, "Not recorded in this release.")
        : list(checks.pct_monthly, "No differences."),
      h("h3", { id: "check-groups" }, "Group figures (warning only)"),
      h("p", {}, `Group cross-check outside the expected range of ${wholePercent(overview.method.group_crosscheck_range[0])} to ${wholePercent(overview.method.group_crosscheck_range[1])}, `,
        "a negative band under the continents, and a PCT “Unknown” row that does not match the world total are listed here. They are logged, never blocking."),
      list(checks.groups ?? [], "None in this release."),
      regressionBlock(data),
    ],
  };
}

function revisionsSection(): Section {
  return {
    id: "revisions",
    title: "Revisions",
    body: [
      h("p", {}, "WIPO revises past years as offices send corrections. Every update fetches each series' whole year range again, so figures for earlier years can change between releases. ",
        `WIPO withholds the most recent months of PCT data. ${PCT_LATE_FILINGS}`),
      h("p", {}, "Data are checked for a new release monthly. A figure always carries the release and retrieval date it came from."),
    ],
  };
}

function wallboardSection({ cfg, params }: MethodsData): Section {
  const { minSeconds, resumeAfterSeconds, pauseMovePixels, views } = cfg.rotation;
  const resumeText = isRotationSeconds(cfg, resumeAfterSeconds)
    ? `, and after ${resumeAfterSeconds} seconds without use it restarts by itself.`
    : ".";
  const jitterText = isPauseMovePixels(pauseMovePixels) && pauseMovePixels > 0
    ? ` Small pointer movements under ${pauseMovePixels} pixels do not pause it.`
    : "";
  const board = boardFacts(cfg); // what the board runs with, its defaults included
  // the tested text minimums (e2e reads them from config.json): stated only when all are configured
  const sizes = cfg.wallboard;
  const sizesText = sizes && [sizes.minTextPx, sizes.minTitlePx, sizes.minFinePrintPx].every((px) => typeof px === "number" && px > 0)
    ? `Text is at least ${sizes.minTextPx} px, slide titles ${sizes.minTitlePx} px and the disclaimer ${sizes.minFinePrintPx} px on a 1080-pixel-high screen, and the board's `
    : "The board's ";
  const colourNames = BOARD_CONTRAST_COLOURS.map((colour) => colour.name);
  const contrastNames = `${colourNames.slice(0, -1).join(", ")} and ${colourNames[colourNames.length - 1]} colours`;
  return {
    id: "wallboard",
    title: "Wallboard mode",
    body: [
      h("p", {}, h("strong", {}, "Office screen. "), "Open the overview with the wallboard theme and ",
        h("code", {}, "?rotate=<seconds>"),
        ` (at least ${minSeconds}): it shows ${views.length} views in turn, each for that many seconds, a chart on its own, a country page or the women-inventors page. `,
        `Touching the mouse or keyboard pauses it; the “Resume rotation” button in the header restarts it${resumeText}${jitterText}`),
      h("p", {}, h("strong", {}, "Conference screen. "), "Open ", h("a", { href: viewLink(cfg, params, "wallboard") }, h("code", {}, "?view=wallboard")),
        " (the “Conference wallboard” link in the footer) for a TV or projector: a carousel made for full screen, of ",
        `${board.slideIds.length} charts, one per slide, each for ${board.seconds} seconds (change it with `, h("code", {}, "?rotate=<seconds>"),
        `, at least ${minSeconds}). The page does not reload between slides; after each full round it checks for a new data version and reloads only when one has been published (that reload leaves full screen started with F or the button; for an unattended screen use the browser’s own full screen or kiosk mode). A bottom bar names the slide, its sources, the data version and the WIPO disclaimer. `,
        `${sizesText}${contrastNames} have a contrast of at least ${BOARD_MIN_CONTRAST}:1 on its background (at the lightest point of the background's gradient too) and on its card colour; `,
        "chart colours are not covered by this. Moving the mouse shows the control bar and never pauses."),
      h("p", {}, "Keys (keyboard, presentation clicker or TV remote):"),
      h("ul", { class: "board-keys-list" }, keyTableRows().map((row) => h("li", {}, `${row.label}: ${row.keys.join(", ")}`))),
      h("p", {}, BOARD_ESCAPE_NOTE),
      h("p", {}, h("strong", {}, "Slide picker. "), "S (or the Slides button) opens a list of the slides: tick the ones to show, move them up or down, and Apply. ",
        "The board starts again at the first chosen slide, without reloading, and the address becomes ", h("code", {}, "?view=wallboard&slides=<ids>"),
        " so the choice can be bookmarked. Ids, in the default order: ", board.slideIds.join(", ") || "none configured",
        ". The order given is kept; unknown ids are dropped with a notice (duplicates silently); an empty or wholly unknown list shows every slide."),
    ],
  };
}

/** Research note behind the section (docs/research/): basis, denominator, omissions, probe facts. */
const WOMEN_RESEARCH_NOTE = "docs/research/2026-10-21-wipo-women-inventors.md";

function womenGroupPart({ overview, groups, entities }: MethodsData): Child[] {
  const label = labelOfEntities(entities);
  const summary = overview.gender?.groups;
  const source = overview.gender?.printed_source;
  const leftOut = summary ? groups.items.flatMap((group) => {
    const codes = summary[group.id]?.unlisted ?? [];
    return codes.length ? [{ group, text: unlistedMembersText(codes.map((code) => `${label(code)} (${code})`), group.members.length) }] : [];
  }) : null;
  const printed = summary ? groups.items.flatMap((group) => (Object.keys(GENDER_TITLES) as (keyof typeof GENDER_TITLES)[]).flatMap((measure) =>
    measure === "women_any_by_field" ? [] : Object.entries(summary[group.id]?.printed?.[measure] ?? {}).map(([year, value]) =>
      ({ group, measure, year, value, ref: summary[group.id]?.printed_refs?.[measure]?.[year] })))) : null;
  return [
    h("p", {}, `${GENDER_TITLES.women_any} for a continent or region is ${GENDER_BASIS_LABEL.computed}: the mean of its members' `,
      "published shares, each weighted by the member's own PCT publications of the same publication year (WIPO table 1010, class Total, by origin). ",
      `A year is shown only when the members with a published share hold at least ${coverageFloorText(overview)} of the group's PCT publications `,
      "(the coverage floor); below it the year reads “no data reported”. The coverage is shown beside “n of m”. ",
      `A value is never an average of the two measures, and a figure computed this way is labelled “${GENDER_BASIS_LABEL.computed}”, `,
      `one WIPO publishes is labelled “${GENDER_BASIS_LABEL.wipo}”.`),
    h("p", {}, "“n of m members”: n = the members with a published share that year; m = the members with a PCT publications row. ",
      "Members left out of m are named per group:"),
    leftOut === null
      ? h("p", { class: "muted" }, "The data carry no group summary, so the left-out members are not listed here.")
      : leftOut.length === 0 ? h("p", { class: "muted" }, "No member is left out.")
        : h("ul", { class: "women-left-out" }, leftOut.map(({ group, text }) => h("li", {}, `${group.label}: ${text}`))),
    h("p", {}, `${GENDER_TITLES.women_share} is ${genderNullText("not_computable", overview)} for a group, since a share of inventors cannot be averaged without them. `,
      "The exception is a figure WIPO itself prints, shown as published and labelled “", GENDER_BASIS_LABEL.wipo, "”:"),
    printed === null || printed.length === 0
      ? h("p", { class: "muted" }, "No printed group figure in the data.")
      : h("ul", { class: "women-printed" }, printed.map(({ group, measure, year, value, ref }) => {
        const name = group.kind === "region" ? `${group.label}, region ${group.id}` : group.label;
        return h("li", {}, `${formatShare(value, genderDecimals(overview))}: ${name}, ${GENDER_TITLES[measure]}, ${year}`,
          h("span", { class: "women-printed-ref" }, ref ? `; figure ${ref.figure}, ${ref.page}` : "; figure and page not recorded"));
      })),
    source && h("p", { class: "women-printed-source" }, `Source of the printed figures: ${source.citation}. `, h("a", { href: source.url, rel: "noopener" }, source.url)),
  ];
}

function womenCrosscheck({ manifest, overview }: MethodsData, gm: NonNullable<Overview["method"]["gender"]>): Child[] {
  const check = manifest.checks.gender;
  const decimals = genderDecimals(overview);
  const pp = (value: number): string => `${fixedHalfAway(value, decimals)} pp`;
  // printed continent figures of the measure: none today (WIPO prints no continent women_any), so nothing is compared
  const printedAny = Object.values(overview.gender?.groups ?? {}).reduce((sum, group) => sum + Object.keys(group.printed?.women_any ?? {}).length, 0);
  return [
    h("p", {}, `Each year the mean of the countries' published ${GENDER_TITLES.women_any} shares, weighted by PCT publications, is compared with WIPO's own World row. `,
      "A year with a gap above the tolerance is a warning and is listed here. When that holds in at most half of the compared years, the refresh goes on with the warnings; ",
      "when it holds in more than half of them, the weighting no longer reproduces WIPO and the refresh is blocked."),
    printedAny === 0
      ? h("p", {}, `WIPO's PCT Yearly Review 2026 prints no continent figure for ${GENDER_TITLES.women_any}, so a comparison of the computed continent values with it `,
        "compares nothing in this release; it runs when one is entered.")
      : h("p", {}, `Each continent's computed ${GENDER_TITLES.women_any} is also compared with the continent figure WIPO prints in its report, for the years it prints one `,
        `(${printedAny} ${printedAny === 1 ? "figure" : "figures"} in this release). A gap above the tolerance there is a warning only, listed here; it never blocks the refresh.`),
    check === undefined ? h("p", { class: "muted" }, "Not recorded in this release.") : [
      h("dl", { class: "facts" },
        h("dt", {}, "Tolerance"), h("dd", {}, pp(gm.crosscheck_tolerance_pp)),
        h("dt", {}, "Years compared"), h("dd", {}, `${check.compared} years`),
        h("dt", {}, "Largest gap"), h("dd", {}, check.max_gap_pp === null ? "none compared" : pp(check.max_gap_pp)),
        h("dt", {}, "Years over the tolerance"), h("dd", {}, check.gap_years.length ? check.gap_years.join(", ") : "none"),
      ),
      list(check.warnings, "No warnings."),
    ],
  ];
}

/** A titled part of the section, addressable by `id` (a link target and a scope for the page's tests). */
function part(id: string, title: string, ...children: Child[]): HTMLElement {
  return h("div", { id, class: "women-part" }, h("h3", {}, title), children);
}

/** Years a women measure holds: first to last for the two country measures; for the field table the source's own years
 * (`overview.sources.women_any_by_field.years`, "a-b"), "<year> only" when one. */
function womenYearsText(id: GenderMeasure | "women_any_by_field", firstYear: number, lastYear: number, overview: Overview): string {
  if (id !== "women_any_by_field") return `${firstYear} to ${lastYear}`;
  const [from, to] = (overview.sources.women_any_by_field?.years ?? `${lastYear}-${lastYear}`).split("-");
  return from === to ? `${from} only (last year)` : `${from} to ${to}`;
}

function womenSection(data: MethodsData): Section | null {
  const { manifest, overview } = data;
  const gm = overview.method.gender;
  const gender = overview.gender;
  if (!gm || !gender) return null; // data written before v0.2w
  const labels = manifest.gender_labels;
  const measures: (GenderMeasure | "women_any_by_field")[] = ["women_any", "women_share", "women_any_by_field"];
  const note = gm.method_note;
  const methodologyHost = /methodology: (\S+?)\)/.exec(note.page)?.[1]; // WIPO's methodology page, named in the note's page text without a scheme
  const methodologyUrl = methodologyHost && (/^https?:\/\//.test(methodologyHost) ? methodologyHost : `https://${methodologyHost}`);
  const goldenIds = manifest.checks.golden_sources.filter((source) => source.id.startsWith("women_"));
  const goldenLines = manifest.checks.golden.filter((line) => line.startsWith("women_"));
  return {
    id: "women-inventors",
    title: "Women inventors",
    body: [
      h("p", {}, "WIPO's Data Center publishes shares only (no counts) of women inventors on PCT applications. Patent Atlas shows WIPO's figures as published, ",
        "by publication year, and computes group values only where the rule below allows it."),
      part("women-measures", "The two measures",
      h("p", {}, "They count different things and are never drawn on one axis. For the two country measures years run from ",
        `${gm.first_year}; the last year is the last with a World value, never later than the last PCT publications year. `,
        "The technology-field table is held for the years its data source records."),
      h("dl", { class: "facts" }, measures.flatMap((id) => [
        h("dt", {}, GENDER_TITLES[id]),
        h("dd", {}, `WIPO table “${labels?.[id] ?? "label not recorded"}”; ${womenYearsText(id, gm.first_year, gender.last_year[id], overview)}`,
          id === "women_any_by_field" ? ", world only" : "", ` (publication year, ${gm.decimals} ${gm.decimals === 1 ? "decimal" : "decimals"}).`),
      ]))),
      part("women-basis", "Basis and denominator",
      h("p", {}, "Shares are by publication year: WIPO counts published applications by their publication date, not by filing year. ",
        `WIPO's notes: ${note.citation}, ${note.page}. `, h("a", { href: note.url, rel: "noopener" }, note.url),
        methodologyUrl && [" How WIPO attributes gender to inventors: its methodology page, ", h("a", { href: methodologyUrl, rel: "noopener" }, methodologyUrl), "."]),
      h("p", {}, "The denominator (all applications, or only those whose inventors WIPO could attribute a gender to) is not stated in the PCT Yearly Review 2026; ",
        "WIPO's methodology pages are not checked here, and Patent Atlas does not guess it. ",
        `Basis, denominator and the checks behind them: Patent Atlas research note ${WOMEN_RESEARCH_NOTE}.`),
      h("p", {}, "Weights for group values are PCT publications by origin (WIPO table 1010, class Total, by publication year), ",
        "never filings by filing year.")),
      part("women-omissions", "Omissions",
      h("p", {}, "WIPO leaves some origin-years out. Patent Atlas shows such a year as “no data reported” with the reason “", genderNullText("not_published", overview),
        "”: never 0, never interpolated. The omissions are not explained by size alone: the research note finds that no origin-year with few PCT publications is published, ",
        "yet some origin-years above that size are still unpublished (research note, section on omissions). So no small-count rule is added: a share WIPO publishes is shown, ",
        "and the country ranking shows each origin's PCT publications beside it. ",
        `Listed origins with no value in any year: ${formatCount(manifest.absent_rows.women_any)} for ${GENDER_TITLES.women_any}, `,
        `${formatCount(manifest.absent_rows.women_share)} for ${GENDER_TITLES.women_share}.`)),
      part("women-groups", "Continents and regions", womenGroupPart(data)),
      part("women-fields", "Technology fields",
        h("p", {}, `${GENDER_TITLES.women_any_by_field} is published for the world only: the Data Center has no split by country, region or continent, so none is shown. `,
          "The PCT Yearly Review prints a table (A26: women's share by region and technology field) and a figure (A27: by top-10 origin and technology field); they are not in this version.")),
      part("women-crosscheck", "Cross-checks against WIPO's figures", womenCrosscheck(data, gm)),
      part("women-golden", "Published WIPO figures",
      h("p", {}, `The World figures and one country figure printed in the PCT Yearly Review are compared with the Data Center (blocking; each within ${overview.method.golden_tolerance_pct}% of its printed value, a relative tolerance, not the cross-check tolerance in pp):`),
      list(goldenLines, "No figures compared."),
      h("ul", { class: "women-golden-sources" }, goldenIds.map((src) => h("li", {},
        h("code", {}, src.id), `: ${src.citation}. ${src.page}. `, h("a", { href: src.url, rel: "noopener" }, src.url))))),
      part("women-caveat", "Caveat", genderCaveat(overview).map((line) => h("p", {}, line))),
    ],
  };
}

function disclaimerSection(): Section {
  return {
    id: "disclaimer",
    title: "Disclaimer",
    body: [h("p", { class: "disclaimer" }, DISCLAIMER), h("p", {}, "Patent Atlas is independent and not affiliated with or endorsed by WIPO.")],
  };
}

export function renderMethods(el: HTMLElement, data: MethodsData): void {
  const sections = [
    sourcesSection(data), definitionsSection(data), groupingsSection(data), worldSection(data), seriesBreaksSection(data),
    yearsSection(data), formulasSection(data), scaleSection(data), mapSection(data), pctMembershipSection(data), womenSection(data), checksSection(data), ratioCheckSection(data), revisionsSection(), wallboardSection(data),
    disclaimerSection(),
  ].filter((section): section is Section => section !== null);
  el.replaceChildren(
    h("header", { class: "page-intro" },
      h("h1", {}, "Methods and sources"),
      h("p", { class: "lede" }, "Where every figure comes from, how it is computed, and how it is checked against independent sources."),
      h("p", { class: "methods-made" }, AI_METHODS_LINE),
    ),
    h("div", { class: "prose-layout" },
      h("nav", { class: "toc", "aria-label": "On this page" },
        h("ul", {}, sections.map((section) => h("li", {}, h("a", { href: `#${section.id}` }, section.title))))),
      h("div", { class: "prose" },
        sections.map((section) => h("section", { id: section.id }, h("h2", {}, section.title), section.body))),
    ),
  );
}
