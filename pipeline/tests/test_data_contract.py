"""Contract of the committed site data (site/data/) and map geometry (site/geo/): every file carries its source and
stays under the size limit; site/data checks skipped before the first pipeline run writes the directory."""
import json
import sys
from pathlib import Path

import pytest

from pipeline import releases

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from repo_guard import RAW_KEYS  # noqa: E402

DATA = Path(__file__).resolve().parents[2] / "site" / "data"
GEO = DATA.parent / "geo"  # scripts/build_geo.py
WITHOUT_SOURCES = {"manifest.json", "entities.json", releases.RELEASES.name}
MAX_FILE_BYTES = 500 * 1024  # plan v0.2a Global Constraints
V01_METHOD_KEYS = {"cagr_years", "golden_tolerance_pct", "rounding"}
GROUP_METHOD_KEYS = {"group_basis", "group_attribution_min", "group_crosscheck_range", "group_crosscheck_assignment",
                     "panel_years", "origin_abroad_from"}

pytestmark = pytest.mark.skipif(not DATA.is_dir(), reason="site/data not generated yet")
# Data written before v0.2a groups (no groups.json) predates these files; the next refresh writes them.
needs_groups = pytest.mark.skipif(not (DATA / "groups.json").is_file(),
                                  reason="site/data predates v0.2a group files (written by the next refresh)")
# Data written before v0.2b ratios (no map/per_million.json) has none of them; the next refresh writes them (M13).
HAS_RATIOS = (DATA / "map" / "per_million.json").is_file()
needs_ratios = pytest.mark.skipif(not HAS_RATIOS, reason="site/data predates v0.2b ratios (next refresh)")
# Data written before v0.2w women inventors (no map/women_any.json) has no gender blocks; the next refresh writes them.
HAS_GENDER = (DATA / "map" / "women_any.json").is_file()
needs_gender = pytest.mark.skipif(not HAS_GENDER, reason="site/data predates v0.2w women inventors (next refresh)")
GENDER_MEASURES = ("women_any", "women_share")  # gender.MEASURES: entity, group and map blocks
GENDER_IDS = (*GENDER_MEASURES, "women_any_by_field")
PUBLICATION_YEAR = "by publication year"  # every gender label and source description says it (plan v0.2w)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def data_files():
    return sorted(DATA.rglob("*.json")) + sorted(GEO.glob("*.json"))


def test_files_have_sources():
    for path in data_files():
        if path.parent == DATA and path.name in WITHOUT_SOURCES:
            continue
        assert load(path).get("sources"), f"{path} has no sources block"


def test_entity_files_listed():
    codes = {entity["code"] for entity in load(DATA / "entities.json")}
    for path in (DATA / "entity").glob("*.json"):
        content = load(path)
        assert content["code"] == path.stem
        assert content["code"] in codes, f"{path.name} not in entities.json"


def test_overview_publishes_wipo_worlds_only():
    overview = load(DATA / "overview.json")
    assert "world_origin" not in overview and "world_origin" not in overview["coverage"]
    assert set(overview["world_last_year"]) == {"world_office", "pct_world"}


def test_overview_method_constants_for_methods_page():
    overview = load(DATA / "overview.json")
    method = overview["method"]  # methods.ts states these; never typed into the page
    expected = V01_METHOD_KEYS | (GROUP_METHOD_KEYS if (DATA / "groups.json").is_file() else set())
    expected |= {"ratios"} if HAS_RATIOS else set()
    expected |= {"gender"} if HAS_GENDER else set()
    expected |= {"golden_growth_tolerance_pp", "treemap", "share_shift"}  # v2a
    assert set(method) == expected
    assert set(method["rounding"]["decimals"]) == {"yoy", "cagr", "share", "resident_share"}


V2A_BLOCKS = {"world_yoy", "top_grower", "treemap", "share_shift",  # overview blocks the v2a dashboard draws
              "pct_membership"}  # and the map's PCT membership layer


def test_v2a_blocks_published():
    """The v2a data refresh wrote every block the dashboard draws: the *_when_published checks below run on them
    (a missing block fails here, never a skip)."""
    overview = load(DATA / "overview.json")
    assert V2A_BLOCKS <= set(overview), sorted(V2A_BLOCKS - set(overview))


