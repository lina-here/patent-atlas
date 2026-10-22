"""Fetch the v0.1 series from the WIPO Data Center as complete-year series (raw data in memory only).

Flow, sequential via `WipoClient`: form controls (offered year range per tab) -> entity lists -> one
table per series (every listed code, full offered range) -> trim to complete years. Collect keeps
every listed code (aggregates too; later steps filter with `entities.classify`). Any unexpected
shape or label -> `parse.SchemaError`; nothing partial is returned.

Complete years: never the current year (caller passes today's UTC date) nor later; PCT also steps
back while the monthly report (4003, origin Total) lacks a month of the year.

`collect` -> {"series": {series id: SeriesData}, "pct_monthly": {year: 12 months}, "ratios": {ratio id:
RatioData}}: world PCT months (origin Total, RO Total), PCT first..last complete year, one request per year (data
note: no multi-year request tried). Ratios (`series.RATIO_SERIES`, ips 100/101): own entity list (no type list),
one table each without type selection, `RATIO_FROM`..ips offered last year, trimmed to ips' last complete year.
"pct_publications": code -> year -> PCT publications (pmh 1010 class "Total", by origin), the gender weights only.
"gender": {gender id: GenderData} (pmh 1040/1042 by origin, 1041 by field, world only). Both by PUBLICATION year,
requested WITHOUT `pmhOffSelValues` (with it: 0 rows), pmh first offered..last offered year, trimmed to the PCT last
complete year (gender: last year with a World value, at most one year earlier). Research
`docs/research/2026-10-21-wipo-women-inventors.md`.
"""
from __future__ import annotations

import datetime
import html
import re
from dataclasses import dataclass
from typing import Callable

from pipeline import parse
from pipeline.entities import classify
from pipeline.parse import NO_TYPE, Entity, SchemaError
from pipeline.series import (
    API_LABELS,
    GENDER_FIELD_IDS,
    GENDER_FROM,
    GENDER_LAST_YEAR_ROW_SHARE_MIN,
    GENDER_MIN_COUNTRY_ROWS,
    GENDER_REGION_CODES,
    GENDER_REPORT,
    GENDER_REPORT_LABEL,
    GENDER_SERIES,
    GENDER_WORLD_CODE,
    PCT_PUBLICATIONS_CLASS_LABEL,
    PCT_PUBLICATIONS_ID,
    PCT_PUBLICATIONS_INDICATOR,
    PCT_PUBLICATIONS_LABEL_WORDS,
    RATIO_FROM,
    RATIO_SERIES,
    RATIO_WORLD_CODE,
    SERIES,
    TOTAL_ROW_CODES,
    GenderDef,
    RatioDef,
    SeriesDef,
    series_by_id,
)
from pipeline.wipo_client import WipoClient

TAB_PARAMS = {"ips": {"selectedTab": "patent"}, "pmh": {"selectedTab": "pct"}}
SELECTION_PARAM = {
    ("ips", "origin"): "ipsOriSelValues",
    ("ips", "office"): "ipsOffSelValues",
    ("pmh", "origin"): "pmhOriSelValues",
}
PMH_ALL_OFFICES = "ZZ"  # receiving office Total; pmh tables garble values without it (research note)
PMH_TOTAL_LABEL = "Total"
PMH_MONTHLY_REPORT = "4003"
PMH_MONTHLY_LABEL = "Monthly statistics"
# PCT months lag ~2 months: in Jan-Feb the previous year is incomplete (1 step back). More steps =
# data trouble -> fail loudly.
MAX_INCOMPLETE_YEARS = 2
# Rows without data / requested rows; above -> truncated table suspected. Live 2026-10-19:
# origin 58/627, office 111/663, PCT 18/209.
MAX_ABSENT_ROW_SHARE = 0.25
# Ratio tables: origins with no value in any year / listed origins. Live 2026-10-20: 60/208 and 61/208 origins
# without any value (research 2026-10-20 §2: WIPO thresholds, historical codes); counts tables keep
# MAX_ABSENT_ROW_SHARE.
MAX_ABSENT_RATIO_ROW_SHARE = 0.35
_YEAR_PATTERN = re.compile(r"^\d{4}$")
_MONTH_PATTERN = re.compile(r"^(\d{4})/([1-9]|1[0-2])$")


