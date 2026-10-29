// World overview: world map (map.ts), world total trend, PCT world trend, top origins, fastest growers, rank race,
// continent share, size vs growth, PCT monthly heat strip. Every number and year in titles and notes is read from
// overview.json (no figure typed here).
import type { Atlas, GroupItem } from "./atlas";
import { CONTINENT_NAMES_PROBLEM, renderChartCard, renderProblemCard, replaceChart, type CardContext, type ChartSpec } from "./chartCard";
import { barChart, chartWidth, lineChart, minChartHeight, minMapHeight, type LinePoint } from "./charts";
import { MONTH_LABELS, heatStripChart, rankRaceChart, scatterChart, shareAreaChart } from "./overviewCharts";
import type { ContinentShare, Overview, SeriesId, WorldId, YearMap } from "./data";
import { h, formatCount } from "./dom";
import { fixedPercent } from "./format";
import { nullReasonText } from "./groupText";
import { mapCard, mapOptions, type MapContext } from "./map";
import { withParams, type Params } from "./params";
import { shareShiftCard } from "./shareShift";
import { treemapCard } from "./treemap";
import { PCT_LATE_FILINGS, WORLD_TITLES, originAbroadNote, seriesBreakNotes } from "./methods";

/** A card's content; `draw` makes its chart at a given width (first render and every resize). */
export type CardContent = Omit<ChartSpec, "id" | "visual"> & {
  /** `height` = the room the chart may take (wallboard focus fit); charts that cannot shrink ignore it. */
  draw: (width: number, height?: number) => SVGElement | HTMLElement;
};
/** `build` returns null when the data for the card is missing (card left out); `wide` = spans the whole grid
 * row (class `chart-card--wide`). `params` = a card with its own state (map metric, year): the params its cite and
 * embed links carry; it fires `card-state` (bubbling) when that state changes, and renderCards redraws it. */
export type CardBuilder = {
  id: string; build: () => CardContent | null; wide?: boolean; params?: () => Partial<Params>;
  /** Set when `build` gives null because the card cannot be drawn (not for lack of data): shown in the card, never left out. */
  problem?: { title: string; message: string };
};

/** Attribute of an HTML figure that holds charts drawn at the card's width: redrawn on resize like a single chart. */
export const REDRAW_ATTRIBUTE = "data-redraw";

/** Fit passes per draw: the first nearly always fits; later ones catch a chart that kept a few pixels. */
const FIT_ATTEMPTS = 3;
/** Wait after the last resize before redrawing (rotation, window drag). */
const RESIZE_SETTLE_MS = 150;

/** What each world series' coverage counts (pipeline/write.py: offices in the WD sum, origins in the
 * PCT sum). */
const REPORTING: Record<WorldId, string> = { world_office: "offices", pct_world: "origins" };
/** Series each world total sums (pipeline/worlds.py WORLD_SOURCES): the series its break notes look up. */
export const WORLD_SERIES: Record<WorldId, SeriesId> = { world_office: "office_apps", pct_world: "pct_origin" };

/** Years up to `lastYear`, ascending; later (provisional) years are left out, null stays null (gap). */
function worldPoints(series: YearMap, lastYear: number): LinePoint[] {
  return Object.entries(series)
    .map(([year, value]) => ({ year: Number(year), value }))
    .filter((point) => point.year <= lastYear)
    .sort((a, b) => a.year - b.year);
}

/** Data-driven completeness line: provisional years named with the coverage rule, else "complete". */
function completeness(overview: Overview, world: WorldId): string {
  const lastYear = overview.world_last_year[world];
  const provisional = Object.keys(overview.coverage[world]).filter((year) => Number(year) > lastYear);
  if (provisional.length === 0) return `Complete through ${lastYear}.`;
  const rule = overview.coverage_rule;
  return `Not shown: ${provisional.join(", ")}, provisional (fewer reporting ${REPORTING[world]} than ` +
    `${Math.round(rule.min_ratio * 100)}% of the most in the ${rule.lookback_years} years before).`;
}

