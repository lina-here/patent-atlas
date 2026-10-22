import pytest

from pipeline import entities
from pipeline.entities import ISO2_TO_ISO3, classify, iso3
from pipeline.parse import parse_entity_list
from pipeline.wipo_client import WipoClient


def test_classify():
    assert classify("CH") == "country"
    assert classify("EP") == "regional_office"
    assert classify("EU") == "aggregate"
    assert classify("SU") == "historical"


def test_classify_wipo_groupings_are_aggregates():
    for code in ("R1", "R7", "WD", "ZZ", "**"):
        assert classify(code) == "aggregate"


def test_iso3():
    assert iso3("CH") == "CHE"
    assert iso3("MG") == "MDG"
    assert iso3("US") == "USA"
    assert iso3("EP") is None
    assert iso3("SU") is None


def test_sets_are_disjoint_and_not_iso_countries():
    groups = [entities.REGIONAL_OFFICES, entities.AGGREGATES, entities.HISTORICAL]
    for i, a in enumerate(groups):
        for b in groups[i + 1:]:
            assert not (a & b)
        assert not (a & set(ISO2_TO_ISO3))


def test_iso3_table_is_well_formed():
    assert all(len(k) == 2 and k.isupper() for k in ISO2_TO_ISO3)
    assert all(len(v) == 3 and v.isupper() for v in ISO2_TO_ISO3.values())
    assert len(set(ISO2_TO_ISO3.values())) == len(ISO2_TO_ISO3)


@pytest.mark.live
def test_all_live_codes_classified():
    client = WipoClient()
    lists = [
        (client.get_json("ips-search/loadOffOrgTechList", {"indicator": "10", "rpType": "13"}), "origin"),
        (client.get_json("ips-search/loadOffOrgTechList", {"indicator": "10", "rpType": "11"}), "office"),
        (client.get_json("pmh-search/loadOffOrgClassList", {"indicator": "1001"}), "origin"),
    ]
    seen = set()
    for raw, kind in lists:  # country iff in ISO2_TO_ISO3 (classify), so no iso3 assert: it could never fail
        for entity in parse_entity_list(raw, kind)[0]:
            seen.add(entity.code)
            classify(entity.code)  # must not raise
    assert {"CH", "EP", "EU"} <= seen


def test_classify_unknown_code_raises():
    with pytest.raises(ValueError):
        classify("XX")


def test_iso3_table_is_complete_iso_3166_1():
    assert len(ISO2_TO_ISO3) == 249
    for code, expected in {"TW": "TWN", "AQ": "ATA", "AX": "ALA", "BL": "BLM", "GS": "SGS", "UM": "UMI",
                           "PS": "PSE", "SJ": "SJM", "TF": "ATF", "XK": None}.items():
        assert ISO2_TO_ISO3.get(code) == expected
    assert classify("AQ") == "country"  # ISO code not seen live is still a country
