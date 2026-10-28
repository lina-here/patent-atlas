"""Data versions (pipeline/releases.py): changed ids per mapping row, version numbering, entries, bootstrap."""
import copy
import datetime
import json
from pathlib import Path

import pytest

from pipeline import releases, write
from pipeline.tests.test_write import RETRIEVED, outputs

ENTITY = write.ENTITY_DIR / "CH.json"


@pytest.fixture
def published(tmp_path):
    """Committed data + a releases.json: (root, fresh copy of the same outputs to mutate)."""
    built = outputs()
    write.write_outputs(built, tmp_path)
    write.write_file(tmp_path, releases.RELEASES, [{"version": "2026-10-01"}])
    return tmp_path, copy.deepcopy(built)


def ids(root, new):
    assert write.changed(new, root)  # changed_ids is only asked when the data changed
    return releases.changed_ids(root, new)


def test_no_releases_file_is_all(tmp_path):
    built = outputs()
    write.write_outputs(built, tmp_path)
    built[write.MANIFEST]["pipeline_sha"] = "def456"
    assert releases.changed_ids(tmp_path, built) == [releases.ALL]
    assert releases.changed_ids(tmp_path / "missing", outputs()) == [releases.ALL]  # fresh clone, no data at all


def test_unchanged_is_empty_and_ignores_releases_version_checks(published):
    root, new = published
    new[write.MANIFEST].update(version="2026-10-01", retrieved="2026-10-30", checks={"wdi": "warn"})
    assert not write.changed(new, root)
    assert releases.changed_ids(root, new) == []
    new[releases.RELEASES] = [{"version": "2026-10-30"}]  # added by run.py after changed_ids: ignored anyway
    assert releases.changed_ids(root, new) == []


def test_map_file_is_its_metric(published):
    root, new = published
    new[write.MAP_DIR / "per_million.json"]["values"] = {}
    assert ids(root, new) == ["per_million"]


@pytest.mark.parametrize("block", ["series", "ratios", "gender", "sources"])
def test_entity_blocks_by_id(published, block):
    root, new = published
    first = sorted(new[ENTITY][block])[0]
    new[ENTITY][block][first] = {"edited": True}
    assert ids(root, new) == [first]


def test_entity_value_deep_in_series(published):
    root, new = published
    totals = new[ENTITY]["series"]["origin_apps"]["types"]["total"]
    totals[sorted(totals)[0]] = 1
    assert ids(root, new) == ["origin_apps"]


def test_group_block_by_id(published):
    root, new = published
    group = next(path for path in new if path.parent == write.GROUP_DIR and new[path].get("series"))
    series_id = sorted(new[group]["series"])[0]
    new[group]["series"][series_id] = {}
    assert ids(root, new) == [series_id]


@pytest.mark.parametrize("key,expected", [
    ("pct_monthly", "pct_monthly"), ("pct_monthly_source", "pct_monthly"), ("method", "method"),
    ("top_n", "method"), ("top_origins", "origin_apps"), ("rank_race", "origin_apps"),
    ("top_grower", "origin_apps"), ("treemap", "origin_apps"), ("world_office", "office_apps"),
    ("pct_world", "pct_origin")])
def test_overview_keys(published, key, expected):
    root, new = published
    new[write.OVERVIEW][key] = "edited"
    assert ids(root, new) == [expected]


@pytest.mark.parametrize("world,expected", [("world_office", "office_apps"), ("pct_world", "pct_origin")])
def test_overview_world_yoy_by_world(published, world, expected):
    """world_yoy.<world key> names its series through KEY_ALIASES (world totals -> their series)."""
    root, new = published
    yoy = new[write.OVERVIEW]["world_yoy"][world]["yoy"]
    yoy[sorted(yoy)[-1]] = 99.9
    assert ids(root, new) == [expected]


def test_overview_world_yoy_added_names_both_series(published):
    """First refresh writing world_yoy (absent on disk): both world series, never the file stem."""
    root, new = published
    old = json.loads((root / write.OVERVIEW).read_text(encoding="utf-8"))
    del old["world_yoy"]
    write.write_file(root, write.OVERVIEW, old)
    assert ids(root, new) == ["office_apps", "pct_origin"]


