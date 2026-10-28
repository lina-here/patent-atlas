"""PCT Contracting States (pipeline/pct_states.py, pct_states.json): the hand-transcribed list and the membership rule."""
import datetime
import json
from collections import Counter
from pathlib import Path

import pytest

from pipeline import pct_states
from pipeline.pct_states import PctStates, load_pct_states, member_years, null_reasons, unmatched

DATA = Path(__file__).resolve().parents[2] / "site" / "data"
# WIPO's count on each transcribed list: status date -> States (PDF heading "159 on 1 October 2026"). A new list adds its
# own pair (README, Updating the PCT states list).
PINNED_COUNTS = {datetime.date(2026, 10, 1): 159}
# Codes as printed in WIPO's two-letter-code PDF (count_check_url), hand-copied in its order. The PDF prints MT for
# Mauritius (a misprint: Malta is MT, Mauritius MU on WIPO's page and in ST.3), so MT appears twice and MU never.
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


def made(in_force: dict[str, str], status_on: str = "2026-10-01") -> PctStates:
    return PctStates(source_url="https://example.org/list", count_check_url="https://example.org/list.pdf",
                     status_on=datetime.date.fromisoformat(status_on), retrieved=datetime.date(2026, 10, 28),
                     count=len(in_force), in_force={code: datetime.date.fromisoformat(day) for code, day in in_force.items()},
                     names={code: code for code in in_force}, continuing={})


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
    assert null_reasons(codes) == {"SU": pct_states.NOT_ON_CURRENT_LIST}


def test_counts_per_year():
    states = made({"BS": "2026-08-19", "CH": "1978-01-24", "ZZ": "1990-05-01"})  # ZZ: a state with no entity
    counts = pct_states.counts(states)
    assert (counts[1978], counts[1989], counts[1990], counts[2025], counts[2026]) == (1, 1, 2, 2, 3)
    assert counts[pct_states.last_year(states)] == states.count
    assert unmatched(states, ["BS", "CH"]) == ["ZZ"]
