"""Women-inventor figures from WIPO shares (pmh 1040 women_any, 1042 women_share). Pure functions except
`load_published` (reads the hand-entered continent figures).
Research `docs/research/2026-10-21-wipo-women-inventors.md`.

- WIPO first (j43): a country or World share is WIPO's value as published; a gap -> null `not_published`.
- Group women_any = mean of members' published 1040 shares weighted by members' own PCT publications (pmh 1010,
  same publication year; ruling Option A), regions AND continents; WIPO's R rows (no share) never weigh.
  Exact `Decimal` sum, rounded once, half away from zero, to GENDER_DECIMALS.
  Coverage = publications of members with a share / publications of members with a count, rounded to
  GENDER_COVERAGE_DECIMALS; that published value below GENDER_GROUP_COVERAGE_MIN -> null `low_coverage` (a minority
  of the group would not represent it). Decision and display use the same number (0.7996 -> 0.8 passes).
  Reason order per year: floor year -> its reason; 0 reporting or count sum 0 -> `none_reported`; low coverage.
- Group women_share: never computed (WIPO publishes shares only, no inventor counts) -> null `not_computable`.
- Continents (= WIPO's six regions): a year WIPO printed a figure (`gender_published.json`, PCT Yearly Review)
  -> WIPO's value (basis `wipo`, year in `wipo_years`; `reporting` and `coverage` null there: they describe the
  computed mean, not WIPO's figure); other years as any group (ruling C1).
- Cross-checks (warning lines): weighted country women_any vs WIPO's World row, and computed continent women_any vs
  a printed figure; both on the unrounded mean. Gap above GENDER_CROSSCHECK_TOLERANCE pp -> line; exactly at it passes.

Shapes (year keys int): country `{value: {year: float | None}, null_reason: {year: key}}`; group adds
`reporting: {year: int | None}`, `members: int`, `coverage: {year: float | None}`, `wipo_years: [int]`.
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from pipeline import m49
from pipeline.groups import NONE_REPORTED
from pipeline.series import GENDER_FROM

WOMEN_ANY = "women_any"  # pmh 1040
WOMEN_SHARE = "women_share"  # pmh 1042
MEASURES = (WOMEN_ANY, WOMEN_SHARE)

GENDER_DECIMALS = 1
GENDER_COVERAGE_DECIMALS = 3  # coverage published as a fraction
GENDER_GROUP_COVERAGE_MIN = 0.8
GENDER_CROSSCHECK_TOLERANCE = 0.5  # pp; 2.5x the publication-weighted max gap (research §4)
GAP_DECIMALS = 2  # cross-check gaps in lines and max_gap_pp

# null reason keys (site maps key -> text); floor keys come from groups
NOT_PUBLISHED = "not_published"
LOW_COVERAGE = "low_coverage"
NOT_COMPUTABLE = "not_computable"
BASIS_WIPO = "wipo"  # a continent year whose value is WIPO's printed figure

PCT_YEARLY_REVIEW_2026 = {
    "citation": "World Intellectual Property Organization (WIPO) (2026). PCT Yearly Review 2026: The International "
                "Patent System. Geneva: WIPO. DOI: 10.34667/tind.59475",
    "url": "https://www.wipo.int/edocs/pubdocs/en/"
           "wipo-pub-901-2026-en-patent-cooperation-treaty-yearly-review-2026.pdf",
}
METHOD_NOTE = {
    **PCT_YEARLY_REVIEW_2026,
    "page": "p. 28 (PDF p. 29), figure A22 note (methodology: www.wipo.int/en/web/economics); p. 29 (PDF p. 30), "
            "figure A25 note (data based on published applications and the publication date)",
}

GENDER_PUBLISHED_PATH = Path(__file__).with_name("gender_published.json")
_PUBLISHED_KEYS = {"source", *MEASURES}  # plus an optional "_comment"
_ENTRY_KEYS = {"value", "figure", "page"}

YearShares = Mapping[int, "float | None"]
YearCounts = Mapping[int, "int | None"]


def _decimal(value: float) -> Decimal:
    return Decimal(repr(value))


def _quantize(value: Decimal, decimals: int) -> Decimal:
    return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _round(value: Decimal, decimals: int) -> float:
    return float(_quantize(value, decimals))


def country_share(published: YearShares, years: Iterable[int]) -> dict:
    """WIPO's share as published (never re-rounded); missing -> null `not_published`."""
    value = {year: published.get(year) for year in years}
    return {"value": value, "null_reason": {year: NOT_PUBLISHED for year, share in value.items() if share is None}}


