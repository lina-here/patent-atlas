import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import pytest  # noqa: E402
import repo_guard  # noqa: E402

RAW = {"recordInfo": {}, "records": []}


def write_json(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return path


def test_flags_raw_shape(tmp_path):
    f = write_json(tmp_path / "raw.json", RAW)
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_fixture_marked_small_ok(tmp_path):
    f = write_json(
        tmp_path / "pipeline" / "tests" / "fixtures" / "ok.json",
        {**RAW, "_fixture": "hand-made"},
    )
    assert f.stat().st_size < 8 * 1024
    assert repo_guard.find_raw([f], root=tmp_path) == []


def test_fixture_unmarked_flagged(tmp_path):
    f = write_json(tmp_path / "pipeline" / "tests" / "fixtures" / "bad.json", RAW)
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_fixture_too_big_flagged(tmp_path):
    f = write_json(
        tmp_path / "pipeline" / "tests" / "fixtures" / "big.json",
        {"recordInfo": {}, "records": ["x" * 9000], "_fixture": "hand-made"},
    )
    assert f.stat().st_size > 8 * 1024
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_marked_outside_fixtures_flagged(tmp_path):
    f = write_json(tmp_path / "other" / "x.json", {**RAW, "_fixture": "hand-made"})
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_ignores_derived(tmp_path):
    f = write_json(tmp_path / "derived.json", {"series": "origin_apps", "values": {}})
    assert repo_guard.find_raw([f], root=tmp_path) == []


def test_ignores_non_json(tmp_path):
    binary = tmp_path / "blob.bin"
    binary.write_bytes(b"\x89PNG\x00\xff\xfe" * 10)
    ts = tmp_path / "app.ts"
    ts.write_text("export const x = { recordInfo: 1, records: 2 };\n")
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    missing = tmp_path / "gone.json"
    assert repo_guard.find_raw([binary, ts, broken, missing], root=tmp_path) == []


def test_raw_inside_top_level_list_flagged(tmp_path):
    f = tmp_path / "list.json"
    f.write_text(json.dumps([RAW]))
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_ignores_plain_top_level_lists(tmp_path):
    lists = [write_json(tmp_path / f"list{i}.json", data) for i, data in enumerate([
        [], [1, 2], [{"code": "CH"}, {"code": "US"}], [{"page": 1}, []], [{"recordInfo": {}}]])]
    assert repo_guard.find_raw(lists, root=tmp_path) == []


# World Bank v2 responses: [page metadata, rows]

def wdi_response(marked=False, rows=1):
    meta = {"page": 1, "pages": 1, "per_page": 20000, "total": rows, "lastupdated": "2026-10-08"}
    if marked:
        meta = {"_fixture": "hand-made", **meta}
    return [meta, [{"indicator": {"id": "SP.POP.TOTL", "value": "Population, total"}, "countryiso3code": "CHE",
                    "date": "2024", "value": 8960000}] * rows]


FIXTURES = Path("pipeline") / "tests" / "fixtures"


def test_flags_wdi_response(tmp_path):
    f = write_json(tmp_path / "pop.json", wdi_response())
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_wdi_fixture_marked_small_ok(tmp_path):
    f = write_json(tmp_path / FIXTURES / "wdi_ok.json", wdi_response(marked=True))
    assert f.stat().st_size <= 8 * 1024
    assert repo_guard.find_raw([f], root=tmp_path) == []


def test_wdi_fixture_unmarked_big_or_outside_flagged(tmp_path):
    unmarked = write_json(tmp_path / FIXTURES / "wdi_unmarked.json", wdi_response())
    big = write_json(tmp_path / FIXTURES / "wdi_big.json", wdi_response(marked=True, rows=100))
    outside = write_json(tmp_path / "data" / "wdi.json", wdi_response(marked=True))
    assert big.stat().st_size > 8 * 1024
    assert repo_guard.find_raw([unmarked, big, outside], root=tmp_path) == [unmarked, big, outside]


def test_flags_raw_ratio_table(tmp_path):
    table = {"recordInfo": {"indicator": "10 - Resident applications per million population (by origin)"},
             "columns": [{"code": "selectedOrigin"}, {"code": "2024"}],
             "records": [{"selectedOrigin": "Switzerland", "2024": "1235.0"}]}
    f = write_json(tmp_path / "ratio.json", table)
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_list_wrapped_raw_fixture_rule(tmp_path):
    ok = write_json(tmp_path / FIXTURES / "wrapped_ok.json", [{**RAW, "_fixture": "hand-made"}])
    unmarked = write_json(tmp_path / FIXTURES / "wrapped_unmarked.json", [RAW])
    assert repo_guard.find_raw([ok, unmarked], root=tmp_path) == [unmarked]


def test_ignores_derived_with_wdi_manifest_block(tmp_path):
    manifest = {"sources": [{"name": "World Bank WDI"}], "wdi_denominators": {
        "population": {"indicator": "SP.POP.TOTL", "name": "Population, total", "lastupdated": "2026-10-08",
                       "page": 1, "pages": 1, "per_page": 20000}}}
    f = write_json(tmp_path / "manifest.json", manifest)
    assert repo_guard.find_raw([f], root=tmp_path) == []


def test_real_fixtures_allowed():
    fixtures = sorted((repo_guard.REPO_ROOT / FIXTURES).glob("*.json"))
    assert repo_guard.REPO_ROOT / FIXTURES / "wdi_resd_small.json" in fixtures
    assert repo_guard.find_raw(fixtures) == []


def test_bom_before_brace_detected(tmp_path):
    f = tmp_path / "bom.json"
    f.write_bytes(b"\xef\xbb\xbf" + json.dumps(RAW).encode())
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_fixture_dir_anchored_to_repo_root(tmp_path):
    f = write_json(
        tmp_path / "x" / "pipeline" / "tests" / "fixtures" / "raw.json",
        {**RAW, "_fixture": "hand-made"},
    )
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


# --- CLI against a temp git repo ---

GUARD = Path(repo_guard.__file__)
RAW_TEXT = json.dumps(RAW)
CLEAN_TEXT = json.dumps({"series": "origin_apps", "values": {}})


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
         "-c", "core.hooksPath=/dev/null", *args],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout.strip()