def test_overview_id_keyed_blocks(published):
    root, new = published
    overview = new[write.OVERVIEW]
    overview["last_year"]["pct_origin"] = 1990
    overview["coverage"]["world_office"] = {}
    overview["gender"]["world"]["women_share"] = {}
    overview["gender"]["by_field"] = {}
    assert ids(root, new) == ["office_apps", "pct_origin", "women_any_by_field", "women_share"]


def test_other_paths_are_the_file_stem(published):
    root, new = published
    new[write.OVERVIEW]["series_breaks"] = []
    new[ENTITY]["label"] = "Helvetia"
    assert ids(root, new) == ["CH", "overview"]


def test_listing_files(published):
    root, new = published
    new[write.ENTITIES] = new[write.ENTITIES][1:]
    new[write.GROUPS]["no_group"] = ["XX"]
    assert ids(root, new) == ["entities", "groups"]


@pytest.mark.parametrize("key,value,expected", [
    ("releases", {"ips": "Last updated: June 2026"}, ["wipo_release"]),
    ("wdi_denominators", {}, ["wdi"]),
    ("pipeline_sha", "def456", ["pipeline"])])
def test_manifest_keys(published, key, value, expected):
    root, new = published
    new[write.MANIFEST][key] = value
    assert ids(root, new) == expected


def test_manifest_absent_rows_are_measure_ids(published):
    root, new = published
    absent = new[write.MANIFEST]["absent_rows"]
    absent["origin_apps"] += 1
    absent["women_any"] += 1
    assert ids(root, new) == ["origin_apps", "women_any"]


def test_added_and_removed_files(published):
    root, new = published
    removed = next(path for path in sorted(new) if path.parent == write.ENTITY_DIR and path != ENTITY)
    removed_series = set(new.pop(removed)["series"])
    new[write.ENTITY_DIR / "XX.json"] = {"code": "XX"}
    found = ids(root, new)
    assert found == sorted(found)
    # code/label: the file stem; the removed file's id blocks: their ids
    assert removed_series and {"XX", removed.stem, *removed_series} <= set(found)


@pytest.mark.parametrize("edit", ["formatting", "corrupt", "empty_new", "removed_map"])
def test_never_empty_when_changed(published, edit):
    root, new = published
    if edit == "formatting":  # same JSON, other text: changed() counts it
        (root / ENTITY).write_text(json.dumps(new[ENTITY]), encoding="utf-8")
    elif edit == "corrupt":
        (root / ENTITY).write_text("{", encoding="utf-8")
    elif edit == "empty_new":
        new[ENTITY] = {}
    else:
        del new[write.MAP_DIR / "per_gdp.json"]
    assert ids(root, new)


@pytest.mark.parametrize("taken,expected", [
    ([], "2026-10-19"), (["2026-10-18"], "2026-10-19"), (["2026-10-19"], "2026-10-19.2"),
    (["2026-10-19.2", "2026-10-19"], "2026-10-19.3")])
def test_next_version(taken, expected):
    assert releases.next_version([{"version": version} for version in taken], RETRIEVED) == expected


def test_next_version_skips_versions_only_tagged():
    """A version reverted out of releases.json keeps its data-<version> tag: its id is never issued again."""
    published = [{"version": "2026-10-18"}]
    assert releases.next_version(published, RETRIEVED, also_taken=["2026-10-19"]) == "2026-10-19.2"
    assert releases.next_version(published, RETRIEVED, also_taken=["2026-10-19", "2026-10-19.2"]) == "2026-10-19.3"


def test_entry_from_manifest():
    manifest = outputs()[write.MANIFEST]
    made = releases.entry("2026-10-19", manifest, ["origin_apps"])
    assert made == {"version": "2026-10-19", "wipo_releases": manifest["releases"],
                    "wdi_last_updated": {indicator: block["last_updated"]
                                         for indicator, block in manifest["wdi_denominators"].items()},
                    "pipeline_sha": "abc123", "changed": ["origin_apps"]}
    assert set(made["wdi_last_updated"]) == {"population", "gdp_ppp"}


