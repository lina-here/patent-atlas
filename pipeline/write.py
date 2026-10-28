"""Derived site data (site/data/*.json) from collected series: layout, write, change test.

Files (paths relative to the data root; JSON year keys are strings):
- entities.json: [{code, label, kind, iso3}], every non-aggregate code (aggregates: overview only).
- overview.json: world series, coverage, world_last_year, top_origins, fastest_growers, constants; `method` =
  constants the methods page states (CAGR years, golden tolerance, rounding), read from their sources here;
  `sources` per series (whole year range), `world_sources` per published world (WIPO row, years charted).
- entity/<code>.json: per-series types + derived figures, only series listing the code; yoy of a series-break year
  null, `yoy_null_reason` {year: "series_break"} (breaks.py).
- groups.json: {items: [{id, kind, label, continent, members}], successors, sources}: continents + M49 regions
  (groups.py); successors = former entity -> [{code, from_year, to_year}] (successors.json; map hatching).
- group/<id>.json: per-series group figures (basis, total, reporting, members, null_reason, source; member_sum
  on wipo_total basis, fixed panel on member_sum basis; regions: no office_apps) + former_notes.
- map/<series>.json: {values: {code: year map}, sources}: countries and former states, cut at world last_year.
- overview.json `continent_share`: per series continent totals + unallocated band (groups.continent_share).
- overview.json `series_breaks`: breaks.listing() + each code's `label` (footnotes on world and group charts).
- overview.json key figures (spec 2a tiles): `world_yoy` {world_office|pct_world: {yoy, yoy_null_reason}} =
  derive.yoy_growth of the published world series (cut at its world_last_year), a year in
  breaks.world_break_years of its series null with reason "series_break"; golden growth figures check it
  (crosscheck.GOLDEN_GROWTH_SERIES). `top_grower` {code, label, rank, value, cagr10, breaks} | null = highest
  cagr10 to top_year among top_origins (tie: better rank, then code; null cagr skipped), `breaks` = its origin
  series' break years after the CAGR base year up to top_year (tile footnote).
- overview.json `treemap` (spec 2a treemap, written here): origin_apps at top_year by continent, shares of WD;
  `_treemap`. Not drawable (continent_share null reason: attribution floor, WD null or provisional, none_reported)
  -> reason, empty rows; a negative rest, or unattributed origins above it, blocks (run.py).
- overview.json `share_shift` (spec 2a share-shift bar): top_origins rows, shares of WD at base_year (top_year -
  CAGR_YEARS) and top_year, change_pp = difference of the published shares (`method.share_shift`), breaks in
  (base_year, top_year]; WD null or provisional at either year -> no_wipo_world_total, no rows; `_share_shift`.
- overview.json views: `rank_race` {first_year, top, rows: [{code, label, ranks}]} (countries ever in the top
  RANK_RACE_TOP, RANK_RACE_FROM..top_year; ranks below the top kept, null = no value); `size_growth`
  [{code, label, continent, value, cagr10}] (countries >= GROWER_MIN at top_year, null cagr kept);
  `pct_monthly` {"YYYY": 12 months} WIPO world (origin Total, RO Total) + `pct_monthly_source`.
- PCT membership (pct_states.py, hand-transcribed `pct_states.json`): map/pct_member.json {values: {code: {year:
  bool}} (country entities; not listed = false), null_reason {code: "not_on_current_list"} (former entities, never
  false), in_force {code: date} (every listed State), unmatched [listed codes with no entity], sources {pct_member}};
  overview `pct_membership` {status_on, retrieved, source_url, count_check_url, first_year, last_year (status_on year),
  count {year: members on the list}, unmatched, continuing [{code, name, in_force, continues}]}.
- manifest.json: releases, retrieval date, pipeline sha, last years, absent rows, `wdi_denominators` (WDI indicator,
  name, last updated, GDP base), `ratio_labels` (WIPO API label per ratio); run.py adds checks and, when the data
  changed, `version` (newest releases.json entry, releases.py). releases.json: run.py, never in `changed`/`_existing`.
- Scale ratios (scale.py; `collected["ratios"]` WIPO tables, `collected["denominators"]` WDI, set by run.py): country
  entity `ratios` {id: {value, computed, null_reason}}, group `ratios` {id: {value, reporting, members, null_reason}},
  map/<MAP_RATIOS>.json {values, computed, null_reason, sources} (countries), overview `world_ratios` (WIPO WD row;
  PCT = ZZ / WDI world), `ratio_last_year`, `ratio_no_denominator` (countries without any WDI value per
  denominator), `method.ratios`. Years RATIO_FROM..numerator series' cut (top_year;
  PCT per million: pct_origin first year..pct_world last_year, final review M3). Sources: WIPO ratio table (ips 101 / 100); PCT per million = pct_origin.

- Women inventors (gender.py; `collected["gender"]` WIPO shares, `collected["pct_publications"]` weights, both by
  publication year; `gender_published.json` WIPO's printed continent figures): entity `gender` {women_any, women_share:
  {value, null_reason}} for every country and each former entity WIPO lists (WIPO's share as published); group `gender`
  (group shape: + reporting, members, coverage, wipo_years); map/women_any.json, map/women_share.json {values,
  null_reason, sources} (countries; women_any + pct_publications); overview `gender` {world (WIPO's ZZ row), by_field (last year), last_year},
  `method.gender`; manifest `gender_labels`. Years GENDER_FROM..each measure's last_year. Source blocks add
  `description` (says "by publication year"); group women_any adds `weights`, continents `printed` (WIPO years).

World figures, share denominators, provisional years: worlds.py. Published worlds = WIPO rows WD, ZZ only;
world_origin (our origin sum) sets `top_year` (year of top_origins / fastest_growers), never published.
Derived "not applicable" = empty map: rank for non-countries, resident_share outside office_apps.
"""
from __future__ import annotations

import datetime
import json
import os
from decimal import Decimal
from pathlib import Path

from pipeline import breaks, crosscheck, derive, gender, groups, m49, pct_states, scale, wdi
from pipeline.collect import GenderData, RatioData, SeriesData
from pipeline.entities import classify, iso3
from pipeline.series import (
    GENDER_FIELD_IDS,
    GENDER_FROM,
    GENDER_SERIES,
    GENDER_WORLD_CODE,
    PCT_BY_FILING_DATE,
    PCT_PUBLICATIONS_CLASS_LABEL,
    PCT_PUBLICATIONS_INDICATOR,
    PCT_PUBLICATIONS_LABEL_WORDS,
    RATIO_FROM,
    RATIO_WORLD_CODE,
    SERIES,
    TOTAL_ROW_CODES,
    GenderDef,
)
from pipeline.worlds import (
    COVERAGE_MIN_RATIO, SHARE_DENOMINATOR, WORLD_OF_SERIES, WORLD_SOURCES, World, in_world_origin)
from pipeline.worlds import totals as _totals

