// World map card (chart id `world-map`). Country mode: each country coloured by its value in the chosen year, bins of
// powers of config `map.logBase` (fixed across years, so the year slider compares like with like). null = hatched
// "no data reported" (never the lightest bin); a reported 0 has its own swatch. Countries too small for the 110m
// geometry are dots (atlas points); a country with data and neither shape nor dot is listed "not drawn on map".
// Successor rule (spec "Map"): a successor of a former entity (groups.json `successors`) is "reported under <former>"
// (own pattern) in a year the former covered it, had a value, and the successor has none; only for a successor that
// reports in the series in some year (SX, BQ never report PCT: no data, no dot). Former entities' own figures: a
// table in "Show figures". Region / continent mode: each member coloured by its group's total (group files), "n of m"
// members reporting, a null year with its reason; links go to the group page.
// Neutral = a polygon whose id names no entities.json country (no id: Kosovo, N. Cyprus, Somaliland; 158 Taiwan,
// 732 W. Sahara, 304 Greenland, 010 Antarctica, ...): grey, unlabelled, no link, whatever the data.
// Ratio metrics (per million population, per $100bn GDP): own log scale (config `map.ratio`, mapScale.ts), WIPO's value
// or ours per cell ("Basis"), a null cell hatched with its reason, group modes read the group files' `ratios`.
// Women-inventor share metrics (WIPO 1040, 1042; by PUBLICATION year): linear percent bins (config `map.share`), 0.0 is bin 1
// (a real share), no successor ("reported under") rule, a null cell hatched with its reason (`genderNullText`). Country cells
// are WIPO's own; group modes read the group files' `gender` (computed with "n of m" and coverage, or WIPO's printed figure).
// PCT membership (map/pct_member.json, overview `pct_membership`): country mode only; member in year Y = PCT in force by
// 31 December Y (latest year as of WIPO's status date); member = solid fill, non-member = own pattern (dashes), a former
// entity is never a non-member (no data, its reason); a territory the PCT applies to through a Contracting State = member
// fill in its periods; a successor State in its window = no data (hatch), tooltip neutral (its own name and date, never
// the State it depended on). Source: WIPO's list, cited by link (a list source, never fetched).
// Colours, strokes, sizes: theme tokens `--map-*` via base.css classes; none here.
import { geoCentroid, geoEqualEarth, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";
import { MAP_METRICS, MAP_RATIOS, MAP_SHARES, isMapMembership, loadLazyValues, type MembershipMapValues, type MembershipNullReason, type PctTerritoryLink, type Atlas, type GroupGenderBlock, type GroupItem, type GroupNullReason, type LazyMetric, type MapMetric, type MapRatio, type MapShare, type MapValues, type ShareMapValues } from "./atlas";
import type { CardContext, TableCell } from "./chartCard";
import { cssLength } from "./charts";
import type { Config, Entities, EntityRef, GenderNullReason, ListSource, Overview, PctMembership, RatioMethod, RatioNullReason, SeriesId, SourceBlock, YearMap } from "./data";
import { formatCount, h } from "./dom";
import { distinctSources } from "./entityPage";
import { coverageText, memberCoverageParts, printedFigureLines } from "./genderCards";
import { nullReasonText } from "./groupText";
import { GENDER_BASIS_LABEL, GENDER_TITLES, formatShare, coverageFloorText, genderCaveat, genderDecimals, genderNullText, unlistedMembersText } from "./genderText";
import { mapScale, ratioBinLabel, ratioBinOf, ratioScale, shareBinLabel, shareBinOf, shareScale, type RatioScale, type ShareScale } from "./mapScale";
import { SERIES_TITLES, originAbroadNote } from "./methods";
import type { CardBuilder, CardContent } from "./overview";
import { PAGE_PARAMS, addressTheme, shareUrl, withParams, type Params } from "./params";
import { RATIO_BASIS_LABEL, RATIO_SHORT, RATIO_TITLES, formatRatio, gdpBasisLabel, ratioNullText, wdiCredit } from "./ratioText";

export const MAP_CARD_ID = "world-map";
export type MapMode = "country" | "region" | "continent";
export type GroupKind = Exclude<MapMode, "country">;
export type { MapMetric } from "./atlas";
export type MapOptions = { mode: MapMode; metric: MapMetric; year: number };
/** Group page map: zoomed to these members (shapes and dots), named in the card note. */
export type MapFocus = { label: string; members: string[] };
/** What the card needs besides the data: links (theme, compact embed). */
export type MapContext = CardContext;

const DEFAULT_METRIC: MapMetric = "origin_apps";
/** Default year: origin = overview `top_year`, else the series' world last year (plan v0.2a Global Constraints). */
const DEFAULT_YEAR: Record<MapMetric, (overview: Overview) => number> = {
  origin_apps: (overview) => overview.top_year,
  office_apps: (overview) => overview.world_last_year.world_office,
  pct_origin: (overview) => overview.world_last_year.pct_world,
  // a ratio: its tile year (latest year with any country value); `top_year` only for data written before v0.2b
  per_million: (overview) => overview.ratio_last_year?.per_million ?? overview.top_year,
  per_gdp: (overview) => overview.ratio_last_year?.per_gdp ?? overview.top_year,
  // a share: its last year with a World value (overview `gender.last_year`); `top_year` only for data written before v0.2w
  women_any: (overview) => overview.gender?.last_year.women_any ?? overview.top_year,
  women_share: (overview) => overview.gender?.last_year.women_share ?? overview.top_year,
  // membership: the status date's year (overview `pct_membership.last_year`)
  pct_member: (overview) => overview.pct_membership?.last_year ?? overview.top_year,
};
const WHAT: Record<SeriesId | MapRatio, string> = {
  origin_apps: "country of residence of the first-named applicant",
  office_apps: "national office where the application was filed",
  pct_origin: "country of residence of the first-named applicant",
  per_million: "country of residence of the first-named applicant",
  per_gdp: "country of residence of the first-named applicant",
};

function isRatioMetric(metric: MapMetric): metric is MapRatio {
  return (MAP_RATIOS as string[]).includes(metric);
}

function isShareMetric(metric: MapMetric): metric is MapShare {
  return (MAP_SHARES as string[]).includes(metric);
}

/** Card title of a metric (series title, the ratio's or the share's). */
function metricTitle(metric: MapMetric): string {
  return isMapMembership(metric) ? MEMBERSHIP_TITLE : isRatioMetric(metric) ? RATIO_TITLES[metric] : isShareMetric(metric) ? GENDER_TITLES[metric] : SERIES_TITLES[metric];
}

/** A share metric on the card: its scale (config `map.share`) and the decimals of a shown share (overview `method.gender`). */
type ShareView = { id: MapShare; scale: ShareScale; decimals: number };

/** A ratio metric on the card: its scale (config `map.ratio`), decimals and method constants (overview `method.ratios`). */
type RatioView = { id: MapRatio; scale: RatioScale; decimals: number; method: RatioMethod };
const SVG_NS = "http://www.w3.org/2000/svg";
/** Pattern ids; base.css fills reference them (`url(#world-map-hatch)`...). Special states differ by pattern as well as
 * colour (WCAG 1.4.1): hatch = no data reported, hatch on grey = not a WIPO country, dots = reported 0, hatch the other
 * way on its own ground = reported under a former entity. */
const HATCH_ID = `${MAP_CARD_ID}-hatch`;
const NEUTRAL_ID = `${MAP_CARD_ID}-neutral`;
const ZERO_ID = `${MAP_CARD_ID}-zero`;
const FORMER_ID = `${MAP_CARD_ID}-former`;
/** PCT non-member: staggered dashes (filled rects): no line and no dot, so it differs from every state above by geometry. */
const NONMEMBER_ID = `${MAP_CARD_ID}-nonmember`;
/** Hatch angles (degrees): the former-entity hatch leans the other way, so it differs from "no data" without colour. */
const HATCH_ANGLE = 45;
const FORMER_HATCH_ANGLE = -45;
/** Pattern spacing and dot radii (px) when the theme sets none (unthemed page): keeps the map legible. */
const UNTHEMED_HATCH_GAP = 4;
const UNTHEMED_DOT_RADIUS = 3;
const UNTHEMED_ZERO_GAP = 5;
const UNTHEMED_ZERO_MARK_RADIUS = 1;
const UNTHEMED_NONMEMBER_GAP = 3;
const UNTHEMED_NONMEMBER_MARK = 1.4;
/** Path coordinate precision (px): enough at any card width, keeps the DOM small. */
const PATH_DIGITS = 1;
/** Zoomed map (group page): height at most this × width, so a tall group (South America) keeps the card on screen. */
const FOCUS_MAX_HEIGHT_RATIO = 1;
export const MAP_DISCLAIMER = "The boundaries and names shown and the designations used on this map do not imply " +
  "official endorsement or acceptance by Patent Atlas or WIPO.";
export const MAP_CREDIT = "Map: Natural Earth (public domain), via world-atlas (ISC licence).";
/** Legend wording of the special states (the methods page describes the same states with these labels). */
export const MAP_STATE_LABELS = {
  zero: "0 reported",
  null: "No data reported",
  nullGroup: "No data reported (reason in the tooltip and figures)",
  former: "Reported under a former entity",
  neutral: "Area without a WIPO country code",
} as const;
const MODE_LABEL: Record<MapMode, string> = { country: "Countries", region: "Regions", continent: "Continents" };

/** Whether region or continent mode is offered for the metric (overview `method.group_basis`; office: continents; the
 * ratios and shares: all modes, a group without data is left out). */
export function modeOffered(overview: Overview, metric: MapMetric, mode: MapMode): boolean {
  return mode === "country" || (!isMapMembership(metric) &&
    (isRatioMetric(metric) || isShareMetric(metric) || Boolean(overview.method.group_basis[metric]?.[mode])));
}

type Bin = string; // "1".."bins", "zero", "null", "former"
type Shown = "area" | "dot" | "not drawn";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

type Shapes = { features: Feature<Geometry, { name: string }>[]; countries: Map<string, EntityRef> };
const shapesCache = new WeakMap<Atlas, Shapes>();

/** Features of the 110m geometry and entities.json countries by M49 numeric (geometry id), computed once. */
function shapes(atlas: Atlas): Shapes {
  let found = shapesCache.get(atlas);
  if (!found) {
    const collection = feature(atlas.geometry, atlas.geometry.objects.countries) as FeatureCollection<Geometry, { name: string }>;
    const countries = new Map(atlas.entities.filter((entity) => entity.kind === "country" && entity.iso_numeric)
      .map((entity) => [entity.iso_numeric as string, entity]));
    found = { features: collection.features, countries };
    shapesCache.set(atlas, found);
  }
  return found;
}

/** Years the slider offers: the first with a country value up to the default (latest complete) year. */
export function metricYears(atlas: Atlas, overview: Overview, metric: MapMetric): { first: number; last: number } {
  const last = DEFAULT_YEAR[metric](overview);
  if (isMapMembership(metric)) return { first: overview.pct_membership?.first_year ?? last, last }; // treaty in force .. status year
  const { countries } = shapes(atlas);
  const codes = new Set([...countries.values()].map((entity) => entity.code));
  let first = last;
  for (const [code, years] of Object.entries(atlas.values[metric]?.values ?? {})) {
    if (!codes.has(code)) continue;
    for (const [year, value] of Object.entries(years)) {
      if (value !== null && Number(year) < first) first = Number(year);
    }
  }
  return { first, last };
}

function clampYear(year: number, range: { first: number; last: number }): number {
  return Math.min(range.last, Math.max(range.first, year));
}

/** Notice for a map mode the metric has no group data for (address and metric control give the same text). */
function modeUnavailableNotice(metric: MapMetric, mode: string): string {
  return `Map mode “${mode}” is not available for ${metricTitle(metric)}: showing countries.`;
}

/** Shows `text` in the page's notice area (the metric control changes the mode after the address was checked). Marked
 * so the next control change removes it; notices raised at page load (address, config) carry no mark. */
function addPageNotice(text: string): void {
  const area = document.getElementById("notices");
  if (!area) return;
  area.append(h("p", { class: "notice", "data-map-control": "" }, text));
  area.hidden = false;
}

/** Removes the notices an earlier map control change raised (stale once the controls change again). */
function clearControlNotices(): void {
  const area = document.getElementById("notices");
  if (!area) return;
  area.querySelectorAll("[data-map-control]").forEach((notice) => notice.remove());
  area.hidden = area.children.length === 0;
}

/** Checks the map params against the data (shape checked in readParams): an unknown mode falls back to countries,
 * a year outside the metric's years is clamped. Changes `params` in place; returns the notices, with those for an
 * invalid config `map` (the card then draws the default scale). */
export function checkMapParams(atlas: Atlas, overview: Overview, params: Params, cfg: Config): string[] {
  const notices = [...mapScale(cfg.map).notices, ...ratioScale(cfg.map).notices,
    ...MAP_SHARES.flatMap((measure) => shareScale(cfg.map, measure).notices)];
  const metric = (params.metric ?? DEFAULT_METRIC) as MapMetric;
  if (params.map && !modeOffered(overview, metric, params.map as MapMode)) {
    notices.push(modeUnavailableNotice(metric, params.map));
    delete params.map;
  }
  if (params.year) {
    const asked = Number(params.year);
    const year = clampYear(asked, metricYears(atlas, overview, metric));
    if (year !== asked) {
      notices.push(`No map data for ${asked} (${metricTitle(metric)}): showing ${year}.`);
      params.year = String(year);
    }
  }
  return notices;
}

/** Map options from checked params; defaults: country mode, applications by origin, latest complete year. */
export function mapOptions(overview: Overview, params: Params): MapOptions {
  const metric = (params.metric ?? DEFAULT_METRIC) as MapMetric;
  return { mode: (params.map ?? "country") as MapMode, metric,
    year: params.year ? Number(params.year) : DEFAULT_YEAR[metric](overview) };
}

/** Bin of a value: "null" (no data), "zero" (reported 0), else 1.. `bins` (powers of `base`; the last open-ended). */
export function binOf(value: number | null, base: number, bins: number): Bin {
  if (value === null) return "null";
  if (value <= 0) return "zero";
  let bin = 1;
  for (let bound = base; value >= bound && bin < bins; bound *= base) bin += 1;
  return String(bin);
}

/** Range of a colour bin ("1–9", last "1,000,000 or more"). */
export function binLabel(bin: number, base: number, bins: number): string {
  const low = base ** (bin - 1);
  return bin === bins ? `${formatCount(low)} or more` : `${formatCount(low)}–${formatCount(base ** bin - 1)}`;
}

type Link = { href: string; target?: string };

/** Link to a country page (`country`) or a group page (`region` / `continent`). */
export function pageLinkOf(key: "country" | GroupKind, id: string, ctx: MapContext): Link {
  if (ctx.compact) {
    // the embed sits in a host page's iframe: open the full site, never navigate the frame
    return { href: shareUrl(ctx.cfg, withParams({ ...PAGE_PARAMS, theme: addressTheme(ctx.cfg), [key]: id }, "./")), target: "_blank" };
  }
  const theme = ctx.params.theme === ctx.cfg.defaultTheme ? undefined : ctx.params.theme;
  return { href: withParams({ ...PAGE_PARAMS, theme, [key]: id }, "./") };
}

function valueText(value: number | null, ratio?: RatioView): string {
  if (ratio) return value === null ? "no data reported" : formatRatio(value, ratio.decimals);
  return value === null ? "no data reported" : value === 0 ? "0 reported" : formatCount(value);
}

/** A shape or dot linking to its page; mouse only (tabindex -1): the figures table and the country
 * picker give the same content and navigation by keyboard without ~200 tab stops. */
function linked(shape: SVGElement, { href, target }: Link): SVGAElement {
  return svg("a", { href, tabindex: -1, ...(target ? { target, rel: "noopener" } : {}) }, shape);
}

/** Line hatch; `cross` adds the perpendicular line (neutral areas: cross hatch, so they differ from no data by geometry,
 * not by ground colour alone; WCAG 1.4.1, final review M10). */
function hatchPattern(id: string, backgroundClass: string, lineClass: string, gap: number, angle: number, cross = false): SVGPatternElement {
  return svg("pattern", { id, patternUnits: "userSpaceOnUse", width: gap, height: gap, patternTransform: `rotate(${angle})` },
    svg("rect", { class: backgroundClass, width: gap, height: gap }),
    svg("line", { class: lineClass, x1: 0, y1: 0, x2: 0, y2: gap }),
    ...(cross ? [svg("line", { class: lineClass, x1: 0, y1: 0, x2: gap, y2: 0 })] : []));
}

function patterns(): SVGDefsElement {
  const hatchGap = cssLength("--map-hatch-gap", UNTHEMED_HATCH_GAP);
  const zeroGap = cssLength("--map-zero-gap", UNTHEMED_ZERO_GAP);
  return svg("defs", {},
    hatchPattern(HATCH_ID, "map-hatch-bg", "map-hatch-line", hatchGap, HATCH_ANGLE),
    hatchPattern(NEUTRAL_ID, "map-neutral-bg", "map-neutral-line", hatchGap, HATCH_ANGLE, true),
    hatchPattern(FORMER_ID, "map-former-bg", "map-former-line", hatchGap, FORMER_HATCH_ANGLE),
    svg("pattern", { id: ZERO_ID, patternUnits: "userSpaceOnUse", width: zeroGap, height: zeroGap },
      svg("rect", { class: "map-zero-bg", width: zeroGap, height: zeroGap }),
      svg("circle", { class: "map-zero-mark", cx: zeroGap / 2, cy: zeroGap / 2, r: cssLength("--map-zero-mark-radius", UNTHEMED_ZERO_MARK_RADIUS) })),
    nonmemberPattern());
}

function nonmemberPattern(): SVGPatternElement {
  const gap = cssLength("--map-nonmember-gap", UNTHEMED_NONMEMBER_GAP);
  const mark = cssLength("--map-nonmember-mark-height", UNTHEMED_NONMEMBER_MARK);
  return svg("pattern", { id: NONMEMBER_ID, patternUnits: "userSpaceOnUse", width: 2 * gap, height: 2 * gap },
    svg("rect", { class: "map-nonmember-bg", width: 2 * gap, height: 2 * gap }),
    svg("rect", { class: "map-nonmember-mark", x: 0, y: (gap - mark) / 2, width: gap, height: mark }),
    svg("rect", { class: "map-nonmember-mark", x: gap, y: gap + (gap - mark) / 2, width: gap, height: mark }));
}

/** How one country is drawn: bin, tooltip, link (its page, or its group's), and a group null year's reason key. */
type Look = { bin: Bin; tip: string; link: Link; reason?: RatioNullReason | GenderNullReason | MembershipNullReason };

function shapeAttributes(code: string, look: Look): Record<string, string> {
  return { "data-code": code, "data-bin": look.bin, ...(look.reason ? { "data-reason": look.reason } : {}) };
}

/** Shapes and dots of the `members` (a group page's map), as one collection to fit the projection to; null when none is drawable. */
function focusCollection(atlas: Atlas, members: string[]): FeatureCollection | null {
  const { features, countries } = shapes(atlas);
  const wanted = new Set(members);
  const areas = features.filter((shape) => shape.id !== undefined && wanted.has(countries.get(String(shape.id))?.code ?? ""));
  const withArea = new Set(areas.map((shape) => countries.get(String(shape.id))?.code));
  const dots: Feature[] = members.filter((code) => !withArea.has(code) && atlas.points[code])
    .map((code) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: atlas.points[code] } }));
  const found = [...areas, ...dots];
  return found.length === 0 ? null : { type: "FeatureCollection", features: found };
}

