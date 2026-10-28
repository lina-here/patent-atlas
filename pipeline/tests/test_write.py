import datetime
import json
from decimal import Decimal
from pathlib import Path

import pytest

from pipeline import breaks, crosscheck, derive, gender, groups, m49, scale, worlds, write
from pipeline.collect import GenderData, RatioData, SeriesData
from pipeline.series import GENDER_FIELD_IDS, GENDER_FROM, GENDER_SERIES, RATIO_FROM, RATIO_SERIES, series_by_id
from pipeline.wdi import Denominator
from pipeline.write import build_outputs, changed, published_value, write_outputs

RELEASES = {"ips": "Last updated: May 2026", "pmh": "Last updated: October 2026"}
RETRIEVED = datetime.date(2026, 10, 19)
YEARS = range(2013, 2025)  # 12 years: 10-year CAGR to 2024 has a base
R_LABELS = {"R1": "Africa", "R2": "Asia", "R3": "Europe", "R4": "Latin America and the Caribbean",
            "R5": "Northern America", "R6": "Oceania"}


def ramp(start, step, years=YEARS):
    return {year: start + step * index for index, year in enumerate(years)}


def nulls(years=YEARS):
    return {year: None for year in years}


def origin_data():
    values = {
        "CH": {"total": ramp(1000, 100), "resident": ramp(400, 10), "abroad": ramp(600, 90)},
        "US": {"total": ramp(5000, 50), "resident": ramp(3000, 0), "abroad": ramp(2000, 50)},
        "MG": {"total": {**ramp(0, 1), 2013: 0}, "resident": nulls(), "abroad": nulls()},  # zero base
        "SU": {"total": {**nulls(), 2013: 70}, "resident": nulls(), "abroad": nulls()},  # historical
        "EU": {"total": ramp(10**6, 0), "resident": nulls(), "abroad": nulls()},  # aggregate
    }
    labels = {"CH": "Switzerland", "US": "United States of America", "MG": "Madagascar",
              "SU": "Soviet Union", "EU": "European Union"}
    return SeriesData(series_by_id("origin_apps"), 2013, 2024, values, labels, 0)


def office_data():
    def office(total, resident):
        return {"total": total, "resident": resident,
                "nonresident": {y: None if total[y] is None else total[y] - resident[y] for y in YEARS}}
    values = {
        "CH": office(ramp(1400, 10), ramp(1100, 5)),
        "US": office(ramp(500000, 1000), ramp(250000, 0)),
        "EP": office(ramp(150000, 2000), ramp(70000, 0)),
        "VA": {key: nulls() for key in ("total", "resident", "nonresident")},  # no data at all
        # WIPO world; resident = WIPO's ratio numerator for the World row (scale.ratio_crosscheck)
        "WD": {"total": ramp(700000, 4000), "resident": ramp(400000, 0), "nonresident": nulls()},
        # WIPO regional totals: sum = WD; R3 = CH + EP, R5 = US (cross-check gap 0)
        **{code: {"total": total, "resident": nulls(), "nonresident": nulls()} for code, total in (
            ("R1", ramp(9, 0)), ("R2", ramp(48500, 990)), ("R3", ramp(151400, 2010)), ("R4", ramp(50, 0)),
            ("R5", ramp(500000, 1000)), ("R6", ramp(41, 0)))},
    }
    labels = {"CH": "Switzerland", "US": "United States of America", "EP": "European Patent Office",
              "VA": "Holy See", "WD": "World", **R_LABELS}
    return SeriesData(series_by_id("office_apps"), 2013, 2024, values, labels, 3)


def pct_data():
    years = range(2013, 2026)
    values = {
        "CH": {"total": ramp(4000, 10, years)},
        "US": {"total": ramp(50000, 100, years)},
        "ZZ": {"total": ramp(60000, 200, years)},  # WIPO total = sum(R1-R6) + ** Unknown
        "R1": {"total": ramp(100, 0, years)}, "R2": {"total": ramp(5000, 80, years)},
        "R3": {"total": ramp(4000, 10, years)}, "R4": {"total": ramp(100, 0, years)},
        "R5": {"total": ramp(50000, 100, years)}, "R6": {"total": ramp(100, 0, years)},
        "**": {"total": ramp(700, 10, years)},
    }
    labels = {"CH": "Switzerland", "US": "United States of America", "ZZ": "Total", "**": "Unknown", **R_LABELS}
    return SeriesData(series_by_id("pct_origin"), 2013, 2025, values, labels, 1)


def make_data():
    return {"origin_apps": origin_data(), "office_apps": office_data(), "pct_origin": pct_data()}


def month_values(year):
    return [year * 10 + month for month in range(1, 13)]


RATIO_YEARS = range(RATIO_FROM, 2025)  # WIPO ratio tables: RATIO_FROM..ips last complete year
WDI_YEARS = range(RATIO_FROM, 2026)  # run.py: RATIO_FROM..max(origin last 2024, PCT last 2025)
WDI_UPDATED = datetime.date(2026, 10, 8)
POPULATION_NAME = "Population, total"
GDP_NAME = "GDP, PPP (constant 2021 international $)"
# WDI level per code, every year of YEARS and 2025 (PCT runs a year ahead); earlier years null
POPULATION = {"CH": 8_000_000.0, "US": 340_000_000.0, "MG": 30_000_000.0}
GDP_PPP = {"CH": 7e11, "US": 2.5e13, "MG": 5e10}
WDI_WORLD = {"population": 8e9, "gdp_ppp": 1.6e14}


def wdi_denominators():
    """run.py's collected["denominators"] (hand-made): WDI population and GDP PPP, years WDI_YEARS."""
    def row(level):
        return {year: level if year in YEARS or year == 2025 else None for year in WDI_YEARS}
    return {key: Denominator(indicator, name, {code: row(level) for code, level in levels.items()},
                             row(WDI_WORLD[key]), WDI_UPDATED)
            for key, indicator, name, levels in (("population", "SP.POP.TOTL", POPULATION_NAME, POPULATION),
                                                 ("gdp_ppp", "NY.GDP.MKTP.PP.KD", GDP_NAME, GDP_PPP))}


def wipo_ratios(data, denominators):
    """collect()'s WIPO ratio tables, consistent with `data` and `denominators` (WIPO = our formula, rounded): CH
    and US every year of YEARS, WD = office WD resident / WDI world; MG listed without values (WIPO lacks it)."""
    tables = {}
    for definition in RATIO_SERIES:
        ratio_id, scale_factor = definition.id, scale.RATIO_SCALE[definition.id]
        rows = denominators[scale.RATIO_DENOMINATOR[ratio_id]]
        values = {code: {year: scale.ratio(data["origin_apps"].values[code]["resident"].get(year),
                                           rows.values[code].get(year), scale_factor) for year in RATIO_YEARS}
                  for code in ("CH", "US")}
        values["MG"] = dict.fromkeys(RATIO_YEARS)
        world = data["office_apps"].values["WD"]["resident"]
        values["WD"] = {year: scale.ratio(world.get(year), rows.world.get(year), scale_factor) for year in RATIO_YEARS}
        labels = {"CH": "Switzerland", "US": "United States of America", "MG": "Madagascar", "WD": "World"}
        api_label = " ".join(definition.label_words) + " (by origin)"
        tables[ratio_id] = RatioData(definition, RATIO_FROM, 2024, values, labels, api_label, 0)
    return tables


GENDER_YEARS = range(GENDER_FROM, 2026)  # GENDER_FROM..PCT last year (gender last_year = last World value)
GENDER_GAP_YEAR = 2010  # WIPO omits CH that year: not_published
# PCT publications by origin, every GENDER_YEARS year (the gender weights); MG counted, no share (africa: none)
PUBLICATIONS = {"CH": 1000, "US": 3000, "MG": 10, "DE": 100, "ZZ": 5000, "**": 200}
# share per origin, every GENDER_YEARS year (CH: GENDER_GAP_YEAR omitted). DE: a country WIPO lists with no entity
# file (warning); MG, SU listed without a value; VA, EP not listed; ** and R1-R6 never countries
GENDER_SHARES = {"women_any": {"CH": 30.0, "US": 40.0, "DE": 20.0, "**": 25.0},
                 "women_share": {"CH": 15.0, "US": 20.0, "DE": 10.0, "**": 12.0}}
GENDER_LABELS = {"CH": "Switzerland", "US": "United States of America", "MG": "Madagascar", "DE": "Germany",
                 "SU": "Soviet Union", "ZZ": "Total", "**": "Unknown", **R_LABELS}


def publications():
    """collect()'s pct_publications (hand-made): code -> year -> count; R rows and SU listed without values."""
    return {code: {year: PUBLICATIONS.get(code) for year in GENDER_YEARS}
            for code in [*PUBLICATIONS, "SU", *R_LABELS]}


def world_share(shares, year):
    """WIPO's World row as the publication-weighted country mean, rounded half away (cross-check gap < 0.05 pp)."""
    weighted = [(shares[code][year], PUBLICATIONS[code]) for code in ("CH", "US", "DE")
                if shares[code][year] is not None]
    return round(sum(share * count for share, count in weighted) / sum(count for _, count in weighted) + 1e-9, 1)


def gender_tables():
    """collect()'s gender tables (hand-made): women_any / women_share by origin, women_any_by_field world only."""
    tables = {}
    for definition in GENDER_SERIES:
        if definition.by == "field":
            values = {field: {year: 30.0 + int(field) / 10 for year in GENDER_YEARS} for field in GENDER_FIELD_IDS}
            labels = {field: f"Field {field}" for field in GENDER_FIELD_IDS}
        else:
            shares = {code: {year: None if code == "CH" and year == GENDER_GAP_YEAR else share
                             for year in GENDER_YEARS} for code, share in GENDER_SHARES[definition.id].items()}
            shares.update({code: dict.fromkeys(GENDER_YEARS) for code in ("MG", "SU", *R_LABELS)})
            shares["ZZ"] = {year: world_share(shares, year) for year in GENDER_YEARS}
            values, labels = shares, {code: GENDER_LABELS[code] for code in shares}
        tables[definition.id] = GenderData(values, labels, 2025, " ".join(definition.label_words) + " (by origin)")
    return tables


def collected(data=None, pct_monthly=None, ratios=None, denominators=None, gender_data=None):
    """collect() result + run.py's WDI denominators: series, PCT world months (default: every pct_origin year,
    month_values), WIPO ratio tables (default: wipo_ratios of `data`), denominators (default: wdi_denominators),
    PCT publications and gender tables (default: publications(), gender_tables())."""
    data = data if data is not None else make_data()
    pct = data["pct_origin"]
    if pct_monthly is None:
        pct_monthly = {year: month_values(year) for year in range(pct.first_year, pct.last_year + 1)}
    denominators = denominators if denominators is not None else wdi_denominators()
    ratios = ratios if ratios is not None else wipo_ratios(data, denominators)
    gender_data = gender_data if gender_data is not None else gender_tables()
    return {"series": data, "pct_monthly": pct_monthly, "ratios": ratios, "denominators": denominators,
            "pct_publications": publications(), "gender": gender_data}


def outputs(**kwargs):
    args = {"collected": collected(), "releases": RELEASES, "retrieved": RETRIEVED, "sha": "abc123"}
    args.update(kwargs)
    return build_outputs(**args)