TOP_N = 20
GROWER_MIN = 1000  # fastest growers: countries with >= this many origin applications in the year shown
RANK_RACE_TOP = 10  # spec Views: rank race = top 10 origins since 1995
RANK_RACE_FROM = 1995
# treemap: origin with value x 100 < this x WD folds into its continent's "other" (exact, before rounding);
# published as method.treemap (the pipeline writes the treemap figures: spec 2a amendments)
TREEMAP_FOLD_SHARE_PCT = 0.5
SHARE_SHIFT_CHANGE = "difference of published shares"  # method.share_shift: how change_pp is computed
PCT_MONTHLY_QUERY = (f"PCT tab; indicator {PCT_BY_FILING_DATE}; report: monthly statistics; receiving office: "
                     f"Total; origin: Total")
SOURCE_NAME = "WIPO Statistics Database"
SOURCE_URL = "https://www3.wipo.int/ipstats/"

ENTITIES = Path("entities.json")
OVERVIEW = Path("overview.json")
MANIFEST = Path("manifest.json")
ENTITY_DIR = Path("entity")
GROUPS = Path("groups.json")
GROUP_DIR = Path("group")
MAP_DIR = Path("map")
DATA_DIRS = (ENTITY_DIR, GROUP_DIR, MAP_DIR)  # one file per entity / group / series; stale files deleted

PUBLISHED_WORLDS = ("world_office", "pct_world")
MAP_RATIOS = ("per_million", "per_gdp")  # map metrics (spec map list); PCT per million on cards only
SHARE_DENOMINATOR_LABEL = {"world_office": "WIPO world total (WD)", "pct_world": "WIPO PCT total (ZZ)"}
GENDER_IDS = tuple(item.id for item in GENDER_SERIES)  # women_any, women_share, women_any_by_field
GROUP_COMPUTED_LABEL = "computed from WIPO shares weighted by PCT publications"  # plan v0.2w: exact wording
GROUP_NOT_COMPUTABLE_LABEL = "not computable for groups (WIPO publishes no inventor counts)"
PRINTED_LABEL = "WIPO's printed figure (PCT Yearly Review) in"
PCT_PUBLICATIONS_QUERY = (f"PCT tab; indicator {PCT_PUBLICATIONS_INDICATOR} - {PCT_PUBLICATIONS_LABEL_WORDS[0]}, "
                          f"class {PCT_PUBLICATIONS_CLASS_LABEL}, by origin; report: yearly statistics, by publication "
                          "year")


def is_ranked(code: str) -> bool:
    return classify(code) == "country"


def _years(series: dict[int, object], until: int | None = None) -> dict[str, object]:
    return {str(year): value for year, value in sorted(series.items()) if until is None or year <= until}


def _source(series: SeriesData, entity: str | None) -> dict:
    return {"name": SOURCE_NAME, "url": SOURCE_URL, "tab": series.series.tab, "query": series.series.query_words,
            "entity": entity, "years": f"{series.first_year}-{series.last_year}"}


def _world_source(key: str, data: dict[str, SeriesData], world: World) -> dict:
    """Source of a published world series: its WIPO total row (WD / ZZ) and the years its chart shows, first
    year with a WIPO value to world_last_year (overview.ts worldTrend title)."""
    series_id, total_code = WORLD_SOURCES[key]
    shown = [year for year, value in sorted(world.published.items()) if value is not None and year <= world.last_year]
    first = shown[0] if shown else world.last_year
    return {**_source(data[series_id], total_code), "years": f"{first}-{world.last_year}"}


def _ranks_by_year(series: SeriesData, until: int) -> dict[int, dict[str, int]]:
    totals = _totals(series)
    return {year: derive.ranks(totals, year, is_ranked) for year in range(series.first_year, until + 1)}


def _derived(series: SeriesData, code: str, world: World, denominator: dict[int, int | None],
             ranks: dict[int, dict[str, int]]) -> dict:
    """`denominator` = groups.world_total: None after its own world's last_year, as for group shares. yoy of a
    series-break year (breaks.py) = null, reason in `yoy_null_reason`."""
    types = series.values[code]
    total = types["total"]
    shown = [year for year in sorted(total) if year <= world.last_year]
    resident_share = {}
    if series.series.id == "office_apps":
        resident_share = {year: derive.resident_share(types["resident"][year], total[year]) for year in sorted(total)}
    yoy = derive.yoy_growth(total)
    broken = sorted(year for year in breaks.break_years(code, series.series.id) if year in yoy)
    yoy.update({year: None for year in broken})
    return {
        "yoy": _years(yoy),
        "yoy_null_reason": {str(year): breaks.SERIES_BREAK for year in broken},
        "cagr10": derive.cagr(total, series.last_year),
        "rank": {str(year): ranks[year][code] for year in shown if code in ranks.get(year, {})},
        "share": {str(year): derive.share(total[year], denominator.get(year)) for year in shown},
        "resident_share": _years(resident_share),
    }


def _labels(data: dict[str, SeriesData]) -> dict[str, str]:
    labels: dict[str, str] = {}
    for series in SERIES:  # first series listing a code names it
        for code, label in data[series.id].labels.items():
            labels.setdefault(code, label)
    return labels


def _top_origins(origin: SeriesData, world: World, denominator: dict[int, int | None],
                 labels: dict[str, str]) -> list[dict]:
    """`denominator` = groups.world_total (None after its own world's last_year)."""
    year = world.last_year
    totals = _totals(origin)
    ranks = derive.ranks(totals, year, is_ranked)
    top = sorted((rank, code) for code, rank in ranks.items() if rank <= TOP_N)
    return [{"code": code, "label": labels[code], "value": totals[code][year], "rank": rank,
             "share": derive.share(totals[code][year], denominator.get(year))} for rank, code in top]


def _sized(origin: SeriesData, world: World) -> list[tuple[str, int, float | None]]:
    """(code, value, cagr10) of countries with >= GROWER_MIN origin applications in world.last_year."""
    year = world.last_year
    sized = []
    for code, total in _totals(origin).items():
        value = total.get(year)
        if is_ranked(code) and value is not None and value >= GROWER_MIN:
            sized.append((code, value, derive.cagr(total, year)))
    return sized


def _fastest_growers(origin: SeriesData, world: World, labels: dict[str, str]) -> list[dict]:
    growers = sorted((-rate, code, rate, value) for code, value, rate in _sized(origin, world) if rate is not None)
    return [{"code": code, "label": labels[code], "cagr10": rate, "value": value}
            for _, code, rate, value in growers[:TOP_N]]


def _top_grower(origin: SeriesData, world: World, top_origins: list[dict]) -> dict | None:
    """Fastest grower among the top_origins rows (spec 2a amendments: no small-base outliers): highest cagr10 to
    world.last_year (top_year), null skipped; tie -> better rank, then code. `breaks` = break years of its origin
    series inside the CAGR window: after the base year (a break there leaves both ends on one method), up to the
    end year."""
    end = world.last_year
    totals = _totals(origin)
    rates = [(derive.cagr(totals[row["code"]], end), row) for row in top_origins]
    rated = [(rate, row) for rate, row in rates if rate is not None]
    if not rated:
        return None
    rate, row = min(rated, key=lambda item: (-item[0], item[1]["rank"], item[1]["code"]))
    window = range(end - derive.CAGR_YEARS + 1, end + 1)
    return {"code": row["code"], "label": row["label"], "rank": row["rank"], "value": row["value"], "cagr10": rate,
            "breaks": sorted(year for year in breaks.break_years(row["code"], origin.series.id) if year in window)}


