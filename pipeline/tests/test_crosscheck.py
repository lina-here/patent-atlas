import datetime
import json
import re
import urllib.error
from pathlib import Path

import pytest

from pipeline import crosscheck
from pipeline.crosscheck import (
    CheckError,
    Fetcher,
    fetch_wdi,
    golden_compare,
    load_golden,
    oecd_trend,
    parse_wdi,
    release_month,
    wdi_compare,
    wdi_timing,
    wdi_years,
    world_check,
)


# WDI (World Bank, office-based resident / non-resident)

def test_wdi_years_skip_latest():
    assert wdi_years(2024) == (2020, 2023)


def test_wdi_blank_skipped():
    ours = {("CH", 2022, "resident"): 1231, ("CH", 2023, "resident"): None, ("US", 2023, "resident"): 5}
    wdi = {("CH", 2022, "resident"): None, ("CH", 2023, "resident"): 1190}  # US 2023 absent at WDI
    assert wdi_compare(ours, wdi) == []


def test_wdi_mismatch_reported():
    ours = {("CH", 2022, "resident"): 1231, ("DE", 2021, "nonresident"): 18747}
    wdi = {("CH", 2022, "resident"): 1231, ("DE", 2021, "nonresident"): 18748}
    assert wdi_compare(ours, wdi) == ["WDI DE 2021 nonresident: WIPO 18747, World Bank 18748"]


def wdi_payload(rows, indicator="IP.PAT.RESD", pages=1, lastupdated="2026-10-08"):
    """World Bank v2 response; lastupdated None = key absent from the page metadata."""
    meta = {"page": 1, "pages": pages, "per_page": 1000, "total": len(rows)}
    if lastupdated is not None:
        meta["lastupdated"] = lastupdated
    return json.dumps([
        meta,
        [{"indicator": {"id": indicator, "value": "x"}, "countryiso3code": iso3, "date": date, "value": value}
         for iso3, date, value in rows],
    ])


WDI_FIXTURE = Path(__file__).parent / "fixtures" / "wdi_resd_small.json"


def test_parse_wdi_maps_iso3_to_wipo_code():
    text = wdi_payload([("CHE", "2023", 1190), ("CHE", "2022", None), ("MDG", "2023", 2.0)])
    assert parse_wdi(text, "IP.PAT.RESD", {"CHE": "CH", "MDG": "MG"}, 2020, 2023).cells == {
        ("CH", 2023, "resident"): 1190, ("CH", 2022, "resident"): None, ("MG", 2023, "resident"): 2}


def test_parse_wdi_reads_lastupdated_from_page_metadata():
    wdi = parse_wdi(WDI_FIXTURE.read_text(encoding="utf-8"), "IP.PAT.RESD", {"CHE": "CH", "MDG": "MG"}, 2020, 2023)
    assert wdi.last_updated == datetime.date(2026, 3, 27)
    assert wdi.cells == {("CH", 2023, "resident"): 1190, ("CH", 2022, "resident"): None, ("MG", 2023, "resident"): 2}


@pytest.mark.parametrize("lastupdated", [None, "", "2026-13-01", "27/03/2026", 20260327])
def test_parse_wdi_missing_or_bad_lastupdated_is_none(lastupdated):
    payload = json.loads(WDI_FIXTURE.read_text(encoding="utf-8"))
    if lastupdated is None:
        del payload[0]["lastupdated"]
    else:
        payload[0]["lastupdated"] = lastupdated
    wdi = parse_wdi(json.dumps(payload), "IP.PAT.RESD", {"CHE": "CH", "MDG": "MG"}, 2020, 2023)
    assert wdi.last_updated is None


@pytest.mark.parametrize("text, expected", [
    ("Last updated: May 2026", (2026, 5)),
    ("Last updated:  september 2025 ", (2025, 9)),
    ("Last updated: Sept 2026", None),
    ("May 2026", None),
    ("", None),
    (None, None),
])
def test_release_month(text, expected):
    assert release_month(text) == expected


# Revision timing: WDI older than the WIPO patent release -> mismatches warn; as recent or newer -> block