function worldTrend(overview: Overview, world: WorldId, what: string): CardBuilder["build"] {
  return () => {
    // WIPO row (WD / ZZ) and the years charted (pipeline/write.py _world_source)
    const source = overview.world_sources[world];
    if (!source) return null;
    const lastYear = overview.world_last_year[world];
    const points = worldPoints(overview[world], lastYear);
    const firstYear = points.find((point) => point.value !== null)?.year ?? lastYear;
    const footnotes = seriesBreakNotes(overview, { world: true, series: WORLD_SERIES[world], first: firstYear, last: lastYear });
    return {
      title: `${WORLD_TITLES[world]}, ${firstYear}–${lastYear}`,
      note: `${what} ${completeness(overview, world)}`,
      ...(footnotes.length > 0 ? { footnotes } : {}),
      draw: (width, height) => lineChart(points, { width, height }),
      table: {
        headers: ["Year", "Applications"],
        rows: [...points].reverse().map((point) => [String(point.year), point.value]),
        numeric: [true, true],
      },
      source,
    };
  };
}

function topOrigins(overview: Overview): CardBuilder["build"] {
  return () => {
    const source = overview.sources.origin_apps;
    if (!source || overview.top_origins.length === 0) return null;
    const rows = [...overview.top_origins].sort((a, b) => a.rank - b.rank);
    return {
      title: `Top ${overview.top_n} origins of patent applications, ${overview.top_year}`,
      note: "Patent applications filed worldwide, by country of residence of the first-named applicant.",
      draw: (width, height) => barChart(rows.map((row) => ({ label: row.label, value: row.value })), { width, height }),
      table: {
        headers: ["Rank", "Origin", `Applications, ${overview.top_year}`],
        rows: rows.map((row) => [row.rank, row.label, row.value]),
        numeric: [true, false, true],
      },
      footnotes: [originAbroadNote(overview)],
      source,
    };
  };
}

function fastestGrowers(overview: Overview): CardBuilder["build"] {
  return () => {
    const source = overview.sources.origin_apps;
    if (!source || overview.fastest_growers.length === 0) return null;
    const { cagr_years: years, rounding } = overview.method;
    const period = `${overview.top_year - years}–${overview.top_year}`;
    const percent = (value: number): string => `${value.toFixed(rounding.decimals.cagr)}%`;
    const rows = overview.fastest_growers;
    return {
      title: `Fastest-growing origins, ${period}`,
      note: `Compound annual growth rate over ${years} years, by applicant's origin; origins with at least ` +
        `${formatCount(overview.grower_min)} applications in ${overview.top_year}.`,
      draw: (width, height) => barChart(rows.map((row) => ({ label: row.label, value: row.cagr10 })), { width, height, format: percent }),
      table: {
        headers: ["Origin", `Annual growth ${period}`],
        rows: rows.map((row) => [row.label, percent(row.cagr10)]),
        numeric: [false, true],
      },
      footnotes: [originAbroadNote(overview)],
      source,
    };
  };
}

/** Consecutive years as ranges: [1980, 1981, 1982, 1985] -> "1980–1982, 1985". */
export function yearRanges(years: number[]): string {
  const runs: [number, number][] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const run = runs.at(-1);
    if (run && year === run[1] + 1) run[1] = year;
    else runs.push([year, year]);
  }
  return runs.map(([from, to]) => (from === to ? String(from) : `${from}–${to}`)).join(", ");
}

/** The continents' display names (groups.json); null when the groups are missing or name one of `ids` not:
 * a card that needs them is then left out (the page notice or the embed message names the failed load), no guessed names. */
function continentLabels(groups: GroupItem[] | null, ids: string[]): Record<string, string> | null {
  const named = new Map((groups ?? []).filter((group) => group.kind === "continent").map((group) => [group.id, group.label]));
  return ids.every((id) => named.has(id)) ? Object.fromEntries(ids.map((id) => [id, named.get(id) as string])) : null;
}

