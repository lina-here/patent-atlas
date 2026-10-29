// Country page (`?country=`: origin, office and PCT series + key-figure tiles + comparison with its region) and office
// page (`?office=`, regional offices: office series + tiles with resident share). Every number, year and label is read
// from entity/<code>.json, overview.json and the region's group file; a series with only nulls is named "no data
// reported", never drawn and never shown as 0.
import type { GroupFigures, GroupItem, GroupsFile } from "./atlas";
import type { CardContext } from "./chartCard";
import { lineChart, type LinePoint } from "./charts";
import { loadJson, type Entities, type EntityFile, type Manifest, type Overview, type RatioId, type SeriesBlock, type SeriesId, type SourceBlock, type YearMap } from "./data";
import { h, formatCount } from "./dom";
import { fixedHalfAway } from "./format";
import { ENTITY_WOMEN_CARD_ID, entityWomenCard } from "./genderCards";
import { PCT_LATE_FILINGS, RANK_BASIS, SERIES_TITLES, originAbroadNote, seriesBreakNotes } from "./methods";
import { renderCards, type CardBuilder, type CardContent } from "./overview";
import { renderPicker } from "./picker";
import { RATIO_BASIS_LABEL, RATIO_TITLES, formatRatio, gdpBasisLabel, isWipoRatio, ratioNullText, shownRatios, wdiCredit, worldBasisText } from "./ratioText";
import { themeLoaded } from "./theme";

export type EntityPageKind = "country" | "office";
export type EntityPageContext = CardContext & { entities: Entities; overview: Overview };
/** A country's UN M49 region (groups.json item) and its figures (group/<id>.json): the region comparison card. */
export type CountryRegion = { group: GroupItem; figures: GroupFigures };

type TypeKey = keyof SeriesBlock["types"];

/** Lines per series, in legend order (type keys of entity files). */
const SERIES_LINES: Record<SeriesId, { key: TypeKey; label: string }[]> = {
  origin_apps: [{ key: "total", label: "Total" }, { key: "resident", label: "Resident" }, { key: "abroad", label: "Abroad" }],
  office_apps: [{ key: "total", label: "Total" }, { key: "resident", label: "Resident" }, { key: "nonresident", label: "Non-resident" }],
  pct_origin: [{ key: "total", label: "Total" }],
};

/** Stable card ids (shared links, embed `?chart=`). */
export const SERIES_CARD_IDS: Record<SeriesId, string> = {
  origin_apps: "origin-apps",
  office_apps: "office-apps",
  pct_origin: "pct-origin",
};
export const TILES_CARD_ID = "entity-tiles";
export const REGION_COMPARE_CARD_ID = "region-compare";
export const SCALE_CARD_ID = "entity-scale";
/** Index decimals (100 = panel first year): display precision of the region comparison. */
const INDEX_DECIMALS = 1;

const PAGE_SERIES: Record<EntityPageKind, SeriesId[]> = {
  country: ["origin_apps", "office_apps", "pct_origin"],
  office: ["office_apps"],
};

const KIND_LINE = { country: "Country", historical: "Former state or territory", regional_office: "Regional office" } as const;

function seriesNote(series: SeriesId, file: EntityFile): string {
  const name = file.label;
  if (series === "origin_apps") {
    return `Applications by residents of ${name} at any office: resident = at their own office or a regional office ` +
      "covering it; abroad = at foreign offices. Origin = residence of the first-named applicant.";
  }
  if (series === "office_apps") {
    return file.kind === "regional_office"
      ? `Applications received by the ${name}: resident = applicants residing in its member states; non-resident = everyone else.`
      : `Applications received by the office of ${name}: resident = applicants residing there; non-resident = everyone else.`;
  }
  return `International (PCT) applications by residents of ${name}, by filing date. ${PCT_LATE_FILINGS}`;
}

