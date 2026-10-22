import json
import sys
from pathlib import Path

import pytest

from pipeline import m49
from pipeline.entities import HISTORICAL, classify
from pipeline.m49 import (CONTINENTS, NO_GROUP, SUCCESSORS, continent_equal_to, continent_of, continent_wipo_code,
                          iso_numeric, members, region_label, region_of)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import build_m49  # noqa: E402

SOVIET_SUCCESSORS = ["AM", "AZ", "BY", "EE", "GE", "KZ", "KG", "LV", "LT", "MD", "RU", "TJ", "TM", "UA", "UZ"]


def test_continents_slugs_and_labels():
    assert CONTINENTS == {
        "africa": "Africa",
        "northern-america": "Northern America",
        "latin-america-caribbean": "Latin America and the Caribbean",
        "asia": "Asia",
        "europe": "Europe",
        "oceania": "Oceania",
    }


def test_region_of_and_labels():
    assert region_of("CN") == "030"
    assert region_label("030") == "Eastern Asia"
    assert region_of("BR") == "005"
    assert region_label("005") == "South America"
    assert region_of("NG") == "011"  # Sub-Saharan Africa -> intermediate region
    assert region_label("011") == "Western Africa"
    assert region_of("CH") == "155"  # outside 419/202 -> sub-region


def test_channel_islands_in_northern_europe():
    assert region_of("GG") == "154"
    assert region_of("JE") is None  # not a WIPO entity: not mapped
    assert region_label("154") == "Northern Europe"


@pytest.mark.parametrize("code", ["EP", "SU", "EU", "WD", "R1", "TW", "XX"])
def test_region_of_none_for_non_countries(code):
    assert region_of(code) is None
    assert continent_of(code) is None


def test_continent_of():
    assert continent_of("MX") == "latin-america-caribbean"
    assert continent_of("US") == "northern-america"
    assert continent_of("CN") == "asia"
    assert continent_of("TR") == "asia"
    assert continent_of("RU") == "europe"
    assert continent_of("EG") == "africa"
    assert continent_of("AU") == "oceania"


def test_northern_america_region_equals_continent():
    assert region_of("US") == "021"
    assert continent_equal_to("021") == "northern-america"
    assert continent_equal_to("030") is None
    assert continent_equal_to("005") is None
    assert members("021") == members("northern-america")


def test_members():
    assert "CN" in members("030") and "JP" in members("030")
    assert "BR" in members("005")
    assert members("030") == sorted(members("030"))
    assert set(members("europe")) >= {"CH", "DE", "GG", "RU"}
    with pytest.raises(KeyError):
        members("999")


def test_regions_partition_continents():
    data = json.loads((ROOT / "pipeline" / "m49.json").read_text("utf-8"))
    region_ids = list(data["regions"])
    seen: dict[str, str] = {}
    for region_id in region_ids:
        region_members = members(region_id)
        assert region_members, region_id
        continents = {continent_of(code) for code in region_members}
        assert continents == {data["regions"][region_id]["continent"]}, region_id  # one continent per region
        for code in region_members:
            assert code not in seen, f"{code} in {seen.get(code)} and {region_id}"  # one region per country
            seen[code] = region_id
    grouped = {code for slug in CONTINENTS for code in members(slug)}
    assert set(seen) == grouped


def test_iso_numeric():
    assert iso_numeric("CH") == "756"
    assert iso_numeric("AQ") is None  # not a WIPO entity: not mapped
    assert iso_numeric("DZ") == "012"
    assert iso_numeric("EP") is None
    assert iso_numeric("TW") is None


def test_no_group_is_antarctica_only():
    assert set(NO_GROUP) == {"AQ"}
    assert NO_GROUP["AQ"]
    assert region_of("AQ") is None and continent_of("AQ") is None


def test_every_entity_country_grouped_or_in_no_group():
    entities = json.loads((ROOT / "site" / "data" / "entities.json").read_text("utf-8"))
    countries = [item["code"] for item in entities if item["kind"] == "country"]
    assert len(countries) > 150
    for code in countries:
        assert code in NO_GROUP or (region_of(code) is not None and continent_of(code) is not None), code


def test_continent_wipo_code_by_series():
    expected = {"africa": "R1", "asia": "R2", "europe": "R3", "latin-america-caribbean": "R4",
                "northern-america": "R5", "oceania": "R6"}
    for slug, code in expected.items():
        assert continent_wipo_code(slug, "office_apps") == code
        assert continent_wipo_code(slug, "pct_origin") == code
        assert continent_wipo_code(slug, "origin_apps") is None
    with pytest.raises(KeyError):
        continent_wipo_code("atlantis", "office_apps")
    with pytest.raises(KeyError):
        continent_wipo_code("europe", "nope")