def _world_yoy(worlds: dict[str, World]) -> dict[str, dict]:
    """Year-on-year change of each published world series as published (WD / ZZ, cut at its world_last_year);
    a year in breaks.world_break_years of its series = null, reason in `yoy_null_reason`."""
    result = {}
    for key in PUBLISHED_WORLDS:
        world = worlds[key]
        yoy = derive.yoy_growth({year: value for year, value in world.published.items() if year <= world.last_year})
        broken = sorted(year for year in breaks.world_break_years(WORLD_SOURCES[key][0]) if year in yoy)
        yoy.update({year: None for year in broken})
        result[key] = {"yoy": _years(yoy), "yoy_null_reason": {str(year): breaks.SERIES_BREAK for year in broken}}
    return result


def _treemap(origin: SeriesData, ctx: groups.Context, labels: dict[str, str]) -> dict:
    """{series, year, world, null_reason, continents, residual, unattributed, no_value} at top_year (the series' cut);
    world = WD (groups.world_total: null when null or provisional), shares = derive.share of it.
    null_reason = continent_share's for the year (attribution floor, WD null or provisional, a continent with no
    member reporting: none_reported) -> every row list empty, residual null.
    continents (CONTINENTS order): member-sum value = its M49 members with a value; a member under
    TREEMAP_FOLD_SHARE_PCT of WD folds into `other` {value, share, codes} (null when none). residual = the
    not-attributable rest (groups.unallocated); unattributed = origins with a value and no continent (inside the rest);
    no_value = M49 members WIPO lists with null that year (listed, never 0)."""
    series_id = origin.series.id
    year = groups.cut_year(series_id, ctx.worlds)
    world = groups.world_total(series_id, ctx.worlds).get(year)
    totals = groups.continent_share(series_id, ctx)
    result: dict = {"series": series_id, "year": year, "world": world, "null_reason": totals["null_reason"].get(year),
                    "continents": [], "residual": None, "unattributed": [], "no_value": []}
    if result["null_reason"] is not None:
        return result
    values = {code: types["total"].get(year) for code, types in origin.values.items()}

    def row(code: str) -> dict:
        return {"code": code, "label": labels[code], "value": values[code], "share": derive.share(values[code], world)}

    line = Decimal(str(TREEMAP_FOLD_SHARE_PCT)) * world
    for continent in m49.CONTINENTS:
        reported = sorted((code for code in groups.listed_members(ctx.data, series_id, continent)
                           if values[code] is not None), key=lambda code: (-values[code], code))
        folded = sorted(code for code in reported if Decimal(values[code]) * 100 < line)
        value = totals["continent"][continent][year]
        member_sum = sum(values[code] for code in reported)
        if member_sum != value:  # holds on member_sum basis only
            raise ValueError(f"treemap {continent} {year}: members sum {member_sum} != continent total {value}")
        other = sum(values[code] for code in folded)
        result["continents"].append({
            "id": continent, "label": groups.group_label(continent), "value": value,
            "share": derive.share(value, world),
            "countries": [row(code) for code in reported if code not in folded],
            "other": {"value": other, "share": derive.share(other, world), "codes": folded} if folded else None})
    rest = totals["unallocated"][year]
    result["residual"] = {"value": rest, "share": derive.share(rest, world),
                          "label": groups.unallocated_label(series_id, ctx)}
    unattributed = [code for code, value in values.items()
                    if value is not None and in_world_origin(code) and m49.continent_of(code) is None]
    result["unattributed"] = [row(code) for code in sorted(unattributed, key=lambda code: (-values[code], code))]
    result["no_value"] = [{"code": code, "label": labels[code]} for code in sorted(values)
                          if values[code] is None and m49.continent_of(code) is not None]
    return result


def _share_shift(origin: SeriesData, world: World, denominator: dict[int, int | None],
                 top_origins: list[dict]) -> dict:
    """{series, base_year, year, null_reason, rows} for the top_origins rows (rank order). year = world.last_year
    (top_year), base_year = year - derive.CAGR_YEARS (cagr10 window). `denominator` = groups.world_total (WD), so
    shares = entity derived.share. change_pp = published share - published share_base, exact in Decimal: the figures
    table adds up, within 0.01 pp of the unrounded difference; null with share_base (origin missing in the base
    year: listed, not plotted). breaks = break years of the code's origin series in (base_year, year]: the two
    shares sit on different methods. WD null or provisional at either year -> no_wipo_world_total, rows []."""
    series_id = origin.series.id
    year = world.last_year
    base_year = year - derive.CAGR_YEARS
    result: dict = {"series": series_id, "base_year": base_year, "year": year, "null_reason": None, "rows": []}
    if denominator.get(year) is None or denominator.get(base_year) is None:
        result["null_reason"] = groups.NO_WIPO_WORLD_TOTAL
        return result
    totals = _totals(origin)
    window = range(base_year + 1, year + 1)
    for top in top_origins:
        code = top["code"]
        share = derive.share(totals[code].get(year), denominator[year])
        share_base = derive.share(totals[code].get(base_year), denominator[base_year])
        change = None
        if share is not None and share_base is not None:
            change = float(Decimal(repr(share)) - Decimal(repr(share_base)))
        broken = sorted(item for item in breaks.break_years(code, series_id) if item in window)
        result["rows"].append({"code": code, "label": top["label"], "rank": top["rank"], "share_base": share_base,
                               "share": share, "change_pp": change, "breaks": broken})
    return result


def _size_growth(origin: SeriesData, world: World, labels: dict[str, str]) -> list[dict]:
    """Every country of `_sized`, largest first; null cagr10 listed (the chart lists it under the plot)."""
    return [{"code": code, "label": labels[code], "continent": m49.continent_of(code), "value": value,
             "cagr10": rate} for code, value, rate in sorted(_sized(origin, world), key=lambda row: (-row[1], row[0]))]


def _rank_race(origin: SeriesData, world: World, ranks: dict[int, dict[str, int]], labels: dict[str, str]) -> dict:
    """Countries ever ranked <= RANK_RACE_TOP in first..top year, ordered by rank at the top year (unranked last)."""
    first, last = max(RANK_RACE_FROM, origin.first_year), world.last_year
    years = range(first, last + 1)
    codes = {code for year in years for code, rank in ranks[year].items() if rank <= RANK_RACE_TOP}
    order = sorted(codes, key=lambda code: (ranks[last].get(code, float("inf")), code))
    return {"first_year": first, "top": RANK_RACE_TOP,
            "rows": [{"code": code, "label": labels[code],
                      "ranks": {str(year): ranks[year].get(code) for year in years}} for code in order]}


