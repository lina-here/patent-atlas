"""Fail unless every file under DIR parses as JSON: `python3 scripts/check_json.py DIR`.

Runs in the refresh publish job (stdlib only, no package code) on the artifact the build job handed over, before it is
committed: a truncated or non-JSON file named *.json must not reach main. json.load builds plain data and runs no code.
Exit 0 = all parse (and DIR holds at least one file), 1 = a failure or nothing to check.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def failures(directory: Path) -> tuple[int, list[str]]:
    """(files checked, one message per file that does not parse)."""
    checked, bad = 0, []
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        checked += 1
        try:
            with path.open(encoding="utf-8") as handle:
                json.load(handle)
        except (ValueError, OSError) as error:  # JSONDecodeError and UnicodeDecodeError are ValueErrors
            bad.append(f"{path.relative_to(directory)}: {error}")
    return checked, bad


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: check_json.py DIR", file=sys.stderr)
        return 2
    directory = Path(argv[0])
    if not directory.is_dir():
        print(f"{directory} is not a directory", file=sys.stderr)
        return 1
    checked, bad = failures(directory)
    for message in bad:
        print(f"not JSON: {message}", file=sys.stderr)
    if not checked:
        print("no files to check", file=sys.stderr)
        return 1
    print(f"{checked} files, {len(bad)} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