/** World projection fitted to the card width, or (group page) centred on the members' centroid longitude (groups across the
 * antimeridian, such as Oceania, stay in one piece) and fitted to them, padded by a dot diameter, height capped. */
function projectionFor(atlas: Atlas, width: number, focus?: MapFocus): { projection: ReturnType<typeof geoEqualEarth>; height: number } {
  const { features } = shapes(atlas);
  const world: FeatureCollection = { type: "FeatureCollection", features };
  const target = focus ? focusCollection(atlas, focus.members) : null;
  if (target) {
    const pad = 2 * cssLength("--map-dot-radius", UNTHEMED_DOT_RADIUS);
    const projection = geoEqualEarth().rotate([-geoCentroid(target)[0], 0]).fitWidth(width - 2 * pad, target);
    const [[, top], [, bottom]] = geoPath(projection).bounds(target);
    const height = Math.ceil(Math.min(bottom - top + 2 * pad, width * FOCUS_MAX_HEIGHT_RATIO));
    projection.fitExtent([[pad, pad], [width - pad, height - pad]], target);
    // one point (or several at one place) has no extent: the world map instead
    if (Number.isFinite(projection.scale()) && height > 2 * pad) return { projection, height };
  }
  const projection = geoEqualEarth().fitWidth(width, world);
  return { projection, height: Math.ceil(geoPath(projection).bounds(world)[1][1]) };
}

