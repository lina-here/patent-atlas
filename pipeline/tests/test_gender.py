"""Women-inventor figures on hand-made literals: WIPO shares kept, PCT-publication-weighted group women_any with a
coverage floor, women_share never computed for groups, WIPO's printed continent figures win, cross-checks."""
import json

import pytest

from pipeline import gender, m49
from pipeline.gender import (BASIS_WIPO, GENDER_CROSSCHECK_TOLERANCE, GENDER_GROUP_COVERAGE_MIN, LOW_COVERAGE,
                             NOT_COMPUTABLE, NOT_PUBLISHED, WOMEN_ANY, WOMEN_SHARE, continent_crosscheck,
                             continent_value, country_share, group_women_any, group_women_share, load_published,
                             method_constants, world_crosscheck)
from pipeline.groups import ATTRIBUTION_FLOOR, NONE_REPORTED

YEARS = [2024, 2025]
PCT_YR_2026_URL = ("https://www.wipo.int/edocs/pubdocs/en/"
                   "wipo-pub-901-2026-en-patent-cooperation-treaty-yearly-review-2026.pdf")


def shares_of(women_any: dict, women_share: dict | None = None) -> dict:
    return {WOMEN_ANY: women_any, WOMEN_SHARE: women_share or {}}


# Countries: WIPO's value as published

def test_country_share_kept_as_published():
    result = country_share({2023: 12.5, 2024: 33.0}, [2023, 2024])
    assert result == {"value": {2023: 12.5, 2024: 33.0}, "null_reason": {}}
    assert repr(result["value"][2024]) == "33.0"  # never re-rounded or turned into an int


def test_country_share_gap_not_published():
    result = country_share({2023: 12.5, 2024: None}, [2022, 2023, 2024])
    assert result == {"value": {2022: None, 2023: 12.5, 2024: None},
                      "null_reason": {2022: NOT_PUBLISHED, 2024: NOT_PUBLISHED}}


# Groups: women_any weighted by members' PCT publications

THREE = ["AA", "BB", "CC"]
THREE_SHARES = {"AA": {2025: None}, "BB": {2025: 20.0}, "CC": {2025: 35.5}}
THREE_COUNTS = {"AA": {2025: 100}, "BB": {2025: 300}, "CC": {2025: 600}}


def test_group_weighted_mean_literal():
    """(20.0 x 300 + 35.5 x 600) / 900 = 27300 / 900 = 30.333.. -> 30.3; coverage 900 / 1000."""
    result = group_women_any(THREE, shares_of(THREE_SHARES), THREE_COUNTS, [2025], {})
    assert result == {"value": {2025: 30.3}, "null_reason": {}, "reporting": {2025: 2}, "members": 3,
                      "coverage": {2025: 0.9}, "wipo_years": []}


def test_group_rounds_half_away_once_on_exact_decimals():
    """(10.0 + 10.1) / 2 = 10.05 exactly -> 10.1 (float arithmetic would give 10.049999.. -> 10.0)."""
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 10.0}, "BB": {2025: 10.1}}),
                             {"AA": {2025: 1}, "BB": {2025: 1}}, [2025], {})
    assert result["value"] == {2025: 10.1}


def test_group_coverage_rounded_to_coverage_decimals():
    """2 / 3 = 0.6666.. -> 0.667 (and low coverage)."""
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 30.0}, "BB": {2025: None}}),
                             {"AA": {2025: 2000}, "BB": {2025: 1000}}, [2025], {})
    assert result["coverage"] == {2025: 0.667}
    assert result["null_reason"] == {2025: LOW_COVERAGE}


@pytest.mark.parametrize("with_share, without_share, value, reason, coverage", [
    (800, 200, 30.0, None, 0.8),  # exactly the floor passes (compared as Decimal)
    (799, 201, None, LOW_COVERAGE, 0.799),
])
def test_group_coverage_floor_edge(with_share, without_share, value, reason, coverage):
    assert GENDER_GROUP_COVERAGE_MIN == 0.8
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 30.0}, "BB": {2025: None}}),
                             {"AA": {2025: with_share}, "BB": {2025: without_share}}, [2025], {})
    assert result["value"] == {2025: value}
    assert result["null_reason"] == ({} if reason is None else {2025: reason})
    assert result["coverage"] == {2025: coverage}
    assert result["reporting"] == {2025: 1}


def test_group_coverage_decision_uses_the_published_rounded_value():
    """7996 / 10000 = 0.7996 -> published 0.8, so the group passes: the shown coverage never contradicts low_coverage."""
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 30.0}, "BB": {2025: None}}),
                             {"AA": {2025: 7996}, "BB": {2025: 2004}}, [2025], {})
    assert result["coverage"] == {2025: 0.8}
    assert result["value"] == {2025: 30.0} and result["null_reason"] == {}


