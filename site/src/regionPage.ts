// Region page (`?region=<m49>`) and continent page (`?continent=<slug>`): member table, group totals per series with
// "n of m" coverage and every null year's reason (group/<id>.json `null_reason`), the basis (WIPO's regional total or the
// sum of members) and, on a WIPO total, the member-sum cross-check; map zoomed to the members. A region with the same
// members as its continent (021 Northern America) has no page of its own: its address shows the continent page
// (map.ts `groupPageTarget`). "m" = the members WIPO lists for the series (pipeline/groups.py `listed_members`); a member
// WIPO does not list (Guernsey: office series only) is named under the card, never counted as not reporting.
import { MAP_SERIES, type Atlas, type GroupItem, type GroupNullReason, type GroupSeries } from "./atlas";
import { dataTable, type CardContext, type ChartTable, type TableCell } from "./chartCard";
import { lineChart, type LinePoint } from "./charts";
import type { Config, Overview, RatioId, SeriesId, SourceBlock } from "./data";
import { formatCount, h } from "./dom";
import { signedPercent } from "./format";
import { GROUP_WOMEN_CARD_ID, groupWomenCard } from "./genderCards";
import { SERIES_CARD_IDS, distinctSources, hasRatioValue, ratioYears, scaleTilesFigure, type EntityPageContext, type ScaleTile } from "./entityPage";
import { PCT_UNLISTED_ORIGIN_GROUPS, nullReasonText, wipoTotalCounts, wipoTotalGapCause } from "./groupText";
import { MAP_CARD_ID, formerExclusionText, groupPageTarget, labelOf, mapCard, memberCoverageText, mapOptions, pageLinkOf, type GroupKind, type MapContext } from "./map";
import { PCT_LATE_FILINGS, SERIES_TITLES, originAbroadNote, seriesBreakNotes } from "./methods";
import { renderCards, yearRanges, type CardBuilder, type CardContent } from "./overview";
import { addressParams, echoValue, withParams, type Params } from "./params";
import { renderPicker } from "./picker";
import { RATIO_BASIS_LABEL, RATIO_SHORT, formatRatio, gdpBasisLabel, isWipoRatio, ratioNullText, shownRatios, wdiCredit, worldBasisText } from "./ratioText";
import { themeLoaded } from "./theme";

export type GroupPageContext = EntityPageContext & { atlas: Atlas };

export const GROUP_MEMBERS_CARD_ID = "group-members";
export const GROUP_SCALE_CARD_ID = "group-scale";
/** Cards a group page has (embed with `?region=` / `?continent=`); totals use the series card ids of country pages. */
export const GROUP_CARD_IDS: string[] = [GROUP_MEMBERS_CARD_ID, ...Object.values(SERIES_CARD_IDS), GROUP_SCALE_CARD_ID, GROUP_WOMEN_CARD_ID, MAP_CARD_ID];

const KIND_TITLE: Record<GroupKind, string> = { region: "Region", continent: "Continent" };
const TOTAL_LINE = { wipo_total: "WIPO regional total", member_sum: "Sum of member countries" } as const;

/** Label of the cross-check line and column: names the non-member codes WIPO counts in its total and the sum adds
 * (overview `group_crosscheck_assignment`), so the figure is never read as the members' sum alone. */
function crossCheckLabel(atlas: Atlas, overview: Overview, groupId: string, series: SeriesId): string {
  const extra = overview.method.group_crosscheck_assignment[series]?.[groupId] ?? [];
  const label = labelOf(atlas);
  return extra.length ? `Sum of member countries + ${extra.map(label).join(", ")} (cross-check)` : "Sum of member countries (cross-check)";
}

/** The group a checked address asks for: `?continent=` wins over `?region=`; a region with its continent's members moves to
 * the continent. `moved` = the address must be rewritten. Unknown ids are dropped with a notice. */
export function findGroup(groups: GroupItem[], params: Params): { group?: GroupItem; notices: string[]; moved: boolean } {
  const notices: string[] = [];
  let moved = false;
  // an unknown continent is dropped first, so `?region=021&continent=atlantis` is not first moved to a continent page
  if (params.continent && !groups.some((item) => item.kind === "continent" && item.id === params.continent)) {
    notices.push(`Unknown continent: ${echoValue(params.continent)}`);
    delete params.continent;
  }
  if (params.region) {
    const region = groups.find((item) => item.kind === "region" && item.id === params.region);
    if (!region) {
      notices.push(`Unknown region: ${echoValue(params.region)}`);
      delete params.region;
    } else {
      const target = groupPageTarget(groups, region);
      if (target.kind === "continent" && !params.continent) {
        notices.push(`${region.label} (region ${region.id}) has the same members as the continent: showing the continent page.`);
        params.continent ??= target.id;
        delete params.region;
        moved = true;
      }
    }
  }
  if (params.continent && params.region) {
    notices.push(`Showing the continent page only; region ${params.region} left out.`);
    delete params.region;
    moved = true;
  }
  const kind: GroupKind | undefined = params.continent ? "continent" : params.region ? "region" : undefined;
  const group = kind ? groups.find((item) => item.kind === kind && item.id === params[kind]) : undefined;
  return { group, notices, moved };
}