def _pct_monthly(pct: SeriesData, months: dict[int, list[int | None]]) -> dict[str, list[int | None]]:
    """Collected PCT world months, checked: every pct_origin year, 12 months each."""
    expected = list(range(pct.first_year, pct.last_year + 1))
    if sorted(months) != expected or any(len(values) != 12 for values in months.values()):
        raise ValueError(f"pct_monthly: years {sorted(months)} / month counts do not match pct_origin "
                         f"{pct.first_year}-{pct.last_year} x 12")
    return {str(year): list(months[year]) for year in expected}


def method_constants() -> dict:
    """Constants behind the figures, published so the methods page never types a number."""
    return {
        "cagr_years": derive.CAGR_YEARS,
        "golden_tolerance_pct": crosscheck.GOLDEN_TOLERANCE_PCT,
        "golden_growth_tolerance_pp": crosscheck.GOLDEN_GROWTH_TOLERANCE_PP,
        "rounding": {
            "mode": derive.ROUNDING_MODE,
            "decimals": {"yoy": derive.YOY_DECIMALS, "cagr": derive.CAGR_DECIMALS,
                         "share": derive.SHARE_DECIMALS, "resident_share": derive.SHARE_DECIMALS},
        },
        "group_basis": groups.basis_table(),
        "group_attribution_min": groups.GROUP_ATTRIBUTION_MIN,
        "group_crosscheck_range": list(groups.GROUP_CROSSCHECK_RANGE),
        "group_crosscheck_assignment": {series_id: {continent: list(codes) for continent, codes in extra.items()}
                                        for series_id, extra in groups.CROSSCHECK_EXTRA.items()},
        "panel_years": groups.PANEL_YEARS,
        "origin_abroad_from": groups.ORIGIN_ABROAD_FROM,
        "ratios": scale.method_constants(),
        "gender": gender.method_constants(),
        "treemap": {"fold_share_pct": TREEMAP_FOLD_SHARE_PCT},
        "share_shift": {"change": SHARE_SHIFT_CHANGE, "decimals": derive.SHARE_DECIMALS},
    }


def _ratio_source(ratio: RatioData, entity: str | None) -> dict:
    return {"name": SOURCE_NAME, "url": SOURCE_URL, "tab": "ips", "query": ratio.ratio.query_words,
            "entity": entity, "years": f"{ratio.first_year}-{ratio.last_year}"}


def ratio_years(ratio_id: str, data: dict[str, SeriesData], worlds: dict[str, World]) -> range:
    """First year..cut year of the ratio's numerator series (origin_apps: top_year; pct_origin: pct_world). First:
    RATIO_FROM for WIPO's ratios (its tables start there, whatever our counts); a computed-only ratio (PCT per million)
    starts no earlier than its numerator series: no cells before PCT data (final review M3)."""
    series_id = scale.RATIO_NUMERATOR[ratio_id][0]
    first = RATIO_FROM if ratio_id in scale.WIPO_RATIO_IDS else max(RATIO_FROM, data[series_id].first_year)
    return range(first, groups.cut_year(series_id, worlds) + 1)


def ratio_numerators(data: dict[str, SeriesData], ratio_id: str) -> dict[str, dict[int, int | None]]:
    """code -> numerator year series of the ratio (scale.RATIO_NUMERATOR: series id, type key)."""
    series_id, type_key = scale.RATIO_NUMERATOR[ratio_id]
    return {code: types[type_key] for code, types in data[series_id].values.items() if type_key in types}


def _entity_codes(data: dict[str, SeriesData]) -> list[str]:
    """Codes with an entity file: every non-aggregate code of the count series (unknown code -> ValueError, G12)."""
    return sorted({code for series in data.values() for code in series.values if classify(code) != "aggregate"})


def _classify_ratio_codes(ratios: dict[str, RatioData]) -> None:
    """Every WIPO ratio-table code classified like the count codes: unknown -> ValueError (audit G12; ruling I2)."""
    for ratio_id in scale.WIPO_RATIO_IDS:
        for code in ratios[ratio_id].values:
            classify(code)


def unlisted_ratio_codes(collected: dict, worlds: dict[str, World]) -> dict[str, list[dict]]:
    """Per WIPO ratio: codes other than RATIO_WORLD_CODE with a WIPO value in the ratio's years but no country entity
    (not shown, not compared): [{code, years: "first-last"}]. Warning + manifest checks.ratios.<id>.unlisted, never
    blocking (ruling I2: nothing wrong is shown, only something not shown)."""
    countries = {code for code in _entity_codes(collected["series"]) if classify(code) == "country"}
    result = {}
    for ratio_id in scale.WIPO_RATIO_IDS:
        years = ratio_years(ratio_id, collected["series"], worlds)
        unlisted = []
        for code, values in sorted(collected["ratios"][ratio_id].values.items()):
            if code == RATIO_WORLD_CODE or code in countries:
                continue
            present = [year for year in years if values.get(year) is not None]
            if present:
                unlisted.append({"code": code, "years": f"{present[0]}-{present[-1]}"})
        result[ratio_id] = unlisted
    return result


def _ratio_block(result: dict) -> dict:
    block = {key: _years(result[key]) for key in ("value", "null_reason")}
    if "computed" in result:
        block["computed"] = list(result["computed"])
    else:
        block.update(reporting=_years(result["reporting"]), members=result["members"])
    return block


def _country_ratios(codes: list[str], collected: dict, worlds: dict[str, World]) -> dict[str, dict]:
    """code -> {ratio id: {value, computed, null_reason}} for every country code (WIPO first; scale.country_ratio)."""
    data, ratios, denominators = collected["series"], collected["ratios"], collected["denominators"]
    result: dict[str, dict] = {code: {} for code in codes}
    for ratio_id in scale.RATIO_IDS:
        numerators = ratio_numerators(data, ratio_id)
        rows = denominators[scale.RATIO_DENOMINATOR[ratio_id]].values
        wipo = ratios[ratio_id].values if ratio_id in scale.WIPO_RATIO_IDS else {}
        years = ratio_years(ratio_id, data, worlds)
        for code in codes:
            result[code][ratio_id] = _ratio_block(scale.country_ratio(
                wipo.get(code), numerators.get(code, {}), rows.get(code), ratio_id, years))
    return result


def _group_ratios(group_id: str, ctx: groups.Context, collected: dict) -> dict:
    """{ratio id: {value, reporting, members, null_reason}}: member sums, members and floor of the numerator series
    (scale.group_ratio), continents and regions alike."""
    blocks = {}
    for ratio_id in scale.RATIO_IDS:
        series_id = scale.RATIO_NUMERATOR[ratio_id][0]
        blocks[ratio_id] = _ratio_block(scale.group_ratio(
            ratio_numerators(ctx.data, ratio_id), collected["denominators"][scale.RATIO_DENOMINATOR[ratio_id]].values,
            groups.listed_members(ctx.data, series_id, group_id), ratio_id, ratio_years(ratio_id, ctx.data, ctx.worlds),
            ctx.floor(series_id)))
    return blocks