def test_build_outputs_shapes():
    out = outputs()
    entity_files = {Path("entity") / f"{code}.json" for code in ("CH", "US", "MG", "SU", "EP", "VA")}
    group_files = {Path("group") / f"{item['id']}.json" for item in groups.groups_list()}
    map_files = {Path("map") / f"{map_id}.json"
                 for map_id in ("origin_apps", "office_apps", "pct_origin", "per_million", "per_gdp", "women_any",
                                "women_share")}
    assert set(out) == ({Path("entities.json"), Path("overview.json"), Path("manifest.json"), Path("groups.json")}
                        | entity_files | group_files | map_files)

    entities = out[Path("entities.json")]
    assert {e["code"]: (e["label"], e["kind"], e["iso3"], e["iso_numeric"]) for e in entities} == {
        "CH": ("Switzerland", "country", "CHE", "756"), "US": ("United States of America", "country", "USA", "840"),
        "MG": ("Madagascar", "country", "MDG", "450"), "SU": ("Soviet Union", "historical", None, None),
        "EP": ("European Patent Office", "regional_office", None, None),
        "VA": ("Holy See", "country", "VAT", "336")}

    overview = out[Path("overview.json")]
    assert "world_origin" not in overview and "world_origin" not in overview["coverage"]
    assert overview["top_year"] == 2024
    assert set(overview) >= {"world_office", "pct_world", "coverage", "world_last_year", "top_year",
                             "top_origins", "fastest_growers", "top_n", "grower_min", "last_year", "sources"}
    assert (overview["top_n"], overview["grower_min"]) == (write.TOP_N, write.GROWER_MIN)
    assert overview["method"] == {
        "cagr_years": derive.CAGR_YEARS, "golden_tolerance_pct": crosscheck.GOLDEN_TOLERANCE_PCT,
        "golden_growth_tolerance_pp": crosscheck.GOLDEN_GROWTH_TOLERANCE_PP,
        "rounding": {"mode": "half away from zero",
                     "decimals": {"yoy": derive.YOY_DECIMALS, "cagr": derive.CAGR_DECIMALS,
                                  "share": derive.SHARE_DECIMALS, "resident_share": derive.SHARE_DECIMALS}},
        "group_basis": groups.basis_table(),
        "group_attribution_min": groups.GROUP_ATTRIBUTION_MIN,
        "group_crosscheck_range": list(groups.GROUP_CROSSCHECK_RANGE),
        "group_crosscheck_assignment": {"office_apps": {"europe": ["EP", "EA", "YU"], "africa": ["OA", "AP"],
                                                        "asia": ["GC"]},
                                        "pct_origin": {"latin-america-caribbean": ["AN"]}},
        "panel_years": groups.PANEL_YEARS,
        "origin_abroad_from": groups.ORIGIN_ABROAD_FROM,
        "ratios": scale.method_constants(),
        "gender": gender.method_constants(),
        "treemap": {"fold_share_pct": write.TREEMAP_FOLD_SHARE_PCT}}
    assert overview["last_year"] == {"origin_apps": 2024, "office_apps": 2024, "pct_origin": 2025}
    assert overview["world_last_year"] == {"world_office": 2024, "pct_world": 2025}
    assert all(isinstance(year, str) for year in overview["world_office"])
    assert overview["world_office"]["2024"] == 744000  # WIPO's WD row, not our sum
    assert overview["pct_world"]["2025"] == 62400  # WIPO's ZZ row
    assert overview["sources"]["office_apps"] == {
        "name": "WIPO Statistics Database", "url": "https://www3.wipo.int/ipstats/", "tab": "ips",
        "query": series_by_id("office_apps").query_words, "entity": None, "years": "2013-2024"}
    top = overview["top_origins"]
    assert [(t["code"], t["rank"]) for t in top] == [("US", 1), ("CH", 2), ("MG", 3)]
    assert top[0] == {"code": "US", "label": "United States of America", "value": 5550, "rank": 1,
                      "share": 0.75}  # 5550 / WIPO world total (WD) 744000
    assert overview["share_denominator"] == {"origin_apps": "WIPO world total (WD)",
                                             "office_apps": "WIPO world total (WD)",
                                             "pct_origin": "WIPO PCT total (ZZ)"}
    growers = overview["fastest_growers"]
    assert [g["code"] for g in growers] == ["CH", "US"]  # MG below GROWER_MIN
    assert growers[0] == {"code": "CH", "label": "Switzerland", "cagr10": 6.7, "value": 2100}

    ch = out[Path("entity/CH.json")]
    assert (ch["code"], ch["label"], ch["kind"]) == ("CH", "Switzerland", "country")
    assert set(ch["series"]) == {"origin_apps", "office_apps", "pct_origin"}
    origin = ch["series"]["origin_apps"]
    assert set(origin["types"]) == {"total", "resident", "abroad"}
    assert origin["types"]["total"]["2024"] == 2100
    assert set(origin["derived"]) == {"yoy", "yoy_null_reason", "cagr10", "rank", "share", "resident_share"}
    assert origin["derived"]["yoy"]["2024"] == 5.0
    assert origin["derived"]["yoy_null_reason"] == {}
    assert "2013" not in origin["derived"]["yoy"]
    assert origin["derived"]["rank"]["2024"] == 2
    assert origin["derived"]["share"]["2024"] == 0.28  # 2100 / WD 744000, not our origin sum
    assert origin["derived"]["resident_share"] == {}
    office = ch["series"]["office_apps"]["derived"]
    assert office["resident_share"]["2024"] == 76.49  # 1155 / 1510 = 76.4900...
    assert office["share"]["2024"] == 0.2  # 1510 / WIPO world 744000 = 0.2029...
    assert ch["sources"]["origin_apps"]["entity"] == "CH"

    ep = out[Path("entity/EP.json")]
    assert set(ep["series"]) == {"office_apps"}
    assert ep["series"]["office_apps"]["derived"]["rank"] == {}  # regional office: never ranked
    su = out[Path("entity/SU.json")]
    assert su["series"]["origin_apps"]["derived"]["rank"] == {}  # historical: never ranked

    manifest = out[Path("manifest.json")]
    assert manifest["releases"] == RELEASES
    assert manifest["retrieved"] == "2026-10-19"
    assert manifest["pipeline_sha"] == "abc123"
    assert manifest["last_year"] == {**overview["last_year"], **overview["gender"]["last_year"]}
    # gender: MG, SU, R1-R6 listed without any value
    assert manifest["absent_rows"] == {"origin_apps": 0, "office_apps": 3, "pct_origin": 1, "women_any": 8,
                                       "women_share": 8, "women_any_by_field": 0}


def test_include_predicates():
    assert worlds.in_world_office_sum("EP") and worlds.in_world_office_sum("SU") and worlds.in_world_office_sum("CH")
    assert not worlds.in_world_office_sum("WD") and not worlds.in_world_office_sum("R1")
    assert worlds.in_world_origin("SU") and worlds.in_world_origin("CH")
    assert not worlds.in_world_origin("EU") and not worlds.in_world_origin("ZZ") and not worlds.in_world_origin("EP")
    assert write.is_ranked("CH") and not write.is_ranked("SU") and not write.is_ranked("EP")

    figures = worlds.world_figures(make_data())
    assert figures["world_origin"].our_sum[2013] == 1000 + 5000 + 0 + 70  # SU in, EU out
    assert figures["world_origin"].coverage[2013] == 4
    assert figures["world_origin"].coverage[2014] == 3  # SU null
    assert figures["world_office"].our_sum[2013] == 1400 + 500000 + 150000  # EP in, WD/R1 out
    assert figures["world_office"].coverage[2013] == 3  # VA null


def test_provisional_year_trimmed():
    data = make_data()
    for code in ("US", "MG"):  # 2024 reported by 1 of 3 countries -> provisional
        data["origin_apps"].values[code]["total"][2024] = None
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["top_year"] == 2023
    assert {t["code"]: t["value"] for t in overview["top_origins"]} == {"US": 5500, "CH": 2000, "MG": 10}
    ch = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("entity/CH.json")]
    assert "2024" not in ch["series"]["origin_apps"]["derived"]["share"]
    assert "2024" not in ch["series"]["origin_apps"]["derived"]["rank"]


def test_world_sources_name_the_wipo_row_and_the_years_shown():
    data = make_data()
    data["office_apps"].values["WD"]["total"].update({2013: None, 2014: None})  # WIPO world blank before 2015
    data["pct_origin"].values["CH"]["total"][2025] = None  # PCT 2025 reported by 1 of 2 origins -> provisional
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["world_last_year"]["pct_world"] == 2024
    assert overview["world_sources"] == {
        # chart shows years with a WIPO value up to world_last_year; the row reproduces it in the Data Center
        "world_office": {**overview["sources"]["office_apps"], "entity": "WD", "years": "2015-2024"},
        "pct_world": {**overview["sources"]["pct_origin"], "entity": "ZZ", "years": "2013-2024"},
    }
    assert overview["sources"]["office_apps"]["years"] == "2013-2024"  # series blocks unchanged


def test_entity_all_null():
    va = outputs()[Path("entity/VA.json")]
    office = va["series"]["office_apps"]
    assert set(va["series"]) == {"office_apps"}
    assert all(value is None for series in office["types"].values() for value in series.values())
    assert set(office["types"]["total"]) == {str(year) for year in YEARS}
    derived = office["derived"]
    assert all(value is None for value in derived["yoy"].values())
    assert derived["cagr10"] is None and derived["rank"] == {}
    assert all(value is None for value in derived["share"].values())
    assert all(value is None for value in derived["resident_share"].values())


def test_no_nan():
    data = make_data()
    data["office_apps"].values["CH"]["total"] = {year: 0 for year in YEARS}  # zero base everywhere
    out = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    for content in out.values():
        json.dumps(content, allow_nan=False)
    assert out[Path("entity/MG.json")]["series"]["origin_apps"]["derived"]["yoy"]["2014"] is None
    assert out[Path("entity/CH.json")]["series"]["office_apps"]["derived"]["resident_share"]["2024"] is None


def test_incomplete_year_rejected():
    with pytest.raises(ValueError, match="not complete"):
        outputs(retrieved=datetime.date(2025, 6, 1))


def test_no_raw_keys_in_outputs():
    def keys(node):
        if isinstance(node, dict):
            for key, value in node.items():
                yield key
                yield from keys(value)
        elif isinstance(node, list):
            for item in node:
                yield from keys(item)

    for content in outputs().values():
        assert not {"recordInfo", "records"} & set(keys(content))


def test_published_value():
    out = outputs()
    assert published_value(out, "office_apps", "world", 2024) == 744000
    assert published_value(out, "pct_origin", "world", 2025) == 62400
    assert published_value(out, "origin_apps", "CH", 2024) == 2100
    assert published_value(out, "origin_apps", "XX", 2024) is None
    assert published_value(out, "office_apps", "VA", 2024) is None
    assert published_value(out, "per_million", "CH", 2024) == 63.8  # entity ratios (WIPO's value, 510 / 8)
    assert published_value(out, "per_gdp", "world", 2024) == 250.0  # overview world_ratios (WIPO WD row)
    assert published_value(out, "per_gdp", "VA", 2024) is None  # country without counts or WDI row
    assert published_value(out, "per_gdp", "EP", 2024) is None  # not a country: no ratios
    assert published_value(out, "per_gdp", "XX", 2024) is None
    # gender (golden women_*): entity gender.<measure>.value, World = overview gender.world
    assert published_value(out, "women_any", "CH", 2024) == 30.0
    assert published_value(out, "women_share", "CH", 2024) == 15.0
    assert published_value(out, "women_share", "CH", GENDER_GAP_YEAR) is None
    assert published_value(out, "women_any", "world", 2025) == 37.1
    assert published_value(out, "women_share", "world", 2025) == 18.5  # (15 x 1000 + 20 x 3000 + 10 x 100) / 4100
    assert published_value(out, "women_any", "EP", 2024) is None  # not a country: no gender block
    assert published_value(out, "women_share", "XX", 2024) is None