/** `lookOf` gives every entities.json country's look; `dots` = codes drawn as a dot (no 110m shape, a point). */
function drawMap(atlas: Atlas, lookOf: (entity: EntityRef) => Look, dots: EntityRef[], width: number, focus?: MapFocus): SVGSVGElement {
  const { features, countries } = shapes(atlas);
  const { projection, height } = projectionFor(atlas, width, focus);
  const path = geoPath(projection).digits(PATH_DIGITS);
  const neutral: SVGElement[] = [];
  const coloured: SVGElement[] = [];
  for (const shape of features) {
    const d = path(shape);
    if (!d) continue;
    const entity = shape.id === undefined ? undefined : countries.get(String(shape.id));
    if (!entity) {
      neutral.push(svg("path", { class: "map-shape map-neutral", d, "data-id": shape.id === undefined ? "" : String(shape.id) }));
      continue;
    }
    const look = lookOf(entity);
    coloured.push(linked(svg("path", { class: "map-shape", d, ...shapeAttributes(entity.code, look) },
      svg("title", {}, look.tip)), look.link));
  }
  const circles: SVGElement[] = [];
  const radius = cssLength("--map-dot-radius", UNTHEMED_DOT_RADIUS);
  for (const entity of dots) {
    const at = projection(atlas.points[entity.code]);
    if (!at) continue;
    const look = lookOf(entity);
    circles.push(linked(svg("circle", { class: "map-shape map-dot", cx: at[0].toFixed(PATH_DIGITS), cy: at[1].toFixed(PATH_DIGITS), r: radius,
      ...shapeAttributes(entity.code, look) }, svg("title", {}, look.tip)), look.link));
  }
  return svg("svg", { class: "map-svg", viewBox: `0 0 ${width} ${height}`, width, height },
    patterns(),
    svg("g", { class: "map-neutral-layer" }, ...neutral),
    svg("g", { class: "map-country-layer" }, ...coloured),
    svg("g", { class: "map-dot-layer" }, ...circles));
}

function swatch(bin: Bin | "neutral", label: string): HTMLElement {
  const rect = bin === "neutral"
    ? svg("rect", { class: "map-shape map-neutral", width: "100%", height: "100%" })
    : svg("rect", { class: "map-shape", "data-bin": bin, width: "100%", height: "100%" });
  return h("li", { "data-bin": bin }, svg("svg", { class: "map-swatch", "aria-hidden": "true" }, rect), label);
}

function shareLegend(share: ShareView): HTMLElement {
  // linear percent bins; 0.0 is a real share (bin 1: no zero swatch); no former entities; a null cell's reason is in its
  // tooltip and the figures (it differs by cell: not published, low coverage, not computable)
  const { step, bins } = share.scale;
  return h("div", { class: "map-legend" },
    h("p", { class: "map-legend-title" }, `Linear scale: bins of ${step} percentage points, by publication year`),
    h("ul", {},
      Array.from({ length: bins }, (_, index) => swatch(String(index + 1), shareBinLabel(index + 1, share.scale))),
      swatch("null", MAP_STATE_LABELS.nullGroup),
      swatch("neutral", MAP_STATE_LABELS.neutral),
    ));
}

function countLegend(scale: { logBase: number; bins: number }, mode: MapMode, ratio?: RatioView): HTMLElement {
  const { logBase, bins } = scale;
  // a ratio: bins half-open from the configured lowest bound (labels carry the bounds); 0.0 only from a count of 0 (WIPO
  // publishes no 0.0; a count above 0 rounding to 0.0 is null, below_precision); no former entities
  return h("div", { class: "map-legend" },
    h("p", { class: "map-legend-title" }, `Log scale: bins of powers of ${logBase}`),
    h("ul", {},
      swatch("zero", ratio ? formatRatio(0, ratio.decimals) : MAP_STATE_LABELS.zero),
      Array.from({ length: bins }, (_, index) =>
        swatch(String(index + 1), ratio ? ratioBinLabel(index + 1, ratio.scale) : binLabel(index + 1, logBase, bins))),
      swatch("null", mode === "country" ? MAP_STATE_LABELS.null : MAP_STATE_LABELS.nullGroup),
      mode === "country" && !ratio ? swatch("former", MAP_STATE_LABELS.former) : null,
      swatch("neutral", MAP_STATE_LABELS.neutral),
    ));
}

function controls(atlas: Atlas, overview: Overview, state: MapOptions, range: { first: number; last: number },
  changed: () => void): HTMLElement {
  const mode = h("select", { id: `${MAP_CARD_ID}-mode` },
    (Object.keys(MODE_LABEL) as MapMode[]).map((id) => h("option", { value: id,
      ...(id === state.mode ? { selected: "" } : {}),
      ...(modeOffered(overview, state.metric, id) ? {} : { disabled: "" }) }, MODE_LABEL[id])));
  mode.addEventListener("change", () => {
    clearControlNotices();
    state.mode = mode.value as MapMode;
    changed();
  });
  // a ratio is offered when the data carry ratio constants (v0.2b on), a share when they carry the gender block (v0.2w on);
  // their files load when chosen (M6)
  const metric = h("select", { id: `${MAP_CARD_ID}-metric` },
    MAP_METRICS.filter((id) => atlas.values[id] || (isRatioMetric(id) && overview.method.ratios) ||
      (isShareMetric(id) && overview.gender && overview.method.gender) || (isMapMembership(id) && overview.pct_membership)).map((id) =>
      h("option", { value: id, ...(id === state.metric ? { selected: "" } : {}) }, metricTitle(id))));
  metric.addEventListener("change", async () => {
    clearControlNotices();
    const chosen = metric.value as MapMetric;
    if ((isRatioMetric(chosen) || isShareMetric(chosen) || isMapMembership(chosen)) && !atlas.values[chosen]) {
      metric.disabled = true;
      const loaded = await loadLazyValues(atlas, chosen as LazyMetric);
      metric.disabled = false;
      if (!loaded) {
        addPageNotice(`The figures for ${metricTitle(chosen)} could not be loaded.`);
        metric.value = state.metric;
        return;
      }
    }
    state.metric = chosen;
    state.year = clampYear(state.year, metricYears(atlas, overview, state.metric));
    if (!modeOffered(overview, state.metric, state.mode)) { // office by region: none
      addPageNotice(modeUnavailableNotice(state.metric, state.mode));
      state.mode = "country";
    }
    changed();
  });
  const label = h("output", { class: "map-year-value", for: `${MAP_CARD_ID}-year` }, String(state.year));
  const year = h("input", { id: `${MAP_CARD_ID}-year`, type: "range", min: String(range.first), max: String(range.last),
    step: "1", value: String(state.year) });
  // `input` while dragging only updates the label: redrawing would replace the slider under the pointer
  year.addEventListener("input", () => { label.textContent = year.value; });
  year.addEventListener("change", () => {
    clearControlNotices();
    state.year = Number(year.value);
    changed();
  });
  return h("div", { class: "map-controls" },
    h("label", {}, "Show ", mode),
    h("label", {}, "Measure ", metric),
    h("label", { class: "map-year" }, "Year ", year, label));
}

