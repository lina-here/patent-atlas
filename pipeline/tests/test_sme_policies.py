"""SMEs page data (site/sme/policies.json, hand-curated from primary sources): shape and source rules the page relies on.
Values are never fixed here: the test checks form, ranges, hosts and sums only."""
import json
import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse

import pytest

POLICIES = Path(__file__).resolve().parents[2] / "site" / "sme" / "policies.json"

OFFICE_ORDER = ["US", "EP", "JP", "KR", "CN"]
# primary sources only: each office's own domain; share and resource pages from WIPO, the EPO or the EU
OFFICE_HOSTS = {"US": "uspto.gov", "EP": "epo.org", "JP": "jpo.go.jp", "KR": "kipo.go.kr", "CN": "cnipa.gov.cn"}
SHARE_HOSTS = ["wipo.int", "epo.org", "euipo.europa.eu", "europa.eu"]
LANGS = {"ko", "zh"}


@pytest.fixture(scope="module")
def data():
    with POLICIES.open(encoding="utf-8") as handle:
        return json.load(handle)


def on_host(url, hosts):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return parsed.scheme == "https" and any(host == allowed or host.endswith(f".{allowed}") for allowed in hosts)


def text(value):
    return isinstance(value, str) and value.strip() != ""


def test_checked_on_is_a_date(data):
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["checked_on"])
    date.fromisoformat(data["checked_on"])


def test_offices_are_the_ip5_in_order(data):
    assert [office["code"] for office in data["offices"]] == OFFICE_ORDER
    for office in data["offices"]:
        assert text(office["name"]) and text(office["short"])
        for key in ("definitions", "fee_reductions", "support"):
            assert isinstance(office[key], list)


def test_office_entries_link_to_the_office_itself(data):
    for office in data["offices"]:
        host = [OFFICE_HOSTS[office["code"]]]
        for entry in office["definitions"] + office["fee_reductions"]:
            assert on_host(entry["source_url"], host), (office["code"], entry["source_url"])
        for entry in office["support"]:
            assert on_host(entry["url"], host), (office["code"], entry["url"])


def test_definitions_and_support_have_text(data):
    for office in data["offices"]:
        for entry in office["definitions"]:
            assert text(entry["category"]) and text(entry["text"])
        for entry in office["support"]:
            assert text(entry["name"]) and text(entry["text"])


def test_fee_reductions(data):
    for office in data["offices"]:
        for fee in office["fee_reductions"]:
            assert text(fee["category"]) and text(fee["as_published"]) and text(fee["fees"])
            pct = fee["reduction_pct"]
            assert pct is None or (isinstance(pct, (int, float)) and not isinstance(pct, bool) and 0 <= pct <= 100), fee
            assert fee.get("since") is None or date.fromisoformat(fee["since"])
            assert fee.get("as_published_lang", "ko") in LANGS


def decimals(value):
    exponent = Decimal(str(value)).as_tuple().exponent
    return max(0, -exponent)


def test_shares(data):
    assert data["shares"], "no share figures"
    ids = [share["id"] for share in data["shares"]]
    assert len(ids) == len(set(ids))
    for share in data["shares"]:
        assert isinstance(share["year"], int)
        assert text(share["scope"]) and text(share["citation"]) and text(share["page"])
        assert share.get("note") is None or text(share["note"])
        assert on_host(share["url"], SHARE_HOSTS), share["url"]
        rows = share["rows"]
        assert rows and all(text(row["label"]) for row in rows)
        assert all(isinstance(row["pct"], (int, float)) and 0 <= row["pct"] <= 100 for row in rows)
        # published rounding: each row may be off by half its last digit
        places = max(decimals(row["pct"]) for row in rows)
        tolerance = len(rows) * Decimal(5) / Decimal(10) ** (places + 1)
        total = sum(Decimal(str(row["pct"])) for row in rows)
        assert abs(total - 100) <= tolerance, (share["id"], total, tolerance)


def test_resources(data):
    assert data["resources"]
    for resource in data["resources"]:
        assert text(resource["title"]) and text(resource["publisher"]) and text(resource["text"])
        assert on_host(resource["url"], SHARE_HOSTS), resource["url"]


def test_on_host_rejects_lookalikes():
    assert on_host("https://www.epo.org/x", ["epo.org"])
    assert not on_host("http://www.epo.org/x", ["epo.org"])
    assert not on_host("https://epo.org.example.com/x", ["epo.org"])
    assert not on_host("https://notepo.org/x", ["epo.org"])


def urls_in(value, path=""):
    """Every (path, url) under `value`: string values of keys `url` or ending in `_url`."""
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and (key == "url" or key.endswith("_url")):
                yield f"{path}.{key}", item
            else:
                yield from urls_in(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from urls_in(item, f"{path}[{index}]")


def on_allowed_host(url, hosts):
    """https, and the host equals an entry or ends with "." + entry."""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return parsed.scheme == "https" and any(host == allowed or host.endswith(f".{allowed}") for allowed in hosts)


def test_every_url_is_on_an_allowed_host(data):
    hosts = data["allowed_hosts"]
    assert hosts and all(text(host) for host in hosts)
    found = list(urls_in(data))
    assert found
    outside = [(path, url) for path, url in found if not on_allowed_host(url, hosts)]
    assert outside == []


def test_pct_blocks(data):
    pct = data["pct"]
    date.fromisoformat(pct["checked_on"])
    for key in ("pct_international", "isa_ipea", "national_phase"):
        assert pct[key], key
    for item in pct["pct_international"]:
        assert text(item["fee"]) and text(item["reduction"]) and text(item["who_qualifies"]) and text(item["source_url"])
    for item in pct["isa_ipea"]:
        assert text(item["office"]) and text(item["role"]) and text(item["fee"]) and text(item["source_url"])
    for item in pct["national_phase"]:
        assert text(item["office"]) and text(item["source_url"])
        assert item["applies_on_entry"] in (True, False, None), item
    assert text(pct["pct_wide_sme"]["status"]) and text(pct["pct_wide_sme"]["source_url"])


def test_other_offices(data):
    other = data["other_offices"]
    groups = data["category_groups"]
    assert groups and all(text(label) for label in groups.values())
    ip5 = {office["code"] for office in data["offices"]}
    codes = [office["code"] for office in other["offices"]]
    assert len(codes) == len(set(codes)) and not ip5 & set(codes)
    for office in other["offices"]:
        assert text(office["name"]) and text(office["guide_updated"])
        assert office["fee_reductions"], office["code"]
        for fee in office["fee_reductions"]:
            assert text(fee["category"]) and text(fee["as_published"]) and text(fee["source_url"]), (office["code"], fee)
            assert fee["category_group"] and set(fee["category_group"]) <= set(groups), (office["code"], fee["category_group"])
            pct = fee["reduction_pct"]
            assert pct is None or (isinstance(pct, (int, float)) and not isinstance(pct, bool) and 0 <= pct <= 100), fee
        for entry in office.get("support", []):
            assert text(entry["name"]) and text(entry["text"]) and text(entry["url"])
    assert all(text(code) for code in other["no_reduction_listed"])
    assert other["not_assessed"] and all(isinstance(listed, list) for listed in other["not_assessed"].values())


def test_on_allowed_host_rejects_lookalikes():
    assert on_allowed_host("https://pctlegal.wipo.int/x", ["wipo.int"])
    assert not on_allowed_host("https://wipo.int.example.com/x", ["wipo.int"])
    assert not on_allowed_host("https://notwipo.int/x", ["wipo.int"])
    assert not on_allowed_host("http://pctlegal.wipo.int/x", ["wipo.int"])
