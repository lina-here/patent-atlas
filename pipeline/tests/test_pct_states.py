"""PCT Contracting States (pipeline/pct_states.py, pct_states.json): the hand-transcribed list and the membership rule."""
import datetime
import json
from collections import Counter
from pathlib import Path

import pytest

from pipeline import pct_states
from pipeline.pct_states import (Former, PctStates, Territory, load_pct_states, member_years, null_reasons,
                                  successor_of, unmatched)

DATA = Path(__file__).resolve().parents[2] / "site" / "data"
# WIPO's count on each transcribed list: status date -> States (PDF heading "159 on 1 October 2026"). A new list adds its
# own pair (README, Updating the PCT states list).
PINNED_COUNTS = {datetime.date(2026, 10, 1): 159}
# Codes as printed in WIPO's two-letter-code PDF (count_check_url), hand-copied in its order. The PDF prints MT for
# Mauritius as well as for Malta; WIPO's page gives Mauritius MU. So MT appears twice and MU never.
PDF_PRINTED_CODES = """
AE AG AL AM AO AT AU AZ BA BB BE BF BG BH BJ BN BR BS BW BY BZ CA CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO
DZ EC EE EG ES FI FR GA GB GD GE GH GM GN GQ GR GT GW HN HR HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KP KR KW
KZ LA LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MN MR MT MT MW MX MY MZ NA NE NG NI NL NO NZ OM PA PE PG PH PL PT
QA RO RS RU RW SA SC SD SE SG SI SK SL SM SN ST SV SY SZ TD TG TH TJ TM TN TR TT TZ UA UG US UY UZ VC VN WS ZA ZM ZW
""".split()


def raw() -> dict:
    return json.loads(pct_states.PCT_STATES_PATH.read_text("utf-8"))


def write_list(tmp_path, **changes) -> Path:
    content = {**raw(), **changes}
    path = tmp_path / "pct_states.json"
    path.write_text(json.dumps(content), "utf-8")
    return path


def made(in_force: dict[str, str], status_on: str = "2026-10-01", territories: dict[str, tuple[str, str]] | None = None,
         successors: dict[str, list[str]] | None = None) -> PctStates:
    """A list in memory: territories code -> (via, from); successors former -> codes."""
    return PctStates(source_url="https://example.org/list", count_check_url="https://example.org/list.pdf",
                     status_on=datetime.date.fromisoformat(status_on), retrieved=datetime.date(2026, 10, 28),
                     count=len(in_force),
                     in_force={code: datetime.date.fromisoformat(day) for code, day in in_force.items()},
                     names={code: code for code in in_force}, continuing={},
                     territories={code: Territory(code, code, via, datetime.date.fromisoformat(day), "footnote")
                                  for code, (via, day) in (territories or {}).items()},
                     successors={former: Former(former, former, "XXXX", tuple(codes))
                                 for former, codes in (successors or {}).items()})


def entities() -> list[dict]:
    return json.loads((DATA / "entities.json").read_text("utf-8"))


def test_count_matches_list():
    states = load_pct_states()
    assert len(raw()["states"]) == states.count == len(states.in_force)
    assert PINNED_COUNTS[states.status_on] == states.count


def test_bahamas_present():
    states = load_pct_states()
    assert states.in_force["BS"] == datetime.date(2026, 8, 19)
    assert states.names["BS"] == "Bahamas"


def test_dates_valid_and_not_after_status():
    content = raw()
    status_on = datetime.date.fromisoformat(content["status_on"])
    assert status_on <= datetime.date.fromisoformat(content["retrieved"])
    for state in content["states"]:
        assert datetime.date.fromisoformat(state["in_force"]) <= status_on, state


def test_codes_unique_sorted():
    codes = [state["code"] for state in raw()["states"]]
    assert codes == sorted(set(codes))
    assert all(len(code) == 2 and code.isascii() and code.isupper() for code in codes)
    assert all(state["name"] and not state["name"][-1].isdigit() for state in raw()["states"])  # no footnote marks


