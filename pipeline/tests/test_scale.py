import json

from pipeline import groups, scale
from pipeline.collect import RatioData
from pipeline.scale import (
    BELOW_THRESHOLD,
    NO_APPLICATIONS,
    NO_GDP,
    NO_POPULATION,
    RATIO_DENOMINATOR,
    RATIO_BLOCKING_TEST,
    RATIO_COUNTRY_FACTOR_MAX,
    RATIO_COUNTRY_SHARE_MAX,
    RATIO_IDS,
    RATIO_NUMERATOR,
    RATIO_SCALE,
    RATIO_VINTAGE_NOTE_MIN,
    WIPO_RATIO_IDS,
    WIPO_THRESHOLD,
    RatioCheck,
    country_ratio,
    group_ratio,
    method_constants,
    ratio,
    ratio_crosscheck,
    world_pct_per_million,
    world_ratio,
)
from pipeline.series import RATIO_FROM, RATIO_SERIES
from pipeline.wdi import WDI_MAX_LAG, Denominator

Y2024 = range(2024, 2025)


# ratio

def test_ratio_rounds_one_decimal():
    assert ratio(11157, 9034000.0, 1e6) == 1235.0  # CH 2024 (research note §2)
    assert ratio(14502, 1e12, 1e11) == 1450.2


def test_ratio_tie_half_away_from_zero():
    assert ratio(3, 20000000.0, 1e6) == 0.2  # exact 0.15 (float rounding would give 0.1)
    assert ratio(5, 20000000.0, 1e6) == 0.3  # exact 0.25 (half even would give 0.2)


def test_ratio_none_or_non_positive_denominator():
    assert ratio(5, 0.0, 1e6) is None
    assert ratio(5, -1.0, 1e6) is None
    assert ratio(None, 1.0, 1e6) is None
    assert ratio(5, None, 1e6) is None


def test_ratio_zero_numerator_is_zero():
    assert ratio(0, 1e6, 1e6) == 0.0


# country

def test_country_wipo_value_kept_when_computed_differs():
    result = country_ratio({2024: 1235.0}, {2024: 20000}, {2024: 9034000.0}, "per_million", Y2024)
    assert result == {"value": {2024: 1235.0}, "computed": [], "null_reason": {}}


def test_country_wipo_zero_kept():
    result = country_ratio({2024: 0.0}, {2024: 5}, {2024: 9034000.0}, "per_million", Y2024)
    assert result == {"value": {2024: 0.0}, "computed": [], "null_reason": {}}


def test_country_wipo_value_kept_when_denominator_at_or_below_threshold():
    below = country_ratio({2024: 900.0}, {2024: 5}, {2024: 500_000.0}, "per_million", Y2024)
    assert below == {"value": {2024: 900.0}, "computed": [], "null_reason": {}}
    at = country_ratio({2024: 900.0}, {2024: 5}, {2024: 1_000_000.0}, "per_million", Y2024)
    assert at == below
    gdp = country_ratio({2024: 12.5}, {2024: 5}, {2024: 10_000_000_000.0}, "per_gdp", Y2024)
    assert gdp == {"value": {2024: 12.5}, "computed": [], "null_reason": {}}


def test_country_fill_above_population_threshold():
    result = country_ratio({2024: None}, {2024: 100}, {2024: 1_000_001.0}, "per_million", Y2024)
    assert result == {"value": {2024: 100.0}, "computed": [2024], "null_reason": {}}


def test_country_fill_when_wipo_lists_no_row():
    result = country_ratio(None, {2024: 100}, {2024: 2_000_000.0}, "per_million", Y2024)
    assert result == {"value": {2024: 50.0}, "computed": [2024], "null_reason": {}}


def test_country_population_at_threshold_is_below():
    result = country_ratio({2024: None}, {2024: 100}, {2024: 1_000_000.0}, "per_million", Y2024)
    assert result == {"value": {2024: None}, "computed": [], "null_reason": {2024: BELOW_THRESHOLD}}


def test_country_gdp_at_threshold_is_below_and_above_is_filled():
    below = country_ratio({2024: None}, {2024: 100}, {2024: 1e10}, "per_gdp", Y2024)
    assert below == {"value": {2024: None}, "computed": [], "null_reason": {2024: BELOW_THRESHOLD}}
    above = country_ratio({2024: None}, {2024: 100}, {2024: 2e10}, "per_gdp", Y2024)
    assert above == {"value": {2024: 500.0}, "computed": [2024], "null_reason": {}}