def _world_ratios(collected: dict, worlds: dict[str, World]) -> dict[str, dict[str, float | None]]:
    """WIPO's WD row as published (per million, per GDP); PCT per million = ZZ / WDI world population."""
    result = {}
    for ratio_id in scale.WIPO_RATIO_IDS:
        published = collected["ratios"][ratio_id].values[RATIO_WORLD_CODE]
        result[ratio_id] = _years(scale.world_ratio({year: published.get(year)
                                                     for year in ratio_years(ratio_id, collected["series"], worlds)}))
    zz = collected["series"]["pct_origin"].values[TOTAL_ROW_CODES["pct_origin"]]["total"]
    result["pct_per_million"] = _years(scale.world_pct_per_million(
        {year: zz.get(year) for year in ratio_years("pct_per_million", collected["series"], worlds)},
        collected["denominators"]["population"].world))
    return result


def _ratio_last_year(country_ratios: dict[str, dict]) -> dict[str, int]:
    """Latest year (<= the ratio's cut) with any non-null country value; ratio absent when none."""
    last = {}
    for ratio_id in scale.RATIO_IDS:
        years = [int(year) for blocks in country_ratios.values()
                 for year, value in blocks[ratio_id]["value"].items() if value is not None]
        if years:
            last[ratio_id] = max(years)
    return last


def _ratio_no_denominator(codes: list[str], collected: dict, worlds: dict[str, World]) -> dict[str, list[str]]:
    """Denominator -> country codes with no WDI value in any year of its WIPO ratio (per million: population; per
    GDP: GDP PPP): the methods page names them (final review I2; never typed examples)."""
    data, denominators = collected["series"], collected["denominators"]
    result = {}
    for ratio_id in scale.WIPO_RATIO_IDS:
        kind = scale.RATIO_DENOMINATOR[ratio_id]
        rows, years = denominators[kind].values, ratio_years(ratio_id, data, worlds)
        result[kind] = [code for code in codes if all((rows.get(code) or {}).get(year) is None for year in years)]
    return result


def _ratio_map_file(ratio_id: str, country_ratios: dict[str, dict], ratio: RatioData) -> dict:
    return {"values": {code: blocks[ratio_id]["value"] for code, blocks in country_ratios.items()},
            "computed": {code: blocks[ratio_id]["computed"] for code, blocks in country_ratios.items()},
            "null_reason": {code: blocks[ratio_id]["null_reason"] for code, blocks in country_ratios.items()},
            "sources": {ratio_id: _ratio_source(ratio, None)}}


def _wdi_denominators(denominators: dict[str, wdi.Denominator]) -> dict:
    """Manifest: WDI indicator, name, last updated per denominator; GDP base parsed from WDI's name (CheckError
    when it names none: the GDP label never guesses)."""
    result = {}
    for key, denominator in denominators.items():
        result[key] = {"indicator": denominator.indicator, "name": denominator.name,
                       "last_updated": denominator.last_updated.isoformat() if denominator.last_updated else None}
        if key == "gdp_ppp":
            result[key]["gdp_base"] = wdi.gdp_base_year(denominator.name)
    return result


# Women inventors (gender.py)

def gender_years(collected: dict, gender_id: str) -> range:
    """GENDER_FROM..the measure's own last year (last year with a World value)."""
    return range(GENDER_FROM, collected["gender"][gender_id].last_year + 1)


def gender_members(collected: dict, group_id: str) -> list[str]:
    """M49 members of the group with a PCT publications row (the weights): coverage denominator and m of "n of m".
    Never the gender table's list: a member it lacks has no share, so counts uncovered (review I1)."""
    return [code for code in m49.members(group_id) if code in collected["pct_publications"]]


def group_women_any_computed(collected: dict, group_id: str) -> dict:
    """Publication-weighted women_any of the group (before WIPO's printed continent figures). No floor: the
    attribution floor of pct_origin is a filing-year rule of another series; the coverage floor is gender's own."""
    shares = {measure: collected["gender"][measure].values for measure in gender.MEASURES}
    return gender.group_women_any(gender_members(collected, group_id), shares,
                                  collected["pct_publications"], gender_years(collected, gender.WOMEN_ANY), {})


def _gender_def(gender_id: str) -> GenderDef:
    return next(item for item in GENDER_SERIES if item.id == gender_id)


def _gender_source(collected: dict, gender_id: str, entity: str | None, description: str | None = None) -> dict:
    """Source block of a gender table; `description` defaults to the measure's label (says "by publication year").
    Years = what is written: by field only its last year (overview by_field, review M1)."""
    definition = _gender_def(gender_id)
    last = collected["gender"][gender_id].last_year
    first = last if definition.by == "field" else GENDER_FROM
    return {"name": SOURCE_NAME, "url": SOURCE_URL, "tab": "pmh", "query": definition.query_words, "entity": entity,
            "years": f"{first}-{last}",
            "description": description or definition.label}


def _gender_block(result: dict) -> dict:
    """gender.py shape (int year keys) -> JSON (string year keys); group keys kept when present."""
    block = {key: _years(result[key]) for key in ("value", "null_reason")}
    if "members" in result:
        block.update(reporting=_years(result["reporting"]), members=result["members"],
                     coverage=_years(result["coverage"]), wipo_years=list(result["wipo_years"]))
    return block


def _gender_codes(collected: dict, codes: list[str]) -> list[str]:
    """Entity codes with a gender block: every country, and each former entity WIPO lists in a gender table."""
    listed = {code for measure in gender.MEASURES for code in collected["gender"][measure].values}
    return [code for code in codes
            if classify(code) == "country" or (classify(code) == "historical" and code in listed)]


def _classify_gender_codes(collected: dict) -> None:
    """Every origin code of the gender tables classified like the count codes: unknown -> ValueError (audit G12)."""
    for measure in gender.MEASURES:
        for code in collected["gender"][measure].values:
            classify(code)


def unlisted_gender_codes(collected: dict) -> list[str]:
    """Warning lines: country codes with a WIPO share but no entity file (not shown; checks.gender warnings)."""
    entities = set(_entity_codes(collected["series"]))
    lines = []
    for measure in gender.MEASURES:
        for code, values in sorted(collected["gender"][measure].values.items()):
            present = [year for year in gender_years(collected, measure) if values.get(year) is not None]
            if present and classify(code) == "country" and code not in entities:
                lines.append(f"{measure} {code}: WIPO values {present[0]}-{present[-1]}, no country entity (not shown)")
    return lines


def _country_gender(code: str, collected: dict) -> dict:
    return {measure: _gender_block(gender.country_share(collected["gender"][measure].values.get(code, {}),
                                                        gender_years(collected, measure)))
            for measure in gender.MEASURES}


def _country_publications(code: str, collected: dict) -> dict:
    """PCT publications (pmh 1010) of a country over the women_any years; None where WIPO lists none."""
    counts = collected["pct_publications"].get(code, {})
    return {str(year): counts.get(year) for year in gender_years(collected, gender.WOMEN_ANY)}


def _publications_source(collected: dict, entity: str | None) -> dict:
    return {"name": SOURCE_NAME, "url": SOURCE_URL, "tab": "pmh", "query": PCT_PUBLICATIONS_QUERY, "entity": entity,
            "years": f"{GENDER_FROM}-{collected['gender'][gender.WOMEN_ANY].last_year}",
            "description": "PCT publications, by publication year"}