def test_page_codes_equal_pdf_codes():
    """The page's rows (the source) against the PDF's printed codes (the count check): the same States, but for the
    PDF's MT printed for Mauritius."""
    printed = Counter(PDF_PRINTED_CODES)
    assert sum(printed.values()) == PINNED_COUNTS[datetime.date(2026, 10, 1)] and printed["MT"] == 2
    expected = sorted((set(printed) | {"MU"}))
    assert sorted(load_pct_states().in_force) == expected


def test_continuing_states_listed():
    states = load_pct_states()
    assert states.continuing == {"RS": "Serbia and Montenegro", "RU": "Soviet Union"}
    assert set(states.continuing) <= set(states.in_force)


def test_codes_known_or_reported():
    """Every code is an entities.json code or reported by the run (`unmatched`, printed by run.py)."""
    states = load_pct_states()
    codes = {entity["code"] for entity in json.loads((DATA / "entities.json").read_text("utf-8"))}
    reported = unmatched(states, codes)
    assert reported == sorted(code for code in states.in_force if code not in codes)
    assert all(code in codes or code in reported for code in states.in_force)


def test_load_rejects_bad_date(tmp_path):
    states = raw()["states"]
    with pytest.raises(ValueError, match="date"):
        load_pct_states(write_list(tmp_path, states=[{**states[0], "in_force": "1999-02-30"}, *states[1:]]))
    with pytest.raises(ValueError, match="date"):
        load_pct_states(write_list(tmp_path, status_on="1 October 2026"))


def test_load_rejects_count_mismatch(tmp_path):
    with pytest.raises(ValueError, match="count"):
        load_pct_states(write_list(tmp_path, count=158))


def test_load_rejects_duplicate_code(tmp_path):
    states = raw()["states"]
    with pytest.raises(ValueError, match="duplicate"):
        load_pct_states(write_list(tmp_path, states=[*states[:-1], {**states[-1], "code": states[0]["code"]}]))


def test_load_rejects_date_after_status(tmp_path):
    states = raw()["states"]
    with pytest.raises(ValueError, match="after"):
        load_pct_states(write_list(tmp_path, states=[{**states[0], "in_force": "2026-10-02"}, *states[1:]]))
    with pytest.raises(ValueError, match="after"):
        load_pct_states(write_list(tmp_path, retrieved="2026-09-30"))


def test_load_rejects_unlisted_continuing_state(tmp_path):
    with pytest.raises(ValueError, match="continuing"):
        load_pct_states(write_list(tmp_path, continuing={"SU": "Soviet Union"}))


def test_member_years_31_december():
    states = made({"BS": "2026-08-19", "CH": "2010-12-31", "DE": "2011-01-01", "US": "2026-10-01"})
    years = member_years(states, ["BS", "CH", "DE", "US"])
    assert set(years["BS"]) == set(range(pct_states.PCT_FIRST_YEAR, 2027))
    assert (years["BS"][2025], years["BS"][2026]) == (False, True)
    assert (years["CH"][2009], years["CH"][2010]) == (False, True)  # in force 31 December Y: member in Y
    assert (years["DE"][2010], years["DE"][2011]) == (False, True)  # 1 January Y+1: not in Y
    assert years["US"][2026] is True  # latest year: in force on the status date


def test_former_entity_null_not_false():
    """A former entity (kind historical) never shows as a non-member: null, reason not_on_current_list."""
    states = made({"CH": "1978-01-24"})
    codes = ["CH", "SU", "VA", "EP"]  # country listed, former, country not listed, regional office
    years = member_years(states, codes)
    assert set(years) == {"CH", "VA"}
    assert not any(years["VA"].values())  # a country not on the list: non-member every year
    assert null_reasons(states, codes) == {"SU": pct_states.NOT_ON_CURRENT_LIST}


def test_counts_per_year():
    states = made({"BS": "2026-08-19", "CH": "1978-01-24", "ZZ": "1990-05-01"})  # ZZ: a state with no entity
    counts = pct_states.counts(states)
    assert (counts[1978], counts[1989], counts[1990], counts[2025], counts[2026]) == (1, 1, 2, 2, 3)
    assert counts[pct_states.last_year(states)] == states.count
    assert unmatched(states, ["BS", "CH"]) == ["ZZ"]


# ---- Territories (WIPO's page footnotes) and successor States (ISO 3166-3) ----

