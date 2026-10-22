#!/usr/bin/env python3
"""Build pipeline/m49.json (our country -> M49 group mapping) from a saved copy of the UNSD M49 page.

Run by hand: `python3 -I scripts/build_m49.py <overview.html> --retrieved YYYY-MM-DD`; again when
`site/data/entities.json` gains a country (test_m49 fails until then).
Source: table `#downloadTableEN` of SOURCE_URL (the page's CSV/Excel buttons export that table client-side).
UN terms (personal non-commercial use, no redistribution): keep the page in a temp dir, never in the repo
(repo guard flags it). Output = mapping only, for `entities.json` countries only (map polygons without a WIPO
entity need no group): ISO2 -> M49 numeric, region id, continent; labels of the regions used and of the
continents. No names, ISO3 or LDC/LLDC/SIDS flags. Rules below are checked on every row of the table.

Rules (spec v0.2 "Groupings"; data check 2026-10-20 §4):
- Continent = M49 region; Americas split by sub-region: 021 Northern America, 419 Latin America and the Caribbean.
- Region = M49 sub-region; intermediate region only inside 419 and 202 (Sub-Saharan Africa), where every row must
  have one. Elsewhere intermediate regions are ignored (Channel Islands 830 -> 154 Northern Europe).
- Row with no region (Antarctica): region and continent null. Row with no ISO2 (Sark): skipped.
- Entity country not in M49 (TW today has no WIPO entity) -> error: a grouping decision for Lina.
Standalone (no pipeline import) so it runs under `python3 -I`.
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from html.parser import HTMLParser
from pathlib import Path

SOURCE_NAME = "UN Statistics Division: Standard country or area codes for statistical use (M49)"
SOURCE_URL = "https://unstats.un.org/unsd/methodology/m49/overview/"
TABLE_ID = "downloadTableEN"
REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "pipeline" / "m49.json"
ENTITIES_PATH = REPO_ROOT / "site" / "data" / "entities.json"

AMERICAS = "019"
# M49 region -> continent slug; Americas resolved by sub-region.
CONTINENT_OF_REGION = {"002": "africa", "142": "asia", "150": "europe", "009": "oceania"}
CONTINENT_OF_AMERICAS_SUBREGION = {"021": "northern-america", "419": "latin-america-caribbean"}
CONTINENT_ORDER = ["africa", "northern-america", "latin-america-caribbean", "asia", "europe", "oceania"]
SUBREGIONS_SPLIT_BY_INTERMEDIATE = {"419", "202"}

REGION_CODE = "Region Code"
REGION_NAME = "Region Name"
SUBREGION_CODE = "Sub-region Code"
SUBREGION_NAME = "Sub-region Name"
INTERMEDIATE_CODE = "Intermediate Region Code"
INTERMEDIATE_NAME = "Intermediate Region Name"
M49_CODE = "M49 Code"
ISO2 = "ISO-alpha2 Code"
REQUIRED_COLUMNS = [REGION_CODE, REGION_NAME, SUBREGION_CODE, SUBREGION_NAME, INTERMEDIATE_CODE,
                    INTERMEDIATE_NAME, M49_CODE, ISO2]


class _TableRows(HTMLParser):
    """Text of each td/th per tr inside the table with id TABLE_ID (comments skipped by the parser)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found = False
        self.rows: list[list[str]] = []
        self._depth = 0  # table nesting inside the target table
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            if self._depth:
                self._depth += 1
            elif not self.found and (dict(attrs).get("id") or "").strip() == TABLE_ID:  # first one only
                self.found = True
                self._depth = 1
        elif not self._depth:
            return
        elif tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if not self._depth:
            return
        if tag == "table":
            self._depth -= 1
        elif tag in ("td", "th") and self._cell is not None:
            self.rows[-1].append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def parse_table(html: str) -> list[dict[str, str]]:
    """Rows of the English M49 table as {column header: cell text}."""
    parser = _TableRows()
    parser.feed(html)
    parser.close()
    if not parser.found or not parser.rows:
        raise ValueError(f"no table #{TABLE_ID} in the page")
    header, *body = parser.rows
    missing = [name for name in REQUIRED_COLUMNS if name not in header]
    if missing:
        raise ValueError(f"M49 table: columns missing: {missing}")
    rows = []
    for cells in body:
        if len(cells) < len(header):
            raise ValueError(f"M49 table: short row {cells}")
        rows.append(dict(zip(header, cells)))
    return rows


