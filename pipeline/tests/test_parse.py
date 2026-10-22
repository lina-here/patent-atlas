import copy
import json
from pathlib import Path

import pytest

from pipeline import parse
from pipeline.parse import (Cell, Entity, SchemaError, check_seq_order, parse_class_list, parse_decimal,
                            parse_entity_list, parse_share, parse_table, parse_value)

FIXTURES = Path(__file__).parent / "fixtures"
TYPE_LABELS = {"Total": "910", "Resident": "911", "Abroad": "912"}
CODES = {"CH", "US", "CI"}
TYPES = {"910", "911", "912"}


def load(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def entity_list():
    return load("entities_origin_small.json")


@pytest.fixture
def table():
    return load("table_origin_small.json")


@pytest.fixture
def entities(entity_list):
    return parse_entity_list(entity_list, "origin", min_entities=3)[0]


def run(table, entities, codes=CODES, types=TYPES):
    return parse_table(table, entities, TYPE_LABELS, codes, types)


def test_parse_value():
    assert parse_value("") is None
    assert parse_value("-") is None
    assert parse_value(None) is None
    assert parse_value("1,234") == 1234
    assert parse_value("1234.0") == 1234
    assert parse_value("0") == 0
    assert parse_value("272,481") == 272481
    for bad in ["12.5", "abc", "1,23", "-5", "1,1,1,2,209,3,929", "00", "1.2.3", "n/a"]:
        with pytest.raises(SchemaError):
            parse_value(bad)
    assert parse_value(1234) == 1234  # JSON int accepted
    for bad in [12.5, 1234.0, True, -1]:
        with pytest.raises(SchemaError):
            parse_value(bad)  # type: ignore[arg-type]


def test_parse_decimal():
    assert parse_decimal("1505.6") == 1505.6
    assert parse_decimal("1,235.0") == 1235.0
    assert parse_decimal("0.1") == 0.1
    assert parse_decimal("7") == 7.0 and isinstance(parse_decimal("7"), float)
    assert parse_decimal(7) == 7.0 and isinstance(parse_decimal(7), float)  # JSON int accepted
    for empty in ("", "-", " ", None):
        assert parse_decimal(empty) is None
    for bad in ["1,1,1,2", "-3.2", "1.2.3", "1,23.5", ".5", "1.", "01.5", "n/a", "..", True, -1, 2.5]:
        with pytest.raises(SchemaError):
            parse_decimal(bad)  # type: ignore[arg-type]


def test_parse_decimal_at_most_one_decimal_place():
    # WIPO publishes one decimal; "1.505" is a dot-grouped 1505 in a de-locale formatter, not 1.505
    for bad in ["1.505", "0.25", "1,505.25", "1505.60", "3.14159"]:
        with pytest.raises(SchemaError):
            parse_decimal(bad)
    assert parse_decimal("1505.6") == 1505.6 and parse_decimal("1,505.6") == 1505.6


def test_parse_value_still_integer_only():
    with pytest.raises(SchemaError):
        parse_value("1505.6")  # counts stay integer; decimals only through parse_decimal


def test_parse_entity_list_ips_origin(entity_list):
    entities, type_labels = parse_entity_list(entity_list, "origin", min_entities=3)
    assert entities == [
        Entity("CH", "Switzerland"),
        Entity("CI", "Côte d'Ivoire"),
        Entity("US", "United States of America"),
    ]
    assert type_labels == TYPE_LABELS  # leading space of " Total" stripped


def test_parse_entity_list_ips_office_shape():
    raw = {"ipsOriginList": None, "ipsOffList": {"CH": "Switzerland", "EP": "European Patent Office"},
           "ipsTechList": {"900": " Total", "902": "Non-resident", "901": "Resident"}}
    entities, type_labels = parse_entity_list(raw, "office", min_entities=2)
    assert [e.code for e in entities] == ["CH", "EP"]
    assert type_labels == {"Total": "900", "Non-resident": "902", "Resident": "901"}
    with pytest.raises(SchemaError):  # rpType 11 list has no origin list
        parse_entity_list(raw, "origin", min_entities=1)


def test_parse_entity_list_pmh_shape():
    raw = {"pmhOriginList": {"ZZ": "Total", "CH": "Switzerland"}, "pmhOffList": {"ZZ": "Total", "OA": "OAPI"},
           "pmhOriginListSeq": {"ZZ": 1, "CH": 179}}
    entities, type_labels = parse_entity_list(raw, "origin", min_entities=2)
    assert entities == [Entity("CH", "Switzerland"), Entity("ZZ", "Total")]
    assert type_labels == {}
    offices, _ = parse_entity_list(raw, "office", tab="pmh", min_entities=2)
    assert offices == [Entity("OA", "OAPI"), Entity("ZZ", "Total")]
    with pytest.raises(SchemaError):  # forced tab does not match the shape
        parse_entity_list(raw, "origin", tab="ips", min_entities=1)


def test_parse_table_small(table, entities):
    cells = run(table, entities)
    assert len(cells) == 27
    got = {(c.code, c.type_id, c.year): c.value for c in cells}
    expected = {
        ("CH", "910", 2022): 40000, ("CH", "910", 2023): 41500, ("CH", "910", 2024): 42000,
        ("CH", "911", 2022): 10000, ("CH", "911", 2023): 10500, ("CH", "911", 2024): 11000,
        ("CH", "912", 2022): 30000, ("CH", "912", 2023): 31000, ("CH", "912", 2024): 31000,
        ("US", "910", 2022): 600000, ("US", "910", 2023): 610000, ("US", "910", 2024): 620000,
        ("US", "911", 2022): 300000, ("US", "911", 2023): 305000, ("US", "911", 2024): 310000,
        ("US", "912", 2022): 300000, ("US", "912", 2023): 305000, ("US", "912", 2024): 310000,
        ("CI", "910", 2022): None, ("CI", "910", 2023): None, ("CI", "910", 2024): 12,
        ("CI", "911", 2022): None, ("CI", "911", 2023): None, ("CI", "911", 2024): 5,
        ("CI", "912", 2022): None, ("CI", "912", 2023): None, ("CI", "912", 2024): 7,
    }
    assert got == expected
    assert all(isinstance(c, Cell) for c in cells)


def test_parse_table_html_escaped_label_matches(table, entities):
    # fixture serves "C&ocirc;te d&#39;Ivoire"; list has "Côte d'Ivoire"
    assert any(c.code == "CI" for c in run(table, entities))


def test_parse_table_ignores_unrequested_known_rows(table, entities):
    cells = run(table, entities, codes={"CH"}, types={"910"})
    assert [(c.code, c.type_id, c.year) for c in cells] == [("CH", "910", y) for y in (2022, 2023, 2024)]


def test_schema_missing_columns(table, entities):
    del table["columns"]
    with pytest.raises(SchemaError):
        run(table, entities)


def test_schema_all_null_response(entities):
    # HTTP 200 with every key null (wrong param names)
    with pytest.raises(SchemaError):
        run({"recordInfo": None, "columns": None, "records": None}, entities)


def test_schema_missing_record_info(table, entities):
    table["recordInfo"] = None
    with pytest.raises(SchemaError):
        run(table, entities)


def test_schema_empty_records(table, entities):
    table["records"] = []
    with pytest.raises(SchemaError):
        run(table, entities)


def test_schema_not_an_object(entities):
    with pytest.raises(SchemaError):
        run("<html>error</html>", entities)  # type: ignore[arg-type]


def test_schema_unknown_label(table, entities):
    table["records"][0]["selectedOrigin"] = "Atlantis"
    with pytest.raises(SchemaError, match="Atlantis"):
        run(table, entities)


def test_schema_unknown_type_label(table, entities):
    table["records"][0]["selectedTechnology"] = "Mystery"
    with pytest.raises(SchemaError, match="Mystery"):
        run(table, entities)


def test_schema_duplicate_labels(entity_list):
    entity_list["ipsOriginList"]["XX"] = "Switzerland"
    with pytest.raises(SchemaError, match="duplicate"):
        parse_entity_list(entity_list, "origin", min_entities=3)
    # equal after unescape + strip
    entity_list["ipsOriginList"]["XX"] = " Switzerland&#32;"
    with pytest.raises(SchemaError, match="duplicate"):
        parse_entity_list(entity_list, "origin", min_entities=3)


def test_schema_duplicate_labels_in_entities_argument(table):
    twins = [Entity("CH", "Switzerland"), Entity("XX", "Switzerland")]
    with pytest.raises(SchemaError, match="duplicate"):
        run(table, twins)


def test_schema_duplicate_row(table, entities):
    table["records"].append(copy.deepcopy(table["records"][0]))
    with pytest.raises(SchemaError, match="duplicate row"):
        run(table, entities)


def test_schema_missing_entity(table, entities):
    table["records"] = [r for r in table["records"] if r["selectedOrigin"] != "Switzerland"]
    with pytest.raises(SchemaError, match="missing"):
        run(table, entities)


def test_schema_missing_type_for_entity(table, entities):
    table["records"] = [r for r in table["records"]
                        if not (r["selectedOrigin"] == "Switzerland" and r["selectedTechnology"] == "Abroad")]
    with pytest.raises(SchemaError, match="missing"):
        run(table, entities)


def test_schema_too_few_entities(entity_list):
    assert parse.MIN_ENTITIES == 150
    with pytest.raises(SchemaError, match="at least"):
        parse_entity_list(entity_list, "origin")  # 3 entities < default MIN_ENTITIES
    with pytest.raises(SchemaError, match="at least"):
        parse_entity_list(entity_list, "origin", min_entities=4)


def test_min_entities_patchable(entity_list, monkeypatch):
    monkeypatch.setattr(parse, "MIN_ENTITIES", 3)
    assert len(parse_entity_list(entity_list, "origin")[0]) == 3


def test_schema_entity_list_null_or_empty(entity_list):
    entity_list["ipsOriginList"] = None
    with pytest.raises(SchemaError):
        parse_entity_list(entity_list, "origin", min_entities=0)
    entity_list["ipsOriginList"] = {}
    with pytest.raises(SchemaError):
        parse_entity_list(entity_list, "origin", min_entities=0)


def test_schema_no_type_list_for_ips(entity_list):
    entity_list["ipsTechList"] = None
    with pytest.raises(SchemaError):
        parse_entity_list(entity_list, "origin", min_entities=3)


def test_entity_list_without_types_for_ratio_lists():
    # ratio lists (ips 100/101) send ipsTechList null (research 2026-10-20 §2)
    raw = load("ratio_entities_small.json")
    assert raw["ipsTechList"] is None
    entities, type_labels = parse_entity_list(raw, "origin", "ips", min_entities=10, types=False)
    assert [e.code for e in entities] == ["CH", "CI", "DE", "JP", "LU", "MG", "SU", "US", "VA", "WD"]
    assert type_labels == {}
    with pytest.raises(SchemaError, match="ipsTechList"):
        parse_entity_list(raw, "origin", "ips", min_entities=10, types=True)


def test_year_columns_numeric(table, entities):
    for bad in ["20x4", "2024/1", "24", "total"]:
        broken = copy.deepcopy(table)
        broken["columns"][-1]["code"] = bad
        with pytest.raises(SchemaError, match="year"):
            run(broken, entities)
    no_years = copy.deepcopy(table)
    no_years["columns"] = no_years["columns"][:2]
    with pytest.raises(SchemaError, match="year"):
        run(no_years, entities)


def test_schema_record_missing_year_key(table, entities):
    del table["records"][0]["2023"]
    with pytest.raises(SchemaError, match="2023"):
        run(table, entities)


def test_schema_bad_cell_value_names_cell(table, entities):
    table["records"][0]["2024"] = "1,1,1,2,209"
    with pytest.raises(SchemaError, match="CH/910/2024"):
        run(table, entities)


def test_ignores_fixture_marker_and_seq_order(table, entities):
    assert table["_fixture"] == "hand-made"
    assert "selectedOrigin_SeqOrder" in table["records"][0]
    assert len(run(table, entities)) == 27


# pmh: origin + receiving office columns, no type column

PMH_ENTITIES = [Entity("CH", "Switzerland"), Entity("US", "United States of America"), Entity("ZZ", "Total")]


def pmh_table():
    def row(origin, office, a, b):
        return {"selectedOffice": office, "selectedOrigin": origin, "2023": a, "2024": b,
                "2023_SeqOrder": 1.0, "selectedOrigin_SeqOrder": 1}
    return {
        "recordInfo": {"propertyRight": "PCT"},
        "columns": [{"code": c, "value": c, "type": "text"} for c in ("selectedOffice", "selectedOrigin")]
        + [{"code": y, "value": y, "type": "number"} for y in ("2023", "2024")],
        "records": [row("Switzerland", "Total", "5,000", "5,100"),
                    row("United States of America", "Total", "55,000", None),
                    row("Total", "Total", "270,000", "271,000")],
    }


def test_parse_table_pmh_maps_origin():
    cells = parse_table(pmh_table(), PMH_ENTITIES, {}, {"CH", "US", "ZZ"}, {parse.NO_TYPE})
    got = {(c.code, c.type_id, c.year): c.value for c in cells}
    assert len(cells) == 6
    assert got[("CH", parse.NO_TYPE, 2023)] == 5000
    assert got[("US", parse.NO_TYPE, 2024)] is None
    assert got[("ZZ", parse.NO_TYPE, 2023)] == 270000


def test_schema_pmh_non_total_office():
    broken = pmh_table()
    broken["records"][0]["selectedOffice"] = "Switzerland"
    with pytest.raises(SchemaError, match="receiving office"):
        parse_table(broken, PMH_ENTITIES, {}, {"CH", "US", "ZZ"}, {parse.NO_TYPE})


def test_schema_pmh_garbled_values():
    # missing RO filter: WIPO concatenates RO rows into one string
    broken = pmh_table()
    broken["records"][0]["2024"] = "1,1,1,1,1,1,2,209,219,3,3,3,3,3,3,929,4,5,5,345,57,899"
    with pytest.raises(SchemaError, match="CH"):
        parse_table(broken, PMH_ENTITIES, {}, {"CH", "US", "ZZ"}, {parse.NO_TYPE})


def test_schema_no_type_column_but_types_requested():
    with pytest.raises(SchemaError, match="missing"):
        parse_table(pmh_table(), PMH_ENTITIES, TYPE_LABELS, {"CH"}, {"910"})


def test_requested_years(table, entities):
    assert len(parse_table(table, entities, TYPE_LABELS, CODES, TYPES, requested_years={2022, 2023, 2024})) == 27
    with pytest.raises(SchemaError, match="year columns"):  # missing year
        parse_table(table, entities, TYPE_LABELS, CODES, TYPES, requested_years={2021, 2022, 2023, 2024})
    with pytest.raises(SchemaError, match="year columns"):  # extra year in table
        parse_table(table, entities, TYPE_LABELS, CODES, TYPES, requested_years={2022, 2023})


def test_kind_must_match_entity_column(table, entities):
    assert len(parse_table(table, entities, TYPE_LABELS, CODES, TYPES, kind="origin")) == 27
    with pytest.raises(SchemaError, match="office"):  # origin table parsed as office
        parse_table(table, entities, TYPE_LABELS, CODES, TYPES, kind="office")
    office_table = copy.deepcopy(table)
    office_table["columns"][0]["code"] = "selectedOffice"
    for record in office_table["records"]:
        record["selectedOffice"] = record.pop("selectedOrigin")
    with pytest.raises(SchemaError, match="origin"):  # office table parsed as origin
        parse_table(office_table, entities, TYPE_LABELS, CODES, TYPES, kind="origin")
    assert len(parse_table(office_table, entities, TYPE_LABELS, CODES, TYPES, kind="office")) == 27
    with pytest.raises(SchemaError, match="kind"):
        parse_table(table, entities, TYPE_LABELS, CODES, TYPES, kind="bogus")  # type: ignore[arg-type]


def test_pmh_kind_origin_ok_office_rejected():
    args = (PMH_ENTITIES, {}, {"CH", "US", "ZZ"}, {parse.NO_TYPE})
    assert len(parse_table(pmh_table(), *args, kind="origin")) == 6
    with pytest.raises(SchemaError):
        parse_table(pmh_table(), *args, kind="office")


def test_empty_requested_sets_rejected(table, entities):
    with pytest.raises(SchemaError, match="empty"):
        parse_table(table, entities, TYPE_LABELS, set(), TYPES)
    with pytest.raises(SchemaError, match="empty"):
        parse_table(table, entities, TYPE_LABELS, CODES, set())


def test_table_cell_types(table, entities):
    table["records"][0]["2024"] = 42000  # JSON int accepted
    cells = run(table, entities)
    assert next(c for c in cells if (c.code, c.type_id, c.year) == ("CH", "910", 2024)).value == 42000
    for bad in [42000.5, 42000.0, True, ["1"]]:
        broken = copy.deepcopy(table)
        broken["records"][0]["2024"] = bad
        with pytest.raises(SchemaError, match="CH/910/2024"):
            run(broken, entities)


# WIPO omits a (code, type) row that is all null over the requested years (live 2026-10-19)

def test_absent_rows_null_when_allowed(table, entities):
    us_abroad = ("United States of America", "Abroad")
    table["records"] = [r for r in table["records"]
                        if r["selectedOrigin"] != "Switzerland"
                        and (r["selectedOrigin"], r["selectedTechnology"]) != us_abroad]
    cells = parse_table(table, entities, TYPE_LABELS, CODES, TYPES, allow_absent_rows=True)
    got = {(c.code, c.type_id, c.year): c.value for c in cells}
    assert len(cells) == 27
    assert all(got[("CH", t, y)] is None for t in TYPES for y in (2022, 2023, 2024))
    assert all(got[("US", "912", y)] is None for y in (2022, 2023, 2024))
    assert got[("US", "910", 2024)] == 620000


def test_absent_rows_still_reject_type_in_no_row(table, entities):
    table["records"] = [r for r in table["records"] if r["selectedTechnology"] != "Abroad"]
    with pytest.raises(SchemaError, match="type"):
        parse_table(table, entities, TYPE_LABELS, CODES, TYPES, allow_absent_rows=True)


def test_absent_rows_still_reject_no_requested_code_present(table, entities):
    with pytest.raises(SchemaError, match="no requested code"):
        parse_table(table, entities + [Entity("VA", "Holy See")], TYPE_LABELS, {"VA"}, TYPES,
                    allow_absent_rows=True)


def test_absent_rows_pmh_wrong_types_still_raise():
    with pytest.raises(SchemaError, match="type"):
        parse_table(pmh_table(), PMH_ENTITIES, TYPE_LABELS, {"CH"}, {"910"}, allow_absent_rows=True)


def test_validated_columns_public(table):
    columns, records = parse.validated_columns(table)
    assert [c["code"] for c in columns][:2] == ["selectedOrigin", "selectedTechnology"]
    assert len(records) == 9
    with pytest.raises(SchemaError, match="records"):
        parse.validated_columns({**table, "records": None})


# ratio tables (ips 100/101): no type column, decimal strings

def test_parse_table_decimals_ratio_table():
    raw = load("ratio_per_million_small.json")
    entities, _ = parse_entity_list(load("ratio_entities_small.json"), "origin", "ips", min_entities=10, types=False)
    codes = {e.code for e in entities}
    cells = parse_table(raw, entities, {}, codes, {parse.NO_TYPE}, requested_years=set(range(1990, 2025)),
                        kind="origin", allow_absent_rows=True, decimals=True)
    got = {(c.code, c.year): c.value for c in cells}
    assert {c.type_id for c in cells} == {parse.NO_TYPE}
    assert len(cells) == 10 * 35
    assert got[("CH", 2024)] == 1235.0 and isinstance(got[("CH", 2024)], float)
    assert got[("CI", 2024)] is None  # ""
    assert got[("MG", 2024)] == 0.1
    assert got[("MG", 2023)] is None  # "-"
    assert got[("LU", 2024)] is None  # row absent


def test_ratio_fixtures_keep_live_shape():
    # live 2026-10-21: integer-valued ratios arrive as "1235" (no ".0");
    # records carry *_SeqOrder floats the parser must ignore
    for name in ("ratio_per_million_small.json", "ratio_per_gdp_small.json"):
        records = load(name)["records"]
        assert all("selectedOrigin_SeqOrder" in record for record in records)
        assert any(key.endswith("_SeqOrder") and key[:4].isdigit() for record in records for key in record)
        assert any(isinstance(v, str) and v.isdigit() for record in records for v in record.values())
        assert not any(isinstance(v, str) and v.endswith(".0") for record in records for v in record.values())


def test_parse_table_counts_reject_decimals():
    raw = load("ratio_per_million_small.json")
    entities, _ = parse_entity_list(load("ratio_entities_small.json"), "origin", "ips", min_entities=10, types=False)
    with pytest.raises(SchemaError, match="CH/none/1990"):
        parse_table(raw, entities, {}, {"CH"}, {parse.NO_TYPE}, allow_absent_rows=True)


# women inventors (pmh 1040-1042) and publications (1010): research 2026-10-21-wipo-women-inventors.md

def test_parse_share():
    assert parse_share("33.0") == 33.0 and isinstance(parse_share("33.0"), float)
    assert parse_share("0.0") == 0.0 and parse_share("100.0") == 100.0 and parse_share("7") == 7.0
    for empty in ("", "-", None):
        assert parse_share(empty) is None
    for bad in ["100.1", "1,100", "1.05", "-1.0", "101", "033.0", "1,000.0", True, 2.5]:
        with pytest.raises(SchemaError):
            parse_share(bad)  # type: ignore[arg-type]


def test_parse_class_list():
    raw = {"pmhClassList": {"10": "Measurement", "2": "Audio-visual technology",
                            "1": "Electrical machinery, apparatus, energy"},
           "pmhClassLabel": "Field of technology", "pmhOriginList": None}
    assert parse_class_list(raw) == [Entity("1", "Electrical machinery, apparatus, energy"),
                                     Entity("2", "Audio-visual technology"), Entity("10", "Measurement")]  # numeric
    assert parse_class_list({"pmhClassList": {"109": "Total", "112": "English"}})[0] == Entity("109", "Total")
    assert parse_class_list({"pmhClassList": {"1": "Furniture, games &amp; toys"}}) == [
        Entity("1", "Furniture, games & toys")]
    for bad in ({"pmhClassList": None}, {"pmhClassList": {}}, {}, {"pmhClassList": {"1": "A", "2": "A"}}, []):
        with pytest.raises(SchemaError):
            parse_class_list(bad)  # type: ignore[arg-type]


FIELDS = [Entity("1", "Electrical machinery, apparatus, energy"), Entity("6", "Computer technology")]


def field_table():
    years = ["2024", "2025"]
    return {"recordInfo": {"indicator": "14 - ..."},
            "columns": [{"code": "selectedClass"}] + [{"code": y} for y in years],
            "records": [{"selectedClass": "Computer technology", "2024": "38.3", "2025": "39.6"},
                        {"selectedClass": "Electrical machinery, apparatus, energy", "2024": "31.1", "2025": None}]}


def test_parse_table_selected_class_entity():
    cells = parse_table(field_table(), FIELDS, {}, {"1", "6"}, {parse.NO_TYPE}, kind="field", shares=True)
    got = {(c.code, c.year): c.value for c in cells}
    assert got == {("6", 2024): 38.3, ("6", 2025): 39.6, ("1", 2024): 31.1, ("1", 2025): None}
    assert {c.type_id for c in cells} == {parse.NO_TYPE}


def test_parse_table_field_kind_needs_class_only():
    raw = field_table()
    raw["columns"].insert(0, {"code": "selectedOrigin"})
    for record in raw["records"]:
        record["selectedOrigin"] = "Total"
    with pytest.raises(SchemaError, match="kind 'field'"):
        parse_table(raw, FIELDS, {}, {"1", "6"}, {parse.NO_TYPE}, kind="field")
    with pytest.raises(SchemaError, match="no selectedOrigin or selectedOffice"):  # field table needs kind="field"
        parse_table(field_table(), FIELDS, {}, {"1", "6"}, {parse.NO_TYPE})


def test_parse_table_selected_class_as_type_column():
    # 1010 shape: origin rows x publication language (selectedClass), class "Total" requested
    raw = {"recordInfo": {}, "columns": [{"code": "selectedOrigin"}, {"code": "selectedClass"}, {"code": "2025"}],
           "records": [{"selectedOrigin": "Switzerland", "selectedClass": "Total", "2025": "5,350"},
                       {"selectedOrigin": "Switzerland", "selectedClass": "English", "2025": "4,100"}]}
    cells = parse_table(raw, [Entity("CH", "Switzerland")], {"Total": "109", "English": "112"}, {"CH"}, {"109"},
                        kind="origin")
    assert cells == [Cell("CH", "109", 2025, 5350)]


def test_parse_table_shares_guard():
    raw = field_table()
    raw["records"][0]["2024"] = "100.1"
    with pytest.raises(SchemaError, match="6/none/2024"):
        parse_table(raw, FIELDS, {}, {"1", "6"}, {parse.NO_TYPE}, kind="field", shares=True)


def test_check_seq_order():
    ok = {"recordInfo": {}, "columns": [{"code": "2024"}], "records": [
        {"2024": "33.0", "2024_SeqOrder": 33.0, "2025": None, "2025_SeqOrder": None},
        {"2024": "1.0"}]}  # no _SeqOrder keys: nothing to compare
    check_seq_order(ok, "t")
    for record in ({"2024": "33.0", "2024_SeqOrder": None}, {"2024": None, "2024_SeqOrder": 66.0}):
        with pytest.raises(SchemaError, match="t: record 0 _SeqOrder"):
            check_seq_order({"recordInfo": {}, "columns": [{"code": "2024"}], "records": [record]}, "t")


@pytest.mark.parametrize("shares, value, order, ok", [
    (True, "33.0", 33.0, True), (True, "33.5", 33.0, True), (True, "33.5", 34.0, True), (True, "33.0", 66.0, False),
    (True, "33.0", 34.0, False), (False, "5,350", 5350.0, True), (False, "5,350", 5351.0, False),
    (False, "5,423,100", 10846.0, False), (False, "5350", 5350, True)])
def test_check_seq_order_magnitude(shares, value, order, ok):
    raw = {"recordInfo": {}, "columns": [{"code": "2024"}], "records": [{"2024": value, "2024_SeqOrder": order}]}
    if ok:
        check_seq_order(raw, "t", shares=shares)
    else:
        with pytest.raises(SchemaError, match="t: record 0 2024 _SeqOrder"):
            check_seq_order(raw, "t", shares=shares)


def test_check_seq_order_unparseable_value_left_to_parse_table():
    raw = {"recordInfo": {}, "columns": [{"code": "2024"}], "records": [{"2024": "1,100", "2024_SeqOrder": 1.0}]}
    check_seq_order(raw, "t", shares=True)  # parse_table raises with the cell's name
