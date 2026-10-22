"""Regression check of a refresh against the committed data (hand-made files in tmp_path; literal expected lines)."""
import copy
from pathlib import Path

from pipeline import regress, write
from pipeline.regress import Regression

LAST = {"office_apps": 2024, "origin_apps": 2024, "pct_origin": 2025}


def entity(code, label, origin_total):
    return {"code": code, "label": label, "kind": "country",
            "series": {"origin_apps": {"types": {"total": {str(year): value for year, value in origin_total.items()}},
                                       "derived": {}}}}


def outputs_with(entities=(), groups=(), world_office=None, last_year=None, world_last_year=None, top_year=None):
    """Minimal site data: manifest last_year, overview worlds (+ optional world_last_year, top_year), entity and
    group files."""
    outputs = {write.MANIFEST: {"last_year": dict(last_year or LAST)},
               write.OVERVIEW: {"world_office": world_office or {"2023": 1000, "2024": 1100}, "pct_world": {}}}
    if world_last_year is not None:
        outputs[write.OVERVIEW]["world_last_year"] = world_last_year
    if top_year is not None:
        outputs[write.OVERVIEW]["top_year"] = top_year
    for item in entities:
        outputs[write.ENTITY_DIR / f"{item['code']}.json"] = item
    for group_id, label in groups:
        outputs[write.GROUP_DIR / f"{group_id}.json"] = {"id": group_id, "label": label, "series": {}}
    return outputs


def commit(root: Path, outputs):
    for path, content in outputs.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(write.dumps(content), encoding="utf-8")


def swiss(**years):
    return entity("CH", "Switzerland", {2022: 1000, 2023: 1000, 2024: 1000, **{int(y[1:]): v for y, v in years.items()}})


def test_empty_root_no_lines(tmp_path):
    assert regress.compare(outputs_with([swiss()]), tmp_path) == Regression([], [], 0)
    commit(tmp_path, {path: content for path, content in outputs_with([swiss()]).items() if path != write.MANIFEST})
    assert regress.compare(outputs_with(), tmp_path) == Regression([], [], 0)  # files but no manifest: not compared


def test_unchanged_no_lines(tmp_path):
    commit(tmp_path, outputs_with([swiss()], [("155", "Western Europe")]))
    assert regress.compare(outputs_with([swiss()], [("155", "Western Europe")]), tmp_path) == Regression([], [], 0)


def test_last_year_moved_back_blocks(tmp_path):
    commit(tmp_path, outputs_with([swiss()]))
    result = regress.compare(outputs_with([swiss()], last_year={**LAST, "origin_apps": 2023}), tmp_path)
    assert result.blocking == ["last_year origin_apps moved back 2024 -> 2023"]
    later = regress.compare(outputs_with([swiss()], last_year={**LAST, "pct_origin": 2026}), tmp_path)
    assert later.blocking == []  # a later last year is the normal refresh


def test_entity_no_longer_published_blocks_with_code_and_label(tmp_path):
    commit(tmp_path, outputs_with([swiss(), entity("VA", "Holy See", {2024: None})]))
    result = regress.compare(outputs_with([swiss()]), tmp_path)
    assert result.blocking == ["entity VA (Holy See) no longer published"]


def test_group_no_longer_published_blocks(tmp_path):
    commit(tmp_path, outputs_with([swiss()], [("155", "Western Europe"), ("europe", "Europe")]))
    result = regress.compare(outputs_with([swiss()], [("europe", "Europe")]), tmp_path)
    assert result.blocking == ["group 155 (Western Europe) no longer published"]


def test_past_year_revision_above_threshold_listed(tmp_path):
    assert regress.REVISION_WARN_PCT == 5
    commit(tmp_path, outputs_with([swiss(), entity("DE", "Germany", {2022: 1000, 2024: 1000})]))
    new = outputs_with([swiss(y2022=1060), entity("DE", "Germany", {2022: 1050, 2024: 1000})])
    result = regress.compare(new, tmp_path)
    assert result.revisions == ["entity CH origin_apps total 2022: 1000 -> 1060 (+6.0%)"]  # DE: 5% is not above 5
    assert result.revision_count == 1 and result.blocking == []


def test_zero_to_value_and_withdrawn_listed(tmp_path):
    commit(tmp_path, outputs_with([swiss(y2022=0, y2023=900)]))
    result = regress.compare(outputs_with([swiss(y2022=3, y2023=None)]), tmp_path)
    assert result.revisions == ["entity CH origin_apps total 2023: 900 -> null (withdrawn)",
                                "entity CH origin_apps total 2022: 0 -> 3"]