/** The world map card. Sync: the atlas is preloaded. Mode, metric and year controls (full page only) change the card's
 * own state and ask renderCards to redraw it (`card-state` event; the address and cite links follow). */
export function mapCard(atlas: Atlas, overview: Overview, opts: MapOptions, ctx: MapContext, focus?: MapFocus): CardBuilder {
  const state: MapOptions = { ...opts };
  return {
    id: MAP_CARD_ID,
    wide: true,
    // country = the default: no `map` param
    params: () => ({ map: state.mode === "country" ? undefined : state.mode, metric: state.metric, year: String(state.year) }),
    build: () => mapContent(atlas, overview, state, ctx, focus),
  };
}

type Predecessor = { former: EntityRef; until: number; from: number };
const predecessorsCache = new WeakMap<Atlas, Map<string, Predecessor[]>>();

/** Successor code -> the former entities that covered it, and when (groups.json `successors`), computed once. */
function predecessors(atlas: Atlas): Map<string, Predecessor[]> {
  let found = predecessorsCache.get(atlas);
  if (!found) {
    const entities = new Map(atlas.entities.map((entity) => [entity.code, entity]));
    found = new Map();
    for (const [code, successors] of Object.entries(atlas.successors)) {
      const former = entities.get(code) ?? { code, label: code } as EntityRef;
      for (const successor of successors) {
        found.set(successor.code, [...(found.get(successor.code) ?? []),
          { former, from: successor.from_year, until: successor.to_year }]);
      }
    }
    predecessorsCache.set(atlas, found);
  }
  return found;
}

function reports(years: Record<string, number | null> | undefined): boolean {
  return Object.values(years ?? {}).some((value) => value !== null);
}

/** The former entity `code` is reported under in `year` (successor rule, file header), else undefined. */
function reportedUnder(atlas: Atlas, values: MapValues, code: string, year: number): EntityRef | undefined {
  const own = values.values[code];
  if ((own?.[String(year)] ?? null) !== null || !reports(own)) return undefined;
  return predecessors(atlas).get(code)?.find((covered) => covered.from <= year && year <= covered.until &&
    (values.values[covered.former.code]?.[String(year)] ?? null) !== null)?.former;
}

/** Caveat for a member-sum group total: the figures of former entities that members are reported under in `year`
 * (successor rule) are not in the sum, e.g. "Excludes figures reported under Yugoslavia (332)"; undefined when none. */
export function formerExclusionText(atlas: Atlas, values: MapValues, members: string[], year: number): string | undefined {
  const formers = new Map<string, EntityRef>();
  for (const code of members) {
    const former = reportedUnder(atlas, values, code, year);
    if (former) formers.set(former.code, former);
  }
  if (formers.size === 0) return undefined;
  const named = [...formers.values()].map((former) =>
    `${former.label} (${formatCount(values.values[former.code][String(year)] as number)})`);
  return `Excludes figures reported under ${named.join(", ")}`;
}

/** Former entities listed for the series: their years with data, successors (until when), value in `year`. */
function formerTable(atlas: Atlas, values: MapValues, year: number, valueHeader: string): CardContent["moreTables"] {
  const entities = new Map(atlas.entities.map((entity) => [entity.code, entity]));
  const rows = Object.entries(atlas.successors).filter(([code]) => values.values[code]).map(([code, successors]) => {
    const reported = Object.entries(values.values[code]).filter(([, value]) => value !== null).map(([at]) => Number(at));
    const years = reported.length === 0 ? "no data" : `${Math.min(...reported)}–${Math.max(...reported)}`;
    const byEnd = new Map<number, string[]>();
    for (const successor of successors) {
      byEnd.set(successor.to_year, [...(byEnd.get(successor.to_year) ?? []), entities.get(successor.code)?.label ?? successor.code]);
    }
    const named = byEnd.size === 0 ? "none"
      : [...byEnd].map(([until, labels]) => `${labels.join(", ")} (until ${until})`).join("; ");
    return [`${entities.get(code)?.label ?? code} (${code})`, years, named, values.values[code][String(year)] ?? null];
  });
  if (rows.length === 0) return undefined;
  return [{ caption: "Former entities", table: { headers: ["Former entity", "Years", "Successors", valueHeader], rows,
    numeric: [false, false, false, true] } }];
}

/** Label of an entity code (the code itself when entities.json has none). */
export function labelOf(atlas: Atlas): (code: string) => string {
  return labelOfEntities(atlas.entities);
}

/** labelOf from the entity list alone (methods page, which loads no atlas). */
export function labelOfEntities(entities: Entities): (code: string) => string {
  const labels = new Map(entities.map((entity) => [entity.code, entity.label]));
  return (code) => labels.get(code) ?? code;
}

/** Members WIPO does not list for the series (no row in map/<series>.json): outside "m". */
export function unlistedMembers(atlas: Atlas, group: GroupItem, series: SeriesId): string[] {
  const values = atlas.values[series]?.values ?? {};
  return group.members.filter((code) => !(code in values));
}

/** What "m" in "n of m" counts, and the members outside it: "of the 44 members WIPO lists for this series; not listed by
 * WIPO for this series: Guernsey (GG) (45 members in all)". Shared by the region page and the map's region modes. */
export function memberCoverageText(atlas: Atlas, group: GroupItem, series: SeriesId, figures: { members: number }): string {
  return coverageSentence(labelOf(atlas), unlistedMembers(atlas, group, series), group, figures);
}

/** The same for a women-inventor measure: the members outside m are the group file's `gender.<measure>.unlisted` (members with
 * no PCT publications row), not a lookup in a map file. Reads "of the 44 members with PCT publications data; without PCT
 * publications data: Guernsey (GG) (45 members in all)". */
export function genderMemberCoverageText(atlas: Atlas, group: GroupItem, block: { members: number; unlisted: string[] }): string {
  const label = labelOf(atlas);
  const missing = unlistedMembersText(block.unlisted.map((code) => `${label(code)} (${code})`), group.members.length);
  return `of the ${block.members} members with PCT publications data${missing && `; ${missing}`}`;
}

function coverageSentence(label: (code: string) => string, unlisted: string[], group: GroupItem, figures: { members: number }): string {
  const missing = unlisted.length === 0 ? ""
    : `; not listed by WIPO for this series: ${unlisted.map((code) => `${label(code)} (${code})`).join(", ")} ` +
      `(${group.members.length} members in all)`;
  return `of the ${figures.members} members WIPO lists for this series${missing}`;
}

function mapContent(atlas: Atlas, overview: Overview, state: MapOptions, ctx: MapContext, focus?: MapFocus): CardContent | null {
  const metric = state.metric;
  const range = metricYears(atlas, overview, metric);
  if (isMapMembership(metric)) {
    const values = atlas.values[metric];
    const block = overview.pct_membership;
    if (!values || !block) return null; // data written before v2a
    return cardOf(atlas, overview, state, ctx, focus, membershipContent(atlas, values, block, state, ctx), range, () => membershipLegend(block));
  }
  if (isShareMetric(metric)) {
    const values = atlas.values[metric];
    const source = values?.sources[metric];
    if (!values || !source || !(overview.gender && overview.method.gender)) return null; // no gender data before v0.2w
    const share: ShareView = { id: metric, scale: shareScale(ctx.cfg.map, metric).scale, decimals: genderDecimals(overview) };
    const bin = (value: number | null): Bin => shareBinOf(value, share.scale);
    const content = state.mode === "country" ? shareCountryContent(atlas, overview, values, state, bin, ctx, source, share)
      : shareGroupContent(atlas, overview, state, state.mode, bin, ctx, share);
    return cardOf(atlas, overview, state, ctx, focus, content, range, () => shareLegend(share));
  }
  const values = atlas.values[metric];
  const source = values?.sources[metric];
  if (!values || !source) return null;
  const method = overview.method.ratios;
  if (isRatioMetric(metric) && !method) return null; // data written before v0.2b has no ratio constants
  const ratio: RatioView | undefined = isRatioMetric(metric) && method
    ? { id: metric, scale: ratioScale(ctx.cfg.map).scale, decimals: method.decimals, method } : undefined;
  const scale = ratio?.scale ?? mapScale(ctx.cfg.map).scale;
  const bin = (value: number | null): Bin => ratio ? ratioBinOf(value, ratio.scale) : binOf(value, scale.logBase, scale.bins);
  const what = WHAT[metric];
  const content = state.mode === "country"
    ? countryContent(atlas, overview, values, state, bin, ctx, source, what, ratio)
    : groupContent(atlas, overview, state, state.mode, bin, ctx, what, ratio);
  return cardOf(atlas, overview, state, ctx, focus, content, range, () => countLegend(scale, state.mode, ratio),
    metric === "origin_apps" ? [originAbroadNote(overview)] : [], ratio ? [wdiCredit(ctx.manifest)] : undefined);
}

