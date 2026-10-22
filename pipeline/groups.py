"""Group figures (continents, M49 regions): totals by basis, coverage, fixed panel, unallocated band, checks.

Basis (data check `docs/research/2026-10-20-v0.2a-data-check.md` §6; one basis per series and group kind):
- `wipo_total`: continent in a series whose WIPO table lists R1-R6 (`m49.SERIES_WITH_WIPO_CONTINENT_TOTALS`):
  total = WIPO's R row (includes regional offices + WIPO estimates). Null R year -> null, reason
  `no_wipo_regional_total`; never filled from member sums. Member sum kept as cross-check only. No fixed panel:
  the R row has no member gaps.
- `member_sum`: regions, and continents of series without R rows (origin): sum of non-null members. Null where 0
  members reported (`none_reported`), the WIPO world total is null or provisional (`no_wipo_world_total`), or the
  series fails the attribution floor that year (`attribution_floor`). Fixed panel for indexed comparisons.
- No count coverage threshold (controller ruling 2026-10-20): "n of m" (`reporting` of `members`) is published.
- `members`/`reporting` = M49 countries WIPO lists for the series; regional offices, former states never count.
- Office not in region mode (`series_of_group`): regional offices EP/OA/AP/EA/GC belong to no region.
- Every figure cut at the series' world `last_year` (worlds.py: later years provisional).
- World total of a series = WIPO's (`worlds.SHARE_DENOMINATOR`), None after that world's own last_year
  (provisional WD never divides origin figures: fails closed).
- Unallocated = world total - sum of continent totals; null where any continent total or the world total is null.
- `context()` holds per-run figures (floor, continents, PCT band check), each computed on first use, once;
  every public figure function takes it and reads `ctx.data` (one data per context). Lazy: a region needs no R
  row; floor only for series with member_sum groups.
"""
from __future__ import annotations

from decimal import Decimal

from pipeline import derive, m49
from pipeline.collect import SeriesData
from pipeline.parse import SchemaError
from pipeline.series import SERIES, TOTAL_ROW_CODES
from pipeline.worlds import SHARE_DENOMINATOR, WORLD_OF_SERIES, World, world_figures

WIPO_TOTAL = "wipo_total"
MEMBER_SUM = "member_sum"

# Published (overview.json `method`). Values from the data check §2/§6 (2026-10-20 measurements there).
# member_sum year with sum(grouped countries) / world total below this -> group totals null. Origin: WIPO's
# by-origin data count almost no filings abroad before 1994 (measured ratio 1985-1993 0.50-0.67, 1994+ >= 0.871).
GROUP_ATTRIBUTION_MIN = 0.8
# (R - member sum incl. assigned offices) / R outside -> warning. Positive gap = WIPO estimates for non-reporting
# offices (measured inside every year).
GROUP_CROSSCHECK_RANGE = (-0.05, 0.20)
PANEL_YEARS = 10  # fixed-panel window (member_sum groups): members reporting every year of it
ORIGIN_ABROAD_FROM = 1994  # first year origin "Abroad" is substantially reported (note §2: 1993 7,514 -> 243,947)

REGION_SERIES = ("origin_apps", "pct_origin")
# Codes WIPO counts in an R row that are no M49 member: added to the cross-check member sum only (note §2).
# YU office data ends 2003 (Europe).
CROSSCHECK_EXTRA: dict[str, dict[str, tuple[str, ...]]] = {
    "office_apps": {"europe": ("EP", "EA", "YU"), "africa": ("OA", "AP"), "asia": ("GC",)},
    "pct_origin": {"latin-america-caribbean": ("AN",)},
}

# null reason keys (site maps key -> text)
NO_WIPO_REGIONAL_TOTAL = "no_wipo_regional_total"
NO_WIPO_WORLD_TOTAL = "no_wipo_world_total"
ATTRIBUTION_FLOOR = "attribution_floor"
NONE_REPORTED = "none_reported"