SERIES_BREAK_KEYS = {"code", "label", "year", "series", "note", "citation", "url", "page", "groups"}  # site SeriesBreak


def test_series_breaks_when_published():
    """Audit F1: each break WIPO publishes is in the entity data too (yoy of the year null, reason series_break)."""
    overview = load(DATA / "overview.json")
    for entry in overview["series_breaks"]:
        assert set(entry) == SERIES_BREAK_KEYS, entry
        derived = load(DATA / "entity" / f"{entry['code']}.json")["series"]
        for series_id in entry["series"]:
            year = str(entry["year"])
            assert derived[series_id]["derived"]["yoy"][year] is None, (entry["code"], series_id)
            assert derived[series_id]["derived"]["yoy_null_reason"][year] == "series_break", (entry["code"], series_id)


def test_world_yoy_when_published():
    """Spec 2a key-figure tiles: world change recomputed from the committed world series (derive.yoy_growth); a
    year of a series break listing the world's series null, reason series_break."""
    from pipeline import derive
    from pipeline.worlds import WORLD_SOURCES
    from pipeline.write import PUBLISHED_WORLDS
    overview = load(DATA / "overview.json")
    assert set(overview["world_yoy"]) == set(PUBLISHED_WORLDS)
    for key in PUBLISHED_WORLDS:
        series_id = WORLD_SOURCES[key][0]
        series = {int(year): value for year, value in overview[key].items()}
        broken = {entry["year"] for entry in overview["series_breaks"] if series_id in entry["series"]}
        expected = derive.yoy_growth(series)
        expected.update({year: None for year in broken if year in expected})
        block = overview["world_yoy"][key]
        assert block["yoy"] == {str(year): value for year, value in expected.items()}, key
        assert block["yoy_null_reason"] == {str(year): "series_break" for year in sorted(broken)
                                            if year in expected}, key


def test_top_grower_when_published():
    """Top grower = the top_origins row (same code, rank, value) with the highest cagr10 to top_year, recomputed
    from the committed entity totals (derive.cagr); null when no row has one."""
    from pipeline import derive
    overview = load(DATA / "overview.json")
    totals = entity_totals()
    rates = {row["code"]: derive.cagr({int(year): value for year, value in totals[row["code"]]["origin_apps"].items()},
                                      overview["top_year"]) for row in overview["top_origins"]}
    grower = overview["top_grower"]
    rated = [row for row in overview["top_origins"] if rates[row["code"]] is not None]
    if grower is None:
        assert rated == []
        return
    row = min(rated, key=lambda item: (-rates[item["code"]], item["rank"], item["code"]))  # tie: rank, then code
    assert (grower["code"], grower["label"], grower["rank"], grower["value"], grower["cagr10"]) == (
        row["code"], row["label"], row["rank"], row["value"], rates[row["code"]])
    top_year, years = overview["top_year"], overview["method"]["cagr_years"]
    assert grower["breaks"] == sorted(  # tile footnote: breaks after the CAGR base year, up to top_year
        entry["year"] for entry in overview["series_breaks"] if entry["code"] == grower["code"]
        and "origin_apps" in entry["series"] and top_year - years < entry["year"] <= top_year)


