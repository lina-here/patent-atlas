"""Citable data versions: `site/data/releases.json`, newest first (spec v1 "Citable data versions").

run.py appends one entry when write.changed is true: {version, wipo_releases, wdi_last_updated (per WDI indicator,
from manifest wdi_denominators), pipeline_sha, changed}. Version = retrieval date `YYYY-MM-DD`, `.2`, `.3` for
later changed runs that day. A published entry never changes (append refuses a taken version); scripts/tag_data.py
tags `data-<version>` on the commit that introduced it; a tagged version stays taken after a revert drops its entry
(run.py passes the tags in). `changed` = sorted ids of what differs from the data on disk, never empty; `["all"]` when no releases.json exists (first version, fresh clone).
`python3 -m pipeline.run --bootstrap-version` writes the first entry for data already committed (no fetch), only when
their manifest names a commit of this repo. No git here: run.py gathers tags and checks commits.
"""
from __future__ import annotations

import datetime
import json
import re
from collections.abc import Callable, Iterable
from pathlib import Path

from pipeline import scale, write
from pipeline.series import SERIES
from pipeline.worlds import WORLD_SOURCES

RELEASES = Path("releases.json")
VERSION_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}(\.\d+)?")  # fullmatch; contract test reads it
TAG_PREFIX = "data-"  # git tag of a version: data-<version> (scripts/tag_data.py)
ALL = "all"
DIRTY_SUFFIX = "-dirty"  # run.pipeline_sha: pipeline/ had uncommitted changes
UNKNOWN_SHA = "unknown"  # run.pipeline_sha: not in a git checkout
LISTING_IDS = {write.ENTITIES: "entities", write.GROUPS: "groups"}
MANIFEST_IDS = {"releases": "wipo_release", "wdi_denominators": "wdi", "pipeline_sha": "pipeline"}
MANIFEST_MEASURES = "absent_rows"  # {measure id: count}: the differing measure ids
# entity/group/overview top-level keys built from one source: that id, wherever the difference sits below
TOP_KEY_IDS = {
    "pct_monthly": "pct_monthly", "pct_monthly_source": "pct_monthly",
    "method": "method", "coverage_rule": "method", "top_n": "method", "grower_min": "method",
    **{key: "origin_apps" for key in ("top_origins", "top_grower", "fastest_growers", "size_growth", "rank_race",
                                      "top_year")},
}
# keys naming an id by another word: world totals -> their series; overview gender.by_field
KEY_ALIASES = {**{world: series_id for world, (series_id, _) in WORLD_SOURCES.items()},
               "by_field": "women_any_by_field"}
KNOWN_IDS = frozenset({*(series.id for series in SERIES), *scale.RATIO_IDS, *write.GENDER_IDS, "pct_publications"})
_MISSING = object()


def load(root: Path) -> list[dict]:
    """releases.json under root, [] when absent. ValueError when it is not a list of entries with unique valid
    versions (never appended to: a published version must not be rewritten by a guess)."""
    path = root / RELEASES
    if not path.is_file():
        return []
    content = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(content, list) or not all(isinstance(item, dict) for item in content):
        raise ValueError(f"{path}: not a list of version entries")
    versions = [item.get("version") for item in content]
    bad = [version for version in versions if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version)]
    if bad:
        raise ValueError(f"{path}: invalid versions {bad}")
    if len(set(versions)) != len(versions):
        raise ValueError(f"{path}: duplicate versions")
    return content


def _diff_paths(old: object, new: object, path: tuple[str, ...] = ()):
    """Key paths where old and new differ; recurses while each side is a dict or missing (a list = one leaf)."""
    if old == new:
        return
    both_mappings = all(isinstance(side, dict) or side is _MISSING for side in (old, new))
    if not both_mappings:
        yield path
        return
    old_map = old if isinstance(old, dict) else {}
    new_map = new if isinstance(new, dict) else {}
    for key in sorted(set(old_map) | set(new_map)):
        yield from _diff_paths(old_map.get(key, _MISSING), new_map.get(key, _MISSING), (*path, key))


def _path_ids(path: tuple[str, ...]) -> set[str]:
    """Ids a data-file key path names: TOP_KEY_IDS for its top key, else every known id (aliases resolved) on it."""
    if path and path[0] in TOP_KEY_IDS:
        return {TOP_KEY_IDS[path[0]]}
    return {KEY_ALIASES.get(key, key) for key in path} & KNOWN_IDS