/** Years up to `lastYear` with at least one value in the series' lines, ascending. */
function reportedYears(block: SeriesBlock, series: SeriesId, lastYear: number): number[] {
  const years = new Set<number>();
  for (const { key } of SERIES_LINES[series]) {
    for (const [year, value] of Object.entries(block.types[key] ?? {})) {
      if (value !== null && Number(year) <= lastYear) years.add(Number(year));
    }
  }
  return [...years].sort((a, b) => a - b);
}

/** Series of this page with data, and those without (absent from the file or all null). */
function splitSeries(file: EntityFile, overview: Overview, kind: EntityPageKind): { shown: SeriesId[]; missing: SeriesId[] } {
  const shown: SeriesId[] = [];
  const missing: SeriesId[] = [];
  for (const series of PAGE_SERIES[kind]) {
    const block = file.series[series];
    const source = file.sources[series];
    if (block && source && reportedYears(block, series, overview.last_year[series]).length > 0) shown.push(series);
    else missing.push(series);
  }
  return { shown, missing };
}

function seriesCard(file: EntityFile, overview: Overview, series: SeriesId): CardBuilder["build"] {
  return () => {
    const block = file.series[series];
    const source = file.sources[series];
    if (!block || !source) return null;
    const reported = reportedYears(block, series, overview.last_year[series]);
    if (reported.length === 0) return null;
    const first = reported[0];
    const last = reported[reported.length - 1];
    const years = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    const lines = SERIES_LINES[series].filter(({ key }) => block.types[key]);
    const single = lines.length === 1;
    const valueOf = (key: TypeKey, year: number): number | null => block.types[key]?.[String(year)] ?? null;
    const points: LinePoint[] = lines.flatMap(({ key, label }) =>
      years.map((year) => ({ year, value: valueOf(key, year), ...(single ? {} : { key: label }) })));
    const footnotes = [
      ...(series === "origin_apps" ? [originAbroadNote(overview)] : []),
      ...seriesBreakNotes(overview, { code: file.code, series, first, last }),
    ];
    return {
      title: `${SERIES_TITLES[series]}, ${first === last ? first : `${first}–${last}`}`,
      note: seriesNote(series, file),
      ...(footnotes.length > 0 ? { footnotes } : {}),
      draw: (width) => lineChart(points, single ? { width } : { width, keys: lines.map((line) => line.label) }),
      table: {
        headers: ["Year", ...lines.map((line) => line.label)],
        rows: [...years].reverse().map((year) => [String(year), ...lines.map(({ key }) => valueOf(key, year))]),
        numeric: [true, ...lines.map(() => true)],
      },
      source,
    };
  };
}

type Tile = { label: string; value: string };
type TileGroup = { series: SeriesId; year: number; tiles: Tile[]; source: SourceBlock };