UNALLOCATED_LABEL = {"office_apps": "unallocated", "pct_origin": "origin unknown",
                     "origin_apps": "not attributable"}
GENERIC_UNALLOCATED_LABEL = "unallocated"
PCT_UNKNOWN_CODE = "**"  # WIPO "Unknown" origin; ZZ - sum(R1-R6) equals it (note §2), checked per year


class Context:
    """Per-run figures shared by every group, file and check; each computed on first use, then cached.
    Built by `context` for one `data`; treat results as read-only."""

    def __init__(self, data: dict[str, SeriesData], worlds: dict[str, World]):
        self.data = data
        self.worlds = worlds
        self._floor: dict[str, dict[int, str]] = {}
        self._continents: dict[tuple[str, str], dict] = {}
        self._pct_mismatches: list[tuple[int, int, int | None]] | None = None

    def floor(self, series_id: str) -> dict[int, str]:
        """Year -> null reason of the series' member_sum groups (floor_failures). ValueError for a series
        without member_sum groups (office: every group is a WIPO R row)."""
        if not has_member_sum(series_id):
            raise ValueError(f"{series_id}: no member_sum groups, no attribution floor")
        if series_id not in self._floor:
            self._floor[series_id] = floor_failures(self.data, series_id, self.worlds)
        return self._floor[series_id]

    def continent(self, series_id: str, continent: str) -> dict:
        key = (series_id, continent)
        if key not in self._continents:
            self._continents[key] = _group_series(series_id, continent, self)
        return self._continents[key]

    def continents(self, series_id: str) -> dict[str, dict]:
        """continent -> group_series, CONTINENTS order."""
        return {continent: self.continent(series_id, continent) for continent in m49.CONTINENTS}

    def pct_mismatches(self) -> list[tuple[int, int, int | None]]:
        if self._pct_mismatches is None:
            self._pct_mismatches = pct_band_mismatches(self.data, self.worlds)
        return self._pct_mismatches


def cut_year(series_id: str, worlds: dict[str, World]) -> int:
    return worlds[WORLD_OF_SERIES[series_id]].last_year


def _years(data: dict[str, SeriesData], series_id: str, worlds: dict[str, World]) -> range:
    return range(data[series_id].first_year, cut_year(series_id, worlds) + 1)


def world_total(series_id: str, worlds: dict[str, World]) -> dict[int, int | None]:
    """WIPO world total dividing the series (SHARE_DENOMINATOR); years after that world's last_year -> None."""
    world = worlds[SHARE_DENOMINATOR[series_id]]
    return {year: value if year <= world.last_year else None for year, value in world.published.items()}


def region_ids() -> list[str]:
    """M49 region ids with members, incl. 021 (= Northern America continent; region map mode needs it)."""
    return sorted({m49.region_of(code) for continent in m49.CONTINENTS for code in m49.members(continent)})


def group_continent(group_id: str) -> str:
    return group_id if group_id in m49.CONTINENTS else m49.region_continent(group_id)


def group_label(group_id: str) -> str:
    return m49.CONTINENTS[group_id] if group_id in m49.CONTINENTS else m49.region_label(group_id)


def series_of_group(group_id: str) -> tuple[str, ...]:
    """Series with figures for this group: continents all, regions `REGION_SERIES`. Unknown id -> KeyError;
    region without members -> ValueError (m49.json and the region list disagree)."""
    if group_id in m49.CONTINENTS:
        return tuple(series.id for series in SERIES)
    if not m49.members(group_id):
        raise ValueError(f"region {group_id} ({m49.region_label(group_id)}) has no member countries in m49.json")
    return REGION_SERIES


def basis(series_id: str, group_id: str) -> str:
    if group_id in m49.CONTINENTS and m49.continent_wipo_code(group_id, series_id) is not None:
        return WIPO_TOTAL
    return MEMBER_SUM


