"""Series breaks WIPO publishes: years a country's data are not comparable with the year before (audit F1).

Entity yoy of a break year = null, reason `SERIES_BREAK` (write._derived); overview `series_breaks` = `listing()`,
so world, region and continent charts spanning year - 1 to year carry a footnote (they publish no growth rate).
`note` = our summary of WIPO's note, never shown as a quote (spec M4). Citation = WIPI 2025 as in golden.json
(test_write checks they agree). write.py adds each code's `label` to the overview entries (Includes <label>: ...).
"""
from __future__ import annotations

from pipeline import m49

SERIES_BREAK = "series_break"  # yoy_null_reason value

WIPI_2025_CITATION = ("World Intellectual Property Organization (WIPO) (2025). World Intellectual Property Indicators "
                      "2025. Geneva: WIPO. DOI: 10.34667/tind.58959")
WIPI_2025_URL = ("https://www.wipo.int/edocs/pubdocs/en/"
                 "wipo-pub-941-2025-en-world-intellectual-property-indicators-2025.pdf")

# Office and origin series (plan decision); PCT not affected: WIPO's note concerns China's office data.
SERIES_BREAKS: list[dict] = [
    {"code": "CN", "year": 2017, "series": ["office_apps", "origin_apps"],
     "note": ("China's data before 2017 are not comparable with later years owing to a change in methodology; "
              "WIPO does not report a 2017 growth rate at world level"),
     "citation": WIPI_2025_CITATION, "url": WIPI_2025_URL,
     "page": ("figure A1 note, p. 25 (PDF p. 27); 'Change in method of counting IP applications by CNIPA in 2017', "
              "p. 173 (PDF p. 175)")},
]


def break_years(code: str, series_id: str) -> set[int]:
    """Break years of a code in a series (yoy of each = null)."""
    return {entry["year"] for entry in SERIES_BREAKS if entry["code"] == code and series_id in entry["series"]}


def listing() -> list[dict]:
    """Each break + `groups` = its code's M49 region and continent (None dropped): the group charts it touches."""
    return [{**entry, "series": list(entry["series"]),
             "groups": [group for group in (m49.region_of(entry["code"]), m49.continent_of(entry["code"]))
                        if group is not None]}
            for entry in SERIES_BREAKS]
