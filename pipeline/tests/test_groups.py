"""Group figures on hand fixtures: basis per series, null reasons, panel, unallocated band, checks."""
import pytest

import subprocess
import sys
from pathlib import Path

from pipeline import groups, m49
from pipeline.collect import SeriesData
from pipeline.groups import (ATTRIBUTION_FLOOR, NO_WIPO_REGIONAL_TOTAL, NO_WIPO_WORLD_TOTAL, NONE_REPORTED,
                             continent_share, fixed_panel, former_notes, group_series, unallocated)
from pipeline.parse import SchemaError
from pipeline.series import series_by_id

YEARS = range(2018, 2025)
R_LABELS = {"R1": "Africa", "R2": "Asia", "R3": "Europe", "R4": "Latin America and the Caribbean",
            "R5": "Northern America", "R6": "Oceania"}
LABELS = {**R_LABELS, "WD": "World", "ZZ": "Total", "**": "Unknown", "EP": "European Patent Office",
          "OA": "African Intellectual Property Organization", "AN": "Netherlands Antilles", "SU": "Soviet Union"}

# per-year constant values; office: R = member sum + regional offices (R1 has a +10 WIPO estimate)
OFFICE = {"CH": 1000, "DE": 5000, "US": 10000, "CA": 500, "CN": 20000, "JP": 8000, "NG": 100, "KE": 50,
          "BR": 300, "MX": 200, "AU": 400, "EP": 3000,
          "R1": 160, "R2": 28000, "R3": 9000, "R4": 500, "R5": 10500, "R6": 400}
OFFICE_WD = sum(OFFICE[code] for code in R_LABELS)
ORIGIN = {"CH": 2000, "DE": 6000, "US": 9000, "CA": 400, "CN": 19010, "JP": 9000, "NG": 20, "KE": 10, "BR": 200,
          "MX": 100, "AU": 300, "SU": None}
PCT = {"CH": 300, "DE": 1500, "US": 5000, "CA": 100, "CN": 6000, "JP": 4000, "NG": 1, "KE": 2, "BR": 50, "MX": 20,
       "AU": 150, "R1": 3, "R2": 10000, "R3": 1800, "R4": 70, "R5": 5100, "R6": 150, "**": 77}
PCT_ZZ = sum(PCT[code] for code in R_LABELS) + PCT["**"]


def series_data(series_id, constants):
    """SeriesData with every type of the series; `constants`: code -> value every year (or a year map)."""
    definition = series_by_id(series_id)
    values = {}
    for code, value in constants.items():
        total = dict(value) if isinstance(value, dict) else {year: value for year in YEARS}
        values[code] = {key: total if key == "total" else {year: None for year in YEARS}
                        for key in definition.type_ids}
    labels = {code: LABELS.get(code, code) for code in values}
    return SeriesData(definition, YEARS[0], YEARS[-1], values, labels, 0)


def make_data():
    return {
        "origin_apps": series_data("origin_apps", ORIGIN),
        "office_apps": series_data("office_apps", {**OFFICE, "WD": OFFICE_WD}),
        "pct_origin": series_data("pct_origin", {**PCT, "ZZ": PCT_ZZ}),
    }


def set_total(data, series_id, code, year, value):
    data[series_id].values[code]["total"][year] = value


def test_basis_per_series_and_kind():
    data = make_data()
    ctx = groups.context(data)
    assert group_series("office_apps", "europe", ctx)["basis"] == "wipo_total"
    assert group_series("pct_origin", "europe", ctx)["basis"] == "wipo_total"
    assert group_series("origin_apps", "europe", ctx)["basis"] == "member_sum"
    assert group_series("pct_origin", "155", ctx)["basis"] == "member_sum"  # regions: no WIPO row


def test_office_has_no_region_series():
    assert groups.series_of_group("155") == ("origin_apps", "pct_origin")
    assert groups.series_of_group("europe") == ("origin_apps", "office_apps", "pct_origin")
    data = make_data()
    with pytest.raises(ValueError, match="office_apps"):
        group_series("office_apps", "155", groups.context(data))