@pytest.mark.parametrize("last_updated, release, warn", [
    (datetime.date(2026, 4, 30), "Last updated: May 2026", True),   # older: WIPO revisions not yet in WDI
    (datetime.date(2025, 12, 1), "Last updated: May 2026", True),
    (datetime.date(2026, 5, 1), "Last updated: May 2026", False),   # same month: block
    (datetime.date(2026, 7, 1), "Last updated: May 2026", False),   # newer: block
    (None, "Last updated: May 2026", False),                       # missing date: fail safe
    (datetime.date(2026, 4, 30), "Updated in spring", False),       # unparseable release: fail safe
])
def test_wdi_timing(last_updated, release, warn):
    is_warning, reason = wdi_timing(last_updated, release)
    assert is_warning is warn
    assert reason  # always explained, for the manifest (warn) or the blocking message (block)


def test_wdi_timing_reason_names_both_dates():
    _, reason = wdi_timing(datetime.date(2026, 4, 30), "Last updated: May 2026")
    assert "2026-04-30" in reason and "May 2026" in reason
    _, reason = wdi_timing(None, "Last updated: May 2026")
    assert "lastupdated" in reason


@pytest.mark.parametrize("text, message", [
    ('[{"message": [{"id": "120", "key": "Invalid value"}]}]', "World Bank API error"),
    ("<html>", "not JSON"),
    (wdi_payload([("CHE", "2023", 1)], pages=2), "pages"),
    (wdi_payload([("CHE", "2023", 1)], indicator="IP.PAT.NRES"), "indicator"),
    (wdi_payload([("FRA", "2023", 1)]), "country"),
    (wdi_payload([("CHE", "2019", 1)]), "year"),
    (wdi_payload([("CHE", "2023", 1.5)]), "value"),
    (wdi_payload([("CHE", "2023", "1190")]), "value"),
    (wdi_payload([("CHE", "2023", 1), ("CHE", "2023", 1)]), "duplicate"),
])
def test_parse_wdi_rejects_bad_shapes(text, message):
    with pytest.raises(CheckError, match=message):
        parse_wdi(text, "IP.PAT.RESD", {"CHE": "CH"}, 2020, 2023)


def test_wdi_rows_returns_page_metadata_and_rows():
    meta, rows = crosscheck.wdi_rows(wdi_payload([("CHE", "2023", 1190), ("FRA", "2019", "x")]), "IP.PAT.RESD")
    assert (meta["pages"], meta["lastupdated"]) == (1, "2026-10-08")
    assert [(r["countryiso3code"], r["value"]) for r in rows] == [("CHE", 1190), ("FRA", "x")]  # no row mapping
    assert crosscheck.wdi_rows(json.dumps([{"page": 1, "pages": 1}, None]), "IP.PAT.RESD")[1] == []


@pytest.mark.parametrize("text, message", [
    ('[{"message": [{"id": "120", "key": "Invalid value"}]}]', "World Bank API error"),
    ("<html>", "not JSON"),
    ('{"page": 1}', "unexpected response shape"),
    (json.dumps([{"page": 1, "pages": 1}, {"rows": []}]), "rows are not a list"),
    (json.dumps([{"page": 1, "pages": 1}, [{"indicator": "IP.PAT.RESD"}]]), "malformed row"),
    (wdi_payload([("CHE", "2023", 1)], pages=2), "2 pages, expected 1"),
    (wdi_payload([("CHE", "2023", 1)], indicator="IP.PAT.NRES"), "row for indicator 'IP.PAT.NRES'"),
])
def test_wdi_rows_rejects_bad_shapes(text, message):
    with pytest.raises(CheckError, match=message):
        crosscheck.wdi_rows(text, "IP.PAT.RESD")


def test_fetch_wdi_requests_both_indicators():
    urls = []

    def fetch(url, accept):
        urls.append(url)
        indicator = "IP.PAT.RESD" if "IP.PAT.RESD" in url else "IP.PAT.NRES"
        return wdi_payload([("CHE", "2023", 1190 if indicator == "IP.PAT.RESD" else 271)], indicator=indicator)

    result = fetch_wdi(["CH"], 2020, 2023, fetch)
    assert result.cells == {("CH", 2023, "resident"): 1190, ("CH", 2023, "nonresident"): 271}
    assert result.last_updated == datetime.date(2026, 10, 8)
    assert urls == [
        "https://api.worldbank.org/v2/country/CHE/indicator/IP.PAT.RESD?format=json&date=2020:2023&per_page=1000",
        "https://api.worldbank.org/v2/country/CHE/indicator/IP.PAT.NRES?format=json&date=2020:2023&per_page=1000",
    ]


