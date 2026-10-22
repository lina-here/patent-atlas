// Women-inventors page (`?view=women-inventors`) and its three embeddable cards: the world trend of both WIPO measures
// (one chart each), applications with a woman inventor by technology field (world), and a sortable ranking of countries.
// All figures are WIPO's, as published, by PUBLICATION year; nothing is computed here. Every number, year and label is
// read from overview.json, entities.json and the two map files (map/women_any.json also holds the PCT publications).
import type { ChartTable, TableCell } from "./chartCard";
import { barChart, lineChart, type LinePoint } from "./charts";
import { loadJson, type Entities, type GenderMapFile, type GenderMeasure, type Overview, type SourceBlock, type YearMap } from "./data";
import { h, formatCount } from "./dom";
import type { EntityPageContext } from "./entityPage";
import { GENDER_BASIS_LABEL, GENDER_TITLES, NOT_PUBLISHED_SHORT, formatShare, genderCaveat, genderDecimals, genderNullText } from "./genderText";
import { pageLinkOf } from "./map";
import type { Params } from "./params";
import { REDRAW_ATTRIBUTE, renderCards, type CardBuilder } from "./overview";
import type { CardContext } from "./chartCard";
import { themeLoaded } from "./theme";

/** `?view=` value of the page (params.ts VIEWS). */
export const WOMEN_VIEW = "women-inventors";
export const WOMEN_TREND_ID = "women-world-trend";
export const WOMEN_FIELD_ID = "women-by-field";
export const WOMEN_RANKING_ID = "women-ranking";
export const WOMEN_CARD_IDS: string[] = [WOMEN_TREND_ID, WOMEN_FIELD_ID, WOMEN_RANKING_ID];

const MEASURES: GenderMeasure[] = ["women_any", "women_share"];
const RANKING_TITLE = "Women inventors by country";
/** Sort columns of the ranking, in table order. */
type SortKey = "label" | "publications" | "women_any" | "women_share";
const SORT_KEYS: SortKey[] = ["label", "publications", "women_any", "women_share"];

/** What the ranking reads: the countries (entities.json) and the two measures' map files (`women_any` also carries
 * `pct_publications`). No entity file is loaded. */
export type WomenRanking = { countries: Entities; women_any: GenderMapFile; women_share: GenderMapFile };

/** The ranking's data; an Error when a map file cannot be loaded (the ranking then shows why). */
export async function loadWomenRanking(entities: Entities): Promise<WomenRanking | Error> {
  try {
    const [women_any, women_share] = await Promise.all(MEASURES.map((measure) => loadJson<GenderMapFile>(`data/map/${measure}.json`)));
    return { countries: entities.filter((entity) => entity.kind === "country"), women_any, women_share };
  } catch (error) {
    console.error(error); // detail for the console; the card shows the sentence
    return error instanceof Error ? error : new Error(String(error));
  }
}

const sortedYears = (years: YearMap, last: number): number[] =>
  Object.keys(years).map(Number).filter((year) => year <= last).sort((a, b) => a - b);

function trendCard(overview: Overview): CardBuilder["build"] {
  return () => {
    const gender = overview.gender;
    const sources = MEASURES.map((measure) => overview.sources[measure]);
    if (!gender || sources.some((source) => !source)) return null;
    const decimals = genderDecimals(overview);
    const points = (measure: GenderMeasure): LinePoint[] => sortedYears(gender.world[measure], gender.last_year[measure])
      .map((year) => ({ year, value: gender.world[measure][String(year)] }));
    const years = MEASURES.flatMap((measure) => points(measure).filter((point) => point.value !== null).map((point) => point.year));
    if (years.length === 0) return null;
    const tableOf = (measure: GenderMeasure): ChartTable => ({
      headers: ["Year", GENDER_TITLES[measure]],
      rows: [...points(measure)].reverse().map((point) => [String(point.year), formatShare(point.value, decimals)]),
      numeric: [true, true],
    });
    return {
      title: `Women inventors in PCT applications, world, ${Math.min(...years)}–${Math.max(...years)}`,
      note: `WIPO's world figures (code ZZ), shown as published (${GENDER_BASIS_LABEL.wipo}), by publication year. Two measures, one ` +
        "chart each: they count different things and are never drawn on one axis.",
      draw: (width) => h("div", { class: "women-trends", [REDRAW_ATTRIBUTE]: "" },
        MEASURES.map((measure) => {
          const svg = lineChart(points(measure), { width, format: (value) => formatShare(value, decimals), tick: (value) => formatShare(value, 0) });
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", GENDER_TITLES[measure]);
          return h("div", { class: "women-trend" }, h("h3", {}, GENDER_TITLES[measure]), svg);
        })),
      table: tableOf("women_any"),
      moreTables: [{ caption: GENDER_TITLES.women_share, table: tableOf("women_share") }],
      footnotes: genderCaveat(overview),
      source: sources as SourceBlock[],
    };
  };
}