/** The card around a mode's content: zoom note, footnotes, controls, map, legend, disclaimer and credits (every metric). */
function cardOf(atlas: Atlas, overview: Overview, state: MapOptions, ctx: MapContext, focus: MapFocus | undefined, content: ModeContent,
  range: { first: number; last: number }, legendOf: () => HTMLElement, extraFootnotes: string[] = [], dataCredits?: string[]): CardContent {
  const footnotes = [...(content.footnotes ?? []), ...extraFootnotes];
  let figure: HTMLElement | undefined;
  const changed = (): void => { figure?.dispatchEvent(new Event("card-state", { bubbles: true })); };
  return {
    ...content,
    ...(focus ? { note: `${content.note} Zoomed to the members of ${focus.label}.` } : {}),
    ...(footnotes.length ? { footnotes } : {}),
    draw: (width) => {
      figure = h("div", { class: "map-figure" },
        ctx.compact ? null : controls(atlas, overview, state, range, changed),
        drawMap(atlas, content.lookOf, content.dots, width, focus),
        legendOf(),
        content.below,
        h("p", { class: "map-disclaimer" }, MAP_DISCLAIMER));
      return figure;
    },
    credits: [MAP_CREDIT],
    ...(dataCredits ? { dataCredits } : {}),
  };
}


/** How a country is drawn: an area when it has a shape; else a dot when it has a point and something to show (a value, a
 * former entity it is reported under, or a hatched null with a reason); else listed "not drawn" (value, no point) or not at all. */
function shownOf(atlas: Atlas, withShape: Set<string>, numeric: string, code: string,
  cell: { hasValue: boolean; former?: boolean; hatchedNull: boolean }): Shown | null {
  if (withShape.has(numeric)) return "area";
  const point = code in atlas.points;
  if (!cell.hasValue && !cell.former && !(cell.hatchedNull && point)) return null;
  return point ? "dot" : "not drawn";
}

/** Paragraph under the legend naming the countries with a value and no shape or dot; null when none. */
function notDrawnNote(items: string[]): HTMLElement | null {
  return items.length === 0 ? null : h("p", { class: "map-not-drawn" }, "Not drawn on map (no shape at this scale): ", items.join(", "), ".");
}

/** The groups of `kind` whose file failed to load (atlas.missingGroups), and their members' group: those countries say so,
 * never "in no region". */
function failedGroupsOf(atlas: Atlas, kind: GroupKind): { failed: GroupItem[]; failedOf: Map<string, GroupItem> } {
  const failed = atlas.groups.filter((group) => group.kind === kind && atlas.missingGroups.includes(group.id));
  return { failed, failedOf: new Map(failed.flatMap((group) => group.members.map((code) => [code, group] as const))) };
}

/** Look of a country, in group mode, whose group has no figures (file failed) or that is in no group of the kind. */
function groupGapLook(atlas: Atlas, kind: GroupKind, year: number, entity: EntityRef, lost: GroupItem | undefined, ctx: MapContext): Look {
  if (lost) {
    const target = groupPageTarget(atlas.groups, lost);
    return { bin: "null", link: pageLinkOf(target.kind, target.id, ctx), tip: `${lost.label} (${entity.label}): figures could not be loaded` };
  }
  return { bin: "null", link: pageLinkOf("country", entity.code, ctx), tip: `${entity.label}: in no ${kind} (${year})` };
}

/** Table row of a group whose file failed to load: label link, `middle` cells, the reason. */
function failedGroupRow(atlas: Atlas, group: GroupItem, ctx: MapContext, middle: TableCell[]): TableCell[] {
  const target = groupPageTarget(atlas.groups, group);
  return [{ text: group.label, ...pageLinkOf(target.kind, target.id, ctx) }, ...middle, "figures could not be loaded"];
}

const failedGroupsFootnote = (failed: GroupItem[]): string[] => (failed.length
  ? [`The figures of ${failed.map((group) => group.label).join(", ")} could not be loaded: their countries show no data.`] : []);

/** Countries (by `groupOf`) with no shape and a point: drawn as dots in group modes. */
function groupDots(atlas: Atlas, groupOf: Map<string, unknown>): EntityRef[] {
  const { features, countries } = shapes(atlas);
  const withShape = new Set(features.map((shape) => String(shape.id)));
  return [...countries].filter(([numeric, entity]) => !withShape.has(numeric) && entity.code in atlas.points && groupOf.has(entity.code))
    .map(([, entity]) => entity);
}

type ModeContent = Omit<CardContent, "draw" | "credits"> & {
  lookOf: (entity: EntityRef) => Look;
  dots: EntityRef[];
  /** Under the legend: countries not drawn (country mode). */
  below: HTMLElement | null;
};

type Row = { entity: EntityRef; value: number | null; former?: EntityRef; shown: Shown | null;
  /** Ratio cell: why it is null, or whose value it is. */
  reason?: RatioNullReason; basis?: "wipo" | "computed" };

/** Sentence of a ratio cell's basis for tooltip and table. */

function countryContent(atlas: Atlas, overview: Overview, values: MapValues, state: MapOptions, bin: (value: number | null) => Bin,
  ctx: MapContext, source: SourceBlock, what: string, ratio?: RatioView): ModeContent {
  const { features, countries } = shapes(atlas);
  const withShape = new Set(features.map((shape) => String(shape.id)));
  const rows = new Map<string, Row>();
  for (const [numeric, entity] of countries) {
    const years = values.values[entity.code];
    if (!years) continue; // not listed for this series
    const value = years[String(state.year)] ?? null;
    const former = reportedUnder(atlas, values, entity.code, state.year);
    const reason = ratio && value === null ? values.null_reason?.[entity.code]?.[String(state.year)] : undefined;
    // no dot for a null with nothing to say; a ratio null with counts but no usable denominator is a hatched dot
    // (below WIPO's threshold, no WDI data: review focus 1), one with no applications at all stays undrawn like a count
    const shown = shownOf(atlas, withShape, numeric, entity.code,
      { hasValue: value !== null, former: former !== undefined, hatchedNull: reason !== undefined && reason !== "no_applications" });
    const basis = ratio && value !== null ? (values.computed?.[entity.code]?.includes(state.year) ? "computed" : "wipo") : undefined;
    rows.set(entity.code, { entity, value, former, shown, reason, basis });
  }
  const reasonText = (row: Row): string => (ratio && row.reason ? ratioNullText(row.reason, ratio.id, overview) : "");
  const valueOf = (row: Row): string => (row.former ? `reported under ${row.former.label}` : valueText(row.value, ratio));
  const tipOf = (entity: EntityRef, row: Row | undefined): string => {
    if (!ratio || !row) return `${entity.label}: ${row ? valueOf(row) : valueText(null)} (${state.year})`;
    if (row.value === null) return `${entity.label}: ${valueText(null)}${row.reason ? `: ${reasonText(row)}` : ""} (${state.year})`;
    return `${entity.label}: ${valueOf(row)} (${state.year}); Basis: ${RATIO_BASIS_LABEL[row.basis ?? "wipo"]}`;
  };
  const notDrawn = [...rows.values()].filter((row) => row.shown === "not drawn");
  const sorted = [...rows.values()].sort((a, b) =>
    (b.value ?? -1) - (a.value ?? -1) || a.entity.label.localeCompare(b.entity.label));
  const office = state.metric === "office_apps"
    ? " Regional offices (such as the European Patent Office) are not countries and are not on the map." : "";
  const valueHeader = ratio ? `${RATIO_SHORT[ratio.id][0].toUpperCase()}${RATIO_SHORT[ratio.id].slice(1)}, ${state.year}`
    : `Applications, ${state.year}`;
  const note = ratio
    ? `Each country coloured by its resident patent applications ${RATIO_SHORT[ratio.id]}, counted by ${what}: ` +
      `WIPO's own figure where WIPO publishes one, else ${RATIO_BASIS_LABEL.computed}. Countries too small to draw are dots; ` +
      "a hatched country has no value (reason in its tooltip and the figures); click a country for its page." +
      (ratio.method.denominator[ratio.id] === "gdp_ppp" ? ` ${gdpBasisLabel(ctx.manifest)}.` : "")
    : `Each country coloured by its applications, counted by ${what}.${office} ` +
      "Countries too small to draw are dots; click a country for its page.";
  const shownSources = ratio ? distinctSources([source, overview.sources[ratio.method.numerator[ratio.id].series]]) : source;
  return {
    title: `${metricTitle(state.metric)}, ${state.year}`,
    note,
    lookOf: (entity) => {
      const row = rows.get(entity.code);
      return { bin: row?.former ? "former" : bin(row?.value ?? null), link: pageLinkOf("country", entity.code, ctx),
        reason: row?.reason, tip: tipOf(entity, row) };
    },
    dots: [...rows.values()].filter((row) => row.shown === "dot").map((row) => row.entity),
    below: notDrawnNote(notDrawn.map((row) => `${row.entity.label} (${row.former ? valueOf(row) : ratio ? valueText(row.value, ratio) : formatCount(row.value)})`)),
    table: ratio ? {
      headers: ["Country", "Code", valueHeader, "Basis", "On the map", "Note"],
      rows: sorted.map((row) => [row.entity.label, row.entity.code,
        row.value === null ? null : formatRatio(row.value, ratio.decimals),
        row.basis ? RATIO_BASIS_LABEL[row.basis] : null, row.shown ?? "no data", reasonText(row)]),
      numeric: [false, false, true, false, false, false],
    } : {
      headers: ["Country", "Code", valueHeader, "On the map"],
      rows: sorted.map((row) => [row.entity.label, row.entity.code,
        row.former ? valueOf(row) : row.value, row.shown ?? "no data"]),
      numeric: [false, false, true, false],
    },
    moreTables: ratio ? undefined : formerTable(atlas, values, state.year, valueHeader),
    source: shownSources,
  };
}

