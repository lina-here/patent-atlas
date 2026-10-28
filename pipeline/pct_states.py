"""PCT Contracting States: WIPO's list, transcribed by hand into `pct_states.json`, and the membership rule.

`pct_states.json` (reference data, never parsed from WIPO's documents by code):
- `source_url`: WIPO's page "PCT Contracting States"; each row = two-letter code (WIPO ST.3 = entities.json `code`),
  name as printed (footnote marks dropped), "Date on Which State Became Bound by the PCT" (`in_force`, ISO).
- `count_check_url`: WIPO's PDF "PCT Contracting States and Two-letter Codes (<count> on <date>)": `count` and
  `status_on` come from its heading. It prints MT for Mauritius (MU on the page): a WIPO misprint, not carried.
- `retrieved`: when the page was read. `continuing`: code -> the State it continues, where WIPO's footnote says the
  printed date is that State's (RU: Soviet Union; RS: Serbia and Montenegro); the date stays as printed.
- States sorted by code. A code with no WIPO entity stays listed (`unmatched`, reported by run.py).

Membership (map/pct_member.json, overview `pct_membership`; write.py): years PCT_FIRST_YEAR (treaty in force)..
status_on.year; member in year Y = in force by 31 December Y; in status_on.year the view is as of `status_on` (the same
result: no date is after it). A country entity not on the list = non-member (false) every year. A former entity (kind
historical) is never false: null, reason NOT_ON_CURRENT_LIST (the list names today's States only). Regional offices:
not on the map, skipped.
"""
from __future__ import annotations

import datetime
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from pipeline.entities import classify

PCT_STATES_PATH = Path(__file__).with_name("pct_states.json")
PCT_MEMBER_ID = "pct_member"
PCT_FIRST_YEAR = 1978  # PCT in force 24 January 1978
NOT_ON_CURRENT_LIST = "not_on_current_list"


@dataclass(frozen=True)
class PctStates:
    source_url: str
    count_check_url: str
    status_on: datetime.date
    retrieved: datetime.date
    count: int
    in_force: dict[str, datetime.date]
    names: dict[str, str]
    continuing: dict[str, str]


def _date(value: object, where: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(str(value))
    except ValueError:
        raise ValueError(f"pct_states: {where}: bad date {value!r} (YYYY-MM-DD)") from None


def load_pct_states(path: Path = PCT_STATES_PATH) -> PctStates:
    """The list; ValueError on a bad date, a duplicate code, a row count other than `count`, an `in_force` after
    `status_on`, `status_on` after `retrieved`, or a continuing State not on the list."""
    content = json.loads(path.read_text("utf-8"))
    status_on = _date(content["status_on"], "status_on")
    retrieved = _date(content["retrieved"], "retrieved")
    if status_on > retrieved:
        raise ValueError(f"pct_states: status_on {status_on} after retrieved {retrieved}")
    in_force: dict[str, datetime.date] = {}
    names: dict[str, str] = {}
    for state in content["states"]:
        code = state["code"]
        if code in in_force:
            raise ValueError(f"pct_states: duplicate code {code}")
        in_force[code] = _date(state["in_force"], code)
        if in_force[code] > status_on:
            raise ValueError(f"pct_states: {code} in force {in_force[code]} after status date {status_on}")
        names[code] = state["name"]
    count = content["count"]
    if len(in_force) != count:
        raise ValueError(f"pct_states: {len(in_force)} rows, count says {count}")
    continuing = dict(content.get("continuing", {}))
    if not set(continuing) <= set(in_force):
        raise ValueError(f"pct_states: continuing States not on the list: {sorted(set(continuing) - set(in_force))}")
    return PctStates(source_url=content["source_url"], count_check_url=content["count_check_url"], status_on=status_on,
                     retrieved=retrieved, count=count, in_force=in_force, names=names, continuing=continuing)


def last_year(states: PctStates) -> int:
    return states.status_on.year


def years(states: PctStates) -> range:
    return range(PCT_FIRST_YEAR, last_year(states) + 1)


def is_member(states: PctStates, code: str, year: int) -> bool:
    """In force by 31 December `year`; in the status year, on the status date."""
    since = states.in_force.get(code)
    if since is None:
        return False
    return since <= (states.status_on if year == last_year(states) else datetime.date(year, 12, 31))


def unmatched(states: PctStates, entity_codes: Iterable[str]) -> list[str]:
    """Listed codes with no WIPO entity, sorted."""
    known = set(entity_codes)
    return sorted(code for code in states.in_force if code not in known)


def member_years(states: PctStates, entity_codes: Iterable[str]) -> dict[str, dict[int, bool]]:
    """Country entity -> year -> member; former entities and regional offices absent (null_reasons). A listed code
    whose entity is not a country is an error (the list names States)."""
    result: dict[str, dict[int, bool]] = {}
    for code in sorted(entity_codes):
        kind = classify(code)
        if kind != "country":
            if code in states.in_force:
                raise ValueError(f"pct_states: listed {code} is a {kind} entity, not a country")
            continue
        result[code] = {year: is_member(states, code, year) for year in years(states)}
    return result


def null_reasons(entity_codes: Iterable[str]) -> dict[str, str]:
    """Former entities: null, never non-member."""
    return {code: NOT_ON_CURRENT_LIST for code in sorted(entity_codes) if classify(code) == "historical"}


def counts(states: PctStates) -> dict[int, int]:
    """States on the list that are members in each year (mapped and unmatched alike)."""
    return {year: sum(is_member(states, code, year) for code in states.in_force) for year in years(states)}
