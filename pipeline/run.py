"""Refresh site data: `python3 -m pipeline.run [--out DIR] [--dry-run] [--accept-regression] [--bootstrap-version]`.

collect (WIPO: counts, PCT months, ratios, PCT publications, women-inventor shares) -> WDI denominators (ratios) ->
build outputs -> cross-checks (crosscheck.py) -> regression vs committed data (regress.py) -> write only when data
changed, as a new data version (releases.py; refused for a dirty or unknown pipeline). Exit 0 = written, unchanged, or dry
run passed; 2 = blocking failure (fetch, schema, check, regression, dirty pipeline): nothing written, last good data
kept. --dry-run runs every check and prints the results, writes nothing. --bootstrap-version: no fetch, first data
version for the data already in --out (refused unless their manifest names a commit of this repo).
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

from pipeline import crosscheck, gender, groups, m49, regress, releases as versions, scale, wdi, write
from pipeline.collect import SeriesData, collect, releases
from pipeline.crosscheck import CheckError, Fetch, Fetcher
from pipeline.entities import classify
from pipeline.parse import SchemaError
from pipeline.series import GENDER_WORLD_CODE, RATIO_FROM, TOTAL_ROW_CODES
from pipeline.wipo_client import WipoClient, WipoError

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "site" / "data"
SYSTEM_CA_BUNDLE = Path("/etc/ssl/cert.pem")
VINTAGE_PRINT_MAX = 5  # largest vintage factors per ratio on the dry-run line (manifest lists all)
# also the override path of the scheduled refresh, which has no input (README "Refresh the data")
ACCEPT_REGRESSION_HELP = (
    "accept blocking regression lines (a series' last year moved back, an entity or group no longer published): "
    "they go to manifest checks.regression.accepted and the run goes on. The scheduled refresh "
    "(refresh-data.yml) has no override: a blocked refresh fails its job; to accept, run "
    "`python3 -m pipeline.run --accept-regression` locally, run the gates, commit site/data by pathspec with the "
    "accepted lines in the message")


def use_system_ca_bundle() -> None:
    """python.org macOS Python ships without CA certificates: use the system bundle unless
    SSL_CERT_FILE is set. Elsewhere (CI) the default context already verifies."""
    if "SSL_CERT_FILE" in os.environ or not SYSTEM_CA_BUNDLE.exists():
        return
    context = ssl.create_default_context(cafile=str(SYSTEM_CA_BUNDLE))
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=context)))


def pipeline_sha(root: Path = REPO_ROOT) -> str:
    """Version of the code writing the data: last commit that changed pipeline/ (not HEAD: data and site
    commits move HEAD, and write.changed counts a new sha as a change), "-dirty" when pipeline/ has
    uncommitted or untracked files; "unknown" outside git."""
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()

    try:
        sha = git("log", "-1", "--format=%H", "--", "pipeline")
        dirty = git("status", "--porcelain", "--", "pipeline")
    except (OSError, subprocess.CalledProcessError):
        return versions.UNKNOWN_SHA
    if not sha:
        return versions.UNKNOWN_SHA
    return f"{sha}{versions.DIRTY_SUFFIX}" if dirty else sha


def data_tag_versions(root: Path = REPO_ROOT) -> list[str]:
    """Versions of local `data-<version>` tags: taken even when a revert dropped them from releases.json. [] outside
    git (pipeline_sha is then "unknown" and the run is refused anyway)."""
    try:
        listed = subprocess.run(["git", "tag", "--list", f"{versions.TAG_PREFIX}*"], cwd=root, capture_output=True,
                                text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    return [tag.removeprefix(versions.TAG_PREFIX) for tag in listed.split()]


def is_commit(sha: str, root: Path = REPO_ROOT) -> bool:
    """sha names a commit of this repo (bootstrap: a version must cite code a reader can find)."""
    if not re.fullmatch(r"[0-9a-f]{4,64}", sha):  # hex only: nothing git could read as an option or a ref name
        return False
    try:
        return subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=root,
                              capture_output=True).returncode == 0
    except OSError:
        return False


def utc_today() -> datetime.date:
    return datetime.datetime.now(datetime.timezone.utc).date()


def ratio_denominators(data: dict[str, SeriesData], fetch: Fetch) -> dict[str, wdi.Denominator]:
    """WDI population + GDP PPP, RATIO_FROM..max(origin_apps, pct_origin last year): PCT runs a year ahead (I3)."""
    return wdi.fetch_denominators(RATIO_FROM, max(data["origin_apps"].last_year, data["pct_origin"].last_year), fetch)


def ratio_summary(check: scale.RatioCheck, unlisted: dict[str, list[dict]]) -> dict:
    """Manifest checks.ratios per WIPO ratio (I9): counts, failing lines (first RATIO_FAILING_LIST_MAX; count taken
    before the cut), drift per country, World row pass/fail (fail = a year outside tolerance or none compared) and
    its per-year lines (uncut: one per year at most), codes with WIPO values but no country entity
    (write.unlisted_ratio_codes), vintage factors (countries off by a median factor, largest first) and the
    non-blocking test's warning lines (scale.RATIO_BLOCKING_TEST)."""
    return {ratio_id: {
        "compared": check.compared[ratio_id], "failing_count": len(check.failing[ratio_id]),
        "failing": check.failing[ratio_id][:scale.RATIO_FAILING_LIST_MAX], "by_country": check.by_country[ratio_id],
        "world": "fail" if check.world_failing[ratio_id] or check.world_compared[ratio_id] == 0 else "pass",
        "world_failing": check.world_failing[ratio_id], "unlisted": unlisted[ratio_id],
        "vintage_factors": check.vintage_factors[ratio_id], "warnings": check.warnings[ratio_id],
    } for ratio_id in scale.WIPO_RATIO_IDS}