def guard(repo: Path, *args: str):
    return subprocess.run(
        [sys.executable, str(GUARD), *args], cwd=repo, capture_output=True, text=True
    )


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "r"
    r.mkdir()
    git(r, "init", "-q")
    (r / "a.txt").write_text("a")
    git(r, "add", "a.txt")
    git(r, "commit", "-q", "-m", "base")
    return r


def test_cli_clean_exit_0(repo):
    (repo / "d.json").write_text(CLEAN_TEXT)
    git(repo, "add", "d.json")
    assert guard(repo, "--staged").returncode == 0
    assert guard(repo, "--all").returncode == 0
    assert guard(repo, "--range", "HEAD..HEAD").returncode == 0


def test_cli_staged_hit_exit_1(repo):
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    res = guard(repo, "--staged")
    assert res.returncode == 1
    assert "raw.json" in res.stderr


def test_cli_staged_reads_blob_not_working_tree(repo):
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    (repo / "raw.json").write_text(CLEAN_TEXT)
    assert guard(repo, "--staged").returncode == 1


def test_cli_staged_ignores_unstaged_raw(repo):
    (repo / "raw.json").write_text(RAW_TEXT)
    assert guard(repo, "--staged").returncode == 0


def test_cli_non_ascii_filename(repo):
    name = "donn\u00e9es-\u00e9 \u65e5\u672c.json"
    (repo / name).write_text(RAW_TEXT)
    git(repo, "add", name)
    res = guard(repo, "--staged")
    assert res.returncode == 1
    assert name in res.stderr


