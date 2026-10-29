"""PCT Contracting States: WIPO's list, transcribed by hand into `pct_states.json`, and the membership rule.

`pct_states.json` (reference data, never parsed from WIPO's documents by code):
- `source_url`: WIPO's page "PCT Contracting States"; each row = two-letter code (WIPO ST.3 = entities.json `code`),
  name as printed (footnote marks dropped), "Date on Which State Became Bound by the PCT" (`in_force`, ISO).
- `count_check_url`: WIPO's PDF "PCT Contracting States and Two-letter Codes (<count> on <date>)": `count` and
  `status_on` come from its heading. It prints MT for Mauritius as well as for Malta; the page gives MU, used here.
- `retrieved`: when the page was read. `continuing`: code -> the State WIPO's footnote names it the continuing State
  of (RU: Soviet Union; RS: Serbia and Montenegro); the date stays as printed.
- `territories` [{code, name, periods: [{via, from, to, source}]}]: a territory the PCT applies or applied to through
  a listed State (`via`) from `from` to `to` (null = still applies), each period with its WIPO sources [{document,
  url, text verbatim}]: the page's footnote to that State, or WIPO's PCT Notifications for a past period. Added only
  when `code` is an entities.json country entity (`name` as the source names it); never a State, never counted.
- `successors` {predecessor: {name, source, codes, end, end_source, bound_on?, own_dates?, note?}}: the States that
  succeeded a predecessor, from ISO 3166 (`source`: ISO 3166-3 former country codes; ISO 3166-1 for a new code).
  Predecessor = a former entity of the data (not on the list; successors listed, own date = their printed date) or a
  listed State that continues (`own_dates`: the day each successor left it, e.g. independence). Window = the years
  the successor's treaty status depended on the predecessor: from the predecessor's date as WIPO prints it (its own row,
  or `bound_on`, the row whose footnote says the date is the predecessor's; none: the series' start) to `end`
  (`end_source`). `note` = where the list departs from ISO 3166.
- States sorted by code. A code with no WIPO entity stays listed (`unmatched`, reported by run.py).

Membership (map/pct_member.json, overview `pct_membership`; write.py): years PCT_FIRST_YEAR (treaty in force)..
status_on.year; member in year Y = in force by 31 December Y; in status_on.year the view is as of `status_on` (the same
result: no date is after it). A span (territory period, successor window) covers Y when it starts by 31 December Y and
ends on or after 1 January Y (a span ending mid-year still covers that year). A territory: true in a year a period
covers, else false. A successor State: true from its own date; null (SUCCESSOR_STATE) in a year its window covers,
never false then (neither member nor non-member is claimed; conservative); else false.
Any other country entity not on the list = non-member (false) every year. A former entity (kind historical) is never
false: null, reason NOT_ON_CURRENT_LIST (the list names today's States only).
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
class Citation:
    """A WIPO document a period rests on: its name, link and the words relied on (verbatim)."""
    document: str
    url: str
    text: str


@dataclass(frozen=True)
class Period:
    """The PCT applied through the listed State `via` from `since` to `until` (None = still applies)."""
    via: str
    since: datetime.date
    until: datetime.date | None
    sources: tuple[Citation, ...]


@dataclass(frozen=True)
class Territory:
    """A territory the PCT applies or applied to through listed States, period by period (sorted, no overlap)."""
    code: str
    name: str
    periods: tuple[Period, ...]


@dataclass(frozen=True)
class Predecessor:
    """A former entity of the data, or a listed State that continues, and its successor States (ISO 3166 `source`);
    `own_dates` = the day a successor left a continuing State (others: their printed date)."""
    code: str
    name: str
    source: str
    codes: tuple[str, ...]
    end: datetime.date
    end_source: str
    bound_on: str = ""
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


def _period(code: str, row: dict, in_force: dict[str, datetime.date], status_on: datetime.date) -> Period:
    via = row["via"]
    if via not in in_force:
        raise ValueError(f"pct_states: territory {code} applies through {via}, not on the list")
    since = _date(row["from"], f"territory {code}")
    until = None if row.get("to") is None else _date(row["to"], f"territory {code} to")
    if since < in_force[via]:
        raise ValueError(f"pct_states: territory {code} from {since} before {via} bound ({in_force[via]})")
    if max(since, until or since) > status_on:
        raise ValueError(f"pct_states: territory {code} period {since}..{until} after status date {status_on}")
    if until is not None and until < since:
        raise ValueError(f"pct_states: territory {code} period ends {until} before it starts {since}")
    sources = tuple(Citation(document=cited["document"], url=cited["url"], text=cited["text"])
                    for cited in row.get("source", []))
    if not sources or not all(cited.document and cited.url and cited.text for cited in sources):
        raise ValueError(f"pct_states: territory {code} period {since} without its WIPO source (document, url, text)")
    return Period(via=via, since=since, until=until, sources=sources)


def _territories(rows: list[dict], in_force: dict[str, datetime.date],
                 status_on: datetime.date) -> dict[str, Territory]:
    result: dict[str, Territory] = {}
    for row in rows:
        code = row["code"]
        if code in result:
            raise ValueError(f"pct_states: duplicate territory {code}")
        if code in in_force:
            raise ValueError(f"pct_states: territory {code} is a Contracting State on the list")
        periods = tuple(_period(code, period, in_force, status_on) for period in row["periods"])
        if not periods:
            raise ValueError(f"pct_states: territory {code} without a period")
        for earlier, later in zip(periods, periods[1:]):
            if earlier.until is None or later.since <= earlier.until:
                raise ValueError(f"pct_states: territory {code} periods overlap or are not sorted ({later.since})")
        result[code] = Territory(code=code, name=row["name"], periods=periods)
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
        bound_on = entry.get("bound_on", "")
        if bound_on and (bound_on not in in_force or predecessor in in_force):
            raise ValueError(f"pct_states: {predecessor} bound on {bound_on}: not listed, or {predecessor} listed")
        end = _date(entry.get("end"), f"{predecessor} end")
        start = in_force.get(predecessor) or in_force.get(bound_on) or datetime.date(PCT_FIRST_YEAR, 1, 1)
        if not start <= end <= status_on or not entry.get("end_source"):
            raise ValueError(f"pct_states: {predecessor} end {end} before its start {start}, after the status date "
                             "or without its source")
        if any(day <= end for day in own_dates.values()):
            raise ValueError(f"pct_states: an own date of {predecessor}'s successors is not after its end {end}")
        missing = sorted(set(codes) - set(in_force) - set(own_dates))
        if missing:
            raise ValueError(f"pct_states: successors of {predecessor} not on the list: {missing}")
        twice = sorted(seen & set(codes))
        if twice:
            raise ValueError(f"pct_states: successor States under more than one predecessor: {twice}")
        seen |= set(codes)
        result[predecessor] = Predecessor(code=predecessor, name=entry["name"], source=entry["source"], codes=codes,
                                          end=end, end_source=entry["end_source"], bound_on=bound_on,
                                          note=entry.get("note", ""), own_dates=own_dates)
    return result


def load_pct_states(path: Path = PCT_STATES_PATH) -> PctStates:
    """The list; ValueError on a bad date, a duplicate code, a row count other than `count`, an `in_force` after
    `status_on`, `status_on` after `retrieved`, a continuing State not on the list, a bad territory (a listed State,
    `via` not listed, a period before `via` was bound, after `status_on`, unsorted or overlapping, a period without
    its cited sources) or a bad successor entry (a successor neither listed nor given an own date, a listed predecessor
    without its successors' own dates, an own date after `status_on` or not after `end`, a successor under two
    predecessors, `bound_on` not listed, `end` bad, before the window's start, after `status_on` or without
    `end_source`)."""
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


def window_start(states: PctStates, predecessor: Predecessor) -> datetime.date | None:
    """The predecessor's date as WIPO prints it (its own row, or the row `bound_on` whose footnote says the date is
    the predecessor's); None = not printed: the series' start."""
    return states.in_force.get(predecessor.code) or states.in_force.get(predecessor.bound_on)


def _covers(states: PctStates, since: datetime.date | None, until: datetime.date | None, year: int) -> bool:
    """`since`..`until` reaches into `year` (31 December rule: a span that ends mid-year still covers that year)."""
    return (since is None or _by(states, since, year)) and (until is None or until >= datetime.date(year, 1, 1))


def _successor_year(states: PctStates, code: str, year: int) -> bool | None:
    """Member from its own date; null in a year the predecessor's window covers; else false."""
    if is_member(states, code, year):
        return True
    predecessor = successor_of(states)[code]
    return None if _covers(states, window_start(states, predecessor), predecessor.end, year) else False