function fieldCard(overview: Overview): CardBuilder["build"] {
  return () => {
    const gender = overview.gender;
    const source = overview.sources.women_any_by_field;
    if (!gender || !source) return null;
    const fields = Object.values(gender.by_field);
    const rows = fields.flatMap((field) => (field.value === null ? [] : [{ label: field.label, value: field.value }]))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    if (rows.length === 0) return null;
    const year = gender.last_year.women_any_by_field;
    const decimals = genderDecimals(overview);
    const missing = fields.filter((field) => field.value === null).map((field) => field.label);
    return {
      title: `${GENDER_TITLES.women_any_by_field}, ${year}`,
      note: `Share of PCT applications published in ${year} with at least one woman inventor, in each technology field. ` +
        `WIPO publishes this by field for the world only; ${GENDER_BASIS_LABEL.wipo}'s figures, as published.`,
      draw: (width, height) => barChart(rows, { width, height, format: (value) => formatShare(value, decimals) }),
      table: {
        headers: ["Technology field", `${GENDER_TITLES.women_any}, ${year}`],
        rows: rows.map((row): TableCell[] => [row.label, formatShare(row.value, decimals)]),
        numeric: [false, true],
      },
      footnotes: [...(missing.length ? [`No data reported: ${missing.join("; ")}.`] : []), ...genderCaveat(overview)],
      source,
    };
  };
}

type RankingRow = { code: string; label: string; publications: number | null; women_any: number | null; women_share: number | null };

/** Nulls last in either direction; ties by label. */
function compareRows(key: SortKey, direction: 1 | -1): (a: RankingRow, b: RankingRow) => number {
  return (a, b) => {
    const left = key === "label" ? a.label : a[key];
    const right = key === "label" ? b.label : b[key];
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left === null || right === null || left === right) return a.label.localeCompare(b.label);
    return (typeof left === "string" ? left.localeCompare(right as string) : (left as number) - (right as number)) * direction;
  };
}

function rankingTable(rows: RankingRow[], headers: Record<SortKey, string>, year: number, overview: Overview, ctx: CardContext): HTMLElement {
  const decimals = genderDecimals(overview);
  const state: { key: SortKey; direction: 1 | -1 } = { key: "women_any", direction: -1 };
  const body = h("tbody");
  const heads = SORT_KEYS.map((key) => {
    const button = h("button", { type: "button", class: "sort-button" }, headers[key]);
    button.addEventListener("click", () => {
      state.direction = state.key === key ? (state.direction === 1 ? -1 : 1) : key === "label" ? 1 : -1;
      state.key = key;
      draw();
    });
    return h("th", { scope: "col", ...(key === "label" ? {} : { class: "num" }) }, button);
  });
  const cell = (text: string, missing: boolean): HTMLElement => h("td", { class: missing ? "num ranking-missing" : "num" }, text);
  const draw = (): void => {
    heads.forEach((head, index) => {
      if (SORT_KEYS[index] === state.key) head.setAttribute("aria-sort", state.direction === 1 ? "ascending" : "descending");
      else head.removeAttribute("aria-sort");
    });
    body.replaceChildren(...[...rows].sort(compareRows(state.key, state.direction)).map((row) =>
      h("tr", { "data-code": row.code },
        h("td", {}, h("a", { href: pageLinkOf("country", row.code, ctx).href, ...(ctx.compact ? { target: "_blank", rel: "noopener" } : {}) }, row.label)),
        cell(formatCount(row.publications), false),
        ...(["women_any", "women_share"] as const).map((measure) => cell(
          row[measure] === null ? NOT_PUBLISHED_SHORT : formatShare(row[measure], decimals), row[measure] === null)))));
  };
  draw();
  return h("div", { class: "table-scroll ranking-scroll" },
    h("table", { class: "data-table ranking-table", "aria-label": `${RANKING_TITLE}, ${year}` },
      h("thead", {}, h("tr", {}, heads)), body));
}