def test_treemap_when_published():
    """Spec 2a amendments (pipeline writes the treemap): recomputed from committed files. Continent value =
    continent_share total = countries + other; continents + not-attributable rest = WD (overview.world_office); rest
    >= 0 (negative blocks the refresh); origin values = map/origin_apps.json; fold rule from method.treemap; labels
    from groups.json / entities.json."""
    from decimal import Decimal
    from pipeline import derive
    overview = load(DATA / "overview.json")
    block, year = overview["treemap"], str(overview["top_year"])
    share = overview["continent_share"]["origin_apps"]
    world = overview["world_office"].get(year)  # null or past world_last_year: absent
    assert (block["series"], block["year"], block["world"], block["null_reason"]) == (
        "origin_apps", overview["top_year"], world, share["null_reason"].get(year))
    if block["null_reason"] is not None:
        assert (block["continents"], block["residual"], block["unattributed"], block["no_value"]) == ([], None, [], [])
        return
    values = {code: years.get(year) for code, years in load(DATA / "map" / "origin_apps.json")["values"].items()}
    labels = {item["code"]: item["label"] for item in load(DATA / "entities.json")}
    continents = [item for item in load(DATA / "groups.json")["items"] if item["kind"] == "continent"]
    line = Decimal(str(overview["method"]["treemap"]["fold_share_pct"])) * world
    assert [(row["id"], row["label"]) for row in block["continents"]] == [(item["id"], item["label"])
                                                                           for item in continents]
    for row, item in zip(block["continents"], continents):
        reported = {code for code in item["members"] if values.get(code) is not None}
        assert row["value"] == share["continent"][row["id"]][year] == sum(values[code] for code in reported), row["id"]
        assert row["share"] == derive.share(row["value"], world)
        for country in row["countries"]:
            assert country == {"code": country["code"], "label": labels[country["code"]],
                               "value": values[country["code"]], "share": derive.share(values[country["code"]], world)}
            assert Decimal(country["value"]) * 100 >= line, country["code"]
        assert row["countries"] == sorted(row["countries"], key=lambda country: (-country["value"], country["code"]))
        other = row["other"] or {"value": 0, "codes": []}
        assert other["codes"] == sorted(other["codes"]) and all(Decimal(values[code]) * 100 < line
                                                                for code in other["codes"]), row["id"]
        assert other["value"] == sum(values[code] for code in other["codes"])
        assert row["other"] is None or (other["codes"] and other["share"] == derive.share(other["value"], world))
        assert {country["code"] for country in row["countries"]} | set(other["codes"]) == reported, row["id"]
    residual = block["residual"]
    assert (residual["value"], residual["label"]) == (share["unallocated"][year], share["unallocated_label"])
    assert residual["value"] >= 0 and residual["share"] == derive.share(residual["value"], world)
    assert sum(row["value"] for row in block["continents"]) + residual["value"] == world
    grouped = {code for item in continents for code in item["members"]}
    assert block["unattributed"] == sorted(
        ({"code": code, "label": labels[code], "value": value, "share": derive.share(value, world)}
         for code, value in values.items() if code not in grouped and value is not None),
        key=lambda row: (-row["value"], row["code"]))
    assert sum(row["value"] for row in block["unattributed"]) <= residual["value"]  # inside the rest
    assert block["no_value"] == [{"code": code, "label": labels[code]} for code in sorted(values)
                                 if code in grouped and values[code] is None]


def test_share_shift_when_published():
    """Spec 2a amendments (share-shift bar): recomputed from committed files. year = top_year, base_year = top_year -
    method.cagr_years; rows = top_origins (code, label, rank, share); shares = entity derived.share at both years;
    change_pp = share - share_base exact in Decimal (null base -> null), the rule method.share_shift states; breaks =
    the code's origin series breaks in (base_year, year]. WD null or past world_last_year at either year ->
    no_wipo_world_total, no rows."""
    from decimal import Decimal
    overview = load(DATA / "overview.json")
    block, method = overview["share_shift"], overview["method"]
    year, base_year = overview["top_year"], overview["top_year"] - method["cagr_years"]
    assert (block["series"], block["year"], block["base_year"]) == ("origin_apps", year, base_year)
    assert method["share_shift"] == {"change": "difference of published shares",
                                     "decimals": method["rounding"]["decimals"]["share"]}
    if any(overview["world_office"].get(str(shown)) is None for shown in (year, base_year)):  # cut years absent
        assert (block["null_reason"], block["rows"]) == ("no_wipo_world_total", [])
        return
    assert block["null_reason"] is None
    assert [(row["code"], row["label"], row["rank"], row["share"]) for row in block["rows"]] == [
        (row["code"], row["label"], row["rank"], row["share"]) for row in overview["top_origins"]]
    for row in block["rows"]:
        share = load(DATA / "entity" / f"{row['code']}.json")["series"]["origin_apps"]["derived"]["share"]
        assert (row["share_base"], row["share"]) == (share.get(str(base_year)), share[str(year)]), row["code"]
        if row["share_base"] is None:
            assert row["change_pp"] is None, row["code"]
        else:
            assert Decimal(str(row["change_pp"])) == Decimal(str(row["share"])) - Decimal(str(row["share_base"]))
        assert row["breaks"] == sorted(entry["year"] for entry in overview["series_breaks"]
                                       if entry["code"] == row["code"] and "origin_apps" in entry["series"]
                                       and base_year < entry["year"] <= year), row["code"]