/** The continents a card names: those of the share series (and, for size and growth, those of its origins). */
function continentIds(overview: Overview, card: "continent-share" | "size-growth"): string[] {
  const own = Object.keys(overview.continent_share.origin_apps?.continent ?? {});
  return card === "continent-share" ? own : [...new Set([...own, ...overview.size_growth.map((entry) => entry.continent)])];
}

/** The in-card message of a continent card whose names are missing; undefined when it has them or has no data to draw
 * (then the card is left out, as for any card without data). */
function continentNamesProblem(overview: Overview, groups: GroupItem[] | null, card: "continent-share" | "size-growth"): CardBuilder["problem"] {
  if (!overview.sources.origin_apps || !overview.continent_share.origin_apps || continentLabels(groups, continentIds(overview, card))) return undefined;
  // size-growth draws only origins with a growth rate: none = no card, whatever the names
  if (card === "size-growth" && !overview.size_growth.some((entry) => entry.cagr10 !== null)) return undefined;
  return { title: card === "continent-share" ? "Continents' share of world patent applications by origin" : `Size and growth of origins, ${overview.top_year}`,
    message: CONTINENT_NAMES_PROBLEM };
}

function sortedYears(keys: string[]): number[] {
  return keys.map(Number).sort((a, b) => a - b);
}

function rankRace(overview: Overview): CardBuilder["build"] {
  return () => {
    const source = overview.sources.origin_apps;
    const race = overview.rank_race;
    if (!source || race.rows.length === 0) return null;
    const years = sortedYears([...new Set(race.rows.flatMap((row) => Object.keys(row.ranks)))]);
    const headers = ["Year", ...Array.from({ length: race.top }, (_, index) => `Rank ${index + 1}`)];
    // ties share a rank (pipeline/derive.py ranks competition-style: 8, 8, 10): a cell names every country at its rank, a
    // rank skipped after a tie says so (the table is the chart's text alternative; final review I2)
    const ranked = (year: number, rank: number): string | null => {
      const at = race.rows.filter((row) => row.ranks[String(year)] === rank).map((row) => row.label);
      if (at.length > 1) return `${at.join(", ")} (tied)`;
      if (at.length === 1) return at[0];
      const tiedAbove = race.rows.some((row) => {
        const above = row.ranks[String(year)];
        return above != null && above < rank && race.rows.filter((other) => other.ranks[String(year)] === above).length > rank - above;
      });
      return tiedAbove ? "– (tie above)" : null;
    };
    return {
      title: `Top ${race.top} origins, ranked, ${years[0]}–${years[years.length - 1]}`,
      note: `Rank by patent applications by applicant's origin, 1 at the top; a line breaks in a year the country ranks below ${race.top}. ` +
        "Countries with equal applications share a rank and the next rank is skipped; the figures name every country at a rank.",
      draw: (width, height) => rankRaceChart(race.rows, { top: race.top, years, width, height }),
      table: {
        headers,
        rows: [...years].reverse().map((year) => [String(year), ...Array.from({ length: race.top }, (_, index) => ranked(year, index + 1))]),
        numeric: headers.map(() => false),
      },
      footnotes: [originAbroadNote(overview)],
      source,
    };
  };
}

/** The unallocated band is below 0 in `year`: listed in `negative_years` (ints, as the pipeline writes them) or computed so. */
function isNegativeBand(block: ContinentShare, year: number): boolean {
  return block.negative_years.includes(year) || (block.unallocated[String(year)] ?? 0) < 0;
}

/** Why a continent-share year is not in the chart. */
function omissionReason(overview: Overview, series: SeriesId, year: number): string {
  const block = overview.continent_share[series];
  if (isNegativeBand(block, year)) return "the unallocated band is negative";
  const reason = block.null_reason[String(year)];
  return reason ? `no data reported: ${nullReasonText(reason, overview)}` : "no data reported";
}