def has_member_sum(series_id: str) -> bool:
    """True when some group of the series is summed from members (needs the attribution floor)."""
    return series_id in REGION_SERIES or any(basis(series_id, continent) == MEMBER_SUM
                                             for continent in m49.CONTINENTS)


def basis_table() -> dict[str, dict[str, str | None]]:
    """Basis per series and group kind (None = not offered), published for the methods page."""
    continent = next(iter(m49.CONTINENTS))
    return {series.id: {"continent": basis(series.id, continent),
                        "region": MEMBER_SUM if series.id in REGION_SERIES else None} for series in SERIES}


def listed_members(data: dict[str, SeriesData], series_id: str, group_id: str) -> list[str]:
    """M49 members of the group that WIPO lists for the series."""
    values = data[series_id].values
    return [code for code in m49.members(group_id) if code in values]


def _sum(data: dict[str, SeriesData], series_id: str,
         codes: list[str]) -> tuple[dict[int, int | None], dict[int, int]]:
    values = data[series_id].values
    return derive.world_sum({code: values[code]["total"] for code in codes if code in values}, lambda code: True)


def _wipo_row(data: dict[str, SeriesData], series_id: str, continent: str) -> dict[int, int | None]:
    """WIPO's R row for a continent; SchemaError when missing or its label is not the continent label."""
    code = m49.continent_wipo_code(continent, series_id)
    series = data[series_id]
    expected = m49.CONTINENTS[continent]
    if code not in series.values:
        raise SchemaError(f"{series_id}: WIPO regional total {code} ({expected}) not listed")
    label = series.labels.get(code)
    if label != expected:
        raise SchemaError(f"{series_id}: {code} label {label!r}, expected {expected!r}")
    return series.values[code]["total"]


def floor_failures(data: dict[str, SeriesData], series_id: str, worlds: dict[str, World]) -> dict[int, str]:
    """Year -> null reason for every member_sum group of the series: `no_wipo_world_total` when the world total
    is null or provisional (fails closed), `attribution_floor` when sum(all grouped countries, before any
    nulling) / world total < GROUP_ATTRIBUTION_MIN (world 0 or nothing reported fails too)."""
    world = world_total(series_id, worlds)
    grouped = [code for code in data[series_id].values if m49.continent_of(code) is not None]
    sums, _ = _sum(data, series_id, grouped)
    minimum = Decimal(str(GROUP_ATTRIBUTION_MIN))
    reasons = {}
    for year in _years(data, series_id, worlds):
        total, grouped_sum = world.get(year), sums.get(year)
        if total is None:
            reasons[year] = NO_WIPO_WORLD_TOTAL
        elif total <= 0 or grouped_sum is None or Decimal(grouped_sum) < minimum * total:
            reasons[year] = ATTRIBUTION_FLOOR
    return reasons


def _group_series(series_id: str, group_id: str, ctx: Context) -> dict:
    data = ctx.data
    if series_id not in series_of_group(group_id):
        raise ValueError(f"{series_id} not offered for region {group_id}")
    years = _years(data, series_id, ctx.worlds)
    members = listed_members(data, series_id, group_id)
    sums, coverage = _sum(data, series_id, members)
    group_basis = basis(series_id, group_id)
    result: dict = {"basis": group_basis, "members": len(members),
                    "reporting": {year: coverage.get(year, 0) for year in years}}
    null_reason: dict[int, str] = {}
    if group_basis == WIPO_TOTAL:
        row = _wipo_row(data, series_id, group_id)
        total = {year: row.get(year) for year in years}
        null_reason = {year: NO_WIPO_REGIONAL_TOTAL for year, value in total.items() if value is None}
        extra = list(CROSSCHECK_EXTRA.get(series_id, {}).get(group_id, ()))
        check_sums, _ = _sum(data, series_id, members + extra)
        result["member_sum"] = {year: check_sums.get(year) for year in years}
    else:
        floor = ctx.floor(series_id)
        total = {}
        for year in years:
            total[year] = None if year in floor else sums.get(year)
            if year in floor:
                null_reason[year] = floor[year]
            elif total[year] is None:
                null_reason[year] = NONE_REPORTED
    result["total"] = total
    result["null_reason"] = null_reason
    return result