def test_group_count_sum_zero_none_reported():
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 30.0}, "BB": {2025: 40.0}}),
                             {"AA": {2025: 0}, "BB": {2025: 0}}, [2025], {})
    assert result["value"] == {2025: None}
    assert result["null_reason"] == {2025: NONE_REPORTED}
    assert result["reporting"] == {2025: 2} and result["coverage"] == {2025: None}


def test_group_no_member_reporting_none_reported():
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: None}}), {"AA": {2025: 100}, "BB": {2025: 50}},
                             [2025], {})
    assert result["value"] == {2025: None}
    assert result["null_reason"] == {2025: NONE_REPORTED}
    assert result["reporting"] == {2025: 0} and result["coverage"] == {2025: 0.0}


def test_group_floor_reason_wins():
    """A floor year is null with the floor's reason, even with full coverage; other years computed."""
    shares = {"AA": {2024: 30.0, 2025: 30.0}}
    counts = {"AA": {2024: 100, 2025: 100}}
    result = group_women_any(["AA"], shares_of(shares), counts, YEARS, {2024: ATTRIBUTION_FLOOR})
    assert result["value"] == {2024: None, 2025: 30.0}
    assert result["null_reason"] == {2024: ATTRIBUTION_FLOOR}
    assert result["reporting"] == {2024: 1, 2025: 1} and result["coverage"] == {2024: 1.0, 2025: 1.0}


def test_group_reads_women_any_only():
    """1042 values given alongside never change the result: a group value never mixes 1040 and 1042."""
    alone = group_women_any(THREE, shares_of(THREE_SHARES), THREE_COUNTS, [2025], {})
    women_share = {"AA": {2025: 99.9}, "BB": {2025: 1.0}, "CC": {2025: 2.0}}
    both = group_women_any(THREE, shares_of(THREE_SHARES, women_share), THREE_COUNTS, [2025], {})
    assert both == alone


def test_group_weights_from_members_not_wipo_region_row():
    """Continent = WIPO region R1: R1's own count (1010 has R rows) is never a weight nor in the coverage base."""
    shares = {"NG": {2025: 20.0}, "KE": {2025: 30.0}, "R1": {2025: 90.0}}
    counts = {"NG": {2025: 10}, "KE": {2025: 30}, "R1": {2025: 100000}}
    result = group_women_any(["NG", "KE"], shares_of(shares), counts, [2025], {})
    assert result["value"] == {2025: 27.5}  # (200 + 900) / 40
    assert result["coverage"] == {2025: 1.0} and result["members"] == 2


def test_group_member_without_count_not_in_coverage_base():
    result = group_women_any(["AA", "BB"], shares_of({"AA": {2025: 30.0}, "BB": {2025: 50.0}}),
                             {"AA": {2025: 100}}, [2025], {})
    assert result["value"] == {2025: 30.0}
    assert result["reporting"] == {2025: 1} and result["coverage"] == {2025: 1.0}


def test_group_women_share_not_computable_every_year():
    result = group_women_share(THREE, YEARS)
    assert result == {"value": {2024: None, 2025: None},
                      "null_reason": {2024: NOT_COMPUTABLE, 2025: NOT_COMPUTABLE},
                      "reporting": {2024: None, 2025: None}, "members": 3,  # not computed: no reporting count (final I1)
                      "coverage": {2024: None, 2025: None}, "wipo_years": []}


# Continents: WIPO's printed figures win (ruling C1)

PRINTED = {
    "source": {"citation": "c", "url": "u"},
    WOMEN_ANY: {"africa": {2025: {"value": 31.0, "figure": "F", "page": "p"}}},
    WOMEN_SHARE: {"africa": {2025: {"value": 18.1, "figure": "A24", "page": "p. 9 (PDF p. 10)"}}},
}


def computed_africa() -> dict:
    shares = {"NG": {2024: 20.0, 2025: 30.0}, "KE": {2024: 30.0, 2025: 30.6}}
    counts = {"NG": {2024: 10, 2025: 10}, "KE": {2024: 30, 2025: 0}}
    return group_women_any(["NG", "KE"], shares_of(shares), counts, YEARS, {})


def test_continent_printed_year_wins_over_computed():
    computed = computed_africa()
    assert computed["value"] == {2024: 27.5, 2025: 30.0}
    result = continent_value(WOMEN_ANY, "africa", computed, PRINTED)
    assert result["value"] == {2024: 27.5, 2025: 31.0}
    assert result["wipo_years"] == [2025]
    assert result["null_reason"] == {}
    assert computed["value"][2025] == 30.0  # input untouched
    assert computed["reporting"] == {2024: 2, 2025: 2} and computed["coverage"] == {2024: 1.0, 2025: 1.0}
    assert BASIS_WIPO == "wipo"