def test_country_gdp_threshold_not_used_for_population():
    # 5e9 people: above the population threshold although below the GDP one
    result = country_ratio(None, {2024: 5000}, {2024: 5e9}, "per_million", Y2024)
    assert result["value"] == {2024: 1.0}


def test_country_missing_population():
    result = country_ratio({2024: None}, {2024: 100}, {2024: None}, "per_million", Y2024)
    assert result["null_reason"] == {2024: NO_POPULATION}
    no_row = country_ratio({2024: 12.5}, {2024: 100}, None, "per_million", range(2023, 2025))
    assert no_row == {"value": {2023: None, 2024: 12.5}, "computed": [], "null_reason": {2023: NO_POPULATION}}


def test_country_missing_gdp():
    result = country_ratio({2024: None}, {2024: 100}, {2024: None}, "per_gdp", Y2024)
    assert result["null_reason"] == {2024: NO_GDP}
    assert country_ratio(None, {2024: 100}, None, "per_gdp", Y2024)["null_reason"] == {2024: NO_GDP}


def test_country_missing_applications():
    assert country_ratio({2024: None}, {2024: None}, {2024: 2e6}, "per_million", Y2024)["null_reason"] == {
        2024: NO_APPLICATIONS}
    assert country_ratio(None, {}, {2024: 2e6}, "per_million", Y2024)["null_reason"] == {2024: NO_APPLICATIONS}


def test_country_reason_order_threshold_then_denominator_then_numerator():
    assert country_ratio(None, {2024: None}, {2024: 500_000.0}, "per_million", Y2024)["null_reason"] == {
        2024: BELOW_THRESHOLD}
    assert country_ratio(None, {2024: None}, {2024: None}, "per_million", Y2024)["null_reason"] == {
        2024: NO_POPULATION}


def test_country_every_year_listed():
    result = country_ratio({2022: 10.0, 2023: None}, {2023: 100, 2024: 300}, {2023: 2e6, 2024: 3e6},
                           "per_million", range(2022, 2025))
    assert result == {"value": {2022: 10.0, 2023: 50.0, 2024: 100.0}, "computed": [2023, 2024],
                      "null_reason": {}}


# PCT per million (M7): no WIPO value, WIPO's per-million population threshold by analogy

def test_country_pct_per_million_threshold():
    below = country_ratio(None, {2024: 50}, {2024: 1_000_000.0}, "pct_per_million", Y2024)
    assert below == {"value": {2024: None}, "computed": [], "null_reason": {2024: BELOW_THRESHOLD}}
    above = country_ratio(None, {2024: 50}, {2024: 1_000_001.0}, "pct_per_million", Y2024)
    assert above == {"value": {2024: 50.0}, "computed": [2024], "null_reason": {}}


def test_world_pct_per_million():
    assert world_pct_per_million({2024: 273900}, {2024: 8.1e9}) == {2024: 33.8}
    assert world_pct_per_million({2022: None, 2023: 270000, 2024: 273900}, {2022: 8.0e9, 2023: None}) == {
        2022: None, 2023: None, 2024: None}


def test_world_ratio_as_published():
    assert world_ratio({2024: 450.1, 2023: None}) == {2024: 450.1, 2023: None}


# group

def group(ratio_id="per_million", years=Y2024, floor=None, **members):
    """members: code=(numerator, denominator) for every year in `years`."""
    numerators = {code: {year: pair[0] for year in years} for code, pair in members.items()}
    denominator = {code: {year: pair[1] for year in years} for code, pair in members.items()}
    return group_ratio(numerators, denominator, list(members), ratio_id, years, floor or {})


def test_group_sum_over_members_with_both_values():
    result = group(A=(100, 2e6), B=(50, None), C=(None, 1e6))
    assert result == {"value": {2024: 50.0}, "reporting": {2024: 1}, "members": 3, "null_reason": {}}