@pytest.mark.parametrize("dates, expected", [
    (("2026-03-27", "2026-04-02"), datetime.date(2026, 4, 2)),  # newest of the two: warn only if both are older
    (("2026-03-27", None), None),                               # one missing: unknown, fail safe
])
def test_fetch_wdi_last_updated_across_indicators(dates, expected):
    def fetch(url, accept):
        first = "IP.PAT.RESD" in url
        indicator = "IP.PAT.RESD" if first else "IP.PAT.NRES"
        return wdi_payload([("CHE", "2023", 1)], indicator=indicator, lastupdated=dates[0 if first else 1])

    assert fetch_wdi(["CH"], 2020, 2023, fetch).last_updated == expected


def test_fetch_wdi_rejects_non_country_code():
    with pytest.raises(CheckError, match="ISO3"):
        fetch_wdi(["EP"], 2020, 2023, lambda url, accept: "")


# Fetcher: polite, errors -> CheckError

def test_fetcher_http_error_is_check_error():
    def opener(request):
        raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)

    with pytest.raises(CheckError, match="HTTP 503"):
        Fetcher(opener=opener, sleep=lambda s: None).get("https://example.org/x", "application/json")


def test_fetcher_network_error_is_check_error():
    def opener(request):
        raise TimeoutError("timed out")

    with pytest.raises(CheckError, match="timed out"):
        Fetcher(opener=opener, sleep=lambda s: None).get("https://example.org/x", "application/json")


def test_fetcher_polite():
    seen, sleeps = [], []

    def opener(request):
        seen.append((request.full_url, request.get_header("User-agent"), request.get_header("Accept")))
        return b"ok"

    fetcher = Fetcher(opener=opener, sleep=sleeps.append)
    assert fetcher.get("https://example.org/a", "text/csv") == "ok"
    assert fetcher.get("https://example.org/b", "text/csv") == "ok"
    assert sleeps == [1.0]
    assert seen[0] == ("https://example.org/a", crosscheck.USER_AGENT, "text/csv")


# Golden figures from WIPO publications

GOLDEN = [{"id": "world_2024", "description": "d", "value": 1000, "year": 2024, "series": "office_apps",
           "code_or_world": "world", "citation": "c", "url": "u", "page": "p"}]


def test_golden_within_1pct_passes():
    for live in (1000, 1010, 990):  # exactly 1% passes
        failures, notes = golden_compare(GOLDEN, lambda entry: live)
        assert failures == []
        assert len(notes) == 1 and notes[0].startswith("world_2024: live")


def test_golden_over_1pct_fails():
    for live in (1011, 989):
        failures, notes = golden_compare(GOLDEN, lambda entry: live)
        assert notes == []
        assert len(failures) == 1 and "world_2024" in failures[0] and "1%" in failures[0]


def test_golden_float_live():
    """Ratio figures: WIPI prints whole numbers, the Data Center one decimal (CN per GDP 2024, research note §2)."""
    golden = [{**GOLDEN[0], "id": "per_gdp_cn_2024", "value": 4977, "series": "per_gdp", "code_or_world": "CN"}]
    failures, notes = golden_compare(golden, lambda entry: 4976.5)
    assert failures == [] and notes == ["per_gdp_cn_2024: live 4976.5 vs published 4977 (-0.01%)"]
    failures, notes = golden_compare(golden, lambda entry: 4927.23)  # gap 49.77 = exactly 1% (float math: 49.770...04)
    assert failures == [] and len(notes) == 1
    failures, notes = golden_compare(golden, lambda entry: 4927.2)
    assert notes == [] and failures == ["per_gdp_cn_2024: live 4927.2 vs published 4977 (-1.00%), over 1% "
                                        "(per_gdp CN 2024)"]


def test_golden_no_live_value_fails():
    failures, notes = golden_compare(GOLDEN, lambda entry: None)
    assert notes == [] and "no live value" in failures[0]