# Territory -> (State it applies through, from), as WIPO's footnotes print them: Hong Kong, China (China's footnote:
# "with effect from 1 July 1997"); Curaçao, Sint Maarten, Bonaire, Sint Eustatius and Saba (the Netherlands' footnote:
# ratification for the Netherlands Antilles, continuing after 10 October 2010; from the Netherlands' own date);
# Bailiwick of Guernsey (the United Kingdom's footnote: "with effect from 23 March 2021").
TERRITORIES = {"BQ": ("NL", "1979-07-10"), "CW": ("NL", "1979-07-10"), "GG": ("GB", "2021-03-23"),
               "HK": ("CN", "1997-07-01"), "SX": ("NL", "1979-07-10")}
# Former entity -> its successor States on the list. ISO 3166-3: SUHH (13 codes) plus Belarus and Ukraine (Soviet
# republics with their own ISO 3166-1 codes); CSHH; YUCS (renamed Serbia and Montenegro) then CSXX.
SUCCESSORS = {"CS": ("CZ", "SK"),
              "SU": ("AM", "AZ", "BY", "EE", "GE", "KG", "KZ", "LT", "LV", "MD", "RU", "TJ", "TM", "UA", "UZ"),
              "YU": ("ME", "RS")}
# Former entities with no successor-State rule: AN's successors are territories (footnoted, own dates); DD merged into
# Germany, bound since the PCT's first year; ZR's successor (CD) is not on the list.
FORMER_WITHOUT_SUCCESSORS = {"AN", "DD", "ZR"}
# Country entities not on the list and no footnoted territory, reviewed against WIPO's page: non-member States and
# areas; MO: footnote "Not applicable to Macau, China". A new entity fails here until reviewed (a footnoted territory
# goes into `territories`, anything else here).
REVIEWED_NON_MEMBERS = set("""
AD AF AR BD BI BO BT CD CK ER ET FJ FM GY HT KI LB MH MM MO MV NP NR NU PK PW PY SB SO SR SS TL TO TV VA VE VU YE
""".split())


def test_territories_transcribed():
    states = load_pct_states()
    assert {code: (t.via, t.since.isoformat()) for code, t in states.territories.items()} == TERRITORIES
    for code in ("CW", "SX", "BQ"):
        assert states.territories[code].since == states.in_force["NL"]  # the Netherlands' printed date
    assert states.territories["HK"].footnote == "Applies also to Hong Kong, China with effect from 1 July 1997."
    assert "Bailiwick of Guernsey with effect from 23 March 2021" in states.territories["GG"].footnote
    assert states.territories["CW"].footnote.startswith("Ratification for the Kingdom in Europe, the Netherlands")
    assert [t["code"] for t in raw()["territories"]] == sorted(TERRITORIES)


def test_territories_are_country_entities_not_states():
    """A territory is added only when its code is an entities.json country entity; never a Contracting State."""
    states = load_pct_states()
    kinds = {entity["code"]: entity["kind"] for entity in entities()}
    for code, territory in states.territories.items():
        assert kinds.get(code) == "country", code
        assert code not in states.in_force and territory.via in states.in_force


def test_non_listed_country_entities_reviewed():
    states = load_pct_states()
    countries = {entity["code"] for entity in entities() if entity["kind"] == "country"}
    assert countries - set(states.in_force) - set(states.territories) == REVIEWED_NON_MEMBERS


def test_successors_transcribed():
    states = load_pct_states()
    assert {former: entry.codes for former, entry in states.successors.items()} == SUCCESSORS
    assert {former: entry.name for former, entry in states.successors.items()} == {
        "CS": "Czechoslovakia", "SU": "Soviet Union", "YU": "Yugoslavia (Serbia and Montenegro from 2003)"}
    assert successor_of(states)["UA"].code == "SU" and successor_of(states)["ME"].code == "YU"


def test_former_entities_reviewed():
    historical = {entity["code"] for entity in entities() if entity["kind"] == "historical"}
    assert set(load_pct_states().successors) | FORMER_WITHOUT_SUCCESSORS == historical
    assert not set(load_pct_states().successors) & FORMER_WITHOUT_SUCCESSORS


