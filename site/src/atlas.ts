// Atlas bundle for the world map: geometry (site/geo, scripts/build_geo.py), dots for countries too small for the
// 110m geometry, map values per series (pipeline/write.py `_map_file`), groups and former-entity successors
// (groups.json), group figures (group/<id>.json, for region and continent modes), entities (ISO2 -> M49 numeric =
// geometry id). Loaded once per page, in parallel with the page data. Ratio and share map files (~270 KB each) load only
// when that metric is shown: asked by the address at load, or chosen later (`loadLazyValues`; final review M6).
import type { GeometryCollection, Topology } from "topojson-specification";
import { loadJson, type Entities, type GenderMeasure, type GenderNullReason, type GroupRatio, type RatioId, type RatioNullReason, type SeriesId, type SourceBlock, type YearMap } from "./data";

/** Series the map can show. */
export const MAP_SERIES: SeriesId[] = ["origin_apps", "office_apps", "pct_origin"];
/** Ratios the map can show (spec map list: per capita, per GDP; PCT per million stays on the cards). */
export type MapRatio = "per_million" | "per_gdp";
export const MAP_RATIOS: MapRatio[] = ["per_million", "per_gdp"];
/** Women-inventor shares the map can show (WIPO 1040 and 1042, by publication year). */
export type MapShare = GenderMeasure;
export const MAP_SHARES: MapShare[] = ["women_any", "women_share"];
export type MapMetric = SeriesId | MapRatio | MapShare;
/** Metrics whose map file loads only when shown. */
export type LazyMetric = MapRatio | MapShare;
/** Every map metric, in the metric control's order. */
export const MAP_METRICS: MapMetric[] = [...MAP_SERIES, ...MAP_RATIOS, ...MAP_SHARES];

export type CountryGeometry = Topology<{ countries: GeometryCollection<{ name: string }> }>;

/** map/<metric>.json: countries and former states, years cut at the series' world last year (ratios: at the tile year).
 * Ratio files add `computed` (per country the years whose value is ours, not WIPO's) and `null_reason` (per country and
 * year why it is null); `sources` holds the WIPO table of a ratio or share. Share files carry `null_reason` (no `computed`:
 * a country share is WIPO's). */
export type MapValues<Reason extends string = RatioNullReason> = {
  values: Record<string, YearMap>;
  sources: Partial<Record<MapMetric, SourceBlock>>;
  computed?: Record<string, number[]>;
  null_reason?: Record<string, Record<string, Reason>>;
};
/** A share map file: its null reasons are the gender ones. */
export type ShareMapValues = MapValues<GenderNullReason>;

/** A country whose territory a former entity covered, and the years it did (pipeline/successors.json). */
export type Successor = { code: string; from_year: number; to_year: number };

export type GroupItem = {
  id: string;
  kind: "continent" | "region";
  label: string;
  continent: string;
  members: string[];
};

/** Why a group year is null (pipeline/groups.py null reason keys). */
export type GroupNullReason = "no_wipo_regional_total" | "attribution_floor" | "none_reported" | "no_wipo_world_total";

/** Fixed panel of a member_sum series (pipeline/groups.py `panel`): members reporting in every year first..last, and
 * their sum; first/last null when no year is left. */
export type GroupPanel = { first: number | null; last: number | null; members: string[]; total: YearMap };

/** One series of a group file: `total` (WIPO's regional row or member sum, by `basis`), `reporting` of `members` (the
 * group's members WIPO lists for the series); `member_sum` = cross-check sum (wipo_total only); `panel` (member_sum only). */
export type GroupSeries = {
  basis: "wipo_total" | "member_sum";
  total: YearMap;
  reporting: Record<string, number>;
  members: number;
  null_reason: Record<string, GroupNullReason>;
  source: SourceBlock;
  member_sum?: YearMap;
  panel?: GroupPanel;
};

/** A former entity that covered members of the group, until when (pipeline/groups.py `former_notes`). */
export type FormerNote = { former: string; members: string[]; until: number };

/** WIPO's printed figure behind a group value in `wipo_years` (PCT Yearly Review figure and page). */
export type GroupPrintedFigure = { citation: string; figure: string; page: string; url: string };

/** A group's women-inventor measure (pipeline/gender.py): `value` = computed from members' WIPO shares weighted by PCT
 * publications, or WIPO's printed figure in `wipo_years` (then `reporting` and `coverage` are null); `women_share` is
 * `not_computable` outside `wipo_years`. `reporting` of `members` hold `coverage` of the group's PCT publications. */
export type GroupGenderBlock = {
  value: YearMap;
  null_reason: Record<string, GenderNullReason>;
  reporting: Record<string, number | null>;
  members: number;
  /** M49 members outside m: no PCT publications row (codes; `unlisted.length + members` = the group's members). */
  unlisted: string[];
  coverage: Record<string, number | null>;
  wipo_years: number[];
};

/** Source of a group's gender measure: the series' source block plus the weights query (computed values) and the printed
 * citations by year (WIPO's values). */
export type GroupGenderSource = SourceBlock & { weights?: string; printed?: Record<string, GroupPrintedFigure> };