def test_golden_file_valid():
    golden = load_golden()
    assert len(golden) == 11
    assert {entry["series"] for entry in golden} == {"office_apps", "origin_apps", "pct_origin", "per_gdp",
                                                     "per_million", "women_any", "women_share", "world_office_yoy",
                                                     "pct_world_yoy"}
    for entry in golden:
        assert set(entry) == crosscheck.GOLDEN_KEYS
        assert isinstance(entry["value"], (int, float)) and not isinstance(entry["value"], bool)
        assert entry["series"] in crosscheck.GOLDEN_GROWTH_SERIES or entry["value"] > 0  # growth: any sign
        assert entry["url"].startswith("https://www.wipo.int/") and entry["page"]


def test_repo_golden_has_pct_2025():
    """Audit F3: the newest PCT year shown has a golden figure (PCT Yearly Review 2026, table A9 row Total)."""
    entry = {item["id"]: item for item in load_golden()}["pct_applications_2025"]
    assert (entry["value"], entry["year"], entry["series"], entry["code_or_world"]) == (275900, 2025, "pct_origin", "world")
    assert entry["url"] == ("https://www.wipo.int/edocs/pubdocs/en/"
                            "wipo-pub-901-2026-en-patent-cooperation-treaty-yearly-review-2026.pdf")
    assert entry["citation"].startswith("World Intellectual Property Organization (WIPO) (2026). PCT Yearly Review "
                                        "2026: The International Patent System.")  # WIPO's own title
    if "DOI:" in entry["citation"]:  # read from the PDF's front matter, never derived
        assert re.search(r"DOI: 10\.\d{4,9}/\S+$", entry["citation"])
    assert "WIPO estimate, rounded to hundreds" in entry["description"]


WIPI_2025_URL = ("https://www.wipo.int/edocs/pubdocs/en/"
                 "wipo-pub-941-2025-en-world-intellectual-property-indicators-2025.pdf")


@pytest.mark.parametrize("golden_id, value, series, code, figure", [
    ("per_gdp_cn_2024", 4977, "per_gdp", "CN", "figure A37"),
    ("per_million_kr_2024", 3783, "per_million", "KR", "figure A38"),
])
def test_repo_golden_has_ratio_figures(golden_id, value, series, code, figure):
    """WIPI 2025 figures A37 / A38 (research note §2), page read from the PDF (Task 3a Step 1)."""
    entry = {item["id"]: item for item in load_golden()}[golden_id]
    assert (entry["value"], entry["year"], entry["series"], entry["code_or_world"]) == (value, 2024, series, code)
    assert entry["url"] == WIPI_2025_URL
    assert entry["citation"].endswith("World Intellectual Property Indicators 2025. Geneva: WIPO. "
                                      "DOI: 10.34667/tind.58959")
    assert entry["page"].startswith(f"p. 45 (PDF p. 47), {figure} ")


PCT_YR_2026_URL = ("https://www.wipo.int/edocs/pubdocs/en/"
                   "wipo-pub-901-2026-en-patent-cooperation-treaty-yearly-review-2026.pdf")


@pytest.mark.parametrize("golden_id, value, series, code, page", [
    ("women_any_world_2025", 38.1, "women_any", "world", "p. 28 (PDF p. 29), "),
    ("women_share_world_2025", 18.1, "women_share", "world", "p. 28 (PDF p. 29), "),
    ("women_share_es_2025", 28.7, "women_share", "ES", "p. 9 (PDF p. 10), "),
])
def test_repo_golden_has_gender_figures(golden_id, value, series, code, page):
    """PCT Yearly Review 2026 (Task 2a Step 1): World 1040 / 1042 and Spain's 1042, 2025, printed as numbers."""
    entry = {item["id"]: item for item in load_golden()}[golden_id]
    assert (entry["value"], entry["year"], entry["series"], entry["code_or_world"]) == (value, 2025, series, code)
    assert entry["url"] == PCT_YR_2026_URL
    pct_2025 = {item["id"]: item for item in load_golden()}["pct_applications_2025"]
    assert entry["citation"] == pct_2025["citation"]
    assert entry["page"].startswith(page)
    assert "publication year" in entry["description"]