/** Checks `?region=` / `?continent=` against groups.json (shape checked in readParams), rewrites the address when the page
 * moves; returns the notices. */
export function resolveGroupParams(cfg: Config, params: Params, groups: GroupItem[]): string[] {
  const { notices, moved } = findGroup(groups, params);
  if (moved) history.replaceState(null, "", withParams(addressParams(cfg, params)));
  return notices;
}

function sortedYears(years: Record<string, unknown>): number[] {
  return Object.keys(years).map(Number).sort((a, b) => a - b);
}

function coverageNote(atlas: Atlas, group: GroupItem, series: SeriesId, figures: GroupSeries): string {
  return `“n of m” = members reporting that year, ${memberCoverageText(atlas, group, series, figures)}.`;
}

function nullYearNotes(figures: GroupSeries, overview: Overview): string[] {
  const byReason = new Map<GroupNullReason, number[]>();
  for (const [year, reason] of Object.entries(figures.null_reason)) byReason.set(reason, [...(byReason.get(reason) ?? []), Number(year)]);
  return [...byReason].map(([reason, years]) => `No total in ${yearRanges(years)}: ${nullReasonText(reason, overview)}.`);
}

function formerNote(atlas: Atlas, groupId: string): string | null {
  const notes = atlas.groupFigures[groupId]?.former_notes ?? [];
  if (notes.length === 0) return null;
  const label = labelOf(atlas);
  const covered = notes.map((note) => `${label(note.former)} (${note.former}) until ${note.until}: ${note.members.map(label).join(", ")}`);
  return `Former entities: ${covered.join("; ")}. In a year a member has no figure of its own and its former entity reported, ` +
    "the sum leaves that figure out (named per year in the figures).";
}

type CrossCheck = { gap: Record<number, number>; outside: number[]; note: string } | null;

/** WIPO total vs the member sum (plus the codes WIPO counts in the total that are no member, overview
 * `group_crosscheck_assignment`): gap = (total − sum) ÷ total; outside `group_crosscheck_range` = a warning year. */
function crossCheck(atlas: Atlas, overview: Overview, groupId: string, series: SeriesId, figures: GroupSeries): CrossCheck {
  const sums = figures.member_sum;
  if (figures.basis !== "wipo_total" || !sums) return null;
  const [low, high] = overview.method.group_crosscheck_range;
  const places = overview.method.rounding.decimals.share;
  const gap: Record<number, number> = {};
  for (const year of sortedYears(figures.total)) {
    const total = figures.total[String(year)] ?? null;
    const sum = sums[String(year)] ?? null;
    if (total !== null && sum !== null && total > 0) gap[year] = (total - sum) / total;
  }
  const years = sortedYears(gap);
  if (years.length === 0) return null;
  const outside = years.filter((year) => gap[year] < low || gap[year] > high);
  const extra = overview.method.group_crosscheck_assignment[series]?.[groupId] ?? [];
  const label = labelOf(atlas);
  const plus = extra.length ? ` plus ${extra.map((code) => `${label(code)} (${code})`).join(", ")} (counted in WIPO's total, in no member)` : "";
  const gaps = years.map((year) => gap[year]);
  const last = years[years.length - 1];
  return {
    gap,
    outside,
    note: `Cross-check: gap = (WIPO's total − sum of member countries${plus}) ÷ WIPO's total, ` +
      `${signedPercent(Math.min(...gaps), places)} to ${signedPercent(Math.max(...gaps), places)} over ${yearRanges(years)} ` +
      `(${last}: ${signedPercent(gap[last], places)}); expected ${signedPercent(low, places)} to ${signedPercent(high, places)}, ` +
      `as ${wipoTotalGapCause(series, PCT_UNLISTED_ORIGIN_GROUPS.includes(groupId))}. ` +
      (outside.length ? `Outside that range: ${yearRanges(outside)}.` : "Every year is inside that range."),
  };
}