@dataclass
class SeriesData:
    series: SeriesDef
    first_year: int
    last_year: int
    values: dict[str, dict[str, dict[int, int | None]]]  # code -> type key -> year -> value
    labels: dict[str, str]  # code -> WIPO label (unescaped), every code in values
    # requested (code, type) rows with no value in any requested year; WIPO omits such rows
    absent_rows: int


@dataclass
class RatioData:
    ratio: RatioDef
    first_year: int
    last_year: int
    values: dict[str, dict[int, float | None]]  # code -> year -> value (WD = World, as WIPO publishes it)
    labels: dict[str, str]  # code -> WIPO label (unescaped), every code in values
    api_label: str  # recordInfo indicator as echoed (wording beyond label_words not pinned)
    absent_rows: int  # listed origins with no value in any requested year


@dataclass
class GenderData:
    values: dict[str, dict[int, float | None]]  # code (origin, or field id "1".."35") -> year -> share in percent
    labels: dict[str, str]  # code -> WIPO label (unescaped), every code in values
    last_year: int  # last year with a World value (field table: any value); <= PCT publications' last year
    api_label: str  # recordInfo indicator as echoed


def _api_text(value: object) -> str:
    return html.unescape(value).strip() if isinstance(value, str) else ""


def _check_labels(raw: dict, indicator: str, report: str, what: str) -> None:
    info = raw.get("recordInfo")
    info = info if isinstance(info, dict) else {}
    for key, expected in (("indicator", indicator), ("reportType", report)):
        got = _api_text(info.get(key))
        if got != expected:
            raise SchemaError(f"{what}: recordInfo {key} {got!r}, expected {expected!r}")


def _year_range(client: WipoClient, tab: str) -> tuple[int, int]:
    """(first, last) year the tab offers; the from-year list must run without gaps to the to-year."""
    raw = client.get_json(f"{tab}-search/formcontrols", TAB_PARAMS[tab])
    lists = []
    for key in (f"{tab}FYears", f"{tab}ToYearList"):
        years = raw.get(key)
        if not isinstance(years, list) or not years or not all(
                isinstance(y, str) and _YEAR_PATTERN.match(y) for y in years):
            raise SchemaError(f"{tab} form controls: {key} is not a non-empty list of years: {years!r}")
        lists.append([int(y) for y in years])
    from_years, to_years = lists
    first, last = from_years[0], max(to_years)
    if from_years != list(range(first, first + len(from_years))) or from_years[-1] != last:
        raise SchemaError(f"{tab} form controls: from-years {from_years[0]}..{from_years[-1]} "
                          f"({len(from_years)}) do not run to to-year {last}")
    return first, last


def _entity_list(client: WipoClient, series: SeriesDef) -> tuple[list[Entity], dict[str, str]]:
    if series.tab == "ips":
        raw = client.get_json("ips-search/loadOffOrgTechList",
                              {"indicator": series.indicator, "rpType": series.report_type})
    else:
        raw = client.get_json("pmh-search/loadOffOrgClassList", {"indicator": series.indicator})
    entities, type_labels = parse.parse_entity_list(raw, series.kind, series.tab)
    if series.tab == "ips":
        # type ids must still mean what our keys say (catches renumbered or swapped ids)
        id_to_label = {type_id: label for label, type_id in type_labels.items()}
        for key, type_id in series.type_ids.items():
            label = id_to_label.get(type_id, "")
            if label.lower().replace("-", "") != key:
                raise SchemaError(f"{series.id}: type {type_id} is {label!r}, expected {key!r}")
    return entities, type_labels