@pytest.mark.parametrize("golden_id, value, year, series, same_publication_as, page", [
    ("world_patent_growth_2024", 4.9, 2024, "world_office_yoy", "world_patent_applications_2024",
     "p. 7 (PDF p. 9), table 'IP filing activity by origin'"),
    ("pct_growth_2025", 0.7, 2025, "pct_world_yoy", "pct_applications_2025", "p. 16 (PDF p. 17), table A9"),
])
def test_repo_golden_has_growth_figures(golden_id, value, year, series, same_publication_as, page):
    """Spec 2a amendments: world change on the key-figure tiles checked against WIPO's printed growth, same
    publication (citation, URL) as the world count it grows from; description quotes the printed row."""
    by_id = {item["id"]: item for item in load_golden()}
    entry, count = by_id[golden_id], by_id[same_publication_as]
    assert (entry["value"], entry["year"], entry["series"], entry["code_or_world"]) == (value, year, series, "world")
    assert (entry["citation"], entry["url"]) == (count["citation"], count["url"])
    assert entry["page"].startswith(page)
    assert crosscheck.GOLDEN_GROWTH_SERIES[series] in ("world_office", "pct_world")


GROWTH = {**GOLDEN[0], "id": "pct_growth_2025", "value": 0.7, "year": 2025, "series": "pct_world_yoy"}


def write_golden(tmp_path, entries):
    path = tmp_path / "golden.json"
    path.write_text(json.dumps(entries), encoding="utf-8")
    return path


@pytest.mark.parametrize("value", [-3.7, 0, 0.0, -0.1, 12, 4.9])
def test_golden_growth_negative_value_loads(tmp_path, value):
    """A growth figure may be negative or zero (counts and shares stay positive)."""
    assert load_golden(write_golden(tmp_path, [{**GROWTH, "value": value}]))[0]["value"] == value


@pytest.mark.parametrize("value", [0.75, -3.75, 0.05, True, "0.7", float("nan"), float("inf")])
def test_golden_growth_two_decimals_rejected(tmp_path, value):
    """WIPO prints growth with one decimal: a second decimal (or a non-number) is a typo, never compared."""
    with pytest.raises(CheckError, match="golden"):
        load_golden(write_golden(tmp_path, [{**GROWTH, "value": value}]))


def test_golden_growth_within_tolerance_passes():
    """|live - published| <= GOLDEN_GROWTH_TOLERANCE_PP (absolute pp, exact Decimal): one printed rounding unit."""
    assert crosscheck.GOLDEN_GROWTH_TOLERANCE_PP == 0.1
    for live in (0.6, 0.7, 0.8):
        failures, notes = golden_compare([GROWTH], lambda entry: live)
        assert failures == [] and len(notes) == 1, live
    for live in (0.5, 0.9, -0.7):
        failures, notes = golden_compare([GROWTH], lambda entry: live)
        assert notes == [] and len(failures) == 1, live


def test_golden_growth_negative_published():
    entry = {**GROWTH, "value": -3.7}
    assert golden_compare([entry], lambda entry: -3.6)[0] == []
    assert golden_compare([entry], lambda entry: -3.8)[0] == []
    assert len(golden_compare([entry], lambda entry: -3.9)[0]) == 1
    assert len(golden_compare([entry], lambda entry: 3.7)[0]) == 1  # sign matters


@pytest.mark.parametrize("published", [0, 0.0])
def test_golden_growth_zero_published(published):
    """Absolute tolerance: a printed 0.0 needs no division."""
    entry = {**GROWTH, "value": published}
    for live in (0.0, 0.1, -0.1):
        failures, notes = golden_compare([entry], lambda entry: live)
        assert failures == [] and len(notes) == 1, live
    failures, notes = golden_compare([entry], lambda entry: 0.2)
    assert notes == [] and len(failures) == 1