def test_pct_member_when_published():
    """Committed map/pct_member.json = pct_states.member_years of the committed pct_states.json against committed
    entities.json; former entities null (not_on_current_list), never false; overview counts match the list."""
    import datetime
    from pipeline import pct_states
    states = pct_states.load_pct_states()
    entities = load(DATA / "entities.json")
    codes = [entity["code"] for entity in entities]
    file = load(DATA / "map" / "pct_member.json")
    expected = pct_states.member_years(states, codes)
    assert file["values"] == {code: {str(year): member for year, member in years.items()}
                              for code, years in expected.items()}
    assert file["null_reason"] == pct_states.null_reasons(states, codes)
    assert {code for code, reason in file["null_reason"].items() if reason == pct_states.NOT_ON_CURRENT_LIST} == {
        entity["code"] for entity in entities if entity["kind"] == "historical"}
    # successor States: null before their own date, never false; their former entity carried for the tooltip
    hidden = {code for code, reason in file["null_reason"].items() if reason == pct_states.SUCCESSOR_STATE}
    assert hidden and set(file["successor_of"]) == hidden
    for code in hidden:
        assert False not in file["values"][code].values(), code
        assert file["successor_of"][code]["code"] in states.successors
    # territories: member fill from their footnoted date, never counted
    assert set(file["territories"]) == set(states.territories) & set(codes)
    for code, territory in file["territories"].items():
        assert territory["from"] == states.territories[code].since.isoformat() and code not in file["in_force"]
    assert file["in_force"] == {code: day.isoformat() for code, day in states.in_force.items()}
    assert file["unmatched"] == pct_states.unmatched(states, codes)
    assert file["sources"]["pct_member"]["status_on"] == states.status_on.isoformat()
    block = load(DATA / "overview.json")["pct_membership"]
    assert (block["status_on"], block["last_year"]) == (states.status_on.isoformat(), states.status_on.year)
    assert block["count"] == {str(year): count for year, count in pct_states.counts(states).items()}
    assert block["count"][str(block["last_year"])] == states.count
    assert datetime.date.fromisoformat(block["retrieved"]) >= datetime.date.fromisoformat(block["status_on"])


def test_files_under_size_limit():
    for path in data_files():
        assert path.stat().st_size < MAX_FILE_BYTES, f"{path} is {path.stat().st_size} bytes"


@needs_groups
def test_every_grouped_country_in_exactly_one_region():
    items = load(DATA / "groups.json")["items"]
    regions = [code for item in items if item["kind"] == "region" for code in item["members"]]
    continents = [code for item in items if item["kind"] == "continent" for code in item["members"]]
    assert len(regions) == len(set(regions)) and len(continents) == len(set(continents))
    assert set(regions) == set(continents)


@needs_groups
def test_group_and_map_files_listed():
    ids = {item["id"] for item in load(DATA / "groups.json")["items"]}
    assert {path.stem for path in (DATA / "group").glob("*.json")} == ids
    for path in (DATA / "group").glob("*.json"):
        content = load(path)
        assert content["id"] == path.stem
        assert ("office_apps" in content["series"]) == (content["kind"] == "continent")
    from pipeline.write import MAP_RATIOS
    maps = set(load(DATA / "overview.json")["last_year"]) | (set(MAP_RATIOS) if HAS_RATIOS else set())
    maps |= set(GENDER_MEASURES) if HAS_GENDER else set()
    maps |= {"pct_member"} if "pct_membership" in load(DATA / "overview.json") else set()
    assert {path.stem for path in (DATA / "map").glob("*.json")} == maps
    overview = load(DATA / "overview.json")
    assert set(overview["continent_share"]) == set(overview["last_year"])
    assert all("iso_numeric" in entity for entity in load(DATA / "entities.json"))