/** A percent tile value: "–" when null; `signed` puts "+" before a gain. */
export function percent(value: number | null | undefined, places: number, signed = false): string {
  if (value === null || value === undefined) return "–";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(places)}%`;
}

/** Share already rounded by the pipeline to `places`: a 0 with a count above 0 is "<0.01%" (smallest step of
 * `places`), so a shown 0 stays a 0 WIPO reported (methods page). */
function sharePercent(share: number | null, part: number | null, places: number): string {
  if (share === 0 && part !== null && part > 0) return `<${(10 ** -places).toFixed(places)}%`;
  return percent(share, places);
}

/** Last year with rank and share: the cut-off of the world the series is ranked in (pipeline/write.py
 * WORLD_OF_SERIES); origin_apps' world (world_origin) is unpublished, its cut-off is `top_year`. */
const RANK_SHARE_LAST_YEAR: Record<SeriesId, (overview: Overview) => number> = {
  origin_apps: (overview) => overview.top_year,
  office_apps: (overview) => overview.world_last_year.world_office,
  pct_origin: (overview) => overview.world_last_year.pct_world,
};

/** Tile year: the series' latest complete year (overview.last_year); a former entity's last reported year. */
function tileYear(file: EntityFile, block: SeriesBlock, lastYear: number): number | null {
  if (file.kind !== "historical") return lastYear;
  const reported = Object.entries(block.types.total)
    .filter(([year, value]) => value !== null && Number(year) <= lastYear)
    .map(([year]) => Number(year));
  return reported.length ? Math.max(...reported) : null;
}

function tileGroup(file: EntityFile, overview: Overview, series: SeriesId): TileGroup | null {
  const block = file.series[series];
  const source = file.sources[series];
  if (!block || !source) return null;
  const lastYear = overview.last_year[series];
  const year = tileYear(file, block, lastYear);
  if (year === null) return null;
  const at = (map: YearMap): number | null => map[String(year)] ?? null;
  const { cagr_years: cagrYears, rounding: { decimals } } = overview.method;
  const derived = block.derived;
  const tiles: Tile[] = [
    { label: `Applications, ${year}`, value: formatCount(at(block.types.total)) },
    { label: `Change from ${year - 1}`, value: percent(at(derived.yoy), decimals.yoy, true) },
  ];
  // cagr10 is computed for the series' latest year (pipeline/write.py), so its period ends there; a former
  // entity has no value then (no tile)
  if (file.kind !== "historical") {
    tiles.push({ label: `Annual growth ${lastYear - cagrYears}–${lastYear}`, value: percent(derived.cagr10, decimals.cagr, true) });
  }
  // rank and share stop at the world cut-off (later years provisional), which can be before the series' last year
  const rankShareYear = Math.min(year, RANK_SHARE_LAST_YEAR[series](overview));
  const atRankShare = (map: YearMap): number | null => map[String(rankShareYear)] ?? null;
  // ranked: countries only (former states and regional offices are never ranked)
  if (file.kind === "country") {
    const rank = atRankShare(derived.rank);
    tiles.push({ label: `Rank among ${RANK_BASIS[series]}, ${rankShareYear}`, value: rank === null ? "–" : String(rank) });
  }
  tiles.push({
    label: `Share of ${overview.share_denominator[series]}, ${rankShareYear}`,
    value: sharePercent(atRankShare(derived.share), atRankShare(block.types.total), decimals.share),
  });
  if (series === "office_apps") {
    tiles.push({
      label: `Resident share, ${year}`,
      value: sharePercent(at(derived.resident_share), block.types.resident ? at(block.types.resident) : null, decimals.resident_share),
    });
  }
  return { series, year, tiles, source };
}

function tilesFigure(groups: TileGroup[]): HTMLElement {
  return h("div", { class: "entity-tiles" },
    groups.map((group) => h("section", { class: "tile-group", "data-series": group.series },
      h("h3", {}, SERIES_TITLES[group.series]),
      h("dl", { class: "tiles" }, group.tiles.map((tile) => h("div", { class: "tile" },
        h("dt", { class: "tile-label" }, tile.label),
        h("dd", { class: "tile-value" }, tile.value)))),
    )));
}

function tilesCard(file: EntityFile, overview: Overview, series: SeriesId[]): CardBuilder["build"] {
  return () => {
    const groups = series.map((id) => tileGroup(file, overview, id)).filter((group): group is TileGroup => group !== null);
    if (groups.length === 0) return null;
    const content: CardContent = {
      title: `Key figures: ${file.label}`,
      note: `${file.kind === "historical" ? "Last year reported for each series" : "Latest complete year of each series"}; ` +
        `${file.kind === "country" ? "growth, ranks and shares" : "growth and shares"} computed by Patent Atlas (see methods). ` +
        "– = no data reported." + (groups.some((group) => group.series === "pct_origin") ? ` ${PCT_LATE_FILINGS}` : ""),
      // a former entity's origin tiles can show a year before origin_abroad_from
      ...(groups.some((group) => group.series === "origin_apps" && group.year < overview.method.origin_abroad_from)
        ? { footnotes: [originAbroadNote(overview)] } : {}),
      draw: () => tilesFigure(groups),
      table: {
        headers: ["Series", "Figure", "Value"],
        rows: groups.flatMap((group) => group.tiles.map((tile) => [SERIES_TITLES[group.series], tile.label, tile.value])),
        numeric: [false, false, true],
      },
      source: groups.map((group) => group.source),
    };
    return content;
  };
}

/** A scale tile: the ratio's title with its year, the value, then lines under it (basis or reason, region, World), each
 * with its class (`tile-basis`, `tile-region`, `tile-world`). */
export type ScaleTile = { id: RatioId; year: number; value: string; lines: { cls: string; text: string }[] };

export function scaleTilesFigure(tiles: ScaleTile[]): HTMLElement {
  return h("dl", { class: "tiles scale-tiles" }, tiles.map((tile) => h("div", { class: "tile", "data-ratio": tile.id },
    h("dt", { class: "tile-label" }, `${RATIO_TITLES[tile.id]}, ${tile.year}`),
    h("dd", { class: "tile-value" }, tile.value),
    tile.lines.map((line) => h("dd", { class: `tile-label ${line.cls}` }, line.text)))));
}

/** Whether a ratio map has a value in a year up to `last`. */
export function hasRatioValue(values: YearMap, last: number): boolean {
  return Object.entries(values).some(([year, value]) => value !== null && Number(year) <= last);
}

/** Years of a ratio map up to `last`, latest first. */
export function ratioYears(values: YearMap, last: number): number[] {
  return Object.keys(values).map(Number).filter((year) => year <= last).sort((a, b) => b - a);
}

/** Distinct source blocks (one query line each). */
export function distinctSources(sources: (SourceBlock | undefined)[]): SourceBlock[] {
  const seen = new Map<string, SourceBlock>();
  for (const source of sources) if (source) seen.set(JSON.stringify(source), source);
  return [...seen.values()];
}

/** Country scale card: per ratio a tile for its `ratio_last_year`: the country's value (WIPO's, or computed) or "–" and
 * the reason, the region's value with "n of m" members, World's value for the same year (never a later one). Left out
 * when no ratio has a value. */
function scaleCard(file: EntityFile, overview: Overview, manifest: Manifest, region: CountryRegion | null | undefined): CardBuilder["build"] {
  return () => {
    const method = overview.method.ratios;
    const ratios = file.ratios;
    if (!method || !ratios) return null;
    const shown = shownRatios(overview).filter(({ id }) => ratios[id]);
    if (!shown.some(({ id, year }) => hasRatioValue(ratios[id]!.value, year))) return null;
    const format = (value: number | null | undefined): string => formatRatio(value ?? null, method.decimals);
    const country = (id: RatioId, year: number): { value: string; basis: string } => {
      const block = ratios[id]!;
      const value = block.value[String(year)] ?? null;
      if (value === null) {
        const reason = block.null_reason[String(year)];
        return { value: "–", basis: reason ? `no data reported: ${ratioNullText(reason, id, overview)}` : "no data reported" };
      }
      return { value: format(value), basis: block.computed.includes(year) ? RATIO_BASIS_LABEL.computed : RATIO_BASIS_LABEL.wipo };
    };
    const group = (id: RatioId, year: number): { value: string; members: string; line: string } | null => {
      const figures = region?.figures.ratios?.[id];
      if (!region || !figures) return null;
      const value = figures.value[String(year)] ?? null;
      const reason = figures.null_reason[String(year)];
      const members = `${figures.reporting[String(year)] ?? 0} of ${figures.members}`;
      if (value !== null) return { value: format(value), members, line: `${region.group.label}: ${format(value)} (${members} members)` };
      const why = reason ? `no data reported: ${ratioNullText(reason, id, overview, "group")}` : "no data reported";
      return { value: why, members, line: `${region.group.label}: – (${why}, ${members} members)` };
    };
    const world = (id: RatioId, year: number): string => format(overview.world_ratios?.[id]?.[String(year)]);
    const tiles: ScaleTile[] = shown.map(({ id, year }) => {
      const own = country(id, year);
      const beside = group(id, year);
      return { id, year, value: own.value, lines: [{ cls: "tile-basis", text: own.basis },
        ...(beside ? [{ cls: "tile-region", text: beside.line }] : []), { cls: "tile-world", text: `World: ${world(id, year)}` }] };
    });
    const ids = shown.map(({ id }) => id);
    const gdpComputed = shown.some(({ id, year }) => method.denominator[id] === "gdp_ppp" &&
      (ratios[id]!.computed.length > 0 || Boolean(region?.figures.ratios?.[id] && hasRatioValue(region.figures.ratios[id]!.value, year))));
    const numerator = (id: RatioId): SeriesId => method.numerator[id].series;
    const source = distinctSources(shown.flatMap(({ id }) => [
      ...(isWipoRatio(id, overview) ? [file.sources[id], overview.sources[id]] : [overview.sources[numerator(id)]]),
      ...(!isWipoRatio(id, overview) || ratios[id]!.computed.length > 0 ? [file.sources[numerator(id)]] : []),
      ...(region?.figures.ratios?.[id] ? [overview.sources[numerator(id)]] : []),
    ]));
    if (source.length === 0) return null;
    const regionLabel = region?.figures.ratios ? region.group.label : undefined; // no region sentence without ratio figures
    // M4: a break in the numerator series the table spans (CN 2017, origin_apps)
    const footnotes = [...new Set(shown.flatMap(({ id, year }) => {
      const years = ratioYears(ratios[id]!.value, year);
      return years.length === 0 ? [] : seriesBreakNotes(overview,
        { code: file.code, series: numerator(id), first: years[years.length - 1], last: years[0], growth: false });
    }))];
    return {
      title: `Per capita and per GDP: ${file.label}`,
      note: `${file.label}: WIPO's published figure (“${RATIO_BASIS_LABEL.wipo}”) where it has one, else ` +
        `${RATIO_BASIS_LABEL.computed} (applications ÷ population or GDP); no value where population or GDP is at or below ` +
        "the threshold WIPO applies to its per-million and per-GDP figures (PCT per million uses the population threshold WIPO " +
        "uses for its per-million figures). " +
        (regionLabel ? `${regionLabel}: the sum of its members' applications ÷ the sum of their population or GDP, over the ` +
          "members with both values that year (“n of m” members). " : "") +
        `World: ${worldBasisText(ids, overview)}. – = no data reported.` + (gdpComputed ? ` ${gdpBasisLabel(manifest)}.` : ""),
      ...(footnotes.length > 0 ? { footnotes } : {}),
      draw: () => scaleTilesFigure(tiles),
      table: {
        headers: ["Measure", "Year", "Country", "Basis", "Region", "Members reporting", "World"],
        rows: shown.flatMap(({ id, year: last }) => ratioYears(ratios[id]!.value, last).map((year) => {
          const own = country(id, year);
          const beside = group(id, year);
          return [RATIO_TITLES[id], String(year), own.value, own.basis, beside?.value ?? "–", beside?.members ?? "–", world(id, year)];
        })),
        numeric: [false, true, true, false, true, false, true],
      },
      source,
      dataCredits: [wdiCredit(manifest)],
    };
  };
}