def _table_params(series: SeriesDef, codes: list[str], first: int, last: int) -> dict[str, str]:
    params = {**TAB_PARAMS[series.tab], "indicator": series.indicator, "reportType": series.report_type,
              "fromYear": str(first), "toYear": str(last)}
    if series.tab == "pmh":
        params["pmhOffSelValues"] = PMH_ALL_OFFICES
    params[SELECTION_PARAM[(series.tab, series.kind)]] = ",".join(codes)
    if series.tab == "ips":
        params["ipsTechSelValues"] = ",".join(series.type_ids.values())
    return params


def _collect_series(client: WipoClient, series: SeriesDef, entities: list[Entity],
                    type_labels: dict[str, str], first: int, api_last: int, last: int) -> SeriesData:
    codes = [entity.code for entity in entities]
    raw = client.get_json(f"{series.tab}-search/table-result", _table_params(series, codes, first, api_last))
    cells = parse.parse_table(raw, entities, type_labels, set(codes), set(series.type_ids.values()),
                              requested_years=set(range(first, api_last + 1)), kind=series.kind,
                              allow_absent_rows=True)
    _check_labels(raw, *API_LABELS[series.id], series.id)
    by_cell = {(cell.code, cell.type_id, cell.year): cell.value for cell in cells}
    requested_rows = len(codes) * len(series.type_ids)
    absent_rows = sum(1 for code in codes for type_id in series.type_ids.values()
                      if all(by_cell[(code, type_id, year)] is None for year in range(first, api_last + 1)))
    if absent_rows > MAX_ABSENT_ROW_SHARE * requested_rows:
        raise SchemaError(f"{series.id}: {absent_rows}/{requested_rows} rows without data, above "
                          f"{MAX_ABSENT_ROW_SHARE:.0%} (truncated table?)")
    values = {
        code: {key: {year: by_cell[(code, type_id, year)] for year in range(first, last + 1)}
               for key, type_id in series.type_ids.items()}
        for code in codes
    }
    total_code = TOTAL_ROW_CODES.get(series.id)
    if total_code is not None:
        if total_code not in values:
            raise SchemaError(f"{series.id}: total row {total_code} not in the entity list")
        if values[total_code]["total"][last] is None:
            raise SchemaError(f"{series.id}: total row {total_code} has no value for {last} (truncated table?)")
    labels = {entity.code: entity.label for entity in entities}  # parse_entity_list unescaped them
    return SeriesData(series, first, last, values, labels, absent_rows)


def _check_label_words(raw: dict, what: str, label_words: tuple[str, ...], report_label: str) -> str:
    """Echoed indicator text; it must hold every `label_words` item, reportType must equal `report_label`."""
    info = raw.get("recordInfo")
    info = info if isinstance(info, dict) else {}
    indicator = _api_text(info.get("indicator"))
    missing = [word for word in label_words if word not in indicator]
    if missing:
        raise SchemaError(f"{what}: recordInfo indicator {indicator!r} lacks {missing}")
    report = _api_text(info.get("reportType"))
    if report != report_label:
        raise SchemaError(f"{what}: recordInfo reportType {report!r}, expected {report_label!r}")
    return indicator


def _check_ratio_labels(raw: dict, ratio: RatioDef) -> str:
    return _check_label_words(raw, ratio.id, ratio.label_words, ratio.report_label)