function rankingCard(overview: Overview, data: WomenRanking | Error, ctx: CardContext): CardBuilder {
  if (data instanceof Error) {
    return { id: WOMEN_RANKING_ID, wide: true, build: () => null,
      problem: { title: RANKING_TITLE, message: `The country data could not be loaded: ${data.message}` } };
  }
  return {
    id: WOMEN_RANKING_ID,
    wide: true,
    build: () => {
      const gender = overview.gender;
      const sources = [data.women_any.sources.women_any, data.women_share.sources.women_share, data.women_any.sources.pct_publications];
      if (!gender || sources.some((source) => !source) || !data.women_any.pct_publications) return null;
      const publications = data.women_any.pct_publications;
      // one publication year for the base and both shares: the last year both measures have a World value
      const year = Math.min(gender.last_year.women_any, gender.last_year.women_share);
      const newer = MEASURES.filter((measure) => gender.last_year[measure] > year)
        .map((measure) => `${GENDER_TITLES[measure]} also has ${gender.last_year[measure]}: see the world chart and the country pages.`);
      const rows: RankingRow[] = data.countries.flatMap((country) => data.women_any.values[country.code] ? [{
        code: country.code, label: country.label,
        publications: publications[country.code]?.[String(year)] ?? null,
        women_any: data.women_any.values[country.code][String(year)] ?? null,
        women_share: data.women_share.values[country.code]?.[String(year)] ?? null,
      }] : []);
      if (rows.length === 0) return null;
      const decimals = genderDecimals(overview);
      const headers: Record<SortKey, string> = {
        label: "Country",
        publications: `PCT publications, ${year}`,
        women_any: `${GENDER_TITLES.women_any}, ${year}`,
        women_share: `${GENDER_TITLES.women_share}, ${year}`,
      };
      const shown = [...rows].sort(compareRows("women_any", -1));
      return {
        title: `${RANKING_TITLE}, ${year}`,
        note: `WIPO's shares for ${year}, by publication year, as published (${GENDER_BASIS_LABEL.wipo}); sort by any column. ` +
          "PCT publications = the country's PCT applications published that year (WIPO indicator 1010), shown so the size of each " +
          "country's figures is visible; the PCT Yearly Review 2026 does not state the denominator of the shares.",
        draw: () => rankingTable(rows, headers, year, overview, ctx),
        table: {
          headers: SORT_KEYS.map((key) => headers[key]),
          rows: shown.map((row): TableCell[] => [{ text: row.label, ...pageLinkOf("country", row.code, ctx) }, row.publications,
            row.women_any === null ? NOT_PUBLISHED_SHORT : formatShare(row.women_any, decimals),
            row.women_share === null ? NOT_PUBLISHED_SHORT : formatShare(row.women_share, decimals)]),
          numeric: [false, true, true, true],
        },
        footnotes: [
          `“${NOT_PUBLISHED_SHORT}” = ${genderNullText("not_published", overview)}: WIPO omits some countries' years, so the ` +
            "country's page may show a share for other years. – = no count reported.",
          ...newer,
          ...genderCaveat(overview),
        ],
        source: sources as SourceBlock[],
      };
    },
  };
}

/** The three cards, in order (embed picks one by id). `ranking` = the ranking's data (or the load error); null = not loaded:
 * the ranking card is left out. */
export function womenCards(overview: Overview, ranking: WomenRanking | Error | null, ctx: CardContext): CardBuilder[] {
  // cite, share and embed links of a card reach the page's chart; a country, office, region or continent in the address
  // (a stray one in an embed) must not travel with them, it would win over the view
  const view = (): Partial<Params> => ({ view: WOMEN_VIEW, country: undefined, office: undefined, region: undefined, continent: undefined });
  return [
    { id: WOMEN_TREND_ID, wide: true, build: trendCard(overview), params: view },
    { id: WOMEN_FIELD_ID, wide: true, build: fieldCard(overview), params: view },
    ...(ranking ? [{ ...rankingCard(overview, ranking, ctx), params: view }] : []),
  ];
}

/** Renders the women-inventors page into `el`. */
export async function renderWomenPage(el: HTMLElement, ctx: EntityPageContext): Promise<void> {
  const { overview, cfg } = ctx;
  document.title = `Women inventors – ${cfg.siteName}`;
  const note = overview.method.gender?.method_note;
  const [caveat] = genderCaveat(overview);
  const header = h("header", { class: "page-intro" },
    h("h1", {}, "Women inventors in PCT applications"),
    h("p", { class: "lede" },
      "How large is the share of women among inventors in international (PCT) patent applications, and how does it differ " +
      "between countries and technology fields? WIPO's figures, as published, by publication year."),
    h("p", { class: "women-caveat" }, caveat, " ",
      note ? ["WIPO's method note: ", h("a", { href: note.url, rel: "noopener" }, note.citation), `, ${note.page}.`] : "WIPO's method note: not recorded."));
  if (!overview.gender) {
    el.replaceChildren(header, h("p", { class: "notice entity-missing" }, "No women-inventor data in this data set."));
    return;
  }
  const grid = h("div", { id: "charts", class: "chart-grid" });
  el.replaceChildren(header, grid);
  const ranking = await loadWomenRanking(ctx.entities);
  await themeLoaded();
  renderCards(grid, womenCards(overview, ranking, ctx), ctx);
}