function continentShare(overview: Overview, groups: GroupItem[] | null): CardBuilder["build"] {
  return () => {
    const series: SeriesId = "origin_apps";
    const source = overview.sources[series];
    const block = overview.continent_share[series];
    if (!source || !block) return null;
    const ids = Object.keys(block.continent);
    const labels = continentLabels(groups, ids);
    if (!labels) return null;
    const bandLabel = block.unallocated_label.replace(/^./, (letter) => letter.toUpperCase());
    const years = sortedYears(Object.keys(block.unallocated));
    const valueOf = (id: string, year: number): number | null => block.continent[id][String(year)] ?? null;
    const bandOf = (year: number): number | null => block.unallocated[String(year)] ?? null;
    const reasonOf = (year: number): string | null => {
      const complete = ids.every((id) => valueOf(id, year) !== null) && bandOf(year) !== null;
      return complete && !isNegativeBand(block, year) ? null : omissionReason(overview, series, year);
    };
    const shown = years.filter((year) => reasonOf(year) === null);
    if (shown.length === 0) return null;
    const shareOf = (value: number | null, year: number): number | null => {
      const world = ids.reduce((sum, id) => sum + (valueOf(id, year) ?? 0), bandOf(year) ?? 0);
      return value === null || world <= 0 ? null : value / world;
    };
    const layers = [
      ...ids.map((id) => ({ key: id, label: labels[id], shares: Object.fromEntries(shown.map((year) => [year, shareOf(valueOf(id, year), year)])) })),
      { key: "unallocated", label: bandLabel, hatched: true, shares: Object.fromEntries(shown.map((year) => [year, shareOf(bandOf(year), year)])) },
    ];
    const chartYears = years.filter((year) => year >= shown[0]);
    const decimals = overview.method.rounding.decimals.share;
    const omitted = years.filter((year) => reasonOf(year) !== null);
    const byReason = new Map<string, number[]>();
    for (const year of omitted) byReason.set(reasonOf(year) as string, [...(byReason.get(reasonOf(year) as string) ?? []), year]);
    return {
      title: `Continents' share of world patent applications by origin, ${shown[0]}–${years[years.length - 1]}`,
      note: `Each continent's applications as a share of the world total; the hatched band (“${block.unallocated_label}”) is the part of the ` +
        "world total no continent accounts for. Years left out are named under the chart.",
      draw: (width, height) => shareAreaChart(layers, { years: chartYears, width, height, format: (share) => `${fixedPercent(share, decimals)}%` }),
      table: {
        headers: ["Year", ...ids.map((id) => labels[id]), bandLabel, "In the chart"],
        rows: [...years].reverse().map((year) => [String(year), ...ids.map((id) => valueOf(id, year)), bandOf(year),
          reasonOf(year) === null ? "yes" : `no: ${reasonOf(year)}`]),
        numeric: [false, ...ids.map(() => true), true, false],
      },
      footnotes: [...[...byReason].map(([reason, list]) => `Left out of the chart: ${yearRanges(list)} (${reason}).`),
        originAbroadNote(overview),
        ...seriesBreakNotes(overview, { world: true, series, first: shown[0], last: years[years.length - 1] })],
      source,
    };
  };
}