def _ratio_lines(ratio_id: str, block: dict) -> list[str]:
    """Dry run / blocked run (no manifest written): count line, warning lines, vintage factors line (count + largest
    VINTAGE_PRINT_MAX), WD lines, countries with failing cells (most first), failing lines, unlisted codes (rulings
    I1, I2)."""
    vintage = block["vintage_factors"]
    largest = ", ".join(f"{item['code']} {item['median_factor']:.4f}" for item in vintage[:VINTAGE_PRINT_MAX])
    drifting = sorted(((code, entry) for code, entry in block["by_country"].items() if entry["failing"]),
                      key=lambda item: (-item[1]["failing"], item[0]))
    return [
        f"{ratio_id}: {block['failing_count']} of {block['compared']} compared cells outside tolerance; "
        f"world row {block['world']}",
        *(f"{line} (warning)" for line in block["warnings"]),
        f"{ratio_id}: {len(vintage)} countries with a median factor off by more than "
        f"{scale.RATIO_VINTAGE_NOTE_MIN * 100:g}% (WDI vintage){': ' + largest if largest else ''}",
        *block["world_failing"],
        *(f"{ratio_id} {code}: {entry['failing']} failing, max "
          f"{'n/a' if entry['max_pct'] is None else str(entry['max_pct']) + '%'}" for code, entry in drifting),
        *block["failing"],
        *(f"{ratio_id} {item['code']}: WIPO values {item['years']}, no country entity (not shown, not compared)"
          for item in block["unlisted"]),
    ]