def _weighted(members: Iterable[str], shares: Mapping[str, YearShares], counts: Mapping[str, YearCounts],
              year: int) -> tuple[Decimal | None, int, int, int]:
    """(exact weighted mean or None, reporting, count sum of members with both, count sum of members with a count)."""
    total, reporting, with_share, counted = Decimal(0), 0, 0, 0
    for code in members:
        count = counts.get(code, {}).get(year)
        if count is None:
            continue
        counted += count
        share = shares.get(code, {}).get(year)
        if share is None:
            continue
        reporting += 1
        with_share += count
        total += _decimal(share) * count
    mean = total / with_share if with_share else None
    return mean, reporting, with_share, counted


def group_women_any(members: list[str], shares: Mapping[str, Mapping[str, YearShares]],
                    pct_counts: Mapping[str, YearCounts], years: Iterable[int], floor: Mapping[int, str]) -> dict:
    """Group women_any. `shares` = {measure: {code: {year: share}}}; reads WOMEN_ANY only (never mixes in 1042).
    `pct_counts` = code -> year -> PCT publications (`collected["pct_publications"]`); only `members` weigh.
    `floor` = year -> null reason of the group's floor (fail closed)."""
    any_shares = shares.get(WOMEN_ANY, {})
    minimum = _decimal(GENDER_GROUP_COVERAGE_MIN)
    result: dict = {"value": {}, "null_reason": {}, "reporting": {}, "members": len(members), "coverage": {},
                    "wipo_years": []}
    for year in years:
        mean, reporting, with_share, counted = _weighted(members, any_shares, pct_counts, year)
        result["reporting"][year] = reporting
        coverage = _quantize(Decimal(with_share) / counted, GENDER_COVERAGE_DECIMALS) if counted else None
        result["coverage"][year] = None if coverage is None else float(coverage)
        reason = None
        if year in floor:
            reason = floor[year]
        elif reporting == 0 or with_share == 0:
            reason = NONE_REPORTED
        elif coverage < minimum:
            reason = LOW_COVERAGE
        result["value"][year] = None if reason or mean is None else _round(mean, GENDER_DECIMALS)
        if reason:
            result["null_reason"][year] = reason
    return result


def group_women_share(members: list[str], years: Iterable[int]) -> dict:
    """Group women_share: not computable (WIPO publishes no inventor counts); reporting None, never 0: members do
    publish shares, nothing was computed from them (final review I1)."""
    years = list(years)
    return {"value": {year: None for year in years}, "null_reason": {year: NOT_COMPUTABLE for year in years},
            "reporting": {year: None for year in years}, "members": len(members),
            "coverage": {year: None for year in years}, "wipo_years": []}


def continent_value(measure: str, continent: str, computed: dict, published: dict) -> dict:
    """`computed` (group shape) with WIPO's printed figure in each year it has (`published` = load_published());
    printed years outside the computed years are unused. In a printed year reporting and coverage are None (they
    describe the computed mean, not WIPO's figure). Input untouched."""
    printed = published.get(measure, {}).get(continent, {})
    result = {**computed, "value": dict(computed["value"]), "null_reason": dict(computed["null_reason"]),
              "reporting": dict(computed["reporting"]), "coverage": dict(computed["coverage"])}
    wipo_years = sorted(year for year in printed if year in result["value"])
    for year in wipo_years:
        result["value"][year] = printed[year]["value"]
        result["null_reason"].pop(year, None)
        result["reporting"][year] = None
        result["coverage"][year] = None
    result["wipo_years"] = wipo_years
    return result


def _gap_line(what: str, year: int, ours: Decimal, wipo: float, gap: Decimal) -> str:
    return f"{what} {year}: {ours} vs WIPO {wipo} (gap {gap:+} pp, over {GENDER_CROSSCHECK_TOLERANCE} pp)"