/** One group's figures for the metric, one shape for series (group file `series`) and ratios (`ratios`): `computed` = a
 * ratio, always our sum ÷ sum. */
type GroupView = {
  basis: "wipo_total" | "member_sum" | "computed"; total: YearMap; reporting: Record<string, number>; members: number;
  null_reason: Record<string, RatioNullReason>; source: SourceBlock | SourceBlock[];
};

type GroupRow = { group: GroupItem; figures: GroupView; total: number | null; reporting: number; reason?: RatioNullReason;
  /** Formers whose figures the member sum leaves out (formerExclusionText). */
  excludes?: string };

/** Page kind and id a group links to: a region whose members equal its continent's (Northern America) links to the
 * continent page (the region has no page of its own). */
export function groupPageTarget(groups: GroupItem[], group: GroupItem): { kind: GroupKind; id: string } {
  const continent = group.kind === "region" ? groups.find((item) => item.kind === "continent" && item.id === group.continent) : undefined;
  const same = continent && continent.members.length === group.members.length &&
    continent.members.every((code) => group.members.includes(code));
  return same ? { kind: "continent", id: continent.id } : { kind: group.kind, id: group.id };
}

function groupContent(atlas: Atlas, overview: Overview, state: MapOptions, kind: GroupKind,
  bin: (value: number | null) => Bin, ctx: MapContext, what: string, ratio?: RatioView): ModeContent {
  const year = String(state.year);
  // the series whose members "m" counts: the metric, or a ratio's numerator
  const coverageSeries: SeriesId = ratio ? ratio.method.numerator[ratio.id].series : state.metric as SeriesId;
  const viewOf = (id: string): GroupView | undefined => {
    const file = atlas.groupFigures[id];
    if (!ratio) {
      const figures = file?.series[coverageSeries];
      return figures && { basis: figures.basis, total: figures.total, reporting: figures.reporting, members: figures.members,
        null_reason: figures.null_reason, source: figures.source };
    }
    const figures = file?.ratios?.[ratio.id];
    return figures && { basis: "computed", total: figures.value, reporting: figures.reporting, members: figures.members,
      null_reason: figures.null_reason, source: distinctSources([overview.sources[coverageSeries], overview.sources[ratio.id as keyof Overview["sources"]]]) };
  };
  const groups: GroupRow[] = atlas.groups.filter((group) => group.kind === kind).flatMap((group) => {
    const figures = viewOf(group.id);
    if (!figures) return [];
    const total = figures.total[year] ?? null;
    return [{ group, figures, total, reporting: figures.reporting[year] ?? 0,
      reason: total === null ? figures.null_reason[year] : undefined,
      excludes: total !== null && figures.basis === "member_sum"
        ? formerExclusionText(atlas, atlas.values[coverageSeries], group.members, state.year) : undefined }];
  });
  const groupOf = new Map(groups.flatMap((row) => row.group.members.map((code) => [code, row] as const)));
  const { failed, failedOf } = failedGroupsOf(atlas, kind);
  const reasonText = (reason: RatioNullReason): string =>
    ratio ? ratioNullText(reason, ratio.id, overview, "group") : nullReasonText(reason as GroupNullReason, overview);
  const totalText = (row: GroupRow): string =>
    row.total === null && row.reason ? `no data reported: ${reasonText(row.reason)}` : valueText(row.total, ratio);
  const groupLink = (row: GroupRow): Link => {
    const target = groupPageTarget(atlas.groups, row.group);
    return pageLinkOf(target.kind, target.id, ctx);
  };
  const coverage = (row: GroupRow): string => `${row.reporting} of ${row.figures.members}`;
  const { features, countries } = shapes(atlas);
  const withShape = new Set(features.map((shape) => String(shape.id)));
  const sorted = [...groups].sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.group.label.localeCompare(b.group.label));
  const valueHeader = ratio ? `${RATIO_SHORT[ratio.id][0].toUpperCase()}${RATIO_SHORT[ratio.id].slice(1)}, ${state.year}`
    : `Applications, ${state.year}`;
  const totalCell = (row: GroupRow): TableCell => (ratio && row.total !== null ? formatRatio(row.total, ratio.decimals) : row.total);
  const noteOf = (row: GroupRow): string => (row.reason ? reasonText(row.reason)
    : row.figures.basis === "wipo_total" ? "WIPO regional total"
      : `sum of reporting members${row.excludes ? `. ${row.excludes}` : ""}`);
  return {
    title: `${metricTitle(state.metric)}, by ${kind}, ${state.year}`,
    note: ratio
      ? `Each country coloured by its ${kind}'s resident patent applications ${RATIO_SHORT[ratio.id]}, counted by ${what}: ` +
        `${RATIO_BASIS_LABEL.computed}, the sum of the members' applications ÷ the sum of their ${ratio.method.denominator[ratio.id] === "gdp_ppp" ? "GDP" : "population"} ` +
        `over the members with both values that year; “n of m” = those members of all the members WIPO lists. Click a country for its ${kind}'s page.` +
        (ratio.method.denominator[ratio.id] === "gdp_ppp" ? ` ${gdpBasisLabel(ctx.manifest)}.` : "")
      : `Each country coloured by its ${kind}'s total, counted by ${what}; “n of m” = member countries ` +
        `reporting that year. Click a country for its ${kind}'s page.`,
    lookOf: (entity) => {
      const row = groupOf.get(entity.code);
      if (!row) return groupGapLook(atlas, kind, state.year, entity, failedOf.get(entity.code), ctx);
      return { bin: bin(row.total), reason: row.reason, link: groupLink(row),
        tip: `${row.group.label} (${entity.label}): ${totalText(row)} (${state.year}); ${coverage(row)} countries reporting` +
          (row.excludes ? `. ${row.excludes}` : "") + (ratio ? `; Basis: ${RATIO_BASIS_LABEL.computed}` : "") };
    },
    dots: groupDots(atlas, groupOf),
    below: null,
    table: {
      headers: [kind === "region" ? "Region" : "Continent", valueHeader, "Countries reporting",
        ...(ratio ? ["Basis"] : []), "Note"],
      rows: [...sorted.map((row): TableCell[] => [{ text: row.group.label, ...groupLink(row) }, totalCell(row), coverage(row),
        ...(ratio ? [row.total === null ? null : RATIO_BASIS_LABEL.computed] : []), noteOf(row)]),
      ...failed.map((group) => failedGroupRow(atlas, group, ctx, [null, "–", ...(ratio ? ["–"] : [])]))],
      numeric: [false, true, false, ...(ratio ? [false] : []), false],
    },
    footnotes: [...groups.filter((row) => unlistedMembers(atlas, row.group, coverageSeries).length > 0)
      .map((row) => `${row.group.label}: “n of m” counts members reporting that year, ${memberCoverageText(atlas, row.group, coverageSeries, row.figures)}.`),
    ...failedGroupsFootnote(failed)],
    source: groups.map((row) => row.figures.source).flat(),
  };
}

/** What a share metric measures, in running text. */
const SHARE_PHRASE: Record<MapShare, string> = {
  women_any: "share of PCT applications with at least one woman inventor",
  women_share: "women's share of PCT inventors",
};