def gender_summary(collected: dict) -> dict:
    """Manifest checks.gender, warning lines (plan v0.2w): publication-weighted country women_any vs WIPO's World row
    per year (`gap_years` = years over GENDER_CROSSCHECK_TOLERANCE; run_checks blocks when more than half the compared
    years are), then computed continent women_any vs a figure WIPO printed, then country codes WIPO lists without an
    entity file (write.unlisted_gender_codes), then 1010 origins the 1040 list lacks (counted uncovered in group
    coverage, review I1)."""
    table = collected["gender"][gender.WOMEN_ANY]
    countries = {code: years for code, years in table.values.items() if classify(code) == "country"}
    world = gender.world_crosscheck(countries, collected["pct_publications"], table.values[GENDER_WORLD_CODE],
                                    write.gender_years(collected, gender.WOMEN_ANY))
    published = gender.load_published()
    continent_lines = [line for continent in m49.CONTINENTS for line in gender.continent_crosscheck(
        continent, write.group_women_any_computed(collected, continent),
        write.gender_members(collected, continent), table.values, collected["pct_publications"],
        published)]
    return {"compared": world["compared"], "max_gap_pp": world["max_gap_pp"], "gap_years": world["gap_years"],
            "warnings": [*world["lines"], *continent_lines, *write.unlisted_gender_codes(collected),
                         *(f"{gender.WOMEN_ANY} {code}: in the PCT publications origin list (1010), not in the "
                           f"{gender.WOMEN_ANY} list (1040): counted uncovered in group coverage"
                           for code in sorted(set(collected["pct_publications"]) - set(table.values)))]}


def _gender_lines(block: dict) -> list[str]:
    """Dry run / blocked run: the World cross-check count line, then each warning."""
    years = f" ({', '.join(str(year) for year in block['gap_years'])})" if block["gap_years"] else ""
    max_gap = "n/a" if block["max_gap_pp"] is None else f"{block['max_gap_pp']} pp"
    return [f"women_any weighted country mean vs WIPO World: {len(block['gap_years'])} of {block['compared']} "
            f"compared years over {gender.GENDER_CROSSCHECK_TOLERANCE} pp{years}; max gap {max_gap}",
            *(f"{line} (warning)" for line in block["warnings"])]


def _summary_lines(key: str, result: object) -> list:
    if key == "ratios":
        return [line for ratio_id, block in result.items() for line in _ratio_lines(ratio_id, block)]
    if key == "gender":
        return _gender_lines(result)
    return result if isinstance(result, list) else [result]


