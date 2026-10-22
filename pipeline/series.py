"""v0.1 series: what collect fetches from the WIPO Data Center, and the words the site shows for it.

Ids from the live API (research note §WIPO Data Center backend, probed 2026-10-19). `type_ids` = our
type key -> WIPO type id; pmh tables have no type column, so their one type is `parse.NO_TYPE`.
`API_LABELS` = indicator and report labels as the table's `recordInfo` echoes them; collect checks
them so a renumbered id fails loudly instead of fetching another series.
`TOTAL_ROW_CODES` = aggregate whose total must have a value in the last complete year (guard against a
truncated table). origin_apps has none: its list offers no world/total code and no R1-R6 (only EU and R7,
both with values: data check 2026-10-20 §1; an unlisted ZZ is echoed back but undocumented).
`RATIO_SERIES` = WIPO's own ratio indicators (ips, by origin, one decimal, no type column; research
`docs/research/2026-10-20-wipo-ratio-indicators.md` §2). Their API label is checked by words (`label_words`), not
whole: wording such as "(2017 PPP)" is stale and may change (R§4); `report_label` is checked exactly.
`GENDER_SERIES` = WIPO women-inventor shares (pmh 1040/1042 by origin, 1041 by technology field, world only), by
PUBLICATION year; `PCT_PUBLICATIONS_*` = pmh 1010 class "Total" by origin, the gender weights (same basis). Research
`docs/research/2026-10-21-wipo-women-inventors.md`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pipeline.parse import NO_TYPE

PATENT_APPLICATIONS = "1 - Total patent applications (direct and PCT national phase entries)"
PCT_BY_FILING_DATE = "1 - PCT applications by filing date"


@dataclass(frozen=True)
class SeriesDef:
    id: str
    tab: Literal["ips", "pmh"]
    indicator: str
    report_type: str
    type_ids: dict[str, str]
    label: str
    query_words: str

    @property
    def kind(self) -> Literal["origin", "office"]:
        """Entity column of the table: applicant's origin or filing office."""
        kind = _KIND_BY_REPORT.get((self.tab, self.report_type))
        if kind is None:
            raise ValueError(f"series {self.id}: no entity kind for {self.tab} report {self.report_type}")
        return kind


_KIND_BY_REPORT: dict[tuple[str, str], Literal["origin", "office"]] = {
    ("ips", "13"): "origin",
    ("ips", "11"): "office",
    ("pmh", "4001"): "origin",
}

SERIES: list[SeriesDef] = [
    SeriesDef(
        id="origin_apps",
        tab="ips",
        indicator="10",
        report_type="13",
        type_ids={"total": "910", "resident": "911", "abroad": "912"},
        label="Patent applications by applicant's origin",
        query_words=f"Patent tab; indicator {PATENT_APPLICATIONS}; report: total count by applicant's origin",
    ),
    SeriesDef(
        id="office_apps",
        tab="ips",
        indicator="10",
        report_type="11",
        type_ids={"total": "900", "resident": "901", "nonresident": "902"},
        label="Patent applications by filing office",
        query_words=f"Patent tab; indicator {PATENT_APPLICATIONS}; report: total count by filing office",
    ),
    SeriesDef(
        id="pct_origin",
        tab="pmh",
        indicator="1001",
        report_type="4001",
        type_ids={"total": NO_TYPE},
        label="PCT applications by applicant's origin (filing date)",
        query_words=f"PCT tab; indicator {PCT_BY_FILING_DATE}; report: yearly statistics; receiving office: Total",
    ),
]

API_LABELS: dict[str, tuple[str, str]] = {
    "origin_apps": (PATENT_APPLICATIONS, "Total count by applicant's origin"),
    "office_apps": (PATENT_APPLICATIONS, "Total count by filing office"),
    "pct_origin": (PCT_BY_FILING_DATE, "Yearly statistics"),
}


@dataclass(frozen=True)
class RatioDef:
    id: str
    indicator: str
    report_type: str
    report_label: str  # recordInfo reportType, exact
    label_words: tuple[str, ...]  # each must appear in the recordInfo indicator
    label: str
    query_words: str


RATIO_FROM = 1990  # first year WIPO publishes ratio values: no PPP GDP earlier (R§2)
_RATIO_REPORT = "13"  # by applicant's origin, same report as origin_apps

