import datetime
import json
from pathlib import Path

import pytest

from pipeline import collect as collect_module
from pipeline import parse
from pipeline.collect import (GenderData, RatioData, SeriesData, collect, complete_last_year, monthly_complete_fn,
                              releases)
from pipeline.parse import SchemaError
from pipeline.series import (API_LABELS, GENDER_FIELD_IDS, GENDER_SERIES, RATIO_FROM, RATIO_SERIES, SERIES,
                             SeriesDef)

FIXTURES = Path(__file__).parent / "fixtures"
TODAY = datetime.date(2026, 10, 19)


def load_raw(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def load(name):
    raw = load_raw(name)
    return extend_fields(raw) if name == "women_by_field_small.json" else raw


def extend_fields(raw):
    """Field fixture holds 3 of 35 fields (8 KB cap); add the others in live shape (hand-made values)."""
    fields = load_raw("women_field_list_small.json")["pmhClassList"]
    present = {record["selectedClass"] for record in raw["records"]}
    years = [column["code"] for column in raw["columns"] if column["code"].isdigit()]
    for field_id, label in fields.items():
        if label in present:
            continue
        record = {"selectedClass": label, "selectedClass_SeqOrder": int(field_id)}
        for index, year in enumerate(years):
            value = None if year == years[-1] else f"{int(field_id) + 10}.{index}"
            record[year] = value
            record[f"{year}_SeqOrder"] = None if value is None else float(round(float(value)))
        raw["records"].append(record)
    return raw


ROUTES = {
    ("ips-search/formcontrols", None): "formcontrols_ips_small.json",
    ("pmh-search/formcontrols", None): "formcontrols_pmh_small.json",
    ("ips-search/loadOffOrgTechList", "13"): "entities_origin_small.json",
    ("ips-search/loadOffOrgTechList", "11"): "entities_office_small.json",
    ("pmh-search/loadOffOrgClassList", None): "entities_pct_small.json",
    ("ips-search/table-result", "13"): "table_origin_small.json",
    ("ips-search/table-result", "11"): "table_office_small.json",
    ("pmh-search/table-result", "4001"): "table_pct_small.json",
    ("pmh-search/table-result", "4003"): "pct_monthly_small.json",
}
# ratio indicators share rpType 13 with origin_apps, gender and publication tables report 4001 with pct_origin:
# routed by indicator
INDICATOR_ROUTES = {
    ("ips-search/loadOffOrgTechList", "100"): "ratio_entities_small.json",
    ("ips-search/loadOffOrgTechList", "101"): "ratio_entities_small.json",
    ("ips-search/table-result", "100"): "ratio_per_gdp_small.json",
    ("ips-search/table-result", "101"): "ratio_per_million_small.json",
    ("pmh-search/loadOffOrgClassList", "1010"): "pct_publications_list_small.json",
    ("pmh-search/loadOffOrgClassList", "1040"): "women_origin_list_small.json",
    ("pmh-search/loadOffOrgClassList", "1042"): "women_origin_list_small.json",
    ("pmh-search/loadOffOrgClassList", "1041"): "women_field_list_small.json",
    ("pmh-search/table-result", "1010"): "pct_publications_small.json",
    ("pmh-search/table-result", "1040"): "women_any_small.json",
    ("pmh-search/table-result", "1042"): "women_share_small.json",
    ("pmh-search/table-result", "1041"): "women_by_field_small.json",
}
RATIO_INDICATORS = {"100", "101"}
GENDER_INDICATORS = {"1010", "1040", "1041", "1042"}
FIXTURE_COUNTRY_ROWS = 4  # countries with a gender value in women_any/women_share_small (AM, CH, DE, US)


def route(path, params):
    key = (path, params.get("indicator"))
    if key in INDICATOR_ROUTES:
        return INDICATOR_ROUTES[key]
    return ROUTES[(path, params.get("rpType") or params.get("reportType"))]


def slice_monthly(raw, first, last):
    """Server behaviour: the monthly table holds only columns of fromYear..toYear."""
    def keep(key):
        code = key.split("_")[0]
        return "/" not in code or first <= int(code.split("/")[0]) <= last
    if isinstance(raw.get("columns"), list) and isinstance(raw.get("records"), list):
        raw["columns"] = [c for c in raw["columns"] if keep(c["code"])]
        raw["records"] = [{k: v for k, v in r.items() if keep(k)} for r in raw["records"]]
    return raw


MONTHLY_EARLY_YEARS = range(2022, 2025)  # pct table years before the fixture's 2025


def early_month_value(year, month):
    return (year - 2000) * 1000 + month


def extend_monthly(raw):
    """Monthly fixture holds 2025-2026 only; add 2022-2024 (hand-made: value = early_month_value)."""
    early = [{**column, "code": f"{year}/{month}", "value": f"{year}/{month}",
              "sortProperty": f"{year}/{month}_SeqOrder"}
             for year in MONTHLY_EARLY_YEARS for month in range(1, 13)
             for column in raw["columns"][2:3]]
    raw["columns"] = raw["columns"][:2] + early + raw["columns"][2:]
    for year in MONTHLY_EARLY_YEARS:
        for month in range(1, 13):
            raw["records"][0][f"{year}/{month}"] = f"{early_month_value(year, month):,}"
    return raw


MONTHLY_2025 = [21000, 20000, 24000, 22000, 21500, 23000, 22500, 20500, 25000, 23000, 22500, 29000]


class FakeClient:
    def __init__(self, overrides=None):
        self.calls = []
        self.overrides = overrides or {}

    def get_json(self, path, params):
        self.calls.append((path, dict(params)))
        name = route(path, params)
        raw = self.overrides[name]() if name in self.overrides else load(name)
        if name == "pct_monthly_small.json" and name not in self.overrides:
            raw = extend_monthly(raw)
        if params.get("reportType") == "4003":
            raw = slice_monthly(raw, int(params["fromYear"]), int(params["toYear"]))
        return raw

    def release_string(self, tab):
        return {"ips": "Last updated: May 2026", "pmh": "Last updated: October 2026"}[tab]

    def monthly_years(self):
        return [int(p["fromYear"]) for path, p in self.calls if p.get("reportType") == "4003"]


@pytest.fixture
def small_lists(monkeypatch):
    monkeypatch.setattr(parse, "MIN_ENTITIES", 1)
    monkeypatch.setattr(collect_module, "GENDER_MIN_COUNTRY_ROWS", FIXTURE_COUNTRY_ROWS)


# complete_last_year

def test_complete_last_year_drops_current():
    assert complete_last_year(2026, TODAY, None) == 2025


def test_complete_last_year_api_behind():
    assert complete_last_year(2024, TODAY, None) == 2024


def test_pct_incomplete_month_steps_back():
    client = FakeClient()
    # January 2027: 2026 has 9 month columns (2 null) -> step back to 2025 (12 months)
    assert complete_last_year(2027, datetime.date(2027, 1, 15), monthly_complete_fn(client)) == 2025
    assert client.monthly_years() == [2026, 2025]


def test_pct_complete_year_kept():
    client = FakeClient()
    assert complete_last_year(2026, TODAY, monthly_complete_fn(client)) == 2025
    assert client.monthly_years() == [2025]


def test_complete_last_year_gives_up():
    with pytest.raises(SchemaError, match="monthly"):
        complete_last_year(2026, TODAY, lambda year: False)


# monthly_complete_fn

def test_monthly_complete_fn():
    client = FakeClient()
    is_complete = monthly_complete_fn(client)
    assert is_complete(2025) is True
    assert is_complete(2026) is False
    assert is_complete(2025) is True
    assert client.monthly_years() == [2025, 2026]  # cached per year
    path, params = client.calls[0]
    assert path == "pmh-search/table-result"
    assert params == {"selectedTab": "pct", "indicator": "1001", "reportType": "4003", "fromYear": "2025",
                      "toYear": "2025", "pmhOffSelValues": "ZZ", "pmhOriSelValues": "ZZ"}


def test_monthly_null_month_incomplete():
    def with_null():
        raw = load("pct_monthly_small.json")
        raw["records"][0]["2025/12"] = None
        return raw
    assert monthly_complete_fn(FakeClient({"pct_monthly_small.json": with_null}))(2025) is False


def mutated_monthly(mutate):
    def make():
        raw = load("pct_monthly_small.json")
        mutate(raw)
        return raw
    return monthly_complete_fn(FakeClient({"pct_monthly_small.json": make}))


def drop_column(code):
    def mutate(raw):
        raw["columns"] = [c for c in raw["columns"] if c["code"] != code]
    return mutate


def rename_column(old, new):
    def mutate(raw):
        for c in raw["columns"]:
            if c["code"] == old:
                c["code"] = new
        raw["records"][0][new] = raw["records"][0].pop(old)
    return mutate


@pytest.mark.parametrize("mutate, message", [
    (drop_column("2025/6"), "months"),                       # gap inside a year
    (rename_column("2025/3", "2025/03"), "not a month"),     # zero-padded month
    (rename_column("2025/3", "2025/13"), "not a month"),
    (lambda raw: raw["records"].append(dict(raw["records"][0])), "one record"),
    (lambda raw: raw["records"][0].update(selectedOrigin="Switzerland"), "origin"),
    (lambda raw: raw["records"][0].update(selectedOffice="Switzerland"), "office"),
    (lambda raw: raw["records"][0].update({"2025/4": "1,1,2,209"}), "2025/4"),
    (lambda raw: raw["recordInfo"].update(reportType="Yearly statistics"), "report"),
    (lambda raw: raw.update(records=None), "records"),
])
def test_monthly_schema_errors(mutate, message):
    with pytest.raises(SchemaError, match=message):
        mutated_monthly(mutate)(2025)


def test_monthly_wrong_year_rejected():
    with pytest.raises(SchemaError, match="year"):
        mutated_monthly(lambda raw: None)(2024)  # fixture holds no 2024 columns


# collect

def test_collect_shapes(small_lists):
    client = FakeClient()
    collected = collect(client, TODAY)
    assert set(collected) == {"series", "pct_monthly", "ratios", "pct_publications", "gender"}
    data = collected["series"]
    assert set(data) == {"origin_apps", "office_apps", "pct_origin"}
    assert all(isinstance(d, SeriesData) for d in data.values())
    assert [data[s.id].series for s in SERIES] == SERIES

    origin = data["origin_apps"]
    assert (origin.first_year, origin.last_year) == (2022, 2024)
    assert set(origin.values) == {"CH", "US", "CI"}
    assert set(origin.values["CH"]) == {"total", "resident", "abroad"}
    assert origin.values["CH"]["total"] == {2022: 40000, 2023: 41500, 2024: 42000}
    assert origin.values["CI"]["total"] == {2022: None, 2023: None, 2024: 12}
    assert origin.labels["CI"] == "Côte d'Ivoire"

    office = data["office_apps"]
    assert set(office.values) == {"CH", "EP", "US", "VA", "WD"}
    assert set(office.values["EP"]) == {"total", "resident", "nonresident"}
    assert office.values["CH"]["resident"] == {2022: 1100, 2023: 1150, 2024: 1190}
    assert office.values["US"]["total"][2024] is None
    # VA has no rows (WIPO omits all-null rows): kept, every value None
    assert office.values["VA"] == {t: {2022: None, 2023: None, 2024: None}
                                   for t in ("total", "resident", "nonresident")}
    assert office.labels["EP"] == "European Patent Office"
    assert (origin.absent_rows, office.absent_rows) == (0, 3)

    pct = data["pct_origin"]
    assert (pct.first_year, pct.last_year) == (2022, 2025)  # 2026 (current, partial) trimmed
    assert set(pct.values) == {"CH", "R6", "US", "VA", "ZZ"}
    assert pct.values["ZZ"] == {"total": {2022: 278000, 2023: 273000, 2024: 274000, 2025: 275000}}
    assert pct.values["VA"] == {"total": {2022: None, 2023: None, 2024: None, 2025: None}}
    assert pct.absent_rows == 1

    # world (origin Total, RO Total) months, pct first..last complete year; 2026 (partial) left out
    assert collected["pct_monthly"] == {
        **{year: [early_month_value(year, month) for month in range(1, 13)] for year in MONTHLY_EARLY_YEARS},
        2025: MONTHLY_2025}


def test_collect_requests(small_lists):
    client = FakeClient()
    collect(client, TODAY)
    tables = {p["reportType"]: (path, p) for path, p in client.calls
              if path.endswith("table-result") and p["indicator"] not in RATIO_INDICATORS | GENDER_INDICATORS}
    assert tables["13"] == ("ips-search/table-result", {
        "selectedTab": "patent", "indicator": "10", "reportType": "13", "fromYear": "2022", "toYear": "2024",
        "ipsOriSelValues": "CH,CI,US", "ipsTechSelValues": "910,911,912"})
    assert tables["11"] == ("ips-search/table-result", {
        "selectedTab": "patent", "indicator": "10", "reportType": "11", "fromYear": "2022", "toYear": "2024",
        "ipsOffSelValues": "CH,EP,US,VA,WD", "ipsTechSelValues": "900,901,902"})
    assert tables["4001"] == ("pmh-search/table-result", {
        "selectedTab": "pct", "indicator": "1001", "reportType": "4001", "fromYear": "2022", "toYear": "2026",
        "pmhOffSelValues": "ZZ", "pmhOriSelValues": "CH,R6,US,VA,ZZ"})
    assert ("ips-search/loadOffOrgTechList", {"indicator": "10", "rpType": "13"}) in client.calls
    assert ("ips-search/loadOffOrgTechList", {"indicator": "10", "rpType": "11"}) in client.calls
    assert ("pmh-search/loadOffOrgClassList", {"indicator": "1001"}) in client.calls
    # 2 form controls, 3 lists, 3 tables, 4 monthly, 2 ratio lists + 2 tables, 4 gender/publication lists + 4 tables
    assert len(client.calls) == 24
    assert client.monthly_years() == [2025, 2022, 2023, 2024]  # completeness check first; 2025 cached


def test_collect_pct_monthly_starts_at_pct_first_year(small_lists):
    collected = collect(FakeClient(), TODAY)
    # heat strip covers the PCT yearly series' years (live: pmh first year 1995), so the strip and totals agree
    assert min(collected["pct_monthly"]) == collected["series"]["pct_origin"].first_year == 2022


def test_collect_pct_monthly_pads_short_year(small_lists):
    def short_2022():  # a year the table holds only months 1-6 of: 6 nulls appended
        raw = extend_monthly(load("pct_monthly_small.json"))
        drop = {f"2022/{month}" for month in range(7, 13)}
        raw["columns"] = [column for column in raw["columns"] if column["code"] not in drop]
        return raw
    monthly = collect(FakeClient({"pct_monthly_small.json": short_2022}), TODAY)["pct_monthly"]
    assert monthly[2022] == [early_month_value(2022, month) for month in range(1, 7)] + [None] * 6
    assert monthly[2025] == MONTHLY_2025


def collect_mutated(mutations):
    def factory(name, mutate):
        def make():
            raw = load(name)
            mutate(raw)
            return raw
        return make
    return collect(FakeClient({name: factory(name, m) for name, m in mutations.items()}), TODAY)["series"]


def collect_with(name, mutate):
    return collect_mutated({name: mutate})


def drop_rows(label, column="selectedOffice"):
    def mutate(raw):
        raw["records"] = [r for r in raw["records"] if r[column] != label]
    return mutate


def drop_listed(key, code):
    def mutate(raw):
        del raw[key][code]
    return mutate


def null_cell(label, year, column="selectedOffice", type_label=None):
    def mutate(raw):
        for record in raw["records"]:
            if record[column] == label and record.get("selectedTechnology", "Total") == (type_label or "Total"):
                record[year] = None
    return mutate


# truncation guards: absent-row ceiling, aggregate total row with data in last_year

def test_collect_absent_row_ceiling(small_lists):
    # EP rows dropped: VA + EP absent = 6 of 15 requested rows (40%) > 25%
    with pytest.raises(SchemaError, match="rows without data"):
        collect_with("table_office_small.json", drop_rows("European Patent Office"))


def test_collect_absent_rows_at_ceiling_pass(small_lists):
    # R6 gone from list and table: VA absent = 1 of 4 rows = exactly 25% -> allowed
    data = collect_mutated({"entities_pct_small.json": drop_listed("pmhOriginList", "R6"),
                            "table_pct_small.json": drop_rows("Oceania", "selectedOrigin")})
    assert data["pct_origin"].absent_rows == 1


def test_collect_office_world_total_null_last_year(small_lists):
    with pytest.raises(SchemaError, match="WD"):
        collect_with("table_office_small.json", null_cell("World", "2024"))


def test_collect_office_world_not_listed(small_lists, monkeypatch):
    # ceiling lifted: the WD guard must fire on its own, whatever share of rows is absent
    monkeypatch.setattr(collect_module, "MAX_ABSENT_ROW_SHARE", 1.0)
    with pytest.raises(SchemaError, match="total row WD not in the entity list"):
        collect_mutated({"entities_office_small.json": drop_listed("ipsOffList", "WD"),
                         "table_office_small.json": drop_rows("World")})


def test_collect_pct_total_null_last_year(small_lists):
    with pytest.raises(SchemaError, match="ZZ"):
        collect_with("table_pct_small.json", null_cell("Total", "2025", column="selectedOrigin"))


def test_collect_office_label_not_in_list(small_lists):
    with pytest.raises(SchemaError, match="unknown selectedOffice label"):
        collect_with("entities_office_small.json", drop_listed("ipsOffList", "EP"))


def test_collect_rejects_renumbered_indicator(small_lists):
    def mutate(raw):
        raw["recordInfo"]["indicator"] = "2 - Total patent grants (direct and PCT national phase entries)"
    with pytest.raises(SchemaError, match="indicator"):
        collect_with("table_office_small.json", mutate)


def test_collect_rejects_swapped_type_ids(small_lists):
    def mutate(raw):  # table rows still map, but 911 would now mean Abroad
        raw["ipsTechList"]["911"], raw["ipsTechList"]["912"] = "Abroad", "Resident"
    with pytest.raises(SchemaError, match="911"):
        collect_with("entities_origin_small.json", mutate)


@pytest.mark.parametrize("mutate", [
    lambda raw: raw.update(ipsFYears=["2022", "2024"]),           # gap
    lambda raw: raw.update(ipsToYearList=["2023"]),               # to-year != last from-year
    lambda raw: raw.update(ipsFYears=[]),
    lambda raw: raw.update(ipsFYears=["2022", "2023", "2024/1"]),
    lambda raw: raw.pop("ipsToYearList"),
])
def test_collect_rejects_bad_year_range(small_lists, mutate):
    with pytest.raises(SchemaError, match="year"):
        collect_with("formcontrols_ips_small.json", mutate)


def test_collect_rejects_no_complete_year(small_lists):
    with pytest.raises(SchemaError, match="complete year"):
        collect(FakeClient(), datetime.date(2022, 6, 1))  # ips: min(2024, 2021) < first year 2022


# ratio indicators (ips 100/101): decimals, no type column, own absent-row ceiling

RATIO_CODES = ["CH", "CI", "DE", "JP", "LU", "MG", "SU", "US", "VA", "WD"]


def test_collect_ratios(small_lists):
    client = FakeClient()
    ratios = collect(client, TODAY)["ratios"]
    assert list(ratios) == [r.id for r in RATIO_SERIES] == ["per_gdp", "per_million"]
    assert all(isinstance(r, RatioData) for r in ratios.values())
    assert [ratios[r.id].ratio for r in RATIO_SERIES] == RATIO_SERIES

    per_million = ratios["per_million"]
    assert (per_million.first_year, per_million.last_year) == (RATIO_FROM, 2024) == (1990, 2024)
    assert sorted(per_million.values) == RATIO_CODES
    assert all(set(years) == set(range(1990, 2025)) for years in per_million.values.values())
    assert per_million.values["CH"][1990] == 450.2
    assert per_million.values["CH"][2024] == 1235.0 and isinstance(per_million.values["CH"][2024], float)
    assert per_million.values["WD"][2024] == 330.6  # World row kept
    assert per_million.values["MG"][2024] == 0.1
    assert per_million.values["CI"][2024] is None  # ""
    assert all(value is None for value in per_million.values["LU"].values())  # row absent
    assert per_million.labels["CI"] == "Côte d'Ivoire"
    assert per_million.api_label == "10 - Resident applications per million population (by origin)"
    assert per_million.absent_rows == 3  # LU, SU (all null), VA: 30% of 10, under the 35% ceiling

    per_gdp = ratios["per_gdp"]
    assert per_gdp.values["CH"][2024] == 1505.6
    assert per_gdp.values["WD"][1990] == 1300.0
    assert per_gdp.api_label == "9 - Resident applications per 100 billion USD GDP (2017 PPP) (by origin)"
    assert per_gdp.absent_rows == 3  # CI, SU, VA

    lists = [p for path, p in client.calls if path == "ips-search/loadOffOrgTechList"]
    assert {"indicator": "100", "rpType": "13"} in lists and {"indicator": "101", "rpType": "13"} in lists
    tables = {p["indicator"]: p for path, p in client.calls if path == "ips-search/table-result"}
    assert tables["101"] == {  # no ipsTechSelValues: ratio tables have no type column
        "selectedTab": "patent", "indicator": "101", "reportType": "13", "fromYear": "1990", "toYear": "2024",
        "ipsOriSelValues": ",".join(RATIO_CODES)}
    assert tables["100"]["indicator"] == "100" and "ipsTechSelValues" not in tables["100"]


def test_collect_ratios_trimmed_to_complete_year(small_lists, monkeypatch):
    # gender fixtures: Armenia has no 2023 value (3 of 4 countries); the row-share limit is tested separately
    monkeypatch.setattr(collect_module, "GENDER_LAST_YEAR_ROW_SHARE_MIN", 0.5)
    client = FakeClient()
    ratios = collect(client, datetime.date(2024, 6, 1))["ratios"]  # ips offers 2024, complete only to 2023
    assert (ratios["per_million"].first_year, ratios["per_million"].last_year) == (1990, 2023)
    assert set(ratios["per_million"].values["CH"]) == set(range(1990, 2024))
    tables = [p for path, p in client.calls if path == "ips-search/table-result" and p["indicator"] == "101"]
    assert tables[0]["toYear"] == "2024"  # full offered range requested, then trimmed


def test_collect_ratio_label_words_checked(small_lists):
    def mutate(raw):
        raw["recordInfo"]["indicator"] = "10 - Resident applications per inhabitant (by origin)"
    with pytest.raises(SchemaError, match="per million population"):
        collect_with("ratio_per_million_small.json", mutate)


def test_collect_ratio_wording_outside_label_words_free(small_lists):
    relabelled = "9 - Resident applications per 100 billion USD GDP (2021 PPP) (by origin)"

    def make():  # WIPO relabels "(2017 PPP)": not pinned, echoed as api_label
        raw = load("ratio_per_gdp_small.json")
        raw["recordInfo"]["indicator"] = relabelled
        return raw
    ratios = collect(FakeClient({"ratio_per_gdp_small.json": make}), TODAY)["ratios"]
    assert ratios["per_gdp"].api_label == relabelled


def test_collect_ratio_report_label_checked(small_lists):
    def mutate(raw):
        raw["recordInfo"]["reportType"] = "Total count by filing office"
    with pytest.raises(SchemaError, match="per_gdp: recordInfo reportType"):
        collect_with("ratio_per_gdp_small.json", mutate)


def test_collect_ratio_absent_row_ceiling(small_lists):
    # Japan dropped: LU, SU, VA, JP absent = 4 of 10 (40%) > 35%; per_gdp (30%) passes first
    with pytest.raises(SchemaError, match="per_million: 4/10 rows without data"):
        collect_with("ratio_per_million_small.json", drop_rows("Japan", "selectedOrigin"))


def test_collect_ratio_world_null_last_year(small_lists):
    with pytest.raises(SchemaError, match="per_million: world row WD has no value for 2024"):
        collect_with("ratio_per_million_small.json", null_cell("World", "2024", column="selectedOrigin"))


def test_collect_ratio_world_not_listed(small_lists, monkeypatch):
    # ceiling lifted: the World guard fires on its own, whatever share of rows is absent
    monkeypatch.setattr(collect_module, "MAX_ABSENT_RATIO_ROW_SHARE", 1.0)
    with pytest.raises(SchemaError, match="per_gdp: world row WD not in the entity list"):
        collect_mutated({"ratio_entities_small.json": drop_listed("ipsOriginList", "WD"),
                         "ratio_per_gdp_small.json": drop_rows("World", "selectedOrigin"),
                         "ratio_per_million_small.json": drop_rows("World", "selectedOrigin")})


def test_releases():
    assert releases(FakeClient()) == {"ips": "Last updated: May 2026", "pmh": "Last updated: October 2026"}


def test_kind_unmapped_report_names_series():
    odd = SeriesDef("odd_series", "ips", "10", "15", {"total": "910"}, "x", "x")
    with pytest.raises(ValueError, match="odd_series"):
        odd.kind


def test_api_labels_cover_series():
    assert set(API_LABELS) == {s.id for s in SERIES}
    assert [s.kind for s in SERIES] == ["origin", "office", "origin"]


def test_ratio_series_pin_origin_report():
    assert [(r.id, r.indicator, r.report_type) for r in RATIO_SERIES] == [("per_gdp", "100", "13"),
                                                                          ("per_million", "101", "13")]
    assert {r.report_label for r in RATIO_SERIES} == {API_LABELS["origin_apps"][1]} == {
        "Total count by applicant's origin"}
    assert RATIO_FROM == 1990


# women inventors (pmh 1040/1041/1042) and PCT publications (pmh 1010): research 2026-10-21-wipo-women-inventors.md

GENDER_ORIGIN_CODES = ["**", "AM", "CH", "DE", "R3", "R6", "US", "VA", "ZZ"]  # parse_entity_list order (by code)
GENDER_YEARS = set(range(2022, 2026))  # fixture pmh years 2022-2026; 2026 (current) trimmed


def collect_all(mutations):
    def factory(name, mutate):
        def make():
            raw = load(name)
            mutate(raw)
            return raw
        return make
    return collect(FakeClient({name: factory(name, m) for name, m in mutations.items()}), TODAY)


def _sort_key(value):
    """WIPO's `_SeqOrder` for a cell: the value; an unparseable (garbled) text keeps a dummy key."""
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return 1.0


def set_cell(label, year, value, column="selectedOrigin", seq=True):
    def mutate(raw):
        for record in raw["records"]:
            if record[column] == label:
                record[year] = value
                if seq:
                    record[f"{year}_SeqOrder"] = None if value is None else _sort_key(value)
    return mutate


def add_listed(key, code, label):
    def mutate(raw):
        raw[key][code] = label
    return mutate


def gender_tables(client):
    return {p["indicator"]: p for path, p in client.calls
            if path == "pmh-search/table-result" and p["indicator"] in GENDER_INDICATORS}


def test_gender_request_has_no_office_param(small_lists):
    client = FakeClient()
    collect(client, TODAY)
    tables = gender_tables(client)
    assert set(tables) == GENDER_INDICATORS
    assert all("pmhOffSelValues" not in params for params in tables.values())  # with it: 0 rows (probe)
    for indicator in ("1040", "1042"):
        assert tables[indicator] == {"selectedTab": "pct", "indicator": indicator, "reportType": "4001",
                                     "fromYear": "2022", "toYear": "2026",
                                     "pmhOriSelValues": ",".join(GENDER_ORIGIN_CODES)}
    assert tables["1010"] == {"selectedTab": "pct", "indicator": "1010", "reportType": "4001", "fromYear": "2022",
                              "toYear": "2026", "pmhOriSelValues": "**,AM,CH,DE,US,VA,ZZ", "pmhClassSelValues": "109"}
    for indicator in ("1010", "1040", "1041", "1042"):
        assert ("pmh-search/loadOffOrgClassList", {"indicator": indicator}) in client.calls


def test_gender_origin_values(small_lists):
    gender = collect(FakeClient(), TODAY)["gender"]
    assert list(gender) == [g.id for g in GENDER_SERIES] == ["women_any", "women_share", "women_any_by_field"]
    assert all(isinstance(data, GenderData) for data in gender.values())
    women_any = gender["women_any"]
    assert sorted(women_any.values) == sorted(GENDER_ORIGIN_CODES)  # every listed code kept, ** included
    assert all(set(years) == GENDER_YEARS for years in women_any.values.values())
    assert women_any.values["CH"][2024] == 33.0 and isinstance(women_any.values["CH"][2024], float)
    assert women_any.values["ZZ"][2025] == 38.1
    assert women_any.values["AM"][2023] is None and women_any.values["AM"][2024] == 20.0  # WIPO omits, gap kept
    assert women_any.values["**"][2023] == 45.5 and women_any.labels["**"] == "Unknown"
    assert all(value is None for value in women_any.values["VA"].values())  # listed, no row
    assert all(value is None for value in women_any.values["R3"].values())
    assert women_any.last_year == 2025
    assert women_any.api_label == "13 - Share of applications with at least one women inventor (yearly statistics)"
    assert gender["women_share"].values["CH"][2024] == 16.9
    assert gender["women_share"].api_label == "15 - Share of women inventors (yearly statistics)"


@pytest.mark.parametrize("list_name", ["women_origin_list_small.json", "pct_publications_list_small.json"])
def test_gender_unknown_code_raises(small_lists, list_name):
    with pytest.raises(SchemaError, match="'XX'"):  # audit G12: never guessed as a country
        collect_all({list_name: add_listed("pmhOriginList", "XX", "Nowhere")})


def test_gender_field_world_only(small_lists):
    client = FakeClient()
    by_field = collect(client, TODAY)["gender"]["women_any_by_field"]
    assert list(by_field.values) == list(GENDER_FIELD_IDS) == [str(i) for i in range(1, 36)]
    assert by_field.labels["6"] == "Computer technology"  # parse_class_list labels
    assert by_field.labels["35"] == "Civil engineering"
    assert by_field.values["6"][2025] == 39.6
    assert set(by_field.values["1"]) == GENDER_YEARS and by_field.last_year == 2025
    params = gender_tables(client)["1041"]
    assert params == {"selectedTab": "pct", "indicator": "1041", "reportType": "4001", "fromYear": "2022",
                      "toYear": "2026", "pmhClassSelValues": ",".join(str(i) for i in range(1, 36))}


def test_gender_field_list_changed_raises(small_lists):
    with pytest.raises(SchemaError, match="women_any_by_field: field ids"):
        collect_all({"women_field_list_small.json": add_listed("pmhClassList", "36", "Quantum technology")})


def test_gender_label_check(small_lists):
    def mutate(raw):  # 1040 renumbered to the by-technology table
        raw["recordInfo"]["indicator"] = (
            "13 - Share of applications with at least one women inventor by technology (yearly statistics)")
    with pytest.raises(SchemaError, match="women_any: recordInfo indicator"):
        collect_all({"women_any_small.json": mutate})


@pytest.mark.parametrize("value", ["100.1", "1,100", "1.05", "-1.0"])
def test_gender_share_guards(small_lists, value):
    with pytest.raises(SchemaError, match="CH/none/2024"):
        collect_all({"women_any_small.json": set_cell("Switzerland", "2024", value)})


def test_gender_share_bounds_inclusive(small_lists):
    collected = collect_all({"women_any_small.json": set_cell("Armenia", "2025", "100.0"),
                             "women_share_small.json": set_cell("Armenia", "2025", "0.0")})
    assert collected["gender"]["women_any"].values["AM"][2025] == 100.0
    assert collected["gender"]["women_share"].values["AM"][2025] == 0.0  # a real share, not missing


@pytest.mark.parametrize("seq_value, value", [(None, "33.0"), (12.0, None)])
def test_gender_seqorder_mismatch(small_lists, seq_value, value):
    def mutate(raw):  # garbling sign (research 2026-10-19): sort keys and values disagree
        for record in raw["records"]:
            if record["selectedOrigin"] == "Switzerland":
                record["2024"], record["2024_SeqOrder"] = value, seq_value
    with pytest.raises(SchemaError, match="women_any: record 2 _SeqOrder"):
        collect_all({"women_any_small.json": mutate})


def test_gender_seqorder_doubled_key_raises(small_lists):
    def mutate(raw):  # research 2026-10-19: missing RO filter doubles the sort key; value looks fine
        for record in raw["records"]:
            if record["selectedOrigin"] == "Switzerland":
                record["2024_SeqOrder"] = 66.0
    with pytest.raises(SchemaError, match=r"women_any: record 2 2024 _SeqOrder 66\.0 != value '33\.0'"):
        collect_all({"women_any_small.json": mutate})


def test_gender_seqorder_rounding_tolerated(small_lists):
    collect_all({"women_any_small.json": set_cell("Switzerland", "2024", "33.5", seq=False)})  # key 33.0: diff 0.5


def test_gender_seqorder_beyond_rounding_raises(small_lists):
    def mutate(raw):
        for record in raw["records"]:
            if record["selectedOrigin"] == "Switzerland":
                record["2024_SeqOrder"] = 34.0  # value 33.0: diff 1
    with pytest.raises(SchemaError, match="women_any: record 2 2024 _SeqOrder"):
        collect_all({"women_any_small.json": mutate})


def test_publications_seqorder_count_off_by_one_raises(small_lists):
    def mutate(raw):
        for record in raw["records"]:
            if record["selectedOrigin"] == "Switzerland":
                record["2025_SeqOrder"] = 5351.0  # value "5,350": counts must match exactly
    with pytest.raises(SchemaError, match="pct_publications: record 2 2025 _SeqOrder 5351.0"):
        collect_all({"pct_publications_small.json": mutate})


def test_publications_seqorder_concatenated_value_raises(small_lists):
    # "5,423" + "100" -> "5,423,100" is a well-formed count; only the sort key (10,846) gives it away
    with pytest.raises(SchemaError, match="pct_publications: record 2 2025 _SeqOrder 10846.0"):
        collect_all({"pct_publications_small.json": lambda raw: [
            record.update({"2025": "5,423,100", "2025_SeqOrder": 10846.0})
            for record in raw["records"] if record["selectedOrigin"] == "Switzerland"]})


def test_gender_region_value_raises(small_lists):
    def mutate(raw):
        raw["records"].append({**raw["records"][0], "selectedOrigin": "Europe"})
    with pytest.raises(SchemaError, match="continent shares"):
        collect_all({"women_share_small.json": mutate})


def test_gender_value_before_from_raises(small_lists, monkeypatch):
    monkeypatch.setattr(collect_module, "GENDER_FROM", 2023)  # fixture rows hold 2022 values
    with pytest.raises(SchemaError, match="women_any: values before 2023"):
        collect(FakeClient(), TODAY)


def test_gender_min_rows(small_lists, monkeypatch):
    collect(FakeClient(), TODAY)  # at the minimum: ok
    monkeypatch.setattr(collect_module, "GENDER_MIN_COUNTRY_ROWS", FIXTURE_COUNTRY_ROWS + 1)
    with pytest.raises(SchemaError, match="women_any: 4 country rows with a value, expected at least 5"):
        collect(FakeClient(), TODAY)


def test_gender_last_year_lag(small_lists):
    lagged = collect_all({"women_any_small.json": set_cell("Total", "2025", None)})["gender"]["women_any"]
    assert lagged.last_year == 2024 and set(lagged.values["CH"]) == {2022, 2023, 2024}
    with pytest.raises(SchemaError, match="women_any: World row ZZ has no value in 2025 nor 2024"):
        collect_all({"women_any_small.json": lambda raw: [set_cell("Total", y, None)(raw) for y in ("2024", "2025")]})


def test_gender_last_year_capped_at_publications(small_lists):
    # ZZ has a value in 2026, but publications end in 2025: the table's own newest year is not the last year
    women_any = collect_all({"women_any_small.json": set_cell("Total", "2026", "39.0")})["gender"]["women_any"]
    assert women_any.last_year == 2025 and 2026 not in women_any.values["ZZ"]


def test_gender_last_year_row_share(small_lists, monkeypatch):
    cut = {"women_any_small.json": set_cell("Armenia", "2025", None)}  # last year 3 country rows, year before 4
    monkeypatch.setattr(collect_module, "GENDER_LAST_YEAR_ROW_SHARE_MIN", 0.75)
    assert collect_all(cut)["gender"]["women_any"].last_year == 2025  # at the limit: ok
    monkeypatch.setattr(collect_module, "GENDER_LAST_YEAR_ROW_SHARE_MIN", 0.76)
    with pytest.raises(SchemaError, match="women_any: 3 country rows with a value in 2025, 4 in 2024"):
        collect_all(cut)


def test_gender_last_year_row_share_uses_lagged_year(small_lists):
    # World row missing in 2025 -> last year 2024: compared with 2023 (3 countries), not with 2025
    lagged = {"women_any_small.json": set_cell("Total", "2025", None)}
    assert collect_all(lagged)["gender"]["women_any"].last_year == 2024


def test_gender_field_last_year_lag(small_lists):
    def null_2025(raw):
        for record in raw["records"]:
            record["2025"], record["2025_SeqOrder"] = None, None
    by_field = collect_all({"women_by_field_small.json": null_2025})["gender"]["women_any_by_field"]
    assert by_field.last_year == 2024


def test_gender_zero_rows_names_request(small_lists):
    def empty(raw):  # live answer to pmhOffSelValues=ZZ: 0 rows, columns null
        raw["recordInfo"], raw["columns"], raw["records"] = None, None, []
    with pytest.raises(SchemaError, match=r"women_share: 0 rows for request .*pmhOriSelValues=<9 codes>"):
        collect_all({"women_share_small.json": empty})


GENDER_TABLE_FIXTURES = ["women_any_small.json", "women_share_small.json", "women_by_field_small.json",
                         "pct_publications_small.json"]


@pytest.mark.parametrize("name", GENDER_TABLE_FIXTURES)
def test_gender_fixtures_keep_live_shape(name):
    raw = load_raw(name)
    assert raw["_fixture"] == "hand-made" and (FIXTURES / name).stat().st_size <= 8 * 1024
    codes = [column["code"] for column in raw["columns"]]
    assert "selectedOffice" not in codes  # requested without pmhOffSelValues
    years = [code for code in codes if code.isdigit()]
    for record in raw["records"]:
        for year in years:
            assert record[year] is None or isinstance(record[year], str)  # live: strings, null = missing
            assert f"{year}_SeqOrder" in record
            assert (record[year] is None) == (record[f"{year}_SeqOrder"] is None)
        if name != "pct_publications_small.json":
            assert all(parse.parse_share(record[year]) is not None or record[year] is None for year in years)


def test_pct_publications_values(small_lists):
    publications = collect(FakeClient(), TODAY)["pct_publications"]
    assert sorted(publications) == ["**", "AM", "CH", "DE", "US", "VA", "ZZ"]
    assert publications["CH"] == {2022: 5100, 2023: 5200, 2024: 5302, 2025: 5350}  # 2026 trimmed
    assert publications["ZZ"][2025] == 265154
    assert publications["VA"] == {year: None for year in GENDER_YEARS}


def test_pct_publications_label_check(small_lists):
    def mutate(raw):
        raw["recordInfo"]["indicator"] = "5a - PCT publications by technology"
    with pytest.raises(SchemaError, match="pct_publications: recordInfo indicator"):
        collect_all({"pct_publications_small.json": mutate})


def test_pct_publications_world_null_last_year(small_lists):
    with pytest.raises(SchemaError, match="pct_publications: World row ZZ has no value for 2025"):
        collect_all({"pct_publications_small.json": set_cell("Total", "2025", None)})


def test_pct_publications_total_class_required(small_lists):
    with pytest.raises(SchemaError, match="pct_publications: no class 'Total'"):
        collect_all({"pct_publications_list_small.json": lambda raw: raw["pmhClassList"].pop("109")})


def test_gender_series_pinned():
    assert [(g.id, g.indicator, g.by) for g in GENDER_SERIES] == [
        ("women_any", "1040", "origin"), ("women_share", "1042", "origin"), ("women_any_by_field", "1041", "field")]
    assert collect_module.GENDER_FROM == 2000 and collect_module.GENDER_MIN_COUNTRY_ROWS == 80
    assert collect_module.GENDER_LAST_YEAR_ROW_SHARE_MIN == 0.85


def test_gender_labels_name_publication_year():
    assert all(g.label.endswith("by publication year") for g in GENDER_SERIES)
    assert [g.label for g in GENDER_SERIES][1] == "Women's share of PCT inventors, by publication year"
