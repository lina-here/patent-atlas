// Types mirror the pipeline output (pipeline/write.py build_outputs, manifest checks from pipeline/run.py).
// Year keys are strings ("2024"); a missing value is null, never 0.
import type { GroupNullReason } from "./atlas";

export type Config = {
  siteName: string;
  author: string;
  contact: string;
  defaultTheme: string;
  themes: string[];
  baseUrl: string;
  /** Theme preselected in "Embed" snippets (used when listed in `themes`). */
  embedTheme: string;
  /** iframe height (px) written into embed snippets; the host page may change it. */
  embedHeight: number;
  /** Wallboard rotation (`?rotate=<seconds>`): the shortest interval accepted, seconds of no interaction after which a paused
   * rotation resumes by itself, pointer movement (px, summed
   * since the last resume) below which a paused or running rotation ignores the mouse, and the views shown in turn.
   * A view is a query string relative to index.html (`chart=world-trend`, `country=CN`). */
  rotation: { minSeconds: number; resumeAfterSeconds: number; pauseMovePixels: number; views: string[] };
  /** Conference wallboard (`?view=wallboard`, wallboard.ts): seconds per slide, seconds without input before the controls
   * hide, fetch timeout, TV overscan padding (% of each side), text minimums at 1920x1080 (px), and the slides: `params`
   * = an embed query of one chart (`chart=world-map&metric=per_million`). */
  wallboard: {
    seconds: number; hideControlsSeconds: number; fetchTimeoutSeconds: number; safeAreaPercent: number;
    minTextPx: number; minTitlePx: number; minFinePrintPx: number;
    slides: { id: string; label: string; params: string }[];
  };
  /** World map colour scale: bins of powers of `logBase` (bin 1 = 1 to base-1), the last open-ended; `bins`
   * = their count, one theme colour each (`--map-bin-1`..). A reported 0 and no data have their own swatches.
   * `ratio` = the scale of the per-million and per-GDP metrics: bin 1 = above 0 and below `lowest` × `logBase`, each next
   * bin `logBase` times higher, the last open-ended (mapScale.ts `ratioBinOf`); absent = the default scale. */
  map: { logBase: number; bins: number; ratio?: { logBase: number; bins: number; lowest: number };
    /** Linear percent bins of the women-inventor share metrics (mapScale.ts `shareScale`). */
    share?: Partial<Record<GenderMeasure, { step: number; bins: number }>> };
};

export type SeriesId = "origin_apps" | "office_apps" | "pct_origin";
export type WorldId = "world_office" | "pct_world";
/** Data Center tab: "ips" = patent tab, "pmh" = PCT tab; keys `Manifest.releases`. */
export type Tab = "ips" | "pmh";

export type YearMap = Record<string, number | null>;

export type SourceBlock = {
  name: string;
  url: string;
  tab: Tab;
  query: string;
  entity: string | null;
  years: string;
};

export type EntityKind = "country" | "historical" | "regional_office";

export type EntityRef = {
  code: string;
  label: string;
  kind: EntityKind;
  iso3: string | null;
  /** UN M49 = ISO 3166-1 numeric, 3 digits (map geometry id); null for former states and regional offices. */
  iso_numeric: string | null;
};

export type Entities = EntityRef[];

export type Derived = {
  yoy: YearMap;
  /** Why a yoy year is null when it is not a gap: "series_break" (pipeline/breaks.py). Absent in data written before
   * v0.2b (= no reasons). */
  yoy_null_reason?: Record<string, "series_break">;
  cagr10: number | null;
  /** Ranked years only; null tolerated defensively (shown as '–'). */
  rank: Record<string, number | null>;
  share: YearMap;
  /** office_apps only; `{}` for other series. */
  resident_share: YearMap;
};

/** Type keys: origin_apps total/resident/abroad; office_apps total/resident/nonresident; pct_origin total. */
export type SeriesBlock = {
  types: { total: YearMap } & Partial<Record<"resident" | "abroad" | "nonresident", YearMap>>;
  derived: Derived;
};

/** Scale ratios (pipeline/scale.py RATIO_IDS): resident applications per million population and per $100bn GDP (PPP),
 * PCT applications per million population. */
export type RatioId = "per_million" | "per_gdp" | "pct_per_million";
/** WIPO's own ratio tables (`per_million`, `per_gdp`): source keys beside the series in `sources`. */
export type WipoRatioId = Exclude<RatioId, "pct_per_million">;
/** Why a ratio year is null (pipeline/scale.py keys; groups add GroupNullReason). */
export type RatioNullReason = "below_wipo_threshold" | "no_population" | "no_gdp" | "no_applications" | "below_precision"
  | GroupNullReason;