def test_year_or_series_gone_from_published_entity_is_withdrawn(tmp_path):
    commit(tmp_path, outputs_with([swiss()]))
    shorter = swiss()
    del shorter["series"]["origin_apps"]["types"]["total"]["2022"]
    assert regress.compare(outputs_with([shorter]), tmp_path).revisions == [
        "entity CH origin_apps total 2022: 1000 -> null (withdrawn)"]
    bare = {**swiss(), "series": {}}
    assert regress.compare(outputs_with([bare]), tmp_path).revision_count == 2  # 2022, 2023; 2024 is the latest


def test_backfill_from_null_not_listed(tmp_path):
    commit(tmp_path, outputs_with([swiss(y2022=None)]))
    assert regress.compare(outputs_with([swiss(y2022=500)]), tmp_path) == Regression([], [], 0)


def test_latest_committed_year_not_compared(tmp_path):
    commit(tmp_path, outputs_with([swiss()], world_office={"2023": 1000, "2024": 1000}))
    new = outputs_with([swiss(y2024=2000)], world_office={"2023": 1000, "2024": 3000})
    assert regress.compare(new, tmp_path) == Regression([], [], 0)


def test_overview_world_revision_listed(tmp_path):
    commit(tmp_path, outputs_with([swiss()], world_office={"2022": 1000, "2023": 1000, "2024": 1000}))
    new = outputs_with([swiss()], world_office={"2022": 1000, "2023": 900, "2024": 1000})
    assert regress.compare(new, tmp_path).revisions == ["overview world_office 2023: 1000 -> 900 (-10.0%)"]


def test_many_revisions_capped_sorted_by_change_counted(tmp_path):
    assert regress.REVISION_LIST_MAX == 20
    years = range(1990, 2015)  # 25 past years
    commit(tmp_path, outputs_with([entity("CH", "Switzerland", {**{year: 1000 for year in years}, 2024: 1})]))
    revised = {year: 1000 + 100 + 10 * index for index, year in enumerate(years)}  # +10% .. +34%, larger later
    result = regress.compare(outputs_with([entity("CH", "Switzerland", {**revised, 2024: 1})]), tmp_path)
    assert result.revision_count == 25
    assert len(result.revisions) == 20
    assert result.revisions[0] == "entity CH origin_apps total 2014: 1000 -> 1340 (+34.0%)"
    assert result.revisions[-1] == "entity CH origin_apps total 1995: 1000 -> 1150 (+15.0%)"


def test_withdrawn_first_then_zero_base_then_by_change(tmp_path):
    commit(tmp_path, outputs_with([swiss(y2022=0, y2023=900), entity("DE", "Germany", {2022: 100, 2024: 1})]))
    new = outputs_with([swiss(y2022=3, y2023=None), entity("DE", "Germany", {2022: 300, 2024: 1})])
    assert regress.compare(new, tmp_path).revisions == [
        "entity CH origin_apps total 2023: 900 -> null (withdrawn)",
        "entity CH origin_apps total 2022: 0 -> 3",
        "entity DE origin_apps total 2022: 100 -> 300 (+200.0%)",
    ]


def test_withdrawn_survives_the_cap_behind_larger_revisions(tmp_path):
    years = range(1990, 2015)  # 25 past years, all revised +1000%
    commit(tmp_path, outputs_with([entity("CH", "Switzerland", {**{year: 100 for year in years}, 2015: 500, 2024: 1}),
                                   entity("ZZ", "Zedland", {2015: 700, 2024: 1})]))
    revised = {**{year: 1100 for year in years}, 2015: None, 2024: 1}
    result = regress.compare(outputs_with([entity("CH", "Switzerland", revised),
                                           entity("ZZ", "Zedland", {2015: None, 2024: 1})]), tmp_path)
    assert result.revision_count == 27
    assert result.revisions[:2] == ["entity CH origin_apps total 2015: 500 -> null (withdrawn)",
                                    "entity ZZ origin_apps total 2015: 700 -> null (withdrawn)"]
    assert len(result.revisions) == 20


def test_compare_leaves_outputs_unchanged(tmp_path):
    commit(tmp_path, outputs_with([swiss()]))
    new = outputs_with([swiss(y2022=2000)])
    before = copy.deepcopy(new)
    regress.compare(new, tmp_path)
    assert new == before