def test_group_member_with_zero_denominator_not_reporting():
    result = group(A=(100, 2e6), B=(50, 0.0))
    assert result == {"value": {2024: 50.0}, "reporting": {2024: 1}, "members": 2, "null_reason": {}}
    only_zero = group(B=(50, 0.0))
    assert only_zero == {"value": {2024: None}, "reporting": {2024: 0}, "members": 1,
                         "null_reason": {2024: groups.NONE_REPORTED}}


def test_group_none_reported():
    result = group(A=(None, 2e6), B=(50, None))
    assert result == {"value": {2024: None}, "reporting": {2024: 0}, "members": 2,
                      "null_reason": {2024: groups.NONE_REPORTED}}


def test_group_floor_nulls_year_fail_closed():
    years = range(1992, 1995)
    result = group(years=years, floor={1992: groups.ATTRIBUTION_FLOOR, 1993: groups.NO_WIPO_WORLD_TOTAL},
                   A=(100, 2e6))
    assert result["value"] == {1992: None, 1993: None, 1994: 50.0}
    assert result["null_reason"] == {1992: "attribution_floor", 1993: "no_wipo_world_total"}
    assert result["reporting"] == {1992: 1, 1993: 1, 1994: 1}


def test_group_floor_reason_wins_over_none_reported():
    result = group(floor={2024: groups.ATTRIBUTION_FLOOR}, A=(None, 2e6))
    assert result["null_reason"] == {2024: groups.ATTRIBUTION_FLOOR}


def test_group_below_threshold_member_counts():
    result = group(A=(100, 2e6), D=(10, 500_000.0))
    assert result["value"] == {2024: 44.0}
    assert result["reporting"] == {2024: 2}


def test_group_total_at_or_below_threshold_null():
    """Ruling (Task 3a review): summed denominator <= WIPO's threshold -> null below_wipo_threshold (Micronesia,
    Polynesia); reporting still counted. PCT per million: population threshold by analogy."""
    for ratio_id in ("per_million", "pct_per_million"):
        at = group(ratio_id, A=(10, 400_000.0), B=(5, 600_000.0))  # 1 M exactly
        assert at == {"value": {2024: None}, "reporting": {2024: 2}, "members": 2,
                      "null_reason": {2024: scale.BELOW_THRESHOLD}}
        above = group(ratio_id, A=(10, 400_000.0), B=(5, 600_001.0))
        assert above["value"] == {2024: 15.0} and above["null_reason"] == {}
    at_gdp = group("per_gdp", A=(10, 4e9), B=(5, 6e9))  # 10 bn exactly
    assert at_gdp["value"] == {2024: None} and at_gdp["null_reason"] == {2024: scale.BELOW_THRESHOLD}
    assert group("per_gdp", A=(10, 4e9), B=(5, 6.1e9))["value"] == {2024: 148.5}


def test_group_floor_and_none_reported_win_over_threshold():
    assert group(floor={2024: groups.ATTRIBUTION_FLOOR}, A=(10, 400_000.0))["null_reason"] == {
        2024: groups.ATTRIBUTION_FLOOR}
    assert group(A=(None, 400_000.0))["null_reason"] == {2024: groups.NONE_REPORTED}


def test_group_per_gdp_scale():
    result = group("per_gdp", A=(100, 1e12), B=(50, 1e12))
    assert result["value"] == {2024: 7.5}


def test_group_pct_per_million():
    result = group("pct_per_million", A=(30, 2e6), B=(None, 1e6))
    assert result == {"value": {2024: 15.0}, "reporting": {2024: 1}, "members": 2, "null_reason": {}}


def test_group_member_without_rows_and_non_members_ignored():
    numerators = {"A": {2024: 100}, "X": {2024: 900}}
    denominator = {"A": {2024: 2e6}, "X": {2024: 1e6}}
    result = group_ratio(numerators, denominator, ["A", "SU"], "per_million", Y2024, {})
    assert result == {"value": {2024: 50.0}, "reporting": {2024: 1}, "members": 2, "null_reason": {}}


# cross-check

RATIO_DEF = {ratio_def.id: ratio_def for ratio_def in RATIO_SERIES}
CODES = ["AT", "BE", "BR", "CA", "CN", "DE", "DK", "ES", "FI", "FR",
         "GB", "IN", "IT", "JP", "KR", "MX", "NL", "NO", "PL", "SE"]


