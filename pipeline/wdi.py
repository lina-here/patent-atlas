"""World Bank WDI denominators for the ratio figures: population and GDP PPP, every country, one request each.

Research `docs/research/2026-10-20-wipo-ratio-indicators.md` §2/§4: WIPO divides by WDI `SP.POP.TOTL` and
`NY.GDP.MKTP.PP.KD`. Rows keyed by WIPO code (inverse `entities.ISO2_TO_ISO3`); `WDI_WORLD` -> `world`; WDI
aggregates and codes without a WIPO country code skipped. GDP base year comes from WDI's indicator name
(`gdp_base_year`), never from WIPO's stale "(2017 PPP)" label. Raw responses stay in memory; any unexpected shape
-> CheckError.
"""
from __future__ import annotations

import datetime
import math
import re
from dataclasses import dataclass

from pipeline.crosscheck import CheckError, Fetch, wdi_last_updated, wdi_rows
from pipeline.entities import ISO2_TO_ISO3

WDI_DENOMINATORS = {"population": "SP.POP.TOTL", "gdp_ppp": "NY.GDP.MKTP.PP.KD"}
WDI_ALL_URL = ("https://api.worldbank.org/v2/country/all/indicator/{indicator}"
               "?format=json&date={first}:{last}&per_page=20000")
WDI_WORLD = "WLD"
WDI_MAX_LAG = 2  # years WDI's World row may trail the last requested year (WDI lags ~1 year); scale.method_constants
_CODE_BY_ISO3 = {code_iso3: code for code, code_iso3 in ISO2_TO_ISO3.items()}
_GDP_BASE_PATTERN = re.compile(r"constant (\d{4}) international \$")


@dataclass
class Denominator:
    indicator: str
    name: str  # WDI indicator name as served, e.g. "GDP, PPP (constant 2021 international $)"
    values: dict[str, dict[int, float | None]]  # WIPO code -> year (first..last) -> value; only codes WDI serves
    world: dict[int, float | None]  # WDI_WORLD row, every year first..last
    last_updated: datetime.date | None  # page metadata `lastupdated`; None = missing or unparseable


def parse_denominator(text: str, indicator: str, first: int, last: int) -> Denominator:
    """World Bank v2 `country/all` response -> Denominator. Beyond `wdi_rows`: no rows, a name that is empty or
    differs between rows, no WLD value in last-WDI_MAX_LAG..last (truncated response), and on kept rows a year
    outside first..last, a duplicate (code, year), or a value that is not a non-negative number -> CheckError.
    Years WDI has not filled stay None (ratio cells: no_population / no_gdp)."""
    meta, rows = wdi_rows(text, indicator)
    if not rows:
        raise CheckError(f"WDI {indicator}: no rows")
    name = rows[0]["indicator"].get("value")
    if not isinstance(name, str) or not name.strip():
        raise CheckError(f"WDI {indicator}: indicator name {name!r} is not a non-empty string")
    differing = [row["indicator"].get("value") for row in rows if row["indicator"].get("value") != name]
    if differing:
        raise CheckError(f"WDI {indicator}: rows differ in indicator name ({name!r}, {differing[0]!r})")
    years = range(first, last + 1)
    values: dict[str, dict[int, float | None]] = {}
    world: dict[int, float | None] = dict.fromkeys(years)
    seen: set[tuple[str, int]] = set()
    for row in rows:
        iso3 = row.get("countryiso3code")
        if iso3 == WDI_WORLD:
            code, target = WDI_WORLD, world
        elif iso3 in _CODE_BY_ISO3:
            code = _CODE_BY_ISO3[iso3]
            target = values.setdefault(code, dict.fromkeys(years))
        else:
            continue  # WDI aggregate (AFE, EUU, ...) or no WIPO country code (XKX, CHI)
        date = row.get("date")
        if not (isinstance(date, str) and re.fullmatch(r"\d{4}", date) and first <= int(date) <= last):
            raise CheckError(f"WDI {indicator}: {code} year {date!r} outside {first}-{last}")
        year = int(date)
        if (code, year) in seen:
            raise CheckError(f"WDI {indicator}: duplicate row {code} {date}")
        seen.add((code, year))
        value = row.get("value")
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                  or not math.isfinite(value) or value < 0):
            raise CheckError(f"WDI {indicator}: {code} {date} value {value!r} is not a non-negative number")
        target[year] = None if value is None else float(value)
    recent = range(max(first, last - WDI_MAX_LAG), last + 1)
    if all(world[year] is None for year in recent):
        raise CheckError(f"WDI {indicator}: world row {WDI_WORLD} has no value in {recent[0]}-{last}")
    return Denominator(indicator, name, values, world, wdi_last_updated(meta))


def fetch_denominators(first: int, last: int, fetch: Fetch) -> dict[str, Denominator]:
    """{"population", "gdp_ppp"} -> Denominator, years first..last; one request per indicator."""
    return {key: parse_denominator(fetch(WDI_ALL_URL.format(indicator=indicator, first=first, last=last),
                                         "application/json"), indicator, first, last)
            for key, indicator in WDI_DENOMINATORS.items()}


def gdp_base_year(name: str) -> int:
    """Price base of a WDI GDP indicator name ("GDP, PPP (constant 2021 international $)" -> 2021); a name without
    "constant <year> international $" -> CheckError (label must never guess the base)."""
    match = _GDP_BASE_PATTERN.search(name)
    if match is None:
        raise CheckError(f"WDI GDP indicator name {name!r} names no constant international $ base year")
    return int(match.group(1))