def test_continent_printed_year_has_no_reporting_or_coverage():
    """No "n of m reporting" or coverage beside WIPO's figure; the computed years keep theirs."""
    result = continent_value(WOMEN_ANY, "africa", computed_africa(), PRINTED)
    assert result["reporting"] == {2024: 2, 2025: None}
    assert result["coverage"] == {2024: 1.0, 2025: None}
    share = continent_value(WOMEN_SHARE, "africa", group_women_share(["NG", "KE"], YEARS), PRINTED)
    assert share["reporting"] == {2024: None, 2025: None} and share["coverage"] == {2024: None, 2025: None}


def test_continent_printed_women_share_replaces_not_computable_that_year_only():
    result = continent_value(WOMEN_SHARE, "africa", group_women_share(["NG", "KE"], YEARS), PRINTED)
    assert result["value"] == {2024: None, 2025: 18.1}
    assert result["null_reason"] == {2024: NOT_COMPUTABLE}
    assert result["wipo_years"] == [2025]


def test_continent_without_printed_figure_unchanged():
    computed = computed_africa()
    assert continent_value(WOMEN_ANY, "europe", computed, PRINTED) == computed
    later = continent_value(WOMEN_SHARE, "africa", group_women_share(["NG"], [2024]), PRINTED)
    assert later["wipo_years"] == [] and later["value"] == {2024: None}  # printed year outside the years: unused


def test_continent_printed_replaces_a_null_computed_year():
    shares = {"NG": {2025: 30.0}, "KE": {2025: None}}
    counts = {"NG": {2025: 10}, "KE": {2025: 90}}
    computed = group_women_any(["NG", "KE"], shares_of(shares), counts, [2025], {})
    assert computed["null_reason"] == {2025: LOW_COVERAGE}
    result = continent_value(WOMEN_ANY, "africa", computed, PRINTED)
    assert result["value"] == {2025: 31.0} and result["null_reason"] == {}


def crosscheck_africa(share_2025: float, count_2025: int = 10) -> list[str]:
    """One member NG, so the unrounded weighted mean = share_2025; continent_crosscheck vs printed women_any 31.0."""
    shares, counts = {"NG": {2025: share_2025}}, {"NG": {2025: count_2025}}
    computed = group_women_any(["NG"], shares_of(shares), counts, [2025], {})
    return continent_crosscheck("africa", computed, ["NG"], shares, counts, PRINTED)


@pytest.mark.parametrize("share, flagged", [(30.5, False), (31.5, False), (30.4, True), (31.6, True)])
def test_continent_crosscheck_tolerance_edge(share, flagged):
    """Weighted women_any vs WIPO's printed 31.0: a gap of exactly the tolerance passes, both signs."""
    assert GENDER_CROSSCHECK_TOLERANCE == 0.5
    lines = crosscheck_africa(share)
    assert len(lines) == (1 if flagged else 0)
    if flagged:
        assert "africa 2025" in lines[0] and "vs WIPO 31.0" in lines[0] and str(share) in lines[0]


def test_continent_crosscheck_uses_the_unrounded_mean():
    """31.54 rounds to 31.5 (gap 0.5, passes) but the unrounded gap is 0.54 pp: flagged, and the line shows 0.54."""
    lines = crosscheck_africa(31.54)
    assert len(lines) == 1 and "gap +0.54 pp" in lines[0] and "31.54" in lines[0]
    assert crosscheck_africa(30.46)[0].count("-0.54") == 1


def test_continent_crosscheck_skips_null_computed():
    shares, counts = {"NG": {2025: 30.0}, "KE": {2025: None}}, {"NG": {2025: 10}, "KE": {2025: 90}}
    computed = group_women_any(["NG", "KE"], shares_of(shares), counts, [2025], {})
    assert computed["value"] == {2025: None}  # low coverage
    assert continent_crosscheck("africa", computed, ["NG", "KE"], shares, counts, PRINTED) == []
    assert continent_crosscheck("europe", computed_africa(), ["NG"], {}, {}, PRINTED) == []


# World cross-check: weighted country women_any vs WIPO's World row (ZZ)

CHECK_SHARES = {"AA": {2024: 30.0, 2025: 30.0}, "BB": {2024: 40.0, 2025: 40.0}}
CHECK_COUNTS = {"AA": {2024: 100, 2025: 100}, "BB": {2024: 100, 2025: 100}}  # weighted mean 35.0 each year