def ratio_data(ratio_id, values):
    return RatioData(ratio=RATIO_DEF[ratio_id], first_year=2024, last_year=2024, values=values,
                     labels={code: code for code in values}, api_label=RATIO_DEF[ratio_id].label, absent_rows=0)


def denominator(indicator, values, world):
    return Denominator(indicator=indicator, name=indicator, values=values, world=world, last_updated=None)


MATCHING_WORLD = {"per_million": (1000.0, 1e7), "per_gdp": (6.3, 1.6e14)}  # with office_wd 10000


def check(cells=None, world=None, office_wd=10000):
    """cells: ratio_id -> code -> (wipo, resident, denominator), year 2024; world: ratio_id -> (wipo, wdi world),
    default rows that match office_wd; world={} = no WD row at all.
    Countries share one resident count across ratios, so each test uses distinct codes per ratio."""
    cells = cells or {}
    world = MATCHING_WORLD if world is None else world
    wipo, resident = {}, {}
    denominators = {"population": {}, "gdp_ppp": {}}
    world_denominators = {"population": {2024: 8e9}, "gdp_ppp": {2024: 1.6e14}}
    for ratio_id in WIPO_RATIO_IDS:
        values = {code: {2024: cell[0]} for code, cell in cells.get(ratio_id, {}).items()}
        for code, cell in cells.get(ratio_id, {}).items():
            resident[code] = {2024: cell[1]}
            if cell[2] is not None:
                denominators[RATIO_DENOMINATOR[ratio_id]][code] = {2024: cell[2]}
        if ratio_id in world:
            values["WD"] = {2024: world[ratio_id][0]}
            world_denominators[RATIO_DENOMINATOR[ratio_id]] = {2024: world[ratio_id][1]}
        wipo[ratio_id] = ratio_data(ratio_id, values)
    denominator_rows = {key: denominator(key, denominators[key], world_denominators[key])
                        for key in denominators}
    return ratio_crosscheck(wipo, resident, {2024: office_wd}, denominator_rows)


def exact_cells(codes):
    """Cells whose computed value equals WIPO's: 1000 residents / 1e7 people = 100.0 per million."""
    return {code: (100.0, 1000, 1e7) for code in codes}


def gdp_cells(codes):
    """1000 residents / 1e12 GDP x 1e11 = 100.0 per $100bn."""
    return {code: (100.0, 1000, 1e12) for code in codes}


def test_crosscheck_tolerance_boundary():
    passing = check({"per_million": {"CH": (1000.0, 10050, 1e7)}})
    assert passing.failing == {"per_million": [], "per_gdp": []}
    boundary = check({"per_million": {"CH": (1000.0, 1005050, 1e9)}})  # |1005.05 - 1000| = 0.05 + 0.005 x 1000
    assert boundary.failing["per_million"] == []
    failing = check({"per_million": {"CH": (1000.0, 10051, 1e7)}})
    assert failing.failing["per_million"] == ["per_million CH 2024: WIPO 1000.0, computed 1005.1 (+0.51%)"]
    assert failing.compared == {"per_million": 1, "per_gdp": 0}


def test_crosscheck_failing_line_and_by_country():
    result = check({"per_gdp": {"CH": (1505.6, 14502, 1e12)}})
    assert result.failing["per_gdp"] == ["per_gdp CH 2024: WIPO 1505.6, computed 1450.2 (-3.68%)"]
    assert result.by_country["per_gdp"]["CH"] == {"failing": 1, "max_pct": 3.7, "median_factor": 0.9632}


def test_crosscheck_by_country_lists_passing_drift():
    result = check({"per_million": {"CH": (1000.0, 10049, 1e7), "DE": (100.0, 1000, 1e7)}})
    assert result.by_country["per_million"] == {"CH": {"failing": 0, "max_pct": 0.5, "median_factor": 1.0049},
                                                "DE": {"failing": 0, "max_pct": 0.0, "median_factor": 1.0}}


def test_crosscheck_one_failing_of_ten_does_not_block():
    cells = exact_cells(CODES[:9])
    cells["SE"] = (100.0, 1100, 1e7)
    result = check({"per_million": cells})
    assert result.compared["per_million"] == 10
    assert len(result.failing["per_million"]) == 1
    assert result.blocking == []


