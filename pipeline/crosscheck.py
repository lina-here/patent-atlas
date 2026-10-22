"""Cross-checks of live WIPO data before anything is published (spec "Cross-checks").

Blocking (failure -> run fails, last good data kept):
- WDI exact: World Bank `IP.PAT.RESD` / `IP.PAT.NRES` (re-publishes WIPO office data) == office_apps
  resident / non-resident for `WDI_OFFICES`, years last_year-`WDI_YEARS_BACK`..last_year-1.
  Revision-timing rule: the latest year is skipped (WDI picks up a WIPO release months later); a blank
  on either side skips the cell. WDI last updated (response `lastupdated`) before the month of the WIPO
  patent release -> mismatches are warnings (WIPO revised past years, WDI not yet); same month or newer,
  or either date missing/unparseable -> mismatches block (`wdi_timing`). Fetch or shape error = blocking.
- Golden: `golden.json` headline figures from WIPO publications vs the published value;
  |live - published| <= `GOLDEN_TOLERANCE_PCT` % of published passes (noted), above fails.
- World totals: our sum of entities > WIPO's own total = data error, except `WORLD_OFFICE_EXCESS_YEARS`
  (warning). Sum < `WORLD_MIN_SUM_RATIO` of WIPO's total in a non-provisional year = warning.
Warning only: OECD trend (PATSTAT, fractional counts): direction of yearly change of PCT applications
for the biggest origins; any OECD problem = warning. PCT monthly (`monthly_check`): a year with every month
whose sum != WIPO's yearly ZZ total; a year with null months (padded or not reported) noted.
"""
from __future__ import annotations

import csv
import datetime
import io
import json
import math
import re
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from pipeline.entities import classify, iso3
from pipeline.wipo_client import USER_AGENT, PoliteOpener

REQUEST_TIMEOUT_S = 30
Fetch = Callable[[str, str], str]  # (url, accept) -> body text; raises CheckError
YearSeries = dict[int, "int | None"]

WDI_OFFICES = ("CH", "US", "CN", "DE", "MG")
WDI_INDICATORS = {"IP.PAT.RESD": "resident", "IP.PAT.NRES": "nonresident"}
WDI_URL = ("https://api.worldbank.org/v2/country/{countries}/indicator/{indicator}"
           "?format=json&date={first}:{last}&per_page=1000")
WDI_YEARS_BACK = 4
# WIPO release strings ("Last updated: May 2026"), English month names (collect.releases)
RELEASE_PATTERN = re.compile(r"\s*Last updated:\s*([A-Za-z]+)\s+(\d{4})\s*")
MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december")

GOLDEN_PATH = Path(__file__).with_name("golden.json")
GOLDEN_KEYS = {"id", "description", "value", "year", "series", "code_or_world", "citation", "url", "page"}
GOLDEN_TOLERANCE_PCT = 1
GOLDEN_SOURCE_KEYS = ("id", "citation", "url", "page")  # publication behind each figure, for the methods page

# Live 2026-10-19: office sum exceeds WIPO's World (WD) by 0.06-2.0% in these years only (WD = WIPO
# estimate; 1980-1984 WD blank). Reported as warnings; an excess in any other year blocks.
WORLD_OFFICE_EXCESS_YEARS = frozenset({1987, 1989, 1990, 1991, 1992, 1993, 1994})
WORLD_MIN_SUM_RATIO = Decimal("0.9")

OECD_URL = ("https://sdmx.oecd.org/public/rest/data/OECD.STI.PIE,DSD_PATENTS@DF_PATENTS,1.0/"
            "9P50_1.A.AP.PATN.APPLICATION.{countries}._Z.APPLICANT._Z._Z._T?startPeriod={first}")
OECD_ACCEPT = "application/vnd.sdmx.data+csv;version=1.0.0"
OECD_BIG_ORIGINS = 5
OECD_COMPARE_YEARS = 3
# Opposite directions closer than this (percentage points) are noise between the two counting methods.
OECD_MIN_GAP_PP = 2.0


class CheckError(Exception):
    """A blocking cross-check could not run (fetch or response shape)."""


class Fetcher:
    """Polite sequential HTTP GET for cross-check sources (same User-Agent, delay and retries as WipoClient)."""

    def __init__(self, opener: Callable[[urllib.request.Request], bytes] | None = None,
                 delay_s: float = 1.0, sleep: Callable[[float], None] = time.sleep) -> None:
        self._polite = PoliteOpener(opener or _default_opener, delay_s, sleep, CheckError)

    def get(self, url: str, accept: str) -> str:
        request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT})
        body = self._polite.open(request, url)
        try:
            return body.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise CheckError(f"response for {url} is not UTF-8") from error


