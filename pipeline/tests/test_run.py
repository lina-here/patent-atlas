"""CLI flow with fakes: blocking check failure -> exit 2, nothing written; else write when changed."""
import json
import subprocess
from pathlib import Path

import pytest

from pipeline import crosscheck, gender, groups, m49, releases, run, scale, write
from pipeline.crosscheck import CheckError
from pipeline.entities import iso3
from pipeline.parse import SchemaError
from pipeline.series import GENDER_FROM, RATIO_FROM
from pipeline.tests.test_crosscheck import wdi_payload
from pipeline.tests.test_wdi import payload as denominator_payload
from pipeline.wdi import WDI_ALL_URL, WDI_DENOMINATORS, WDI_WORLD
from pipeline.wipo_client import WipoError
from pipeline.tests.test_write import (
    RELEASES, RETRIEVED, WD_2024, collected, gender_tables, make_data, treemap_data, wdi_denominators, wipo_ratios)
from pipeline.tests.test_write import outputs as built_outputs


def collect_result():
    """collect() as the WIPO client returns it: run.py adds `denominators` (WDI) itself."""
    result = collected()
    del result["denominators"]
    return result


@pytest.fixture
def fake_pipeline(monkeypatch):
    monkeypatch.setattr(run, "use_system_ca_bundle", lambda: None)
    monkeypatch.setattr(run, "WipoClient", lambda: object())
    monkeypatch.setattr(run, "collect", lambda client, today: collect_result())
    fetchers = []
    monkeypatch.setattr(run, "Fetcher", lambda: fetchers.append(FakeFetcher(make_data())) or fetchers[-1])
    monkeypatch.setattr(run, "releases", lambda client: dict(RELEASES))
    monkeypatch.setattr(run, "pipeline_sha", lambda: "abc123")
    monkeypatch.setattr(run, "data_tag_versions", lambda: [])  # never this repo's real tags
    monkeypatch.setattr(run, "utc_today", lambda: RETRIEVED)
    result = {"failures": [], "summary": {"wdi": "pass"}, "contexts": [], "fetchers": fetchers}

    def run_checks(data, outputs, fetcher, ctx):
        result["contexts"].append(ctx)
        return list(result["failures"]), dict(result["summary"])
    monkeypatch.setattr(run, "run_checks", run_checks)
    return result


def test_run_writes_outputs_with_checks(fake_pipeline, tmp_path):
    assert run.main(["--out", str(tmp_path)]) == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["checks"] == {"wdi": "pass", "regression": {
        "warn_pct": 5, "revision_count": 0, "revisions": [], "accepted": []}}  # empty dir: nothing to compare
    assert (tmp_path / "entity" / "CH.json").exists()
    assert manifest["wdi_denominators"]["gdp_ppp"]["gdp_base"] == 2021  # fetched through run.Fetcher
    assert (tmp_path / "map" / "per_million.json").exists()
    (fetcher,) = fake_pipeline["fetchers"]  # one Fetcher per run: WDI denominators and the checks
    assert [url for url in fetcher.urls if "country/all" in url] == [
        WDI_ALL_URL.format(indicator=indicator, first=RATIO_FROM, last=2025) for indicator in WDI_DENOMINATORS.values()]


def test_run_builds_group_context_once(fake_pipeline, monkeypatch, tmp_path):
    contexts, worlds = [], []
    real_context, real_worlds = groups.context, groups.world_figures
    monkeypatch.setattr(groups, "context", lambda *args: contexts.append(real_context(*args)) or contexts[-1])
    monkeypatch.setattr(groups, "world_figures", lambda data: worlds.append(data) or real_worlds(data))
    assert run.main(["--out", str(tmp_path)]) == 0
    assert len(contexts) == 1 and len(worlds) == 1  # outputs and checks share one context (and its worlds)
    assert fake_pipeline["contexts"] == contexts