function sizeGrowth(overview: Overview, groups: GroupItem[] | null): CardBuilder["build"] {
  return () => {
    const source = overview.sources.origin_apps;
    if (!source || overview.size_growth.length === 0) return null;
    const { cagr_years: years } = overview.method;
    const entries = overview.size_growth;
    const labels = continentLabels(groups, [...new Set([...Object.keys(overview.continent_share.origin_apps.continent),
      ...entries.map((entry) => entry.continent)])]);
    const points = entries.flatMap((entry) => (entry.cagr10 === null ? [] : [{ label: entry.label, key: entry.continent, x: entry.value, y: entry.cagr10 }]));
    if (!labels || points.length === 0) return null;
    const noGrowth = entries.filter((entry) => entry.cagr10 === null);
    const keys = Object.keys(labels).filter((key) => points.some((point) => point.key === key)).map((key) => ({ key, label: labels[key] }));
    const percent = (value: number): string => `${Number(value.toPrecision(3))}%`;
    const growth = (value: number | null): string | null => (value === null ? null : `${value.toFixed(overview.method.rounding.decimals.cagr)}%`);
    const tipGrowth = (value: number): string => growth(value) as string;
    return {
      title: `Size and growth of origins, ${overview.top_year}`,
      note: `Applications by applicant's origin in ${overview.top_year} against ${years}-year compound annual growth; ` +
        `origins with at least ${formatCount(overview.grower_min)} applications. Colour and shape = continent.`,
      draw: (width, height) => scatterChart(points, keys, {
        xLabel: `Applications in ${overview.top_year} (log scale)`, yLabel: `Annual growth over ${years} years`, formatY: percent, formatTip: tipGrowth, width, height }),
      table: {
        headers: ["Origin", "Continent", `Applications, ${overview.top_year}`, `Annual growth ${overview.top_year - years}–${overview.top_year}`],
        rows: entries.map((entry) => [entry.label, labels[entry.continent], entry.value, growth(entry.cagr10)]),
        numeric: [false, false, true, true],
      },
      footnotes: [
        ...(noGrowth.length === 0 ? [] : [`Not plotted, growth over ${years} years cannot be computed (no value ${years} years earlier, or a zero value then): ` +
          `${noGrowth.map((entry) => `${entry.label} (${formatCount(entry.value)} applications)`).join(", ")}.`]),
        originAbroadNote(overview),
      ],
      source,
    };
  };
}

function pctMonthly(overview: Overview): CardBuilder["build"] {
  return () => {
    const source = overview.pct_monthly_source;
    const years = sortedYears(Object.keys(overview.pct_monthly ?? {}));
    if (!source || years.length === 0) return null;
    const cells = years.flatMap((year) => overview.pct_monthly[String(year)].map((value, index) => ({ year, month: index + 1, value })));
    if (cells.every((entry) => entry.value === null)) return null;
    return {
      title: `PCT applications by month, ${years[0]}–${years[years.length - 1]}`,
      note: `WIPO's PCT total (all receiving offices) by filing month; colour runs from the lowest to the highest month, see legend. ${PCT_LATE_FILINGS}`,
      draw: (width, height) => heatStripChart(cells, { years, width, height, noDataLabel: "no data reported", valueLabel: "PCT applications" }),
      table: {
        headers: ["Year", ...MONTH_LABELS],
        rows: [...years].reverse().map((year) => [String(year), ...overview.pct_monthly[String(year)]]),
        numeric: [false, ...MONTH_LABELS.map(() => true)],
      },
      source,
    };
  };
}

type DrawnCard = { shell: HTMLElement; content: CardContent; width: number };

/** Fit (wallboard, rotation focus, embed): the chart takes only the height its room has left once the text around it is laid
 * out (`room` = the slide's stage, else the viewport), so nothing scrolls. Measured, never a text budget: text wraps
 * differently in each fallback font. A chart shrinks to `draw`'s own height (never below `minChartHeight`); the map, drawn
 * by CSS, gets a maximum height instead (never below `minMapHeight`). */
function fitToRoom(card: DrawnCard, room?: HTMLElement): void {
  // a redrawn chart may not lose exactly the height asked (margins, rounding): measured again, a few tries at most
  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt += 1) {
    const overflow = room
      ? Math.ceil(Math.max(room.scrollHeight - room.clientHeight, card.shell.getBoundingClientRect().bottom - room.getBoundingClientRect().bottom))
      : document.documentElement.scrollHeight - window.innerHeight;
    if (overflow <= 0) return;
    const visual = card.shell.querySelector<HTMLElement | SVGElement>(".chart-figure > svg, .chart-figure .map-svg");
    if (!visual) return;
    const map = visual instanceof SVGElement && visual.classList.contains("map-svg");
    const current = visual.getBoundingClientRect().height;
    const height = Math.max(map ? minMapHeight() : minChartHeight(), current - overflow);
    if (height >= current) return; // at its smallest
    if (map) visual.style.maxHeight = `${height}px`;
    else replaceChart(card.shell, card.content.draw(card.width, height) as SVGElement);
  }
}