/** Basis of a group card: WIPO-total wording per series from groupText (shared with the methods page). */
function basisNote(atlas: Atlas, overview: Overview, series: SeriesId, figures: GroupSeries, group: GroupItem, checkLabel: string): string {
  if (figures.basis !== "wipo_total") {
    return `Sum of the member countries of ${group.label} reporting each year; years without a total are named under the chart.`;
  }
  const label = labelOf(atlas);
  const added = (overview.method.group_crosscheck_assignment[series]?.[group.id] ?? []).map((code) => `${label(code)} (${code})`);
  const counts = wipoTotalCounts(series, added, PCT_UNLISTED_ORIGIN_GROUPS.includes(group.id) ? [group.label] : []);
  return `WIPO's own regional total for ${group.label} (code ${figures.source.entity ?? "–"}), which ${counts}; ` +
    `“${checkLabel}” is drawn beside it as a cross-check.`;
}

/** Group totals for one series: chart from the first year with a total; figures table with every year of the group file. */
function totalsCard(atlas: Atlas, overview: Overview, group: GroupItem, series: SeriesId): CardBuilder {
  const figures = atlas.groupFigures[group.id]?.series[series];
  const title = `${SERIES_TITLES[series]}, ${group.label}`;
  return {
    id: SERIES_CARD_IDS[series],
    problem: { title, message: figures
      ? `No total reported in any year. ${nullYearNotes(figures, overview).join(" ")}`
      : "The figures of this group could not be loaded." },
    build: (): CardContent | null => {
      if (!figures) return null;
      const years = sortedYears(figures.total);
      const valued = years.filter((year) => (figures.total[String(year)] ?? null) !== null);
      if (valued.length === 0) return null;
      const first = valued[0];
      const last = years[years.length - 1];
      const shown = years.filter((year) => year >= first);
      const values = atlas.values[series];
      const check = crossCheck(atlas, overview, group.id, series, figures);
      const totalKey = TOTAL_LINE[figures.basis];
      const checkKey = crossCheckLabel(atlas, overview, group.id, series);
      const at = (map: Record<string, number | null> | undefined, year: number): number | null => map?.[String(year)] ?? null;
      const points: LinePoint[] = shown.flatMap((year) => [
        { year, value: at(figures.total, year), ...(check ? { key: totalKey } : {}) },
        ...(check ? [{ year, value: at(figures.member_sum, year), key: checkKey }] : []),
      ]);
      const places = overview.method.rounding.decimals.share;
      const noteOf = (year: number): string => {
        const reason = figures.null_reason[String(year)];
        if (reason) return nullReasonText(reason, overview);
        if (check?.outside.includes(year)) return "cross-check outside the expected range";
        if (figures.basis === "member_sum" && values) return formerExclusionText(atlas, values, group.members, year) ?? "";
        return "";
      };
      const table: ChartTable = {
        headers: ["Year", totalKey, "Members reporting", ...(check ? [checkKey, "Gap"] : []), "Note"],
        rows: [...years].reverse().map((year): TableCell[] => [String(year), at(figures.total, year),
          `${figures.reporting[String(year)] ?? 0} of ${figures.members}`,
          ...(check ? [at(figures.member_sum, year), year in check.gap ? signedPercent(check.gap[year], places) : "–"] : []),
          noteOf(year)]),
        numeric: [true, true, false, ...(check ? [true, true] : []), false],
      };
      const former = figures.basis === "member_sum" ? formerNote(atlas, group.id) : null;
      const footnotes = [
        coverageNote(atlas, group, series, figures),
        ...nullYearNotes(figures, overview),
        ...(former ? [former] : []),
        ...(check ? [check.note] : []),
        ...(series === "origin_apps" ? [originAbroadNote(overview)] : []),
        ...(series === "pct_origin" ? [PCT_LATE_FILINGS] : []),
        ...seriesBreakNotes(overview, { group: group.id, series, first, last }),
      ];
      return {
        title: `${title}, ${first === last ? first : `${first}–${last}`}`,
        note: basisNote(atlas, overview, series, figures, group, checkKey),
        footnotes,
        draw: (width) => lineChart(points, check ? { width, keys: [totalKey, checkKey] } : { width }),
        table,
        source: figures.source,
      };
    },
  };
}

/** Group scale card: per ratio a tile for its `ratio_last_year` (value, "n of m" members, World beside) and a table of
 * every year (value, members reporting, reason). Left out when no ratio has a value. */