@pytest.mark.parametrize("version,changed", [("2026-10-19", []), ("19.10.2026", ["all"])])
def test_entry_refuses_empty_changed_or_bad_version(version, changed):
    with pytest.raises(ValueError):
        releases.entry(version, outputs()[write.MANIFEST], changed)


def test_append_newest_first_never_rewrites():
    old = [{"version": "2026-10-01"}]
    assert releases.append(old, {"version": "2026-10-19"}) == [{"version": "2026-10-19"}, {"version": "2026-10-01"}]
    assert old == [{"version": "2026-10-01"}]
    with pytest.raises(ValueError, match="already published"):
        releases.append(old, {"version": "2026-10-01"})


def test_load(tmp_path):
    assert releases.load(tmp_path) == []
    (tmp_path / releases.RELEASES).write_text('[{"version": "2026-10-01"}]', encoding="utf-8")
    assert releases.load(tmp_path) == [{"version": "2026-10-01"}]


@pytest.mark.parametrize("content", ["{", "{}", "[{}]", '[{"version": "soon"}]',
                                     '[{"version": "2026-10-01"}, {"version": "2026-10-01"}]'])
def test_load_refuses_malformed(tmp_path, content):
    (tmp_path / releases.RELEASES).write_text(content, encoding="utf-8")
    with pytest.raises(ValueError):
        releases.load(tmp_path)


def committed(tmp_path, sha="abc123"):
    built = outputs(sha=sha)
    write.write_outputs(built, tmp_path)
    return built


def test_bootstrap_writes_first_entry_from_manifest(tmp_path):
    built = committed(tmp_path)
    data_before = {path: (tmp_path / path).read_text(encoding="utf-8") for path in built if path != write.MANIFEST}
    made = releases.bootstrap(tmp_path, is_commit=lambda sha: True)
    version = RETRIEVED.isoformat()
    assert made == releases.entry(version, built[write.MANIFEST], [releases.ALL])
    assert json.loads((tmp_path / releases.RELEASES).read_text(encoding="utf-8")) == [made]
    manifest = json.loads((tmp_path / write.MANIFEST).read_text(encoding="utf-8"))
    assert manifest == {**built[write.MANIFEST], "version": version}
    assert {path: (tmp_path / path).read_text(encoding="utf-8") for path in data_before} == data_before
    assert not write.changed({**built, write.MANIFEST: manifest}, tmp_path)  # bootstrap is no data change


def test_bootstrap_refuses_when_versions_exist(tmp_path):
    committed(tmp_path)
    releases.bootstrap(tmp_path, is_commit=lambda sha: True)
    before = (tmp_path / releases.RELEASES).read_bytes()
    with pytest.raises(ValueError, match="exists"):
        releases.bootstrap(tmp_path, is_commit=lambda sha: True)
    assert (tmp_path / releases.RELEASES).read_bytes() == before


@pytest.mark.parametrize("sha", ["abc123-dirty", "unknown", "fed987"])
def test_bootstrap_refuses_a_sha_not_committed_here(tmp_path, sha):
    """A dirty, unknown or foreign sha (private-repo commit after go-public) is no commit a reader can find: refused,
    nothing written; the way out is a full refresh from committed code (README)."""
    committed(tmp_path, sha=sha)
    before = sorted(path.name for path in tmp_path.iterdir())
    with pytest.raises(ValueError, match="full refresh from committed code"):
        releases.bootstrap(tmp_path, is_commit=lambda candidate: candidate == "abc123")
    assert sorted(path.name for path in tmp_path.iterdir()) == before
    assert "version" not in json.loads((tmp_path / write.MANIFEST).read_text(encoding="utf-8"))


def test_version_pattern():
    for good in ("2026-10-19", "2026-10-19.2", "2026-10-19.12"):
        assert releases.VERSION_PATTERN.fullmatch(good)
    for bad in ("2026-10-19.", "2026-10-19-2", "v2026-10-19", "2026-1-19"):
        assert not releases.VERSION_PATTERN.fullmatch(bad)
    assert datetime.date.fromisoformat(RETRIEVED.isoformat()) == RETRIEVED


def test_releases_path_is_relative():
    assert releases.RELEASES == Path("releases.json")