/** A country's ratio (pipeline/scale.py `country_ratio`): WIPO's value where published, else computed (`computed` = those
 * years); null years carry a reason. */
export type RatioBlock = { value: YearMap; computed: number[]; null_reason: Record<string, RatioNullReason> };
/** A group's ratio (pipeline/scale.py `group_ratio`): sum ÷ sum over members with both values, `reporting` of `members`. */
export type GroupRatio = { value: YearMap; reporting: Record<string, number>; members: number; null_reason: Record<string, RatioNullReason> };

/** Women-inventor measures (pipeline/gender.py): `women_any` = share of PCT applications with at least one woman inventor
 * (WIPO 1040), `women_share` = women's share of PCT inventors (1042); `women_any_by_field` = 1041 (world only). All by publication year. */
export type GenderMeasure = "women_any" | "women_share";
/** Why a gender year is null: a country year WIPO omits ("not_published"), a group year too thinly covered, or a measure
 * that cannot be computed for groups; plus the group reasons (pipeline/gender.py). */
export type GenderNullReason = "not_published" | "low_coverage" | "not_computable" | GroupNullReason;
export type GenderBlock = { value: YearMap; null_reason: Record<string, GenderNullReason> };
/** Source blocks the women-inventor data adds beside the series ones (`pct_publications` = the weights, entity files). */
export type GenderSourceId = GenderMeasure | "women_any_by_field" | "pct_publications";
/** overview.method.gender (pipeline/write.py): WIPO's method note and the constants the cards state. */
export type GenderMethod = {
  coverage_decimals: number;
  crosscheck_tolerance_pp: number;
  decimals: number;
  first_year: number;
  /** Least share of a group's PCT publications the members with a published share must hold. */
  group_coverage_min: number;
  method_note: { citation: string; page: string; url: string };
};
/** overview.gender: WIPO's World row per measure, technology fields in their last year (`value` null = no figure). */
export type GenderOverview = {
  world: Record<GenderMeasure, YearMap>;
  by_field: Record<string, { label: string; value: number | null }>;
  last_year: Record<GenderMeasure | "women_any_by_field", number>;
  /** Per group with either: its members outside m (codes) and WIPO's printed values by measure and year (group files hold the
   * same). Absent in data written before the group summary. */
  groups?: Record<string, {
    unlisted: string[];
    printed: Partial<Record<GenderMeasure, Record<string, number>>>;
    /** Figure and page of each printed value, by measure and year (same keys as `printed`). Absent in data written before it. */
    printed_refs?: Partial<Record<GenderMeasure, Record<string, { figure: string; page: string }>>>;
  }>;
  /** Publication WIPO's printed group figures come from (citation and link; `groups[g].printed_refs` holds figure and page). */
  printed_source?: { citation: string; url: string };
};

/** map/women_any.json and map/women_share.json (countries): shares by code; `women_any` also carries the PCT publications
 * (same figures as each country file's `pct_publications`) and their source. */
export type GenderMapFile = {
  values: Record<string, YearMap>;
  null_reason: Record<string, Record<string, GenderNullReason>>;
  pct_publications?: Record<string, YearMap>;
  sources: Partial<Record<GenderSourceId, SourceBlock>>;
};

export type EntityFile = {
  code: string;
  label: string;
  kind: EntityKind;
  /** Only series that list this entity. */
  series: Partial<Record<SeriesId, SeriesBlock>>;
  /** Absent in data written before v0.2b and for entities WDI has no row for. */
  ratios?: Partial<Record<RatioId, RatioBlock>>;
  /** Women-inventor shares (WIPO's, as published). Absent in data written before v0.2w and for entities that are no country. */
  gender?: Record<GenderMeasure, GenderBlock>;
  /** PCT publications by publication year (the gender weights; WIPO 1010, class Total); null = no figure. Countries only. */
  pct_publications?: YearMap;
  /** Series sources; WIPO ratio tables (`per_million`, `per_gdp`) beside them when `ratios` is present; the gender
   * measures and `pct_publications` beside them when those blocks are. */
  sources: Partial<Record<SeriesId | WipoRatioId | GenderSourceId, SourceBlock>>;
};

export type TopOrigin = { code: string; label: string; value: number; rank: number; share: number | null };
export type FastestGrower = { code: string; label: string; cagr10: number; value: number };