/** Redraws each card's chart when its width changes (window resize, phone rotation), after the size
 * settles; open panels and theme choices stay as they are. `fit`: redraws on any resize and fits the room's height again
 * (`room` observed too; none = the viewport, and the body observed: text laid out after the fit, such as notices, grows
 * it). Returns the function that stops it. */
function redrawOnResize(cards: DrawnCard[], fit: boolean, room?: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const redraw = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const card of cards) {
        const width = chartWidth(card.shell);
        if (width === card.width && !fit) continue;
        card.width = width;
        card.shell.querySelector<HTMLElement>(".map-svg")?.style.removeProperty("max-height");
        // an HTML figure (map) scales by CSS; redrawing it would detach the element that fires card-state
        const several = card.shell.querySelector(`.chart-figure > [${REDRAW_ATTRIBUTE}]`);
        if (several) several.replaceWith(card.content.draw(width));
        else if (card.shell.querySelector(".chart-figure > svg")) replaceChart(card.shell, card.content.draw(width) as SVGElement);
        if (fit) fitToRoom(card, room);
      }
    }, RESIZE_SETTLE_MS);
  };
  const observer = new ResizeObserver(redraw);
  for (const card of cards) observer.observe(card.shell);
  if (room) observer.observe(room);
  const onWindow = fit && !room;
  if (onWindow) observer.observe(document.body);
  if (onWindow) window.addEventListener("resize", redraw);
  return () => {
    clearTimeout(timer);
    observer.disconnect();
    if (onWindow) window.removeEventListener("resize", redraw);
  };
}

/** The card's context: its own state params over the page's. */
function cardContext(builder: CardBuilder, ctx: CardContext): CardContext {
  return builder.params ? { ...ctx, params: { ...ctx.params, ...builder.params() } } : ctx;
}

/** Redraws a stateful card after `card-state`: address rewritten (full page) so a reload or a shared address shows
 * the same figure; focus, the open tool panel and the open sources-and-notes details kept. */
function redrawOnState(shell: HTMLElement, builder: CardBuilder, ctx: CardContext): void {
  shell.addEventListener("card-state", () => {
    const content = builder.build();
    if (!content || !builder.params) return;
    const focused = shell.contains(document.activeElement) ? document.activeElement?.id : undefined;
    const open = [...shell.querySelectorAll(".tool-button")].findIndex((button) => button.getAttribute("aria-expanded") === "true");
    const notesOpen = shell.querySelector<HTMLDetailsElement>("details.card-details")?.open ?? false;
    const { draw, ...rest } = content;
    renderChartCard(shell, { id: builder.id, ...rest, visual: draw(chartWidth(shell)) }, cardContext(builder, ctx));
    if (!ctx.compact) history.replaceState(null, "", withParams(builder.params()));
    if (notesOpen) shell.querySelector<HTMLDetailsElement>("details.card-details")?.setAttribute("open", "");
    if (open >= 0) shell.querySelectorAll<HTMLElement>(".tool-button")[open]?.click();
    if (focused) document.getElementById(focused)?.focus();
  });
}

/** Fills `grid` with one card per builder, in order (overview, country and office pages); `opts.fit` = fitted to the
 * viewport height (rotation focus, embed), `opts.fitTo` = fitted to that element's height (a slide's stage). Cards
 * are placed first, so each chart is drawn at its card's real width; `?chart=<id>` scrolls to that card. Returns the
 * function that removes the resize observers and listeners. */
