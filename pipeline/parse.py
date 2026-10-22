"""Parse + validate WIPO Data Center responses (in memory; raw dicts from `WipoClient`).

This is the gate against malformed data: any unexpected shape raises `SchemaError`; nothing is
guessed or defaulted. Missing value = `None`, never 0.

Entity lists, two shapes:
- ips `loadOffOrgTechList`: keys `ipsOriginList` (rpType 13, origin) or `ipsOffList` (rpType 11,
  office); the other is null. `ipsTechList` {type id: label} = the series types; null for ratio indicators
  (ips 100/101) -> caller passes `types=False`.
- pmh `loadOffOrgClassList`: keys `pmhOriginList`, `pmhOffList` (receiving offices), both
  {code: label}, `ZZ` = "Total". No type list -> type map is empty.
`parse_entity_list` detects the shape from the keys; `tab` forces one (wrong shape -> SchemaError).
pmh `pmhClassList` {id: label} (1041 technology fields, 1010 publication languages) -> `parse_class_list`.

Tables: entity column = `selectedOrigin` or `selectedOffice`; ips adds `selectedTechnology`.
pmh tables carry BOTH `selectedOrigin` and `selectedOffice`: entity = origin, and the receiving
office must be the total row (label `PMH_TOTAL_OFFICE_LABEL`); any other RO row -> SchemaError.
Tables without `selectedTechnology` (pmh, ips ratio indicators) yield cells with `type_id == NO_TYPE`; the
caller passes `type_labels={}` and `requested_types={NO_TYPE}`. Counts parse as int (`parse_value`); ratio
tables send decimals ("1505.6") -> `decimals=True` (`parse_decimal`, float); women-inventor shares ("33.0") ->
`shares=True` (`parse_share`, 0-100).
pmh gender/publication tables (requested without `pmhOffSelValues`) have no `selectedOffice`. `selectedClass` is the
entity column of the world-only field table (kind "field", 1041) and the type column of an origin table (1010).
Year columns must be 4-digit years; monthly columns ("2025/1") are not parsed here.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Literal

MIN_ENTITIES = 150  # real lists; tests pass `min_entities` or patch this
NO_TYPE = "none"  # type_id of cells from tables without a type column (pmh)
PMH_TOTAL_OFFICE_LABEL = "Total"

_ENTITY_LIST_KEYS = {
    ("ips", "origin"): "ipsOriginList",
    ("ips", "office"): "ipsOffList",
    ("pmh", "origin"): "pmhOriginList",
    ("pmh", "office"): "pmhOffList",
}
_TYPE_LIST_KEY = "ipsTechList"
_ENTITY_COLUMN = {"origin": "selectedOrigin", "office": "selectedOffice"}
_TYPE_COLUMN = "selectedTechnology"
_CLASS_COLUMN = "selectedClass"
_CLASS_LIST_KEY = "pmhClassList"
_DIMENSION_COLUMNS = {"selectedOrigin", "selectedOffice", _TYPE_COLUMN, _CLASS_COLUMN}
_SEQ_ORDER_SUFFIX = "_SeqOrder"
_YEAR_PATTERN = re.compile(r"^\d{4}$")
# Plain digits, or thousands groups of exactly 3. Rejects the garbled concatenation WIPO
# returns for a missing RO filter ("1,1,1,2,209,..."), which would otherwise parse as a huge int.
_INTEGER_PART = r"(0|[1-9]\d*|[1-9]\d{0,2}(,\d{3})+)"
_VALUE_PATTERN = re.compile(rf"^{_INTEGER_PART}(\.0+)?$")  # counts: integer, ".0" tail allowed
# ratios: at most one decimal (WIPO's published precision); "1.505" is a de-locale thousands group, not 1.505
_DECIMAL_PATTERN = re.compile(rf"^{_INTEGER_PART}(\.\d)?$")
# shares: percent, one decimal, never a thousands separator ("1,100" = garbled)
_SHARE_PATTERN = re.compile(r"^(0|[1-9]\d{0,2})(\.\d)?$")


class SchemaError(Exception):
    """Response shape or content is not what the pipeline expects."""


@dataclass(frozen=True)
class Entity:
    code: str
    label: str


@dataclass(frozen=True)
class Cell:
    code: str
    type_id: str
    year: int
    value: int | float | None  # float only from decimals tables


def _normalize_label(label: object, what: str) -> str:
    if not isinstance(label, str):
        raise SchemaError(f"{what}: label is not a string: {label!r}")
    normalized = html.unescape(label).strip()
    if not normalized:
        raise SchemaError(f"{what}: empty label")
    return normalized


def _number_text(s: str | int | None, pattern: re.Pattern[str]) -> str | int | None:
    """None, a non-negative JSON int, or the value string without thousands commas; "" / "-" -> None.
    float/bool/negative or a string not matching `pattern` -> SchemaError."""
    if s is None:
        return None
    if isinstance(s, int) and not isinstance(s, bool):
        if s < 0:
            raise SchemaError(f"negative value: {s!r}")
        return s
    if not isinstance(s, str):
        raise SchemaError(f"value is not a string, int or null: {s!r}")
    text = s.strip()
    if text in ("", "-"):
        return None
    if not pattern.match(text):
        raise SchemaError(f"unparseable value: {s!r}")
    return text.replace(",", "")


def parse_value(s: str | int | None) -> int | None:
    """Counts. WIPO sends strings; a JSON int is accepted (non-negative). float/bool/decimal part -> SchemaError."""
    number = _number_text(s, _VALUE_PATTERN)
    return int(number.split(".")[0]) if isinstance(number, str) else number


def parse_decimal(s: str | int | None) -> float | None:
    """Ratio values ("1505.6", "0.1"): digits, optional thousands groups, optional decimal part. A JSON int is
    accepted (non-negative). "" / "-" / None -> None; float/bool/negative/garbled -> SchemaError."""
    number = _number_text(s, _DECIMAL_PATTERN)
    return None if number is None else float(number)


def parse_share(s: str | int | None) -> float | None:
    """Women-inventor shares (percent, "33.0"): 0 <= value <= 100, at most one decimal, no thousands separator.
    "" / "-" / None -> None; "1,100", "1.05", "100.1", negative -> SchemaError."""
    number = _number_text(s, _SHARE_PATTERN)
    if number is None:
        return None
    value = float(number)
    if not 0 <= value <= 100:
        raise SchemaError(f"share outside 0-100: {s!r}")
    return value


def _label_map(raw_map: object, what: str) -> dict[str, str]:
    """{id: raw label} -> {normalized label: id}; duplicate labels are ambiguous -> SchemaError."""
    if not isinstance(raw_map, dict) or not raw_map:
        raise SchemaError(f"{what}: missing, null or empty")
    label_to_id: dict[str, str] = {}
    for key, raw_label in raw_map.items():
        if not isinstance(key, str) or not key.strip():
            raise SchemaError(f"{what}: bad id {key!r}")
        label = _normalize_label(raw_label, f"{what}[{key}]")
        if label in label_to_id:
            raise SchemaError(f"{what}: duplicate label {label!r} ({label_to_id[label]}, {key})")
        label_to_id[label] = key
    return label_to_id


def parse_entity_list(
    raw: dict,
    kind: Literal["origin", "office"],
    tab: Literal["ips", "pmh"] | None = None,
    *,
    min_entities: int | None = None,
    types: bool = True,
) -> tuple[list[Entity], dict[str, str]]:
    """Entities (list order = sorted by code) and type label -> type id ({} for pmh). types=False skips
    `ipsTechList` (null for ratio indicators) and returns {}."""
    if kind not in ("origin", "office"):
        raise SchemaError(f"unknown entity kind {kind!r}")
    if not isinstance(raw, dict):
        raise SchemaError("entity list is not an object")
    if tab is None:
        shapes = [t for t in ("ips", "pmh") if _ENTITY_LIST_KEYS[(t, kind)] in raw]
        if len(shapes) != 1:
            raise SchemaError(f"entity list shape not recognised for kind {kind!r}: keys {sorted(raw)}")
        tab = shapes[0]
    entity_key = _ENTITY_LIST_KEYS.get((tab, kind))
    if entity_key is None:
        raise SchemaError(f"unknown tab {tab!r}")
    label_to_code = _label_map(raw.get(entity_key), entity_key)
    entities = sorted((Entity(code, label) for label, code in label_to_code.items()), key=lambda e: e.code)
    minimum = MIN_ENTITIES if min_entities is None else min_entities
    if len(entities) < minimum:
        raise SchemaError(f"{entity_key}: {len(entities)} entities, expected at least {minimum}")
    type_labels = _label_map(raw.get(_TYPE_LIST_KEY), _TYPE_LIST_KEY) if tab == "ips" and types else {}
    return entities, type_labels


def parse_class_list(raw: dict) -> list[Entity]:
    """pmh `pmhClassList` {id: label} -> entities in numeric id order, labels unescaped. Missing, null, empty or
    duplicate labels -> SchemaError."""
    if not isinstance(raw, dict):
        raise SchemaError("class list is not an object")
    label_to_id = _label_map(raw.get(_CLASS_LIST_KEY), _CLASS_LIST_KEY)
    return sorted((Entity(class_id, label) for label, class_id in label_to_id.items()),
                  key=lambda e: (0, int(e.code), "") if e.code.isdigit() else (1, 0, e.code))


SEQ_ORDER_SHARE_TOLERANCE = 0.5  # shares: WIPO's sort key is the value rounded to an integer


def check_seq_order(raw: dict, what: str, *, shares: bool = False) -> None:
    """Per row, where `<year>_SeqOrder` keys exist: (1) as many non-null sort keys as non-null values; (2) per cell
    the sort key equals the value (counts) or is within SEQ_ORDER_SHARE_TOLERANCE of it (shares).
    Mismatch = garbled table (research 2026-10-19: missing RO filter doubles `_SeqOrder`, concatenates values) ->
    SchemaError. A value that does not parse is skipped here: parse_table rejects it with its own message."""
    _, records = validated_columns(raw)
    for index, record in enumerate(records):
        years = [key for key in record if _YEAR_PATTERN.match(key)]
        if not any(f"{year}{_SEQ_ORDER_SUFFIX}" in record for year in years):
            continue
        values = sum(1 for year in years if record[year] not in (None, "", "-"))
        orders = sum(1 for year in years if record.get(f"{year}{_SEQ_ORDER_SUFFIX}") is not None)
        if values != orders:
            raise SchemaError(f"{what}: record {index} _SeqOrder count {orders} != value count {values} (garbled?)")
        for year in years:
            order = record.get(f"{year}{_SEQ_ORDER_SUFFIX}")
            if order is None:
                continue
            if isinstance(order, bool) or not isinstance(order, (int, float)):
                raise SchemaError(f"{what}: record {index} {year}_SeqOrder is not a number: {order!r}")
            try:
                value = parse_share(record[year]) if shares else parse_value(record[year])
            except SchemaError:
                continue
            if value is None:
                continue
            tolerance = SEQ_ORDER_SHARE_TOLERANCE if shares else 0
            if abs(order - value) > tolerance + 1e-9:
                raise SchemaError(f"{what}: record {index} {year} _SeqOrder {order} != value {record[year]!r} "
                                  "(garbled?)")


def validated_columns(raw: dict) -> tuple[list[dict], list[dict]]:
    if not isinstance(raw, dict):
        raise SchemaError("table is not an object")
    # HTTP 200 with all three null = WIPO's way of saying "bad parameters"
    for key in ("recordInfo", "columns", "records"):
        if raw.get(key) is None:
            raise SchemaError(f"table: {key} missing or null")
    columns, records = raw["columns"], raw["records"]
    if not isinstance(raw["recordInfo"], dict):
        raise SchemaError("table: recordInfo is not an object")
    if not isinstance(columns, list) or not all(isinstance(c, dict) for c in columns):
        raise SchemaError("table: columns is not a list of objects")
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        raise SchemaError("table: records is not a list of objects")
    if not records:
        raise SchemaError("table: records is empty")
    return columns, records


def parse_table(
    raw: dict,
    entities: list[Entity],
    type_labels: dict[str, str],
    requested_codes: set[str],
    requested_types: set[str],
    *,
    requested_years: set[int] | None = None,
    kind: Literal["origin", "office", "field"] | None = None,
    allow_absent_rows: bool = False,
    decimals: bool = False,
    shares: bool = False,
) -> list[Cell]:
    """Cells for requested codes x types (all year columns).

    requested_years (optional): the table's year columns must equal this set exactly; a missing
    or an extra year -> SchemaError. kind (optional): "origin" needs a `selectedOrigin` column;
    "office" needs `selectedOffice` and no `selectedOrigin` (pmh RO-as-entity is not supported);
    "field" needs `selectedClass` and neither origin nor office (pmh 1041, world only);
    a mismatch -> SchemaError. Without kind the entity column is origin if present, else office.
    Type column: `selectedTechnology` (ips), else `selectedClass` beside an origin/office column (pmh 1010).
    allow_absent_rows: WIPO omits a (code, type) row that is all null over the requested years
    (live 2026-10-19: Holy See office; Holy See origin Total/Resident while Abroad present). True ->
    each absent requested row yields a None cell per year; a requested type in no row, or no
    requested code in any row, still raises (wrong request, not missing data). False -> SchemaError.
    decimals: values parsed with `parse_decimal` (ratio tables) instead of `parse_value` (counts).
    shares: values parsed with `parse_share` (women-inventor shares); not with decimals.
    """
    if not requested_codes or not requested_types:
        raise SchemaError("requested_codes and requested_types must not be empty")
    if kind not in (None, "origin", "office", "field"):
        raise SchemaError(f"unknown entity kind {kind!r}")
    if decimals and shares:
        raise ValueError("parse_table: decimals and shares are exclusive")
    columns, records = validated_columns(raw)
    parse_number = parse_share if shares else parse_decimal if decimals else parse_value

    column_codes: list[str] = []
    for column in columns:
        code = column.get("code")
        if not isinstance(code, str):
            raise SchemaError(f"table: column without code: {column!r}")
        if code in column_codes:
            raise SchemaError(f"table: duplicate column {code!r}")
        column_codes.append(code)
    years: list[str] = []
    for code in column_codes:
        if code in _DIMENSION_COLUMNS:
            continue
        if not _YEAR_PATTERN.match(code):
            raise SchemaError(f"table: column {code!r} is not a 4-digit year")
        years.append(code)
    if not years:
        raise SchemaError("table: no year columns")
    if requested_years is not None and {int(y) for y in years} != set(requested_years):
        raise SchemaError(f"table: year columns {sorted(years)} != requested {sorted(requested_years)}")

    has_origin = "selectedOrigin" in column_codes
    has_office = "selectedOffice" in column_codes
    has_class = _CLASS_COLUMN in column_codes
    if kind == "field":
        if has_origin or has_office or not has_class or _TYPE_COLUMN in column_codes:
            raise SchemaError("table: kind 'field' needs selectedClass and no origin, office or type column")
        entity_column, type_column = _CLASS_COLUMN, None
    else:
        if not has_origin and not has_office:
            raise SchemaError("table: no selectedOrigin or selectedOffice column")
        if kind == "origin" and not has_origin:
            raise SchemaError("table: kind 'origin' but no selectedOrigin column")
        if kind == "office" and (has_origin or not has_office):
            raise SchemaError("table: kind 'office' needs selectedOffice and no selectedOrigin column")
        if has_class and _TYPE_COLUMN in column_codes:
            raise SchemaError("table: both selectedTechnology and selectedClass columns")
        entity_column = "selectedOrigin" if has_origin else "selectedOffice"
        type_column = _TYPE_COLUMN if _TYPE_COLUMN in column_codes else _CLASS_COLUMN if has_class else None

    label_to_code: dict[str, str] = {}
    for entity in entities:
        label = _normalize_label(entity.label, f"entity {entity.code}")
        if label in label_to_code:
            raise SchemaError(f"entities: duplicate label {label!r}")
        label_to_code[label] = entity.code
    type_label_to_id = {_normalize_label(label, "type label"): type_id for label, type_id in type_labels.items()}

    cells: list[Cell] = []
    seen: set[tuple[str, str]] = set()
    for index, record in enumerate(records):
        where = f"record {index}"
        for column_code in column_codes:
            if column_code not in record:
                raise SchemaError(f"{where}: missing key {column_code!r}")
        if has_origin and has_office:
            office = _normalize_label(record["selectedOffice"], f"{where} selectedOffice")
            if office != PMH_TOTAL_OFFICE_LABEL:
                raise SchemaError(f"{where}: receiving office {office!r}, expected {PMH_TOTAL_OFFICE_LABEL!r}")
        label = _normalize_label(record[entity_column], f"{where} {entity_column}")
        if label not in label_to_code:
            raise SchemaError(f"{where}: unknown {entity_column} label {label!r}")
        code = label_to_code[label]
        if type_column is not None:
            type_label = _normalize_label(record[type_column], f"{where} {type_column}")
            if type_label not in type_label_to_id:
                raise SchemaError(f"{where}: unknown type label {type_label!r}")
            type_id = type_label_to_id[type_label]
        else:
            type_id = NO_TYPE
        if (code, type_id) in seen:
            raise SchemaError(f"{where}: duplicate row for {code!r} / {type_id!r}")
        seen.add((code, type_id))
        if code not in requested_codes or type_id not in requested_types:
            continue
        for year in years:
            try:
                value = parse_number(record[year])
            except SchemaError as error:
                raise SchemaError(f"{where} ({code}/{type_id}/{year}): {error}") from error
            cells.append(Cell(code, type_id, int(year), value))

    missing = sorted((code, type_id) for code in requested_codes for type_id in requested_types
                     if (code, type_id) not in seen)
    if missing and not allow_absent_rows:
        raise SchemaError(f"table: requested rows missing: {missing[:10]}{' ...' if len(missing) > 10 else ''}")
    if allow_absent_rows:
        types_in_rows = {type_id for _, type_id in seen}
        if not requested_types <= types_in_rows:
            raise SchemaError(f"table: requested type in no row: {sorted(requested_types - types_in_rows)}")
        if not requested_codes & {code for code, _ in seen}:
            raise SchemaError("table: no requested code in any row")
        for code, type_id in missing:
            cells.extend(Cell(code, type_id, int(year), None) for year in years)
    return cells