export type RankRaceEntry = { code: string; label: string; ranks: Record<string, number | null> };
export type SizeGrowthEntry = { code: string; label: string; continent: string; value: number; cagr10: number | null };
/** A year WIPO says a country's data are not comparable with the year before (pipeline/breaks.py `listing`): `note` =
 * our summary of WIPO's note (never quoted), `groups` = the code's M49 region and continent, `label` = its data label. */
export type SeriesBreak = {
  code: string; label: string; year: number; series: SeriesId[]; note: string; citation: string; url: string; page: string;
  groups: string[];
};

/** continent_share per series: values (not shares); `negative_years` = years the band is below 0. */
export type ContinentShare = {
  continent: Record<string, YearMap>;
  unallocated: YearMap;
  unallocated_label: string;
  negative_years: number[];
  null_reason: Record<string, GroupNullReason>;
};

export type Overview = {
  /** WIPO's own world totals (WD, ZZ), cut at `world_last_year`. */
  world_office: YearMap;
  pct_world: YearMap;
  /** Reporting entities per year, provisional years included. */
  coverage: Record<WorldId, Record<string, number>>;
  world_last_year: Record<WorldId, number>;
  top_year: number;
  coverage_rule: { min_ratio: number; lookback_years: number };
  top_origins: TopOrigin[];
  share_denominator: Record<SeriesId, string>;
  fastest_growers: FastestGrower[];
  top_n: number;
  grower_min: number;
  continent_share: Record<SeriesId, ContinentShare>;
  rank_race: { first_year: number; top: number; rows: RankRaceEntry[] };
  /** Largest first; null cagr10 = growth not computable. */
  size_growth: SizeGrowthEntry[];
  /** WIPO world PCT applications by month: "YYYY" -> 12 values (Jan..Dec), null = no figure. */
  pct_monthly: Record<string, (number | null)[]>;
  pct_monthly_source: SourceBlock;
  /** Constants the methods page states (pipeline/write.py method_constants). */
  method: {
    cagr_years: number;
    golden_tolerance_pct: number;
    /** member_sum group year below this share of the world total -> null (`attribution_floor`). */
    group_attribution_min: number;
    /** First year WIPO's by-origin data hold substantial "Abroad" filings (pipeline/groups.py ORIGIN_ABROAD_FROM). */
    origin_abroad_from: number;
    /** Basis per series and group kind; null = the kind is not offered for the series (office by region). */
    group_basis: Record<SeriesId, { continent: string | null; region: string | null }>;
    /** (WIPO total − member sum) ÷ WIPO total outside [low, high] = cross-check warning (pipeline GROUP_CROSSCHECK_RANGE). */
    group_crosscheck_range: [number, number];
    /** Codes WIPO counts in a continent's total that are no member (regional offices, former entities): series -> continent -> codes. */
    group_crosscheck_assignment: Partial<Record<SeriesId, Record<string, string[]>>>;
    /** Fixed-panel window length in years (pipeline PANEL_YEARS). */
    panel_years: number;
    rounding: { mode: string; decimals: { yoy: number; cagr: number; share: number; resident_share: number } };
    /** Scale constants (pipeline/scale.py `method_constants`); absent in data written before v0.2b. */
    ratios?: RatioMethod;
    /** Women-inventor constants and WIPO's method note; absent in data written before v0.2w. */
    gender?: GenderMethod;
  };
  last_year: Record<SeriesId, number>;
  /** Series sources (entity null); WIPO ratio tables with the World row (WD); the gender tables (World row; fields) beside them. */
  sources: Partial<Record<SeriesId | WipoRatioId | GenderSourceId, SourceBlock>>;
  /** Women inventors (WIPO's World row and technology fields); absent in data written before v0.2w. */
  gender?: GenderOverview;
  /** World ratios: WIPO's WD row as published (WIPO ratio ids), PCT per million = WIPO's PCT world total ÷ WDI world
   * population. A year can run past `ratio_last_year`: the cards show `ratio_last_year`'s. Absent before v0.2b. */
  world_ratios?: Partial<Record<RatioId, YearMap>>;
  /** Latest year with any country value per ratio (the tile year); a ratio without any is absent. */
  ratio_last_year?: Partial<Record<RatioId, number>>;
  /** Countries with no WDI value in any year of the WIPO ratio using that denominator (pipeline/write.py
   * `_ratio_no_denominator`; methods page). Absent in data written before the final v0.2b fixes. */
  ratio_no_denominator?: Partial<Record<RatioDenominator, string[]>>;
  /** Source of each world chart: WIPO total row as entity (WD, ZZ), years = the years charted. */
  world_sources: Record<WorldId, SourceBlock>;
  /** Absent in data written before v0.2b: no break notes, no methods section. */
  series_breaks?: SeriesBreak[];
  /** PCT Contracting States (pipeline/pct_states.py); absent in data written before v2a: no map layer, no methods section. */
  pct_membership?: PctMembership;
};

