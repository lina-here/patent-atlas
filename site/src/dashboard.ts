// Dashboard (`?view=dashboard`, spec 2a): a glanceable summary whose tiles link to the full charts. Row 1: four key-figure
// tiles (world patents, world PCT, top origin, fastest grower among the top origins); row 2: the carousel (carousel.ts:
// `dashboard.slides`, each a full card fitted to the stage) and the world map; row 3: the treemap and the share-shift card.
// Every tile is a full chart card (Show figures, Cite, Embed, a same-tab link to its overview chart). Every figure is a
// pipeline field of overview.json, never computed here; a missing figure reads "–" with its reason.
import type { Atlas } from "./atlas";
import { startCarousel } from "./carousel";
import type { CardContext } from "./chartCard";
import type { Entities, Overview, SeriesId, SourceBlock, WorldId } from "./data";
import { h, formatCount } from "./dom";
import { percent } from "./entityPage";
import { MAP_CARD_ID, type MapContext } from "./map";
import { PCT_LATE_FILINGS, WORLD_TITLES, seriesBreaksIn, seriesBreakNotes } from "./methods";
import { WORLD_SERIES, renderCards, worldCards, type CardBuilder, type CardContent } from "./overview";
import { SHARE_SHIFT_CARD_ID, shareShiftCard } from "./shareShift";
import { themeLoaded } from "./theme";
import { TREEMAP_CARD_ID, treemapCard } from "./treemap";

/** `?view=` value of the page (params.ts VIEWS). */
export const DASHBOARD_VIEW = "dashboard";
/** The tiles' card ids, in page order (the key figures, then MAP_CARD_ID, TREEMAP_CARD_ID, SHARE_SHIFT_CARD_ID). */
export const DASHBOARD_TILE_IDS = ["key-world-patents", "key-world-pct", "key-top-origin", "key-top-grower", "world-map", "treemap", "share-shift"];

const [KEY_WORLD_PATENTS, KEY_WORLD_PCT, KEY_TOP_ORIGIN, KEY_TOP_GROWER] = DASHBOARD_TILE_IDS;
const NO_DATA = "There is no data to draw this chart.";
/** Titles of the chart tiles when their data is absent (older data): the tile shows the reason, never a gap. */
const MISSING_TITLES: Record<string, string> = {
  [MAP_CARD_ID]: "World map", [TREEMAP_CARD_ID]: "Who files the world's patents?", [SHARE_SHIFT_CARD_ID]: "Who gained and lost ground?",
};

/** One figure of a key-figure tile: `id` = its `data-figure`; `reason` = why the value is "–". */
type KeyFigure = { id: string; label: string; value: string; reason?: string };

function figuresVisual(figures: KeyFigure[]): HTMLElement {
  return h("dl", { class: "tiles key-figures" }, figures.map((figure) => h("div", { class: "tile", "data-figure": figure.id },
    h("dt", { class: "tile-label" }, figure.label),
    h("dd", { class: "tile-value" }, figure.value),
    figure.reason ? h("dd", { class: "tile-reason" }, figure.reason) : null)));
}

/** A key-figure card's content: its figures as tiles and as the figures table. */
function keyContent(parts: { title: string; note: string; figures: KeyFigure[]; source: SourceBlock; footnotes?: string[] }): CardContent {
  const { figures, ...rest } = parts;
  return {
    ...rest,
    draw: () => figuresVisual(figures),
    table: {
      headers: ["Figure", "Value"],
      rows: figures.map((figure) => [figure.label, figure.reason ? `${figure.value} (${figure.reason})` : figure.value]),
      numeric: [false, true],
    },
  };
}

/** Why a world year-on-year change is null: a series break (overview `series_breaks` names it), or no figure in the data. */
function yoyReason(overview: Overview, world: WorldId, year: number): string {
  const block = overview.world_yoy?.[world];
  if (!block) return "No year-on-year figure in this data version.";
  if (block.yoy_null_reason[String(year)] === "series_break") {
    const named = seriesBreaksIn(overview, { world: true, series: WORLD_SERIES[world], first: year - 1, last: year }).map((entry) => entry.label);
    return `Not computed: series break in ${year}${named.length > 0 ? ` (${named.join(", ")})` : ""}, not comparable with ${year - 1}.`;
  }
  return `No figure for ${year}.`;
}