def _printed_sources(measure: str, continent: str, published: dict, years: list[int]) -> dict:
    """year -> WIPO's printed source (citation, url, figure, page) for each WIPO year of a continent."""
    printed = published[measure][continent]
    return {str(year): {**published["source"], "figure": printed[year]["figure"], "page": printed[year]["page"]}
            for year in years}


def _same_members_continent(group_id: str) -> str | None:
    """The continent this group is, by members (itself, or M49 021 = northern-america): its printed figures apply."""
    members = sorted(m49.members(group_id))
    return next((continent for continent in m49.CONTINENTS if sorted(m49.members(continent)) == members), None)


def _group_gender(group_id: str, collected: dict, published: dict) -> tuple[dict, dict]:
    """(gender blocks, their sources): women_any weighted, women_share not computable; on a continent WIPO's printed
    figures win in the years printed (ruling C1), also on a group with a continent's members (review 4b I1)."""
    results = {
        gender.WOMEN_ANY: group_women_any_computed(collected, group_id),
        gender.WOMEN_SHARE: gender.group_women_share(gender_members(collected, group_id),
                                                     gender_years(collected, gender.WOMEN_SHARE)),
    }
    descriptions = {gender.WOMEN_ANY: GROUP_COMPUTED_LABEL, gender.WOMEN_SHARE: GROUP_NOT_COMPUTABLE_LABEL}
    continent = _same_members_continent(group_id)
    unlisted = sorted(set(m49.members(group_id)) - set(gender_members(collected, group_id)))
    blocks, sources = {}, {}
    for measure, result in results.items():
        if continent:
            result = gender.continent_value(measure, continent, result, published)
        description = f"{_gender_def(measure).label}: {descriptions[measure]}"
        if result["wipo_years"]:
            description += f"; {PRINTED_LABEL} {', '.join(str(year) for year in result['wipo_years'])}"
        sources[measure] = _gender_source(collected, measure, None, description)
        if measure == gender.WOMEN_ANY:  # women_share is never weighted (not computable)
            sources[measure]["weights"] = PCT_PUBLICATIONS_QUERY
        if result["wipo_years"]:
            sources[measure]["printed"] = _printed_sources(measure, continent, published, result["wipo_years"])
        blocks[measure] = _gender_block(result)
        blocks[measure]["unlisted"] = unlisted  # M49 members outside m: no PCT publications row (named on the site)
    return blocks, sources


def _gender_map_file(measure: str, country_gender: dict[str, dict], collected: dict) -> dict:
    """women_any also carries every country's PCT publications: the ranking reads one file, not 200 entities (4a)."""
    file = {"values": {code: blocks[measure]["value"] for code, blocks in country_gender.items()},
            "null_reason": {code: blocks[measure]["null_reason"] for code, blocks in country_gender.items()},
            "sources": {measure: _gender_source(collected, measure, None)}}
    if measure == gender.WOMEN_ANY:
        file["pct_publications"] = {code: _country_publications(code, collected) for code in country_gender}
        file["sources"]["pct_publications"] = _publications_source(collected, None)
    return file


def _gender_overview(collected: dict) -> dict:
    """World = WIPO's ZZ row as published; by_field = women_any by technology field (world) in its last year."""
    tables: dict[str, GenderData] = collected["gender"]
    by_field = tables["women_any_by_field"]
    return {
        "world": {measure: _years({year: tables[measure].values[GENDER_WORLD_CODE].get(year)
                                   for year in gender_years(collected, measure)}) for measure in gender.MEASURES},
        "by_field": {field: {"label": by_field.labels[field], "value": by_field.values[field].get(by_field.last_year)}
                     for field in GENDER_FIELD_IDS},
        "last_year": {gender_id: tables[gender_id].last_year for gender_id in GENDER_IDS},
    }


def _gender_groups_summary(group_files: dict[str, dict]) -> dict:
    """overview.gender.groups: per group with either, its members outside m, WIPO's printed values and their figure
    and page (methods page reads one file, not every group)."""
    summary = {}
    for group_id, file in group_files.items():
        blocks = file["gender"]
        printed = {measure: {str(year): block["value"][str(year)] for year in block["wipo_years"]}
                   for measure, block in blocks.items() if block["wipo_years"]}
        refs = {measure: {year: {key: entry[key] for key in ("figure", "page")}
                          for year, entry in source["printed"].items()}
                for measure, source in file["sources"].items() if measure in blocks and "printed" in source}
        unlisted = blocks[gender.WOMEN_ANY]["unlisted"]
        if unlisted or printed:
            summary[group_id] = {"unlisted": unlisted, "printed": printed, "printed_refs": refs}
    return summary


def _gender_absent_rows(collected: dict) -> dict[str, int]:
    """Listed rows (origins, fields) without a value in any year, per gender table."""
    return {gender_id: sum(1 for values in collected["gender"][gender_id].values.values()
                           if all(value is None for value in values.values())) for gender_id in GENDER_IDS}


def _group_file(group_id: str, ctx: groups.Context, collected: dict, published: dict) -> dict:
    data = ctx.data
    blocks = {}
    for series_id in groups.series_of_group(group_id):
        figures = groups.group_series(series_id, group_id, ctx)
        wipo_row = m49.continent_wipo_code(group_id, series_id) if figures["basis"] == groups.WIPO_TOTAL else None
        block = {
            "basis": figures["basis"], "total": _years(figures["total"]), "reporting": _years(figures["reporting"]),
            "members": figures["members"], "null_reason": _years(figures["null_reason"]),
            "source": _source(data[series_id], wipo_row),
        }
        if figures["basis"] == groups.WIPO_TOTAL:
            block["member_sum"] = _years(figures["member_sum"])
        else:  # fixed panel only on member sums: the R row has no member gaps
            panel = groups.panel(series_id, group_id, ctx)
            block["panel"] = {**panel, "total": _years(panel["total"])}
        blocks[series_id] = block
    gender_blocks, gender_sources = _group_gender(group_id, collected, published)
    return {"id": group_id, "kind": "continent" if group_id in m49.CONTINENTS else "region",
            "label": groups.group_label(group_id), "continent": groups.group_continent(group_id),
            "series": blocks, "ratios": _group_ratios(group_id, ctx, collected), "gender": gender_blocks,
            "former_notes": groups.former_notes(group_id),
            "sources": {**{series_id: block["source"] for series_id, block in blocks.items()}, **gender_sources}}


def _continent_share(series_id: str, ctx: groups.Context) -> dict:
    share = groups.continent_share(series_id, ctx)
    return {**share, "continent": {continent: _years(total) for continent, total in share["continent"].items()},
            "unallocated": _years(share["unallocated"]), "null_reason": _years(share["null_reason"])}


def _map_file(series: SeriesData, until: int) -> dict:
    """Country and former-state totals (former states: successor hatching on the map)."""
    codes = sorted(code for code in series.values if classify(code) in ("country", "historical"))
    return {"values": {code: _years(series.values[code]["total"], until) for code in codes},
            "sources": {series.series.id: _source(series, None)}}