function scaleCard(atlas: Atlas, overview: Overview, group: GroupItem, ctx: CardContext): CardBuilder {
  return {
    id: GROUP_SCALE_CARD_ID,
    wide: true,
    build: (): CardContent | null => {
      const method = overview.method.ratios;
      const ratios = atlas.groupFigures[group.id]?.ratios;
      if (!method || !ratios) return null;
      const shown = shownRatios(overview).filter(({ id }) => ratios[id]);
      if (!shown.some(({ id, year }) => hasRatioValue(ratios[id]!.value, year))) return null;
      const format = (value: number | null | undefined): string => formatRatio(value ?? null, method.decimals);
      const members = (id: RatioId, year: number): string => `${ratios[id]!.reporting[String(year)] ?? 0} of ${ratios[id]!.members}`;
      const reasonOf = (id: RatioId, year: number): string => {
        const reason = ratios[id]!.null_reason[String(year)];
        return reason ? ratioNullText(reason, id, overview, "group") : "";
      };
      const world = (id: RatioId, year: number): string => format(overview.world_ratios?.[id]?.[String(year)]);
      const tiles: ScaleTile[] = shown.map(({ id, year }) => {
        const value = ratios[id]!.value[String(year)] ?? null;
        const reason = reasonOf(id, year);
        const basis = value !== null ? RATIO_BASIS_LABEL.computed : `no data reported${reason ? `: ${reason}` : ""}`;
        return { id, year, value: format(value), lines: [{ cls: "tile-basis", text: `${basis}, ${members(id, year)} members` },
          { cls: "tile-world", text: `World: ${world(id, year)}` }] };
      });
      const years = [...new Set(shown.flatMap(({ id, year }) => ratioYears(ratios[id]!.value, year)))].sort((a, b) => b - a);
      const ids = shown.map(({ id }) => id);
      const last = new Map(shown.map(({ id, year }) => [id, year]));
      const rows = years.map((year): TableCell[] => [String(year), ...ids.flatMap((id): TableCell[] => {
        if (year > (last.get(id) ?? 0) || !(String(year) in ratios[id]!.value)) return ["–", "–", ""];
        return [format(ratios[id]!.value[String(year)]), members(id, year), reasonOf(id, year)];
      })]);
      const header = (id: RatioId): string => RATIO_SHORT[id][0].toUpperCase() + RATIO_SHORT[id].slice(1);
      const gdp = shown.some(({ id }) => method.denominator[id] === "gdp_ppp");
      const numerator = (id: RatioId): SeriesId => method.numerator[id].series;
      const source = distinctSources(shown.flatMap(({ id }) => [overview.sources[numerator(id)],
        ...(isWipoRatio(id, overview) ? [overview.sources[id]] : [])]));
      // M4: a member's break in the numerator series the table spans (CN 2017: Eastern Asia, Asia)
      const footnotes = [...new Set(shown.flatMap(({ id, year }) => {
        const spanned = ratioYears(ratios[id]!.value, year);
        return spanned.length === 0 ? [] : seriesBreakNotes(overview,
          { group: group.id, series: numerator(id), first: spanned[spanned.length - 1], last: spanned[0] });
      }))];
      if (source.length === 0) return null;
      return {
        title: `Per capita and per GDP: ${group.label}`,
        note: `${group.label}: ${RATIO_BASIS_LABEL.computed}: the sum of its members' applications ÷ the sum of their ` +
          "population or GDP, over the members with both values that year (“n of m” = those members, of the members WIPO " +
          "lists for the series); no value where that sum is at or below the threshold WIPO applies to its per-million and per-GDP figures " +
          "(PCT per million uses the population threshold WIPO uses for its per-million figures). " +
          `World: ${worldBasisText(ids, overview)}. – = no data reported.` + (gdp ? ` ${gdpBasisLabel(ctx.manifest)}.` : ""),
        ...(footnotes.length > 0 ? { footnotes } : {}),
        draw: () => scaleTilesFigure(tiles),
        table: {
          headers: ["Year", ...ids.flatMap((id) => [header(id), `${header(id)}: members reporting`, `${header(id)}: note`])],
          rows,
          numeric: [true, ...ids.flatMap(() => [true, false, false])],
        },
        source,
        dataCredits: [wdiCredit(ctx.manifest)],
      };
    },
  };
}

/** Members with their latest value per series (the group file's last year), linked to their pages; a continent's
 * members also name their region. "not listed" = no WIPO row for the member in that series. */