def test_golden_growth_line_format():
    failures, notes = golden_compare([GROWTH], lambda entry: 0.6)
    assert notes == ["pct_growth_2025: live 0.6 vs published 0.7 (-0.1 pp)"]
    failures, notes = golden_compare([GROWTH], lambda entry: 0.7)
    assert notes == ["pct_growth_2025: live 0.7 vs published 0.7 (+0.0 pp)"]
    failures, notes = golden_compare([GROWTH], lambda entry: 0.5)
    assert failures == ["pct_growth_2025: live 0.5 vs published 0.7 (-0.2 pp), over 0.1 pp (pct_world_yoy world 2025)"]
    failures, notes = golden_compare([GROWTH], lambda entry: None)
    assert failures == ["pct_growth_2025: no live value for pct_world_yoy world 2025"]


def test_golden_growth_and_count_entries_side_by_side():
    """Other entries keep the relative tolerance (%), growth entries the absolute one (pp)."""
    live = {"world_2024": 1010, "pct_growth_2025": 0.8}
    failures, notes = golden_compare([GOLDEN[0], GROWTH], lambda entry: live[entry["id"]])
    assert failures == []
    assert notes == ["world_2024: live 1010 vs published 1000 (+1.00%)",
                     "pct_growth_2025: live 0.8 vs published 0.7 (+0.1 pp)"]


def test_golden_float_published():
    """Gender golden figures are shares with one decimal: tolerance stays relative to the printed value."""
    golden = [{**GOLDEN[0], "id": "women_share_world_2025", "value": 18.1, "series": "women_share"}]
    failures, notes = golden_compare(golden, lambda entry: 18.2)  # +0.55%
    assert failures == [] and notes == ["women_share_world_2025: live 18.2 vs published 18.1 (+0.55%)"]
    failures, notes = golden_compare(golden, lambda entry: 18.3)  # +1.10%: 0.2 pp is over 1% of 18.1
    assert notes == [] and failures == ["women_share_world_2025: live 18.3 vs published 18.1 (+1.10%), over 1% "
                                        "(women_share world 2024)"]


@pytest.mark.parametrize("value", [True, 0, -1.5, "18.1", float("nan"), float("inf"), float("-inf")])
def test_load_golden_rejects_bad_value(tmp_path, value):
    path = tmp_path / "golden.json"
    path.write_text(json.dumps([{**GOLDEN[0], "value": value}]), encoding="utf-8")
    with pytest.raises(CheckError, match="golden"):
        load_golden(path)


def test_load_golden_rejects_bad_entry(tmp_path):
    path = tmp_path / "golden.json"
    path.write_text(json.dumps([{"id": "x"}]), encoding="utf-8")
    with pytest.raises(CheckError, match="golden"):
        load_golden(path)


# World totals: WIPO's published total vs our sum of entities

def test_world_check_sum_above_published_blocks():
    failures, warnings = world_check("world_office", {2023: 100, 2024: 100}, {2023: 99, 2024: 101}, 2024)
    assert failures == ["world_office 2024: sum of entities 101 > WIPO total 100"]
    assert warnings == []


def test_world_check_known_excess_year_warns():
    failures, warnings = world_check("world_office", {1990: 100}, {1990: 102}, 1990, known_excess_years={1990})
    assert failures == []
    assert warnings == ["world_office 1990: sum of entities 102 > WIPO total 100 (known WIPO data quirk)"]


def test_world_check_low_coverage_warns_only_up_to_last_year():
    published = {2022: 100, 2023: 100, 2024: 100}
    our_sum = {2022: 90, 2023: 89, 2024: 50}  # 2024 provisional: no warning
    failures, warnings = world_check("pct_world", published, our_sum, 2023)
    assert failures == []
    assert warnings == ["pct_world 2023: sum of entities 89 is 89.0% of WIPO total 100 (< 90%)"]


def test_world_check_skips_missing_years():
    assert world_check("world_office", {1980: None, 1981: 5}, {1980: 7, 1981: None}, 1981) == ([], [])


# OECD trend (warnings only)

OECD_CSV = (
    "DATAFLOW,REF_AREA,TIME_PERIOD,OBS_VALUE\n"
    "x,CHN,2021,100.5\nx,CHN,2022,110.0\nx,CHN,2023,99.0\n"
    "x,USA,2021,50\nx,USA,2022,51\nx,USA,2023,52\n"
)