def pct_band_mismatches(data: dict[str, SeriesData], worlds: dict[str, World]) -> list[tuple[int, int, int | None]]:
    """Years where PCT ZZ - sum(R1-R6) != WIPO `**` Unknown: (year, residual, unknown). Years with ZZ or an R
    null are skipped (no residual); a missing `**` row mismatches every checked year."""
    series = data["pct_origin"]
    rows = [_wipo_row(data, "pct_origin", continent) for continent in m49.CONTINENTS]
    world = series.values[TOTAL_ROW_CODES["pct_origin"]]["total"]
    unknown = series.values.get(PCT_UNKNOWN_CODE, {}).get("total", {})
    mismatches = []
    for year in _years(data, "pct_origin", worlds):
        totals = [row.get(year) for row in rows]
        if world.get(year) is None or None in totals:
            continue
        residual = world[year] - sum(totals)
        if unknown.get(year) != residual:
            mismatches.append((year, residual, unknown.get(year)))
    return mismatches


def context(data: dict[str, SeriesData], worlds: dict[str, World] | None = None) -> Context:
    """One per run (build once, pass to every call); `worlds` defaults to world_figures(data)."""
    return Context(data, worlds if worlds is not None else world_figures(data))


def group_series(series_id: str, group_id: str, ctx: Context) -> dict:
    """{basis, total, reporting, members, null_reason, member_sum (wipo_total only)}; year maps keyed by int,
    first year of the series to its world last_year. Treat as read-only (continents shared via `ctx`)."""
    if group_id in m49.CONTINENTS:
        return ctx.continent(series_id, group_id)
    return _group_series(series_id, group_id, ctx)


def fixed_panel(data: dict[str, SeriesData], series_id: str, group_id: str, first: int, last: int) -> list[str]:
    """Listed members with a non-null value in every year first..last."""
    values = data[series_id].values
    return [code for code in listed_members(data, series_id, group_id)
            if all(values[code]["total"].get(year) is not None for year in range(first, last + 1))]


def panel_window(series_id: str, group_id: str, ctx: Context) -> tuple[int, int] | None:
    """member_sum groups only: last PANEL_YEARS years to the world last_year, from the series' first year and
    after the last floor failure (any reason). None when no year is left."""
    if basis(series_id, group_id) != MEMBER_SUM:
        raise ValueError(f"{group_id} {series_id}: no fixed panel on basis {WIPO_TOTAL} (R row has no member gaps)")
    last = cut_year(series_id, ctx.worlds)
    first = max(ctx.data[series_id].first_year, last - PANEL_YEARS + 1)
    failing = [year for year in ctx.floor(series_id) if year <= last]
    if failing:
        first = max(first, max(failing) + 1)
    return (first, last) if first <= last else None


def panel(series_id: str, group_id: str, ctx: Context) -> dict:
    """{first, last, members, total}: fixed panel and its per-year sum (null when the panel is empty)."""
    data = ctx.data
    window = panel_window(series_id, group_id, ctx)
    if window is None:
        return {"first": None, "last": None, "members": [], "total": {}}
    first, last = window
    codes = fixed_panel(data, series_id, group_id, first, last)
    sums, _ = _sum(data, series_id, codes)
    return {"first": first, "last": last, "members": codes,
            "total": {year: sums.get(year) for year in range(first, last + 1)}}


def unallocated(series_id: str, ctx: Context) -> dict[int, int | None]:
    """World total of the series (`world_total`) minus the sum of continent totals, per year."""
    world = world_total(series_id, ctx.worlds)
    continents = ctx.continents(series_id).values()
    result: dict[int, int | None] = {}
    for year in _years(ctx.data, series_id, ctx.worlds):
        totals = [figures["total"][year] for figures in continents]
        world_value = world.get(year)
        result[year] = None if world_value is None or None in totals else world_value - sum(totals)
    return result


