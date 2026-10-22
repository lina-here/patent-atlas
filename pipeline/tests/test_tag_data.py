"""scripts/tag_data.py on throwaway git repos: tags data-<version> on the commit that introduced it, pushes missing
tags to the given remote, never moves or deletes a tag."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import tag_data  # noqa: E402

from pipeline import releases, write  # noqa: E402

RELEASES_PATH = Path("site/data") / releases.RELEASES


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false",
                           "-c", "core.hooksPath=/dev/null", *args], cwd=root, check=True, capture_output=True,
                          text=True).stdout.strip()


def entry(version, wdi_date="2026-10-08"):
    return {"version": version, "wipo_releases": {"ips": "Last updated: May 2026"},
            "wdi_last_updated": {"population": wdi_date}, "pipeline_sha": "abc123", "changed": ["all"]}


def commit_releases(repo, entries, message):
    write.write_file(repo / "site" / "data", releases.RELEASES, entries)
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def tags(root):
    """{tag: commit} of data-* tags."""
    lines = git(root, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags/data-*").splitlines()
    return dict(line.split() for line in lines)


@pytest.fixture
def repos(tmp_path):
    """(working repo, bare remote): v1 committed, an unrelated commit, then v1.2 (same day) on top."""
    remote, repo = tmp_path / "remote.git", tmp_path / "repo"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "README.md").write_text("x\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "code")
    # the older entry names 2026-10-21 as a WDI vintage: its commit must not count as introducing version 2026-10-21
    shas = {"older": commit_releases(repo, [entry("2026-10-01", wdi_date="2026-10-21")], "data: older")}
    shas["first"] = commit_releases(repo, [entry("2026-10-21"), entry("2026-10-01", wdi_date="2026-10-21")],
                                    "data: first")
    (repo / "README.md").write_text("y\n", encoding="utf-8")
    git(repo, "commit", "-q", "-am", "docs")
    shas["second"] = commit_releases(
        repo, [entry("2026-10-21.2"), entry("2026-10-21"), entry("2026-10-01", wdi_date="2026-10-21")], "data: second")
    return repo, remote, shas


def run_tag(repo, remote):
    return tag_data.main(["--repo", str(repo), "--remote", str(remote)])


EXPECTED = {"data-2026-10-01": "older", "data-2026-10-21": "first", "data-2026-10-21.2": "second"}


def test_creates_tags_on_introducing_commits_and_pushes(repos):
    repo, remote, shas = repos
    assert run_tag(repo, remote) == 0
    expected = {tag: shas[name] for tag, name in EXPECTED.items()}
    assert tags(repo) == expected
    assert tags(remote) == expected  # pushed to the remote given by --remote


def test_second_run_has_nothing_to_do(repos, capsys):
    repo, remote, _ = repos
    assert run_tag(repo, remote) == 0
    before = tags(remote)
    capsys.readouterr()
    assert run_tag(repo, remote) == 0
    assert tags(remote) == before
    assert "nothing to do" in capsys.readouterr().out


def test_pushes_a_local_tag_the_remote_lacks(repos):
    """A missed push (local refresh, failed push) is retried by the next run."""
    repo, remote, shas = repos
    git(repo, "tag", "data-2026-10-21", shas["first"])
    assert run_tag(repo, remote) == 0
    assert tags(remote)["data-2026-10-21"] == shas["first"]


def test_never_moves_an_existing_tag(repos, capsys):
    repo, remote, shas = repos
    git(repo, "tag", "data-2026-10-21", shas["older"])  # wrong commit: reported, never moved
    assert run_tag(repo, remote) == 1
    assert tags(repo)["data-2026-10-21"] == shas["older"]
    assert "data-2026-10-21" in capsys.readouterr().err
    assert tags(remote)["data-2026-10-21.2"] == shas["second"]  # the other tags still made and pushed


def test_never_overwrites_a_remote_tag(repos, tmp_path, capsys):
    repo, remote, shas = repos
    git(repo, "tag", "data-2026-10-21", shas["older"])
    git(repo, "push", "-q", str(remote), "refs/tags/data-2026-10-21")  # remote holds a tag on another commit
    git(repo, "tag", "-d", "data-2026-10-21")
    assert run_tag(repo, remote) == 1
    assert tags(remote)["data-2026-10-21"] == shas["older"]
    assert tags(repo)["data-2026-10-21"] == shas["first"]  # made locally, not forced onto the remote
    assert "data-2026-10-21" in capsys.readouterr().err


def test_no_releases_file_at_head(tmp_path, capsys):
    remote, repo = tmp_path / "remote.git", tmp_path / "repo"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "README.md").write_text("x\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "code")
    assert run_tag(repo, remote) == 0
    assert tags(repo) == {} and tags(remote) == {}
    assert "nothing to do" in capsys.readouterr().out


def test_version_never_introduced_fails(repos, capsys):
    """A version no commit adds in the dumps format (hand-edited file): error, no guess; the others still tagged."""
    repo, remote, shas = repos
    path = repo / RELEASES_PATH
    content = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps([entry("2026-10-22"), *content], separators=(",", ":")),
                    encoding="utf-8")  # compact: not the dumps format
    git(repo, "commit", "-q", "-am", "data: hand-edited")
    assert run_tag(repo, remote) == 1
    assert "data-2026-10-22" not in tags(repo)
    assert "2026-10-22" in capsys.readouterr().err
    assert tags(remote)["data-2026-10-21.2"] == shas["second"]


def test_shallow_clone_refused(repos, tmp_path, capsys):
    """A shallow clone's first commit seems to add every version: refuse rather than tag the wrong commit."""
    repo, remote, _ = repos
    shallow = tmp_path / "shallow"
    git(tmp_path, "clone", "-q", "--depth", "1", f"file://{repo}", str(shallow))
    assert run_tag(shallow, remote) == 1
    assert tags(shallow) == {} and tags(remote) == {}
    assert "shallow" in capsys.readouterr().err