def _collect_ratio(client: WipoClient, ratio: RatioDef, api_last: int, last: int) -> RatioData:
    raw_list = client.get_json("ips-search/loadOffOrgTechList",
                               {"indicator": ratio.indicator, "rpType": ratio.report_type})
    entities, _ = parse.parse_entity_list(raw_list, "origin", "ips", types=False)
    codes = [entity.code for entity in entities]
    first = RATIO_FROM
    requested_years = range(first, api_last + 1)
    raw = client.get_json("ips-search/table-result", {  # no ipsTechSelValues: ratio tables have no type column
        **TAB_PARAMS["ips"], "indicator": ratio.indicator, "reportType": ratio.report_type,
        "fromYear": str(first), "toYear": str(api_last), SELECTION_PARAM[("ips", "origin")]: ",".join(codes)})
    cells = parse.parse_table(raw, entities, {}, set(codes), {NO_TYPE}, requested_years=set(requested_years),
                              kind="origin", allow_absent_rows=True, decimals=True)
    api_label = _check_ratio_labels(raw, ratio)
    by_cell = {(cell.code, cell.year): cell.value for cell in cells}
    absent_rows = sum(1 for code in codes if all(by_cell[(code, year)] is None for year in requested_years))
    if absent_rows > MAX_ABSENT_RATIO_ROW_SHARE * len(codes):
        raise SchemaError(f"{ratio.id}: {absent_rows}/{len(codes)} rows without data, above "
                          f"{MAX_ABSENT_RATIO_ROW_SHARE:.0%} (truncated table?)")
    values = {code: {year: by_cell[(code, year)] for year in range(first, last + 1)} for code in codes}
    if RATIO_WORLD_CODE not in values:
        raise SchemaError(f"{ratio.id}: world row {RATIO_WORLD_CODE} not in the entity list")
    if values[RATIO_WORLD_CODE][last] is None:
        raise SchemaError(f"{ratio.id}: world row {RATIO_WORLD_CODE} has no value for {last} (truncated table?)")
    labels = {entity.code: entity.label for entity in entities}
    return RatioData(ratio, first, last, values, labels, api_label, absent_rows)


def _classify_codes(codes: list[str], what: str) -> None:
    """Every listed code must be known (audit G12): a new WIPO code fails collect, never becomes a country."""
    for code in codes:
        try:
            classify(code)
        except ValueError as error:
            raise SchemaError(f"{what}: {error}") from error


def _pmh_table_params(indicator: str, first: int, api_last: int, selections: dict[str, str]) -> dict[str, str]:
    """Gender / publication table request: no `pmhOffSelValues` (with it WIPO returns 0 rows, research 2026-10-21)."""
    return {**TAB_PARAMS["pmh"], "indicator": indicator, "reportType": GENDER_REPORT, "fromYear": str(first),
            "toYear": str(api_last), **selections}


def _get_rows(client: WipoClient, what: str, params: dict[str, str], *, shares: bool = False) -> dict:
    """Table with at least one row and consistent `_SeqOrder` keys (count and per-cell magnitude). 0 rows -> SchemaError naming the request shape
    (WIPO changed which parameters it accepts)."""
    raw = client.get_json("pmh-search/table-result", params)
    records = raw.get("records") if isinstance(raw, dict) else None
    if records is None or records == []:
        shape = " ".join(f"{key}=<{len(value.split(','))} codes>" if key.endswith("SelValues") else f"{key}={value}"
                         for key, value in params.items())
        raise SchemaError(f"{what}: 0 rows for request {shape} (request shape changed?)")
    parse.check_seq_order(raw, what, shares=shares)
    return raw