@needs_groups
def test_overview_view_blocks():
    overview = load(DATA / "overview.json")  # written by the same refresh as groups.json
    top_year = overview["top_year"]
    race = overview["rank_race"]
    years = [str(year) for year in range(race["first_year"], top_year + 1)]
    assert race["rows"] and all(list(row["ranks"]) == years for row in race["rows"])
    entity_ranks = {path.stem: content["series"]["origin_apps"]["derived"]["rank"]
                    for path in (DATA / "entity").glob("*.json")
                    if "origin_apps" in (content := load(path))["series"]}
    for year in years:  # rows ranked <= top each year = exactly the entities the entity files rank <= top
        in_rows = {row["code"] for row in race["rows"] if row["ranks"][year] is not None
                   and row["ranks"][year] <= race["top"]}
        ranked = {code for code, ranks in entity_ranks.items() if ranks.get(year) is not None
                  and ranks[year] <= race["top"]}
        assert in_rows == ranked, year
        assert len(ranked) >= race["top"], year
    growth = overview["size_growth"]
    assert growth and all(row["value"] >= overview["grower_min"] for row in growth)
    assert {row["code"] for row in overview["fastest_growers"]} <= {row["code"] for row in growth}
    monthly = overview["pct_monthly"]
    pct = overview["sources"]["pct_origin"]["years"].split("-")
    assert list(monthly) == [str(year) for year in range(int(pct[0]), int(pct[1]) + 1)]
    assert all(len(months) == 12 for months in monthly.values())
    assert all(value is not None for value in monthly[pct[1]])  # last complete PCT year: every month
    for year, months in monthly.items():  # complete years add up to WIPO's yearly total (ZZ)
        if None not in months and overview["pct_world"].get(year) is not None:
            assert sum(months) == overview["pct_world"][year], year
    assert overview["pct_monthly_source"]["entity"] == "ZZ"


def test_manifest_run_metadata():
    manifest = load(DATA / "manifest.json")
    assert set(manifest["releases"]) == {"ips", "pmh"}
    assert manifest["releases"]["ips"].startswith("Last updated:")
    assert manifest["retrieved"] and manifest["pipeline_sha"]


ENTRY_KEYS = {"version", "wipo_releases", "wdi_last_updated", "pipeline_sha", "changed"}


def keys_in(value):
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in keys_in(item)}
    if isinstance(value, list):
        return {key for item in value for key in keys_in(item)}
    return set()


def version_order(version):
    day, _, number = version.partition(".")
    return day, int(number or 1)


def test_data_versions():
    """releases.json (spec v1 citable data versions): present, newest first, unique valid versions; the newest
    entry describes the committed data (manifest version, releases, WDI vintages, pipeline)."""
    entries = load(DATA / releases.RELEASES)
    assert isinstance(entries, list) and entries
    versions = [entry["version"] for entry in entries]
    assert all(releases.VERSION_PATTERN.fullmatch(version) for version in versions), versions
    assert len(set(versions)) == len(versions)
    assert versions == sorted(versions, key=version_order, reverse=True)
    for entry in entries:
        assert set(entry) == ENTRY_KEYS, entry["version"]
        assert entry["changed"] and all(isinstance(item, str) for item in entry["changed"]), entry["version"]
    assert not keys_in(entries) & RAW_KEYS
    manifest = load(DATA / "manifest.json")
    assert manifest["version"] == versions[0]
    assert entries[0] == releases.entry(versions[0], manifest, entries[0]["changed"])


def entity_totals():
    """code -> series id -> total year series, from the committed entity files."""
    return {path.stem: {series_id: content["types"]["total"] for series_id, content in load(path)["series"].items()}
            for path in (DATA / "entity").glob("*.json")}


@needs_groups
def test_cross_file_figures_agree():
    """Audit T4: one figure, one value in every file that shows it (map, overview, group, entity)."""
    from pipeline.series import SERIES
    overview = load(DATA / "overview.json")
    totals = entity_totals()
    for series_id in (series.id for series in SERIES):  # count maps only; ratio maps have no entity total
        for code, years in load(DATA / "map" / f"{series_id}.json")["values"].items():
            for year, value in years.items():
                assert value == totals[code][series_id][year], (series_id, code, year)
        for continent, years in overview["continent_share"][series_id]["continent"].items():
            assert years == load(DATA / "group" / f"{continent}.json")["series"][series_id]["total"], \
                (series_id, continent)
    year = str(overview["top_year"])
    for row in overview["top_origins"]:
        origin = load(DATA / "entity" / f"{row['code']}.json")["series"]["origin_apps"]
        assert row["value"] == origin["types"]["total"][year], row["code"]
        assert row["rank"] == origin["derived"]["rank"][year], row["code"]
        assert row["share"] == origin["derived"]["share"][year], row["code"]
    assert len(overview["top_origins"]) == overview["top_n"]