def test_oecd_trend_direction_differs_warns():
    totals = {"CN": {2021: 100, 2022: 105, 2023: 110}, "US": {2021: 50, 2022: 51, 2023: 53}, "EU": {2023: 10**6}}
    warnings = oecd_trend(totals, 2023, lambda url, accept: OECD_CSV)
    assert warnings == ["OECD trend CN 2023: WIPO PCT +4.8% vs OECD -10.0% (direction differs)"]


def test_oecd_trend_small_opposite_changes_ignored():
    csv = "REF_AREA,TIME_PERIOD,OBS_VALUE\nUSA,2022,100\nUSA,2023,99.5\n"
    assert oecd_trend({"US": {2022: 100, 2023: 101}}, 2023, lambda url, accept: csv) == []


def test_oecd_trend_fetch_error_is_warning():
    def fetch(url, accept):
        raise CheckError("HTTP 503 for oecd")

    warnings = oecd_trend({"US": {2023: 1}}, 2023, fetch)
    assert len(warnings) == 1 and "OECD trend check skipped" in warnings[0] and "503" in warnings[0]


def test_oecd_trend_garbage_is_warning():
    warnings = oecd_trend({"US": {2022: 1, 2023: 2}}, 2023, lambda url, accept: "<html>oops</html>")
    assert len(warnings) == 1 and "OECD trend check skipped" in warnings[0]


def test_oecd_trend_request_names_top_countries():
    urls = []

    def fetch(url, accept):
        urls.append((url, accept))
        return "REF_AREA,TIME_PERIOD,OBS_VALUE\n"

    totals = {code: {2023: value} for code, value in
              (("CN", 70), ("US", 55), ("JP", 48), ("KR", 22), ("DE", 16), ("FR", 7), ("ZZ", 999), ("SU", 500))}
    warnings = oecd_trend(totals, 2023, fetch)
    assert "CHN+USA+JPN+KOR+DEU" in urls[0][0] and "FRA" not in urls[0][0]
    assert urls[0][1].startswith("application/vnd.sdmx.data+csv")
    assert warnings == ["OECD trend: no overlapping years to compare"]


def test_fetcher_retries_5xx_and_timeouts_then_succeeds():
    calls, sleeps = [], []

    def opener(request):
        calls.append(request.full_url)
        if len(calls) == 1:
            raise TimeoutError("timed out")
        if len(calls) == 2:
            raise urllib.error.HTTPError(request.full_url, 502, "bad gateway", {}, None)
        return b"ok"

    assert Fetcher(opener=opener, sleep=sleeps.append).get("https://example.org/x", "text/csv") == "ok"
    assert len(calls) == 3 and sleeps == [2.0, 6.0]


def test_fetcher_4xx_not_retried():
    calls, sleeps = [], []

    def opener(request):
        calls.append(request.full_url)
        raise urllib.error.HTTPError(request.full_url, 400, "bad request", {}, None)

    with pytest.raises(CheckError, match="HTTP 400"):
        Fetcher(opener=opener, sleep=sleeps.append).get("https://example.org/x", "text/csv")
    assert len(calls) == 1 and sleeps == []


def test_sum_ratio_summary():
    published = {1980: None, 1981: 1000, 1982: 2000, 1983: 3000}
    our_sum = {1980: 5, 1981: 999, 1982: 1990, 1983: None}
    assert crosscheck.sum_ratio_summary(published, our_sum) == {"min": 0.995, "max": 0.999, "years": "1981-1982"}
    assert crosscheck.sum_ratio_summary({1990: None}, {1990: 1}) == {"min": None, "max": None, "years": None}


# PCT monthly vs yearly (warnings only)

def test_monthly_check():
    yearly = {2020: 120, 2021: 120, 2022: 120, 2023: None}
    months = {
        2020: [10] * 12,  # sum 120 == yearly: silent
        2021: [10] * 11 + [11],  # sum 121: mismatch
        2022: [10] * 6 + [None] * 6,  # short year (padded): visible, no sum compared
        2023: [10] * 12,  # no yearly total: nothing to compare
    }
    assert crosscheck.monthly_check(months, yearly) == [
        "PCT monthly 2021: sum of months 121 != WIPO yearly total (ZZ) 120",
        "PCT monthly 2022: 6 of 12 months not reported (shown null)",
    ]