def _collect_publications(client: WipoClient, first: int, api_last: int, last: int) -> dict[str, dict[int, int | None]]:
    """PCT publications by origin (pmh 1010, class "Total"), first..last; World row ZZ must have a value in last."""
    what = PCT_PUBLICATIONS_ID
    raw_list = client.get_json("pmh-search/loadOffOrgClassList", {"indicator": PCT_PUBLICATIONS_INDICATOR})
    entities, _ = parse.parse_entity_list(raw_list, "origin", "pmh")
    classes = {entity.label: entity.code for entity in parse.parse_class_list(raw_list)}
    if PCT_PUBLICATIONS_CLASS_LABEL not in classes:
        raise SchemaError(f"{what}: no class {PCT_PUBLICATIONS_CLASS_LABEL!r} in {sorted(classes)}")
    total_id = classes[PCT_PUBLICATIONS_CLASS_LABEL]
    codes = [entity.code for entity in entities]
    _classify_codes(codes, what)
    requested_years = range(first, api_last + 1)
    raw = _get_rows(client, what, _pmh_table_params(PCT_PUBLICATIONS_INDICATOR, first, api_last, {
        SELECTION_PARAM[("pmh", "origin")]: ",".join(codes), "pmhClassSelValues": total_id}))
    cells = parse.parse_table(raw, entities, classes, set(codes), {total_id}, requested_years=set(requested_years),
                              kind="origin", allow_absent_rows=True)
    _check_label_words(raw, what, PCT_PUBLICATIONS_LABEL_WORDS, GENDER_REPORT_LABEL)
    by_cell = {(cell.code, cell.year): cell.value for cell in cells}
    absent_rows = sum(1 for code in codes if all(by_cell[(code, year)] is None for year in requested_years))
    if absent_rows > MAX_ABSENT_ROW_SHARE * len(codes):
        raise SchemaError(f"{what}: {absent_rows}/{len(codes)} rows without data, above "
                          f"{MAX_ABSENT_ROW_SHARE:.0%} (truncated table?)")
    if GENDER_WORLD_CODE not in codes:
        raise SchemaError(f"{what}: World row {GENDER_WORLD_CODE} not in the entity list")
    if by_cell[(GENDER_WORLD_CODE, last)] is None:
        raise SchemaError(f"{what}: World row {GENDER_WORLD_CODE} has no value for {last} (truncated table?)")
    return {code: {year: by_cell[(code, year)] for year in range(first, last + 1)} for code in codes}


def _gender_entities(client: WipoClient, gender: GenderDef) -> tuple[list[Entity], dict[str, str]]:
    """Entities and table selection: every listed origin, or the 35 fields (no origin: WIPO has no country split)."""
    raw_list = client.get_json("pmh-search/loadOffOrgClassList", {"indicator": gender.indicator})
    if gender.by == "origin":
        entities, _ = parse.parse_entity_list(raw_list, "origin", "pmh")
        codes = [entity.code for entity in entities]
        _classify_codes(codes, gender.id)
        return entities, {SELECTION_PARAM[("pmh", "origin")]: ",".join(codes)}
    entities = parse.parse_class_list(raw_list)
    codes = [entity.code for entity in entities]
    if tuple(codes) != GENDER_FIELD_IDS:
        raise SchemaError(f"{gender.id}: field ids {codes} != 1..{len(GENDER_FIELD_IDS)} (WIPO changed the fields)")
    return entities, {"pmhClassSelValues": ",".join(codes)}


def _gender_last_year(gender: GenderDef, by_cell: dict[tuple[str, int], float | None], codes: list[str],
                      publications_last: int) -> int:
    """Last year with a World value (field table: any value): the publications' last year, or one earlier (WIPO's
    gender tables may lag a year without failing the refresh); else SchemaError."""
    def has_value(year: int) -> bool:
        rows = [GENDER_WORLD_CODE] if gender.by == "origin" else codes
        return any(by_cell.get((code, year)) is not None for code in rows)
    for year in (publications_last, publications_last - 1):
        if has_value(year):
            return year
    row = f"World row {GENDER_WORLD_CODE}" if gender.by == "origin" else "field table"
    raise SchemaError(f"{gender.id}: {row} has no value in {publications_last} nor {publications_last - 1}")