def run_checks(collected: dict, outputs: dict[Path, dict | list], fetcher: Fetcher,
               ctx: groups.Context) -> tuple[list[str], dict]:
    """(blocking failures, manifest checks summary). `collected` = collect() result + WDI `denominators`; `ctx` =
    the groups.context build_outputs used (its worlds too). CheckError from WDI/golden propagates (blocking).
    Negative not-attributable rest: blocking at the treemap year (overview `treemap`), warning in the continent-share
    history (groups.check_warnings)."""
    data: dict[str, SeriesData] = collected["series"]
    if ctx.data is not data:
        raise ValueError("group context built for other data")
    failures: list[str] = []
    worlds = ctx.worlds
    world_warnings: list[str] = []
    for key in ("world_office", "pct_world"):
        known = crosscheck.WORLD_OFFICE_EXCESS_YEARS if key == "world_office" else frozenset()
        world = worlds[key]
        blocking, warnings = crosscheck.world_check(key, world.published, world.our_sum, world.last_year, known)
        failures += blocking
        world_warnings += warnings

    office = data["office_apps"]
    first, last = crosscheck.wdi_years(office.last_year)
    missing = [code for code in crosscheck.WDI_OFFICES if code not in office.values]
    wdi_sample = crosscheck.fetch_wdi(crosscheck.WDI_OFFICES, first, last, fetcher.get)
    ours = {(code, year, type_key): office.values[code][type_key].get(year)
            for code in crosscheck.WDI_OFFICES if code in office.values
            for type_key in crosscheck.WDI_INDICATORS.values() for year in range(first, last + 1)}
    compared = sum(1 for key, value in ours.items() if value is not None and wdi_sample.cells.get(key) is not None)
    mismatches = crosscheck.wdi_compare(ours, wdi_sample.cells)
    # timing excuses value mismatches only (WDI behind a WIPO revision), never a missing office or no overlap
    lagging, timing = crosscheck.wdi_timing(wdi_sample.last_updated, outputs[write.MANIFEST]["releases"].get("ips"))
    wdi_warnings = mismatches if lagging else []
    wdi_failures = [] if lagging or not mismatches else [*mismatches, timing]
    wdi_failures += [f"WDI sample office {code} not in office_apps" for code in missing]
    if compared == 0:
        wdi_failures.append(f"WDI: no cell with values on both sides in {first}-{last}")
    failures += wdi_failures

    golden = crosscheck.load_golden()
    golden_failures, golden_notes = crosscheck.golden_compare(
        golden, lambda entry: write.published_value(outputs, entry["series"], entry["code_or_world"], entry["year"]))
    failures += golden_failures

    treemap = outputs[write.OVERVIEW]["treemap"]
    if treemap["residual"] is not None and treemap["residual"]["value"] < 0:
        failures.append(f"treemap {treemap['year']}: not-attributable rest negative ({treemap['residual']['value']})")

    numerators = {scale.RATIO_NUMERATOR[ratio_id] for ratio_id in scale.WIPO_RATIO_IDS}
    if len(numerators) != 1:  # ratio_crosscheck takes one numerator for both WIPO ratios (M1)
        raise ValueError(f"WIPO ratios {scale.WIPO_RATIO_IDS} need one numerator, got {sorted(numerators)}")
    ratio_check = scale.ratio_crosscheck(
        collected["ratios"], write.ratio_numerators(data, scale.WIPO_RATIO_IDS[0]),
        data["office_apps"].values[TOTAL_ROW_CODES["office_apps"]]["resident"], collected["denominators"])
    failures += ratio_check.blocking

    pct = data["pct_origin"]
    oecd = crosscheck.oecd_trend({code: types["total"] for code, types in pct.values.items()}, pct.last_year,
                                 fetcher.get)
    summary = {
        "wdi": "fail" if wdi_failures else "warn" if wdi_warnings else "pass",
        "wdi_scope": f"{', '.join(crosscheck.WDI_OFFICES)}; {first}-{last}; {compared} of {len(ours)} cells "
                     f"compared (blank on either side skipped)",
        "wdi_last_updated": wdi_sample.last_updated.isoformat() if wdi_sample.last_updated else None,
        "wdi_warnings": wdi_warnings,
        "wdi_warning_reason": timing if wdi_warnings else None,
        "golden": golden_notes,
        "golden_sources": crosscheck.golden_sources(golden),
        "world": world_warnings,
        "world_sum_ratio": {key: crosscheck.sum_ratio_summary(worlds[key].published, worlds[key].our_sum)
                            for key in write.PUBLISHED_WORLDS},
        "oecd": oecd,
        "pct_monthly": crosscheck.monthly_check(
            {int(year): values for year, values in outputs[write.OVERVIEW]["pct_monthly"].items()},
            worlds["pct_world"].published),  # warnings only: as published vs WIPO's yearly ZZ
        # warnings only: cross-check, negative band (at the treemap year it blocks, above), PCT ** band
        "groups": groups.check_warnings(ctx),
        # warnings unless the World row or the ratio's blocking test (scale.RATIO_BLOCKING_TEST) fails
        "ratios": ratio_summary(ratio_check, write.unlisted_ratio_codes(collected, worlds)),
        # warnings, except a systematic World gap (below)
        "gender": gender_summary(collected),
    }
    checked = summary["gender"]
    if len(checked["gap_years"]) * 2 > checked["compared"]:  # weighting no longer reproduces WIPO (plan stop rule)
        failures.append(f"gender: women_any weighted country mean off WIPO World by over "
                        f"{gender.GENDER_CROSSCHECK_TOLERANCE} pp in {len(checked['gap_years'])} of "
                        f"{checked['compared']} years (over half): refresh blocked")
    return failures, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m pipeline.run", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="data directory (default: site/data)")
    parser.add_argument("--dry-run", action="store_true", help="run all checks, print results, write nothing")
    parser.add_argument("--accept-regression", action="store_true", help=ACCEPT_REGRESSION_HELP)
    parser.add_argument("--bootstrap-version", action="store_true",
                        help="no fetch: write the first data version (releases.json, changed [\"all\"]) for the data "
                             "already in --out; refused when releases.json exists or the manifest's pipeline_sha is not a "
                             "clean commit of this repo")
    args = parser.parse_args(argv)

    if args.bootstrap_version:
        try:
            first = versions.bootstrap(args.out, is_commit)
        except (OSError, ValueError, KeyError) as error:
            print(f"FAILED (nothing written): {error}", file=sys.stderr)
            return 2
        print(f"data version {first['version']} written to {args.out / versions.RELEASES}")
        return 0
    use_system_ca_bundle()
    retrieved = utc_today()
    try:
        client = WipoClient()
        fetcher = Fetcher()
        collected = collect(client, retrieved)
        collected["denominators"] = ratio_denominators(collected["series"], fetcher.get)
        release_strings = releases(client)
        ctx = groups.context(collected["series"])  # one per run: outputs and checks share it
        outputs = write.build_outputs(collected, release_strings, retrieved, pipeline_sha(), ctx)
        failures, summary = run_checks(collected, outputs, fetcher, ctx)
        regression = regress.compare(outputs, args.out)
    except (WipoError, SchemaError, CheckError, ValueError) as error:
        print(f"FAILED (nothing written): {error}", file=sys.stderr)
        return 2

    accepted = regression.blocking if args.accept_regression else []
    if not args.accept_regression:
        failures += regression.blocking
    print(f"releases: {release_strings}; retrieved {retrieved}")
    for key, result in summary.items():
        for line in _summary_lines(key, result):
            print(f"{key}: {line}")
    print(f"regression: {regression.revision_count} past-year values revised over {regress.REVISION_WARN_PCT}% "
          f"or withdrawn ({len(regression.revisions)} listed)")
    for line in regression.revisions:
        print(f"regression: {line}")
    for line in accepted:
        print(f"ACCEPTED (--accept-regression): {line}")
    summary["regression"] = {"warn_pct": regress.REVISION_WARN_PCT, "revision_count": regression.revision_count,
                             "revisions": regression.revisions, "accepted": accepted}
    if failures:
        for line in failures:
            print(f"BLOCKING: {line}", file=sys.stderr)
        if regression.blocking and not accepted:
            print("regression lines: check them, then accept with --accept-regression (README, Refresh the data)",
                  file=sys.stderr)
        print("FAILED (nothing written): blocking check failures", file=sys.stderr)
        return 2
    outputs[write.MANIFEST]["checks"] = summary
    if args.dry_run:
        print("dry run: checks passed, nothing written")
        return 0
    if not write.changed(outputs, args.out):
        print(f"no change: {args.out} kept")
        return 0
    sha = outputs[write.MANIFEST]["pipeline_sha"]
    if sha.endswith(versions.DIRTY_SUFFIX) or sha == versions.UNKNOWN_SHA:  # a citable version names committed code
        print(f"BLOCKING: pipeline {sha}: commit pipeline/ in a git checkout before writing data", file=sys.stderr)
        print("FAILED (nothing written): pipeline code not committed or not in git", file=sys.stderr)
        return 2
    try:
        published = versions.load(args.out)
        version = versions.entry(versions.next_version(published, retrieved, data_tag_versions()),
                                 outputs[write.MANIFEST],
                                 versions.changed_ids(args.out, outputs))
    except (OSError, ValueError) as error:
        print(f"FAILED (nothing written): data version: {error}", file=sys.stderr)
        return 2
    outputs[write.MANIFEST]["version"] = version["version"]
    outputs[versions.RELEASES] = versions.append(published, version)
    try:
        write.write_outputs(outputs, args.out)
    except OSError as error:
        print(f"FAILED writing {args.out} (files may be partly updated; git keeps the last good data): {error}",
              file=sys.stderr)
        return 2
    print(f"written: {len(outputs)} files to {args.out}; data version {version['version']}: "
          f"{', '.join(version['changed'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