/** Region comparison (applications by origin): the country and its region's fixed panel (members reporting in every
 * year of the window; pipeline/groups.py `panel`) indexed to 100 at the panel's first year, and the country's share of
 * the panel total. `leftOut` = why there is no card (country not in the panel, no panel, a zero base year). */
export function regionComparison(file: EntityFile, overview: Overview, region: CountryRegion, entities: Entities): { content: CardContent } | { leftOut: string } {
  const label = region.group.label;
  const series = region.figures.series.origin_apps;
  const panel = series?.panel;
  const own = file.series.origin_apps?.types.total;
  const source = file.sources.origin_apps;
  if (!own || !source) {
    return { leftOut: `No comparison with ${label}: ${file.label} has no applications by origin reported by WIPO.` };
  }
  if (!series || !panel || panel.first === null || panel.last === null) {
    return { leftOut: `No comparison with ${label}: the region has no fixed panel of members reporting applications by origin.` };
  }
  const { first, last } = panel;
  const span = `${first}–${last}`;
  if (!panel.members.includes(file.code)) {
    return { leftOut: `No comparison with ${label}: ${file.label} did not report applications by origin in every year ${span}, ` +
      `so it is not in the region's fixed panel (the members reporting in all those years).` };
  }
  if (panel.members.every((code) => code === file.code)) {
    return { leftOut: `No comparison with ${label}: ${file.label} is the only member of the region's fixed panel ` +
      `(the members reporting applications by origin in every year ${span}), so there is nothing to compare it with.` };
  }
  const years = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const ownAt = (year: number): number | null => own[String(year)] ?? null;
  const panelAt = (year: number): number | null => panel.total[String(year)] ?? null;
  const ownBase = ownAt(first);
  const panelBase = panelAt(first);
  if (!ownBase || ownBase <= 0) {
    return { leftOut: `No comparison with ${label}: ${file.label} reported no applications by origin in ${first}, the base year.` };
  }
  if (!panelBase || panelBase <= 0) {
    return { leftOut: `No comparison with ${label}: the region's fixed panel reported no applications by origin in ${first}, the base year.` };
  }
  const index = (value: number | null, base: number): number | null => (value === null ? null : (value * 100) / base);
  const regionKey = `${label} (panel)`;
  const points: LinePoint[] = years.flatMap((year) => [
    { year, value: index(ownAt(year), ownBase), key: file.label },
    { year, value: index(panelAt(year), panelBase), key: regionKey },
  ]);
  const places = overview.method.rounding.decimals.share;
  const share = (year: number): string => {
    const part = ownAt(year);
    const whole = panelAt(year);
    return part === null || !whole ? "–" : `${fixedHalfAway((part * 100) / whole, places)}%`;
  };
  const fixed = (value: number | null): string => (value === null ? "–" : fixedHalfAway(value, INDEX_DECIMALS));
  return {
    content: {
      title: `${file.label} compared with ${label}, applications by origin, ${span}`,
      note: `Index, ${first} = 100. ${label} = the sum of its fixed panel: the ${panel.members.length} of ${series.members} members ` +
        `reporting in every year ${span}, so the line does not move when a member stops or starts reporting.`,
      footnotes: [
        `Share of ${file.label} in the panel total: ${share(first)} in ${first}, ${share(last)} in ${last}.`,
        `Panel members: ${panel.members.map((code) => entities.find((entity) => entity.code === code)?.label ?? code)
          .sort((a, b) => a.localeCompare(b)).join(", ")}.`,
        originAbroadNote(overview),
        ...seriesBreakNotes(overview, { group: region.group.id, series: "origin_apps", first, last }),
      ],
      draw: (width) => lineChart(points, { width, keys: [file.label, regionKey] }),
      table: {
        headers: ["Year", `${file.label} (index)`, `${label} panel (index)`, `${file.label}, applications`, "Panel total", `Share of ${file.label}`],
        rows: [...years].reverse().map((year) => [String(year), fixed(index(ownAt(year), ownBase)), fixed(index(panelAt(year), panelBase)),
          ownAt(year), panelAt(year), share(year)]),
        numeric: [true, true, true, true, true, true],
      },
      source: [source, series.source],
    },
  };
}