def test_member_years_territories():
    """A territory: true from its footnoted date (31 December rule), false before; never counted as a State."""
    states = load_pct_states()
    years = member_years(states, ["CN", "HK", "MO", "GB", "GG", "NL", "CW", "SX", "BQ"])
    assert (years["HK"][1996], years["HK"][1997]) == (False, True)
    assert (years["GG"][2020], years["GG"][2021]) == (False, True)
    for code in ("CW", "SX", "BQ"):
        assert (years[code][1978], years[code][1979]) == (False, True)
    assert not any(years["MO"].values())  # footnote: not applicable to Macau, China
    without = PctStates(**{**states.__dict__, "territories": {}})
    assert pct_states.counts(states) == pct_states.counts(without)  # States only
    assert null_reasons(states, ["HK", "GG"]) == {}


def test_member_years_territory_31_december():
    states = made({"CN": "1994-01-01"}, territories={"HK": ("CN", "1997-12-31"), "MO": ("CN", "1998-01-01")})
    years = member_years(states, ["CN", "HK", "MO"])
    assert (years["HK"][1996], years["HK"][1997]) == (False, True)
    assert (years["MO"][1997], years["MO"][1998]) == (False, True)
    assert years["HK"][2026] is True


def test_successor_state_null_before_own_date():
    """A successor State: null (successor_state) every year before its own date, never false; true from it."""
    states = load_pct_states()
    codes = ["UA", "BY", "KZ", "AZ", "RU", "CZ", "SK", "ME", "RS", "SI", "DE", "SU", "CS", "YU"]
    years = member_years(states, codes)
    assert (years["UA"][1985], years["UA"][1990], years["UA"][1991]) == (None, None, True)
    assert (years["AZ"][1994], years["AZ"][1995]) == (None, True)
    assert (years["CZ"][1992], years["CZ"][1993]) == (None, True)
    assert (years["ME"][2005], years["ME"][2006]) == (None, True)
    assert (years["RS"][1996], years["RS"][1997]) == (None, True)
    assert all(years["RU"].values())  # continuing State: the Soviet Union's date
    assert years["SI"][1990] is False  # not an ISO 3166-3 successor of YU
    assert all(years["DE"].values())
    for code in ("UA", "BY", "KZ", "AZ", "CZ", "SK", "ME", "RS"):
        assert False not in years[code].values(), code
    assert null_reasons(states, codes) == {
        **{code: pct_states.SUCCESSOR_STATE for code in ("AZ", "BY", "CZ", "KZ", "ME", "RS", "SK", "UA")},
        **{code: pct_states.NOT_ON_CURRENT_LIST for code in ("CS", "SU", "YU")}}


def test_successor_counts_unchanged():
    states = load_pct_states()
    without = PctStates(**{**states.__dict__, "successors": {}})
    assert pct_states.counts(states) == pct_states.counts(without)


def test_load_rejects_bad_territory(tmp_path):
    good = raw()["territories"]
    hk = next(t for t in good if t["code"] == "HK")
    rest = [t for t in good if t["code"] != "HK"]
    for change, match in (({"via": "MO"}, "not on the list"), ({"code": "CN"}, "Contracting State"),
                          ({"from": "1993-12-31"}, "before"), ({"from": "2026-10-02"}, "after"),
                          ({"from": "1 July 1997"}, "date"), ({"footnote": ""}, "footnote")):
        with pytest.raises(ValueError, match=match):
            load_pct_states(write_list(tmp_path, territories=[*rest, {**hk, **change}]))
    with pytest.raises(ValueError, match="duplicate"):
        load_pct_states(write_list(tmp_path, territories=[*good, hk]))


def test_load_rejects_bad_successors(tmp_path):
    good = raw()["successors"]
    for change, match in (({"CS": {**good["CS"], "codes": ["CZ", "QZ"]}}, "not on the list"),
                          ({"CS": {**good["CS"], "codes": ["CZ", "SK", "UA"]}}, "more than one"),
                          ({"CH": {**good["CS"], "codes": ["DE"]}}, "on the list")):
        with pytest.raises(ValueError, match=match):
            load_pct_states(write_list(tmp_path, successors={**good, **change}))