def _default_opener(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
        if response.status != 200:
            raise CheckError(f"HTTP {response.status} for {request.full_url}")
        return response.read()


def _round(value: int | float, decimals: int) -> Decimal:
    """Half-up rounding for messages (same rule as derive)."""
    return Decimal(repr(value)).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _pct(numerator: int, denominator: int, decimals: int) -> Decimal:
    exact = Decimal(numerator) * 100 / Decimal(denominator)
    return exact.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


# WDI

def wdi_years(last_year: int) -> tuple[int, int]:
    """Years compared with WDI: the `WDI_YEARS_BACK` years before the latest (revision-timing rule)."""
    return last_year - WDI_YEARS_BACK, last_year - 1


@dataclass
class Wdi:
    cells: dict[tuple[str, int, str], int | None]  # (WIPO code, year, type key) -> value
    last_updated: datetime.date | None  # response `lastupdated`; None = missing or unparseable


def release_month(release: str | None) -> tuple[int, int] | None:
    """(year, month) of a WIPO release string; any other wording -> None."""
    match = RELEASE_PATTERN.fullmatch(release) if isinstance(release, str) else None
    if match is None or match.group(1).lower() not in MONTHS:
        return None
    return int(match.group(2)), MONTHS.index(match.group(1).lower()) + 1


def wdi_timing(last_updated: datetime.date | None, ips_release: str | None) -> tuple[bool, str]:
    """(mismatches are warnings, reason). Warnings only when WDI was last updated before the month of the
    WIPO patent release: WIPO may have revised past years that WDI has not taken up yet. Same month or newer,
    or a date missing/unparseable -> mismatches block (fail safe)."""
    month = release_month(ips_release)
    if last_updated is None:
        return False, "WDI lastupdated missing or unparseable: mismatches block"
    if month is None:
        return False, f"WIPO patent release {ips_release!r} unparseable: mismatches block"
    release = f"{MONTHS[month[1] - 1].capitalize()} {month[0]}"
    if (last_updated.year, last_updated.month) < month:
        return True, (f"World Bank WDI last updated {last_updated.isoformat()}, before the WIPO patent release of "
                      f"{release}: WIPO revisions not yet in WDI, mismatches are warnings")
    return False, (f"World Bank WDI last updated {last_updated.isoformat()}, not before the WIPO patent release of "
                   f"{release}: mismatches block")


def wdi_last_updated(meta: dict) -> datetime.date | None:
    """Page metadata `lastupdated` (YYYY-MM-DD) as a date; missing or unparseable -> None."""
    text = meta.get("lastupdated")
    if not (isinstance(text, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", text)):
        return None
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        return None


def wdi_compare(ours: dict[tuple[str, int, str], int | None],
                wdi: dict[tuple[str, int, str], int | None]) -> list[str]:
    """Mismatch messages for cells (code, year, type key) with values on both sides; blanks skipped."""
    mismatches = []
    for key in sorted(ours):
        mine, theirs = ours[key], wdi.get(key)
        if mine is not None and theirs is not None and mine != theirs:
            code, year, type_key = key
            mismatches.append(f"WDI {code} {year} {type_key}: WIPO {mine}, World Bank {theirs}")
    return mismatches


def wdi_rows(text: str, indicator: str) -> tuple[dict, list[dict]]:
    """World Bank v2 JSON -> (page metadata, rows): one page, every row an object for `indicator` (null rows ->
    []). Not JSON, API error message, other shape, pages != 1, malformed row, other indicator -> CheckError.
    Shared by `parse_wdi` and `wdi.parse_denominator`; per-row mapping is theirs."""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise CheckError(f"WDI {indicator}: response is not JSON") from error
    if isinstance(payload, list) and payload and isinstance(payload[0], dict) and "message" in payload[0]:
        raise CheckError(f"WDI {indicator}: World Bank API error {payload[0]['message']}")
    if not (isinstance(payload, list) and len(payload) == 2 and isinstance(payload[0], dict)):
        raise CheckError(f"WDI {indicator}: unexpected response shape")
    if payload[0].get("pages") != 1:
        raise CheckError(f"WDI {indicator}: {payload[0].get('pages')} pages, expected 1")
    rows = payload[1] if payload[1] is not None else []
    if not isinstance(rows, list):
        raise CheckError(f"WDI {indicator}: rows are not a list")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("indicator"), dict):
            raise CheckError(f"WDI {indicator}: malformed row {row!r}")
        if row["indicator"].get("id") != indicator:
            raise CheckError(f"WDI {indicator}: row for indicator {row['indicator'].get('id')!r}")
    return payload[0], rows


def parse_wdi(text: str, indicator: str, code_by_iso3: dict[str, str], first: int, last: int) -> Wdi:
    """World Bank v2 JSON -> cells {(WIPO code, year, type key): value} + page metadata `lastupdated`;
    any unexpected shape -> CheckError (a missing or bad `lastupdated` only makes it None)."""
    meta, rows = wdi_rows(text, indicator)
    type_key = WDI_INDICATORS[indicator]
    result: dict[tuple[str, int, str], int | None] = {}
    for row in rows:
        code = code_by_iso3.get(row.get("countryiso3code"))
        if code is None:
            raise CheckError(f"WDI {indicator}: unrequested country {row.get('countryiso3code')!r}")
        date = row.get("date")
        if not (isinstance(date, str) and re.fullmatch(r"\d{4}", date) and first <= int(date) <= last):
            raise CheckError(f"WDI {indicator}: year {date!r} outside {first}-{last}")
        value = row.get("value")
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise CheckError(f"WDI {indicator}: {code} {date} value {value!r} is not a count")
        key = (code, int(date), type_key)
        if key in result:
            raise CheckError(f"WDI {indicator}: duplicate row {code} {date}")
        result[key] = value
    return Wdi(result, wdi_last_updated(meta))


def fetch_wdi(codes: list[str] | tuple[str, ...], first: int, last: int, fetch: Fetch) -> Wdi:
    """WDI resident + non-resident cells for WIPO country codes; one request per indicator. last_updated =
    newest of the responses (warn only if all predate the release), None if any is missing."""
    code_by_iso3 = {}
    for code in codes:
        code_iso3 = iso3(code)
        if code_iso3 is None:
            raise CheckError(f"WDI: no ISO3 code for {code!r}")
        code_by_iso3[code_iso3] = code
    cells: dict[tuple[str, int, str], int | None] = {}
    dates: list[datetime.date | None] = []
    for indicator in WDI_INDICATORS:
        url = WDI_URL.format(countries=";".join(code_by_iso3), indicator=indicator, first=first, last=last)
        wdi = parse_wdi(fetch(url, "application/json"), indicator, code_by_iso3, first, last)
        cells.update(wdi.cells)
        dates.append(wdi.last_updated)
    return Wdi(cells, None if None in dates else max(dates))


# Golden figures

def load_golden(path: Path = GOLDEN_PATH) -> list[dict]:
    try:
        golden = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CheckError(f"golden figures unreadable: {error}") from error
    if not isinstance(golden, list) or not golden:
        raise CheckError("golden figures: expected a non-empty list")
    for entry in golden:
        if not isinstance(entry, dict) or set(entry) != GOLDEN_KEYS:
            raise CheckError(f"golden entry keys {sorted(entry) if isinstance(entry, dict) else entry!r}, "
                             f"expected {sorted(GOLDEN_KEYS)}")
        value = entry["value"]  # count (int) or a share / ratio as printed (float)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 \
                or not isinstance(entry["year"], int):
            raise CheckError(f"golden entry {entry['id']}: value must be a finite positive number, year an integer")
    return golden


def golden_sources(golden: list[dict]) -> list[dict]:
    """Citation of each golden figure (edition and DOI, page, URL), in golden.json order."""
    return [{key: entry[key] for key in GOLDEN_SOURCE_KEYS} for entry in golden]


def golden_compare(golden: list[dict], ours: Callable[[dict], int | float | None]) -> tuple[list[str], list[str]]:
    """(failures, notes): diff > GOLDEN_TOLERANCE_PCT % of the published value fails (relative: for a one-decimal
    share, a fraction of a percentage point). Exact decimal test; a float live or published value (ratio, share; one
    decimal) is taken as written (repr), never with float error."""
    failures, notes = [], []
    for entry in golden:
        live, published = ours(entry), Decimal(repr(entry["value"]))
        where = f"{entry['series']} {entry['code_or_world']} {entry['year']}"
        if live is None:
            failures.append(f"{entry['id']}: no live value for {where}")
            continue
        gap = Decimal(repr(live)) - published
        diff = (gap * 100 / published).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        text = f"{entry['id']}: live {live} vs published {entry['value']} ({diff:+}%)"
        if abs(gap) * 100 > published * GOLDEN_TOLERANCE_PCT:
            failures.append(f"{text}, over {GOLDEN_TOLERANCE_PCT}% ({where})")
        else:
            notes.append(text)
    return failures, notes


# World totals

def world_check(name: str, published: YearSeries, our_sum: YearSeries, last_year: int,
                known_excess_years: frozenset[int] | set[int] = frozenset()) -> tuple[list[str], list[str]]:
    """(failures, warnings) comparing WIPO's own world total with our sum of entities, per year."""
    failures, warnings = [], []
    for year in sorted(published):
        total, summed = published[year], our_sum.get(year)
        if total is None or summed is None:
            continue
        if summed > total:
            message = f"{name} {year}: sum of entities {summed} > WIPO total {total}"
            if year in known_excess_years:
                warnings.append(f"{message} (known WIPO data quirk)")
            else:
                failures.append(message)
        elif year <= last_year and Decimal(summed) < WORLD_MIN_SUM_RATIO * total:
            warnings.append(f"{name} {year}: sum of entities {summed} is {_pct(summed, total, 1)}% of WIPO "
                            f"total {total} (< {WORLD_MIN_SUM_RATIO * 100:.0f}%)")
    return failures, warnings


def monthly_check(months: dict[int, list[int | None]], yearly: YearSeries) -> list[str]:
    """Warnings: PCT world months vs WIPO's yearly total (ZZ). Null months -> note (no sum compared); every
    month reported and sum != yearly -> mismatch; yearly null -> nothing to compare."""
    warnings = []
    for year in sorted(months):
        values = months[year]
        missing = sum(1 for value in values if value is None)
        if missing:
            warnings.append(f"PCT monthly {year}: {missing} of {len(values)} months not reported (shown null)")
        elif yearly.get(year) is not None and sum(values) != yearly[year]:
            warnings.append(f"PCT monthly {year}: sum of months {sum(values)} != WIPO yearly total (ZZ) "
                            f"{yearly[year]}")
    return warnings


def sum_ratio_summary(published: YearSeries, our_sum: YearSeries) -> dict:
    """Our sum / WIPO total over years with both values: {min, max, years} (ratios 4 decimals, half up)."""
    years = [year for year in sorted(published) if published[year] and our_sum.get(year) is not None]
    if not years:
        return {"min": None, "max": None, "years": None}
    ratios = [Decimal(our_sum[year]) / Decimal(published[year]) for year in years]
    return {"min": float(_round_decimal(min(ratios), 4)), "max": float(_round_decimal(max(ratios), 4)),
            "years": f"{years[0]}-{years[-1]}"}


def _round_decimal(value: Decimal, decimals: int) -> Decimal:
    return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


# OECD trend (warning only)

def _parse_oecd(text: str) -> dict[tuple[str, int], float]:
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or not {"REF_AREA", "TIME_PERIOD", "OBS_VALUE"} <= set(reader.fieldnames):
        raise ValueError(f"unexpected OECD columns {reader.fieldnames}")
    values = {}
    for row in reader:
        if row["OBS_VALUE"]:
            values[(row["REF_AREA"], int(row["TIME_PERIOD"]))] = float(row["OBS_VALUE"])
    return values


def oecd_trend(totals: dict[str, YearSeries], last_year: int, fetch: Fetch) -> list[str]:
    """Warnings where WIPO PCT and OECD PCT counts (biggest origins) move in opposite directions
    by at least OECD_MIN_GAP_PP, over the last OECD_COMPARE_YEARS overlapping years. Never raises."""
    countries = [code for code in totals if classify(code) == "country" and totals[code].get(last_year) is not None]
    biggest = sorted(countries, key=lambda code: (-totals[code][last_year], code))[:OECD_BIG_ORIGINS]
    code_by_iso3 = {iso3(code): code for code in biggest}
    first = last_year - OECD_COMPARE_YEARS - 2
    try:
        url = OECD_URL.format(countries="+".join(code_by_iso3), first=first)
        oecd = _parse_oecd(fetch(url, OECD_ACCEPT))
    except Exception as error:  # warning-only check: no OECD problem may stop the run
        return [f"OECD trend check skipped: {error}"]
    warnings, compared = [], 0
    for code_iso3, code in code_by_iso3.items():
        years = [year for year in range(first + 1, last_year + 1)
                 if None not in (totals[code].get(year), totals[code].get(year - 1))
                 and totals[code][year - 1] != 0
                 and (code_iso3, year) in oecd and oecd.get((code_iso3, year - 1))]
        for year in years[-OECD_COMPARE_YEARS:]:
            compared += 1
            ours = (totals[code][year] - totals[code][year - 1]) * 100 / totals[code][year - 1]
            theirs = (oecd[(code_iso3, year)] - oecd[(code_iso3, year - 1)]) * 100 / oecd[(code_iso3, year - 1)]
            if ours * theirs < 0 and abs(ours - theirs) >= OECD_MIN_GAP_PP:
                warnings.append(f"OECD trend {code} {year}: WIPO PCT {_round(ours, 1):+}% vs OECD "
                                f"{_round(theirs, 1):+}% (direction differs)")
    if compared == 0:
        warnings.append("OECD trend: no overlapping years to compare")
    return warnings