def test_run_blocking_failure_writes_nothing(fake_pipeline, tmp_path, capsys):
    fake_pipeline["failures"] = ["golden world_2024: live 2000 vs published 1000"]
    assert run.main(["--out", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []
    assert "golden world_2024" in capsys.readouterr().err


def test_run_dry_run_writes_nothing(fake_pipeline, tmp_path):
    assert run.main(["--out", str(tmp_path), "--dry-run"]) == 0
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("error", [SchemaError("shape changed"), CheckError("HTTP 503 for WDI"), WipoError("HTTP 500")])
def test_run_errors_exit_2(fake_pipeline, monkeypatch, tmp_path, error):
    def boom(*args):
        raise error
    monkeypatch.setattr(run, "collect", boom)
    assert run.main(["--out", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []


def snapshot(root):
    return {path: path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def test_run_regression_blocks_and_flag_accepts(fake_pipeline, tmp_path, capsys):
    assert run.main(["--out", str(tmp_path)]) == 0
    extra = tmp_path / "entity" / "XX.json"  # committed entity the new run no longer publishes
    extra.write_text(write.dumps({"code": "XX", "label": "Extra land", "kind": "country", "series": {}}),
                     encoding="utf-8")
    committed = snapshot(tmp_path)
    assert run.main(["--out", str(tmp_path)]) == 2
    assert snapshot(tmp_path) == committed
    err = capsys.readouterr().err
    assert "BLOCKING: entity XX (Extra land) no longer published" in err
    assert "--accept-regression" in err
    assert run.main(["--out", str(tmp_path), "--accept-regression"]) == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["checks"]["regression"]["accepted"] == ["entity XX (Extra land) no longer published"]
    assert manifest["checks"]["regression"]["revision_count"] == 0  # same data again: nothing revised (key types agree)
    assert not extra.exists()


def test_run_dry_run_reports_regression(fake_pipeline, tmp_path, capsys):
    assert run.main(["--out", str(tmp_path)]) == 0
    entity = json.loads((tmp_path / "entity" / "CH.json").read_text(encoding="utf-8"))
    totals = entity["series"]["origin_apps"]["types"]["total"]
    new_value, totals["2015"] = totals["2015"], 1  # committed past year far from the new value
    assert new_value > 1
    (tmp_path / "entity" / "CH.json").write_text(write.dumps(entity), encoding="utf-8")
    committed = snapshot(tmp_path)
    capsys.readouterr()
    assert run.main(["--out", str(tmp_path), "--dry-run"]) == 0  # revisions warn, never block
    assert snapshot(tmp_path) == committed
    assert f"regression: entity CH origin_apps total 2015: 1 -> {new_value} (+{(new_value - 1) * 100}.0%)\n" \
        in capsys.readouterr().out


def test_run_unchanged_keeps_files(fake_pipeline, tmp_path, monkeypatch, capsys):
    assert run.main(["--out", str(tmp_path)]) == 0
    before = snapshot(tmp_path)
    fake_pipeline["summary"] = {"wdi": "warn"}  # checks alone never count as a change
    assert run.main(["--out", str(tmp_path)]) == 0
    assert snapshot(tmp_path) == before  # manifest and releases.json included: no new version
    assert "no change" in capsys.readouterr().out


def test_run_new_pipeline_sha_rewrites_manifest(fake_pipeline, tmp_path, monkeypatch):
    assert run.main(["--out", str(tmp_path)]) == 0
    monkeypatch.setattr(run, "pipeline_sha", lambda: "def456")
    assert run.main(["--out", str(tmp_path)]) == 0
    assert json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))["pipeline_sha"] == "def456"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_run_first_version_is_all(fake_pipeline, tmp_path):
    """Fresh clone / public repo: no releases.json -> the first entry says "all", no crash."""
    assert run.main(["--out", str(tmp_path)]) == 0
    (first,) = read_json(tmp_path / "releases.json")
    manifest = read_json(tmp_path / "manifest.json")
    assert first == releases.entry(RETRIEVED.isoformat(), manifest, [releases.ALL])
    assert manifest["version"] == RETRIEVED.isoformat()


def test_run_same_day_changed_run_is_next_version(fake_pipeline, tmp_path, monkeypatch):
    assert run.main(["--out", str(tmp_path)]) == 0
    first = (tmp_path / "releases.json").read_text(encoding="utf-8")
    monkeypatch.setattr(run, "pipeline_sha", lambda: "def456")
    assert run.main(["--out", str(tmp_path)]) == 0
    newest, *older = read_json(tmp_path / "releases.json")
    assert newest["version"] == f"{RETRIEVED.isoformat()}.2" and newest["changed"] == ["pipeline"]
    assert newest["pipeline_sha"] == "def456"
    assert older == json.loads(first)  # the published entry is untouched
    assert read_json(tmp_path / "manifest.json")["version"] == newest["version"]


def test_run_skips_a_version_held_by_a_data_tag(fake_pipeline, tmp_path, monkeypatch):
    """Version committed, tagged, then reverted out of releases.json: the re-run must not reuse its id for other
    data (the tag still holds the first data)."""
    monkeypatch.setattr(run, "data_tag_versions", lambda: [RETRIEVED.isoformat()])
    assert run.main(["--out", str(tmp_path)]) == 0
    (first,) = read_json(tmp_path / "releases.json")
    assert first["version"] == f"{RETRIEVED.isoformat()}.2" and first["changed"] == [releases.ALL]
    assert read_json(tmp_path / "manifest.json")["version"] == first["version"]


def test_run_dirty_pipeline_refused(fake_pipeline, tmp_path, monkeypatch, capsys):
    assert run.main(["--out", str(tmp_path)]) == 0
    committed = snapshot(tmp_path)
    monkeypatch.setattr(run, "pipeline_sha", lambda: "def456-dirty")
    assert run.main(["--out", str(tmp_path)]) == 2
    assert snapshot(tmp_path) == committed
    err = capsys.readouterr().err
    assert "BLOCKING: pipeline def456-dirty" in err and "FAILED (nothing written)" in err


def test_run_unknown_pipeline_sha_refused(fake_pipeline, tmp_path, monkeypatch, capsys):
    """pipeline_sha() is "unknown" outside git: a citable version cannot name that."""
    monkeypatch.setattr(run, "pipeline_sha", lambda: "unknown")
    assert run.main(["--out", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []
    err = capsys.readouterr().err
    assert "BLOCKING: pipeline unknown" in err and "FAILED (nothing written)" in err


def test_run_dirty_pipeline_refused_on_first_run(fake_pipeline, tmp_path, monkeypatch):
    monkeypatch.setattr(run, "pipeline_sha", lambda: "abc123-dirty")
    assert run.main(["--out", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []


def test_run_malformed_releases_file_writes_nothing(fake_pipeline, tmp_path, monkeypatch, capsys):
    assert run.main(["--out", str(tmp_path)]) == 0
    (tmp_path / "releases.json").write_text("{}", encoding="utf-8")
    committed = snapshot(tmp_path)
    monkeypatch.setattr(run, "pipeline_sha", lambda: "def456")
    assert run.main(["--out", str(tmp_path)]) == 2
    assert snapshot(tmp_path) == committed
    assert "FAILED (nothing written)" in capsys.readouterr().err


def test_run_bootstrap_version_fetches_nothing(fake_pipeline, tmp_path, monkeypatch):
    write.write_outputs(built_outputs(), tmp_path)

    def no_fetch(*args):
        raise AssertionError("bootstrap must not fetch")
    monkeypatch.setattr(run, "WipoClient", no_fetch)
    monkeypatch.setattr(run, "Fetcher", no_fetch)
    monkeypatch.setattr(run, "is_commit", lambda sha: True)
    assert run.main(["--out", str(tmp_path), "--bootstrap-version"]) == 0
    (first,) = read_json(tmp_path / "releases.json")
    assert first["changed"] == [releases.ALL] and first["version"] == RETRIEVED.isoformat()
    before = snapshot(tmp_path)
    assert run.main(["--out", str(tmp_path), "--bootstrap-version"]) == 2  # never rewrites a published version
    assert snapshot(tmp_path) == before


def test_run_bootstrap_refuses_a_sha_this_repo_lacks(fake_pipeline, tmp_path, monkeypatch, capsys):
    """Go-public: the manifest names a private-repo commit. Refused, exit 2, nothing written."""
    write.write_outputs(built_outputs(), tmp_path)
    before = snapshot(tmp_path)
    monkeypatch.setattr(run, "is_commit", lambda sha: False)
    assert run.main(["--out", str(tmp_path), "--bootstrap-version"]) == 2
    assert snapshot(tmp_path) == before
    assert "full refresh from committed code" in capsys.readouterr().err


# pipeline_sha: version of the code that wrote the data, in a throwaway git repo

def git(root, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false",
                    "-c", "core.hooksPath=/dev/null", *args], cwd=root, check=True, capture_output=True)


def head(root):
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True,
                          text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "pipeline").mkdir()
    (tmp_path / "pipeline" / "run.py").write_text("v1\n", encoding="utf-8")
    git(tmp_path, "init", "-q")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "pipeline v1")
    return tmp_path


def test_pipeline_sha_is_last_pipeline_commit(repo):
    code_commit = head(repo)
    (repo / "site").mkdir()
    (repo / "site" / "manifest.json").write_text("{}\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "data refresh")  # HEAD moves, pipeline code does not
    assert run.pipeline_sha(repo) == code_commit


@pytest.mark.parametrize("change", ["edit", "untracked"])
def test_pipeline_sha_dirty_when_pipeline_has_uncommitted_changes(repo, change):
    if change == "edit":
        (repo / "pipeline" / "run.py").write_text("v2\n", encoding="utf-8")
    else:
        (repo / "pipeline" / "new.py").write_text("x\n", encoding="utf-8")
    assert run.pipeline_sha(repo) == f"{head(repo)}-dirty"


def test_pipeline_sha_ignores_changes_outside_pipeline(repo):
    (repo / "notes.txt").write_text("x\n", encoding="utf-8")
    assert run.pipeline_sha(repo) == head(repo)


def test_pipeline_sha_unknown_outside_git(tmp_path):
    assert run.pipeline_sha(tmp_path) == "unknown"


def test_data_tag_versions_lists_data_tags_only(repo):
    git(repo, "tag", "data-2026-10-21")
    git(repo, "tag", "data-2026-10-21.2")
    git(repo, "tag", "v1")
    assert sorted(run.data_tag_versions(repo)) == ["2026-10-21", "2026-10-21.2"]


def test_data_tag_versions_none_outside_git(tmp_path):
    assert run.data_tag_versions(tmp_path) == []


def test_is_commit(repo):
    assert run.is_commit(head(repo), repo)
    assert run.is_commit(head(repo)[:12], repo)
    for sha in (f"{head(repo)}-dirty", "unknown", "0" * 40, "--all", ""):
        assert not run.is_commit(sha, repo)
    (repo / "blob.txt").write_text("x\n", encoding="utf-8")
    blob = subprocess.run(["git", "hash-object", "-w", "blob.txt"], cwd=repo, check=True, capture_output=True,
                          text=True).stdout.strip()
    assert not run.is_commit(blob, repo)  # an object, not a commit


# run_checks on fixture data with fake sources

GOLDEN_FIXTURE = [
    {"id": "world", "description": "d", "value": 744000, "year": 2024, "series": "office_apps",
     "code_or_world": "world", "citation": "WIPI 2025. DOI: 10.1/x", "url": "https://example.org/wipi.pdf",
     "page": "p. 7"},
    {"id": "ch_origin", "description": "d", "value": 2100, "year": 2024, "series": "origin_apps",
     "code_or_world": "CH", "citation": "PCT Yearly Review 2025", "url": "https://example.org/pyr.pdf",
     "page": "p. 24"},
]


class FakeFetcher:
    def __init__(self, data, wdi_delta=0, lastupdated="2026-10-08", blank=False, denominators=None):
        """blank: every WDI sample row null (WDI has the cells, no values). `denominators`: what WDI `country/all`
        serves (default: test_write.wdi_denominators)."""
        self.data, self.wdi_delta, self.lastupdated, self.blank, self.urls = data, wdi_delta, lastupdated, blank, []
        self.denominators = denominators if denominators is not None else wdi_denominators()

    def get(self, url, accept):
        self.urls.append(url)
        if "/country/all/" in url:  # WDI denominators: rows of the requested years only
            first, last = (int(year) for year in url.split("date=")[1].split("&")[0].split(":"))
            denominator = next(item for item in self.denominators.values() if item.indicator in url)
            rows = [(code_iso3, str(year), value) for code_iso3, years in (
                *((iso3(code), years) for code, years in denominator.values.items()), (WDI_WORLD, denominator.world))
                for year, value in years.items() if first <= year <= last]
            return denominator_payload(rows, denominator.indicator, denominator.name,
                                       lastupdated=denominator.last_updated.isoformat())
        if "worldbank" in url:
            indicator = "IP.PAT.RESD" if "IP.PAT.RESD" in url else "IP.PAT.NRES"
            type_key = crosscheck.WDI_INDICATORS[indicator]
            office = self.data["office_apps"].values
            rows = [(iso3, str(year), None if self.blank else office[code][type_key][year] + self.wdi_delta)
                    for iso3, code in (("CHE", "CH"), ("USA", "US")) for year in range(2020, 2024)]
            return wdi_payload(rows, indicator=indicator, lastupdated=self.lastupdated)
        return "REF_AREA,TIME_PERIOD,OBS_VALUE\nUSA,2023,1\nUSA,2024,2\n"


@pytest.fixture
def checks_env(monkeypatch):
    monkeypatch.setattr(crosscheck, "WDI_OFFICES", ("CH", "US"))
    monkeypatch.setattr(crosscheck, "load_golden", lambda: GOLDEN_FIXTURE)
    data = make_data()
    return data, write.build_outputs(collected(data), RELEASES, RETRIEVED, "abc")


def run_checks(data, outputs, fetcher, **collected_parts):
    """run.run_checks with a context of `data` as it is now (tests change data after build_outputs); WIPO ratio
    tables and WDI denominators from the fixture unless given."""
    return run.run_checks({**collected(data), **collected_parts}, outputs, fetcher, groups.context(data))


def test_run_checks_golden_mismatch_blocks(checks_env, monkeypatch):
    data, outputs = checks_env
    golden = [{**entry, "value": 2200} if entry["id"] == "ch_origin" else entry for entry in GOLDEN_FIXTURE]
    monkeypatch.setattr(crosscheck, "load_golden", lambda: golden)
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert any(line.startswith("ch_origin: live 2100 vs published 2200") for line in failures)
    assert summary["golden"] == ["world: live 744000 vs published 744000 (+0.00%)"]  # the mismatch is no note


@pytest.mark.parametrize("lastupdated", ["2026-10-08", "2026-04-30"])  # an older WDI never excuses no overlap
def test_run_checks_wdi_no_overlap_blocks(checks_env, lastupdated):
    data, outputs = checks_env
    failures, summary = run_checks(data, outputs, FakeFetcher(data, blank=True, lastupdated=lastupdated))
    assert "WDI: no cell with values on both sides in 2020-2023" in failures
    assert summary["wdi"] == "fail"


def test_run_checks_pass(checks_env):
    data, outputs = checks_env
    pct = data["pct_origin"].values
    pct["ZZ"]["total"] = {year: pct["CH"]["total"][year] + pct["US"]["total"][year] + 100
                          for year in pct["CH"]["total"]}
    for code, value in (("R1", 0), ("R2", 0), ("R4", 0), ("R6", 0), ("**", 100)):  # ZZ = sum(R) + ** again
        pct[code]["total"] = {year: value for year in pct[code]["total"]}
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert failures == []
    assert summary["groups"] == []
    assert summary["wdi"] == "pass"
    assert summary["wdi_scope"].startswith("CH, US; 2020-2023; 16 of 16 cells")
    assert (summary["wdi_last_updated"], summary["wdi_warnings"], summary["wdi_warning_reason"]) == (
        "2026-10-08", [], None)
    assert summary["golden"] == ["world: live 744000 vs published 744000 (+0.00%)",
                                 "ch_origin: live 2100 vs published 2100 (+0.00%)"]
    assert summary["world"] == []
    assert summary["golden_sources"] == [
        {"id": "world", "citation": "WIPI 2025. DOI: 10.1/x", "url": "https://example.org/wipi.pdf", "page": "p. 7"},
        {"id": "ch_origin", "citation": "PCT Yearly Review 2025", "url": "https://example.org/pyr.pdf",
         "page": "p. 24"},
    ]
    assert set(summary["world_sum_ratio"]) == {"world_office", "pct_world"}
    assert isinstance(summary["oecd"], list)
    assert summary["ratios"] == {ratio_id: {
        "compared": 24, "failing_count": 0, "failing": [], "world": "pass", "world_failing": [], "unlisted": [],
        "vintage_factors": [], "warnings": [],
        "by_country": {code: {"failing": 0, "max_pct": max_pct, "median_factor": factor}
                       for code, max_pct, factor in by_country}}
        for ratio_id, by_country in (("per_million", (("CH", 0.1, 0.9996), ("US", 0.3, 1.0027))),
                                     ("per_gdp", (("CH", 0.1, 1.0), ("US", 0.0, 1.0))))}  # CH, US x 2013-2024


def test_run_checks_group_warnings_do_not_block(checks_env):
    data, outputs = checks_env
    pct = data["pct_origin"].values
    pct["ZZ"]["total"] = {year: pct["CH"]["total"][year] + pct["US"]["total"][year] + 100
                          for year in pct["CH"]["total"]}  # below sum(R1-R6): band negative, != **
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert failures == []
    assert any("negative" in line for line in summary["groups"])
    assert any("PCT unknown band" in line for line in summary["groups"])


@pytest.mark.parametrize("excess, expected", [(0, []), (1, ["treemap 2024: not-attributable rest negative (-1)"])])
def test_run_checks_negative_treemap_rest_blocks(checks_env, excess, expected):
    """Spec 2a amendments: a negative not-attributable rest at the treemap year blocks the refresh (the band in other
    years: warning only, groups.check_warnings); a rest of 0 passes. TW null: no unattributed origin to fit inside."""
    data = treemap_data()
    origin = data["origin_apps"].values
    origin["TW"]["total"][2024] = None
    grouped = sum(types["total"][2024] or 0 for code, types in origin.items() if m49.continent_of(code))
    origin["JP"]["total"][2024] += WD_2024 - grouped + excess  # continents = WD + excess
    outputs = write.build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    assert outputs[write.OVERVIEW]["treemap"]["residual"]["value"] == -excess
    failures, _ = run_checks(data, outputs, FakeFetcher(data))
    assert [line for line in failures if line.startswith("treemap")] == expected


@pytest.mark.parametrize("excess", [0, 1])
def test_run_checks_unattributed_outside_treemap_rest_blocks(checks_env, excess):
    """Unattributed origins (no M49 continent) sit inside the not-attributable rest: their sum above it blocks (WD
    below the origin sum); equal passes."""
    data = treemap_data()
    rest = write.build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[write.OVERVIEW]["treemap"]["residual"]
    data["origin_apps"].values["TW"]["total"][2024] = rest["value"] + excess  # TW: the fixture's only unattributed
    outputs = write.build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    assert outputs[write.OVERVIEW]["treemap"]["residual"] == rest  # TW outside every continent: rest unchanged
    failures, _ = run_checks(data, outputs, FakeFetcher(data))
    value = rest["value"]
    expected = [f"treemap 2024: unattributed origins exceed the not-attributable rest ({value + excess} > {value})"]
    assert [line for line in failures if line.startswith("treemap")] == (expected if excess else [])


def test_run_checks_wdi_mismatch_and_world_excess_block(checks_env):
    data, outputs = checks_env
    data["office_apps"].values["WD"]["total"][2020] = 1  # WIPO world below our office sum
    failures, summary = run_checks(data, outputs, FakeFetcher(data, wdi_delta=1))
    assert summary["wdi"] == "fail"
    assert any(line.startswith("WDI CH 2020 resident") for line in failures)
    assert any(line.startswith("world_office 2020: sum of entities") for line in failures)


def test_run_checks_wdi_older_than_release_mismatch_warns(checks_env):
    data, outputs = checks_env  # RELEASES ips: May 2026
    failures, summary = run_checks(data, outputs, FakeFetcher(data, wdi_delta=1, lastupdated="2026-04-30"))
    assert failures == []
    assert summary["wdi"] == "warn"
    assert summary["wdi_last_updated"] == "2026-04-30"
    assert "WDI CH 2020 resident: WIPO 1135, World Bank 1136" in summary["wdi_warnings"]
    assert len(summary["wdi_warnings"]) == 16
    assert "2026-04-30" in summary["wdi_warning_reason"] and "May 2026" in summary["wdi_warning_reason"]


@pytest.mark.parametrize("lastupdated", ["2026-05-02", "2026-07-01"])
def test_run_checks_wdi_as_recent_as_release_mismatch_blocks(checks_env, lastupdated):
    data, outputs = checks_env
    failures, summary = run_checks(data, outputs, FakeFetcher(data, wdi_delta=1, lastupdated=lastupdated))
    assert summary["wdi"] == "fail" and summary["wdi_warnings"] == []
    assert "WDI CH 2020 resident: WIPO 1135, World Bank 1136" in failures
    assert any(lastupdated in line and "May 2026" in line for line in failures)


def test_run_checks_wdi_missing_lastupdated_mismatch_blocks(checks_env):
    data, outputs = checks_env
    failures, summary = run_checks(data, outputs, FakeFetcher(data, wdi_delta=1, lastupdated=None))
    assert summary["wdi"] == "fail" and summary["wdi_last_updated"] is None
    assert "WDI CH 2020 resident: WIPO 1135, World Bank 1136" in failures


def test_run_checks_wdi_older_never_excuses_missing_office(checks_env, monkeypatch):
    data, outputs = checks_env
    monkeypatch.setattr(crosscheck, "WDI_OFFICES", ("CH", "US", "DE"))
    failures, _ = run_checks(data, outputs, FakeFetcher(data, lastupdated="2026-04-30"))
    assert failures == ["WDI sample office DE not in office_apps"]


def test_run_checks_missing_sample_office_blocks(checks_env, monkeypatch):
    data, outputs = checks_env
    monkeypatch.setattr(crosscheck, "WDI_OFFICES", ("CH", "US", "DE"))
    fetcher = FakeFetcher(data)
    failures, _ = run_checks(data, outputs, fetcher)
    assert failures == ["WDI sample office DE not in office_apps"]


@pytest.mark.parametrize("target, error", [("build_outputs", ValueError("2026 not complete")),
                                           ("write_outputs", OSError("disk full"))])
def test_run_value_and_os_errors_exit_2(fake_pipeline, monkeypatch, tmp_path, capsys, target, error):
    def boom(*args):
        raise error
    monkeypatch.setattr(write, target, boom)
    assert run.main(["--out", str(tmp_path)]) == 2
    assert str(error) in capsys.readouterr().err


def test_ca_bundle_noop_when_env_set(monkeypatch):
    installed = []
    monkeypatch.setattr(run.urllib.request, "install_opener", installed.append)
    monkeypatch.setenv("SSL_CERT_FILE", "/some/bundle.pem")
    run.use_system_ca_bundle()
    assert installed == []


def test_ca_bundle_installed_when_env_unset(monkeypatch, tmp_path):
    installed, contexts = [], []
    monkeypatch.setattr(run.urllib.request, "install_opener", installed.append)
    monkeypatch.setattr(run.ssl, "create_default_context", lambda cafile: contexts.append(cafile) or None)
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    bundle = tmp_path / "cert.pem"
    monkeypatch.setattr(run, "SYSTEM_CA_BUNDLE", bundle)
    run.use_system_ca_bundle()
    assert installed == []  # no bundle file -> nothing
    bundle.write_text("x", encoding="utf-8")
    run.use_system_ca_bundle()
    assert contexts == [str(bundle)] and len(installed) == 1


def test_run_checks_rejects_context_of_other_data(checks_env):
    data, outputs = checks_env
    with pytest.raises(ValueError, match="context"):
        run.run_checks(collected(data), outputs, FakeFetcher(data), groups.context(make_data()))


def test_run_checks_pct_monthly_warnings(checks_env):
    data, _ = checks_env
    zz = data["pct_origin"].values["ZZ"]["total"]
    months = {year: [zz[year] // 12] * 11 + [zz[year] - 11 * (zz[year] // 12)] for year in zz}  # sums match
    months[2014] = months[2014][:6] + [None] * 6  # short year
    months[2015] = months[2015][:11] + [months[2015][11] + 1]  # mismatch
    outputs = write.build_outputs(collected(data, months), RELEASES, RETRIEVED, "abc")
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert summary["pct_monthly"] == [
        "PCT monthly 2014: 6 of 12 months not reported (shown null)",
        f"PCT monthly 2015: sum of months {zz[2015] + 1} != WIPO yearly total (ZZ) {zz[2015]}",
    ]
    assert not [line for line in failures if "PCT monthly" in line]  # warning only


def test_run_checks_ratio_limits(checks_env, monkeypatch):
    """Fail limit per ratio (I9): above -> blocking line; below -> listed in summary only. per_million blocks on the
    cell share; per_gdp's cell share only warns (scale.RATIO_BLOCKING_TEST). PCT runs a year ahead of origin in the
    fixture: WDI denominators requested RATIO_FROM..PCT last year."""
    data, outputs = checks_env
    fetcher = FakeFetcher(data)
    denominators = run.ratio_denominators(data, fetcher.get)
    assert fetcher.urls == [WDI_ALL_URL.format(indicator=indicator, first=RATIO_FROM, last=2025)
                            for indicator in WDI_DENOMINATORS.values()]
    ratios = wipo_ratios(data, denominators)
    for ratio_id in scale.WIPO_RATIO_IDS:
        for year in (2014, 2015, 2016):  # 3 of 24 compared cells far outside tolerance: 12.5% > 10%
            ratios[ratio_id].values["CH"][year] += 50
    failures, summary = run_checks(data, outputs, fetcher, ratios=ratios, denominators=denominators)
    assert "per_million: 3 of 24 compared cells outside tolerance (12.5%), above the limit 10.0%" in failures
    assert not [line for line in failures if line.startswith("per_gdp")]
    assert set(summary["ratios"]) == {"per_million", "per_gdp"}
    block = summary["ratios"]["per_gdp"]
    assert set(block) == {"compared", "failing", "failing_count", "by_country", "world", "world_failing", "unlisted",
                          "vintage_factors", "warnings"}
    assert block["warnings"] == ["per_gdp: 3 of 24 compared cells outside tolerance (12.5%), above the limit 10.0%"]
    assert (block["compared"], block["failing_count"], len(block["failing"]), block["world"]) == (24, 3, 3, "pass")
    assert block["by_country"]["CH"]["failing"] == 3 and summary["ratios"]["per_million"]["warnings"] == []
    monkeypatch.setattr(scale, "RATIO_FAILING_LIST_MAX", 1)  # published list cut, count taken before the cut
    _, summary = run_checks(data, outputs, fetcher, ratios=ratios, denominators=denominators)
    assert (summary["ratios"]["per_million"]["failing_count"], len(summary["ratios"]["per_million"]["failing"])) == (
        3, 1)
    ratios["per_million"].values["CH"][2016] -= 50  # 2 of 24: 8.3%, below the limit
    failures, summary = run_checks(data, outputs, fetcher, ratios=ratios, denominators=denominators)
    assert not [line for line in failures if line.startswith("per_million")]
    assert summary["ratios"]["per_million"]["failing"][0].startswith("per_million CH 2014: WIPO ")


def test_run_checks_per_gdp_country_factor_blocks(checks_env):
    """per_gdp blocks when a share of countries above RATIO_COUNTRY_SHARE_MAX is off by a median factor beyond
    RATIO_COUNTRY_FACTOR_MAX; the countries are named; manifest lists the vintage factors."""
    data, outputs = checks_env
    ratios = wipo_ratios(data, wdi_denominators())
    ratios["per_gdp"].values["CH"] = {year: None if value is None else round(value * 1.25, 1)
                                      for year, value in ratios["per_gdp"].values["CH"].items()}
    failures, summary = run_checks(data, outputs, FakeFetcher(data), ratios=ratios)
    (line,) = [line for line in failures if line.startswith("per_gdp")]
    assert line.startswith("per_gdp: 1 of 2 countries with a median ours/WIPO factor off by more than 10.0% (50.0%), "
                           "above the limit 5.0%: CH 0.8")
    (vintage,) = summary["ratios"]["per_gdp"]["vintage_factors"]
    assert vintage["code"] == "CH" and abs(vintage["median_factor"] - 0.8) < 0.01


def test_run_checks_ratio_world_row_not_compared_blocks(checks_env):
    data, outputs = checks_env
    data["office_apps"].values["WD"]["resident"] = dict.fromkeys(data["office_apps"].values["WD"]["resident"])
    failures, summary = run_checks(data, outputs, FakeFetcher(data), ratios=wipo_ratios(make_data(), wdi_denominators()))
    assert "per_million world row not compared" in failures and "per_gdp world row not compared" in failures
    assert summary["ratios"]["per_million"]["world"] == "fail"


def test_run_checks_ratio_world_lines_and_unlisted(checks_env):
    """Ruling I1: the WD per-year lines kept in summary["ratios"]; ruling I2: a WIPO value with no country entity
    -> `unlisted` (warning, never blocking)."""
    data, outputs = checks_env
    ratios = wipo_ratios(data, wdi_denominators())
    ratios["per_gdp"].values["WD"][2020] += 50
    ratios["per_million"].values["NO"] = {**dict.fromkeys(ratios["per_million"].values["WD"]), 2024: 5.0}
    failures, summary = run_checks(data, outputs, FakeFetcher(data), ratios=ratios)
    assert "per_gdp world row outside tolerance (1 years)" in failures
    (line,) = summary["ratios"]["per_gdp"]["world_failing"]
    assert line.startswith("per_gdp WD 2020: WIPO ")
    assert summary["ratios"]["per_gdp"]["world"] == "fail" and summary["ratios"]["per_million"]["world_failing"] == []
    assert summary["ratios"]["per_million"]["unlisted"] == [{"code": "NO", "years": "2024-2024"}]
    assert summary["ratios"]["per_gdp"]["unlisted"] == []
    assert not [line for line in failures if "NO" in line.split()]


def test_run_checks_wipo_ratios_share_numerator(checks_env, monkeypatch):
    """Ruling M1: the cross-check takes one numerator for both WIPO ratios; differing numerators raise."""
    data, outputs = checks_env
    monkeypatch.setitem(scale.RATIO_NUMERATOR, "per_gdp", ("pct_origin", "total"))
    with pytest.raises(ValueError, match="numerator"):
        run_checks(data, outputs, FakeFetcher(data))


def test_run_dry_run_prints_ratio_drift_world_and_unlisted(fake_pipeline, tmp_path, capsys):
    """Ruling I1/I2: a (blocked) dry run prints per ratio the count line, the WD lines, the countries with failing
    cells (most failing first), the failing lines and the unlisted codes: what Task 3b reports without a manifest."""
    check = scale.RatioCheck(
        compared={"per_million": 10, "per_gdp": 24},
        failing={"per_million": [], "per_gdp": ["per_gdp CH 2014: WIPO 1.0, computed 2.0 (+100.00%)",
                                                "per_gdp US 2014: WIPO 1.0, computed 1.1 (+10.00%)",
                                                "per_gdp US 2015: WIPO 1.0, computed 1.1 (+10.00%)"]},
        by_country={"per_million": {"CH": {"failing": 0, "max_pct": 0.1}},
                    "per_gdp": {"CH": {"failing": 1, "max_pct": 100.0}, "MG": {"failing": 0, "max_pct": 0.2},
                                "US": {"failing": 2, "max_pct": 10.0}, "ZW": {"failing": 1, "max_pct": None}}},
        world_failing={"per_million": [], "per_gdp": ["per_gdp WD 2020: WIPO 7.5, computed 9.0 (+20.00%)"]},
        world_compared={"per_million": 5, "per_gdp": 5},
        vintage_factors={"per_million": [], "per_gdp": [{"code": code, "median_factor": factor} for code, factor in (
            ("CH", 2.0), ("US", 1.1), ("RW", 0.967), ("IN", 1.03), ("JP", 0.979), ("MG", 1.006))]},
        warnings={"per_million": [], "per_gdp": ["per_gdp: 3 of 24 compared cells outside tolerance (12.5%), above "
                                                 "the limit 10.0%"]},
        blocking=["per_gdp world row outside tolerance (1 years)"])
    fake_pipeline["summary"] = {"ratios": run.ratio_summary(
        check, {"per_million": [{"code": "NO", "years": "2010-2024"}], "per_gdp": []})}
    fake_pipeline["failures"] = list(check.blocking)
    assert run.main(["--dry-run", "--out", str(tmp_path)]) == 2
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("ratios: ")]
    assert lines == [
        "ratios: per_million: 0 of 10 compared cells outside tolerance; world row pass",
        "ratios: per_million: 0 countries with a median factor off by more than 0.5% (WDI vintage)",
        "ratios: per_million NO: WIPO values 2010-2024, no country entity (not shown, not compared)",
        "ratios: per_gdp: 3 of 24 compared cells outside tolerance; world row fail",
        "ratios: per_gdp: 3 of 24 compared cells outside tolerance (12.5%), above the limit 10.0% (warning)",
        "ratios: per_gdp: 6 countries with a median factor off by more than 0.5% (WDI vintage): CH 2.0000, "
        "US 1.1000, RW 0.9670, IN 1.0300, JP 0.9790",
        "ratios: per_gdp WD 2020: WIPO 7.5, computed 9.0 (+20.00%)",
        "ratios: per_gdp US: 2 failing, max 10.0%",
        "ratios: per_gdp CH: 1 failing, max 100.0%",
        "ratios: per_gdp ZW: 1 failing, max n/a",
        "ratios: per_gdp CH 2014: WIPO 1.0, computed 2.0 (+100.00%)",
        "ratios: per_gdp US 2014: WIPO 1.0, computed 1.1 (+10.00%)",
        "ratios: per_gdp US 2015: WIPO 1.0, computed 1.1 (+10.00%)",
    ]
    assert not list(tmp_path.iterdir())


# Women inventors: cross-checks are warnings only (Task 3 stop rule reads gap_years)

DE_UNLISTED = [f"{measure} DE: WIPO values {GENDER_FROM}-2025, no country entity (not shown)"
               for measure in ("women_any", "women_share")]


def test_run_checks_gender_summary(checks_env):
    data, outputs = checks_env
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    # fixture ZZ = weighted country mean rounded: largest gap 39.4 - 39.35 (CH omitted that year)
    assert summary["gender"] == {"compared": 2025 - GENDER_FROM + 1, "max_gap_pp": 0.05, "gap_years": [],
                                 "warnings": DE_UNLISTED}
    assert not [line for line in failures if "women" in line]


def test_run_checks_gender_gaps_warn_never_block(checks_env):
    data, outputs = checks_env
    tables = gender_tables()
    world = tables["women_any"].values["ZZ"]
    world[2020] += 1.0  # 38.1 vs mean 37.07: gap -1.03
    world[2021] -= 0.5  # 36.6 vs 37.07: gap +0.47, within tolerance
    failures, summary = run_checks(data, outputs, FakeFetcher(data), gender=tables)
    assert summary["gender"]["gap_years"] == [2020]
    assert summary["gender"]["max_gap_pp"] == 1.03
    assert summary["gender"]["warnings"][0] == \
        "women_any weighted country mean 2020: 37.07 vs WIPO 38.1 (gap -1.03 pp, over 0.5 pp)"
    assert not [line for line in failures if "women" in line]


def test_run_checks_gender_systematic_gap_blocks(checks_env):
    """Gap over tolerance in more than half the compared years = weighting no longer reproduces WIPO's World row:
    block (the plan's Task 3 stop rule, now in the run; review 6 I2). Half or fewer: warnings only (test above)."""
    data, outputs = checks_env
    tables = gender_tables()
    world = tables["women_any"].values["ZZ"]
    years = sorted(year for year, value in world.items() if value is not None)
    for year in years[:len(years) // 2 + 1]:
        world[year] += 2.0
    failures, summary = run_checks(data, outputs, FakeFetcher(data), gender=tables)
    assert len(summary["gender"]["gap_years"]) == len(years) // 2 + 1
    assert [line for line in failures if line.startswith("gender: women_any weighted country mean off WIPO World")]


def test_run_checks_gender_continent_crosscheck_warns(checks_env, monkeypatch):
    data, outputs = checks_env
    published = gender.load_published()
    published["women_any"] = {"europe": {2024: {"value": 31.0, "figure": "A0", "page": "p. 1"}}}
    monkeypatch.setattr(gender, "load_published", lambda path=gender.GENDER_PUBLISHED_PATH: published)
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert "women_any europe 2024: 29.09 vs WIPO 31.0 (gap -1.91 pp, over 0.5 pp)" in summary["gender"]["warnings"]
    assert summary["gender"]["gap_years"] == []  # World cross-check only
    assert not [line for line in failures if "women" in line]


def test_run_checks_golden_gender_figures(checks_env, monkeypatch):
    """Golden women_* entries (golden.json) read entity gender values and overview gender.world."""
    data, outputs = checks_env
    golden = [{**GOLDEN_FIXTURE[0], "id": "women_any_world", "value": 37.1, "year": 2025, "series": "women_any"},
              {**GOLDEN_FIXTURE[1], "id": "women_share_ch", "value": 15.1, "year": 2024, "series": "women_share"}]
    monkeypatch.setattr(crosscheck, "load_golden", lambda: golden)
    failures, summary = run_checks(data, outputs, FakeFetcher(data))
    assert summary["golden"] == ["women_any_world: live 37.1 vs published 37.1 (+0.00%)",
                                 "women_share_ch: live 15.0 vs published 15.1 (-0.66%)"]
    assert not [line for line in failures if "women" in line]


def test_run_dry_run_prints_gender_lines(fake_pipeline, tmp_path, capsys):
    fake_pipeline["summary"] = {"gender": {"compared": 26, "max_gap_pp": 1.03, "gap_years": [2020],
                                           "warnings": ["women_any weighted country mean 2020: 37.07 vs WIPO 38.1 "
                                                        "(gap -1.03 pp, over 0.5 pp)", *DE_UNLISTED]}}
    assert run.main(["--dry-run", "--out", str(tmp_path)]) == 0  # gender lines never block
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("gender: ")]
    assert lines == [
        "gender: women_any weighted country mean vs WIPO World: 1 of 26 compared years over 0.5 pp (2020); "
        "max gap 1.03 pp",
        "gender: women_any weighted country mean 2020: 37.07 vs WIPO 38.1 (gap -1.03 pp, over 0.5 pp) (warning)",
        *(f"gender: {line} (warning)" for line in DE_UNLISTED),
    ]


def test_run_checks_gender_warns_on_publication_origin_missing_from_1040(checks_env):
    """I1: a 1010 origin the 1040 list lacks is counted uncovered in group coverage; warned, never blocking."""
    data, outputs = checks_env
    publications = collected()["pct_publications"]
    publications["FR"] = {year: 10000 for year in publications["CH"]}
    failures, summary = run_checks(data, outputs, FakeFetcher(data), pct_publications=publications)
    assert ("women_any FR: in the PCT publications origin list (1010), not in the women_any list (1040): counted "
            "uncovered in group coverage") in summary["gender"]["warnings"]
    assert not [line for line in failures if "women" in line]