def test_m49_json_holds_mapping_only():
    data = json.loads((ROOT / "pipeline" / "m49.json").read_text("utf-8"))
    assert set(data) == {"sources", "continents", "regions", "countries"}
    assert data["sources"][0]["url"] == "https://unstats.un.org/unsd/methodology/m49/overview/"
    assert data["sources"][0]["retrieved"] == "2026-10-20"
    for code, entry in data["countries"].items():
        assert len(code) == 2 and code.isupper()
        assert set(entry) == {"numeric", "region", "continent"}, code
        assert len(entry["numeric"]) == 3 and entry["numeric"].isdigit()
    for entry in data["regions"].values():
        assert set(entry) == {"label", "continent"}
    for entry in data["continents"].values():
        assert set(entry) == {"label"}
    text = json.dumps(data)
    for word in ("Switzerland", "CHE", "LDC", "LLDC", "SIDS", "Global"):
        assert word not in text
    assert {code for code, entry in data["countries"].items() if entry["region"] is None} <= set(NO_GROUP)
    entities = json.loads((ROOT / "site" / "data" / "entities.json").read_text("utf-8"))
    assert set(data["countries"]) == build_m49.entity_countries(entities)  # entity countries only (UN terms)


# --- successors ---

def test_successors_table():
    assert set(SUCCESSORS) == HISTORICAL
    years = {former: {item["code"]: (item["from_year"], item["to_year"]) for item in items}
             for former, items in SUCCESSORS.items()}
    assert years["SU"] == {code: (1980, 1991) for code in SOVIET_SUCCESSORS}
    assert years["YU"] == {"SI": (1980, 1991), "HR": (1980, 1991), "BA": (1980, 1991), "MK": (1980, 1991),
                           "RS": (1980, 2003), "ME": (1980, 2003)}
    assert years["CS"] == {"CZ": (1980, 1992), "SK": (1980, 1992)}
    assert years["ZR"] == {"CD": (1980, 1996)}
    assert years["AN"] == {"CW": (1980, 2011), "SX": (1980, 2011), "BQ": (1980, 2011)}
    assert years["DD"] == {}


def test_successors_well_formed():
    for former, items in SUCCESSORS.items():
        for item in items:
            assert set(item) == {"code", "from_year", "to_year"}
            assert classify(item["code"]) == "country"
            assert region_of(item["code"]) is not None
            assert item["from_year"] <= item["to_year"]


def test_dd_has_no_successor_hatch_for_germany():
    assert SUCCESSORS["DD"] == []
    assert all(item["code"] != "DE" for items in SUCCESSORS.values() for item in items)


def test_successors_json_has_sources():
    data = json.loads((ROOT / "pipeline" / "successors.json").read_text("utf-8"))
    assert data["sources"]
    assert set(data) == {"sources", "successors", "notes"}


# --- build_m49.py (hand-made rows, built in memory: a table file would trip the repo guard) ---

HEADER = ["Global Code", "Global Name", "Region Code", "Region Name", "Sub-region Code", "Sub-region Name",
          "Intermediate Region Code", "Intermediate Region Name", "Country or Area", "M49 Code", "ISO-alpha2 Code",
          "ISO-alpha3 Code", "Least Developed Countries (LDC)", "Land Locked Developing Countries (LLDC)",
          "Small Island Developing States (SIDS)"]
ROWS = [
    ["001", "World", "002", "Africa", "015", "Northern Africa", "", "", "Algeria", "012", "DZ", "DZA", "", "", ""],
    ["001", "World", "002", "Africa", "202", "Sub-Saharan Africa", "011", "Western Africa", "Nigeria", "566", "NG",
     "NGA", "", "", ""],
    ["001", "World", "002", "Africa", "202", "Sub-Saharan Africa", "014", "Eastern Africa", "Kenya", "404", "KE",
     "KEN", "", "", ""],
    ["001", "World", "019", "Americas", "021", "Northern America", "", "", "Canada", "124", "CA", "CAN", "", "", ""],
    ["001", "World", "019", "Americas", "419", "Latin America and the Caribbean", "005", "South America", "Brazil",
     "076", "BR", "BRA", "", "", ""],
    ["001", "World", "142", "Asia", "030", "Eastern Asia", "", "", "China", "156", "CN", "CHN", "", "", ""],
    ["001", "World", "150", "Europe", "154", "Northern Europe", "830", "Channel Islands", "Guernsey", "831", "GG",
     "GGY", "", "", ""],
    ["001", "World", "150", "Europe", "155", "Western Europe", "", "", "Switzerland", "756", "CH", "CHE", "", "x",
     ""],
    ["001", "World", "150", "Europe", "154", "Northern Europe", "", "", "Sark", "680", "", "", "", "", ""],
    ["001", "World", "009", "Oceania", "053", "Australia and New Zealand", "", "", "Australia", "036", "AU", "AUS",
     "", "", ""],
    ["001", "World", "", "", "", "", "", "", "Antarctica", "010", "AQ", "ATA", "", "", ""],
]