function worldKey(overview: Overview, world: WorldId, id: string, what: string): CardBuilder {
  return {
    id,
    build: () => {
      const year = overview.world_last_year[world];
      const value = overview[world][String(year)] ?? null;
      const change = overview.world_yoy?.[world]?.yoy[String(year)] ?? null;
      return keyContent({
        title: `${WORLD_TITLES[world]}, ${year}`,
        note: what,
        figures: [
          { id: "value", label: `Applications, ${year}`, value: formatCount(value), ...(value === null ? { reason: `No figure for ${year}.` } : {}) },
          { id: "change", label: `Change from ${year - 1}`, value: percent(change, overview.method.rounding.decimals.yoy, true),
            ...(change === null ? { reason: yoyReason(overview, world, year) } : {}) },
        ],
        source: overview.world_sources[world],
      });
    },
  };
}

function topOriginKey(overview: Overview, source: SourceBlock): CardBuilder["build"] {
  return () => {
    const year = overview.top_year;
    const top = [...overview.top_origins].sort((a, b) => a.rank - b.rank)[0];
    const none = top ? undefined : "No origin ranked in this data.";
    return keyContent({
      title: `Top origin of patent applications, ${year}`,
      note: "By country of residence of the first-named applicant.",
      figures: [
        { id: "origin", label: `Origin ranked first, ${year}`, value: top?.label ?? "–", ...(none ? { reason: none } : {}) },
        { id: "value", label: `Applications, ${year}`, value: formatCount(top?.value) },
        { id: "share", label: `Share of ${overview.share_denominator.origin_apps}, ${year}`,
          value: percent(top?.share, overview.method.rounding.decimals.share),
          ...(top && top.share === null ? { reason: "No world total published for this year." } : {}) },
      ],
      source,
    });
  };
}

/** Footnotes for the series breaks inside the grower's growth window (top_grower.breaks): WIPO's note when the data list it. */
function growerBreakNotes(overview: Overview, code: string, label: string, breaks: number[], first: number): string[] {
  const series: SeriesId = "origin_apps";
  const listed = seriesBreakNotes(overview, { code, series, first, last: overview.top_year, growth: false });
  const entries = seriesBreaksIn(overview, { code, series, first, last: overview.top_year });
  return breaks.map((year) => {
    const at = entries.findIndex((entry) => entry.year === year);
    const text = at >= 0 ? listed[at] : `Series break ${year} in WIPO's ${label} origin data.`;
    return `${text} The growth rate spans this break.`;
  });
}

function topGrowerKey(overview: Overview, source: SourceBlock): CardBuilder["build"] {
  return () => {
    const { cagr_years: years, rounding: { decimals } } = overview.method;
    const end = overview.top_year;
    const period = `${end - years}–${end}`;
    const grower = overview.top_grower ?? null;
    return keyContent({
      title: `Fastest grower among the top ${overview.top_n} origins, ${period}`,
      note: `Compound annual growth over ${years} years; top ${overview.top_n} origins by applications in ${end} only (no small-base outliers).`,
      figures: [
        { id: "origin", label: `Origin, rank ${grower ? grower.rank : "–"} in ${end}`, value: grower?.label ?? "–",
          ...(grower ? {} : { reason: "No growth rate computable for the top origins in this data." }) },
        { id: "growth", label: `Annual growth ${period}`, value: percent(grower?.cagr10, decimals.cagr, true) },
        { id: "value", label: `Applications, ${end}`, value: formatCount(grower?.value) },
      ],
      source,
      ...(grower && grower.breaks.length > 0 ? { footnotes: growerBreakNotes(overview, grower.code, grower.label, grower.breaks, end - years) } : {}),
    });
  };
}

/** The four key-figure cards (dashboard tiles; embeddable by id). Pipeline fields only: world totals and `world_yoy`, the
 * first of `top_origins`, `top_grower`. `overviewChart` = the overview chart each links to. */