def test_published_value_growth():
    """Golden growth ids (crosscheck.GOLDEN_GROWTH_SERIES) read overview world_yoy.<world>.yoy."""
    out = outputs()
    world_yoy = out[Path("overview.json")]["world_yoy"]
    assert published_value(out, "world_office_yoy", "world", 2024) == 0.5  # WD 744000 / 740000: 0.54%
    assert published_value(out, "pct_world_yoy", "world", 2025) == 0.3  # ZZ 62400 / 62200: 0.32%
    for series_id, key in crosscheck.GOLDEN_GROWTH_SERIES.items():
        for year in range(2014, 2026):
            assert published_value(out, series_id, "world", year) == world_yoy[key]["yoy"].get(str(year))
        assert published_value(out, series_id, "world", 2013) is None  # first year: no yoy
        assert published_value(out, series_id, "CH", 2020) is None  # world figures only
    assert published_value(out, "world_office_yoy", "world", 2017) is None  # WIPO's 2017 break (breaks.py)


def world_series(overview, key):
    return {int(year): value for year, value in overview[key].items()}


def test_world_yoy_from_published_world():
    """Spec 2a: tile change = derive.yoy_growth of the published world series (WD / ZZ); break years null."""
    overview = outputs()[Path("overview.json")]
    assert set(overview["world_yoy"]) == set(write.PUBLISHED_WORLDS) == set(crosscheck.GOLDEN_GROWTH_SERIES.values())
    for key in write.PUBLISHED_WORLDS:
        series = world_series(overview, key)
        expected = derive.yoy_growth(series)
        broken = breaks.world_break_years(worlds.WORLD_SOURCES[key][0])
        expected.update({year: None for year in broken if year in expected})
        block = overview["world_yoy"][key]
        assert list(block["yoy"]) == [str(year) for year in sorted(series)[1:]], key  # years 2..last
        assert block["yoy"] == {str(year): value for year, value in expected.items()}, key
        assert block["yoy_null_reason"] == {str(year): breaks.SERIES_BREAK for year in sorted(broken)
                                            if str(year) in block["yoy"]}, key
    assert overview["world_yoy"]["world_office"]["yoy"]["2024"] == 0.5  # (744000 - 740000) / 740000 = 0.54%
    assert overview["world_yoy"]["pct_world"]["yoy"]["2025"] == 0.3  # (62400 - 62200) / 62200 = 0.32%


def test_world_yoy_break_year_null_with_reason(monkeypatch):
    """A break listing office_apps (any code) nulls the world office change of that year; PCT untouched."""
    monkeypatch.setattr(breaks, "SERIES_BREAKS", [
        {"code": "CH", "year": 2020, "series": ["office_apps"], "note": "n", "citation": "c", "url": "u", "page": "p"}])
    assert breaks.world_break_years("office_apps") == {2020}
    assert breaks.world_break_years("pct_origin") == set()
    world_yoy = outputs()[Path("overview.json")]["world_yoy"]
    office = world_yoy["world_office"]
    assert office["yoy"]["2020"] is None
    assert office["yoy_null_reason"] == {"2020": "series_break"}
    assert office["yoy"]["2019"] == 0.6 and office["yoy"]["2021"] == 0.5  # 4000 / 720000, 4000 / 728000
    assert office["yoy"]["2017"] is not None  # repo breaks replaced: only the fixture's year is null
    pct = world_yoy["pct_world"]
    assert pct["yoy_null_reason"] == {} and all(value is not None for value in pct["yoy"].values())


def test_world_break_years_every_code_listing_the_series(monkeypatch):
    entry = {"note": "n", "citation": "c", "url": "u", "page": "p"}
    monkeypatch.setattr(breaks, "SERIES_BREAKS", [
        {**entry, "code": "CN", "year": 2017, "series": ["office_apps", "origin_apps"]},
        {**entry, "code": "CH", "year": 2005, "series": ["office_apps"]},
        {**entry, "code": "US", "year": 2010, "series": ["origin_apps"]}])
    assert breaks.world_break_years("office_apps") == {2005, 2017}
    assert breaks.world_break_years("origin_apps") == {2010, 2017}
    assert breaks.world_break_years("pct_origin") == set()


def test_world_yoy_cut_at_world_last_year():
    data = make_data()
    data["pct_origin"].values["CH"]["total"][2025] = None  # PCT 2025 reported by 1 of 2 origins -> provisional
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["world_last_year"]["pct_world"] == 2024
    pct = overview["world_yoy"]["pct_world"]["yoy"]
    assert "2025" not in pct and list(pct)[-1] == "2024"
    assert list(overview["world_yoy"]["world_office"]["yoy"])[-1] == "2024"


def add_origin(origin, code, total):
    origin.values[code] = {"total": total, "resident": nulls(), "abroad": nulls()}
    origin.labels[code] = code


def test_top_grower_among_top_origins(monkeypatch):
    """Spec 2a amendments: fastest grower among the top_n origins (no small-base outliers): MG (cagr 27.1, rank 4)
    is outside the top 3; JP (rank 1) has no base year (null cagr): skipped."""
    monkeypatch.setattr(write, "TOP_N", 3)
    data = make_data()
    add_origin(data["origin_apps"], "JP", {**nulls(), 2024: 10**6})
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert [row["code"] for row in overview["top_origins"]] == ["JP", "US", "CH"]
    assert derive.cagr({**ramp(0, 1), 2013: 0}, 2024) == 27.1  # MG: (11 / 1) ** 0.1 - 1, rank 4
    assert overview["top_grower"] == {"code": "CH", "label": "Switzerland", "rank": 3, "value": 2100,
                                      "cagr10": 6.7, "breaks": []}  # (2100 / 1100) ** 0.1 - 1 = 6.68%


@pytest.mark.parametrize("tied, expected", [
    ("DE", "DE"),  # same cagr10 as CH, better rank (6300 > 2100): rank wins
    ("AT", "AT"),  # same cagr10 and same value as CH: shared rank, code order
])
def test_top_grower_tie(monkeypatch, tied, expected):
    monkeypatch.setattr(write, "TOP_N", 3)
    data = make_data()
    factor = {"DE": 3, "AT": 1}[tied]  # CH's path (1000 + 100 a year) times factor: same ratio, same cagr10
    add_origin(data["origin_apps"], tied, ramp(1000 * factor, 100 * factor))
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    top = {row["code"]: row["rank"] for row in overview["top_origins"]}
    assert "CH" in top and tied in top
    assert overview["top_grower"]["code"] == expected and overview["top_grower"]["cagr10"] == 6.7


def test_top_grower_none_when_no_cagr():
    data = make_data()
    for code in ("CH", "US", "MG"):  # no base year: every top origin's cagr10 null
        data["origin_apps"].values[code]["total"][2014] = None
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["top_origins"] and overview["top_grower"] is None


def test_top_grower_breaks_in_window(monkeypatch):
    """Tile footnote: break years of the chosen code's origin series after the CAGR base year, up to top_year (base
    < year <= end: a break at the base year leaves both ends on one method)."""
    monkeypatch.setattr(write, "TOP_N", 3)
    entry = {"code": "CN", "series": ["origin_apps"], "note": "n", "citation": "c", "url": "u", "page": "p"}
    monkeypatch.setattr(breaks, "SERIES_BREAKS", [
        {**entry, "year": year} for year in (2013, 2014, 2015, 2017, 2024)] + [
        {**entry, "code": "CH", "year": 2018}, {**entry, "year": 2016, "series": ["office_apps"]}])
    data = make_data()
    add_origin(data["origin_apps"], "CN", ramp(1000, 1000))  # 2014 2000 -> 2024 12000: cagr10 19.6
    data["origin_apps"].labels["CN"] = "China"
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["top_grower"] == {"code": "CN", "label": "China", "rank": 1, "value": 12000, "cagr10": 19.6,
                                      "breaks": [2015, 2017, 2024]}


def test_top_grower_ends_at_top_year():
    """origin 2024 provisional (1 of 3 countries) -> top_year 2023: cagr10 ends there, as fastest_growers."""
    data = make_data()
    for code in ("US", "MG"):
        data["origin_apps"].values[code]["total"][2024] = None
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["top_year"] == 2023
    # base 2013: MG 0 (null cagr), US 5000 -> 5500 (1.0), CH 1000 -> 2000 (7.18%)
    assert overview["top_grower"] == {"code": "CH", "label": "Switzerland", "rank": 2, "value": 2000,
                                      "cagr10": 7.2, "breaks": []}


# Treemap (spec 2a amendments: the pipeline writes the treemap figures)
WD_2024 = 744000  # office_data WD ramp(700000, 4000) at 2024 = the treemap year


def fold_line():
    """Smallest 2024 value keeping its own rectangle: value x 100 >= TREEMAP_FOLD_SHARE_PCT x WD."""
    line = Decimal(str(write.TREEMAP_FOLD_SHARE_PCT)) * WD_2024 / 100
    assert line == int(line)  # fixture: a whole count sits exactly on the line
    return int(line)