def test_wipo_total_equals_r_row_and_member_sum_is_crosscheck():
    data = make_data()
    ctx = groups.context(data)
    europe = group_series("office_apps", "europe", ctx)
    assert europe["total"] == {year: 9000 for year in YEARS}
    assert europe["member_sum"] == {year: 1000 + 5000 + 3000 for year in YEARS}  # EP assigned to Europe
    assert europe["members"] == 2 and europe["reporting"] == {year: 2 for year in YEARS}  # EP never a member
    assert europe["null_reason"] == {}
    assert "member_sum" not in group_series("origin_apps", "europe", ctx)


def test_wipo_total_kept_with_few_members_reporting():
    data = make_data()
    others = [code for code in m49.members("europe") if code not in ("CH", "DE")][:14]
    for code in others:
        data["office_apps"].values[code] = {key: {year: None for year in YEARS}
                                            for key in series_by_id("office_apps").type_ids}
    europe = group_series("office_apps", "europe", groups.context(data))
    assert (europe["members"], europe["reporting"][2024]) == (16, 2)
    assert europe["total"][2024] == 9000  # no count threshold: WIPO's value stands, "2 of 16" is information


def test_r_label_must_equal_continent_label():
    data = make_data()
    data["office_apps"].labels["R1"] = "Asia"
    with pytest.raises(SchemaError, match="R1"):
        group_series("office_apps", "africa", groups.context(data))


def test_missing_r_row_is_schema_error():
    data = make_data()
    del data["pct_origin"].values["R6"]
    with pytest.raises(SchemaError, match="R6"):
        group_series("pct_origin", "oceania", groups.context(data))


def test_null_r_year_null_total_no_member_fill():
    data = make_data()
    set_total(data, "office_apps", "R3", 2018, None)
    europe = group_series("office_apps", "europe", groups.context(data))
    assert europe["total"][2018] is None
    assert europe["null_reason"] == {2018: NO_WIPO_REGIONAL_TOTAL}
    assert europe["member_sum"][2018] == 9000  # cross-check figure only


def test_member_sum_of_non_null_members_and_none_reported():
    data = make_data()
    set_total(data, "origin_apps", "DE", 2020, None)
    set_total(data, "origin_apps", "AU", 2021, None)
    ctx = groups.context(data)
    europe = group_series("origin_apps", "europe", ctx)
    assert europe["total"][2019] == 8000 and europe["total"][2020] == 2000
    assert europe["reporting"][2020] == 1 and europe["members"] == 2
    oceania = group_series("origin_apps", "oceania", ctx)
    assert oceania["total"][2021] is None and oceania["reporting"][2021] == 0
    assert oceania["null_reason"] == {2021: NONE_REPORTED}
    set_total(data, "origin_apps", "AU", 2022, 0)  # a reported 0 is reported
    assert group_series("origin_apps", "oceania", groups.context(data))["total"][2022] == 0  # data changed