export function keyFigureCards(overview: Overview): CardBuilder[] {
  const origin = overview.sources.origin_apps;
  const originCard = (id: string, title: string, overviewChart: string, build: (src: SourceBlock) => CardBuilder["build"]): CardBuilder => {
    const builder: CardBuilder = origin ? { id, build: build(origin) } : { id, build: () => null, problem: { title, message: NO_DATA } };
    return withOverviewChart(builder, overviewChart);
  };
  return [
    withOverviewChart(worldKey(overview, "world_office", KEY_WORLD_PATENTS,
      "WIPO's world total (code WD), all offices; change computed from WIPO's totals."),
      "world-trend"),
    withOverviewChart(worldKey(overview, "pct_world", KEY_WORLD_PCT,
      `WIPO's PCT total (code ZZ), by filing date. ${PCT_LATE_FILINGS}`),
      "pct-world-trend"),
    originCard(KEY_TOP_ORIGIN, "Top origin of patent applications", "top-origins", (src) => topOriginKey(overview, src)),
    originCard(KEY_TOP_GROWER, "Fastest grower among the top origins", "size-growth", (src) => topGrowerKey(overview, src)),
  ];
}

function withOverviewChart(builder: CardBuilder, overviewChart: string): CardBuilder {
  return { ...builder, build: () => { const content = builder.build(); return content ? { ...content, overviewChart } : null; } };
}

/** A tile's builder built once, except a stateful one (`params`: the map), rebuilt from its state on each redraw;
 * absent data = the tile's reason, never a blank tile. */
function tileBuilder(builder: CardBuilder): CardBuilder {
  const content = builder.build();
  if (content || builder.problem) return builder.params ? builder : { ...builder, build: () => content };
  return { ...builder, build: () => null, problem: { title: MISSING_TITLES[builder.id] ?? builder.id, message: NO_DATA } };
}

type DashboardContext = MapContext & { atlas: Atlas | null; overview: Overview; entities: Entities };

/** The dashboard in `app`; returns its notices (the carousel's). */
export async function renderDashboard(app: HTMLElement, ctx: DashboardContext): Promise<string[]> {
  const { atlas, overview } = ctx;
  const cardCtx: CardContext = { cfg: ctx.cfg, manifest: ctx.manifest, params: ctx.params };
  const tileCtx: CardContext = { ...cardCtx, linkOverview: true };
  const charts = worldCards(overview, atlas, cardCtx);
  const map = charts.find((card) => card.id === MAP_CARD_ID)
    ?? { id: MAP_CARD_ID, build: () => null, problem: { title: MISSING_TITLES[MAP_CARD_ID], message: "The world map could not be loaded." } };
  const builders = [...keyFigureCards(overview), map, { ...treemapCard(overview), wide: false }, shareShiftCard(overview)];
  const holders = builders.map(() => h("div", { class: "dashboard-tile" }));
  const [patents, pct, origin, grower, mapTile, treemapTile, shiftTile] = holders;
  const stage = h("section", { class: "dashboard-stage" });
  document.title = `Dashboard – ${ctx.cfg.siteName}`;
  app.replaceChildren(
    h("header", { class: "page-intro" },
      h("h1", {}, "Patents at a glance"),
      h("p", { class: "lede" },
        "Key figures and charts from the WIPO Statistics Database. Each tile names its year and source and links to its full chart on the overview."),
    ),
    h("div", { class: "dashboard" },
      h("div", { class: "dashboard-row dashboard-keys" },
        h("div", { class: "dashboard-pair" }, patents, pct),
        h("div", { class: "dashboard-pair" }, origin, grower)),
      h("div", { class: "dashboard-row" }, stage, mapTile),
      h("div", { class: "dashboard-row" }, treemapTile, shiftTile)),
  );
  await themeLoaded();
  builders.forEach((builder, index) => renderCards(holders[index], [tileBuilder(builder)], tileCtx));
  const notices: string[] = [];
  // its `dispose` handle unused: the page never tears the carousel down (a theme or view change loads a new page);
  // carousel.spec tests dispose through a test-only build
  startCarousel(stage, ctx.cfg, ctx.manifest, ctx.params, notices, { entities: ctx.entities, overview });
  return notices;
}
