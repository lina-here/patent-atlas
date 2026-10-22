"""World figures per series: WIPO's published totals, our sums, coverage, last complete year.

Controller rulings R1/R2: world_office = WIPO's World row (office_apps WD), pct_world = WIPO's Total row
(pct_origin ZZ). Our sums (`in_world_office_sum`, `in_world_origin`) give coverage -> world_last_year (later years
provisional: dropped from world series, shares, ranks, top lists, group and map outputs) and feed
crosscheck.world_check; they stay internal (manifest checks only). world_origin (origin sum) sets `top_year` and is
not published (coverage artefacts). Shares divide by WIPO's own totals (`SHARE_DENOMINATOR`, as WIPI does): origin
and office -> WD, PCT -> ZZ; null where that total is null (no fallback to our sum: one definition).
Used by write.py (outputs), groups.py (group figures) and run.py (checks).
"""
from __future__ import annotations

from dataclasses import dataclass

from pipeline import derive
from pipeline.collect import SeriesData
from pipeline.entities import classify

COVERAGE_MIN_RATIO = 0.9  # derive.world_last_year rule; written to overview for the methods page

# world key -> (series id, WIPO total row code or None = our sum is the published figure)
WORLD_SOURCES: dict[str, tuple[str, str | None]] = {
    "world_office": ("office_apps", "WD"),
    "world_origin": ("origin_apps", None),
    "pct_world": ("pct_origin", "ZZ"),
}
WORLD_OF_SERIES = {series_id: key for key, (series_id, _) in WORLD_SOURCES.items()}
# series id -> world key whose published total is the share denominator (controller ruling 2026-10-20)
SHARE_DENOMINATOR = {"origin_apps": "world_office", "office_apps": "world_office", "pct_origin": "pct_world"}


def in_world_office_sum(code: str) -> bool:
    """Office codes summed for the world office check: countries, regional offices, former states."""
    return classify(code) != "aggregate"


def in_world_origin(code: str) -> bool:
    """Origin codes summed for world_origin and the PCT check: countries and former states."""
    return classify(code) in ("country", "historical")


_SUM_INCLUDE = {"world_office": in_world_office_sum, "world_origin": in_world_origin, "pct_world": in_world_origin}


@dataclass
class World:
    published: dict[int, int | None]  # full year range, provisional years included
    our_sum: dict[int, int | None]
    coverage: dict[int, int]
    last_year: int  # latest non-provisional year


def totals(series: SeriesData) -> dict[str, dict[int, int | None]]:
    """code -> total year series."""
    return {code: types["total"] for code, types in series.values.items()}


def world_figures(data: dict[str, SeriesData]) -> dict[str, World]:
    worlds = {}
    for key, (series_id, total_code) in WORLD_SOURCES.items():
        series_totals = totals(data[series_id])
        our_sum, coverage = derive.world_sum(series_totals, _SUM_INCLUDE[key])
        published = our_sum if total_code is None else dict(series_totals[total_code])
        last_year = derive.world_last_year(coverage, COVERAGE_MIN_RATIO)
        worlds[key] = World(published, our_sum, coverage, last_year)
    return worlds
