"""PCT Contracting States: WIPO's list, transcribed by hand into `pct_states.json`, and the membership rule.

`pct_states.json` (reference data, never parsed from WIPO's documents by code):
- `source_url`: WIPO's page "PCT Contracting States"; each row = two-letter code (WIPO ST.3 = entities.json `code`),
  name as printed (footnote marks dropped), "Date on Which State Became Bound by the PCT" (`in_force`, ISO).
- `count_check_url`: WIPO's PDF "PCT Contracting States and Two-letter Codes (<count> on <date>)": `count` and
  `status_on` come from its heading. It prints MT for Mauritius as well as for Malta; the page gives MU, used here.
- `retrieved`: when the page was read. `continuing`: code -> the State WIPO's footnote names it the continuing State
  of (RU: Soviet Union; RS: Serbia and Montenegro); the date stays as printed.
- `territories` [{code, name, via, from, footnote}]: a territory the PCT applies to through a listed State (`via`)
  from `from`, as the page's footnote to that State prints it (`footnote`, verbatim; `name` as the footnote names it).
  Added only when `code` is an entities.json country entity; never a Contracting State, never counted.
- `successors` {predecessor: {name, source, codes, own_dates?, note?}}: the States that succeeded a predecessor, from
  ISO 3166 (`source`: ISO 3166-3 former country codes; ISO 3166-1 for a new code). Predecessor = a former entity of
  the data (not on the list; successors listed, own date = their printed date) or a listed State that continues (its
  successors' own dates in `own_dates`: the day each left it). `note` = where the list departs from ISO 3166.
- States sorted by code. A code with no WIPO entity stays listed (`unmatched`, reported by run.py).

Membership (map/pct_member.json, overview `pct_membership`; write.py): years PCT_FIRST_YEAR (treaty in force)..
status_on.year; member in year Y = in force by 31 December Y; in status_on.year the view is as of `status_on` (the same
result: no date is after it). A territory: true from its `from` (same rule), else false. A successor State: null
(SUCCESSOR_STATE) every year before its own date, never false then: the list gives no dates for former States, so
neither member nor non-member is claimed; from its own date, the member rule. Any other country entity not on the list
= non-member (false) every year. A former entity (kind historical) is never false: null, reason NOT_ON_CURRENT_LIST
(the list names today's States only).
Regional offices: not on the map, skipped. Counts = Contracting States only.
"""
from __future__ import annotations

import datetime
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from pipeline.entities import classify

PCT_STATES_PATH = Path(__file__).with_name("pct_states.json")
PCT_MEMBER_ID = "pct_member"
PCT_FIRST_YEAR = 1978  # PCT in force 24 January 1978
NOT_ON_CURRENT_LIST = "not_on_current_list"
SUCCESSOR_STATE = "successor_state"


@dataclass(frozen=True)
class Territory:
    """The PCT applies to `code` through the listed State `via` from `since` (WIPO footnote, verbatim)."""
    code: str
    name: str
    via: str
    since: datetime.date
    footnote: str


@dataclass(frozen=True)
class Predecessor:
    """A former entity of the data, or a listed State that continues, and its successor States (ISO 3166 `source`);
    `own_dates` = the day a successor left a continuing State (others: their printed date)."""
    code: str
    name: str
    source: str
    codes: tuple[str, ...]
    note: str = ""
    own_dates: dict[str, datetime.date] = field(default_factory=dict)


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
    territories: dict[str, Territory] = field(default_factory=dict)
    successors: dict[str, Predecessor] = field(default_factory=dict)