/** The cards of a country or office page, in order (key figures first, full width, then a country's scale card; a lone
 * chart full width too; a country's women-inventor card, then the region comparison last, country pages with a region); series without data are left out (embed picks one by id). */
export function entityCards(file: EntityFile, overview: Overview, manifest: Manifest, kind: EntityPageKind, entities: Entities, region?: CountryRegion | null): CardBuilder[] {
  const { shown } = splitSeries(file, overview, kind);
  const lone = shown.length === 1;
  const compared = kind === "country" && region ? regionComparison(file, overview, region, entities) : null;
  return [
    { id: TILES_CARD_ID, build: tilesCard(file, overview, shown), wide: true },
    ...(kind === "country" ? [{ id: SCALE_CARD_ID, build: scaleCard(file, overview, manifest, region), wide: true }] : []),
    ...shown.map((series) => ({ id: SERIES_CARD_IDS[series], build: seriesCard(file, overview, series), wide: lone })),
    ...(kind === "country" ? [{ id: ENTITY_WOMEN_CARD_ID, build: () => entityWomenCard(file, overview, region, entities), wide: true }] : []),
    ...(compared && "content" in compared ? [{ id: REGION_COMPARE_CARD_ID, build: () => compared.content }] : []),
  ];
}

/** groups.json, or null when it cannot load (the page stands without the region parts). */
export function loadGroups(): Promise<GroupsFile | null> {
  return loadJson<GroupsFile>("data/groups.json").catch(() => null);
}