@needs_groups
def test_world_equals_continents_plus_band_and_no_figure_past_cut():
    """Audit T5: the band's world (world_total - continent totals, groups.py) equals the published denominator
    `overview[SHARE_DENOMINATOR]`: guards that desync, not an independent sum check (the band is built from the same
    continents). Member-sum groups add up to their members; no share or rank past the world it depends on."""
    from pipeline.series import SERIES
    from pipeline.worlds import SHARE_DENOMINATOR, WORLD_OF_SERIES
    overview = load(DATA / "overview.json")
    for series_id, block in overview["continent_share"].items():
        world = overview[SHARE_DENOMINATOR[series_id]]
        for year, band in block["unallocated"].items():
            values = [years[year] for years in block["continent"].values()]
            if band is None or None in values:
                continue
            assert sum(values) + band == world[year], (series_id, year)
    totals = entity_totals()
    for item in load(DATA / "groups.json")["items"]:
        group = load(DATA / "group" / f"{item['id']}.json")["series"]
        for series_id, block in group.items():
            if block["basis"] != "member_sum":
                continue
            members = [code for code in item["members"] if series_id in totals.get(code, {})]
            assert len(members) == block["members"], (item["id"], series_id)
            for year, total in block["total"].items():
                if total is None:
                    continue
                values = [totals[code][series_id].get(year) for code in members]
                assert total == sum(value for value in values if value is not None), (item["id"], series_id, year)
    world_last = dict(overview["world_last_year"], world_origin=overview["top_year"])
    for path in (DATA / "entity").glob("*.json"):
        for series_id, content in load(path)["series"].items():
            derived = content["derived"]
            share_cut = world_last[SHARE_DENOMINATOR[series_id]]
            rank_cut = world_last[WORLD_OF_SERIES[series_id]]
            assert all(int(year) <= share_cut for year, value in derived["share"].items() if value is not None), \
                (path.stem, series_id)
            assert all(int(year) <= rank_cut for year, value in derived["rank"].items() if value is not None), \
                (path.stem, series_id)
    assert {series.id for series in SERIES} == set(SHARE_DENOMINATOR)


def ratio_maps():
    from pipeline.write import MAP_RATIOS
    return {ratio_id: load(DATA / "map" / f"{ratio_id}.json") for ratio_id in MAP_RATIOS}


@needs_ratios
def test_ratio_files_small_with_sources():
    for ratio_id, content in ratio_maps().items():
        path = DATA / "map" / f"{ratio_id}.json"
        assert path.stat().st_size < MAX_FILE_BYTES, f"{path} is {path.stat().st_size} bytes"
        assert set(content) == {"values", "computed", "null_reason", "sources"}
        assert set(content["sources"]) == {ratio_id}
    overview = load(DATA / "overview.json")
    assert {"per_million", "per_gdp"} <= set(overview["sources"])
    assert set(overview["world_ratios"]) == set(overview["method"]["ratios"]["ratio_ids"])
    manifest = load(DATA / "manifest.json")
    assert set(manifest["wdi_denominators"]) == {"population", "gdp_ppp"}
    assert set(manifest["ratio_labels"]) == set(overview["method"]["ratios"]["wipo_ratio_ids"])


@needs_ratios
def test_entity_ratio_values_equal_map_values():
    """One figure, one value: each country's ratio in its entity file equals the map (countries only, both ways)."""
    from pipeline.entities import classify
    maps = ratio_maps()
    countries = set()
    for path in (DATA / "entity").glob("*.json"):
        content = load(path)
        if classify(path.stem) != "country":
            assert "ratios" not in content, path.stem
            continue
        countries.add(path.stem)
        for ratio_id, ratio_map in maps.items():
            block = content["ratios"][ratio_id]
            assert block["value"] == ratio_map["values"][path.stem], (ratio_id, path.stem)
            assert block["computed"] == ratio_map["computed"][path.stem], (ratio_id, path.stem)
            assert block["null_reason"] == ratio_map["null_reason"][path.stem], (ratio_id, path.stem)
    for ratio_map in maps.values():
        assert set(ratio_map["values"]) == countries