def _date(value: object, where: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(str(value))
    except ValueError:
        raise ValueError(f"pct_states: {where}: bad date {value!r} (YYYY-MM-DD)") from None


def _territories(rows: list[dict], in_force: dict[str, datetime.date],
                 status_on: datetime.date) -> dict[str, Territory]:
    result: dict[str, Territory] = {}
    for row in rows:
        code, via = row["code"], row["via"]
        if code in result:
            raise ValueError(f"pct_states: duplicate territory {code}")
        if code in in_force:
            raise ValueError(f"pct_states: territory {code} is a Contracting State on the list")
        if via not in in_force:
            raise ValueError(f"pct_states: territory {code} applies through {via}, not on the list")
        since = _date(row["from"], f"territory {code}")
        if since < in_force[via]:
            raise ValueError(f"pct_states: territory {code} from {since} before {via} bound ({in_force[via]})")
        if since > status_on:
            raise ValueError(f"pct_states: territory {code} from {since} after status date {status_on}")
        if not row.get("footnote"):
            raise ValueError(f"pct_states: territory {code} without its WIPO footnote")
        result[code] = Territory(code=code, name=row["name"], via=via, since=since, footnote=row["footnote"])
    return result


def _successors(content: dict[str, dict], in_force: dict[str, datetime.date],
                status_on: datetime.date) -> dict[str, Predecessor]:
    result: dict[str, Predecessor] = {}
    seen: set[str] = set()
    for predecessor, entry in content.items():
        codes = tuple(entry["codes"])
        own_dates = {code: _date(day, f"{predecessor} own date of {code}")
                     for code, day in entry.get("own_dates", {}).items()}
        if predecessor in codes:
            raise ValueError(f"pct_states: predecessor {predecessor} among its own successors")
        if not set(own_dates) <= set(codes):
            raise ValueError(f"pct_states: own dates of {predecessor} for codes not among its successors")
        if predecessor in in_force and set(own_dates) != set(codes):
            raise ValueError(f"pct_states: predecessor {predecessor} is on the list: own dates needed for {codes}")
        late = sorted(code for code, day in own_dates.items() if day > status_on)
        if late:
            raise ValueError(f"pct_states: own dates of {late} after status date {status_on}")
        missing = sorted(set(codes) - set(in_force) - set(own_dates))
        if missing:
            raise ValueError(f"pct_states: successors of {predecessor} not on the list: {missing}")
        twice = sorted(seen & set(codes))
        if twice:
            raise ValueError(f"pct_states: successor States under more than one predecessor: {twice}")
        seen |= set(codes)
        result[predecessor] = Predecessor(code=predecessor, name=entry["name"], source=entry["source"], codes=codes,
                                          note=entry.get("note", ""), own_dates=own_dates)
    return result


def load_pct_states(path: Path = PCT_STATES_PATH) -> PctStates:
    """The list; ValueError on a bad date, a duplicate code, a row count other than `count`, an `in_force` after
    `status_on`, `status_on` after `retrieved`, a continuing State not on the list, a bad territory (a listed State,
    `via` not listed, `from` before `via` was bound or after `status_on`, no footnote) or a bad successor entry (a
    successor neither listed nor given an own date, a listed predecessor without its successors' own dates, an own date
    after `status_on`, a successor under two predecessors)."""
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
                     retrieved=retrieved, count=count, in_force=in_force, names=names, continuing=continuing,
                     territories=_territories(content.get("territories", []), in_force, status_on),
                     successors=_successors(content.get("successors", {}), in_force, status_on))


def last_year(states: PctStates) -> int:
    return states.status_on.year


def years(states: PctStates) -> range:
    return range(PCT_FIRST_YEAR, last_year(states) + 1)


def _by(states: PctStates, since: datetime.date, year: int) -> bool:
    """`since` by 31 December `year`; in the status year, on the status date."""
    return since <= (states.status_on if year == last_year(states) else datetime.date(year, 12, 31))


def is_member(states: PctStates, code: str, year: int) -> bool:
    """A listed State in force by 31 December `year`; in the status year, on the status date."""
    since = states.in_force.get(code)
    return since is not None and _by(states, since, year)


def unmatched(states: PctStates, entity_codes: Iterable[str]) -> list[str]:
    """Listed codes with no WIPO entity, sorted."""
    known = set(entity_codes)
    return sorted(code for code in states.in_force if code not in known)


def successor_of(states: PctStates) -> dict[str, Predecessor]:
    """Successor State code -> the predecessor it succeeded."""
    return {code: predecessor for predecessor in states.successors.values() for code in predecessor.codes}


def own_date(states: PctStates, code: str) -> datetime.date:
    """A successor State's own date: the day it left a continuing State, else its printed date."""
    return successor_of(states)[code].own_dates.get(code) or states.in_force[code]


def _hidden_successors(states: PctStates, entity_codes: Iterable[str]) -> list[str]:
    """Successor States of the entities with a year before their own date (null years)."""
    successors = successor_of(states)
    return sorted(code for code in set(entity_codes)
                  if code in successors and not _by(states, own_date(states, code), PCT_FIRST_YEAR))


def member_years(states: PctStates, entity_codes: Iterable[str]) -> dict[str, dict[int, bool | None]]:
    """Country entity -> year -> member (territory: PCT applies; successor State: null before its date); former
    entities and regional offices absent (null_reasons). A listed code or territory whose entity is not a country is
    an error (the list names States)."""
    successors = successor_of(states)
    result: dict[str, dict[int, bool | None]] = {}
    for code in sorted(entity_codes):
        kind = classify(code)
        if kind != "country":
            if code in states.in_force or code in states.territories:
                raise ValueError(f"pct_states: listed {code} is a {kind} entity, not a country")
            continue
        if code in states.territories:
            result[code] = {year: _by(states, states.territories[code].since, year) for year in years(states)}
        elif code in successors:
            since = own_date(states, code)
            result[code] = {year: is_member(states, code, year) if _by(states, since, year) else None
                            for year in years(states)}
        else:
            result[code] = {year: is_member(states, code, year) for year in years(states)}
    return result


def null_reasons(states: PctStates, entity_codes: Iterable[str]) -> dict[str, str]:
    """Former entities (every year) and successor States (years before their own date): null, never non-member."""
    codes = list(entity_codes)
    reasons = {code: NOT_ON_CURRENT_LIST for code in codes if classify(code) == "historical"}
    reasons |= {code: SUCCESSOR_STATE for code in _hidden_successors(states, codes)}
    return dict(sorted(reasons.items()))


def counts(states: PctStates) -> dict[int, int]:
    """States on the list that are members in each year (mapped and unmatched alike); territories never counted."""
    return {year: sum(is_member(states, code, year) for code in states.in_force) for year in years(states)}