def _collect_gender(client: WipoClient, gender: GenderDef, first: int, api_last: int,
                    publications_last: int) -> GenderData:
    entities, selections = _gender_entities(client, gender)
    codes = [entity.code for entity in entities]
    requested_years = range(first, api_last + 1)
    raw = _get_rows(client, gender.id, _pmh_table_params(gender.indicator, first, api_last, selections),
                     shares=True)
    cells = parse.parse_table(raw, entities, {}, set(codes), {NO_TYPE}, requested_years=set(requested_years),
                              kind=gender.by, allow_absent_rows=gender.by == "origin", shares=True)
    api_label = _check_label_words(raw, gender.id, gender.label_words, GENDER_REPORT_LABEL)
    by_cell = {(cell.code, cell.year): cell.value for cell in cells}
    valued = {code for (code, _), value in by_cell.items() if value is not None}
    early = sorted({year for (_, year), value in by_cell.items() if value is not None and year < GENDER_FROM})
    if early:
        raise SchemaError(f"{gender.id}: values before {GENDER_FROM} ({early[:3]}): WIPO extended the series; "
                          "update GENDER_FROM and the research note")
    regions = sorted(valued & set(GENDER_REGION_CODES))
    if regions:
        raise SchemaError(f"{gender.id}: {regions} now carry values: WIPO publishes continent shares, use them (j43)")
    if gender.by == "origin":
        if GENDER_WORLD_CODE not in codes:
            raise SchemaError(f"{gender.id}: World row {GENDER_WORLD_CODE} not in the entity list")
        countries = sum(1 for code in valued if classify(code) == "country")
        if countries < GENDER_MIN_COUNTRY_ROWS:
            raise SchemaError(f"{gender.id}: {countries} country rows with a value, expected at least "
                              f"{GENDER_MIN_COUNTRY_ROWS} (truncated table?)")
    last = _gender_last_year(gender, by_cell, codes, publications_last)
    if gender.by == "origin":
        country_codes = [code for code in codes if classify(code) == "country"]
        in_last, in_before = (sum(1 for code in country_codes if by_cell.get((code, year)) is not None)
                              for year in (last, last - 1))
        if in_last < GENDER_LAST_YEAR_ROW_SHARE_MIN * in_before:
            raise SchemaError(f"{gender.id}: {in_last} country rows with a value in {last}, {in_before} in "
                              f"{last - 1}; need at least {GENDER_LAST_YEAR_ROW_SHARE_MIN:.0%} (table cut in its "
                              "last year?)")
    years = range(max(first, GENDER_FROM), last + 1)
    values = {code: {year: by_cell[(code, year)] for year in years} for code in codes}
    labels = {entity.code: entity.label for entity in entities}
    return GenderData(values, labels, last, api_label)


def complete_last_year(api_max_year: int, today: datetime.date,
                       monthly_complete: Callable[[int], bool] | None) -> int:
    """Newest complete year: <= api_max_year, < today's year; with monthly_complete (PCT), step back
    while it reports the year incomplete, at most MAX_INCOMPLETE_YEARS steps, then SchemaError."""
    year = min(api_max_year, today.year - 1)
    if monthly_complete is None:
        return year
    for _ in range(MAX_INCOMPLETE_YEARS + 1):
        if monthly_complete(year):
            return year
        year -= 1
    raise SchemaError(f"PCT monthly report: no complete year in {year + 1}..{year + MAX_INCOMPLETE_YEARS + 1}")


def _monthly_values(raw: dict, year: int) -> list[int | None]:
    """Values of `year`'s month columns, in month order, from the origin-Total monthly table."""
    columns, records = parse.validated_columns(raw)
    _check_labels(raw, API_LABELS["pct_origin"][0], PMH_MONTHLY_LABEL, "PCT monthly")
    codes = [column.get("code") for column in columns]
    if len(set(codes)) != len(codes):
        raise SchemaError(f"PCT monthly: duplicate columns {codes}")
    months: dict[int, list[int]] = {}
    for code in codes:
        if code in ("selectedOffice", "selectedOrigin"):
            continue
        match = _MONTH_PATTERN.match(code) if isinstance(code, str) else None
        if match is None:
            raise SchemaError(f"PCT monthly: column {code!r} is not a month 'YYYY/M'")
        months.setdefault(int(match.group(1)), []).append(int(match.group(2)))
    if set(months) != {year} or "selectedOffice" not in codes or "selectedOrigin" not in codes:
        raise SchemaError(f"PCT monthly: columns {codes[:4]}... are not origin/office + months of year {year}")
    if sorted(months[year]) != list(range(1, len(months[year]) + 1)):
        raise SchemaError(f"PCT monthly: {year} months {months[year]} are not 1..n")
    if len(records) != 1:
        raise SchemaError(f"PCT monthly: {len(records)} records, expected one record (origin Total)")
    record = records[0]
    for column in ("selectedOrigin", "selectedOffice"):
        label = _api_text(record.get(column))
        if label != PMH_TOTAL_LABEL:
            raise SchemaError(f"PCT monthly: {column[len('selected'):].lower()} {label!r}, expected Total")
    values = []
    for month in sorted(months[year]):
        code = f"{year}/{month}"
        if code not in record:
            raise SchemaError(f"PCT monthly: record lacks {code}")
        try:
            values.append(parse.parse_value(record[code]))
        except SchemaError as error:
            raise SchemaError(f"PCT monthly {code}: {error}") from error
    return values