def test_world_revision_bounded_by_world_last_year_when_coverage_lags(tmp_path):
    lagging = {"world_office": 2023}  # coverage lags: world cut at 2023 while last_year.office_apps is 2024
    commit(tmp_path, outputs_with([swiss()], world_office={"2022": 1000, "2023": 1000}, world_last_year=lagging))
    new = outputs_with([swiss()], world_office={"2022": 1100, "2023": 1100}, world_last_year=lagging)
    # the newest world year (2023) is not compared; only 2022 is
    assert regress.compare(new, tmp_path).revisions == ["overview world_office 2022: 1000 -> 1100 (+10.0%)"]


def test_world_last_year_moved_back_blocks(tmp_path):
    commit(tmp_path, outputs_with([swiss()], world_last_year={"world_office": 2024, "pct_world": 2025}, top_year=2024))
    new = outputs_with([swiss()], world_last_year={"world_office": 2023, "pct_world": 2025}, top_year=2024)
    assert regress.compare(new, tmp_path).blocking == ["overview world_last_year world_office moved back 2024 -> 2023"]
    later = outputs_with([swiss()], world_last_year={"world_office": 2025, "pct_world": 2026}, top_year=2025)
    assert regress.compare(later, tmp_path).blocking == []


def test_top_year_moved_back_blocks(tmp_path):
    commit(tmp_path, outputs_with([swiss()], top_year=2024))
    result = regress.compare(outputs_with([swiss()], top_year=2023), tmp_path)
    assert result.blocking == ["overview top_year moved back 2024 -> 2023"]


# Women inventors: entity gender.<measure>.value and overview gender.world, shares in percent

GENDER_LAST = {**LAST, "women_any": 2025, "women_share": 2025, "women_any_by_field": 2025}


def with_gender(outputs, ch_shares=None, world_share=None):
    """`outputs` + CH gender women_any values and overview gender.world women_share (year -> share)."""
    if ch_shares is not None:
        ch = outputs[write.ENTITY_DIR / "CH.json"]
        ch["gender"] = {"women_any": {"value": {str(year): value for year, value in ch_shares.items()},
                                      "null_reason": {}}}
    if world_share is not None:
        outputs[write.OVERVIEW]["gender"] = {"world": {"women_share": {str(year): value
                                                                       for year, value in world_share.items()}}}
    return outputs


def test_gender_last_year_moved_back_blocks(tmp_path):
    commit(tmp_path, outputs_with([swiss()], last_year=GENDER_LAST))
    result = regress.compare(outputs_with([swiss()], last_year={**GENDER_LAST, "women_any_by_field": 2024}), tmp_path)
    assert result.blocking == ["last_year women_any_by_field moved back 2025 -> 2024"]


def test_gender_value_withdrawn_and_revision_listed(tmp_path):
    commit(tmp_path, with_gender(outputs_with([swiss()], last_year=GENDER_LAST),
                                 {2022: 2.0, 2023: 30.0, 2024: 31.0, 2025: 32.0}))
    new = with_gender(outputs_with([swiss()], last_year=GENDER_LAST),
                      {2022: 2.1, 2023: None, 2024: 33.0, 2025: 10.0})  # 2025: latest committed year, not compared
    assert regress.compare(new, tmp_path).revisions == [
        "entity CH women_any 2023: 30.0 -> null (withdrawn)",
        "entity CH women_any 2024: 31.0 -> 33.0 (+6.5%)",  # 2.0 -> 2.1: exactly 5% (exact decimal), not above
    ]


def test_gender_block_gone_is_withdrawn(tmp_path):
    commit(tmp_path, with_gender(outputs_with([swiss()], last_year=GENDER_LAST), {2024: 31.0, 2025: 32.0}))
    assert regress.compare(outputs_with([swiss()], last_year=GENDER_LAST), tmp_path).revisions == [
        "entity CH women_any 2024: 31.0 -> null (withdrawn)"]


def test_gender_world_revision_listed(tmp_path):
    commit(tmp_path, with_gender(outputs_with([swiss()], last_year=GENDER_LAST),
                                 world_share={2023: 18.0, 2024: 18.1, 2025: 18.1}))
    new = with_gender(outputs_with([swiss()], last_year=GENDER_LAST), world_share={2023: 19.0, 2024: 18.1, 2025: 18.1})
    assert regress.compare(new, tmp_path).revisions == ["overview world women_share 2023: 18.0 -> 19.0 (+5.6%)"]


def test_gender_not_compared_before_its_first_committed_last_year(tmp_path):
    """Data committed before Stage W has no gender last_year: nothing to compare, nothing blocks."""
    commit(tmp_path, with_gender(outputs_with([swiss()]), {2023: 30.0, 2024: 31.0}))
    new = with_gender(outputs_with([swiss()], last_year=GENDER_LAST), {2023: None, 2024: 31.0})
    assert regress.compare(new, tmp_path) == Regression([], [], 0)