RATIO_SERIES: list[RatioDef] = [
    RatioDef(
        id="per_gdp",
        indicator="100",
        report_type=_RATIO_REPORT,
        report_label=API_LABELS["origin_apps"][1],
        label_words=("Resident applications", "per 100 billion USD GDP"),
        label="Resident patent applications per $100 billion GDP (PPP)",
        query_words="Patent tab; indicator: resident applications per 100 billion USD GDP (by origin); "
                    "report: total count by applicant's origin",
    ),
    RatioDef(
        id="per_million",
        indicator="101",
        report_type=_RATIO_REPORT,
        report_label=API_LABELS["origin_apps"][1],
        label_words=("Resident applications", "per million population"),
        label="Resident patent applications per million population",
        query_words="Patent tab; indicator: resident applications per million population (by origin); "
                    "report: total count by applicant's origin",
    ),
]


RATIO_WORLD_CODE = "WD"  # World row of the ratio tables; must carry a value in the last year

TOTAL_ROW_CODES: dict[str, str] = {
    "office_apps": "WD",  # World
    "pct_origin": "ZZ",  # Total
}


@dataclass(frozen=True)
class GenderDef:
    id: str
    indicator: str
    by: Literal["origin", "field"]  # table rows: applicant's origin, or technology field (world only)
    label: str
    label_words: tuple[str, ...]  # each must appear in the recordInfo indicator; tell 1040 from 1041 apart
    query_words: str


GENDER_REPORT = "4001"
GENDER_REPORT_LABEL = API_LABELS["pct_origin"][1]  # "Yearly statistics"
GENDER_FROM = 2000  # first year WIPO publishes gender shares (research 2026-10-21 §2); a value earlier -> SchemaError
GENDER_WORLD_CODE = "ZZ"  # "Total": WIPO's World share, as published
GENDER_REGION_CODES = ("R1", "R2", "R3", "R4", "R5", "R6")  # listed, never valued (research §2): computed downstream
# origin rows with a value, countries only; live 2026-10-21: 89 (research §2, margin for a few dropped origins)
GENDER_MIN_COUNTRY_ROWS = 80
# country rows with a value in the last year >= this share of the year before's count. Live 2026-10-21: 71 of 72
# (0.986); worst year-on-year 2005-2025: 0.956 (research 2026-10-21 §2). Catches a table cut only in its last year.
GENDER_LAST_YEAR_ROW_SHARE_MIN = 0.85
GENDER_FIELD_IDS = tuple(str(field) for field in range(1, 36))  # 35 WIPO technology fields
_BY_PUBLICATION_YEAR = "report: yearly statistics, by publication year; receiving office: none (not sent)"

GENDER_SERIES: list[GenderDef] = [
    GenderDef(
        id="women_any",
        indicator="1040",
        by="origin",
        label="PCT applications with at least one woman inventor, by publication year",
        label_words=("Share of applications with at least one women inventor (yearly statistics)",),
        query_words="PCT tab; indicator 13 - Share of applications with at least one women inventor; "
                    f"{_BY_PUBLICATION_YEAR}",
    ),
    GenderDef(
        id="women_share",
        indicator="1042",
        by="origin",
        label="Women's share of PCT inventors, by publication year",
        label_words=("Share of women inventors",),
        query_words=f"PCT tab; indicator 15 - Share of women inventors; {_BY_PUBLICATION_YEAR}",
    ),
    GenderDef(
        id="women_any_by_field",
        indicator="1041",
        by="field",
        label="PCT applications with at least one woman inventor, by technology field (world), by publication year",
        label_words=("Share of applications with at least one women inventor by technology",),
        query_words="PCT tab; indicator 14 - Share of applications with at least one women inventor by technology; "
                    f"{_BY_PUBLICATION_YEAR}",
    ),
]

PCT_PUBLICATIONS_ID = "pct_publications"
PCT_PUBLICATIONS_INDICATOR = "1010"
PCT_PUBLICATIONS_LABEL_WORDS = ("PCT publications by language",)
PCT_PUBLICATIONS_CLASS_LABEL = "Total"  # all publication languages


def series_by_id(series_id: str) -> SeriesDef:
    for series in SERIES:
        if series.id == series_id:
            return series
    raise KeyError(series_id)