def monthly_fn(client: WipoClient) -> Callable[[int], list[int | None]]:
    """months(year): PCT monthly report (origin Total, RO Total) values of the year's listed months, in month
    order. One request per year asked, cached."""
    pct = series_by_id("pct_origin")
    cache: dict[int, list[int | None]] = {}

    def months(year: int) -> list[int | None]:
        if year not in cache:
            raw = client.get_json("pmh-search/table-result", {
                **TAB_PARAMS["pmh"], "indicator": pct.indicator, "reportType": PMH_MONTHLY_REPORT,
                "fromYear": str(year), "toYear": str(year),
                "pmhOffSelValues": PMH_ALL_OFFICES, "pmhOriSelValues": PMH_ALL_OFFICES})
            cache[year] = _monthly_values(raw, year)
        return cache[year]

    return months


def monthly_complete_fn(client: WipoClient,
                        months: Callable[[int], list[int | None]] | None = None) -> Callable[[int], bool]:
    """is_complete(year): 12 non-null months. `months` (monthly_fn) shares its cache with pct_monthly."""
    months = months if months is not None else monthly_fn(client)

    def is_complete(year: int) -> bool:
        values = months(year)
        return len(values) == 12 and all(value is not None for value in values)

    return is_complete


def collect(client: WipoClient, today: datetime.date) -> dict:
    """{"series": every series in SERIES keyed by id, "pct_monthly": year -> 12 months (int | None; months the
    table does not list = None), "ratios": every RATIO_SERIES item keyed by id, "pct_publications": code -> year ->
    count, "gender": every GENDER_SERIES item keyed by id}. `today` = current UTC date."""
    ranges = {tab: _year_range(client, tab) for tab in ("ips", "pmh")}
    lists = {series.id: _entity_list(client, series) for series in SERIES}
    months = monthly_fn(client)
    monthly_complete = monthly_complete_fn(client, months)
    data: dict[str, SeriesData] = {}
    for series in SERIES:
        first, api_last = ranges[series.tab]
        last = complete_last_year(api_last, today, monthly_complete if series.tab == "pmh" else None)
        if last < first:
            raise SchemaError(f"{series.id}: no complete year (first {first}, last complete {last})")
        data[series.id] = _collect_series(client, series, *lists[series.id], first, api_last, last)
    pct = data["pct_origin"]
    pct_monthly = {year: (months(year) + [None] * 12)[:12] for year in range(pct.first_year, pct.last_year + 1)}
    ips_api_last = ranges["ips"][1]
    ratio_last = complete_last_year(ips_api_last, today, None)
    if ratio_last < RATIO_FROM:
        raise SchemaError(f"ratios: no complete year (first {RATIO_FROM}, last complete {ratio_last})")
    ratios = {ratio.id: _collect_ratio(client, ratio, ips_api_last, ratio_last) for ratio in RATIO_SERIES}
    pmh_first, pmh_api_last = ranges["pmh"]
    publications = _collect_publications(client, pmh_first, pmh_api_last, pct.last_year)
    gender = {item.id: _collect_gender(client, item, pmh_first, pmh_api_last, pct.last_year) for item in GENDER_SERIES}
    return {"series": data, "pct_monthly": pct_monthly, "ratios": ratios, "pct_publications": publications,
            "gender": gender}


def releases(client: WipoClient) -> dict[str, str]:
    """Release string per tab, "Last updated: <Month Year>"; ips and pmh each have their own endpoint."""
    return {tab: client.release_string(tab) for tab in ("ips", "pmh")}
