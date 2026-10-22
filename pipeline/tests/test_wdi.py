import datetime
import json

import pytest

from pipeline import wdi
from pipeline.crosscheck import CheckError
from pipeline.wdi import (
    WDI_ALL_URL,
    WDI_DENOMINATORS,
    Denominator,
    fetch_denominators,
    gdp_base_year,
    parse_denominator,
)

POPULATION = "SP.POP.TOTL"
POPULATION_NAME = "Population, total"
GDP = "NY.GDP.MKTP.PP.KD"
GDP_NAME = "GDP, PPP (constant 2021 international $)"


def payload(rows, indicator=POPULATION, name=POPULATION_NAME, pages=1, lastupdated="2026-10-08"):
    """World Bank v2 `country/all` response (hand-made); rows = (iso3, date, value[, name])."""
    meta = {"page": 1, "pages": pages, "per_page": 20000, "total": len(rows), "sourceid": "2"}
    if lastupdated is not None:
        meta["lastupdated"] = lastupdated

    def row(iso3, date, value, row_name=name):
        return {"indicator": {"id": indicator, "value": row_name}, "country": {"id": iso3[:2], "value": iso3},
                "countryiso3code": iso3, "date": date, "value": value, "unit": "", "obs_status": "", "decimal": 0}
    return json.dumps([meta, [row(*r) for r in rows]])


ROWS = [("CHE", "2024", 8_960_000), ("CHE", "2023", None), ("WLD", "2024", 8_100_000_000.0),
        ("WLD", "2023", None), ("AFE", "2024", 750_000_000), ("", "2024", 5), ("XKX", "2024", 1_700_000)]


def test_parse_denominator_maps_iso3_world_and_skips_aggregates():
    result = parse_denominator(payload(ROWS), POPULATION, 2023, 2024)
    assert isinstance(result, Denominator)
    assert result.indicator == POPULATION and result.name == POPULATION_NAME
    assert result.values == {"CH": {2023: None, 2024: 8960000.0}}  # AFE, "" and XKX (no WIPO code) skipped
    assert isinstance(result.values["CH"][2024], float)
    assert result.world == {2023: None, 2024: 8.1e9}
    assert result.last_updated == datetime.date(2026, 10, 8)


def test_parse_denominator_fills_missing_years_with_none():
    rows = [("CHE", "2024", 8_960_000), ("WLD", "2024", 8.1e9)]
    result = parse_denominator(payload(rows), POPULATION, 2022, 2024)
    assert result.values == {"CH": {2022: None, 2023: None, 2024: 8960000.0}}
    assert result.world == {2022: None, 2023: None, 2024: 8.1e9}


def test_wdi_max_lag():
    assert wdi.WDI_MAX_LAG == 2  # WDI trails about a year (controller ruling, Task 3a)


@pytest.mark.parametrize("year", ["2024", "2023", "2022"])  # last, last-1, last-2
def test_parse_denominator_accepts_world_value_within_max_lag(year):
    rows = [("CHE", "2024", 8_960_000), ("WLD", year, 8.0e9), ("WLD", "2020", 7.8e9)]
    result = parse_denominator(payload(rows), POPULATION, 2020, 2024)
    assert result.world[int(year)] == 8.0e9 and result.world[2024] == (8.0e9 if year == "2024" else None)


@pytest.mark.parametrize("rows", [
    [("CHE", "2024", 8_960_000)],  # no WLD row
    [("CHE", "2024", 8_960_000), ("WLD", "2024", None), ("WLD", "2023", None), ("WLD", "2022", None)],
    [("CHE", "2024", 8_960_000), ("WLD", "2021", 8.0e9), ("WLD", "2020", 7.9e9)],  # WLD only before last-2
])
def test_parse_denominator_requires_world_value_within_max_lag(rows):
    with pytest.raises(CheckError, match="world row WLD has no value in 2022-2024"):
        parse_denominator(payload(rows), POPULATION, 2020, 2024)


def test_parse_denominator_reads_gdp_name():
    result = parse_denominator(payload([("USA", "2024", 2.9e13), ("WLD", "2024", 1.9e14)], GDP, GDP_NAME), GDP, 2024, 2024)
    assert result.name == GDP_NAME
    assert result.values["US"][2024] == 2.9e13


def test_parse_denominator_missing_lastupdated_is_none():
    assert parse_denominator(payload(ROWS, lastupdated=None), POPULATION, 2023, 2024).last_updated is None


@pytest.mark.parametrize("text, message", [
    (payload([("CHE", "2022", 1)]), "year"),
    (payload([("CHE", "20x4", 1)]), "year"),
    (payload([("CHE", "2024", 1), ("CHE", "2024", 2)]), "duplicate"),
    (payload([("WLD", "2024", 1), ("WLD", "2024", 2)]), "duplicate"),
    (payload([("CHE", "2024", "8960000")]), "value"),
    (payload([("CHE", "2024", True)]), "value"),
    (payload([("CHE", "2024", -1)]), "value"),
    (payload([("WLD", "2024", -0.5)]), "value"),
    (payload([("CHE", "2024", 1), ("DEU", "2024", 2, "Population, female")]), "name"),
    (payload([("CHE", "2024", 1)], name=""), "name"),
    (payload([("CHE", "2024", 1), ("DEU", "2024", 2, None)]), "name"),
    (payload([("CHE", "2024", 1)], name={"x": 1}), "name"),
    (payload([]), "no rows"),
    (payload([("CHE", "2024", 1)], pages=2), "pages"),  # shared wdi_rows check
    (payload([("CHE", "2024", 1)], indicator=GDP), "indicator"),  # shared wdi_rows check
])
def test_parse_denominator_rejects(text, message):
    with pytest.raises(CheckError, match=message):
        parse_denominator(text, POPULATION, 2023, 2024)


def test_gdp_base_year():
    assert gdp_base_year("GDP, PPP (constant 2021 international $)") == 2021
    for name in ("GDP, PPP (current international $)", "GDP (constant 2015 US$)", ""):
        with pytest.raises(CheckError, match="base year"):
            gdp_base_year(name)


def test_fetch_denominators_one_request_per_indicator():
    assert WDI_DENOMINATORS == {"population": POPULATION, "gdp_ppp": GDP}
    calls = []

    def fetch(url, accept):
        calls.append((url, accept))
        indicator = GDP if GDP in url else POPULATION
        name = GDP_NAME if indicator == GDP else POPULATION_NAME
        return payload([("CHE", "2024", 1.0), ("WLD", "2024", 2.0)], indicator, name)

    result = fetch_denominators(1990, 2024, fetch)
    assert list(result) == ["population", "gdp_ppp"]
    assert result["gdp_ppp"].name == GDP_NAME and result["population"].values["CH"][2024] == 1.0
    assert calls == [
        ("https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=1990:2024&per_page=20000",
         "application/json"),
        ("https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.PP.KD?format=json&date=1990:2024"
         "&per_page=20000", "application/json")]
    assert WDI_ALL_URL.format(indicator=GDP, first=1990, last=2024) == calls[1][0]
    assert wdi.WDI_WORLD == "WLD"