def test_cli_all_hit_exit_1(repo):
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    git(repo, "commit", "-q", "-m", "raw")
    assert guard(repo, "--all").returncode == 1


def test_cli_range_hit_exit_1(repo):
    base = git(repo, "rev-parse", "HEAD")
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    git(repo, "commit", "-q", "-m", "raw")
    assert guard(repo, "--range", f"{base}..HEAD").returncode == 1


def test_cli_range_catches_added_then_deleted(repo):
    base = git(repo, "rev-parse", "HEAD")
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    git(repo, "commit", "-q", "-m", "raw")
    git(repo, "rm", "-q", "raw.json")
    git(repo, "commit", "-q", "-m", "remove")
    assert guard(repo, "--all").returncode == 0
    res = guard(repo, "--range", f"{base}..HEAD")
    assert res.returncode == 1
    assert "raw.json" in res.stderr


def test_cli_range_invalid_exit_2_no_traceback(repo):
    res = guard(repo, "--range", "deadbeefdeadbeef..HEAD")
    assert res.returncode == 2
    assert "invalid or unreachable range" in res.stderr
    assert "Traceback" not in res.stderr


def test_cli_not_a_repo_exit_2(tmp_path):
    res = guard(tmp_path, "--all")
    assert res.returncode == 2
    assert "Traceback" not in res.stderr


def test_cli_range_catches_raw_added_only_in_merge(repo):
    base = git(repo, "rev-parse", "HEAD")
    default = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    git(repo, "checkout", "-q", "-b", "side")
    (repo / "side.txt").write_text("s")
    git(repo, "add", "side.txt")
    git(repo, "commit", "-q", "-m", "side")
    git(repo, "checkout", "-q", default)
    (repo / "main.txt").write_text("m")
    git(repo, "add", "main.txt")
    git(repo, "commit", "-q", "-m", "main")
    git(repo, "merge", "-q", "--no-ff", "--no-commit", "side")
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    git(repo, "commit", "-q", "-m", "merge with raw")
    res = guard(repo, "--range", f"{base}..HEAD")
    assert res.returncode == 1
    assert "raw.json" in res.stderr


def test_cli_single_sha_range_covers_all_ancestors(repo):
    # CI passes one sha (`--range $GITHUB_SHA`): rev-list <sha> = full history, so a new branch's first push is scanned
    (repo / "raw.json").write_text(RAW_TEXT)
    git(repo, "add", "raw.json")
    git(repo, "commit", "-q", "-m", "raw")
    git(repo, "rm", "-q", "raw.json")
    git(repo, "commit", "-q", "-m", "remove")
    (repo / "b.txt").write_text("b")
    git(repo, "add", "b.txt")
    git(repo, "commit", "-q", "-m", "later")
    head = git(repo, "rev-parse", "HEAD")
    assert guard(repo, "--all").returncode == 0
    res = guard(repo, "--range", head)
    assert res.returncode == 1
    assert "raw.json" in res.stderr


def test_cli_single_sha_range_clean_history_exit_0(repo):
    assert guard(repo, "--range", git(repo, "rev-parse", "HEAD")).returncode == 0


# --- UNSD M49 table (UN terms: no redistribution) ---

M49_HEADER = ["Global Code", "Global Name", "Region Code", "Region Name", "Sub-region Code", "Sub-region Name",
              "Intermediate Region Code", "Intermediate Region Name", "Country or Area", "M49 Code",
              "ISO-alpha2 Code", "ISO-alpha3 Code"]
M49_ROW = ["001", "World", "150", "Europe", "155", "Western Europe", "", "", "Switzerland", "756", "CH", "CHE"]


@pytest.mark.parametrize("delimiter", [",", ";", "\t"])
def test_flags_m49_csv(tmp_path, delimiter):
    f = tmp_path / "UNSD — Methodology.csv"
    f.write_text("\n".join(delimiter.join(row) for row in (M49_HEADER, M49_ROW)) + "\n", encoding="utf-8")
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_flags_m49_csv_with_bom_and_quotes(tmp_path):
    f = tmp_path / "m49.csv"
    f.write_bytes(b"\xef\xbb\xbf" + ";".join(f'"{cell}"' for cell in M49_HEADER).encode())
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