def continent_crosscheck(continent: str, computed_any: dict, members: list[str], shares: Mapping[str, YearShares],
                         pct_counts: Mapping[str, YearCounts], published: dict) -> list[str]:
    """Warning lines: computed continent women_any (`computed_any` = group_women_any, before continent_value; a null
    year is skipped) vs WIPO's printed women_any. The gap uses the unrounded weighted mean of `members`
    (`shares` = {code: {year: women_any share}}), as world_crosscheck does."""
    lines = []
    step = Decimal(1).scaleb(-GAP_DECIMALS)
    for year, entry in sorted(published.get(WOMEN_ANY, {}).get(continent, {}).items()):
        if computed_any["value"].get(year) is None:
            continue
        mean = _weighted(members, shares, pct_counts, year)[0]
        gap = mean - _decimal(entry["value"])
        if abs(gap) > _decimal(GENDER_CROSSCHECK_TOLERANCE):
            lines.append(_gap_line(f"women_any {continent}", year, mean.quantize(step, rounding=ROUND_HALF_UP),
                                   entry["value"], gap.quantize(step, rounding=ROUND_HALF_UP)))
    return lines


def world_crosscheck(shares: Mapping[str, YearShares], pct_counts: Mapping[str, YearCounts], zz: YearShares,
                     years: Iterable[int]) -> dict:
    """Unrounded publication-weighted mean of country women_any vs WIPO's World row per year. `shares` = countries
    only (caller drops ZZ, **, R*). {compared, max_gap_pp (None if nothing compared), gap_years, lines}."""
    tolerance = _decimal(GENDER_CROSSCHECK_TOLERANCE)
    step = Decimal(1).scaleb(-GAP_DECIMALS)
    compared, gaps, gap_years, lines = 0, [], [], []
    for year in years:
        world = zz.get(year)
        mean = _weighted(list(shares), shares, pct_counts, year)[0]
        if world is None or mean is None:
            continue
        compared += 1
        gap = mean - _decimal(world)
        gaps.append(abs(gap))
        if abs(gap) > tolerance:
            gap_years.append(year)
            lines.append(_gap_line("women_any weighted country mean", year,
                                   mean.quantize(step, rounding=ROUND_HALF_UP), world,
                                   gap.quantize(step, rounding=ROUND_HALF_UP)))
    return {"compared": compared, "max_gap_pp": _round(max(gaps), GAP_DECIMALS) if gaps else None,
            "gap_years": gap_years, "lines": lines}


def method_constants() -> dict:
    """Constants behind the gender figures, JSON-ready (published as overview.method.gender)."""
    return {
        "decimals": GENDER_DECIMALS,
        "coverage_decimals": GENDER_COVERAGE_DECIMALS,
        "group_coverage_min": GENDER_GROUP_COVERAGE_MIN,
        "crosscheck_tolerance_pp": GENDER_CROSSCHECK_TOLERANCE,
        "first_year": GENDER_FROM,
        "method_note": dict(METHOD_NOTE),
    }


def _bad(path: Path, why: str) -> ValueError:
    return ValueError(f"gender_published ({path.name}): {why}")


def load_published(path: Path = GENDER_PUBLISHED_PATH) -> dict:
    """WIPO's printed continent figures: {source: {citation, url}, measure: {continent: {year: {value, figure,
    page}}}}, year keys int. ValueError on any malformed entry (hand-entered file)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise _bad(path, f"unreadable: {error}") from error
    if not isinstance(data, dict) or set(data) - {"_comment"} != _PUBLISHED_KEYS:
        keys = sorted(data) if isinstance(data, dict) else data
        raise _bad(path, f"keys {keys!r}, expected {sorted(_PUBLISHED_KEYS)}")
    source = data["source"]
    if not isinstance(source, dict) or set(source) != {"citation", "url"} or not all(
            isinstance(text, str) and text for text in source.values()):
        raise _bad(path, "source needs a non-empty citation and url")
    result: dict = {"source": dict(source)}
    for measure in MEASURES:
        result[measure] = {}
        if not isinstance(data[measure], dict):
            raise _bad(path, f"{measure}: expected continent -> year -> entry")
        for continent, by_year in data[measure].items():
            if continent not in m49.CONTINENTS:
                raise _bad(path, f"{measure}: unknown continent {continent!r}")
            if not isinstance(by_year, dict):
                raise _bad(path, f"{measure} {continent}: expected year -> entry")
            result[measure][continent] = {}
            for year_text, entry in by_year.items():
                where = f"{measure} {continent} {year_text}"
                if not year_text.isdigit() or not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS:
                    raise _bad(path, f"{where}: expected year -> {sorted(_ENTRY_KEYS)}")
                value = entry["value"]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 100:
                    raise _bad(path, f"{where}: value {value!r} is not a share in percent")
                if not all(isinstance(entry[key], str) and entry[key] for key in ("figure", "page")):
                    raise _bad(path, f"{where}: figure and page must be cited")
                result[measure][continent][int(year_text)] = dict(entry)
    return result
