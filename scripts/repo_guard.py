#!/usr/bin/env python3
"""Repo guard: block raw source data from the repo.

- Raw WIPO API responses (JSON with top-level recordInfo + records, or a top-level list holding such an object)
  and raw World Bank v2 responses (top-level list of two: page metadata with WDI_PAGE_KEYS, rows). Allowed only
  as hand-made fixtures: path starts with pipeline/tests/fixtures/ (relative to repo root), "_fixture":
  "hand-made" at top level (object) or in item 0 (list), size <= FIXTURE_MAX_BYTES.
- The UNSD M49 table (UN terms: no redistribution; never allowed): a .csv/.tsv whose first row, or a .html/.htm
  row whose th/td cells, hold all M49_HEADER_CELLS. Structure only, so docs and code naming the columns pass.
  UTF-8 or UTF-16 (by BOM). The binary .xlsx export is out of scope (zip; not parsed).
Content-based. Git modes read blobs (index / commits), never the working tree.
Exit: 0 clean, 1 raw data found, 2 git error (bad range, not a repo).
"""
import argparse
import csv
import json
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

RAW_KEYS = {"recordInfo", "records"}
WDI_PAGE_KEYS = {"page", "pages", "per_page"}
FIXTURE_DIR = "pipeline/tests/fixtures/"
FIXTURE_MARK = "hand-made"
FIXTURE_MAX_BYTES = 8 * 1024
UTF8_BOM = b"\xef\xbb\xbf"
UTF16_BOMS = (b"\xff\xfe", b"\xfe\xff")
REPO_ROOT = Path(__file__).resolve().parents[1]
M49_HEADER_CELLS = {"global code", "sub-region name", "iso-alpha2 code"}  # compared lower-case, spaces collapsed
M49_CSV_SUFFIXES = {".csv", ".tsv"}
M49_HTML_SUFFIXES = {".html", ".htm"}
CSV_DELIMITERS = (",", ";", "\t")


class GitError(Exception):
    pass


def _raw_mark_holder(data: object) -> dict | None:
    """The object whose "_fixture" mark decides, if data is a raw response: the WIPO object itself, item 0 of a
    list (World Bank v2 shape, or a list holding a WIPO object); None = not a raw response."""
    if isinstance(data, dict):
        return data if RAW_KEYS <= data.keys() else None
    if not isinstance(data, list) or not data:
        return None
    world_bank = len(data) == 2 and isinstance(data[0], dict) and WDI_PAGE_KEYS <= data[0].keys()
    wrapped_wipo = any(isinstance(item, dict) and RAW_KEYS <= item.keys() for item in data)
    if not (world_bank or wrapped_wipo):
        return None
    return data[0] if isinstance(data[0], dict) else {}


def is_raw(relpath: str, raw: bytes) -> bool:
    """True if raw bytes (file at repo-relative posix relpath) are a forbidden raw response."""
    body = raw[len(UTF8_BOM):] if raw.startswith(UTF8_BOM) else raw
    if body.lstrip()[:1] not in (b"{", b"["):
        return False
    try:
        data = json.loads(body.decode("utf-8"))
    except ValueError:
        return False
    holder = _raw_mark_holder(data)
    if holder is None:
        return False
    allowed = (
        PurePosixPath(relpath).as_posix().startswith(FIXTURE_DIR)
        and holder.get("_fixture") == FIXTURE_MARK
        and len(raw) <= FIXTURE_MAX_BYTES
    )
    return not allowed


def _cell(text: str) -> str:
    return " ".join(text.split()).lower()