def treemap_data():
    """origin 2024 above the attribution floor, every continent reporting, values around the fold line: KR on it
    (kept), IN one below (folded); CH, AT, AU, MG below (africa, oceania: folded only); BR, CL tied. TW: no M49
    continent. MX: listed, null in 2024. EU: aggregate. Other years: the default fixture (floor fails there)."""
    data = make_data()
    line = fold_line()
    origin = data["origin_apps"]
    rows = {"JP": ("Japan", 400000), "CN": ("China", 150000), "KR": ("Republic of Korea", line),
            "IN": ("India", line - 1), "DE": ("Germany", 50000), "AT": ("Austria", 100), "BR": ("Brazil", 2 * line),
            "CL": ("Chile", 2 * line), "MX": ("Mexico", None), "AU": ("Australia", line // 4), "TW": ("Taiwan", 500)}
    for code, (label, value) in rows.items():
        add_origin(origin, code, {**nulls(), 2024: value})
        origin.labels[code] = label
    origin.values["CH"]["total"][2024] = line // 2
    origin.values["US"]["total"][2024] = 2 * line
    return data


def treemap(data):
    return write._treemap(data["origin_apps"], groups.context(data), write._labels(data))


def continent_rows(block):
    return {row["id"]: row for row in block["continents"]}


def test_treemap_sums():
    """Countries + other = continent value = continent_share total; continents + not-attributable rest = WD;
    continents in M49 order with their group label; countries value desc, then code."""
    data = treemap_data()
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    block, share = overview["treemap"], overview["continent_share"]["origin_apps"]
    assert (block["series"], block["year"], block["world"], block["null_reason"]) == (
        "origin_apps", overview["top_year"], WD_2024, None)
    assert [row["id"] for row in block["continents"]] == list(m49.CONTINENTS)
    for row in block["continents"]:
        assert row["label"] == groups.group_label(row["id"])
        folded = row["other"]["value"] if row["other"] else 0
        assert sum(country["value"] for country in row["countries"]) + folded == row["value"]
        assert row["value"] == share["continent"][row["id"]]["2024"]
        assert row["share"] == derive.share(row["value"], WD_2024)
        assert row["countries"] == sorted(row["countries"], key=lambda country: (-country["value"], country["code"]))
    residual = block["residual"]
    assert sum(row["value"] for row in block["continents"]) + residual["value"] == WD_2024
    assert residual["value"] == share["unallocated"]["2024"] and residual["value"] >= 0
    assert residual["share"] == derive.share(residual["value"], WD_2024)
    rows = continent_rows(block)
    assert rows["asia"]["countries"][:2] == [
        {"code": "JP", "label": "Japan", "value": 400000, "share": derive.share(400000, WD_2024)},
        {"code": "CN", "label": "China", "value": 150000, "share": derive.share(150000, WD_2024)}]
    assert [country["code"] for country in rows["latin-america-caribbean"]["countries"]] == ["BR", "CL"]  # tie


def test_treemap_fold_boundary():
    """value x 100 < TREEMAP_FOLD_SHARE_PCT x WD folds, exact (before rounding): KR on the line keeps its rectangle;
    IN one below folds although its rounded share equals the threshold (methods text explains it). Every origin of a
    continent folded -> `other` alone; other codes sorted by code."""
    line = fold_line()
    rows = continent_rows(treemap(treemap_data()))
    assert [country["code"] for country in rows["asia"]["countries"]] == ["JP", "CN", "KR"]
    assert rows["asia"]["other"] == {"value": line - 1, "share": write.TREEMAP_FOLD_SHARE_PCT, "codes": ["IN"]}
    assert [country["code"] for country in rows["europe"]["countries"]] == ["DE"]
    assert rows["europe"]["other"]["codes"] == ["AT", "CH"]  # CH larger: still code order
    assert (rows["africa"]["countries"], rows["africa"]["other"]) == (
        [], {"value": 11, "share": derive.share(11, WD_2024), "codes": ["MG"]})
    assert (rows["oceania"]["countries"], rows["oceania"]["other"]["codes"]) == ([], ["AU"])
    assert rows["northern-america"]["other"] is None


@pytest.mark.parametrize("below, reason", [(0, None), (1, groups.ATTRIBUTION_FLOOR)])
def test_treemap_null_reason_attribution_floor(below, reason):
    """Grouped origins = GROUP_ATTRIBUTION_MIN x WD -> drawn; one application less -> reason, every row list empty
    (the card shows the reason, no chart)."""
    data = treemap_data()
    origin = data["origin_apps"].values
    floor = Decimal(str(groups.GROUP_ATTRIBUTION_MIN)) * WD_2024
    assert floor == int(floor)
    grouped = sum(types["total"][2024] or 0 for code, types in origin.items() if m49.continent_of(code))
    origin["JP"]["total"][2024] -= grouped - int(floor) + below
    block = treemap(data)
    assert (block["null_reason"], block["world"]) == (reason, WD_2024)
    if reason is None:
        assert len(block["continents"]) == len(m49.CONTINENTS) and block["residual"]["value"] >= 0
    else:
        assert (block["continents"], block["residual"], block["unattributed"], block["no_value"]) == ([], None, [], [])


def test_treemap_none_reported_passes_through():
    """A continent with no member reporting (latin america: BR, CL null; MX null already) above the floor ->
    continent_share's none_reported, empty rows."""
    data = treemap_data()
    for code in ("BR", "CL"):
        data["origin_apps"].values[code]["total"][2024] = None
    block = treemap(data)
    assert (block["null_reason"], block["world"]) == (groups.NONE_REPORTED, WD_2024)
    assert (block["continents"], block["residual"], block["unattributed"], block["no_value"]) == ([], None, [], [])


@pytest.mark.parametrize("case", ["provisional", "null"])
def test_treemap_wd_provisional(case):
    """WD provisional at the treemap year (office reported by EP alone; origin a year ahead) or null: no WIPO world
    total to divide by -> no_wipo_world_total, world null, every row list empty."""
    data = treemap_data()
    office = data["office_apps"].values
    if case == "provisional":
        for code in ("US", "CH"):
            for key in ("total", "resident", "nonresident"):
                office[code][key][2024] = None
    else:
        office["WD"]["total"][2024] = None
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    block = overview["treemap"]
    assert overview["top_year"] == block["year"] == 2024
    assert (block["null_reason"], block["world"]) == (groups.NO_WIPO_WORLD_TOTAL, None)
    assert (block["continents"], block["residual"], block["unattributed"], block["no_value"]) == ([], None, [], [])


def test_treemap_null_country_listed_not_zero():
    """M49 countries WIPO lists with null at the year: `no_value` (code order), never a 0 rectangle; a 0 is a value."""
    data = treemap_data()
    origin = data["origin_apps"]
    for code, label, value in (("AR", "Argentina", 0), ("BE", "Belgium", None)):
        add_origin(origin, code, {**nulls(), 2024: value})
        origin.labels[code] = label
    block = treemap(data)
    assert block["no_value"] == [{"code": "BE", "label": "Belgium"}, {"code": "MX", "label": "Mexico"}]
    drawn = {country["code"] for row in block["continents"] for country in row["countries"]}
    folded = {code for row in block["continents"] if row["other"] for code in row["other"]["codes"]}
    assert not {"BE", "MX"} & (drawn | folded)
    assert continent_rows(block)["latin-america-caribbean"]["other"] == {"value": 0, "share": 0.0, "codes": ["AR"]}


def test_treemap_unattributed_inside_residual():
    """Origins with a value and no M49 continent (TW; a former state reporting that year): listed under the rest
    (inside it, value desc), never in a continent; aggregates (EU) never listed."""
    data = treemap_data()
    data["origin_apps"].values["SU"]["total"][2024] = 70
    block = treemap(data)
    assert block["unattributed"] == [
        {"code": "TW", "label": "Taiwan", "value": 500, "share": derive.share(500, WD_2024)},
        {"code": "SU", "label": "Soviet Union", "value": 70, "share": derive.share(70, WD_2024)}]
    assert sum(row["value"] for row in block["unattributed"]) <= block["residual"]["value"]
    drawn = {country["code"] for row in block["continents"] for country in row["countries"]}
    folded = {code for row in block["continents"] if row["other"] for code in row["other"]["codes"]}
    assert not {"TW", "SU", "EU"} & (drawn | folded)


def test_treemap_members_must_add_up():
    """Countries + other = continent value holds on member sums only: a WIPO-total continent (PCT R rows: no member
    reports Africa's R1 here) stops the run rather than publishing rectangles that do not add up."""
    data = make_data()
    r1 = data["pct_origin"].values["R1"]["total"][2025]
    with pytest.raises(ValueError, match=f"africa 2025: members sum 0 != continent total {r1}"):
        write._treemap(data["pct_origin"], groups.context(data), write._labels(data))


def test_treemap_residual_label(monkeypatch):
    """Rest label = groups.unallocated_label (one source with the continent-share band)."""
    data = treemap_data()
    assert treemap(data)["residual"]["label"] == groups.unallocated_label("origin_apps", groups.context(data)) == \
        groups.UNALLOCATED_LABEL["origin_apps"]
    monkeypatch.setitem(groups.UNALLOCATED_LABEL, "origin_apps", "edited")
    assert treemap(data)["residual"]["label"] == "edited"


def test_method_treemap_constant(monkeypatch):
    """method.treemap publishes the fold threshold the figures apply (methods page reads it, never a copy)."""
    data = treemap_data()  # values around the current line
    monkeypatch.setattr(write, "TREEMAP_FOLD_SHARE_PCT", write.TREEMAP_FOLD_SHARE_PCT * 2)
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["method"]["treemap"] == {"fold_share_pct": write.TREEMAP_FOLD_SHARE_PCT}
    rows = continent_rows(overview["treemap"])
    assert rows["asia"]["other"]["codes"] == ["IN", "KR"]  # KR (old line) now below
    assert [country["code"] for country in rows["northern-america"]["countries"]] == ["US"]  # 2 x line: on the new one


def test_write_files_sorted_two_space(tmp_path):
    out = outputs()
    write_outputs(out, tmp_path)
    text = (tmp_path / "entity" / "CH.json").read_text(encoding="utf-8")
    assert text == json.dumps(out[Path("entity/CH.json")], allow_nan=False, sort_keys=True, indent=2,
                              ensure_ascii=False) + "\n"
    assert json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))["pipeline_sha"] == "abc123"


def test_changed_when_no_files(tmp_path):
    assert changed(outputs(), tmp_path / "missing")


def test_changed_ignores_retrieval_date(tmp_path):
    write_outputs(outputs(), tmp_path)
    assert not changed(outputs(), tmp_path)
    assert not changed(outputs(retrieved=datetime.date(2026, 11, 3)), tmp_path)


def test_changed_on_pipeline_sha_change(tmp_path):
    write_outputs(outputs(), tmp_path)  # sha abc123
    assert changed(outputs(sha="def456"), tmp_path)
    assert changed(outputs(sha="abc123-dirty"), tmp_path)


def test_changed_on_method_change(tmp_path):
    write_outputs(outputs(), tmp_path)
    new = outputs()
    new[Path("overview.json")]["method"]["cagr_years"] += 1  # method block (overview.json) written by new code
    assert changed(new, tmp_path)


def test_changed_on_release_change(tmp_path):
    write_outputs(outputs(), tmp_path)
    assert changed(outputs(releases={**RELEASES, "pmh": "Last updated: November 2026"}), tmp_path)


def test_changed_on_value_change(tmp_path):
    write_outputs(outputs(), tmp_path)
    data = make_data()
    data["pct_origin"].values["CH"]["total"][2025] += 1
    assert changed(build_outputs(collected(data), RELEASES, RETRIEVED, "abc123"), tmp_path)


def test_stale_entity_removed(tmp_path):
    write_outputs(outputs(), tmp_path)
    stale = tmp_path / "entity" / "XX.json"
    stale.write_text("{}\n", encoding="utf-8")
    assert changed(outputs(), tmp_path)
    write_outputs(outputs(), tmp_path)
    assert not stale.exists()
    assert (tmp_path / "entity" / "CH.json").exists()


def test_origin_share_null_where_wipo_world_null():
    data = make_data()
    data["office_apps"].values["WD"]["total"][2013] = None
    out = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    share = out[Path("entity/CH.json")]["series"]["origin_apps"]["derived"]["share"]
    assert share["2013"] is None  # no fallback to our sum
    assert share["2014"] == 0.16  # 1100 / 704000 = 0.15625 -> 0.16 (third digit 6: plain round-up, not a tie)
    assert "world_origin" not in out[Path("overview.json")]  # our origin sum never published


