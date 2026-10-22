"""Derived figures from year series. Pure functions, no I/O.

Missing value = None, never 0. Percent results are floats rounded with ROUND_HALF_UP via `decimal`
(`_round_pct`): ties round away from zero (7.25 -> 7.3, -7.25 -> -7.3), not Python's banker's `round`.
Ratios of ints are computed exactly in `Decimal` before rounding, so exact ties are detected.
Zero or null base -> None (never inf/NaN).
"""
from __future__ import annotations

from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal

YearSeries = dict[int, "int | None"]

# Published with the data (overview.json `method.rounding`) so the methods page states them from source.
ROUNDING_MODE = "half away from zero"
YOY_DECIMALS = 1
CAGR_DECIMALS = 1
CAGR_YEARS = 10  # one source: write.py (cagr10, fastest growers, overview method) and the default here
SHARE_DECIMALS = 2  # share and resident_share


def _round_pct(value: Decimal, decimals: int) -> float:
    rounded = float(value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP))
    return rounded + 0.0  # -0.0 + 0.0 == 0.0: JSON never shows "-0.0"


def _pct_ratio(numerator: int, denominator: int, decimals: int) -> float:
    return _round_pct(Decimal(numerator) * 100 / Decimal(denominator), decimals)


def yoy_growth(series: YearSeries) -> dict[int, float | None]:
    """Year-over-year growth, percent, 1 decimal (half up).

    One entry per year except the first; None if either year is null or absent (a gap), or the
    previous year is 0. Keys are consistent for tables.
    """
    result: dict[int, float | None] = {}
    for year in sorted(series)[1:]:
        base, current = series.get(year - 1), series[year]
        if base is None or current is None or base == 0:
            result[year] = None
        else:
            result[year] = _pct_ratio(current - base, base, YOY_DECIMALS)
    return result


def cagr(series: YearSeries, end_year: int, years: int = CAGR_YEARS) -> float | None:
    """Compound annual growth rate from `end_year - years` to `end_year`, percent, 1 decimal (half up).

    None if either year is absent or null, or the base is 0. The root is a float power; ties at
    the rounding digit are not exact, so half-up applies to the float's shortest repr.
    """
    if years <= 0:
        raise ValueError(f"years must be positive: {years}")
    base, end = series.get(end_year - years), series.get(end_year)
    if base is None or end is None or base == 0:
        return None
    rate_percent = ((end / base) ** (1 / years) - 1) * 100
    return _round_pct(Decimal(repr(rate_percent)), CAGR_DECIMALS)


def world_sum(
    by_entity: dict[str, YearSeries], include: Callable[[str], bool]
) -> tuple[dict[int, int | None], dict[int, int]]:
    """Sum per year over included entities, plus coverage (included entities with a non-null value).

    A year present in any included entity's series appears in both results; sum is None if coverage
    is 0. A reported 0 counts as covered.
    """
    totals: dict[int, int | None] = {}
    coverage: dict[int, int] = {}
    for code, series in by_entity.items():
        if not include(code):
            continue
        for year, value in series.items():
            totals.setdefault(year, None)
            coverage.setdefault(year, 0)
            if value is not None:
                totals[year] = (totals[year] or 0) + value
                coverage[year] += 1
    return dict(sorted(totals.items())), dict(sorted(coverage.items()))


PROVISIONAL_LOOKBACK_YEARS = 5


def world_last_year(coverage: dict[int, int], min_ratio: float = 0.9) -> int:
    """Latest year of the complete world series; later years are provisional.

    Walks back from the newest year. A year is provisional if its coverage is below `min_ratio` x the
    maximum coverage of the up-to-`PROVISIONAL_LOOKBACK_YEARS` years before it; provisional years are
    dropped from the end, stopping at the first year that passes (a year with no earlier years
    passes). Only the trailing years matter: dips in mid-history are ignored. Empty -> ValueError.
    """
    if not coverage:
        raise ValueError("no coverage data")
    years = sorted(coverage)
    for index in range(len(years) - 1, 0, -1):
        prior = [coverage[year] for year in years[max(0, index - PROVISIONAL_LOOKBACK_YEARS):index]]
        if coverage[years[index]] >= min_ratio * max(prior):
            return years[index]
    return years[0]


def share(value: int | None, total: int | None) -> float | None:
    """value / total, percent, 2 decimals (half up). None if either is null or total is 0."""
    if value is None or total is None or total == 0:
        return None
    return _pct_ratio(value, total, SHARE_DECIMALS)


def ranks(by_entity: dict[str, YearSeries], year: int, include: Callable[[str], bool]) -> dict[str, int]:
    """Rank of each included entity with a non-null value in `year`; 1 = largest.

    Ties share a rank and the next rank skips (5, 5, 3 -> 1, 1, 3). Null or missing = unranked.
    """
    values = {
        code: series[year]
        for code, series in by_entity.items()
        if include(code) and series.get(year) is not None
    }
    descending = sorted(values.values(), reverse=True)
    return {code: descending.index(value) + 1 for code, value in values.items()}


def resident_share(resident: int | None, total: int | None) -> float | None:
    """Resident filings as a percent of total filings: same rounding as `share` (2 decimals)."""
    return share(resident, total)