def _read(path: Path) -> object:
    """Parsed JSON, _MISSING when absent or unreadable as JSON (then all of the new side counts as changed)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _MISSING


def _file_ids(path: Path, old: object, new: object) -> set[str]:
    if path in LISTING_IDS:
        return {LISTING_IDS[path]}
    if path.parent == write.MAP_DIR:
        return {path.stem}
    found: set[str] = set()
    for key_path in _diff_paths(old, new):
        found |= _path_ids(key_path) or {path.stem}
    return found or {path.stem}  # same JSON, other text: write.changed counts it


def _manifest_ids(old: object, new: dict) -> set[str]:
    """Only the manifest keys write.changed compares; version, retrieved, checks, last_year never count."""
    old = old if isinstance(old, dict) else {}
    found = {name for key, name in MANIFEST_IDS.items() if old.get(key) != new.get(key)}
    if old.get(MANIFEST_MEASURES) != new.get(MANIFEST_MEASURES):
        measures = {key_path[0] for key_path in _diff_paths(old.get(MANIFEST_MEASURES, _MISSING),
                                                          new.get(MANIFEST_MEASURES, _MISSING)) if key_path}
        found |= measures or {write.MANIFEST.stem}
    return found


def changed_ids(old_root: Path, new: dict[Path, dict]) -> list[str]:
    """Sorted ids of what `new` changes against the data under old_root; ["all"] when old_root has no releases.json.
    Never empty when write.changed(new, old_root) is true. releases.json itself is ignored on both sides."""
    if not (old_root / RELEASES).is_file():
        return [ALL]
    found: set[str] = set()
    for path in sorted((set(new) | write._existing(old_root)) - {RELEASES}):
        old = _read(old_root / path)
        content = new.get(path, _MISSING)
        if path == write.MANIFEST:
            found |= _manifest_ids(old, content if isinstance(content, dict) else {})
        elif content is _MISSING or old is _MISSING or (old_root / path).read_text(
                encoding="utf-8") != write.dumps(content):
            found |= _file_ids(path, old, content)
    return sorted(found)


def next_version(old: list[dict], retrieved: datetime.date, also_taken: Iterable[str] = ()) -> str:
    """`YYYY-MM-DD` of the retrieval date; `.2`, `.3`... when that day's version is taken: in releases.json (`old`)
    or in `also_taken` (versions of existing data-* tags: a reverted entry's id is never issued again)."""
    taken = {item["version"] for item in old} | set(also_taken)
    version, number = retrieved.isoformat(), 2
    while version in taken:
        version, number = f"{retrieved.isoformat()}.{number}", number + 1
    return version


def entry(version: str, manifest: dict, changed: list[str]) -> dict:
    """The releases.json entry describing data whose manifest is `manifest`."""
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"data version {version!r} is not YYYY-MM-DD(.N)")
    if not changed:
        raise ValueError(f"data version {version}: empty changed list")
    return {"version": version, "wipo_releases": dict(manifest["releases"]),
            "wdi_last_updated": {indicator: block["last_updated"]
                                 for indicator, block in manifest["wdi_denominators"].items()},
            "pipeline_sha": manifest["pipeline_sha"], "changed": list(changed)}


def append(old: list[dict], new_entry: dict) -> list[dict]:
    """New list, newest first; refuses a version already published."""
    if any(item["version"] == new_entry["version"] for item in old):
        raise ValueError(f"data version {new_entry['version']} already published")
    return [new_entry, *old]


def bootstrap(root: Path, is_commit: Callable[[str], bool]) -> dict:
    """First version for data already committed under root (no fetch): entry from its manifest, changed ["all"],
    version = its retrieval date; manifest gains `version`, no data file changes. Refused when releases.json exists,
    or when the manifest's pipeline_sha is dirty, unknown or not a commit here (`is_commit`; e.g. a private-repo sha
    after go-public): a version must name code a reader can find."""
    if (root / RELEASES).exists():
        raise ValueError(f"{root / RELEASES} exists: bootstrap writes the first version only")
    manifest = json.loads((root / write.MANIFEST).read_text(encoding="utf-8"))
    sha = manifest["pipeline_sha"]
    if sha.endswith(DIRTY_SUFFIX) or sha == UNKNOWN_SHA or not is_commit(sha):
        raise ValueError(f"manifest names pipeline {sha}, not a commit of this repo: run a full refresh from committed "
                         f"code instead (README, Refresh the data)")
    version = next_version([], datetime.date.fromisoformat(manifest["retrieved"]))
    first = entry(version, manifest, [ALL])
    write.write_file(root, RELEASES, append([], first))
    write.write_file(root, write.MANIFEST, {**manifest, "version": version})
    return first