@needs_ratios
def test_ratio_no_denominator_matches_map():
    """overview.ratio_no_denominator (methods page list) agrees with the map files: a listed country never has a computed
    year; a country with a computed year is never listed (guards the list across refreshes; final review N2)."""
    listed = load(DATA / "overview.json")["ratio_no_denominator"]
    maps = ratio_maps()
    for ratio_id, kind in (("per_million", "population"), ("per_gdp", "gdp_ppp")):
        computed = {code for code, years in maps[ratio_id]["computed"].items() if years}
        assert not computed & set(listed[kind]), (ratio_id, sorted(computed & set(listed[kind])))
        reason = "no_population" if kind == "population" else "no_gdp"
        for code in listed[kind]:
            reasons = set(maps[ratio_id]["null_reason"][code].values())
            assert reasons <= {reason, "no_applications"} and (reasons or maps[ratio_id]["values"][code]), (ratio_id, code)


@needs_ratios
def test_ratio_computed_years_and_null_reasons():
    """`computed` years carry our value (WIPO published none: never both); each null has a reason; PCT per million
    (no WIPO figure exists) is computed in every year with a value; no value past its cut."""
    overview = load(DATA / "overview.json")
    constants = overview["method"]["ratios"]
    cut = {ratio_id: overview["top_year"] for ratio_id in constants["wipo_ratio_ids"]}
    cut["pct_per_million"] = overview["world_last_year"]["pct_world"]
    first = {ratio_id: constants["ratio_from"] for ratio_id in constants["wipo_ratio_ids"]}
    first["pct_per_million"] = max(constants["ratio_from"], int(min(overview["pct_world"])))  # M3: PCT's first year
    for path in (DATA / "entity").glob("*.json"):
        for ratio_id, block in load(path).get("ratios", {}).items():
            where = (ratio_id, path.stem)
            assert list(block["value"]) == [str(year) for year in range(first[ratio_id], cut[ratio_id] + 1)], where
            for year in block["computed"]:
                assert block["value"][str(year)] is not None and str(year) not in block["null_reason"], where
            for year, value in block["value"].items():
                assert (value is None) == (year in block["null_reason"]), (where, year)
            if ratio_id not in constants["wipo_ratio_ids"]:
                assert sorted(block["computed"]) == [int(year) for year, value in block["value"].items()
                                                     if value is not None], where
    for ratio_id, year in overview["ratio_last_year"].items():
        assert year <= cut[ratio_id], ratio_id


@needs_ratios
def test_ratio_computed_zero_only_from_zero_count():
    """Final review M2: a computed (country fill) value of 0.0 comes only from a count of 0; a count > 0 rounding to
    0.0 is null with reason below_precision."""
    overview = load(DATA / "overview.json")
    numerator = overview["method"]["ratios"]["numerator"]
    for path in (DATA / "entity").glob("*.json"):
        content = load(path)
        for ratio_id, block in content.get("ratios", {}).items():
            series = numerator[ratio_id]
            counts = content["series"].get(series["series"], {}).get("types", {}).get(series["type"], {})
            for year in block["computed"]:
                if block["value"][str(year)] == 0:
                    assert counts.get(str(year)) == 0, (ratio_id, path.stem, year)
            for year, reason in block["null_reason"].items():
                if reason == "below_precision":
                    assert (counts.get(year) or 0) > 0, (ratio_id, path.stem, year)


def gender_maps():
    return {measure: load(DATA / "map" / f"{measure}.json") for measure in GENDER_MEASURES}


@needs_gender
def test_gender_files_small_with_sources():
    for measure, content in gender_maps().items():
        path = DATA / "map" / f"{measure}.json"
        assert path.stat().st_size < MAX_FILE_BYTES, f"{path} is {path.stat().st_size} bytes"
        weights = {"pct_publications"} if measure == "women_any" else set()  # ranking column (Task 4a)
        assert set(content) == {"values", "null_reason", "sources"} | weights
        assert set(content["sources"]) == {measure} | weights
        for source in content["sources"].values():
            assert PUBLICATION_YEAR in source["description"]
        if weights:
            assert set(content["pct_publications"]) == set(content["values"])
            for code, counts in content["pct_publications"].items():
                assert counts == load(DATA / "entity" / f"{code}.json")["pct_publications"], code
    overview = load(DATA / "overview.json")
    assert set(overview["gender"]) == {"world", "by_field", "last_year", "groups", "printed_source"}
    assert set(overview["gender"]["world"]) == set(GENDER_MEASURES)
    assert len(overview["gender"]["by_field"]) == 35
    assert all(field["label"] for field in overview["gender"]["by_field"].values())
    assert set(overview["gender"]["last_year"]) == set(GENDER_IDS)
    for gender_id in GENDER_IDS:
        assert PUBLICATION_YEAR in overview["sources"][gender_id]["description"]
    manifest = load(DATA / "manifest.json")
    assert set(GENDER_IDS) <= set(manifest["last_year"]) and set(GENDER_IDS) <= set(manifest["absent_rows"])
    assert set(manifest["gender_labels"]) == set(GENDER_IDS)


