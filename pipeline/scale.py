"""Scale ratios (per million population, per $100bn GDP PPP, PCT per million) and the WIPO ratio cross-check.
Pure functions, no I/O (spec "Measures"; research `docs/research/2026-10-20-wipo-ratio-indicators.md` §2, §4).

- WIPO first: a country or World value WIPO publishes (ips 100/101) is kept as published, never overridden.
- Country fill: WIPO null + numerator + WDI denominator present + denominator above WIPO's threshold -> computed,
  year listed in `computed`. WIPO's thresholds (country profile note 5) are for its own resident ratios: population
  for per million, PPP GDP for per GDP; strictly greater passes.
- Below precision (ruling, final review M2): a computed value (country fill, group) rounding to 0.0 at RATIO_DECIMALS
  with a numerator > 0 -> null BELOW_PRECISION; WIPO publishes no 0.0 in either table and leaves these cells empty
  (live 2026-10-21: all 13 per-million fills were such cells). A numerator of 0 stays 0.0 (a real zero).
- PCT per million: WIPO publishes no PCT ratio and no threshold for one. Our rule, by analogy: WIPO's per-million
  population threshold (`WIPO_THRESHOLD["population"]`).
- Groups: sum(numerator) / sum(denominator) over members with both values that year, no threshold inside sums;
  "n of m" = `reporting` of `members`; a year in the numerator series' floor is null with that reason (fail closed);
  summed denominator <= WIPO's threshold -> null BELOW_THRESHOLD (ruling, Task 3a review: WIPO's small-population
  rationale applies to groups, e.g. Micronesia, Polynesia; PCT per million by analogy, as for countries).
- Cross-check (`ratio_crosscheck`): ours unrounded vs every WIPO value, per ratio; fail limit per ratio, never pooled.
  Blocking test per ratio (RATIO_BLOCKING_TEST): per million = cell share; per GDP = share of countries off by a
  median factor (WDI GDP revisions after WIPO's release shift a country's whole series by one factor; live
  2026-10-21: 27 of 142 countries, up to ~3%; ruling, Task 3b dry run). The other test warns.
- Rounding: RATIO_DECIMALS, half away from zero via `Decimal` (same rule as derive).
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from statistics import median

from pipeline.collect import RatioData
from pipeline.groups import NONE_REPORTED
from pipeline.series import RATIO_FROM, RATIO_WORLD_CODE
from pipeline.wdi import WDI_MAX_LAG, Denominator

# Published by `method_constants` (overview.method.ratios); the methods page reads them there.
RATIO_IDS = ("per_million", "per_gdp", "pct_per_million")
WIPO_RATIO_IDS = ("per_million", "per_gdp")  # WIPO publishes these (ips 101, 100); PCT per million computed only
RATIO_SCALE = {"per_million": 1e6, "per_gdp": 1e11, "pct_per_million": 1e6}
RATIO_DENOMINATOR = {"per_million": "population", "per_gdp": "gdp_ppp", "pct_per_million": "population"}
RATIO_NUMERATOR = {"per_million": ("origin_apps", "resident"), "per_gdp": ("origin_apps", "resident"),
                   "pct_per_million": ("pct_origin", "total")}  # (series id, type key); I4
WIPO_THRESHOLD = {"population": 1_000_000, "gdp_ppp": 10_000_000_000}  # value must be strictly greater; GDP = PPP
RATIO_DECIMALS = 1  # WIPO's precision
RATIO_ABS_TOLERANCE = 0.05
RATIO_REL_TOLERANCE = 0.005
RATIO_FAIL_SHARE_MAX = 0.10  # per ratio (I9)
RATIO_FAILING_LIST_MAX = 50  # failing lines published per ratio (Task 3a cuts; `failing` holds all)
RATIO_COUNTRY_FACTOR_MAX = 0.10  # |median(ours/WIPO) - 1| beyond: unit/indicator error, not a WDI vintage shift
RATIO_COUNTRY_SHARE_MAX = 0.05  # countries beyond the factor limit, share of compared; above blocks (country test)
RATIO_VINTAGE_NOTE_MIN = 0.005  # |median - 1| above: listed in vintage_factors (= RATIO_REL_TOLERANCE, the cell scale)
CELL_SHARE = "cell_share"  # failing share of compared cells > RATIO_FAIL_SHARE_MAX
COUNTRY_FACTOR = "country_factor"  # share of countries |median - 1| > RATIO_COUNTRY_FACTOR_MAX > RATIO_COUNTRY_SHARE_MAX
RATIO_BLOCKING_TEST = {"per_million": CELL_SHARE, "per_gdp": COUNTRY_FACTOR}  # the other test warns; WD always blocks

# Null-reason keys; groups also use groups.NONE_REPORTED / ATTRIBUTION_FLOOR / NO_WIPO_WORLD_TOTAL (via `floor`).
BELOW_THRESHOLD = "below_wipo_threshold"
NO_POPULATION = "no_population"
NO_GDP = "no_gdp"
NO_APPLICATIONS = "no_applications"
BELOW_PRECISION = "below_precision"
_MISSING_DENOMINATOR = {"population": NO_POPULATION, "gdp_ppp": NO_GDP}

_PCT_DECIMALS = 2  # failing lines
_MAX_PCT_DECIMALS = 1  # by_country max_pct
_SHARE_DECIMALS = 1  # blocking line share and limit
_FACTOR_DECIMALS = 4  # median factors in by_country, vintage_factors and lines


def _decimal(value: float) -> Decimal:
    return Decimal(repr(value))


def _quantize(value: Decimal, decimals: int) -> Decimal:
    return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _exact(numerator: int, denominator: Decimal, scale: float) -> Decimal:
    return Decimal(numerator) * _decimal(scale) / denominator


def _round_ratio(exact: Decimal) -> float:
    return float(_quantize(exact, RATIO_DECIMALS)) + 0.0  # -0.0 + 0.0 == 0.0: JSON never shows "-0.0"


def _usable(value: float | None) -> bool:
    return value is not None and value > 0


def _ours(count: int | None, base: float | None, scale: float) -> Decimal | None:
    """Unrounded count x scale / base; None when either is None or base <= 0."""
    if count is None or not _usable(base):
        return None
    return _exact(count, _decimal(base), scale)


def ratio(numerator: int | None, denominator: float | None, scale: float) -> float | None:
    """numerator x scale / denominator, RATIO_DECIMALS half away from zero; None when either is None or
    denominator <= 0."""
    exact = _ours(numerator, denominator, scale)
    return None if exact is None else _round_ratio(exact)


def _computed(count: int, exact: Decimal) -> tuple[float | None, str | None]:
    """(rounded value, None) or (None, BELOW_PRECISION) when it rounds to 0.0 from a count > 0 (M2)."""
    value = _round_ratio(exact)
    return (None, BELOW_PRECISION) if value == 0 and count > 0 else (value, None)


def country_ratio(wipo: dict[int, float | None] | None, numerator: dict[int, int | None],
                  denominator: dict[int, float | None] | None, ratio_id: str, years: range) -> dict:
    """{"value": {year: float | None}, "computed": [year], "null_reason": {year: key}} for every year.
    WIPO value where non-null (0.0 kept); else computed above the threshold; else null, reason checked in order:
    below threshold, missing denominator (`denominator` None = no WDI row), missing numerator; a computed value
    rounding to 0.0 from a count > 0 -> null BELOW_PRECISION."""
    kind = RATIO_DENOMINATOR[ratio_id]
    threshold = WIPO_THRESHOLD[kind]
    wipo = wipo or {}
    denominator = denominator or {}
    value: dict[int, float | None] = {}
    computed: list[int] = []
    null_reason: dict[int, str] = {}
    for year in years:
        published = wipo.get(year)
        if published is not None:
            value[year] = published
            continue
        count, base = numerator.get(year), denominator.get(year)
        value[year] = None
        if base is not None and base <= threshold:
            null_reason[year] = BELOW_THRESHOLD
        elif base is None:
            null_reason[year] = _MISSING_DENOMINATOR[kind]
        elif count is None:
            null_reason[year] = NO_APPLICATIONS
        else:
            value[year], reason = _computed(count, _exact(count, _decimal(base), RATIO_SCALE[ratio_id]))
            if reason is None:
                computed.append(year)
            else:
                null_reason[year] = reason
    return {"value": value, "computed": computed, "null_reason": null_reason}


def group_ratio(numerators: dict[str, dict[int, int | None]], denominator: dict[str, dict[int, float | None]],
                members: list[str], ratio_id: str, years: range, floor: dict[int, str]) -> dict:
    """{"value", "reporting": {year: int}, "members": len(members), "null_reason"}: sum(numerator) /
    sum(denominator) over members with both values (denominator > 0) that year, no threshold inside sums.
    Null reason, first that applies: a year in `floor` (numerator series' Context.floor) -> that reason; 0 reporting
    -> NONE_REPORTED; summed denominator <= WIPO_THRESHOLD -> BELOW_THRESHOLD; rounds to 0.0 from a sum > 0 ->
    BELOW_PRECISION. Reporting always counted.
    Caller: members = groups.listed_members(data, RATIO_NUMERATOR[id][0], group)."""
    threshold = _decimal(WIPO_THRESHOLD[RATIO_DENOMINATOR[ratio_id]])
    value: dict[int, float | None] = {}
    reporting: dict[int, int] = {}
    null_reason: dict[int, str] = {}
    for year in years:
        count_sum, base_sum = 0, Decimal(0)
        reporting[year] = 0
        for code in members:
            count = numerators.get(code, {}).get(year)
            base = denominator.get(code, {}).get(year)
            if count is not None and _usable(base):
                count_sum += count
                base_sum += _decimal(base)
                reporting[year] += 1
        value[year] = None
        if year in floor:
            null_reason[year] = floor[year]
        elif reporting[year] == 0:
            null_reason[year] = NONE_REPORTED
        elif base_sum <= threshold:
            null_reason[year] = BELOW_THRESHOLD
        else:
            value[year], reason = _computed(count_sum, _exact(count_sum, base_sum, RATIO_SCALE[ratio_id]))
            if reason is not None:
                null_reason[year] = reason
    return {"value": value, "reporting": reporting, "members": len(members), "null_reason": null_reason}


def world_ratio(wipo_wd: dict[int, float | None]) -> dict[int, float | None]:
    """WIPO's WD row as published (WIPO first; never computed)."""
    return dict(wipo_wd)


def world_pct_per_million(zz: dict[int, int | None],
                          population_world: dict[int, float | None]) -> dict[int, float | None]:
    """PCT ZZ total / WDI world population x 1e6, every year of `zz`; None where either is missing."""
    return {year: ratio(count, population_world.get(year), RATIO_SCALE["pct_per_million"])
            for year, count in zz.items()}


@dataclass
class RatioCheck:
    """Keyed by WIPO ratio id. `compared` / `failing` / `by_country` = country cells; the WD row is checked apart
    (`world_compared` years, `world_failing` lines per ratio; own blocking lines, none compared = blocking).
    `by_country[id][code]` = every compared code: failing cells, largest |% diff| and median ours/WIPO factor (each
    None when every WIPO value is 0). `vintage_factors[id]` = [{code, median_factor}] with |median - 1| >
    RATIO_VINTAGE_NOTE_MIN, largest first. `warnings[id]` = the non-blocking test's line when over its limit."""
    compared: dict[str, int]
    failing: dict[str, list[str]]
    by_country: dict[str, dict[str, dict]]
    world_failing: dict[str, list[str]]
    world_compared: dict[str, int]
    vintage_factors: dict[str, list[dict]]
    warnings: dict[str, list[str]]
    blocking: list[str]


def _cell(ratio_id: str, code: str, year: int, published: float, ours: Decimal) -> tuple[bool, Decimal | None, str]:
    """(passes, |% diff| unrounded or None when WIPO is 0, failing line)."""
    wipo = _decimal(published)
    tolerance = _decimal(RATIO_ABS_TOLERANCE) + _decimal(RATIO_REL_TOLERANCE) * abs(wipo)
    passes = abs(ours - wipo) <= tolerance
    pct = (ours - wipo) * 100 / wipo if wipo != 0 else None
    pct_text = "n/a" if pct is None else f"{_quantize(pct, _PCT_DECIMALS):+f}%"
    line = (f"{ratio_id} {code} {year}: WIPO {_quantize(wipo, RATIO_DECIMALS):f}, "
            f"computed {_quantize(ours, RATIO_DECIMALS):f} ({pct_text})")
    return passes, None if pct is None else abs(pct), line


def _percent(share: Decimal) -> str:
    return f"{_quantize(share * 100, _SHARE_DECIMALS):f}%"


def _cell_share_line(ratio_id: str, failing: int, compared: int) -> str | None:
    """Line when the failing share of compared cells > RATIO_FAIL_SHARE_MAX, else None."""
    limit = _decimal(RATIO_FAIL_SHARE_MAX)
    if Decimal(failing) <= limit * compared:
        return None
    return (f"{ratio_id}: {failing} of {compared} compared cells outside tolerance "
            f"({_percent(Decimal(failing) / compared)}), above the limit {_percent(limit)}")


def _country_factor_line(ratio_id: str, factors: dict[str, Decimal]) -> str | None:
    """Line naming the countries with |median - 1| > RATIO_COUNTRY_FACTOR_MAX when their share of the countries with
    a factor > RATIO_COUNTRY_SHARE_MAX, else None."""
    factor_limit, share_limit = _decimal(RATIO_COUNTRY_FACTOR_MAX), _decimal(RATIO_COUNTRY_SHARE_MAX)
    off = _largest_first({code: factor for code, factor in factors.items() if abs(factor - 1) > factor_limit})
    if Decimal(len(off)) <= share_limit * len(factors):
        return None
    named = ", ".join(f"{code} {_quantize(factors[code], _FACTOR_DECIMALS):f}" for code in off)
    return (f"{ratio_id}: {len(off)} of {len(factors)} countries with a median ours/WIPO factor off by more than "
            f"{_percent(factor_limit)} ({_percent(Decimal(len(off)) / len(factors))}), above the limit "
            f"{_percent(share_limit)}: {named}")


def _largest_first(factors: dict[str, Decimal]) -> list[str]:
    """Codes by |factor - 1| descending, then code."""
    return sorted(factors, key=lambda code: (-abs(factors[code] - 1), code))


def ratio_crosscheck(wipo: dict[str, RatioData], resident: dict[str, dict[int, int | None]],
                     office_wd_resident: dict[int, int | None], denominators: dict[str, Denominator]) -> RatioCheck:
    """Our unrounded ratio vs every WIPO value with both inputs present; pass iff |ours - wipo| <=
    RATIO_ABS_TOLERANCE + RATIO_REL_TOLERANCE x wipo. Countries: `resident` (origin type 911) / WDI row; codes
    without a WDI row (SU, YU, TW) are not compared. WD: office WD type 901 / WDI world. Per country: median of
    ours/WIPO over compared cells, WIPO-0 cells skipped. Blocking per ratio: any WD failure or no WD year compared
    (fails closed); RATIO_BLOCKING_TEST[id] over its limit (never pooled across ratios); the other test warns."""
    result = RatioCheck(compared={}, failing={}, by_country={}, world_failing={}, world_compared={},
                        vintage_factors={}, warnings={}, blocking=[])
    for ratio_id in WIPO_RATIO_IDS:
        scale = RATIO_SCALE[ratio_id]
        rows = denominators[RATIO_DENOMINATOR[ratio_id]]
        compared, failing, world_failing, world_compared = 0, [], [], 0
        drift: dict[str, dict] = {}
        cell_factors: dict[str, list[Decimal]] = {}
        for code in sorted(wipo[ratio_id].values):
            is_world = code == RATIO_WORLD_CODE
            numerator = office_wd_resident if is_world else resident.get(code, {})
            base = rows.world if is_world else rows.values.get(code, {})
            for year, published in sorted(wipo[ratio_id].values[code].items()):
                if published is None:
                    continue
                ours = _ours(numerator.get(year), base.get(year), scale)
                if ours is None:
                    continue
                passes, pct, line = _cell(ratio_id, code, year, published, ours)
                if is_world:
                    world_compared += 1
                    if not passes:
                        world_failing.append(line)
                    continue
                compared += 1
                entry = drift.setdefault(code, {"failing": 0, "max_pct": None, "median_factor": None})
                if not passes:
                    failing.append(line)
                    entry["failing"] += 1
                if pct is not None and (entry["max_pct"] is None or pct > entry["max_pct"]):
                    entry["max_pct"] = pct
                if published != 0:
                    cell_factors.setdefault(code, []).append(ours / _decimal(published))
        factors = {code: median(values) for code, values in cell_factors.items()}
        for code, entry in drift.items():
            if entry["max_pct"] is not None:
                entry["max_pct"] = float(_quantize(entry["max_pct"], _MAX_PCT_DECIMALS))
            if code in factors:
                entry["median_factor"] = float(_quantize(factors[code], _FACTOR_DECIMALS))
        note_min = _decimal(RATIO_VINTAGE_NOTE_MIN)
        result.vintage_factors[ratio_id] = [
            {"code": code, "median_factor": float(_quantize(factors[code], _FACTOR_DECIMALS))}
            for code in _largest_first(factors) if abs(factors[code] - 1) > note_min]
        result.compared[ratio_id] = compared
        result.failing[ratio_id] = failing
        result.by_country[ratio_id] = drift
        result.world_failing[ratio_id] = world_failing
        result.world_compared[ratio_id] = world_compared
        if world_failing:
            result.blocking.append(f"{ratio_id} world row outside tolerance ({len(world_failing)} years)")
        if world_compared == 0:
            result.blocking.append(f"{ratio_id} world row not compared")
        result.warnings[ratio_id] = []
        lines = {CELL_SHARE: _cell_share_line(ratio_id, len(failing), compared),
                 COUNTRY_FACTOR: _country_factor_line(ratio_id, factors)}
        for test, line in lines.items():
            if line is not None:
                (result.blocking if test == RATIO_BLOCKING_TEST[ratio_id] else result.warnings[ratio_id]).append(line)
    return result


def method_constants() -> dict:
    """Every constant above + ratio_from + wdi.WDI_MAX_LAG, JSON-ready; published as overview.method.ratios."""
    return {
        "ratio_ids": list(RATIO_IDS),
        "wipo_ratio_ids": list(WIPO_RATIO_IDS),
        "scale": dict(RATIO_SCALE),
        "denominator": dict(RATIO_DENOMINATOR),
        "numerator": {ratio_id: {"series": series_id, "type": type_key}
                      for ratio_id, (series_id, type_key) in RATIO_NUMERATOR.items()},
        "wipo_threshold": dict(WIPO_THRESHOLD),
        "decimals": RATIO_DECIMALS,
        "abs_tolerance": RATIO_ABS_TOLERANCE,
        "rel_tolerance": RATIO_REL_TOLERANCE,
        "fail_share_max": RATIO_FAIL_SHARE_MAX,
        "failing_list_max": RATIO_FAILING_LIST_MAX,
        "country_factor_max": RATIO_COUNTRY_FACTOR_MAX,
        "country_share_max": RATIO_COUNTRY_SHARE_MAX,
        "vintage_note_min": RATIO_VINTAGE_NOTE_MIN,
        "blocking_test": dict(RATIO_BLOCKING_TEST),
        "ratio_from": RATIO_FROM,
        "wdi_max_lag": WDI_MAX_LAG,
    }