class _RowCells(HTMLParser):
    """Collects the text of th/td cells per tr."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            self._close_cell()
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th", "tr"):
            self._close_cell()

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def _close_cell(self) -> None:
        if self._cell is not None and self.rows:
            self.rows[-1].append(_cell("".join(self._cell)))
        self._cell = None


def _decode_text(raw: bytes) -> str:
    """Text of a CSV/HTML file: UTF-16 by its BOM (Excel "Unicode text" exports), else UTF-8 (BOM dropped)."""
    if raw.startswith(UTF16_BOMS):
        return raw.decode("utf-16", "replace")
    body = raw[len(UTF8_BOM):] if raw.startswith(UTF8_BOM) else raw
    return body.decode("utf-8", "replace")


def is_m49_table(relpath: str, raw: bytes) -> bool:
    """True if raw bytes are the UNSD M49 table as CSV (header = first row) or HTML (a row's cells)."""
    suffix = PurePosixPath(relpath).suffix.lower()
    if suffix not in M49_CSV_SUFFIXES | M49_HTML_SUFFIXES:
        return False
    text = _decode_text(raw)
    if "iso-alpha2" not in text.lower():
        return False
    if suffix in M49_CSV_SUFFIXES:
        first = next((line for line in text.splitlines() if line.strip()), "")
        return any(M49_HEADER_CELLS <= {_cell(c) for c in next(csv.reader([first], delimiter=d), [])}
                   for d in CSV_DELIMITERS)
    parser = _RowCells()
    parser.feed(text)
    parser.close()
    return any(M49_HEADER_CELLS <= set(row) for row in parser.rows)


def is_forbidden(relpath: str, raw: bytes) -> bool:
    return is_raw(relpath, raw) or is_m49_table(relpath, raw)


def find_raw(paths: list[Path], root: Path = REPO_ROOT) -> list[Path]:
    """Working-tree check of files; paths outside root count as non-fixture."""
    flagged = []
    for path in paths:
        try:
            if not path.is_file():
                continue
            raw = path.read_bytes()
        except OSError:
            continue
        try:
            relpath = path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            relpath = path.name
        if is_forbidden(relpath, raw):
            flagged.append(path)
    return flagged


def _git(root: Path, *args: str) -> bytes:
    proc = subprocess.run(["git", *args], cwd=root, capture_output=True)
    if proc.returncode != 0:
        raise GitError(proc.stderr.decode("utf-8", "replace").strip() or f"git {args[0]} failed")
    return proc.stdout


def _names(out: bytes) -> list[str]:
    return [n.decode("utf-8", "surrogateescape") for n in out.split(b"\0") if n]


def _blob(root: Path, spec: str) -> bytes | None:
    try:
        return _git(root, "cat-file", "blob", spec)
    except GitError:  # gitlink, deleted, not a blob
        return None


def _scan(root: Path, items: list[tuple[str, str]]) -> list[str]:
    """items: (blob spec, relpath). Returns labels of raw hits."""
    hits = []
    for spec, relpath in items:
        raw = _blob(root, spec)
        if raw is not None and is_forbidden(relpath, raw):
            hits.append(f"{relpath} ({spec.split(':', 1)[0] or 'index'})")
    return hits


def scan_staged(root: Path) -> list[str]:
    names = _names(_git(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"))
    return _scan(root, [(f":{n}", n) for n in names])


def scan_all(root: Path) -> list[str]:
    return _scan(root, [(f":{n}", n) for n in _names(_git(root, "ls-files", "-z"))])


def scan_range(root: Path, rev_range: str) -> list[str]:
    try:
        shas = _git(root, "rev-list", rev_range).decode().split()
    except GitError as err:
        raise GitError(f"invalid or unreachable range {rev_range!r}: {err}") from err
    items = []
    for sha in shas:
        out = _git(root, "diff-tree", "-r", "-m", "--root", "--no-commit-id",
                   "--name-only", "-z", "--diff-filter=AM", sha)  # -m: merge commits too
        items += [(f"{sha}:{n}", n) for n in dict.fromkeys(_names(out))]
    return _scan(root, items)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--range", metavar="A..B|SHA",
                      help="rev-list range; a single SHA = it and all its ancestors")
    mode.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)

    try:
        root = Path(_git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
        if args.staged:
            hits = scan_staged(root)
        elif args.range:
            hits = scan_range(root, args.range)
        else:
            hits = scan_all(root)
    except (GitError, OSError) as err:
        print(f"repo_guard: {err}", file=sys.stderr)
        return 2

    if hits:
        print("repo_guard: raw source data (WIPO / World Bank API response / UNSD M49 table) must not be committed:",
              file=sys.stderr)
        for hit in hits:
            print("  " + hit.encode("utf-8", "backslashreplace").decode(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
