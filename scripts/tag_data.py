"""Tag data versions: `python3 scripts/tag_data.py --remote <url or name> [--repo DIR]`.

For each version in site/data/releases.json at HEAD (pipeline/releases.py): tag `data-<version>` on the commit that
introduced it (oldest `git log -S` match of its `"version": "<id>"` line), then push data tags the remote lacks.
A tag is never moved, deleted or force-pushed: one on another commit, locally or on the remote, is reported (exit 1)
and left as is. So is a version whose entry at its tag (or introducing commit) differs from HEAD's: the id was
re-added with other content (a revert, then a re-run); a published version must never change. Exit 0 = tags in place
(or nothing to do), 1 = something needs a person. Runs on every refresh workflow run on main (retries a missed push);
after a local refresh run it with `--remote origin` (README).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
from pipeline.releases import TAG_PREFIX, VERSION_PATTERN  # noqa: E402  the contract's definitions, one place

RELEASES_PATH = "site/data/releases.json"


class GitError(Exception):
    pass


def git(repo: Path, *args: str) -> str:
    """stdout of a git command; GitError names the subcommand and git's message, never the arguments (the remote
    URL may carry a token)."""
    done = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if done.returncode != 0:
        raise GitError(f"git {args[0]} failed: {done.stderr.strip()}")
    return done.stdout.strip()


def version_line(version: str) -> str:
    """The entry's version line as pipeline/write.dumps writes it (json, indent 2); test_tag_data writes with dumps."""
    return f'"version": {json.dumps(version)}'


def head_entries(repo: Path) -> list[object] | None:
    """The entries of releases.json at HEAD, None when HEAD has no such file."""
    try:
        git(repo, "cat-file", "-e", f"HEAD:{RELEASES_PATH}")
    except GitError:
        return None
    return json.loads(git(repo, "show", f"HEAD:{RELEASES_PATH}"))


def entry_at(repo: Path, commit: str, version: str) -> dict | None:
    """The entry for version in releases.json at commit, None when that commit has no such file or entry."""
    try:
        entries = json.loads(git(repo, "show", f"{commit}:{RELEASES_PATH}"))
    except (GitError, ValueError):
        return None
    found = [item for item in entries if isinstance(item, dict) and item.get("version") == version] \
        if isinstance(entries, list) else []
    return found[0] if found else None


def introducing_commit(repo: Path, version: str) -> str | None:
    """Oldest commit whose diff of releases.json adds or removes the version line (the one adding it first)."""
    found = git(repo, "log", "-S", version_line(version), "--format=%H", "--reverse", "HEAD", "--", RELEASES_PATH)
    return found.splitlines()[0] if found else None


def local_tags(repo: Path) -> dict[str, str]:
    """{tag: commit} of local data tags (annotated ones peeled to their commit)."""
    lines = git(repo, "for-each-ref", "--format=%(refname:strip=2) %(objectname) %(*objectname)",
                f"refs/tags/{TAG_PREFIX}*").splitlines()
    return {parts[0]: parts[-1] for parts in (line.split() for line in lines)}


def remote_tags(repo: Path, remote: str) -> dict[str, str]:
    """{tag: commit} of the remote's data tags (`^{}` lines = annotated tags peeled)."""
    tags: dict[str, str] = {}
    for line in git(repo, "ls-remote", "--tags", "--", remote).splitlines():
        sha, ref = line.split("\t")
        name = ref.removeprefix("refs/tags/")
        peeled = name.endswith("^{}")
        name = name.removesuffix("^{}")
        if name.startswith(TAG_PREFIX) and (peeled or name not in tags):
            tags[name] = sha
    return tags


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 scripts/tag_data.py", description=__doc__.splitlines()[0])
    parser.add_argument("--remote", required=True, help="remote name or URL to push data tags to")
    parser.add_argument("--repo", type=Path, default=REPO_ROOT, help="repository (default: this one)")
    args = parser.parse_args(argv)

    problems: list[str] = []
    created: list[str] = []
    to_push: list[str] = []
    try:
        if git(args.repo, "rev-parse", "--is-shallow-repository") == "true":
            print("FAILED: shallow clone: its first commit seems to add every version; fetch full history",
                  file=sys.stderr)
            return 1
        entries = head_entries(args.repo)
        if entries is None:
            print(f"nothing to do: no {RELEASES_PATH} at HEAD")
            return 0
        at_head = {item.get("version"): item for item in reversed(entries) if isinstance(item, dict)}
        versions = [item.get("version") if isinstance(item, dict) else None for item in entries]
        tags = local_tags(args.repo)
        wanted: dict[str, str] = {}  # tag -> commit it is on locally
        seen: set[object] = set()
        for version in versions:
            if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
                problems.append(f"{RELEASES_PATH} has an entry with version {version!r}, not "
                                f"{VERSION_PATTERN.pattern}: not tagged")
                continue
            if version in seen:
                problems.append(f"{RELEASES_PATH} lists version {version} twice: tagged once")
                continue
            seen.add(version)
            tag, commit = f"{TAG_PREFIX}{version}", introducing_commit(args.repo, version)
            if commit is None:
                problems.append(f"{tag}: no commit adds {version_line(version)} to {RELEASES_PATH}: not tagged")
                continue
            on = tags.get(tag, commit)
            differs = entry_at(args.repo, on, version) != at_head[version]
            if tag in tags:
                if tags[tag] != commit:
                    problems.append(f"{tag} is on {tags[tag]}, version introduced by {commit}: tag left as is")
                elif differs:
                    problems.append(f"{tag}: entry {version} at {on} differs from HEAD's (id re-added with other "
                                    f"content, e.g. after a revert): tag left as is; a published version never changes")
                wanted[tag] = tags[tag]
                continue
            if differs:
                problems.append(f"{tag}: entry {version} at {commit} differs from HEAD's (id re-added with other "
                                f"content, e.g. after a revert): not tagged; a published version never changes")
                continue
            git(args.repo, "tag", tag, commit)
            created.append(tag)
            wanted[tag] = commit
        on_remote = remote_tags(args.repo, args.remote)
        for tag in sorted(set(wanted) & set(on_remote)):
            if on_remote[tag] != wanted[tag]:
                problems.append(f"{tag} is on {on_remote[tag]} on the remote, {wanted[tag]} here: not pushed")
        to_push = sorted(set(wanted) - set(on_remote))
        if to_push:
            git(args.repo, "push", "--", args.remote, *(f"refs/tags/{tag}:refs/tags/{tag}" for tag in to_push))
    except (GitError, ValueError) as error:
        for tag in created:  # already in the local repo: the next run pushes them
            print(f"tagged {tag}")
        print(f"FAILED: {error}", file=sys.stderr)
        return 1
    for tag in created:
        print(f"tagged {tag}")
    for tag in to_push:
        print(f"pushed {tag}")
    for line in problems:
        print(f"PROBLEM: {line}", file=sys.stderr)
    if not created and not to_push and not problems:
        print("nothing to do: every data version tagged and pushed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