function shareValueHeader(state: MapOptions): string {
  return `Share, ${state.year} (publication year)`;
}

type ShareRow = { entity: EntityRef; value: number | null; reason?: GenderNullReason; shown: Shown | null };

/** Country mode of a share metric: WIPO's own published share per country ("Basis: WIPO"), a null year hatched with its
 * reason (`genderNullText`), no successor rule, no zero state. */
function shareCountryContent(atlas: Atlas, overview: Overview, values: ShareMapValues, state: MapOptions, bin: (value: number | null) => Bin,
  ctx: MapContext, source: SourceBlock, share: ShareView): ModeContent {
  const { features, countries } = shapes(atlas);
  const withShape = new Set(features.map((shape) => String(shape.id)));
  const year = String(state.year);
  const rows = new Map<string, ShareRow>();
  for (const [numeric, entity] of countries) {
    const years = values.values[entity.code];
    if (!years) continue; // not listed for this measure
    const value = years[year] ?? null;
    const reason = value === null ? values.null_reason?.[entity.code]?.[year] : undefined;
    // a null with a reason and a point is a hatched dot; one with nothing to say and no shape stays undrawn
    const shown = shownOf(atlas, withShape, numeric, entity.code, { hasValue: value !== null, hatchedNull: reason !== undefined });
    rows.set(entity.code, { entity, value, reason, shown });
  }
  const reasonText = (row: ShareRow): string => (row.reason ? genderNullText(row.reason, overview) : "");
  const tipOf = (entity: EntityRef, row: ShareRow | undefined): string => {
    if (!row || row.value === null) {
      return `${entity.label}: no data reported${row?.reason ? `: ${reasonText(row)}` : ""} (${state.year})`;
    }
    return `${entity.label}: ${formatShare(row.value, share.decimals)} (${state.year}); Basis: ${GENDER_BASIS_LABEL.wipo}`;
  };
  const notDrawn = [...rows.values()].filter((row) => row.shown === "not drawn");
  const sorted = [...rows.values()].sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.entity.label.localeCompare(b.entity.label));
  return {
    title: `${GENDER_TITLES[share.id]}, ${state.year} (publication year)`,
    note: `Each country coloured by its ${SHARE_PHRASE[share.id]}, as WIPO publishes it. Countries too small to draw are dots; ` +
      "a hatched country has no value (WIPO omits some country-years; reason in its tooltip and the figures); click a country for its page.",
    lookOf: (entity) => {
      const row = rows.get(entity.code);
      return { bin: bin(row?.value ?? null), link: pageLinkOf("country", entity.code, ctx), reason: row?.reason, tip: tipOf(entity, row) };
    },
    dots: [...rows.values()].filter((row) => row.shown === "dot").map((row) => row.entity),
    below: notDrawnNote(notDrawn.map((row) => `${row.entity.label} (${formatShare(row.value, share.decimals)})`)),
    table: {
      headers: ["Country", "Code", shareValueHeader(state), "Basis", "On the map", "Note"],
      rows: sorted.map((row) => [row.entity.label, row.entity.code,
        row.value === null ? null : formatShare(row.value, share.decimals),
        row.value === null ? null : GENDER_BASIS_LABEL.wipo, row.shown ?? "no data", reasonText(row)]),
      numeric: [false, false, true, false, false, false],
    },
    footnotes: genderCaveat(overview),
    source,
  };
}

/** `missing`: the group's file loaded but holds no figures of the measure (an empty block stands in). */
type ShareGroupRow = { group: GroupItem; block: GroupGenderBlock; total: number | null; reason?: GenderNullReason;
  basis: "wipo" | "computed" | null; missing: boolean };
const EMPTY_GENDER_BLOCK: GroupGenderBlock = { value: {}, null_reason: {}, reporting: {}, members: 0, unlisted: [], coverage: {}, wipo_years: [] };
const MISSING_FIGURES_TEXT = "no figures of this measure in the group's file";

/** Region / continent mode of a share metric: each member coloured by its group's value, from the group file's `gender`:
 * computed from members' WIPO shares weighted by PCT publications ("n of m" members, coverage), WIPO's printed figure in
 * `wipo_years`, else null with its reason (`women_share` is not computable for a group). */
function shareGroupContent(atlas: Atlas, overview: Overview, state: MapOptions, kind: GroupKind, bin: (value: number | null) => Bin,
  ctx: MapContext, share: ShareView): ModeContent {
  const year = String(state.year);
  const metric = share.id;
  const { failed, failedOf } = failedGroupsOf(atlas, kind);
  const groups: ShareGroupRow[] = atlas.groups.filter((group) => group.kind === kind && !failed.includes(group)).map((group) => {
    const found = atlas.groupFigures[group.id]?.gender?.[metric];
    const block = found ?? EMPTY_GENDER_BLOCK;
    const total = block.value[year] ?? null;
    return { group, block, total, reason: total === null ? block.null_reason[year] : undefined, missing: !found,
      basis: total === null ? null : block.wipo_years.includes(state.year) ? "wipo" : "computed" };
  });
  const groupOf = new Map(groups.flatMap((row) => row.group.members.map((code) => [code, row] as const)));
  const basisText = (row: ShareGroupRow): string | null => (row.basis ? GENDER_BASIS_LABEL[row.basis] : null);
  const reasonOf = (row: ShareGroupRow): string => (row.missing ? MISSING_FIGURES_TEXT : row.reason ? genderNullText(row.reason, overview) : "");
  const valueText = (row: ShareGroupRow): string => (row.total === null
    ? `no data reported${reasonOf(row) ? `: ${reasonOf(row)}` : ""}` : formatShare(row.total, share.decimals));
  // a not-computable year has no member count (reporting null): no "n of m", never "0 of m"
  const hasMembers = (row: ShareGroupRow): boolean => row.reason !== "not_computable" && (row.block.reporting[year] ?? null) !== null;
  const memberParts = (row: ShareGroupRow): string[] => (hasMembers(row) ? memberCoverageParts(row.block, year, overview) : []);
  const groupLink = (row: { group: GroupItem }): Link => {
    const target = groupPageTarget(atlas.groups, row.group);
    return pageLinkOf(target.kind, target.id, ctx);
  };
  const sorted = [...groups].sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.group.label.localeCompare(b.group.label));
  const noteOf = (row: ShareGroupRow): string => {
    if (row.basis !== "wipo") return reasonOf(row);
    const printed = atlas.groupFigures[row.group.id]?.sources?.[metric]?.printed?.[year];
    return `WIPO's printed figure${printed ? ` ${printed.figure}` : ""}`;
  };
  const floor = coverageFloorText(overview);
  return {
    title: `${GENDER_TITLES[metric]}, by ${kind}, ${state.year} (publication year)`,
    note: metric === "women_any"
      ? `Each country coloured by its ${kind}'s ${SHARE_PHRASE[metric]}: ${GENDER_BASIS_LABEL.computed}; “n of m” = members with a published ` +
        `share of the members with PCT publications data; coverage = their share of the ${kind}'s PCT publications` +
        `${floor === null ? "" : ` (a value needs at least ${floor})`}. Click a country for its ${kind}'s page.`
      : `Each country coloured by its ${kind}'s ${SHARE_PHRASE[metric]}: ${genderNullText("not_computable", overview)}, except where WIPO ` +
        `prints a figure for the same countries (labelled WIPO). WIPO prints continent figures${kind === "region" ? "; region 021 takes Northern America's because its members are the same" : ""}. Click a country for its ${kind}'s page.`,
    lookOf: (entity) => {
      const row = groupOf.get(entity.code);
      if (!row) return groupGapLook(atlas, kind, state.year, entity, failedOf.get(entity.code), ctx);
      const detail = [...(row.basis ? [`Basis: ${basisText(row)}`] : []), ...memberParts(row)];
      return { bin: bin(row.total), reason: row.reason, link: groupLink(row),
        tip: `${row.group.label} (${entity.label}): ${valueText(row)} (${state.year})${detail.length ? `; ${detail.join("; ")}` : ""}` };
    },
    dots: groupDots(atlas, groupOf),
    below: null,
    table: {
      headers: [kind === "region" ? "Region" : "Continent", shareValueHeader(state), "Members reporting", "Coverage", "Basis", "Note"],
      rows: [...sorted.map((row): TableCell[] => {
        const reporting = row.block.reporting[year];
        const coverage = row.block.coverage[year];
        return [{ text: row.group.label, ...groupLink(row) }, row.total === null ? null : formatShare(row.total, share.decimals),
          hasMembers(row) ? `${reporting} of ${row.block.members}` : null,
          coverage === null || coverage === undefined || !reporting || !hasMembers(row) ? null : coverageText(coverage, overview),
          basisText(row), noteOf(row)];
      }),
      ...failed.map((group) => failedGroupRow(atlas, group, ctx, [null, null, null, null]))],
      numeric: [false, true, false, true, false, false],
    },
    footnotes: [
      ...(metric === "women_any" ? groups.filter((row) => row.block.unlisted.length > 0)
        .map((row) => `${row.group.label}: “n of m” counts members with a published share, ${genderMemberCoverageText(atlas, row.group, row.block)}.`) : []),
      ...groups.filter((row) => row.basis === "wipo").flatMap((row) => printedFigureLines(metric, row.group.label,
        { wipoYears: [state.year], source: atlas.groupFigures[row.group.id]?.sources?.[metric] })),
      ...failedGroupsFootnote(failed),
      ...genderCaveat(overview)],
    source: distinctSources([atlas.values[metric]?.sources[metric], ...groups.map((row) => atlas.groupFigures[row.group.id]?.sources?.[metric])]),
  };
}

