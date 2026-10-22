"""Regression check: a refresh's outputs against the committed data in the out dir (run.py, before writing).

Blocking (run fails unless `--accept-regression`): a series' `manifest.last_year`, an overview `world_last_year` or
`top_year` moved back; a committed entity/<code>.json or group/<id>.json no longer published (its page and links
would break).
Warning (manifest `checks.regression`): past years revised, entity `series.<s>.types.<t>` and overview
world_office / pct_world; entity years before the committed last_year of the series, world years before the
committed overview world_last_year of that world (cut short of last_year when coverage lags): old > 0 and change above
REVISION_WARN_PCT % of old (exact decimal; gender shares too: relative to the old share, not percentage points);
old 0 -> any other value; old value -> null or absent ("withdrawn"). Gender (women_any, women_share): entity
`gender.<m>.value` and overview `gender.world.<m>`, years before the committed manifest last_year of the measure;
data committed before it had one is not compared. The latest committed
year is not compared (WIPO revises it routinely). Old null -> value = backfill, not listed. Sorted: withdrawn
first (a figure the site showed is gone), then 0 base, then |change| % descending; first REVISION_LIST_MAX kept,
all counted.
Out dir without manifest.json (first run) -> nothing compared.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from pipeline import write
from pipeline.worlds import WORLD_SOURCES

REVISION_WARN_PCT = 5
REVISION_LIST_MAX = 20
# sort tier: withdrawn, then 0 -> value (no finite percentage), then by |change| %
TIER_WITHDRAWN, TIER_ZERO_BASE, TIER_CHANGED = 2, 1, 0


@dataclass
class Regression:
    blocking: list[str] = field(default_factory=list)
    revisions: list[str] = field(default_factory=list)
    revision_count: int = 0


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _decimal(value: int | float) -> Decimal:
    return Decimal(repr(value))  # a share as written (18.1), never its binary float


def _revised(where: str, old: dict[str, int | float | None], new: dict[str, int | float | None],
             before: int) -> list[tuple[int, Decimal, str]]:
    """(sort tier, |change| %, line) per year < `before` whose committed value `old` was revised past the warning rule."""
    found = []
    for year, was in old.items():
        if int(year) >= before or was is None:
            continue
        now = new.get(year)
        if now is None:
            found.append((TIER_WITHDRAWN, Decimal(0), f"{where} {year}: {was} -> null (withdrawn)"))
        elif was == 0:
            if now != 0:
                found.append((TIER_ZERO_BASE, Decimal(0), f"{where} {year}: 0 -> {now}"))
        elif was > 0 and abs(_decimal(now) - _decimal(was)) * 100 > _decimal(was) * REVISION_WARN_PCT:
            change = ((_decimal(now) - _decimal(was)) * 100 / _decimal(was)).quantize(Decimal("0.1"),
                                                                                       rounding=ROUND_HALF_UP)
            found.append((TIER_CHANGED, abs(change), f"{where} {year}: {was} -> {now} ({change:+}%)"))
    return found


def _moved_back_overview(old_overview: dict, new_overview: dict) -> list[str]:
    """Blocking lines: overview world_last_year[<world>] and top_year lower than committed."""
    lines = []
    old_worlds, new_worlds = old_overview.get("world_last_year", {}), new_overview.get("world_last_year", {})
    for key, old in sorted(old_worlds.items()):
        new = new_worlds.get(key)
        if old is not None and new is not None and new < old:
            lines.append(f"overview world_last_year {key} moved back {old} -> {new}")
    old_top, new_top = old_overview.get("top_year"), new_overview.get("top_year")
    if old_top is not None and new_top is not None and new_top < old_top:
        lines.append(f"overview top_year moved back {old_top} -> {new_top}")
    return lines


def _gender_revised(where: str, old: dict, new: dict, old_last: dict[str, int]) -> list[tuple[int, Decimal, str]]:
    """Revised past gender values: `old` / `new` = {measure: {"value": {year: share}}}; measures without a committed
    last_year (data before Stage W) skipped."""
    found = []
    for measure, block in sorted(old.items()):
        if measure in old_last:
            found += _revised(f"{where} {measure}", block["value"], new.get(measure, {}).get("value", {}),
                              old_last[measure])
    return found


def compare(outputs: dict[Path, dict | list], root: Path) -> Regression:
    """Regression of `outputs` (write.build_outputs) against the data committed under `root`."""
    if not (root / write.MANIFEST).is_file():
        return Regression()
    old_last: dict[str, int] = _read(root / write.MANIFEST).get("last_year", {})
    new_last: dict[str, int] = outputs[write.MANIFEST]["last_year"]
    blocking = [f"last_year {series_id} moved back {old} -> {new_last[series_id]}"
                for series_id, old in sorted(old_last.items())
                if series_id in new_last and new_last[series_id] < old]
    old_overview_path = root / write.OVERVIEW
    old_overview = _read(old_overview_path) if old_overview_path.is_file() else {}
    new_overview = outputs.get(write.OVERVIEW, {})
    blocking += _moved_back_overview(old_overview, new_overview)
    for folder, kind in ((write.ENTITY_DIR, "entity"), (write.GROUP_DIR, "group")):
        for path in sorted((root / folder).glob("*.json")):
            if path.relative_to(root) not in outputs:
                blocking.append(f"{kind} {path.stem} ({_read(path).get('label', path.stem)}) no longer published")

    found: list[tuple[int, Decimal, str]] = []
    for path in sorted(outputs):
        if path.parent != write.ENTITY_DIR or not (root / path).is_file():
            continue
        new_series, old_entity = outputs[path]["series"], _read(root / path)
        for series_id, block in old_entity["series"].items():
            if series_id not in old_last:
                continue
            new_types = new_series.get(series_id, {}).get("types", {})
            for type_key, years in block["types"].items():
                found += _revised(f"entity {path.stem} {series_id} {type_key}", years, new_types.get(type_key, {}),
                                  old_last[series_id])
        found += _gender_revised(f"entity {path.stem}", old_entity.get("gender", {}), outputs[path].get("gender", {}),
                                 old_last)
    for key in write.PUBLISHED_WORLDS:
        series_id = WORLD_SOURCES[key][0]
        if series_id in old_last:
            # worlds are cut at their own world_last_year, which can lag the series' last_year
            before = old_overview.get("world_last_year", {}).get(key, old_last[series_id])
            found += _revised(f"overview {key}", old_overview.get(key, {}), new_overview.get(key, {}), before)
    old_world, new_world = ({measure: {"value": years} for measure, years in overview.get("gender", {}).get(
        "world", {}).items()} for overview in (old_overview, new_overview))
    found += _gender_revised("overview world", old_world, new_world, old_last)
    found.sort(key=lambda item: (-item[0], -item[1], item[2]))
    return Regression(blocking, [line for _, _, line in found[:REVISION_LIST_MAX]], len(found))