def _territory_year(states: PctStates, territory: Territory, year: int) -> bool:
    return any(_covers(states, period.since, period.until, year) for period in territory.periods)


def _hidden_successors(states: PctStates, entity_codes: Iterable[str]) -> list[str]:
    """Successor States of the entities with a null year (window before their own date)."""
    successors = successor_of(states)
    return sorted(code for code in set(entity_codes) if code in successors
                  and any(_successor_year(states, code, year) is None for year in years(states)))


def member_years(states: PctStates, entity_codes: Iterable[str]) -> dict[str, dict[int, bool | None]]:
    """Country entity -> year -> member (territory: PCT applies; successor State: null in its window); former
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
            result[code] = {year: _territory_year(states, states.territories[code], year) for year in years(states)}
        elif code in successors:
            result[code] = {year: _successor_year(states, code, year) for year in years(states)}
        else:
            result[code] = {year: is_member(states, code, year) for year in years(states)}
    return result


def null_reasons(states: PctStates, entity_codes: Iterable[str]) -> dict[str, str]:
    """Former entities (every year) and successor States (years in their window): null, never non-member."""
    codes = list(entity_codes)
    reasons = {code: NOT_ON_CURRENT_LIST for code in codes if classify(code) == "historical"}
    reasons |= {code: SUCCESSOR_STATE for code in _hidden_successors(states, codes)}
    return dict(sorted(reasons.items()))


def counts(states: PctStates) -> dict[int, int]:
    """States on the list that are members in each year (mapped and unmatched alike); territories never counted."""
    return {year: sum(is_member(states, code, year) for code in states.in_force) for year in years(states)}