function membersCard(atlas: Atlas, group: GroupItem, ctx: MapContext): CardBuilder {
  return {
    id: GROUP_MEMBERS_CARD_ID,
    wide: true,
    build: () => {
      const label = labelOf(atlas);
      const series = MAP_SERIES.filter((id) => atlas.groupFigures[group.id]?.series[id] && atlas.values[id]);
      const yearOf = (id: SeriesId): number => {
        const years = sortedYears(atlas.groupFigures[group.id]?.series[id]?.total ?? {});
        return years[years.length - 1];
      };
      const regions = group.kind === "continent"
        ? atlas.groups.filter((item) => item.kind === "region" && item.continent === group.id) : [];
      const regionCell = (code: string): TableCell => {
        const region = regions.find((item) => item.members.includes(code));
        if (!region) return "–";
        const target = groupPageTarget(atlas.groups, region);
        return { text: region.label, ...pageLinkOf(target.kind, target.id, ctx) };
      };
      const members = [...group.members].sort((a, b) => label(a).localeCompare(label(b)));
      const table: ChartTable = {
        headers: ["Country", "Code", ...(regions.length ? ["Region"] : []), ...series.map((id) => `${SERIES_TITLES[id]}, ${yearOf(id)}`)],
        rows: members.map((code): TableCell[] => [{ text: label(code), ...pageLinkOf("country", code, ctx) }, code,
          ...(regions.length ? [regionCell(code)] : []),
          ...series.map((id): TableCell => {
            const values = atlas.values[id].values[code];
            return values ? values[String(yearOf(id))] ?? null : "not listed";
          })]),
        numeric: [false, false, ...(regions.length ? [false] : []), ...series.map(() => true)],
      };
      const title = `Members of ${group.label}`;
      return {
        title,
        note: `${group.members.length} member countries (UN M49), latest year of each series. – = no data reported; ` +
          "“not listed” = WIPO publishes no figure for that member in the series.",
        draw: () => h("div", { class: "group-members" }, dataTable(table, title)),
        table,
        source: series.map((id) => atlas.values[id].sources[id]).filter((source): source is SourceBlock => Boolean(source)),
      };
    },
  };
}

/** The cards of a group page, in order (embed picks one by id): members, totals per series, scale ratios, women inventors, map zoomed to
 * the members. */
export function groupCards(atlas: Atlas, overview: Overview, group: GroupItem, ctx: CardContext): CardBuilder[] {
  const series = MAP_SERIES.filter((id) => atlas.groupFigures[group.id]?.series[id]);
  return [
    membersCard(atlas, group, ctx),
    ...series.map((id) => totalsCard(atlas, overview, group, id)),
    scaleCard(atlas, overview, group, ctx),
    { id: GROUP_WOMEN_CARD_ID, build: () => groupWomenCard(atlas.groupFigures[group.id], group, overview, atlas.entities), wide: true },
    mapCard(atlas, overview, mapOptions(overview, ctx.params), ctx, { label: group.label, members: group.members }),
  ];
}

function groupHeader(group: GroupItem, ctx: GroupPageContext): HTMLElement {
  const { atlas } = ctx;
  const link = (item: GroupItem): HTMLElement => {
    const target = groupPageTarget(atlas.groups, item);
    return h("a", { href: pageLinkOf(target.kind, target.id, ctx).href }, item.label);
  };
  const continent = atlas.groups.find((item) => item.kind === "continent" && item.id === group.continent);
  const regions = atlas.groups.filter((item) => item.kind === "region" && item.continent === group.id &&
    groupPageTarget(atlas.groups, item).kind === "region");
  const where = group.kind === "region"
    ? [`UN M49 code ${group.id}`, continent ? [" · in ", link(continent)] : null]
    : regions.length ? ["regions: ", regions.flatMap((item, index) => [index ? ", " : "", link(item)])] : null;
  const picker = h("div", { class: "picker" });
  renderPicker(picker, ctx.entities, atlas.groups, ctx, ctx.overview.size_growth);
  return h("header", { class: "page-intro entity-intro" },
    h("div", { class: "entity-title" }, h("h1", {}, group.label)),
    h("p", { class: "lede" }, KIND_TITLE[group.kind], where ? [" · ", where] : null),
    picker,
  );
}

/** Renders the page of group `id` (checked by resolveGroupParams) into `el`. */
export async function renderGroupPage(el: HTMLElement, id: string, kind: GroupKind, ctx: GroupPageContext): Promise<void> {
  const group = ctx.atlas.groups.find((item) => item.kind === kind && item.id === id);
  if (!group) throw new Error(`Unknown ${kind}: ${id}`);
  document.title = `${group.label} – ${ctx.cfg.siteName}`;
  const grid = h("div", { id: "charts", class: "chart-grid" });
  el.replaceChildren(groupHeader(group, ctx), grid);
  await themeLoaded();
  renderCards(grid, groupCards(ctx.atlas, ctx.overview, group, ctx), ctx satisfies CardContext);
}