def _pct_source(states: pct_states.PctStates) -> dict:
    return {"source_url": states.source_url, "count_check_url": states.count_check_url,
            "status_on": states.status_on.isoformat(), "retrieved": states.retrieved.isoformat()}


def _pct_member_map_file(states: pct_states.PctStates, codes: list[str]) -> dict:
    return {"values": {code: {str(year): member for year, member in years.items()}
                       for code, years in pct_states.member_years(states, codes).items()},
            "null_reason": pct_states.null_reasons(codes),
            "in_force": {code: day.isoformat() for code, day in states.in_force.items()},
            "unmatched": pct_states.unmatched(states, codes),
            "sources": {pct_states.PCT_MEMBER_ID: _pct_source(states)}}


def _pct_membership(states: pct_states.PctStates, codes: list[str]) -> dict:
    """Overview block: the map's year range and note counts, the methods page's dates, unmatched and continuing States."""
    return {**_pct_source(states), "first_year": pct_states.PCT_FIRST_YEAR, "last_year": pct_states.last_year(states),
            "count": {str(year): count for year, count in pct_states.counts(states).items()},
            "unmatched": pct_states.unmatched(states, codes),
            "continuing": [{"code": code, "name": states.names[code], "in_force": states.in_force[code].isoformat(),
                            "continues": continues} for code, continues in sorted(states.continuing.items())]}


def groups_listing(group_items: list[dict]) -> dict:
    """groups.json: group list + former-entity successors (the map hatches a successor "reported under" its former)
    + `no_group` (code -> why M49 lists no region; methods page)."""
    return {"items": group_items, "successors": m49.SUCCESSORS, "no_group": m49.NO_GROUP,
            "sources": {"groupings": m49.M49_SOURCES, "former_entities": m49.SUCCESSORS_SOURCES}}


def build_outputs(collected: dict, releases: dict[str, str], retrieved: datetime.date, sha: str,
                  group_ctx: groups.Context | None = None,
                  pct: pct_states.PctStates | None = None) -> dict[Path, dict | list]:
    """Every site data file, keyed by path relative to the data root. Manifest `checks` filled by run.py.
    `collected` = collect() result + run.py's WDI `denominators`; `group_ctx` = groups.context of its series
    (run.py shares it with the checks), built here when None; `pct` = the PCT States list run.py loaded, loaded here
    when None."""
    if pct is None:
        pct = pct_states.load_pct_states()
    data: dict[str, SeriesData] = collected["series"]
    for series in data.values():
        if series.last_year >= retrieved.year:
            raise ValueError(f"{series.series.id}: last year {series.last_year} not complete on {retrieved}")
    for gender_id, table in collected["gender"].items():
        if table.last_year >= retrieved.year:
            raise ValueError(f"{gender_id}: last year {table.last_year} not complete on {retrieved}")
    if group_ctx is None:
        group_ctx = groups.context(data)
    elif group_ctx.data is not data:
        raise ValueError("group context built for other data")
    worlds = group_ctx.worlds
    labels = _labels(data)
    last_year = {series.id: data[series.id].last_year for series in SERIES}
    ranks = {series.id: _ranks_by_year(data[series.id], worlds[WORLD_OF_SERIES[series.id]].last_year)
             for series in SERIES}
    # share denominators cut at their own world's last_year, the same figure the group shares divide by
    denominators = {series.id: groups.world_total(series.id, worlds) for series in SERIES}

    outputs: dict[Path, dict | list] = {}
    codes = _entity_codes(data)
    ratios: dict[str, RatioData] = collected["ratios"]
    _classify_ratio_codes(ratios)
    country_ratios = _country_ratios([code for code in codes if classify(code) == "country"], collected, worlds)
    _classify_gender_codes(collected)
    entity_gender = {code: _country_gender(code, collected) for code in _gender_codes(collected, codes)}
    published = gender.load_published()
    for code in codes:
        listing = [series for series in SERIES if code in data[series.id].values]
        outputs[ENTITY_DIR / f"{code}.json"] = {
            "code": code, "label": labels[code], "kind": classify(code),
            "series": {series.id: {
                "types": {key: _years(values) for key, values in data[series.id].values[code].items()},
                "derived": _derived(data[series.id], code, worlds[WORLD_OF_SERIES[series.id]],
                                    denominators[series.id], ranks[series.id]),
            } for series in listing},
            "sources": {series.id: _source(data[series.id], code) for series in listing},
        }
        if code in country_ratios:  # pct_per_million cites sources.pct_origin
            outputs[ENTITY_DIR / f"{code}.json"]["ratios"] = country_ratios[code]
            outputs[ENTITY_DIR / f"{code}.json"]["sources"].update(
                {ratio_id: _ratio_source(ratios[ratio_id], code) for ratio_id in scale.WIPO_RATIO_IDS})
        if code in entity_gender:
            outputs[ENTITY_DIR / f"{code}.json"]["gender"] = entity_gender[code]
            outputs[ENTITY_DIR / f"{code}.json"]["sources"].update(
                {measure: _gender_source(collected, measure, code) for measure in gender.MEASURES})
            if classify(code) == "country":  # gender weights, shown in the women ranking (Task 4a)
                outputs[ENTITY_DIR / f"{code}.json"]["pct_publications"] = _country_publications(code, collected)
                outputs[ENTITY_DIR / f"{code}.json"]["sources"]["pct_publications"] = _publications_source(
                    collected, code)
    outputs[ENTITIES] = [{"code": code, "label": labels[code], "kind": classify(code), "iso3": iso3(code),
                          "iso_numeric": m49.iso_numeric(code)} for code in codes]
    group_items = groups.groups_list()
    outputs[GROUPS] = groups_listing(group_items)
    for item in group_items:
        outputs[GROUP_DIR / f"{item['id']}.json"] = _group_file(item["id"], group_ctx, collected, published)
    gender_groups = _gender_groups_summary({item["id"]: outputs[GROUP_DIR / f"{item['id']}.json"]
                                            for item in group_items})
    for series in SERIES:
        cut = worlds[WORLD_OF_SERIES[series.id]].last_year
        outputs[MAP_DIR / f"{series.id}.json"] = _map_file(data[series.id], cut)
    for ratio_id in MAP_RATIOS:
        outputs[MAP_DIR / f"{ratio_id}.json"] = _ratio_map_file(ratio_id, country_ratios, ratios[ratio_id])
    country_gender = {code: blocks for code, blocks in entity_gender.items() if classify(code) == "country"}
    for measure in gender.MEASURES:
        outputs[MAP_DIR / f"{measure}.json"] = _gender_map_file(measure, country_gender, collected)
    outputs[MAP_DIR / f"{pct_states.PCT_MEMBER_ID}.json"] = _pct_member_map_file(pct, codes)
    gender_overview = _gender_overview(collected)
    top_origins = _top_origins(data["origin_apps"], worlds["world_origin"], denominators["origin_apps"], labels)
    outputs[OVERVIEW] = {
        **{key: _years(worlds[key].published, worlds[key].last_year) for key in PUBLISHED_WORLDS},
        "coverage": {key: _years(worlds[key].coverage) for key in PUBLISHED_WORLDS},
        "world_last_year": {key: worlds[key].last_year for key in PUBLISHED_WORLDS},
        "top_year": worlds["world_origin"].last_year,
        "coverage_rule": {"min_ratio": COVERAGE_MIN_RATIO, "lookback_years": derive.PROVISIONAL_LOOKBACK_YEARS},
        "top_origins": top_origins,
        "top_grower": _top_grower(data["origin_apps"], worlds["world_origin"], top_origins),
        "world_yoy": _world_yoy(worlds),
        "treemap": _treemap(data["origin_apps"], group_ctx, labels),
        "share_shift": _share_shift(data["origin_apps"], worlds["world_origin"], denominators["origin_apps"],
                                    top_origins),
        "share_denominator": {series_id: SHARE_DENOMINATOR_LABEL[key] for series_id, key in SHARE_DENOMINATOR.items()},
        "fastest_growers": _fastest_growers(data["origin_apps"], worlds["world_origin"], labels),
        "size_growth": _size_growth(data["origin_apps"], worlds["world_origin"], labels),
        "rank_race": _rank_race(data["origin_apps"], worlds["world_origin"], ranks["origin_apps"], labels),
        "pct_monthly": _pct_monthly(data["pct_origin"], collected["pct_monthly"]),
        "pct_monthly_source": {**_source(data["pct_origin"], TOTAL_ROW_CODES["pct_origin"]),
                               "query": PCT_MONTHLY_QUERY},
        "top_n": TOP_N,
        "grower_min": GROWER_MIN,
        "method": method_constants(),
        "last_year": last_year,
        "sources": {**{series.id: _source(data[series.id], None) for series in SERIES},
                    **{ratio_id: _ratio_source(ratios[ratio_id], RATIO_WORLD_CODE) for ratio_id in scale.WIPO_RATIO_IDS},
                    **{gender_id: _gender_source(collected, gender_id,  # World as published; fields: world only
                                                 GENDER_WORLD_CODE if gender_id in gender.MEASURES else None)
                       for gender_id in GENDER_IDS}},
        "gender": {**gender_overview, "groups": gender_groups, "printed_source": dict(published["source"])},
        "world_ratios": _world_ratios(collected, worlds),
        "ratio_last_year": _ratio_last_year(country_ratios),
        "ratio_no_denominator": _ratio_no_denominator(sorted(country_ratios), collected, worlds),
        "world_sources": {key: _world_source(key, data, worlds[key]) for key in PUBLISHED_WORLDS},
        "continent_share": {series.id: _continent_share(series.id, group_ctx) for series in SERIES},
        "series_breaks": [{**entry, "label": labels.get(entry["code"], entry["code"])} for entry in breaks.listing()],
        "pct_membership": _pct_membership(pct, codes),
    }
    outputs[MANIFEST] = {
        "releases": dict(releases),
        "retrieved": retrieved.isoformat(),
        "pipeline_sha": sha,
        "last_year": {**last_year, **gender_overview["last_year"]},
        "absent_rows": {**{series.id: data[series.id].absent_rows for series in SERIES},
                        **_gender_absent_rows(collected)},
        "wdi_denominators": _wdi_denominators(collected["denominators"]),
        "ratio_labels": {ratio_id: ratios[ratio_id].api_label for ratio_id in scale.WIPO_RATIO_IDS},
        "gender_labels": {gender_id: collected["gender"][gender_id].api_label for gender_id in GENDER_IDS},
        "checks": {},
    }
    return outputs