def test_crosscheck_per_million_two_failing_of_ten_blocks_that_ratio_only():
    """per_million blocking test = cell share (unchanged by the per_gdp ruling, Task 3a fix2)."""
    assert RATIO_BLOCKING_TEST["per_million"] == "cell_share"
    cells = exact_cells(CODES[:8])
    cells["SE"] = (100.0, 1100, 1e7)
    cells["NO"] = (100.0, 900, 1e7)
    result = check({"per_million": cells, "per_gdp": gdp_cells(CODES[8:16])})
    assert result.blocking == ["per_million: 2 of 10 compared cells outside tolerance (20.0%), above the limit 10.0%"]
    assert result.warnings == {"per_million": [], "per_gdp": []}  # 2 of 10 countries at exactly 10%: not beyond


def test_crosscheck_fail_limit_never_pooled():
    population = {f"P{index}": (100.0, 1000, 1e7) for index in range(8)}
    population["P8"] = (100.0, 1100, 1e7)
    population["P9"] = (100.0, 900, 1e7)
    gdp = {f"G{index:02d}": (100.0, 1000, 1e12) for index in range(20)}
    result = check({"per_million": population, "per_gdp": gdp})
    assert result.compared == {"per_million": 10, "per_gdp": 20}  # pooled 2 of 30 = 6.7% would pass
    assert result.failing["per_gdp"] == []
    assert result.blocking == ["per_million: 2 of 10 compared cells outside tolerance (20.0%), above the limit 10.0%"]


def gdp_factor_cells(count, factor_codes, wipo):
    """per_gdp cells over `count` countries G00..; ours = 100.0 (1000 / 1e12 x 1e11); codes in `factor_codes` have
    WIPO = `wipo` (a constant factor, as a WDI GDP vintage gives), the rest WIPO 100.0."""
    return {f"G{index:02d}": (wipo if f"G{index:02d}" in factor_codes else 100.0, 1000, 1e12)
            for index in range(count)}


def test_crosscheck_per_gdp_vintage_factor_warns_only():
    """Ruling Task 3b dry run: a constant 3% factor on many countries = WDI GDP vintage; cells fail but no block."""
    assert RATIO_BLOCKING_TEST["per_gdp"] == "country_factor"
    off = {f"G{index:02d}" for index in range(5)}  # 5 of 20 cells fail: 25% > RATIO_FAIL_SHARE_MAX
    result = check({"per_gdp": gdp_factor_cells(20, off, 103.0)})  # ours / WIPO = 100 / 103
    assert len(result.failing["per_gdp"]) == 5
    assert result.blocking == []
    assert result.warnings["per_gdp"] == [
        "per_gdp: 5 of 20 compared cells outside tolerance (25.0%), above the limit 10.0%"]
    assert result.vintage_factors["per_gdp"] == [{"code": code, "median_factor": 0.9709} for code in sorted(off)]
    assert result.by_country["per_gdp"]["G00"]["median_factor"] == 0.9709
    assert result.vintage_factors["per_million"] == []


def test_crosscheck_per_gdp_large_factor_on_many_countries_blocks():
    """Beyond RATIO_COUNTRY_FACTOR_MAX on more than RATIO_COUNTRY_SHARE_MAX of countries: unit/indicator error."""
    assert (RATIO_COUNTRY_FACTOR_MAX, RATIO_COUNTRY_SHARE_MAX) == (0.10, 0.05)
    result = check({"per_gdp": gdp_factor_cells(20, {"G03", "G07"}, 115.0)})  # 2 of 20 = 10% > 5%; factor 0.8696
    assert result.blocking == [
        "per_gdp: 2 of 20 countries with a median ours/WIPO factor off by more than 10.0% (10.0%), above the limit "
        "5.0%: G03 0.8696, G07 0.8696"]
    one = check({"per_gdp": gdp_factor_cells(20, {"G03"}, 115.0)})  # 1 of 20 = 5%: not above the limit
    assert one.blocking == [] and one.warnings["per_gdp"] == []


def test_crosscheck_per_gdp_world_row_still_blocks():
    result = check(world={**MATCHING_WORLD, "per_gdp": (7.5, 1.6e14)})  # ours 10000 / 1.6e14 x 1e11 = 6.25
    assert result.blocking == ["per_gdp world row outside tolerance (1 years)"]