def test_changed_ignores_stray_files(tmp_path):
    write_outputs(outputs(), tmp_path)
    (tmp_path / "notes.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "entity" / "README.txt").write_text("x\n", encoding="utf-8")
    assert not changed(outputs(), tmp_path)
    write_outputs(outputs(), tmp_path)
    assert (tmp_path / "notes.json").exists()  # only stale entity/*.json are deleted


def test_changed_on_absent_rows_change(tmp_path):
    write_outputs(outputs(), tmp_path)
    data = make_data()
    data["office_apps"].absent_rows = 4
    assert changed(build_outputs(collected(data), RELEASES, RETRIEVED, "abc123"), tmp_path)


def test_group_files():
    out = outputs()
    listing = out[Path("groups.json")]
    assert listing["sources"]["groupings"][0]["url"].startswith("https://unstats.un.org/")
    assert listing["sources"]["former_entities"]
    assert listing["successors"] == m49.SUCCESSORS
    assert listing["no_group"] == m49.NO_GROUP == {"AQ": "Antarctica: M49 lists no region"}  # methods page lists them
    assert {"code": "CD", "from_year": 1980, "to_year": 1996} in listing["successors"]["ZR"]
    europe = out[Path("group/europe.json")]
    assert (europe["kind"], europe["label"], europe["continent"]) == ("continent", "Europe", "europe")
    assert set(europe["series"]) == {"origin_apps", "office_apps", "pct_origin"}
    office = europe["series"]["office_apps"]
    assert office["basis"] == "wipo_total" and office["total"]["2013"] == 151400
    assert office["member_sum"]["2013"] == 1400 + 150000  # CH + EP
    assert (office["members"], office["reporting"]["2013"], office["null_reason"]) == (2, 1, {})  # CH; VA no data
    assert office["source"]["entity"] == "R3" and europe["sources"]["office_apps"] == office["source"]
    assert "panel" not in office  # wipo_total: no fixed panel
    origin = europe["series"]["origin_apps"]  # fixture: grouped origin sum far below WD -> attribution floor
    assert origin["basis"] == "member_sum" and "member_sum" not in origin
    assert origin["total"]["2013"] is None and origin["null_reason"]["2013"] == "attribution_floor"
    assert origin["source"]["entity"] is None
    region = out[Path("group/155.json")]
    assert region["kind"] == "region" and set(region["series"]) == {"origin_apps", "pct_origin"}  # no office
    assert region["series"]["pct_origin"]["total"]["2025"] == 4000 + 10 * 12
    assert out[Path("group/151.json")]["former_notes"][0]["former"] == "CS"


def test_map_files():
    out = outputs()
    origin = out[Path("map/origin_apps.json")]
    assert set(origin["values"]) == {"CH", "US", "MG", "SU"}  # countries + former states; no EU aggregate
    assert origin["values"]["CH"]["2024"] == 2100 and origin["values"]["SU"]["2014"] is None
    assert set(out[Path("map/office_apps.json")]["values"]) == {"CH", "US", "VA"}  # no EP, WD, R rows
    assert out[Path("map/pct_origin.json")]["sources"]["pct_origin"]["tab"] == "pmh"


def test_overview_continent_share():
    share = outputs()[Path("overview.json")]["continent_share"]
    assert set(share) == {"origin_apps", "office_apps", "pct_origin"}
    office = share["office_apps"]
    assert office["continent"]["europe"]["2013"] == 151400
    assert office["unallocated"] == {str(year): 0 for year in YEARS}  # fixture: WD = sum R
    assert (office["unallocated_label"], office["negative_years"], office["null_reason"]) == ("unallocated", [], {})
    pct = share["pct_origin"]
    assert pct["unallocated"]["2025"] == 700 + 10 * 12 and pct["unallocated_label"] == "origin unknown"
    origin = share["origin_apps"]
    assert origin["unallocated_label"] == "not attributable"
    assert all(value is None for value in origin["unallocated"].values())
    assert set(origin["null_reason"].values()) == {"attribution_floor"}


def test_group_and_map_outputs_cut_at_world_last_year():
    data = make_data()
    data["pct_origin"].values["CH"]["total"][2025] = None  # PCT 2025 reported by 1 of 2 origins -> provisional
    data["office_apps"].values["WD"]["total"][2014] = None
    out = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    assert max(out[Path("map/pct_origin.json")]["values"]["US"]) == "2024"
    assert max(out[Path("group/155.json")]["series"]["pct_origin"]["total"]) == "2024"
    assert max(out[Path("group/155.json")]["series"]["pct_origin"]["panel"]["total"]) == "2024"
    share = out[Path("overview.json")]["continent_share"]
    assert max(share["pct_origin"]["unallocated"]) == "2024"
    assert max(share["pct_origin"]["continent"]["europe"]) == "2024"
    assert share["office_apps"]["unallocated"]["2014"] is None  # WIPO world null -> band null
    assert share["office_apps"]["null_reason"] == {"2014": "no_wipo_world_total"}


def test_changed_false_on_unchanged_group_and_map_files(tmp_path):
    write_outputs(outputs(), tmp_path)
    assert (tmp_path / "groups.json").is_file() and (tmp_path / "group" / "europe.json").is_file()
    assert (tmp_path / "map" / "origin_apps.json").is_file()
    assert not changed(outputs(), tmp_path)
    data = make_data()
    data["office_apps"].values["R3"]["total"][2020] += 1  # only a group figure differs
    assert changed(build_outputs(collected(data), RELEASES, RETRIEVED, "abc123"), tmp_path)


@pytest.mark.parametrize("stale", ["group/999.json", "map/old_series.json"])
def test_stale_group_and_map_files_removed(tmp_path, stale):
    write_outputs(outputs(), tmp_path)
    (tmp_path / stale).write_text("{}\n", encoding="utf-8")
    assert changed(outputs(), tmp_path)
    write_outputs(outputs(), tmp_path)
    assert not (tmp_path / stale).exists()
    assert (tmp_path / "group" / "europe.json").exists() and (tmp_path / "map" / "pct_origin.json").exists()


# overview view blocks (Task 7 charts)

def test_rank_race(monkeypatch):
    monkeypatch.setattr(write, "RANK_RACE_TOP", 2)
    data = make_data()
    data["origin_apps"].values["MG"]["total"][2013] = 10**5  # top 2 in 2013 only
    data["origin_apps"].values["CH"]["total"][2020] = None  # no value: rank null, never dropped
    race = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]["rank_race"]
    years = [str(year) for year in range(2013, 2025)]  # series first year (after RANK_RACE_FROM) to top_year
    assert (race["first_year"], race["top"]) == (2013, 2)
    assert [row["code"] for row in race["rows"]] == ["US", "CH", "MG"]  # ever in top 2; order: rank at top_year
    us, ch, mg = race["rows"]
    assert us["label"] == "United States of America" and list(us["ranks"]) == years
    assert mg["ranks"]["2013"] == 1 and mg["ranks"]["2014"] == 3  # ranks beyond top kept as data
    assert ch["ranks"]["2020"] is None and ch["ranks"]["2013"] == 3
    assert all(code not in ("SU", "EU") for code in (row["code"] for row in race["rows"]))  # countries only


def test_rank_race_from_and_top_year_cut(monkeypatch):
    monkeypatch.setattr(write, "RANK_RACE_TOP", 2)
    monkeypatch.setattr(write, "RANK_RACE_FROM", 2015)
    data = make_data()
    data["origin_apps"].values["MG"]["total"][2013] = 10**5  # before RANK_RACE_FROM: not counted
    for code in ("US", "MG"):  # 2024 provisional (1 of 3 countries): top_year 2023
        data["origin_apps"].values[code]["total"][2024] = None
    race = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]["rank_race"]
    assert race["first_year"] == 2015
    assert [row["code"] for row in race["rows"]] == ["US", "CH"]
    assert list(race["rows"][0]["ranks"]) == [str(year) for year in range(2015, 2024)]


def test_rank_race_constants():
    assert (write.RANK_RACE_TOP, write.RANK_RACE_FROM) == (10, 1995)  # spec Views: top 10 origins since 1995


def test_size_growth():
    data = make_data()
    origin = data["origin_apps"]
    origin.values["JP"] = {"total": {**nulls(), 2024: 3000}, "resident": nulls(), "abroad": nulls()}  # no base
    origin.labels["JP"] = "Japan"
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    assert overview["size_growth"] == [  # countries >= GROWER_MIN at top_year, largest first; null cagr kept
        {"code": "US", "label": "United States of America", "continent": "northern-america", "value": 5550,
         "cagr10": 0.9},  # (5550 / 5050) ** (1 / 10) - 1 = 0.948...%
        {"code": "JP", "label": "Japan", "continent": "asia", "value": 3000, "cagr10": None},
        {"code": "CH", "label": "Switzerland", "continent": "europe", "value": 2100, "cagr10": 6.7},
    ]
    assert m49.continent_of("JP") == "asia"
    assert [g["code"] for g in overview["fastest_growers"]] == ["CH", "US"]  # same rule, null cagr left out


def test_pct_monthly():
    overview = outputs()[Path("overview.json")]
    assert overview["pct_monthly"] == {str(year): month_values(year) for year in range(2013, 2026)}
    assert overview["pct_monthly_source"] == {
        "name": "WIPO Statistics Database", "url": "https://www3.wipo.int/ipstats/", "tab": "pmh",
        "query": write.PCT_MONTHLY_QUERY, "entity": "ZZ", "years": "2013-2025"}
    months = {**{year: month_values(year) for year in range(2013, 2026)}, 2014: [None] * 12}
    assert outputs(collected=collected(pct_monthly=months))[Path("overview.json")]["pct_monthly"]["2014"] == [
        None] * 12


@pytest.mark.parametrize("months", [
    {year: month_values(year) for year in range(2014, 2026)},  # a pct year missing
    {year: month_values(year)[:11] for year in range(2013, 2026)},  # 11 months
])
def test_pct_monthly_shape_checked(months):
    with pytest.raises(ValueError, match="pct_monthly"):
        outputs(collected=collected(pct_monthly=months))


def test_build_outputs_takes_a_prebuilt_context():
    data = make_data()
    ctx = groups.context(data)
    assert build_outputs(collected(data), RELEASES, RETRIEVED, "abc", ctx) == build_outputs(
        collected(data), RELEASES, RETRIEVED, "abc")
    with pytest.raises(ValueError, match="context"):
        build_outputs(collected(make_data()), RELEASES, RETRIEVED, "abc", ctx)  # built for other data


def test_origin_share_null_where_wipo_world_provisional():
    """Final review M1 / test-gaps audit 1: origin shares divide by WD; a year where WD is provisional (past
    world_office.last_year) has no share, as in the group files (same helper, groups.world_total), even when origin
    coverage passes that year. Ranks need no WD: kept."""
    data = make_data()
    for key in ("total", "resident", "nonresident"):  # office 2024 reported by EP alone -> provisional
        data["office_apps"].values["US"][key][2024] = None
        data["office_apps"].values["CH"][key][2024] = None
    out = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    overview = out[Path("overview.json")]
    assert overview["world_last_year"]["world_office"] == 2023
    assert overview["top_year"] == 2024  # origin runs a year ahead
    share = out[Path("entity/CH.json")]["series"]["origin_apps"]["derived"]["share"]
    assert share["2024"] is None
    assert out[Path("entity/CH.json")]["series"]["origin_apps"]["derived"]["rank"]["2024"] == 2
    assert share["2023"] == 0.27  # CH 2023 / WD 2023 = 2000 / 740000 = 0.2702...
    assert all(item["share"] is None for item in overview["top_origins"])
    assert overview["continent_share"]["origin_apps"]["null_reason"].get("2024") == "no_wipo_world_total"


def china_data():
    """make_data + CN totals 2015-2018 in office, origin and PCT (null in the other years): WIPO's 2017 break."""
    data = make_data()
    def years_of(series, values):
        known = dict(zip(range(2015, 2019), values))
        return {year: known.get(year) for year in range(series.first_year, series.last_year + 1)}
    origin, office, pct = data["origin_apps"], data["office_apps"], data["pct_origin"]
    origin.values["CN"] = {"total": years_of(origin, (1000, 1100, 1300, 1430)),
                           "resident": years_of(origin, (900, 990, 1170, 1287)),
                           "abroad": years_of(origin, (100, 110, 130, 143))}
    office.values["CN"] = {"total": years_of(office, (2000, 2200, 2600, 2860)),
                           "resident": years_of(office, (1500, 1650, 1950, 2145)),
                           "nonresident": years_of(office, (500, 550, 650, 715))}
    pct.values["CN"] = {"total": years_of(pct, (100, 110, 121, 130))}
    for series in (origin, office, pct):
        series.labels["CN"] = "China"
    return data