@needs_gender
def test_overview_gender_groups_equal_group_files():
    """overview.gender.groups is the group files' unlisted members, printed values and printed figure and page (the methods
    page reads it instead of 34 files): rebuilt here from the files, both ways (a group with neither is absent)."""
    overview = load(DATA / "overview.json")["gender"]
    expected = {}
    for path in sorted((DATA / "group").glob("*.json")):
        group = load(path)
        blocks = group["gender"]
        assert blocks["women_any"]["unlisted"] == blocks["women_share"]["unlisted"], path.stem
        printed = {measure: {year: block["value"][year] for year in map(str, block["wipo_years"])}
                   for measure, block in blocks.items() if block["wipo_years"]}
        refs = {measure: {year: {"figure": entry["figure"], "page": entry["page"]} for year, entry in source["printed"].items()}
                for measure, source in group["sources"].items() if "printed" in source}
        for measure, years in printed.items():  # every printed value has its figure and page, none without a value
            assert set(refs[measure]) == set(years), (path.stem, measure)
            assert all(entry["figure"] and entry["page"] for entry in refs[measure].values()), (path.stem, measure)
        if blocks["women_any"]["unlisted"] or printed:
            expected[group["id"]] = {"unlisted": blocks["women_any"]["unlisted"], "printed": printed, "printed_refs": refs}
    assert expected, "no group with an unlisted member or a printed figure"
    assert overview["groups"] == expected
    groups_file = {item["id"]: item for item in load(DATA / "groups.json")["items"]}
    for group_id, entry in overview["groups"].items():  # unlisted codes are members of the group
        assert set(entry["unlisted"]) <= set(groups_file[group_id]["members"]), group_id
    printed_urls = {entry["url"] for path in (DATA / "group").glob("*.json") for source in load(path)["sources"].values()
                    for entry in source.get("printed", {}).values()}
    assert printed_urls == {overview["printed_source"]["url"]}
    assert all(entry["citation"] == overview["printed_source"]["citation"] for path in (DATA / "group").glob("*.json")
               for source in load(path)["sources"].values() for entry in source.get("printed", {}).values())


@needs_gender
def test_entity_gender_values_equal_map_values():
    """One figure, one value: each country's gender block equals the map (countries only, both ways); never for an
    aggregate or a regional office."""
    from pipeline.entities import classify
    maps = gender_maps()
    countries = set()
    for path in (DATA / "entity").glob("*.json"):
        content = load(path)
        kind = classify(path.stem)
        if kind != "country":
            assert kind == "historical" or "gender" not in content, path.stem
            continue
        countries.add(path.stem)
        for measure, gender_map in maps.items():
            block = content["gender"][measure]
            assert block["value"] == gender_map["values"][path.stem], (measure, path.stem)
            assert block["null_reason"] == gender_map["null_reason"][path.stem], (measure, path.stem)
            assert PUBLICATION_YEAR in content["sources"][measure]["description"]
    for gender_map in maps.values():
        assert set(gender_map["values"]) == set(gender_map["null_reason"]) == countries


@needs_gender
def test_group_women_share_only_wipo_printed():
    """A group women_share value is never computed (WIPO publishes no inventor counts): values only in WIPO's printed
    years, each cited; every other year null `not_computable`."""
    for path in (DATA / "group").glob("*.json"):
        content = load(path)
        block = content["gender"]["women_share"]
        printed = {str(year) for year in block["wipo_years"]}
        assert {year for year, value in block["value"].items() if value is not None} <= printed, path.stem
        assert all(block["null_reason"][year] == "not_computable" for year in block["value"] if year not in printed)
        source = content["sources"]["women_share"]
        assert set(source.get("printed", {})) == printed, path.stem
        for measure in GENDER_MEASURES:
            assert PUBLICATION_YEAR in content["sources"][measure]["description"]