WANTED = {"DZ", "NG", "KE", "CA", "BR", "CN", "GG", "CH", "AU", "AQ"}


def table_html(header=HEADER, rows=ROWS) -> str:
    def cells(row):
        return "".join(f"<td>{cell}</td>" for cell in row)
    body = "".join(f"<tr>{cells(row)}<!--<td>x</td>--></tr>" for row in rows)
    other = f'<table id="downloadTableFR"><tr>{cells(header)}</tr><tr>{cells(rows[0])}</tr></table>'
    return (f'<html><body>{other}<table id = "downloadTableEN" class="compact"><thead><tr>{cells(header)}</tr>'
            f"</thead><tbody>{body}</tbody></table></body></html>")


def test_build_parses_english_table_only():
    rows = build_m49.parse_table(table_html())
    assert len(rows) == len(ROWS)
    assert rows[0]["ISO-alpha2 Code"] == "DZ"


def test_build_parses_first_english_table_only():
    html = table_html()
    second = '<table id="downloadTableEN"><tr><td>x</td></tr></table></body>'
    rows = build_m49.parse_table(html.replace("</body>", second))
    assert len(rows) == len(ROWS)


def test_build_mapping_rules():
    mapping = build_m49.build_mapping(build_m49.parse_table(table_html()), "2026-10-20", WANTED)
    countries = mapping["countries"]
    assert countries["NG"] == {"numeric": "566", "region": "011", "continent": "africa"}
    assert countries["KE"]["region"] == "014"
    assert countries["DZ"]["region"] == "015"
    assert countries["CA"] == {"numeric": "124", "region": "021", "continent": "northern-america"}
    assert countries["BR"] == {"numeric": "076", "region": "005", "continent": "latin-america-caribbean"}
    assert countries["GG"]["region"] == "154"  # intermediate 830 ignored outside 419/202
    assert countries["AQ"] == {"numeric": "010", "region": None, "continent": None}
    assert "" not in countries  # Sark: no ISO code, skipped
    assert mapping["regions"]["011"] == {"label": "Western Africa", "continent": "africa"}
    assert "830" not in mapping["regions"] and "202" not in mapping["regions"]
    assert mapping["continents"]["latin-america-caribbean"] == {"label": "Latin America and the Caribbean"}
    assert mapping["continents"]["northern-america"] == {"label": "Northern America"}
    assert mapping["sources"][0]["retrieved"] == "2026-10-20"


def test_build_keeps_wanted_codes_and_their_regions_only():
    mapping = build_m49.build_mapping(build_m49.parse_table(table_html()), "2026-10-20", {"CN", "BR"})
    assert set(mapping["countries"]) == {"CN", "BR"}
    assert set(mapping["regions"]) == {"030", "005"}
    assert set(mapping["continents"]) == {"africa", "northern-america", "latin-america-caribbean", "asia", "europe",
                                          "oceania"}  # labels from the whole table


def test_build_fails_on_entity_country_not_in_m49():
    with pytest.raises(ValueError, match="TW"):
        build_m49.build_mapping(build_m49.parse_table(table_html()), "2026-10-20", {"CN", "TW"})


def test_build_fails_on_missing_intermediate_region():
    rows = [row[:] for row in ROWS]
    rows[4][6] = ""  # Brazil without intermediate region
    with pytest.raises(ValueError, match="BR"):
        build_m49.build_mapping(build_m49.parse_table(table_html(rows=rows)), "2026-10-20", WANTED)


def test_build_fails_on_unknown_region():
    rows = [row[:] for row in ROWS]
    rows[5][2] = "999"
    with pytest.raises(ValueError, match="CN"):
        build_m49.build_mapping(build_m49.parse_table(table_html(rows=rows)), "2026-10-20", WANTED)


def test_build_fails_without_english_table():
    with pytest.raises(ValueError):
        build_m49.parse_table("<html><table id='downloadTableFR'></table></html>")


def test_committed_mapping_matches_module():
    data = json.loads((ROOT / "pipeline" / "m49.json").read_text("utf-8"))
    assert {code for code, entry in data["countries"].items() if entry["region"]} == {
        code for slug in CONTINENTS for code in m49.members(slug)}
