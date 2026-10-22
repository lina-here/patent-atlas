import json

import pytest

from pipeline.derive import cagr, ranks, resident_share, share, world_last_year, world_sum, yoy_growth


def test_yoy_basic():
    assert yoy_growth({2020: 100, 2021: 110}) == {2021: 10.0}


def test_yoy_negative_and_rounding():
    assert yoy_growth({2020: 3, 2021: 2}) == {2021: -33.3}
    assert yoy_growth({2020: 400, 2021: 429}) == {2021: 7.3}  # 7.25 exactly -> half up
    assert yoy_growth({2020: 400, 2021: 371}) == {2021: -7.3}  # -7.25 exactly -> away from zero


def test_growth_zero_base():
    assert yoy_growth({2020: 0, 2021: 5}) == {2021: None}
    assert cagr({2010: 0, 2020: 5}, 2020) is None


def test_yoy_null_either_year():
    result = yoy_growth({2019: 10, 2020: None, 2021: 5})
    assert result == {2020: None, 2021: None}
    assert "NaN" not in json.dumps(result) and "Infinity" not in json.dumps(result)


def test_yoy_gap_year_is_none():
    assert yoy_growth({2018: 10, 2020: 20, 2021: 40}) == {2020: None, 2021: 100.0}


def test_no_negative_zero():
    tiny_drop = {2020: 100000, 2021: 99999}  # -0.001% rounds to zero
    assert json.dumps(yoy_growth(tiny_drop)) == '{"2021": 0.0}'
    assert json.dumps(cagr({2010: 100000, 2020: 99999}, 2020)) == "0.0"
    assert json.dumps(share(0, -5)) == "0.0"


def test_cagr_basic():
    assert cagr({2010: 100, 2020: 200}, 2020) == 7.2
    assert cagr({2015: 100, 2020: 100}, 2020, years=5) == 0.0
    assert cagr({2010: 200, 2020: 100}, 2020) == -6.7


def test_cagr_null_base():
    assert cagr({2010: None, 2020: 200}, 2020) is None
    assert cagr({2020: 200}, 2020) is None  # base year absent
    assert cagr({2010: 100, 2020: None}, 2020) is None


def test_cagr_rejects_nonpositive_years():
    with pytest.raises(ValueError):
        cagr({2020: 1}, 2020, years=0)


def test_world_sum_skips_null_and_excluded():
    by_entity = {
        "CH": {2020: 10, 2021: None},
        "US": {2020: 20, 2021: 30},
        "EP": {2020: 1000, 2021: 1000},
        "XX": {2020: None, 2021: None},
    }
    totals, coverage = world_sum(by_entity, lambda code: code != "EP")
    assert totals == {2020: 30, 2021: 30}
    assert coverage == {2020: 2, 2021: 1}


def test_world_sum_zero_coverage_is_null():
    totals, coverage = world_sum({"CH": {2020: None, 2021: 5}}, lambda code: True)
    assert totals == {2020: None, 2021: 5}
    assert coverage == {2020: 0, 2021: 1}


def test_world_sum_counts_real_zero_as_reporting():
    totals, coverage = world_sum({"CH": {2020: 0}}, lambda code: True)
    assert totals == {2020: 0}
    assert coverage == {2020: 1}


def test_world_last_year_drops_low_coverage():
    assert world_last_year({2022: 100, 2023: 98, 2024: 60}) == 2023


def test_world_last_year_all_good_and_edges():
    assert world_last_year({2022: 100, 2023: 100}) == 2023
    assert world_last_year({2023: 5}) == 2023
    assert world_last_year({2022: 100, 2023: 90}) == 2023  # exactly 0.9 passes
    with pytest.raises(ValueError):
        world_last_year({})


def test_world_last_year_two_year_partial_tail():
    assert world_last_year({2021: 100, 2022: 100, 2023: 60, 2024: 58}) == 2022


def test_world_last_year_ignores_mid_history_dip():
    assert world_last_year({2003: 100, 2004: 50, 2005: 100, 2006: 100}) == 2006


def test_world_last_year_window_is_five_prior_years():
    # 200 in 2000 is outside the 5 years before 2006 (2001..2005), so 2006 passes
    coverage = {2000: 200, 2001: 100, 2002: 100, 2003: 100, 2004: 100, 2005: 100, 2006: 100}
    assert world_last_year(coverage) == 2006
    # inside the window the earlier peak counts
    assert world_last_year({2001: 200, 2002: 190, 2003: 100, 2004: 100}) == 2002
    assert world_last_year({2005: 100, 2006: 89}) == 2005


def test_ranks_ties():
    by_entity = {"A": {2020: 5}, "B": {2020: 5}, "C": {2020: 3}}
    assert ranks(by_entity, 2020, lambda code: True) == {"A": 1, "B": 1, "C": 3}


def test_ranks_skips_null_missing_excluded():
    by_entity = {
        "A": {2020: 5},
        "B": {2020: None},
        "C": {2019: 9},
        "D": {2020: 7},
        "EP": {2020: 99},
    }
    assert ranks(by_entity, 2020, lambda code: code != "EP") == {"D": 1, "A": 2}


def test_share_null():
    assert share(None, 100) is None
    assert share(5, None) is None
    assert share(5, 0) is None


def test_share_values():
    assert share(1, 3) == 33.33
    assert share(5, 100) == 5.0
    assert share(0, 100) == 0.0
    assert share(1, 8) == 12.5
    assert share(1, 16) == 6.25
    assert share(1, 32) == 3.13  # 3.125 exactly -> half up


def test_resident_share():
    assert resident_share(25, 100) == 25.0
    assert resident_share(None, 100) is None
    assert resident_share(5, 0) is None