def test_china_break_nulls_yoy_with_reason():
    """Audit F1: WIPO says China's data before 2017 are not comparable; CN office/origin yoy 2017 = null with the
    reason, the years around it computed; PCT and other countries untouched."""
    out = build_outputs(collected(china_data()), RELEASES, RETRIEVED, "abc")
    china = out[Path("entity/CN.json")]["series"]
    for series_id in ("office_apps", "origin_apps"):
        derived = china[series_id]["derived"]
        assert derived["yoy"]["2016"] == 10.0, series_id
        assert derived["yoy"]["2017"] is None, series_id
        assert derived["yoy_null_reason"] == {"2017": breaks.SERIES_BREAK} == {"2017": "series_break"}
        assert derived["yoy"]["2018"] == 10.0, series_id
    pct = china["pct_origin"]["derived"]
    assert pct["yoy"]["2017"] == 10.0 and pct["yoy_null_reason"] == {}
    swiss = out[Path("entity/CH.json")]["series"]
    for series_id in ("office_apps", "origin_apps", "pct_origin"):
        assert swiss[series_id]["derived"]["yoy_null_reason"] == {}
        assert swiss[series_id]["derived"]["yoy"]["2017"] is not None
    assert swiss["origin_apps"]["derived"]["yoy"]["2017"] == 7.7  # 100 / 1300 = 7.69...%


def test_overview_lists_series_breaks():
    out = build_outputs(collected(china_data()), RELEASES, RETRIEVED, "abc")
    listed = out[Path("overview.json")]["series_breaks"]
    assert len(listed) == len(breaks.SERIES_BREAKS) == 1
    entry = listed[0]
    assert (entry["code"], entry["year"], entry["series"]) == ("CN", 2017, ["office_apps", "origin_apps"])
    assert entry["groups"] == ["030", "asia"]  # M49 region, continent: the group charts that include China
    assert entry["label"] == "China"  # data label, for "Includes China" on world and group charts
    assert entry["citation"] and entry["url"] and entry["page"]
    assert entry["note"] and not entry["note"].startswith(("\"", "“"))  # our summary, never a quote (M4)
    assert entry["note"].endswith("WIPO does not report a 2017 growth rate at world level")  # review M1
    assert entry["page"] == ("figure A1 note, p. 25 (PDF p. 27); 'Change in method of counting IP applications "
                             "by CNIPA in 2017', p. 173 (PDF p. 175)")  # review I2: WIPI 2025 figure A1 + data description
    golden_citation = {item["url"]: item["citation"] for item in crosscheck.load_golden()}
    assert golden_citation[entry["url"]] == entry["citation"]  # same WIPI 2025 citation as the golden figures
    assert {key: value for key, value in entry.items() if key != "label"} == breaks.listing()[0]


def test_entity_cagr10_end_year_when_origin_year_provisional():
    """Audit G7/T6: origin 2024 provisional (1 of 3 countries) -> top_year 2023. Pinned rule: entity cagr10 ends at
    the series' last year (2024), fastest growers at top_year (2023). Literals by hand from the fixture."""
    data = make_data()
    for code in ("US", "MG"):
        data["origin_apps"].values[code]["total"][2024] = None
    out = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")
    overview = out[Path("overview.json")]
    assert (overview["top_year"], overview["last_year"]["origin_apps"]) == (2023, 2024)
    assert out[Path("entity/CH.json")]["series"]["origin_apps"]["derived"]["cagr10"] == 6.7  # (2100 / 1100) ** 0.1 - 1 = 6.68% -> 6.7
    growers = {row["code"]: row for row in overview["fastest_growers"]}
    assert growers["CH"]["cagr10"] == 7.2  # (2000 / 1000) ** 0.1 - 1 = 7.18%: end 2023
    assert growers["CH"]["value"] == 2000


FILLER_ORIGINS = ("DE", "FR", "GB", "IT", "ES", "JP", "KR", "CN", "IN", "BR", "CA", "AU", "SE", "NL", "BE", "AT")


def test_top_n_and_grower_min_boundaries():
    """Audit G8: TOP_N + 1 ranked origins -> top list holds TOP_N, rank TOP_N + 1 left out; GROWER_MIN inclusive."""
    data = make_data()
    origin = data["origin_apps"]
    rows = {"NO": write.GROWER_MIN, "FI": write.GROWER_MIN - 1}  # flat series: cagr10 0.0, never None
    rows.update({code: 100 + index for index, code in enumerate(FILLER_ORIGINS)})
    for code, value in rows.items():
        origin.values[code] = {"total": ramp(value, 0), "resident": nulls(), "abroad": nulls()}
        origin.labels[code] = code
    overview = build_outputs(collected(data), RELEASES, RETRIEVED, "abc")[Path("overview.json")]
    ranked = 3 + len(rows)  # CH, US, MG + added countries
    assert ranked == write.TOP_N + 1
    top = overview["top_origins"]
    assert len(top) == write.TOP_N
    assert [row["rank"] for row in top] == list(range(1, write.TOP_N + 1))
    assert "MG" not in {row["code"] for row in top}  # MG 2024 = 11: smallest, rank TOP_N + 1
    assert [row["code"] for row in overview["fastest_growers"]] == ["CH", "US", "NO"]
    assert {row["code"] for row in overview["size_growth"]} == {"CH", "US", "NO"}


def test_build_outputs_unknown_code_raises():
    """Audit G12: a code entities.py does not know stops the run (run.main exit 2), never guessed as a country."""
    data = make_data()
    data["origin_apps"].values["QQ"] = {"total": ramp(10, 0), "resident": nulls(), "abroad": nulls()}
    data["origin_apps"].labels["QQ"] = "Unknown land"
    with pytest.raises(ValueError, match="QQ"):
        build_outputs(collected(data), RELEASES, RETRIEVED, "abc")


def test_build_outputs_unknown_ratio_code_raises():
    """Ruling I2: WIPO ratio-table codes are classified like count codes; unknown -> ValueError (run.main exit 2)."""
    data = make_data()
    ratios = wipo_ratios(data, wdi_denominators())
    ratios["per_gdp"].values["QQ"] = dict.fromkeys(RATIO_YEARS)  # listed even without values
    with pytest.raises(ValueError, match="QQ"):
        build_outputs(collected(data, ratios=ratios), RELEASES, RETRIEVED, "abc")


def test_unlisted_ratio_codes():
    """Ruling I2: a non-WD code with a WIPO value in the ratio's years but no country entity is listed (warning,
    manifest checks.ratios.<id>.unlisted); listed without values (live SU) or with a country entity -> nothing."""
    data = make_data()
    ratios = wipo_ratios(data, wdi_denominators())
    ratios["per_million"].values["NO"] = {**dict.fromkeys(RATIO_YEARS), 2010: 4.5, 2024: 5.0}  # no count series
    ratios["per_million"].values["YU"] = {**dict.fromkeys(RATIO_YEARS), 1990: 1.0, 1991: 2.0}  # historical
    ratios["per_gdp"].values["SU"] = dict.fromkeys(RATIO_YEARS)  # SU entity (historical), no values
    ratios["per_gdp"].values["R1"] = {**dict.fromkeys(RATIO_YEARS), 2024: 3.0}  # aggregate other than WD
    ctx = groups.context(data)
    build_outputs(collected(data, ratios=ratios), RELEASES, RETRIEVED, "abc", ctx)  # known codes: no raise
    assert write.unlisted_ratio_codes(collected(data, ratios=ratios), ctx.worlds) == {
        "per_million": [{"code": "NO", "years": "2010-2024"}, {"code": "YU", "years": "1990-1991"}],
        "per_gdp": [{"code": "R1", "years": "2024-2024"}],
    }
    assert write.unlisted_ratio_codes(collected(data), ctx.worlds) == {"per_million": [], "per_gdp": []}  # MG, WD


# Scale ratios (Task 3a): entity, group, map, overview and manifest outputs

def ratio_id_query(ratio_id):
    return {definition.id: definition for definition in RATIO_SERIES}[ratio_id]


def test_entity_ratios():
    data = make_data()
    origin = data["origin_apps"]
    origin.values["MG"]["resident"][2024] = 25
    origin.values["LU"] = {"total": ramp(100, 0), "resident": ramp(90, 0), "abroad": ramp(10, 0)}
    origin.labels["LU"] = "Luxembourg"
    denominators = wdi_denominators()
    denominators["population"].values["MG"][2024] = 31_250_000.0
    denominators["population"].values["LU"] = {**dict.fromkeys(WDI_YEARS), 2024: 1_000_000.0}  # exactly WIPO's floor
    ratios = wipo_ratios(data, denominators)
    ratios["per_million"].values["CH"][2024] = 64.0  # WIPO's value; ours 510 / 8 = 63.75 -> 63.8
    ratios["per_million"].values["LU"] = {**{year: 90.0 for year in RATIO_YEARS}, 2024: None}
    out = build_outputs(collected(data, ratios=ratios, denominators=denominators), RELEASES, RETRIEVED, "abc")
    ch = out[Path("entity/CH.json")]
    assert set(ch["ratios"]) == {"per_million", "per_gdp", "pct_per_million"}
    per_million = ch["ratios"]["per_million"]
    assert set(per_million) == {"value", "computed", "null_reason"}
    assert per_million["value"]["2024"] == 64.0 and 2024 not in per_million["computed"]  # WIPO first
    assert list(per_million["value"]) == [str(year) for year in RATIO_YEARS]  # RATIO_FROM..top_year
    assert per_million["null_reason"]["1990"] == "no_population"
    mg = out[Path("entity/MG.json")]["ratios"]["per_million"]
    assert mg["value"]["2024"] == 0.8 and mg["computed"] == [2024]  # 25 x 1e6 / 31.25 M
    assert mg["null_reason"]["2023"] == "no_applications"
    lu = out[Path("entity/LU.json")]["ratios"]["per_million"]
    assert lu["value"]["2024"] is None and lu["null_reason"] == {"2024": "below_wipo_threshold"}
    assert lu["value"]["2023"] == 90.0 and lu["computed"] == []  # WIPO's own value kept
    definition = ratio_id_query("per_million")
    assert definition.indicator == "101"
    assert ch["sources"]["per_million"] == {
        "name": "WIPO Statistics Database", "url": "https://www3.wipo.int/ipstats/", "tab": "ips",
        "query": definition.query_words, "entity": "CH", "years": f"{RATIO_FROM}-2024"}
    assert ch["sources"]["per_gdp"]["query"] == ratio_id_query("per_gdp").query_words
    assert "pct_per_million" not in ch["sources"] and "pct_origin" in ch["sources"]  # PCT per million: pct_origin
    for code in ("SU", "EP"):  # historical, regional office: no ratios
        assert "ratios" not in out[Path(f"entity/{code}.json")]
    va = out[Path("entity/VA.json")]["ratios"]  # country without origin counts or WDI row
    assert set(va["per_gdp"]["null_reason"].values()) == {"no_gdp"} and va["per_gdp"]["computed"] == []


def test_group_ratios_n_of_m(monkeypatch):
    data = make_data()
    origin = data["origin_apps"]
    origin.values["LU"] = {"total": ramp(100, 0), "resident": ramp(90, 0), "abroad": ramp(10, 0)}
    origin.values["DE"] = {"total": ramp(6000, 0), "resident": ramp(5000, 0), "abroad": ramp(1000, 0)}  # no WDI row
    origin.labels.update({"LU": "Luxembourg", "DE": "Germany"})
    denominators = wdi_denominators()
    denominators["population"].values["LU"] = {**dict.fromkeys(WDI_YEARS), 2024: 1_000_000.0}  # no threshold in sums

    def group_ratios():
        out = build_outputs(collected(data, denominators=denominators), RELEASES, RETRIEVED, "abc")
        return out[Path("group/155.json")]["ratios"]  # Western Europe: CH, DE, LU listed for origin_apps

    floored = group_ratios()["per_million"]  # fixture: grouped origin sum far below WD -> attribution floor
    assert floored["value"]["2024"] is None and floored["null_reason"]["2024"] == "attribution_floor"
    assert floored["reporting"]["2024"] == 2  # still counted
    monkeypatch.setattr(groups, "GROUP_ATTRIBUTION_MIN", 0.0)
    ratios = group_ratios()
    assert set(ratios) == {"per_million", "per_gdp", "pct_per_million"}
    per_million = ratios["per_million"]
    assert set(per_million) == {"value", "reporting", "members", "null_reason"}
    assert (per_million["members"], per_million["reporting"]["2024"]) == (3, 2)
    assert per_million["value"]["2024"] == 66.7  # (510 + 90) x 1e6 / (8 M + 1 M) = 66.67
    assert per_million["null_reason"]["1990"] == "none_reported" and per_million["reporting"]["2023"] == 1
    pct = ratios["pct_per_million"]  # PCT member totals: CH only listed for pct_origin
    assert (pct["members"], pct["reporting"]["2024"], pct["value"]["2024"]) == (1, 1, 513.8)  # 4110 / 8 M
    assert pct["value"]["2025"] == 515.0  # PCT a year ahead of origin
    europe = build_outputs(collected(data, denominators=denominators), RELEASES, RETRIEVED, "abc")[
        Path("group/europe.json")]["ratios"]
    assert europe["pct_per_million"]["members"] == 1  # continents too, member sums (not the WIPO R row)
    assert europe["per_gdp"]["members"] == 3