def test_attribution_floor_nulls_member_sum_groups():
    data = make_data()
    for code, value in ORIGIN.items():  # 2018: grouped sum / WD below the floor
        if value is not None:
            set_total(data, "origin_apps", code, 2018, value // 2)
    set_total(data, "office_apps", "WD", 2019, None)  # world null -> fails closed
    ctx = groups.context(data)
    for group_id in ("europe", "155", "asia", "030"):
        figures = group_series("origin_apps", group_id, ctx)
        assert figures["total"][2018] is None and figures["total"][2019] is None
        assert figures["null_reason"] == {2018: ATTRIBUTION_FLOOR, 2019: NO_WIPO_WORLD_TOTAL}
        assert figures["reporting"][2018] > 0  # coverage still published
    assert group_series("origin_apps", "europe", ctx)["total"][2020] == 8000


def test_attribution_floor_boundary_is_inclusive():
    data = make_data()
    grouped = sum(value for value in ORIGIN.values() if value is not None)
    assert groups.GROUP_ATTRIBUTION_MIN == 0.8 and grouped % 4 == 0  # fixture: grouped / 0.8 is an integer
    set_total(data, "office_apps", "WD", 2020, grouped * 5 // 4)  # ratio = min exactly: passes
    set_total(data, "office_apps", "WD", 2021, grouped * 5 // 4 + 1)  # just below
    europe = group_series("origin_apps", "europe", groups.context(data))
    assert europe["total"][2020] == 8000
    assert europe["null_reason"] == {2021: ATTRIBUTION_FLOOR}


def test_region_needs_no_r_rows():
    data = make_data()
    for code in R_LABELS:
        del data["pct_origin"].values[code]
    ctx = groups.context(data)  # lazy: no continent figure built yet
    assert group_series("pct_origin", "155", ctx)["total"][2020] == 300 + 1500  # CH + DE
    assert groups.panel("pct_origin", "155", ctx)["members"] == ["CH", "DE"]
    with pytest.raises(SchemaError, match="R3"):
        group_series("pct_origin", "europe", ctx)


def test_no_attribution_floor_for_office(monkeypatch):
    assert {series_id: groups.has_member_sum(series_id) for series_id in ("origin_apps", "office_apps",
                                                                          "pct_origin")} == {
        "origin_apps": True, "office_apps": False, "pct_origin": True}
    floors = []
    real = groups.floor_failures
    monkeypatch.setattr(groups, "floor_failures", lambda data, series_id, worlds: floors.append(series_id)
                        or real(data, series_id, worlds))
    data = make_data()
    ctx = groups.context(data)
    for series_id in ("origin_apps", "office_apps", "pct_origin"):
        continent_share(series_id, ctx)
    groups.check_warnings(ctx)
    group_series("pct_origin", "155", ctx)
    group_series("origin_apps", "155", ctx)
    assert sorted(floors) == ["origin_apps", "pct_origin"]  # each once (cached), never office
    with pytest.raises(ValueError, match="office_apps: no member_sum groups"):
        ctx.floor("office_apps")


def test_fixed_panel_keeps_members_reported_every_year():
    data = make_data()
    set_total(data, "origin_apps", "DE", 2019, None)
    assert fixed_panel(data, "origin_apps", "155", 2018, 2024) == ["CH"]
    assert fixed_panel(data, "origin_apps", "155", 2020, 2024) == ["CH", "DE"]
    panel = groups.panel("origin_apps", "155", groups.context(data))
    assert (panel["first"], panel["last"], panel["members"]) == (2018, 2024, ["CH"])  # window clamped to data
    assert panel["total"] == {year: 2000 for year in YEARS}


def test_panel_starts_after_last_floor_failure():
    data = make_data()
    for code, value in ORIGIN.items():
        if value is not None:
            set_total(data, "origin_apps", code, 2019, value // 2)
    ctx = groups.context(data)
    panel = groups.panel("origin_apps", "europe", ctx)
    assert (panel["first"], panel["last"]) == (2020, 2024)
    assert groups.panel("pct_origin", "155", ctx)["first"] == 2018  # floor is per series


def test_panel_window_is_panel_years_long():
    assert groups.PANEL_YEARS > 1
    data = make_data()
    ctx = groups.context(data)
    first, last = groups.panel_window("pct_origin", "155", ctx)
    assert last == 2024 and first == max(YEARS[0], last - groups.PANEL_YEARS + 1)
    with pytest.raises(ValueError, match="no fixed panel"):  # wipo_total: R row has no member gaps
        groups.panel("pct_origin", "europe", ctx)


def test_unallocated_per_series():
    data = make_data()
    ctx = groups.context(data)
    assert unallocated("office_apps", ctx) == {year: 0 for year in YEARS}
    assert unallocated("pct_origin", ctx) == {year: 77 for year in YEARS}
    origin_grouped = sum(value for value in ORIGIN.values() if value is not None)
    assert unallocated("origin_apps", ctx) == {year: OFFICE_WD - origin_grouped for year in YEARS}
    labels = {series_id: continent_share(series_id, ctx)["unallocated_label"]
              for series_id in ("office_apps", "pct_origin", "origin_apps")}
    assert labels == {"office_apps": "unallocated", "pct_origin": "origin unknown",
                      "origin_apps": "not attributable"}


def test_unallocated_null_when_any_continent_null():
    data = make_data()
    set_total(data, "office_apps", "R6", 2018, None)
    share = continent_share("office_apps", groups.context(data))
    assert share["unallocated"][2018] is None and share["unallocated"][2019] == 0
    assert share["continent"]["oceania"][2018] is None and share["continent"]["europe"][2018] == 9000
    assert share["null_reason"] == {2018: NO_WIPO_REGIONAL_TOTAL}


def test_continent_share_null_reason_for_floor():
    data = make_data()
    set_total(data, "office_apps", "WD", 2018, None)
    ctx = groups.context(data)
    share = continent_share("origin_apps", ctx)
    assert all(share["continent"][slug][2018] is None for slug in m49.CONTINENTS)
    assert share["unallocated"][2018] is None
    assert share["null_reason"] == {2018: NO_WIPO_WORLD_TOTAL}  # band and member_sum continents: world null
    assert continent_share("office_apps", ctx)["null_reason"] == {2018: NO_WIPO_WORLD_TOTAL}  # R rows stand


def test_provisional_wipo_world_fails_closed():
    data = make_data()
    for code in ("CH", "DE", "US", "CA", "CN", "JP", "NG", "KE", "BR"):  # office 2024: 2 of 12 -> provisional
        data["office_apps"].values[code]["total"][2024] = None
    ctx = groups.context(data)
    assert ctx.worlds["world_office"].last_year == 2023 < ctx.worlds["world_origin"].last_year == 2024
    europe = group_series("origin_apps", "europe", ctx)
    assert europe["total"][2024] is None and europe["null_reason"] == {2024: NO_WIPO_WORLD_TOTAL}
    share = continent_share("origin_apps", ctx)
    assert share["unallocated"][2024] is None and share["null_reason"] == {2024: NO_WIPO_WORLD_TOTAL}
    assert groups.panel("origin_apps", "155", ctx)["first"] is None  # last year failed: no window


def test_negative_unallocated_listed_and_warned():
    data = make_data()
    set_total(data, "pct_origin", "ZZ", 2020, PCT_ZZ - 100)  # world below the continent totals
    ctx = groups.context(data)
    share = continent_share("pct_origin", ctx)
    assert share["negative_years"] == [2020] and share["unallocated"][2020] == -23
    warnings = groups.check_warnings(ctx)
    assert any("pct_origin" in line and "2020" in line and "negative" in line for line in warnings)
    fresh = make_data()
    assert continent_share("pct_origin", groups.context(fresh))["negative_years"] == []


def test_pct_unknown_band_check():
    data = make_data()
    assert groups.check_warnings(groups.context(data)) == []
    set_total(data, "pct_origin", "**", 2021, 70)
    ctx = groups.context(data)  # data changed
    warnings = groups.check_warnings(ctx)
    assert any("2021" in line and "**" in line for line in warnings)
    assert continent_share("pct_origin", ctx)["unallocated_label"] == "unallocated"  # label only while it holds


def test_crosscheck_warns_outside_range():
    data = make_data()
    set_total(data, "office_apps", "R1", 2022, 1000)  # (1000 - 150) / 1000 = +85%
    set_total(data, "office_apps", "R1", 2023, 140)  # -7.1%
    warnings = [line for line in groups.check_warnings(groups.context(data)) if "cross-check" in line]
    assert [line for line in warnings if "africa" in line and "2022" in line]
    assert [line for line in warnings if "africa" in line and "2023" in line]
    assert len(warnings) == 2  # +6.25% (R1 160 vs 150) inside the range: no warning


def test_crosscheck_counts_regional_offices_and_an():
    data = make_data()
    data["office_apps"].values["OA"] = series_data("office_apps", {"OA": 10}).values["OA"]
    africa = group_series("office_apps", "africa", groups.context(data))
    assert africa["member_sum"][2020] == 160 and africa["members"] == 2  # OA -> Africa
    an_total = {**{year: None for year in YEARS}, 2020: 2}
    data["pct_origin"].values["AN"] = series_data("pct_origin", {"AN": an_total}).values["AN"]
    lac = group_series("pct_origin", "latin-america-caribbean", groups.context(data))  # data changed
    assert lac["member_sum"][2020] == 72 and lac["member_sum"][2019] == 70  # AN -> LAC
    assert lac["members"] == 2 and lac["reporting"][2020] == 2  # former states never count


def test_outputs_cut_at_world_last_year():
    data = make_data()
    for code in ("CH", "DE", "US", "CA", "CN", "JP", "NG", "KE", "BR"):  # 2024: 2 of 11 origins -> provisional
        set_total(data, "origin_apps", code, 2024, None)
    ctx = groups.context(data)
    assert ctx.worlds["world_origin"].last_year == 2023
    assert max(group_series("origin_apps", "europe", ctx)["total"]) == 2023
    assert max(group_series("pct_origin", "europe", ctx)["total"]) == 2024
    assert max(unallocated("origin_apps", ctx)) == 2023


def test_former_notes():
    eastern = former_notes("151")
    assert {"former": "SU", "until": 1991, "members": ["BY", "MD", "RU", "UA"]} in eastern
    assert {"former": "CS", "until": 1992, "members": ["CZ", "SK"]} in eastern
    southern = former_notes("039")
    assert {"former": "YU", "until": 1991, "members": ["BA", "HR", "MK", "SI"]} in southern
    assert {"former": "YU", "until": 2003, "members": ["ME", "RS"]} in southern
    assert former_notes("021") == []  # DD has no successor note anywhere


def test_groups_list_every_country_in_one_region():
    items = groups.groups_list()
    continents = [item for item in items if item["kind"] == "continent"]
    regions = [item for item in items if item["kind"] == "region"]
    assert [item["id"] for item in continents] == list(m49.CONTINENTS)
    assert "021" in {item["id"] for item in regions}  # US needs a region in region map mode
    seen = [code for item in regions for code in item["members"]]
    assert len(seen) == len(set(seen))
    assert set(seen) == {code for item in continents for code in item["members"]}
    assert all(m49.continent_of(code) == item["continent"] for item in regions for code in item["members"])
    by_id = {item["id"]: item for item in items}
    assert by_id["030"]["label"] == "Eastern Asia" and by_id["030"]["continent"] == "asia"


def test_method_table():
    assert groups.basis_table() == {
        "origin_apps": {"continent": "member_sum", "region": "member_sum"},
        "office_apps": {"continent": "wipo_total", "region": None},
        "pct_origin": {"continent": "wipo_total", "region": "member_sum"},
    }
    assert groups.CROSSCHECK_EXTRA["office_apps"]["europe"] == ("EP", "EA", "YU")
    assert groups.ORIGIN_ABROAD_FROM == 1994


EXTRA_CASES = [(series_id, code, continent) for series_id, extra in groups.CROSSCHECK_EXTRA.items()
               for continent, codes in extra.items() for code in codes]


def test_extra_cases_cover_note_assignment():
    assert {code for _, code, _ in EXTRA_CASES} == {"EP", "EA", "YU", "OA", "AP", "GC", "AN"}


@pytest.mark.parametrize("series_id, code, continent", EXTRA_CASES)
def test_crosscheck_counts_each_assigned_code(series_id, code, continent):
    data = make_data()
    row = data[series_id].values[m49.continent_wipo_code(continent, series_id)]["total"]
    for year in YEARS:
        row[year] *= 2  # R doubled: member sum alone now ~50% below -> warning
    without = [line for line in groups.check_warnings(groups.context(data))
               if "cross-check" in line and continent in line]
    assert len(without) == len(YEARS)
    value = {"office_apps": OFFICE, "pct_origin": PCT}[series_id][m49.continent_wipo_code(continent, series_id)]
    data[series_id].values[code] = series_data(series_id, {code: value}).values[code]  # fills the gap again
    ctx = groups.context(data)  # data changed
    figures = group_series(series_id, continent, ctx)
    base_data = make_data()
    base_data[series_id].values.pop(code, None)  # EP is in the default fixture
    base = group_series(series_id, continent, groups.context(base_data))
    assert figures["member_sum"][2020] == base["member_sum"][2020] + value  # code counted in the cross-check
    assert (figures["members"], figures["reporting"]) == (base["members"], base["reporting"])  # never a member
    assert not [line for line in groups.check_warnings(ctx) if "cross-check" in line and continent in line]


def test_crosscheck_yu_counts_while_it_reports():
    years = range(2002, 2006)
    data = make_data()
    for series in data.values():
        for code, types in series.values.items():
            for key, values in types.items():
                types[key] = {year: values[2020] for year in years}
        series.first_year, series.last_year = years[0], years[-1]
    yu = {2002: 40, 2003: 30, 2004: None, 2005: None}  # WIPO YU office data ends 2003
    data["office_apps"].values["YU"] = {key: dict(yu) if key == "total" else {year: None for year in years}
                                        for key in data["office_apps"].series.type_ids}
    member_sum = group_series("office_apps", "europe", groups.context(data))["member_sum"]
    assert (member_sum[2003], member_sum[2004]) == (9000 + 30, 9000)


def test_region_continent_accessor_and_empty_region(monkeypatch):
    assert m49.region_continent("030") == "asia" and groups.group_continent("021") == "northern-america"
    with pytest.raises(KeyError):
        m49.region_continent("999")
    monkeypatch.setitem(m49._REGIONS, "999", {"label": "Empty", "continent": "europe"})
    assert groups.group_continent("999") == "europe"
    data = make_data()
    with pytest.raises(ValueError, match="region 999 .Empty. has no member countries"):
        group_series("pct_origin", "999", groups.context(data))


@pytest.mark.parametrize("module", ["worlds", "groups", "write", "run"])
def test_each_module_imports_first(module):
    """No import cycle: each pipeline module imports on its own in a fresh interpreter."""
    result = subprocess.run([sys.executable, "-c", f"import pipeline.{module}"], capture_output=True, text=True,
                            cwd=str(Path(__file__).resolve().parents[2]))
    assert result.returncode == 0, result.stderr


def test_floor_fails_when_world_zero_or_nothing_grouped():
    """Audit G9/T9: floor branches `total <= 0` and `grouped_sum is None`: attribution_floor, not none_reported."""
    data = make_data()
    set_total(data, "office_apps", "WD", 2020, 0)
    assert group_series("origin_apps", "europe", groups.context(data))["null_reason"] == {2020: ATTRIBUTION_FLOOR}
    data = make_data()
    for code, value in ORIGIN.items():
        if value is not None:
            set_total(data, "origin_apps", code, 2021, None)
    europe = group_series("origin_apps", "europe", groups.context(data))
    assert europe["total"][2021] is None and europe["null_reason"] == {2021: ATTRIBUTION_FLOOR}


def test_pct_band_missing_unknown_row_mismatches_every_year():
    """Audit G11: no `**` row -> every checked year mismatches and the band label falls back."""
    data = make_data()
    del data["pct_origin"].values["**"]
    ctx = groups.context(data)
    assert [year for year, _, _ in ctx.pct_mismatches()] == list(YEARS)
    assert all(unknown is None for _, _, unknown in ctx.pct_mismatches())
    assert groups.unallocated_label("pct_origin", ctx) == "unallocated"


def test_crosscheck_bounds_inclusive():
    """Audit G11: gap (R - member sum) / R exactly at either bound passes; just past it warns. Africa members
    NG + KE; R1 200."""
    data = make_data()
    for year, nigeria in ((2019, 110), (2020, 160), (2021, 109), (2022, 161)):  # member sum 160, 210, 159, 211
        set_total(data, "office_apps", "R1", year, 200)
        set_total(data, "office_apps", "NG", year, nigeria)
    warnings = [line for line in groups.check_warnings(groups.context(data)) if "cross-check" in line]
    assert len(warnings) == 2  # +20% and -5% exact: none
    assert len([line for line in warnings if "africa 2021" in line]) == 1  # +20.5%
    assert len([line for line in warnings if "africa 2022" in line]) == 1  # -5.5%