export function renderCards(grid: HTMLElement, builders: CardBuilder[], ctx: CardContext,
  opts: { fit?: boolean; fitTo?: HTMLElement } = {}): () => void {
  const fit = Boolean(opts.fit || opts.fitTo);
  // classes set before placing, so each chart is measured at its final width
  const shells = builders.map((builder) => h("section", { class: `card chart-card${builder.wide ? " chart-card--wide" : ""}` }));
  grid.replaceChildren(...shells);
  const cards: DrawnCard[] = [];
  builders.forEach((builder, index) => {
    const shell = shells[index];
    const content = builder.build();
    if (!content) {
      if (builder.problem) renderProblemCard(shell, builder.id, builder.problem.title, builder.problem.message, ctx.idPrefix);
      else shell.remove();
      return;
    }
    const width = chartWidth(shell);
    const { draw, ...rest } = content;
    const visual = draw(width);
    renderChartCard(shell, { id: builder.id, ...rest, visual }, cardContext(builder, ctx));
    // charts only (fit: all): tiles, map scale by CSS; REDRAW_ATTRIBUTE = an HTML figure of several charts (women trend)
    if (visual instanceof SVGElement || visual.hasAttribute(REDRAW_ATTRIBUTE) || fit) cards.push({ shell, content, width });
    if (fit) fitToRoom({ shell, content, width }, opts.fitTo);
    if (builder.params) redrawOnState(shell, builder, ctx);
  });
  const stop = redrawOnResize(cards, fit, opts.fitTo);
  // not in compact mode: scrollIntoView inside an iframe would scroll the host page
  const wanted = ctx.compact ? undefined : ctx.params.chart;
  if (wanted) shells.find((shell) => shell.dataset.chart === wanted)?.scrollIntoView();
  return stop;
}

/** The overview cards, in order (embed picks one by id); the map only with its atlas (`null`: not loaded). The continent
 * cards need only the groups (groups.json): the embed passes them without the atlas. */
export function worldCards(overview: Overview, atlas: Atlas | null, ctx: MapContext,
  groups: GroupItem[] | null = atlas?.groups ?? null): CardBuilder[] {
  return [
    ...(atlas ? [mapCard(atlas, overview, mapOptions(overview, ctx.params), ctx)] : []),
    { id: "world-trend", build: worldTrend(overview, "world_office", "WIPO's world total (code WD) of patent applications filed at all offices.") },
    { id: "pct-world-trend", build: worldTrend(overview, "pct_world",
      "WIPO's PCT total (code ZZ): international applications filed at all receiving offices, by filing date. " +
      `A PCT year is shown once WIPO reports all its months. ${PCT_LATE_FILINGS}`) },
    { id: "top-origins", build: topOrigins(overview) },
    { id: "fastest-growers", build: fastestGrowers(overview) },
    { id: "rank-race", build: rankRace(overview) },
    { id: "continent-share", build: continentShare(overview, groups), problem: continentNamesProblem(overview, groups, "continent-share") },
    { id: "size-growth", build: sizeGrowth(overview, groups), problem: continentNamesProblem(overview, groups, "size-growth") },
    { id: "pct-monthly", build: pctMonthly(overview) },
    treemapCard(overview, ctx.idPrefix),
    shareShiftCard(overview),
  ];
}

const NO_DATA_TO_DRAW = "There is no data to draw this chart.";

/** The card a wallboard rotation view (`?rotate=` with `?chart=<id>`) shows alone, if the id is an overview card. */
export function focusCard(overview: Overview, atlas: Atlas | null, ctx: MapContext): CardBuilder | undefined {
  const builder = ctx.params.rotate ? worldCards(overview, atlas, ctx).find((card) => card.id === ctx.params.chart) : undefined;
  // a card with no data: the focus layout with a message, never a blank grid (rotation moves on as usual)
  if (builder && !builder.problem && !builder.build()) return { ...builder, problem: { title: builder.id, message: NO_DATA_TO_DRAW } };
  return builder;
}

/** Fills `grid` with the overview cards: the map across the top, trends paired, then the two ranked lists (equal
 * heights side by side). */
export function renderWorldCharts(grid: HTMLElement, overview: Overview, atlas: Atlas | null, ctx: CardContext): void {
  renderCards(grid, worldCards(overview, atlas, ctx), ctx);
}