/** A State whose entry-into-force date WIPO prints as that of the State it continues (`continues`). */
export type PctContinuingState = { code: string; name: string; in_force: string; continues: string };

/** overview `pct_membership`: rows from WIPO's page (`source_url`), count and status date from WIPO's list
 * (`count_check_url`); `count` = members per year, `count[last_year]` = the list's count; `unmatched` = listed codes with
 * no WIPO entity. */
export type PctMembership = {
  status_on: string; retrieved: string; source_url: string; count_check_url: string;
  first_year: number; last_year: number; count: Record<string, number>;
  unmatched: string[]; continuing: PctContinuingState[];
};

/** A published list a card cites by its link only (WIPO's PCT Contracting States): no Data Center release, tab or query.
 * `status` = what the list states and when ("159 States on 2026-10-01"). */
export type ListSource = { kind: "list"; name: string; url: string; status: string; retrieved: string };
/** What a card cites: a WIPO statistics table or a published list. */
export type CardSource = SourceBlock | ListSource;

export function isListSource(source: CardSource): source is ListSource {
  return "kind" in source && source.kind === "list";
}

export type RatioDenominator = "population" | "gdp_ppp";

/** overview.method.ratios (pipeline/scale.py `method_constants`). */
export type RatioMethod = {
  ratio_ids: RatioId[];
  /** Ratios WIPO publishes (shown as published, labelled "WIPO"); the others are always computed. */
  wipo_ratio_ids: WipoRatioId[];
  scale: Record<RatioId, number>;
  denominator: Record<RatioId, RatioDenominator>;
  numerator: Record<RatioId, { series: SeriesId; type: keyof SeriesBlock["types"] }>;
  /** Denominator at or below = no value (WIPO's rule; PCT per million uses the population one). */
  wipo_threshold: Record<RatioDenominator, number>;
  decimals: number;
  abs_tolerance: number;
  rel_tolerance: number;
  fail_share_max: number;
  failing_list_max: number;
  country_factor_max: number;
  country_share_max: number;
  vintage_note_min: number;
  /** The blocking cross-check test per WIPO ratio (the other test warns only). */
  blocking_test: Partial<Record<WipoRatioId, "country_factor" | "cell_share">>;
  ratio_from: number;
  wdi_max_lag: number;
};

/** A WDI indicator behind a computed ratio (manifest `wdi_denominators`): `name` = WDI's own indicator name. */
export type WdiDenominator = { indicator: string; name: string; last_updated: string | null };

/** Per-country drift of our computation from WIPO's ratio: failing cells, largest |% diff|, median ours/WIPO factor
 * (null when every WIPO value is 0). */
export type RatioCountryDrift = { failing: number; max_pct: number | null; median_factor: number | null };

/** manifest checks.ratios.<id> (pipeline/run.py `ratio_summary`). */
export type RatioCheck = {
  compared: number;
  failing_count: number;
  /** First `failing_list_max` failing lines. */
  failing: string[];
  by_country: Record<string, RatioCountryDrift>;
  world: "pass" | "fail";
  world_failing: string[];
  /** Codes with WIPO values but no country entity (not shown, not compared). */
  unlisted: { code: string; years: string }[];
  vintage_factors: { code: string; median_factor: number }[];
  warnings: string[];
};

/** null throughout when no year has both values (crosscheck.sum_ratio_summary). */
export type SumRatio = { min: number | null; max: number | null; years: string | null };

/** Publication behind a golden figure (pipeline/golden.json via crosscheck.golden_sources). */
export type GoldenSource = { id: string; citation: string; url: string; page: string };

/** One entry of data/releases.json (newest first): a published data version (pipeline/releases.py). `changed` = series,
 * ratio or gender ids, or "all", "pct_monthly", "method", "entities", "groups", "wipo_release", "wdi", "pipeline" or a file stem. */
export type Release = {
  version: string;
  wipo_releases: Record<string, string>;
  wdi_last_updated: Record<string, string | null>;
  pipeline_sha: string;
  changed: string[];
};