export const MEMBERSHIP_TITLE = "PCT membership";
/** Legend wording of the membership layer. */
export const MEMBERSHIP_LABELS = {
  member: "PCT member (or covered through a Contracting State)", nonmember: "Not a PCT member", null: "No data (reason in the tooltip and figures)",
} as const;
const MEMBERSHIP_NULL_TEXT: Record<MembershipNullReason, string> = {
  not_on_current_list: "not on WIPO's current list of PCT Contracting States (former entity)",
  successor_state: "treaty status depended on a former State, or on a State it left, in that year; not shown",
};
/** Contracting States whose English name takes "the" in a sentence ("through the United Kingdom"); WIPO's list prints
 * the bare name. */
const NAME_WITH_ARTICLE = /^(Netherlands|United |Russian Federation|Republic of |Philippines|Dominican Republic)/;
const PCT_LIST_NAME = "WIPO, PCT Contracting States";

export function membershipNullText(reason: MembershipNullReason): string {
  return MEMBERSHIP_NULL_TEXT[reason] ?? reason;
}

/** A State's name as a sentence reads it: "the Netherlands", "China". */
export function stateInProse(name: string): string {
  return NAME_WITH_ARTICLE.test(name) ? `the ${name}` : name;
}

/** One period of a territory: "applied through the United Kingdom 1981-04-15 to 1997-06-30" (closed) or "applies
 * through China since 1997-07-01". */
function territorySpan(period: PctTerritoryLink[number]): string {
  return period.to ? `applied through ${stateInProse(period.state)} ${period.from} to ${period.to}`
    : `applies through ${stateInProse(period.state)} since ${period.from}`;
}

/** "58 of today's PCT Contracting States bound by 31 December 1990"; the latest year "as of" the status date. Today's
 * States only: WIPO's current list gives no dates for former States; territories are not counted. */
export function membershipCountText(block: PctMembership, year: number): string {
  const count = block.count[String(year)];
  return `${count} of today's PCT Contracting States bound ${year === block.last_year ? `as of ${block.status_on}` : `by 31 December ${year}`}`;
}

/** States whose date WIPO prints as that of the State they continue (card footnote, methods page). */
export function continuingText(block: PctMembership): string {
  return `Continuing States, date as printed by WIPO: ${block.continuing.map((state) => `${state.name} (continuing ${state.continues})`).join(", ")}.`;
}

/** The card's source: WIPO's list, count and status date from the overview. */
function membershipSource(block: PctMembership): ListSource {
  return { kind: "list", name: PCT_LIST_NAME, url: block.source_url, status: `${block.count[String(block.last_year)]} States on ${block.status_on}`,
    retrieved: block.retrieved };
}

function membershipLegend(block: PctMembership): HTMLElement {
  return h("div", { class: "map-legend" },
    h("p", { class: "map-legend-title" }, `PCT in force by 31 December of the year (${block.last_year}: as of ${block.status_on})`),
    h("ul", {}, swatch("member", MEMBERSHIP_LABELS.member), swatch("nonmember", MEMBERSHIP_LABELS.nonmember),
      swatch("null", MEMBERSHIP_LABELS.null), swatch("neutral", MAP_STATE_LABELS.neutral)));
}

type MemberRow = {
  entity: EntityRef; member: boolean | null; inForce?: string; reason?: MembershipNullReason; shown: Shown | null;
  territory?: PctTerritoryLink; successorOf?: { code: string; name: string };
};

/** Tooltip / table text of a row (no label): a listed State, a territory (PCT through a Contracting State, never one
 * itself), a successor State in its window (not shown; its own name and date only, neutral), or a non-member. */
function memberText(row: MemberRow, year: string): string {
  const { member, territory, successorOf } = row;
  if (territory) {
    const covering = territory.filter((period) => period.from.slice(0, 4) <= year && (!period.to || period.to.slice(0, 4) >= year));
    return `${member ? `PCT ${covering.map(territorySpan).join("; ")}` : `Not covered in ${year}; PCT ${territory.map(territorySpan).join("; ")}`} (not a Contracting State)`;
  }
  if (member === null) {
    if (successorOf) {
      const name = row.entity.label;
      return `${year}: not shown; ${row.inForce ? `WIPO lists ${name} as bound by the PCT only from ${row.inForce}`
        : `WIPO does not list ${name} as bound by the PCT`}`;
    }
    return `no data${row.reason ? `: ${membershipNullText(row.reason)}` : ""}`;
  }
  return member ? `Bound since ${row.inForce}` : `Not a PCT member in ${year}${row.inForce ? ` (bound from ${row.inForce})` : ""}`;
}

/** Country mode of the membership layer: member (a territory: PCT applies through a Contracting State), non-member, or
 * null with its reason (a successor State in its window; a former entity in the file: no shape, listed in its own
 * table, never as a non-member). */
function membershipContent(atlas: Atlas, values: MembershipMapValues, block: PctMembership, state: MapOptions, ctx: MapContext): ModeContent {
  const { features, countries } = shapes(atlas);
  const withShape = new Set(features.map((shape) => String(shape.id)));
  const year = String(state.year);
  const rows = new Map<string, MemberRow>();
  for (const [numeric, entity] of countries) {
    if (!(entity.code in values.values)) continue;
    const member = values.values[entity.code][year] ?? null;
    const reason = member === null ? values.null_reason[entity.code] : undefined;
    rows.set(entity.code, { entity, member, inForce: values.in_force[entity.code], reason,
      territory: values.territories[entity.code], successorOf: reason === "successor_state" ? values.successor_of[entity.code] : undefined,
      shown: shownOf(atlas, withShape, numeric, entity.code, { hasValue: member !== null, hatchedNull: reason !== undefined }) });
  }
  const tipOf = (entity: EntityRef, row: MemberRow | undefined): string => (!row ? `${entity.label}: no data (${year})`
    : `${entity.label}: ${memberText(row, year)}${row.member === null && !row.successorOf ? ` (${year})` : ""}`);
  const sorted = [...rows.values()].sort((a, b) => Number(b.member) - Number(a.member) || a.entity.label.localeCompare(b.entity.label));
  const label = labelOf(atlas);
  const formers = Object.keys(values.null_reason).filter((code) => !(code in values.values));
  const drawnText = (row: MemberRow): string => (row.territory ? (row.member ? "PCT applies through a Contracting State" : "not covered")
    : row.member === null ? "no data" : row.member ? "member" : "not a member");
  const notDrawn = notDrawnNote([...rows.values()].filter((row) => row.shown === "not drawn").map((row) => `${row.entity.label} (${drawnText(row)})`));
  const unmatched = values.unmatched.length === 0 ? null
    : h("p", { class: "map-unmatched" }, `PCT States not on the map (no WIPO statistics entity): ${values.unmatched.map(label).join(", ")}.`);
  return {
    title: `${MEMBERSHIP_TITLE}, ${year}`,
    note: `${membershipCountText(block, state.year)}. A country is a member in a year when it was bound by the PCT by 31 December ` +
      `(${block.last_year}: as of ${block.status_on}); a territory, when the PCT applied to it through a Contracting State. ` +
      "Countries too small to draw are dots; click a country for its page.",
    lookOf: (entity) => {
      const row = rows.get(entity.code);
      return { bin: row?.member === true ? "member" : row?.member === false ? "nonmember" : "null", reason: row?.reason,
        link: pageLinkOf("country", entity.code, ctx), tip: tipOf(entity, row) };
    },
    dots: [...rows.values()].filter((row) => row.shown === "dot").map((row) => row.entity),
    below: notDrawn || unmatched ? h("div", { class: "map-below" }, notDrawn, unmatched) : null,
    table: {
      headers: ["Country", `PCT member ${year}`, "Bound by the PCT since"],
      rows: sorted.map((row) => [row.entity.label,
        row.territory || row.successorOf ? memberText(row, year) : row.member === null ? null : row.member ? "Yes" : "No", row.inForce ?? null]),
      numeric: [false, false, false],
    },
    moreTables: formers.length === 0 ? undefined : [{ caption: "Former entities", table: {
      headers: ["Former entity", `PCT member ${year}`, "Note"],
      rows: formers.map((code) => [`${label(code)} (${code})`, null, membershipNullText(values.null_reason[code])]),
      numeric: [false, false, false] } }],
    footnotes: block.continuing.length ? [continuingText(block)] : [],
    source: membershipSource(block),
  };
}