def test_crosscheck_median_factor_skips_wipo_zero_cells():
    wipo = {"per_million": ratio_data("per_million", {"VA": {2022: 0.0, 2023: 0.0, 2024: 100.0}}),
            "per_gdp": ratio_data("per_gdp", {})}
    resident = {"VA": {2022: 2, 2023: 3, 2024: 1010}}
    denominators = {"population": denominator("population", {"VA": dict.fromkeys((2022, 2023, 2024), 1e7)},
                                              {2024: 8e9}),
                    "gdp_ppp": denominator("gdp_ppp", {}, {2024: 1.6e14})}
    result = ratio_crosscheck(wipo, resident, {2024: 10000}, denominators)
    assert result.compared["per_million"] == 3
    assert result.by_country["per_million"]["VA"]["median_factor"] == 1.01  # 101.0 / 100.0 only
    assert result.vintage_factors["per_million"] == [{"code": "VA", "median_factor": 1.01}]


def test_crosscheck_world_off_by_one_percent_blocks():
    result = check(world={**MATCHING_WORLD, "per_million": (1000.0, 1e7)}, office_wd=10100)
    assert result.world_failing == {"per_million": ["per_million WD 2024: WIPO 1000.0, computed 1010.0 (+1.00%)"],
                                    "per_gdp": []}
    assert result.blocking == ["per_million world row outside tolerance (1 years)"]
    assert result.compared == {"per_million": 0, "per_gdp": 0}  # WD checked apart from the country share
    assert "WD" not in result.by_country["per_million"]


def test_crosscheck_world_within_tolerance():
    result = check()
    assert result.world_failing == {"per_million": [], "per_gdp": []}
    assert result.world_compared == {"per_million": 1, "per_gdp": 1}
    assert result.blocking == []


def test_crosscheck_world_counts_failing_years():
    wipo = {"per_million": ratio_data("per_million", {"WD": {2023: 1000.0, 2024: 1000.0}}),
            "per_gdp": ratio_data("per_gdp", {"WD": {2023: 9.0, 2024: 11.0}})}
    denominators = {"population": denominator("population", {}, {2023: 1e7, 2024: 1e7}),
                    "gdp_ppp": denominator("gdp_ppp", {}, {2023: 1e14, 2024: 1e14})}
    result = ratio_crosscheck(wipo, {}, {2023: 9000, 2024: 11000}, denominators)
    assert result.world_failing == {"per_million": ["per_million WD 2023: WIPO 1000.0, computed 900.0 (-10.00%)",
                                                    "per_million WD 2024: WIPO 1000.0, computed 1100.0 (+10.00%)"],
                                    "per_gdp": []}
    assert result.world_compared == {"per_million": 2, "per_gdp": 2}
    assert result.blocking == ["per_million world row outside tolerance (2 years)"]


def test_crosscheck_world_row_missing_blocks_both_ratios():
    result = check(world={})
    assert result.world_compared == {"per_million": 0, "per_gdp": 0}
    assert result.blocking == ["per_million world row not compared", "per_gdp world row not compared"]


def test_crosscheck_world_row_without_inputs_blocks_that_ratio():
    wipo = {"per_million": ratio_data("per_million", {"WD": {2024: 1000.0}}),
            "per_gdp": ratio_data("per_gdp", {"WD": {2024: 6.3}})}
    denominators = {"population": denominator("population", {}, {2024: 1e7}),
                    "gdp_ppp": denominator("gdp_ppp", {}, {})}  # no WDI world GDP
    result = ratio_crosscheck(wipo, {}, {2024: 10000}, denominators)
    assert result.world_compared == {"per_million": 1, "per_gdp": 0}
    assert result.blocking == ["per_gdp world row not compared"]
    wrong_office = ratio_crosscheck(wipo, {}, {}, denominators)  # office WD resident dict empty (wrong wiring)
    assert wrong_office.blocking == ["per_million world row not compared", "per_gdp world row not compared"]


def test_crosscheck_skips_codes_without_inputs():
    result = check({"per_million": {"SU": (500.0, 1000, None), "DE": (100.0, None, 1e7), "FR": (None, 1000, 1e7),
                                    "IT": (100.0, 1000, 1e7)}})
    assert result.compared["per_million"] == 1
    assert list(result.by_country["per_million"]) == ["IT"]