def published_value(outputs: dict[Path, dict], series_id: str, code_or_world: str, year: int) -> int | float | None:
    """Total as published: "world" = the overview world series of `series_id`, else the entity file. Ratio ids
    (scale.RATIO_IDS): overview `world_ratios`, else entity `ratios.<id>.value`. Gender measures (women_any,
    women_share): overview `gender.world`, else entity `gender.<id>.value`. Growth ids
    (crosscheck.GOLDEN_GROWTH_SERIES): overview `world_yoy.<world>.yoy`, world only (else None)."""
    if series_id in crosscheck.GOLDEN_GROWTH_SERIES:
        if code_or_world != "world":
            return None
        world_yoy = outputs[OVERVIEW].get("world_yoy", {}).get(crosscheck.GOLDEN_GROWTH_SERIES[series_id], {})
        return world_yoy.get("yoy", {}).get(str(year))
    if series_id in gender.MEASURES:
        if code_or_world == "world":
            return outputs[OVERVIEW]["gender"]["world"].get(series_id, {}).get(str(year))
        entity = outputs.get(ENTITY_DIR / f"{code_or_world}.json")
        return (entity or {}).get("gender", {}).get(series_id, {}).get("value", {}).get(str(year))
    if series_id in scale.RATIO_IDS:
        if code_or_world == "world":
            return outputs[OVERVIEW]["world_ratios"].get(series_id, {}).get(str(year))
        entity = outputs.get(ENTITY_DIR / f"{code_or_world}.json")
        return (entity or {}).get("ratios", {}).get(series_id, {}).get("value", {}).get(str(year))
    if code_or_world == "world":
        return outputs[OVERVIEW].get(WORLD_OF_SERIES[series_id], {}).get(str(year))
    entity = outputs.get(ENTITY_DIR / f"{code_or_world}.json")
    if entity is None or series_id not in entity["series"]:
        return None
    return entity["series"][series_id]["types"]["total"].get(str(year))


def dumps(content: object) -> str:
    return json.dumps(content, allow_nan=False, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def _existing(root: Path) -> set[Path]:
    """Known data files under root: the top-level files and */*.json of DATA_DIRS; anything else ignored."""
    if not root.is_dir():
        return set()
    top = {name for name in (ENTITIES, OVERVIEW, MANIFEST, GROUPS) if (root / name).is_file()}
    return top | {path.relative_to(root) for folder in DATA_DIRS for path in root.glob(f"{folder}/*.json")}


def changed(new: dict[Path, dict], root: Path) -> bool:
    """True if a data file differs (overview `method` included), a file is added or removed, or manifest
    releases, absent_rows, pipeline_sha or wdi_denominators differ (new code rewrites the data it describes; a new WDI
    vintage, like a WIPO release, renews the GDP label). Retrieval date, checks and last_year alone never count."""
    if _existing(root) != set(new):
        return True
    for path, content in new.items():
        if path != MANIFEST and (root / path).read_text(encoding="utf-8") != dumps(content):
            return True
    old_manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    return any(old_manifest.get(key) != new[MANIFEST][key] for key in ("releases", "absent_rows", "pipeline_sha",
                                                                         "wdi_denominators"))


def write_file(root: Path, path: Path, content: object) -> None:
    """One data file, temp + rename (a reader never sees half a file)."""
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    temp.write_text(dumps(content), encoding="utf-8")
    os.replace(temp, target)


def write_outputs(outputs: dict[Path, dict | list], root: Path) -> None:
    """Write every file (write_file), then delete entity/group/map files not in `outputs`."""
    for path, content in outputs.items():
        write_file(root, path, content)
    for path in _existing(root) - set(outputs):
        if path.parent in DATA_DIRS:
            (root / path).unlink()