def test_invalid_version_reported_not_tagged(repos, capsys):
    """A version outside the contract pattern (hand edit) is never tagged; the valid ones still are."""
    repo, remote, shas = repos
    commit_releases(repo, [entry("foo"), entry("2026-10-21.2"), entry("2026-10-21"),
                           entry("2026-10-01", wdi_date="2026-10-21")], "data: bad version")
    assert run_tag(repo, remote) == 1
    assert "data-foo" not in tags(repo) and "data-foo" not in tags(remote)
    err = capsys.readouterr().err
    assert "PROBLEM" in err and "foo" in err
    assert tags(remote)["data-2026-10-21"] == shas["first"]


def test_version_pattern_is_the_contract_constant():
    assert tag_data.VERSION_PATTERN is releases.VERSION_PATTERN


def test_malformed_entries_reported_not_crashing(repos, capsys):
    """A non-object entry or a duplicated version: PROBLEM and exit 1, no traceback, no second `git tag`."""
    repo, remote, shas = repos
    commit_releases(repo, ["junk", entry("2026-10-21.2"), entry("2026-10-21.2"), entry("2026-10-21"),
                           entry("2026-10-01", wdi_date="2026-10-21")], "data: malformed")
    assert run_tag(repo, remote) == 1
    err = capsys.readouterr().err
    assert "PROBLEM" in err and "FAILED" not in err
    assert tags(remote)["data-2026-10-21.2"] == shas["second"]


def test_remote_argument_is_not_read_as_an_option(repos, capsys):
    """`--remote=--tags` is a (bad) remote name: git must get it after `--`. Without `--`, ls-remote would read it as
    an option and list origin's tags instead of failing."""
    repo, remote, _ = repos
    git(repo, "remote", "add", "origin", str(remote))
    assert tag_data.main(["--repo", str(repo), "--remote=--tags"]) == 1
    assert "git ls-remote failed" in capsys.readouterr().err
    assert tags(remote) == {}


def test_oldest_introducing_commit_wins_when_a_line_returns(tmp_path, capsys):
    """Version line added, removed, added again: `git log -S` matches all three; the tag goes on the first."""
    remote, repo = tmp_path / "remote.git", tmp_path / "repo"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    repo.mkdir()
    git(repo, "init", "-q")
    first = commit_releases(repo, [entry("2026-10-21")], "data: add")
    commit_releases(repo, [entry("2026-10-01")], "data: swap out")
    readded = commit_releases(repo, [entry("2026-10-21")], "data: add back")
    assert first != readded
    assert run_tag(repo, remote) == 0
    assert tags(repo) == {"data-2026-10-21": first}
    assert tags(remote) == {"data-2026-10-21": first}


def test_failed_push_still_lists_the_tags_created(repos, tmp_path, capsys):
    repo, _, _ = repos
    assert run_tag(repo, tmp_path / "no-such-remote.git") == 1
    captured = capsys.readouterr()
    assert "FAILED" in captured.err
    for tag in EXPECTED:
        assert f"tagged {tag}" in captured.out


def revert_and_readd(repo, version, wdi_date):
    """Version committed (A), reverted out (R), re-added by a later run with other content (B, e.g. a new WDI
    vintage): `git log -S` matches A, R and B."""
    first = commit_releases(repo, [entry(version)], "data: add")
    commit_releases(repo, [], "Revert data: add")
    commit_releases(repo, [entry(version, wdi_date=wdi_date)], "data: rerun")
    return first


@pytest.fixture
def empty_repos(tmp_path):
    remote, repo = tmp_path / "remote.git", tmp_path / "repo"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    repo.mkdir()
    git(repo, "init", "-q")
    return repo, remote


def test_tagged_version_readded_with_other_content_fails(empty_repos, capsys):
    """Tag made on A, then revert + re-run reissue the id for B: exit 1, PROBLEM, the tag stays on A."""
    repo, remote = empty_repos
    first = commit_releases(repo, [entry("2026-11-03")], "data: add")
    assert run_tag(repo, remote) == 0
    commit_releases(repo, [], "Revert data: add")
    commit_releases(repo, [entry("2026-11-03", wdi_date="2026-11-01")], "data: rerun")
    capsys.readouterr()
    assert run_tag(repo, remote) == 1
    assert tags(repo) == {"data-2026-11-03": first} and tags(remote) == {"data-2026-11-03": first}
    err = capsys.readouterr().err
    assert "PROBLEM: data-2026-11-03" in err and "differs from HEAD" in err and "tag left as is" in err


def test_untagged_version_readded_with_other_content_is_not_tagged(empty_repos, capsys):
    """Same revert before any tag: the oldest -S match (A) holds other content than HEAD, so no tag is made."""
    repo, remote = empty_repos
    revert_and_readd(repo, "2026-11-03", wdi_date="2026-11-01")
    assert run_tag(repo, remote) == 1
    assert tags(repo) == {} and tags(remote) == {}
    err = capsys.readouterr().err
    assert "PROBLEM: data-2026-11-03" in err and "differs from HEAD" in err and "not tagged" in err