@pytest.mark.parametrize("cell", ["td", "th"])
def test_flags_m49_html_table(tmp_path, cell):
    head = "".join(f"<{cell}>{name}</{cell}>" for name in M49_HEADER)
    body = "".join(f"<td>{value}</td>" for value in M49_ROW)
    f = tmp_path / "overview.html"
    f.write_text(f"<html><table id='downloadTableEN'><thead><tr>\n  {head}\n</tr></thead>"
                 f"<tbody><tr>{body}</tr></tbody></table></html>")
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_flags_m49_even_in_fixture_dir(tmp_path):
    f = tmp_path / "pipeline" / "tests" / "fixtures" / "m49.csv"
    f.parent.mkdir(parents=True)
    f.write_text(",".join(M49_HEADER))
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_m49_header_words_outside_table_structure_ok(tmp_path):
    words = ", ".join(M49_HEADER)
    md = tmp_path / "note.md"
    md.write_text(f"Columns: {words}\n")
    script = tmp_path / "build_m49.py"
    script.write_text(f"HEADER = {M49_HEADER!r}\n")
    js = tmp_path / "x.json"
    js.write_text(json.dumps({"header": M49_HEADER}))
    csv_later_row = tmp_path / "later.csv"  # header cells only in a later row: not the table's header
    csv_later_row.write_text("a,b\n" + ",".join(M49_HEADER) + "\n")
    html_prose = tmp_path / "methods.html"
    html_prose.write_text(f"<p>{words}</p><table><tr><td>{words}</td></tr></table>")
    partial = tmp_path / "partial.csv"
    partial.write_text("Global Code,Region Code,Sub-region Name\n")
    assert repo_guard.find_raw([md, script, js, csv_later_row, html_prose, partial], root=tmp_path) == []


def test_cli_staged_m49_html_exit_1(repo):
    head = "".join(f"<td>{name}</td>" for name in M49_HEADER)
    (repo / "overview.html").write_text(f"<table><tr>{head}</tr></table>")
    git(repo, "add", "overview.html")
    res = guard(repo, "--staged")
    assert res.returncode == 1
    assert "overview.html" in res.stderr
    assert guard(repo, "--all").returncode == 1


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-be"])
def test_flags_m49_csv_utf16(tmp_path, encoding):
    f = tmp_path / "m49.csv"
    text = "\t".join(M49_HEADER) + "\n" + "\t".join(M49_ROW) + "\n"
    bom = b"\xfe\xff" if encoding == "utf-16-be" else b""  # "utf-16" writes its own BOM
    f.write_bytes(bom + text.encode(encoding))
    assert f.read_bytes()[:2] in (b"\xff\xfe", b"\xfe\xff")
    assert repo_guard.find_raw([f], root=tmp_path) == [f]


def test_flags_raw_women_by_field_table(tmp_path):
    # pmh 1041 shape (world-only, selectedClass rows): raw outside fixtures flagged like any WIPO table
    table = {"recordInfo": {"indicator": "14 - Share of applications with at least one women inventor by technology "
                                         "(yearly statistics)"},
             "columns": [{"code": "selectedClass"}, {"code": "2025"}],
             "records": [{"selectedClass": "Computer technology", "2025": "39.6", "2025_SeqOrder": 40.0}]}
    raw = write_json(tmp_path / "site" / "data" / "women.json", table)
    marked_outside = write_json(tmp_path / "women_marked.json", {**table, "_fixture": "hand-made"})
    assert repo_guard.find_raw([raw, marked_outside], root=tmp_path) == [raw, marked_outside]
    fixture = repo_guard.REPO_ROOT / FIXTURES / "women_by_field_small.json"
    assert repo_guard.find_raw([fixture]) == []