def test_crosscheck_wipo_zero_cell():
    result = check({"per_million": {"VA": (0.0, 2, 1e7)}})
    assert result.failing["per_million"] == ["per_million VA 2024: WIPO 0.0, computed 0.2 (n/a)"]
    assert result.by_country["per_million"]["VA"] == {"failing": 1, "max_pct": None, "median_factor": None}


def test_crosscheck_result_type():
    result = check()
    assert isinstance(result, RatioCheck)
    assert result == RatioCheck(compared={"per_million": 0, "per_gdp": 0}, failing={"per_million": [], "per_gdp": []},
                                by_country={"per_million": {}, "per_gdp": {}},
                                world_failing={"per_million": [], "per_gdp": []},
                                world_compared={"per_million": 1, "per_gdp": 1},
                                vintage_factors={"per_million": [], "per_gdp": []},
                                warnings={"per_million": [], "per_gdp": []}, blocking=[])


# constants

def test_constants():
    assert RATIO_IDS == ("per_million", "per_gdp", "pct_per_million")
    assert RATIO_SCALE == {"per_million": 1e6, "per_gdp": 1e11, "pct_per_million": 1e6}
    assert RATIO_NUMERATOR["pct_per_million"] == ("pct_origin", "total")
    assert WIPO_THRESHOLD == {"population": 1_000_000, "gdp_ppp": 10_000_000_000}


def test_method_constants_published():
    constants = method_constants()
    assert json.loads(json.dumps(constants)) == constants  # JSON-ready: lists, string keys
    assert constants["ratio_ids"] == list(RATIO_IDS)
    assert constants["wipo_ratio_ids"] == list(WIPO_RATIO_IDS)
    assert constants["scale"] == RATIO_SCALE
    assert constants["denominator"] == RATIO_DENOMINATOR
    assert constants["ratio_from"] == RATIO_FROM
    assert constants["wipo_threshold"] == WIPO_THRESHOLD
    assert constants["numerator"]["per_gdp"] == {"series": "origin_apps", "type": "resident"}
    assert (constants["abs_tolerance"], constants["rel_tolerance"], constants["fail_share_max"],
            constants["failing_list_max"], constants["decimals"]) == (0.05, 0.005, 0.10, 50, 1)
    assert (constants["country_factor_max"], constants["country_share_max"], constants["vintage_note_min"]) == (
        RATIO_COUNTRY_FACTOR_MAX, RATIO_COUNTRY_SHARE_MAX, RATIO_VINTAGE_NOTE_MIN) == (0.10, 0.05, 0.005)
    assert constants["blocking_test"] == {"per_million": "cell_share", "per_gdp": "country_factor"}
    assert constants["wdi_max_lag"] == WDI_MAX_LAG  # methods page states how far WDI's World row may trail


# below precision (final review M2)

def test_country_fill_rounding_to_zero_is_null_below_precision():
    """Ruling M2: a computed value rounding to 0.0 with a numerator > 0 -> null BELOW_PRECISION (WIPO leaves these
    empty); WIPO's own value is never touched."""
    result = country_ratio({2024: None}, {2024: 3}, {2024: 66_666_667.0}, "per_million", Y2024)  # ET 2000: 0.045
    assert result == {"value": {2024: None}, "computed": [], "null_reason": {2024: scale.BELOW_PRECISION}}
    assert country_ratio({2024: None}, {2024: 3}, {2024: 60_000_000.0}, "per_million", Y2024)["value"] == {
        2024: 0.1}  # exact 0.05 rounds up: shown


def test_country_fill_real_zero_stays_zero():
    result = country_ratio({2024: None}, {2024: 0}, {2024: 2_000_000.0}, "per_million", Y2024)
    assert result == {"value": {2024: 0.0}, "computed": [2024], "null_reason": {}}


def test_country_wipo_zero_never_below_precision():
    assert country_ratio({2024: 0.0}, {2024: 3}, {2024: 66_666_667.0}, "per_million", Y2024)["value"] == {2024: 0.0}


def test_group_rounding_to_zero_is_null_below_precision():
    result = group(A=(3, 66_666_667.0))
    assert result == {"value": {2024: None}, "reporting": {2024: 1}, "members": 1,
                      "null_reason": {2024: scale.BELOW_PRECISION}}
    assert group(A=(0, 2e6))["value"] == {2024: 0.0}