def unallocated_label(series_id: str, ctx: Context) -> str:
    """Per-series band label; PCT "origin unknown" only while ZZ - sum(R) == `**` every year."""
    if series_id == "pct_origin" and ctx.pct_mismatches():
        return GENERIC_UNALLOCATED_LABEL
    return UNALLOCATED_LABEL[series_id]


def continent_share(series_id: str, ctx: Context) -> dict:
    """overview `continent_share` block: continent totals, unallocated band, its label, negative years, null
    reason per year (world total null -> `no_wipo_world_total`, else the first null continent's reason in
    CONTINENTS order). Values, not shares (site divides)."""
    continents = ctx.continents(series_id)
    band = unallocated(series_id, ctx)
    world = world_total(series_id, ctx.worlds)
    null_reason = {}
    for year in band:
        reasons = [figures["null_reason"][year] for figures in continents.values() if year in figures["null_reason"]]
        if world.get(year) is None:
            null_reason[year] = NO_WIPO_WORLD_TOTAL
        elif reasons:
            null_reason[year] = reasons[0]
    return {
        "continent": {continent: figures["total"] for continent, figures in continents.items()},
        "unallocated": band,
        "unallocated_label": unallocated_label(series_id, ctx),
        "negative_years": sorted(year for year, value in band.items() if value is not None and value < 0),
        "null_reason": null_reason,
    }


def check_warnings(ctx: Context) -> list[str]:
    """Manifest warnings (never blocking): cross-check outside GROUP_CROSSCHECK_RANGE, negative unallocated,
    PCT `**` band mismatch."""
    low, high = (Decimal(str(bound)) for bound in GROUP_CROSSCHECK_RANGE)
    warnings = []
    for series in SERIES:
        for continent, figures in ctx.continents(series.id).items():
            if figures["basis"] != WIPO_TOTAL:
                continue
            for year, total in figures["total"].items():
                member_sum = figures["member_sum"][year]
                if not total or member_sum is None:
                    continue
                gap = Decimal(total - member_sum) / total
                if not low <= gap <= high:
                    code = m49.continent_wipo_code(continent, series.id)
                    warnings.append(f"group cross-check {series.id} {continent} {year}: WIPO {code} {total} vs "
                                    f"member sum {member_sum} ({float(gap):+.1%}), outside "
                                    f"{float(low):+.0%}..{float(high):+.0%}")
        for year, value in unallocated(series.id, ctx).items():
            if value is not None and value < 0:
                warnings.append(f"group unallocated {series.id} {year}: negative ({value})")
    for year, residual, unknown in ctx.pct_mismatches():
        warnings.append(f"group PCT unknown band {year}: ZZ - sum(R1-R6) = {residual}, WIPO {PCT_UNKNOWN_CODE} = "
                        f"{unknown}")
    return warnings


def former_notes(group_id: str) -> list[dict]:
    """[{former, until, members}]: members of the group a former entity reported for, until (incl.) `until`
    (successors.json); one entry per (former, until)."""
    group_members = set(m49.members(group_id))
    notes: dict[tuple[str, int], list[str]] = {}
    for former, entries in m49.SUCCESSORS.items():
        for entry in entries:
            if entry["code"] in group_members:
                notes.setdefault((former, entry["to_year"]), []).append(entry["code"])
    return [{"former": former, "until": until, "members": sorted(codes)}
            for (former, until), codes in sorted(notes.items())]


def groups_list() -> list[dict]:
    """groups.json items: continents (CONTINENTS order), then regions by id."""
    return [{"id": group_id, "kind": "continent" if group_id in m49.CONTINENTS else "region",
             "label": group_label(group_id), "continent": group_continent(group_id),
             "members": m49.members(group_id)} for group_id in [*m49.CONTINENTS, *region_ids()]]