@pytest.mark.parametrize("zz, flagged", [(35.5, False), (34.5, False), (35.6, True), (34.4, True)])
def test_world_crosscheck_tolerance_edge(zz, flagged):
    result = world_crosscheck(CHECK_SHARES, CHECK_COUNTS, {2024: 35.0, 2025: zz}, YEARS)
    assert result["compared"] == 2
    assert result["gap_years"] == ([2025] if flagged else [])
    assert len(result["lines"]) == (1 if flagged else 0)
    assert result["max_gap_pp"] == round(abs(35.0 - zz), 2)
    if flagged:
        assert "2025" in result["lines"][0] and str(zz) in result["lines"][0]


def test_world_crosscheck_unrounded_mean_and_skips():
    """Mean (30.0 x 1 + 30.1 x 2) / 3 = 30.0666..; ZZ 30.0 -> gap 0.0666.. -> 0.07. 2024 no ZZ value: not compared;
    CC (count, no share) not in the mean."""
    shares = {"AA": {2024: 30.0, 2025: 30.0}, "BB": {2024: 30.1, 2025: 30.1}, "CC": {2025: None}}
    counts = {"AA": {2024: 1, 2025: 1}, "BB": {2024: 2, 2025: 2}, "CC": {2025: 5000}}
    result = world_crosscheck(shares, counts, {2024: None, 2025: 30.0}, YEARS)
    assert result == {"compared": 1, "max_gap_pp": 0.07, "gap_years": [], "lines": []}


def test_world_crosscheck_nothing_compared():
    result = world_crosscheck({}, {}, {2025: 38.1}, [2025])
    assert result == {"compared": 0, "max_gap_pp": None, "gap_years": [], "lines": []}


# Constants and the hand-entered file

def test_method_constants_keys():
    constants = method_constants()
    assert set(constants) == {"decimals", "coverage_decimals", "group_coverage_min", "crosscheck_tolerance_pp",
                              "first_year", "method_note"}
    assert constants["decimals"] == gender.GENDER_DECIMALS == 1
    assert constants["coverage_decimals"] == gender.GENDER_COVERAGE_DECIMALS == 3
    assert constants["group_coverage_min"] == GENDER_GROUP_COVERAGE_MIN
    assert constants["crosscheck_tolerance_pp"] == GENDER_CROSSCHECK_TOLERANCE
    assert set(constants["method_note"]) == {"citation", "url", "page"}
    assert constants["method_note"]["url"] == PCT_YR_2026_URL
    assert constants["method_note"]["page"].startswith("p. 28 (PDF p. 29), figure A22 note")
    json.dumps(constants, allow_nan=False)


def test_published_file_continent_figures_each_carry_a_page():
    """PCT Yearly Review 2026 p. 9 (PDF p. 10) text citing figure A24: the six WIPO regions, 2025, women_share.
    Values typed from the PDF text; WIPO prints no women_any by region."""
    published = load_published()
    assert published["source"]["url"] == PCT_YR_2026_URL
    assert published["source"]["citation"] == gender.METHOD_NOTE["citation"]
    assert published[WOMEN_ANY] == {}
    values = {slug: {year: entry["value"] for year, entry in years.items()}
              for slug, years in published[WOMEN_SHARE].items()}
    assert values == {"latin-america-caribbean": {2025: 24.5}, "asia": {2025: 18.8}, "northern-america": {2025: 18.2},
                      "africa": {2025: 18.1}, "oceania": {2025: 16.7}, "europe": {2025: 16.3}}
    assert set(values) == set(m49.CONTINENTS)
    for years in published[WOMEN_SHARE].values():
        for entry in years.values():
            assert entry["figure"] == "A24"
            assert entry["page"].startswith("p. 9 (PDF p. 10)")


@pytest.mark.parametrize("change", [
    lambda data: data[WOMEN_SHARE]["asia"]["2025"].pop("page"),
    lambda data: data[WOMEN_SHARE]["asia"]["2025"].update(figure=""),
    lambda data: data[WOMEN_SHARE]["asia"]["2025"].update(value=100.5),
    lambda data: data[WOMEN_SHARE].update(atlantis={"2025": {"value": 1.0, "figure": "A24", "page": "p"}}),
    lambda data: data.update(women_any_by_field={}),
    lambda data: data["source"].pop("url"),
    lambda data: data.update(women_share=[]),
    lambda data: data.update(women_any="asia"),
    lambda data: data[WOMEN_SHARE].update(asia=[1.0]),
    lambda data: data[WOMEN_SHARE].update(asia="18.8"),
])
def test_load_published_rejects_bad_entry(tmp_path, change):
    data = json.loads(gender.GENDER_PUBLISHED_PATH.read_text(encoding="utf-8"))
    change(data)
    path = tmp_path / "gender_published.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="gender_published"):
        load_published(path)
