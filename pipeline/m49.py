"""UN M49 groupings of countries (continent, region) and successors of former entities.

`m49.json` = mapping built by `scripts/build_m49.py` from the UNSD M49 table (mapping only: UN terms forbid
copying the table), for `entities.json` countries only. Continent = M49 region with the Americas split (021 Northern
America, 419 Latin America and the Caribbean); region = M49 sub-region, intermediate region inside 419 and 202. Codes outside M49 (regional
offices, aggregates, former entities, TW) have no group. A region with the same members as a continent (021) is
the continent's page, not a separate one: `continent_equal_to`.
`successors.json` = hand-made from the data check (`docs/research/2026-10-20-v0.2a-data-check.md` §3): former
entity -> countries whose territory it covered, years it did. Spec rule: a successor counts as "reported under
<former>" only in those years when it has no value of its own and the former has one.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path

from pipeline.series import series_by_id

M49_PATH = Path(__file__).with_name("m49.json")
SUCCESSORS_PATH = Path(__file__).with_name("successors.json")

_M49 = json.loads(M49_PATH.read_text("utf-8"))
_COUNTRIES: dict[str, dict] = _M49["countries"]
_REGIONS: dict[str, dict] = _M49["regions"]

CONTINENTS: dict[str, str] = {slug: entry["label"] for slug, entry in _M49["continents"].items()}
M49_SOURCES: list[dict] = _M49["sources"]  # groups.json cites these

# WIPO's regional totals R1-R6 (labels = CONTINENTS labels; data check 2026-10-20 §1-2).
WIPO_CONTINENT_CODES: dict[str, str] = {
    "africa": "R1", "asia": "R2", "europe": "R3", "latin-america-caribbean": "R4", "northern-america": "R5",
    "oceania": "R6",
}
# Series whose WIPO tables list R1-R6 with values (data check §6: basis `wipo_total`); others use member sums.
SERIES_WITH_WIPO_CONTINENT_TOTALS = frozenset({"office_apps", "pct_origin"})

NO_GROUP: dict[str, str] = {"AQ": "Antarctica: M49 lists no region"}

_SUCCESSORS_FILE = json.loads(SUCCESSORS_PATH.read_text("utf-8"))
SUCCESSORS: dict[str, list[dict]] = _SUCCESSORS_FILE["successors"]
SUCCESSORS_SOURCES: list[dict] = _SUCCESSORS_FILE["sources"]


def continent_of(code: str) -> str | None:
    """Continent slug of a country code; None for codes with no M49 group."""
    entry = _COUNTRIES.get(code)
    return entry["continent"] if entry else None


def region_of(code: str) -> str | None:
    """M49 region id (3-digit string) of a country code; None for codes with no M49 group."""
    entry = _COUNTRIES.get(code)
    return entry["region"] if entry else None


def region_label(region_id: str) -> str:
    return _REGIONS[region_id]["label"]


def region_continent(region_id: str) -> str:
    """Continent slug a region id belongs to; KeyError for an unknown id."""
    return _REGIONS[region_id]["continent"]


def iso_numeric(code: str) -> str | None:
    """ISO 3166-1 numeric (= M49 code, 3-digit string); None for codes not in M49."""
    entry = _COUNTRIES.get(code)
    return entry["numeric"] if entry else None


def members(group_id: str) -> list[str]:
    """Sorted country codes of a region id or continent slug: every mapped country (any `entities.json`
    country), whether or not a given series lists it; callers filter to the codes WIPO lists for their series."""
    if group_id in CONTINENTS:
        key = "continent"
    elif group_id in _REGIONS:
        key = "region"
    else:
        raise KeyError(group_id)
    return sorted(code for code, entry in _COUNTRIES.items() if entry[key] == group_id)


@functools.lru_cache(maxsize=None)
def continent_equal_to(region_id: str) -> str | None:
    """Continent slug whose members equal this region's (021 -> northern-america), else None."""
    continent = _REGIONS[region_id]["continent"]
    return continent if members(region_id) == members(continent) else None


def continent_wipo_code(continent: str, series_id: str) -> str | None:
    """WIPO's R code for a continent in a series that lists R rows; None where the series has none."""
    code = WIPO_CONTINENT_CODES[continent]
    series_by_id(series_id)  # unknown series -> KeyError
    return code if series_id in SERIES_WITH_WIPO_CONTINENT_TOTALS else None