def test_group_ratio_below_threshold_end_to_end(monkeypatch):
    """Group file carries below_wipo_threshold when the reporting members' summed denominator <= WIPO's threshold."""
    data = make_data()
    origin = data["origin_apps"]
    origin.values["LU"] = {"total": ramp(100, 0), "resident": ramp(90, 0), "abroad": ramp(10, 0)}
    origin.labels.update({"LU": "Luxembourg"})
    denominators = wdi_denominators()
    denominators["population"].values["LU"] = {**dict.fromkeys(WDI_YEARS), 2024: 1_000_000.0}
    monkeypatch.setattr(groups, "GROUP_ATTRIBUTION_MIN", 0.0)
    monkeypatch.setitem(scale.WIPO_THRESHOLD, "population", 9_000_000)  # CH 8 M + LU 1 M = 9 M: at the threshold
    group = build_outputs(collected(data, denominators=denominators), RELEASES, RETRIEVED, "abc")[
        Path("group/155.json")]["ratios"]["per_million"]
    assert group["value"]["2024"] is None and group["null_reason"]["2024"] == "below_wipo_threshold"
    assert group["reporting"]["2024"] == 2  # still counted


def test_ratio_last_year_and_pct_a_year_ahead():
    out = outputs()  # PCT last 2025, origin 2024; WDI 2025 present
    ch = out[Path("entity/CH.json")]["ratios"]
    assert ch["pct_per_million"]["value"]["2025"] == 515.0 and 2025 in ch["pct_per_million"]["computed"]
    assert max(ch["per_million"]["value"]) == "2024" and max(ch["per_gdp"]["value"]) == "2024"  # top_year cut
    overview = out[Path("overview.json")]
    assert overview["ratio_last_year"] == {"per_million": 2024, "per_gdp": 2024, "pct_per_million": 2025}
    assert overview["world_ratios"]["pct_per_million"]["2025"] == 7.8  # ZZ 62400 / 8 bn
    denominators = wdi_denominators()
    for denominator in denominators.values():
        denominator.world[2025] = None
        for row in denominator.values.values():
            row[2025] = None
    out = build_outputs(collected(make_data(), denominators=denominators), RELEASES, RETRIEVED, "abc")
    pct = out[Path("entity/CH.json")]["ratios"]["pct_per_million"]
    assert pct["value"]["2025"] is None and pct["null_reason"]["2025"] == "no_population"
    overview = out[Path("overview.json")]
    assert overview["ratio_last_year"]["pct_per_million"] == 2024
    assert overview["world_ratios"]["pct_per_million"]["2025"] is None


def test_ratio_last_year_absent_when_no_country_value():
    data = make_data()
    ratios = wipo_ratios(data, wdi_denominators())
    for code in ("CH", "US"):
        ratios["per_gdp"].values[code] = dict.fromkeys(RATIO_YEARS)
    denominators = wdi_denominators()
    denominators["gdp_ppp"].values.clear()  # no WDI GDP row: nothing computed either
    out = build_outputs(collected(data, ratios=ratios, denominators=denominators), RELEASES, RETRIEVED, "abc")
    assert set(out[Path("overview.json")]["ratio_last_year"]) == {"per_million", "pct_per_million"}


def test_ratio_maps_overview_and_manifest():
    out = outputs()
    for ratio_id in ("per_million", "per_gdp"):
        ratio_map = out[Path(f"map/{ratio_id}.json")]
        assert set(ratio_map) == {"values", "computed", "null_reason", "sources"}
        assert set(ratio_map["values"]) == {"CH", "US", "MG", "VA"}  # countries only: no SU, EP, EU, WD
        for code, years in ratio_map["values"].items():
            entity = out[Path(f"entity/{code}.json")]["ratios"][ratio_id]
            assert years == entity["value"], (ratio_id, code)
            assert ratio_map["computed"][code] == entity["computed"], (ratio_id, code)
            assert ratio_map["null_reason"][code] == entity["null_reason"], (ratio_id, code)
        assert ratio_map["sources"] == {ratio_id: {**out[Path("entity/CH.json")]["sources"][ratio_id], "entity": None}}
    assert Path("map/pct_per_million.json") not in out  # map metrics: per million + per GDP (cards show PCT)
    overview = out[Path("overview.json")]
    wipo = wipo_ratios(make_data(), wdi_denominators())
    for ratio_id in ("per_million", "per_gdp"):
        assert overview["world_ratios"][ratio_id] == {str(year): value
                                                      for year, value in wipo[ratio_id].values["WD"].items()}
        assert overview["sources"][ratio_id]["entity"] == "WD"
        assert overview["sources"][ratio_id]["query"] == ratio_id_query(ratio_id).query_words
    assert overview["world_ratios"]["per_million"]["2024"] == 50.0  # 400000 / 8 bn
    assert overview["world_ratios"]["pct_per_million"]["2024"] == 7.8  # ZZ 62200 / 8 bn = 7.775
    assert min(overview["world_ratios"]["pct_per_million"]) == "2013"  # PCT first year (M3): no cells before
    assert overview["method"]["ratios"] == scale.method_constants()
    manifest = out[Path("manifest.json")]
    assert manifest["wdi_denominators"] == {
        "population": {"indicator": "SP.POP.TOTL", "name": POPULATION_NAME, "last_updated": "2026-10-08"},
        "gdp_ppp": {"indicator": "NY.GDP.MKTP.PP.KD", "name": GDP_NAME, "last_updated": "2026-10-08",
                    "gdp_base": 2021}}
    assert manifest["ratio_labels"] == {
        "per_million": "Resident applications per million population (by origin)",
        "per_gdp": "Resident applications per 100 billion USD GDP (by origin)"}


def test_wdi_last_updated_missing_and_gdp_base_required():
    denominators = wdi_denominators()
    denominators["population"].last_updated = None
    manifest = build_outputs(collected(denominators=denominators), RELEASES, RETRIEVED, "abc")[Path("manifest.json")]
    assert manifest["wdi_denominators"]["population"]["last_updated"] is None
    denominators["gdp_ppp"].name = "GDP, PPP (current international $)"  # label must never guess the base
    with pytest.raises(crosscheck.CheckError, match="base year"):
        build_outputs(collected(denominators=denominators), RELEASES, RETRIEVED, "abc")


def test_ratio_map_files_listed_unchanged_and_stale_removed(tmp_path):
    write_outputs(outputs(), tmp_path)
    assert {Path("map/per_million.json"), Path("map/per_gdp.json")} <= write._existing(tmp_path)
    assert not changed(outputs(), tmp_path)
    denominators = wdi_denominators()
    denominators["population"].values["MG"][2020] = 31_000_000.0  # MG has no counts: no output differs
    assert not changed(build_outputs(collected(denominators=denominators), RELEASES, RETRIEVED, "abc123"), tmp_path)
    data = make_data()
    data["origin_apps"].values["MG"]["resident"][2020] = 3  # now MG 2020 is computed: map and entity differ
    assert changed(build_outputs(collected(data, denominators=denominators), RELEASES, RETRIEVED, "abc123"),
                   tmp_path)
    without_gdp_map = {path: content for path, content in outputs().items() if path != Path("map/per_gdp.json")}
    assert changed(without_gdp_map, tmp_path)
    write_outputs(without_gdp_map, tmp_path)
    assert not (tmp_path / "map" / "per_gdp.json").exists() and (tmp_path / "map" / "per_million.json").exists()


def test_changed_on_wdi_update(tmp_path):
    """A new WDI vintage rewrites the data (GDP label names WDI's last-updated date), as a WIPO release does."""
    write_outputs(outputs(), tmp_path)
    denominators = wdi_denominators()
    for denominator in denominators.values():
        denominator.last_updated = datetime.date(2026, 12, 16)
    assert changed(build_outputs(collected(denominators=denominators), RELEASES, RETRIEVED, "abc123"), tmp_path)


def test_pct_per_million_years_start_at_pct_first_year():
    """Final review M3: PCT per million runs from the PCT series' first year (fixture 2013), never RATIO_FROM's
    earlier years (no "no applications" cells before PCT data); WIPO ratios still start at RATIO_FROM."""
    out = outputs()
    first = make_data()["pct_origin"].first_year
    assert first > RATIO_FROM
    ch = out[Path("entity/CH.json")]["ratios"]
    assert min(ch["pct_per_million"]["value"]) == str(first)
    assert min(ch["per_million"]["value"]) == str(RATIO_FROM)
    group = out[Path("group/155.json")]["ratios"]["pct_per_million"]
    assert min(group["value"]) == min(group["reporting"]) == str(first)
    assert min(out[Path("overview.json")]["world_ratios"]["pct_per_million"]) == str(first)


def test_ratio_no_denominator_lists_countries_without_any_wdi_value():
    """Final review I2: overview names the countries with no WDI population / GDP in any ratio year (methods page)."""
    denominators = wdi_denominators()
    denominators["population"].values["MG"] = dict.fromkeys(WDI_YEARS)  # row present, every year None
    out = build_outputs(collected(denominators=denominators), RELEASES, RETRIEVED, "abc")
    assert out[Path("overview.json")]["ratio_no_denominator"] == {"population": ["MG", "VA"], "gdp_ppp": ["VA"]}


# Women inventors (gender.py): WIPO shares, by publication year

COUNTRIES = {"CH", "US", "MG", "VA"}  # fixture country entities (DE: listed by WIPO, no entity file)


def test_gender_entity_equals_map_countries_only():
    out = outputs()
    for measure in gender.MEASURES:
        gender_map = out[Path(f"map/{measure}.json")]
        weights = {"pct_publications"} if measure == gender.WOMEN_ANY else set()  # ranking column, one file (4a)
        assert set(gender_map) == {"values", "null_reason", "sources"} | weights
        assert set(gender_map["values"]) == set(gender_map["null_reason"]) == COUNTRIES  # no SU, DE, ZZ, **, R*
        for code in COUNTRIES:
            block = out[Path(f"entity/{code}.json")]["gender"][measure]
            assert gender_map["values"][code] == block["value"], (measure, code)
            assert gender_map["null_reason"][code] == block["null_reason"], (measure, code)
        expected_sources = {measure: {**out[Path("entity/CH.json")]["sources"][measure], "entity": None}}
        if weights:
            assert gender_map["pct_publications"] == {
                code: out[Path(f"entity/{code}.json")]["pct_publications"] for code in COUNTRIES}
            expected_sources["pct_publications"] = {**out[Path("entity/CH.json")]["sources"]["pct_publications"],
                                                    "entity": None}
        assert gender_map["sources"] == expected_sources