export type Manifest = {
  /** Data version id (YYYY-MM-DD, then .2, .3): cited with every figure. Absent in a manifest written before v1. */
  version?: string;
  releases: Record<Tab, string>;
  /** UTC date, YYYY-MM-DD. */
  retrieved: string;
  pipeline_sha: string;
  last_year: Record<SeriesId, number>;
  /** Per series: entity and type pairs WIPO returned no row for. Per women table (absent before v0.2w): listed origins (fields)
   * with no value in any year (pipeline/write.py `_gender_absent_rows`), not entity-year pairs. */
  absent_rows: Record<SeriesId, number> & Partial<Record<GenderMeasure | "women_any_by_field", number>>;
  /** WDI indicators of the computed ratios; `gdp_base` = constant-price base year parsed from WDI's GDP name. Absent
   * before v0.2b. */
  wdi_denominators?: { population: WdiDenominator; gdp_ppp: WdiDenominator & { gdp_base: number } };
  /** WIPO's own label of each WIPO ratio table (cites its stale "(2017 PPP)"; the GDP label never uses it). */
  ratio_labels?: Partial<Record<WipoRatioId, string>>;
  /** WIPO's own label of each women-inventor table (pmh 1040, 1041, 1042). Absent before v0.2w. */
  gender_labels?: Record<GenderMeasure | "women_any_by_field", string>;
  checks: {
    /** "warn": mismatches excused because WDI predates the WIPO release (wdi_warning_reason); "fail" blocks
     * publication, so a published manifest never carries it. */
    wdi: "pass" | "warn" | "fail";
    wdi_scope: string;
    /** World Bank's own last update, YYYY-MM-DD; null when its response gave none. */
    wdi_last_updated: string | null;
    wdi_warnings: string[];
    wdi_warning_reason: string | null;
    golden: string[];
    golden_sources: GoldenSource[];
    world: string[];
    world_sum_ratio: Record<WorldId, SumRatio>;
    oecd: string[];
    /** PCT monthly vs yearly warnings (pipeline/crosscheck.py monthly_check); absent in a manifest written before v0.2a. */
    pct_monthly?: string[];
    /** Group cross-check, negative unallocated and PCT unknown-band warnings (pipeline/groups.py check_warnings). */
    groups?: string[];
    /** Weighted mean of countries' women_any vs WIPO's World row (pipeline/run.py): years compared, the largest gap in pp
     * (null when none compared), the years over `method.gender.crosscheck_tolerance_pp`. Absent before v0.2w. */
    gender?: { compared: number; max_gap_pp: number | null; gap_years: number[]; warnings: string[] };
    /** Ratio cross-check per WIPO ratio; absent in a manifest written before v0.2b. */
    ratios?: Partial<Record<WipoRatioId, RatioCheck>>;
    /** Refresh against the committed data (pipeline/regress.py): `revisions` = first lines of `revision_count`; `accepted` =
     * blocking lines a local run accepted. Absent in a manifest written before v0.2b. */
    regression?: { warn_pct: number; revision_count: number; revisions: string[]; accepted: string[] };
  };
};

/** Loaded files by path, shared by every caller: each file fetched once per page session (wallboard: once per board
 * session, spec §Rendering). A failed load is dropped, so the next call fetches again (the board retries next cycle). */
const loaded = new Map<string, Promise<unknown>>();
/** Abort a fetch after this long; undefined = wait as the browser does (every page but the wallboard). */
let fetchTimeoutMs: number | undefined;

/** Sets the fetch timeout of every later load (wallboard: `wallboard.fetchTimeoutSeconds`). */
export function setFetchTimeout(seconds: number | undefined): void {
  fetchTimeoutMs = seconds === undefined ? undefined : seconds * 1000;
}

async function fetchJson(path: string, cache?: RequestCache): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = fetchTimeoutMs;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { signal: controller.signal, cache });
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Could not load ${path} (no answer within ${(timeoutMs ?? 0) / 1000} s)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A fresh copy per call (as a fetch per call gave): a caller that changes its copy never changes another's. */
export async function loadJson<T>(path: string): Promise<T> {
  let load = loaded.get(path);
  if (!load) {
    load = fetchJson(path);
    loaded.set(path, load);
    load.catch(() => { if (loaded.get(path) === load) loaded.delete(path); });
  }
  return structuredClone(await load) as T;
}

/** The file as the server has it now: past this page's cache and the browser's (wallboard: a deploy since it started). */
export async function loadFresh<T>(path: string): Promise<T> {
  return (await fetchJson(path, "no-store")) as T;
}