/** group/<id>.json; a series is absent where the group kind does not offer it (office by region). */
export type GroupFigures = {
  id: string; label: string; series: Partial<Record<SeriesId, GroupSeries>>; former_notes?: FormerNote[];
  /** Absent in data written before v0.2b. */
  ratios?: Partial<Record<RatioId, GroupRatio>>;
  /** Absent in data written before v0.2w. */
  gender?: Record<GenderMeasure, GroupGenderBlock>;
  /** Sources of the gender measures (absent with `gender`). */
  sources?: Partial<Record<GenderMeasure, GroupGenderSource>>;
};

export type Atlas = {
  geometry: CountryGeometry;
  /** [lon, lat] dot per country with no 110m shape (site/geo/points.json). */
  points: Record<string, [number, number]>;
  /** Series: always loaded; a ratio or share: once shown (`loadLazyValues`). */
  values: Record<SeriesId, MapValues> & Partial<Record<MapRatio, MapValues>> & Partial<Record<MapShare, ShareMapValues>>;
  groups: GroupItem[];
  /** Former entity code -> successors (DD: none, Germany reports itself). */
  successors: Record<string, Successor[]>;
  /** Group id -> its figures (a group whose file failed to load is absent). */
  groupFigures: Record<string, GroupFigures>;
  /** Ids of the groups whose file failed to load: only those groups lose their figures (final review M2). */
  missingGroups: string[];
  entities: Entities;
};

/** Source of the groupings (UN M49) and of the former-entity table, as groups.json cites them. */
export type GroupingSource = { name: string; url: string; retrieved: string; table: string; use: string };
export type FormerEntitiesSource = { name: string; path: string; retrieved: string; section: string };

/** groups.json: `no_group` = code -> why M49 gives it no region (pipeline/m49.py NO_GROUP; map polygons only). */
export type GroupsFile = {
  items: GroupItem[];
  successors: Record<string, Successor[]>;
  no_group: Record<string, string>;
  sources: { groupings: GroupingSource[]; former_entities: FormerEntitiesSource[] };
};
type PointsFile = { points: Record<string, [number, number]> };

export function isMapRatio(metric: string | undefined): metric is MapRatio {
  return (MAP_RATIOS as (string | undefined)[]).includes(metric);
}

export function isMapShare(metric: string | undefined): metric is MapShare {
  return (MAP_SHARES as (string | undefined)[]).includes(metric);
}

/** The ratio or share map file a `metric` address param needs at load (none for a series or no param). */
export function lazyMetricsFor(metric: string | undefined): LazyMetric[] {
  return isMapRatio(metric) || isMapShare(metric) ? [metric] : [];
}

/** `lazy`: the ratio or share map files to load with the atlas (the address' metric); the others load when chosen. */
export async function loadAtlas(lazy: LazyMetric[] = []): Promise<Atlas> {
  const metrics: MapMetric[] = [...MAP_SERIES, ...lazy];
  const [geometry, points, groups, entities, ...series] = await Promise.all([
    loadJson<CountryGeometry>("geo/countries-110m.json"),
    loadJson<PointsFile>("geo/points.json"),
    loadJson<GroupsFile>("data/groups.json"),
    loadJson<Entities>("data/entities.json"),
    ...metrics.map((id) => loadJson<MapValues>(`data/map/${id}.json`)),
  ]);
  const values = Object.fromEntries(metrics.map((id, index) => [id, series[index]])) as Atlas["values"];
  // one failing group file drops that group only (notice via missingGroupsNotice); map, cards and picker stand
  const figures = await Promise.all(groups.items.map((group) =>
    loadJson<GroupFigures>(`data/group/${group.id}.json`).catch(() => null)));
  const groupFigures = Object.fromEntries(figures.flatMap((file) => (file ? [[file.id, file]] : [])));
  const missingGroups = groups.items.filter((_, index) => figures[index] === null).map((group) => group.id);
  return { geometry, points: points.points, values, groups: groups.items, successors: groups.successors, groupFigures, missingGroups, entities };
}

const lazyLoads = new WeakMap<Atlas, Map<LazyMetric, Promise<boolean>>>();

/** Loads a ratio's or share's map file into `atlas.values` once (a failed load may be retried); false when it could not load. */
export function loadLazyValues(atlas: Atlas, id: LazyMetric): Promise<boolean> {
  if (atlas.values[id]) return Promise.resolve(true);
  const loads = lazyLoads.get(atlas) ?? new Map<LazyMetric, Promise<boolean>>();
  lazyLoads.set(atlas, loads);
  let load = loads.get(id);
  if (!load) {
    const path = `data/map/${id}.json`;
    const loaded = isMapShare(id)
      ? loadJson<ShareMapValues>(path).then((file) => { atlas.values[id] = file; })
      : loadJson<MapValues>(path).then((file) => { atlas.values[id] = file; });
    load = loaded.then(() => true, (error: unknown) => {
      console.error(error);
      loads.delete(id);
      return false;
    });
    loads.set(id, load);
  }
  return load;
}

/** Page notice naming the groups whose figures could not be loaded; null when all loaded. */
export function missingGroupsNotice(atlas: Atlas): string | null {
  if (atlas.missingGroups.length === 0) return null;
  const labels = atlas.missingGroups.map((id) => atlas.groups.find((group) => group.id === id)?.label ?? id);
  return `The figures of ${labels.join(", ")} could not be loaded: ${labels.length === 1 ? "that group shows" : "those groups show"} no totals.`;
}