def test_gender_country_blocks():
    out = outputs()
    ch = out[Path("entity/CH.json")]
    assert set(ch["gender"]) == {"women_any", "women_share"}
    women_any = ch["gender"]["women_any"]
    assert set(women_any) == {"value", "null_reason"}
    assert list(women_any["value"]) == [str(year) for year in GENDER_YEARS]  # GENDER_FROM..gender last_year
    assert women_any["value"]["2025"] == 30.0  # WIPO's share as published
    assert women_any["value"][str(GENDER_GAP_YEAR)] is None
    assert women_any["null_reason"] == {str(GENDER_GAP_YEAR): "not_published"}
    assert ch["sources"]["women_any"] == {
        "name": "WIPO Statistics Database", "url": "https://www3.wipo.int/ipstats/", "tab": "pmh",
        "query": GENDER_SERIES[0].query_words, "entity": "CH", "years": f"{GENDER_FROM}-2025",
        "description": "PCT applications with at least one woman inventor, by publication year"}
    assert ch["sources"]["women_share"]["description"] == "Women's share of PCT inventors, by publication year"


def test_gender_entity_pct_publications():
    """Country entity carries its gender weights (pmh 1010, publication year) for the women ranking (Task 4a)."""
    out = outputs()
    ch = out[Path("entity/CH.json")]
    assert ch["pct_publications"] == {str(year): PUBLICATIONS["CH"] for year in GENDER_YEARS}
    assert ch["sources"]["pct_publications"] == {
        "name": "WIPO Statistics Database", "url": "https://www3.wipo.int/ipstats/", "tab": "pmh",
        "query": write.PCT_PUBLICATIONS_QUERY, "entity": "CH", "years": f"{GENDER_FROM}-2025",
        "description": "PCT publications, by publication year"}
    assert out[Path("entity/VA.json")]["pct_publications"] == {str(year): None for year in GENDER_YEARS}
    assert "pct_publications" not in out[Path("entity/EP.json")]


@pytest.mark.parametrize("code", ["VA", "MG"])  # VA: no WIPO row; MG: a row without any value
def test_gender_country_without_values_all_not_published(code):
    entity = outputs()[Path(f"entity/{code}.json")]
    for measure in gender.MEASURES:
        block = entity["gender"][measure]
        assert set(block["value"].values()) == {None}
        assert block["null_reason"] == {str(year): "not_published" for year in GENDER_YEARS}


def test_gender_never_for_aggregates_or_offices():
    out = outputs()
    assert not any(Path(f"entity/{code}.json") in out for code in ("ZZ", "**", *R_LABELS))
    assert "gender" not in out[Path("entity/EP.json")]  # regional office
    su = out[Path("entity/SU.json")]  # former entity WIPO lists: its shares as published (none here)
    assert set(su["gender"]) == {"women_any", "women_share"} and {"women_any", "women_share"} <= set(su["sources"])


def test_gender_former_entity_not_listed_has_no_block():
    tables = gender_tables()
    for measure in gender.MEASURES:
        del tables[measure].values["SU"]
    out = build_outputs(collected(gender_data=tables), RELEASES, RETRIEVED, "abc123")
    assert "gender" not in out[Path("entity/SU.json")]


def test_gender_group_blocks():
    out = outputs()
    europe = out[Path("group/europe.json")]
    women_any = europe["gender"]["women_any"]
    assert set(women_any) == {"value", "null_reason", "reporting", "members", "coverage", "wipo_years", "unlisted"}
    assert women_any["members"] == 2  # CH, DE: M49 members with a PCT publications row (I1)
    assert (women_any["value"]["2024"], women_any["reporting"]["2024"], women_any["coverage"]["2024"]) == (
        29.1, 2, 1.0)  # (30 x 1000 + 20 x 100) / 1100 = 29.09
    gap = str(GENDER_GAP_YEAR)  # only DE: 100 of 1100 publications
    assert (women_any["value"][gap], women_any["null_reason"][gap], women_any["coverage"][gap]) == (
        None, "low_coverage", 0.091)
    assert women_any["wipo_years"] == []
    women_share = europe["gender"]["women_share"]
    assert women_share["wipo_years"] == [2025]  # gender_published.json: WIPO's printed 2025 figure wins
    assert women_share["value"]["2025"] == gender.load_published()["women_share"]["europe"][2025]["value"]
    assert (women_share["reporting"]["2025"], women_share["coverage"]["2025"]) == (None, None)
    assert women_share["value"]["2024"] is None and women_share["null_reason"]["2024"] == "not_computable"
    assert "2025" not in women_share["null_reason"]
    printed = gender.load_published()["women_share"]["europe"][2025]
    assert europe["sources"]["women_share"]["printed"] == {"2025": {
        **gender.load_published()["source"], "figure": printed["figure"], "page": printed["page"]}}
    assert "printed" not in europe["sources"]["women_any"]
    for measure in gender.MEASURES:
        assert "by publication year" in europe["sources"][measure]["description"]
    assert europe["sources"]["women_any"]["description"].endswith(
        "computed from WIPO shares weighted by PCT publications")
    assert europe["sources"]["women_any"]["weights"] == write.PCT_PUBLICATIONS_QUERY
    assert "weights" not in europe["sources"]["women_share"]  # never weighted
    region = out[Path("group/155.json")]  # Western Europe: CH, DE; regions never take WIPO's continent figures
    assert region["gender"]["women_any"]["value"]["2024"] == 29.1
    assert region["gender"]["women_share"]["wipo_years"] == []
    assert set(region["gender"]["women_share"]["value"].values()) == {None}
    africa = out[Path("group/africa.json")]["gender"]["women_any"]  # MG counted, no share
    assert (africa["value"]["2024"], africa["null_reason"]["2024"], africa["reporting"]["2024"]) == (
        None, "none_reported", 0)


def test_gender_group_with_a_continents_members_takes_its_printed_figures():
    """M49 021 Northern America = continent northern-america (CA, US): same group, same WIPO figure (review 4b I1)."""
    assert sorted(m49.members("021")) == sorted(m49.members("northern-america"))
    out = outputs()
    region, continent = out[Path("group/021.json")], out[Path("group/northern-america.json")]
    for measure in gender.MEASURES:
        assert region["gender"][measure] == continent["gender"][measure], measure
        assert region["sources"][measure] == continent["sources"][measure], measure
    assert region["gender"]["women_share"]["wipo_years"] == [2025]
    assert out[Path("group/155.json")]["gender"]["women_share"]["wipo_years"] == []  # other regions: none


def test_gender_group_unlisted_members_and_overview_groups():
    """Groups name the M49 members outside m (no PCT publications row); overview.gender.groups sums them up with
    WIPO's printed figures, so the site needs no proxy list and no per-group fetch (Task 6)."""
    data = collected()
    del data["pct_publications"]["DE"]
    out = build_outputs(data, RELEASES, RETRIEVED, "abc123")
    expected = sorted(set(m49.members("europe")) - set(data["pct_publications"]))
    assert "DE" in expected and "CH" not in expected
    europe = out[Path("group/europe.json")]
    for measure in gender.MEASURES:
        assert europe["gender"][measure]["unlisted"] == expected, measure
    groups_summary = out[Path("overview.json")]["gender"]["groups"]
    assert groups_summary["europe"]["unlisted"] == expected
    assert groups_summary["europe"]["printed"] == {
        "women_share": {"2025": gender.load_published()["women_share"]["europe"][2025]["value"]}}
    assert groups_summary["021"]["printed"] == groups_summary["northern-america"]["printed"]
    assert out[Path("overview.json")]["gender"]["printed_source"] == gender.load_published()["source"]
    printed = gender.load_published()["women_share"]["europe"][2025]
    assert groups_summary["europe"]["printed_refs"] == {
        "women_share": {"2025": {"figure": printed["figure"], "page": printed["page"]}}}
    assert all(entry["unlisted"] or entry["printed"] for entry in groups_summary.values())  # only groups with either


def test_gender_group_member_missing_from_the_gender_table_counts_uncovered():
    """I1: members = M49 members with a PCT publications row, whether or not WIPO's 1040 table lists them; FR (not
    in the gender tables) holds 10000 publications: Europe covers 1100 / 11100 -> low_coverage, m counts FR."""
    data = collected()
    data["pct_publications"]["FR"] = dict.fromkeys(GENDER_YEARS, 10000)
    europe = build_outputs(data, RELEASES, RETRIEVED, "abc123")[Path("group/europe.json")]["gender"]
    women_any = europe["women_any"]
    assert (women_any["value"]["2024"], women_any["null_reason"]["2024"], women_any["coverage"]["2024"]) == (
        None, "low_coverage", 0.099)
    assert (women_any["members"], women_any["reporting"]["2024"]) == (3, 2)
    assert europe["women_share"]["members"] == 3


def test_gender_overview_and_manifest():
    out = outputs()
    overview = out[Path("overview.json")]["gender"]
    assert set(overview) == {"world", "by_field", "last_year", "groups", "printed_source"}
    assert set(overview["world"]) == {"women_any", "women_share"}
    assert overview["world"]["women_any"]["2025"] == 37.1  # WIPO's ZZ row as published
    assert list(overview["world"]["women_share"]) == [str(year) for year in GENDER_YEARS]
    assert len(overview["by_field"]) == 35
    assert overview["by_field"]["7"] == {"label": "Field 7", "value": 30.7}  # last year
    assert overview["last_year"] == {"women_any": 2025, "women_share": 2025, "women_any_by_field": 2025}
    sources = out[Path("overview.json")]["sources"]
    assert sources["women_any"]["entity"] == sources["women_share"]["entity"] == "ZZ"
    assert sources["women_any_by_field"]["entity"] is None
    assert sources["women_any_by_field"]["years"] == "2025-2025"  # M1: the overview shows the last year only
    for gender_id in ("women_any", "women_share", "women_any_by_field"):
        assert "by publication year" in sources[gender_id]["description"]
    assert out[Path("overview.json")]["method"]["gender"] == gender.method_constants()
    manifest = out[Path("manifest.json")]
    assert manifest["gender_labels"] == {item.id: " ".join(item.label_words) + " (by origin)" for item in GENDER_SERIES}


def test_gender_years_end_at_each_measures_last_year():
    tables = gender_tables()
    tables["women_share"].last_year = 2024
    for values in tables["women_share"].values.values():
        values.pop(2025)
    out = build_outputs(collected(gender_data=tables), RELEASES, RETRIEVED, "abc123")
    assert max(out[Path("entity/CH.json")]["gender"]["women_share"]["value"]) == "2024"
    assert max(out[Path("entity/CH.json")]["gender"]["women_any"]["value"]) == "2025"
    assert out[Path("group/europe.json")]["gender"]["women_share"]["wipo_years"] == []  # printed 2025 not shown
    assert out[Path("manifest.json")]["last_year"]["women_share"] == 2024


def test_gender_unknown_code_raises():
    tables = gender_tables()
    tables["women_any"].values["QQ"] = dict.fromkeys(GENDER_YEARS)
    with pytest.raises(ValueError):
        build_outputs(collected(gender_data=tables), RELEASES, RETRIEVED, "abc123")


def test_gender_incomplete_year_rejected():
    tables = gender_tables()
    tables["women_any"].last_year = RETRIEVED.year
    with pytest.raises(ValueError, match="women_any"):
        build_outputs(collected(gender_data=tables), RELEASES, RETRIEVED, "abc123")


def test_unlisted_gender_codes():
    assert write.unlisted_gender_codes(collected()) == [
        f"women_any DE: WIPO values {GENDER_FROM}-2025, no country entity (not shown)",
        f"women_share DE: WIPO values {GENDER_FROM}-2025, no country entity (not shown)"]