/** The country's region and its figures; null when it is in no region; an Error when the group file cannot load. */
export async function loadCountryRegion(code: string, groups: GroupsFile | null): Promise<CountryRegion | null | Error> {
  if (!groups) return new Error("groups.json could not be loaded");
  const group = groups.items.find((item) => item.kind === "region" && item.members.includes(code));
  if (!group) return null;
  try {
    return { group, figures: await loadJson<GroupFigures>(`data/group/${group.id}.json`) };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function entityHeader(file: EntityFile, ctx: EntityPageContext, groups: GroupsFile | null): HTMLElement {
  const picker = h("div", { class: "picker" });
  renderPicker(picker, ctx.entities, groups?.items ?? null, ctx, ctx.overview.size_growth);
  return h("header", { class: "page-intro entity-intro" },
    h("div", { class: "entity-title" },
      h("h1", {}, file.label),
      file.kind === "historical" ? h("span", { class: "badge" }, "former") : null,
    ),
    h("p", { class: "lede" }, `${KIND_LINE[file.kind]} · WIPO code ${file.code}`),
    picker,
  );
}

/** Renders the page for `code` (checked against entities.json by main.ts) into `el`. */
export async function renderEntityPage(el: HTMLElement, code: string, kind: EntityPageKind, ctx: EntityPageContext): Promise<void> {
  const [file, groups] = await Promise.all([loadJson<EntityFile>(`data/entity/${code}.json`), loadGroups()]);
  document.title = `${file.label} – ${ctx.cfg.siteName}`;
  const { shown, missing } = splitSeries(file, ctx.overview, kind);
  const header = entityHeader(file, ctx, groups);
  if (shown.length === 0) {
    el.replaceChildren(header,
      h("p", { class: "notice entity-missing" },
        `No data reported for ${file.label} in the WIPO series shown here (${PAGE_SERIES[kind].map((id) => SERIES_TITLES[id]).join("; ")}).`));
    return;
  }
  const grid = h("div", { id: "charts", class: "chart-grid" });
  const parts: HTMLElement[] = [header];
  if (missing.length) {
    parts.push(h("p", { class: "entity-missing" }, `No data reported: ${missing.map((id) => SERIES_TITLES[id]).join("; ")}.`));
  }
  const region = kind === "country" && file.kind === "country" ? await loadCountryRegion(file.code, groups) : null;
  if (region instanceof Error) {
    parts.push(h("p", { class: "region-compare-note" }, "The comparison with the region could not be loaded."));
  } else if (region) {
    const compared = regionComparison(file, ctx.overview, region, ctx.entities);
    if ("leftOut" in compared) parts.push(h("p", { class: "region-compare-note" }, compared.leftOut));
  }
  el.replaceChildren(...parts, grid);
  await themeLoaded();
  renderCards(grid, entityCards(file, ctx.overview, ctx.manifest, kind, ctx.entities, region instanceof Error ? null : region), ctx);
}