def entity_countries(entities: list[dict]) -> set[str]:
    return {item["code"] for item in entities if item["kind"] == "country"}


def build_mapping(rows: list[dict[str, str]], retrieved: str, wanted: set[str]) -> dict:
    """Mapping for the `wanted` country codes; every row of the table is checked against the rules."""
    countries: dict[str, dict] = {}
    regions: dict[str, dict] = {}
    continent_labels: dict[str, str] = {}
    for row in rows:
        code = row[ISO2]
        if not code:
            continue
        if code in countries:
            raise ValueError(f"M49 table: {code} twice")
        region, subregion = row[REGION_CODE], row[SUBREGION_CODE]
        if not region:
            countries[code] = {"numeric": row[M49_CODE], "region": None, "continent": None}
            continue
        if region == AMERICAS:
            continent = CONTINENT_OF_AMERICAS_SUBREGION.get(subregion)
            continent_label = row[SUBREGION_NAME]
        else:
            continent = CONTINENT_OF_REGION.get(region)
            continent_label = row[REGION_NAME]
        if continent is None:
            raise ValueError(f"M49 table: {code}: region {region} / sub-region {subregion} has no continent")
        if subregion in SUBREGIONS_SPLIT_BY_INTERMEDIATE:
            if not row[INTERMEDIATE_CODE]:
                raise ValueError(f"M49 table: {code} in {subregion} has no intermediate region")
            group, label = row[INTERMEDIATE_CODE], row[INTERMEDIATE_NAME]
        else:
            group, label = subregion, row[SUBREGION_NAME]
        if not group or not label:
            raise ValueError(f"M49 table: {code}: no sub-region")
        for table, key, value in ((regions, group, {"label": label, "continent": continent}),
                                  (continent_labels, continent, continent_label)):
            if table.setdefault(key, value) != value:
                raise ValueError(f"M49 table: {code}: {key} inconsistent ({table[key]} vs {value})")
        countries[code] = {"numeric": row[M49_CODE], "region": group, "continent": continent}
    missing = sorted(wanted - set(countries))
    if missing:
        raise ValueError(f"entity countries not in M49: {missing} (grouping decision needed)")
    countries = {code: countries[code] for code in sorted(wanted)}
    used = {entry["region"] for entry in countries.values()}
    return {
        "sources": [{
            "name": SOURCE_NAME, "url": SOURCE_URL, "table": f"#{TABLE_ID}", "retrieved": retrieved,
            "use": "mapping only (ISO2 -> M49 numeric, region, continent; group labels); UNSD table not copied",
        }],
        "continents": {slug: {"label": continent_labels[slug]} for slug in CONTINENT_ORDER
                       if slug in continent_labels},
        "regions": {key: value for key, value in sorted(regions.items()) if key in used},
        "countries": countries,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("page", type=Path, help="saved copy of the M49 overview page (temp dir)")
    parser.add_argument("--retrieved", required=True, help="date the page was saved, YYYY-MM-DD")
    parser.add_argument("--entities", type=Path, default=ENTITIES_PATH)
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    args = parser.parse_args(argv)
    retrieved = datetime.date.fromisoformat(args.retrieved).isoformat()
    wanted = entity_countries(json.loads(args.entities.read_text("utf-8")))
    mapping = build_mapping(parse_table(args.page.read_text("utf-8")), retrieved, wanted)
    if list(mapping["continents"]) != CONTINENT_ORDER:
        raise ValueError(f"M49 table: continents found {list(mapping['continents'])}, expected {CONTINENT_ORDER}")
    args.out.write_text(json.dumps(mapping, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{args.out}: {len(mapping['countries'])} countries, {len(mapping['regions'])} regions", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
