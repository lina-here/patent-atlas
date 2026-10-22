"""Entity codes in WIPO lists: what each code is, and ISO 3166-1 alpha-3 for countries.

WIPO uses ISO 3166-1 alpha-2 for countries plus its own codes. Confirmed against the live origin and
office lists (ips + pmh), 2026-10-19. `ISO2_TO_ISO3` is the full ISO 3166-1 table (all officially
assigned codes), so a new WIPO country needs no edit. `classify` raises on a code in no set (a new
non-ISO WIPO code), so it fails the pipeline and the live test instead of being treated as a country.
"""
from __future__ import annotations

from typing import Literal

Kind = Literal["country", "regional_office", "aggregate", "historical"]

REGIONAL_OFFICES = frozenset({"EP", "OA", "AP", "EA", "GC"})
# Non-ISO groupings: EU members, R1-R7 (R1 Africa, R2 Asia, R3 Europe, R4 Latin America and the
# Caribbean, R5 Northern America, R6 Oceania, R7 Least Developed Countries), WD World, ZZ Total, ** Unknown.
AGGREGATES = frozenset({"EU", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "WD", "ZZ", "**"})
# Dissolved states: SU Soviet Union, YU Yugoslavia, DD German Democratic Republic, CS Czechoslovakia,
# ZR Zaire, AN Netherlands Antilles.
HISTORICAL = frozenset({"SU", "YU", "DD", "CS", "ZR", "AN"})

ISO2_TO_ISO3: dict[str, str] = {
    "AD": "AND", "AE": "ARE", "AF": "AFG", "AG": "ATG", "AI": "AIA",
    "AL": "ALB", "AM": "ARM", "AO": "AGO", "AQ": "ATA", "AR": "ARG",
    "AS": "ASM", "AT": "AUT", "AU": "AUS", "AW": "ABW", "AX": "ALA",
    "AZ": "AZE", "BA": "BIH", "BB": "BRB", "BD": "BGD", "BE": "BEL",
    "BF": "BFA", "BG": "BGR", "BH": "BHR", "BI": "BDI", "BJ": "BEN",
    "BL": "BLM", "BM": "BMU", "BN": "BRN", "BO": "BOL", "BQ": "BES",
    "BR": "BRA", "BS": "BHS", "BT": "BTN", "BV": "BVT", "BW": "BWA",
    "BY": "BLR", "BZ": "BLZ", "CA": "CAN", "CC": "CCK", "CD": "COD",
    "CF": "CAF", "CG": "COG", "CH": "CHE", "CI": "CIV", "CK": "COK",
    "CL": "CHL", "CM": "CMR", "CN": "CHN", "CO": "COL", "CR": "CRI",
    "CU": "CUB", "CV": "CPV", "CW": "CUW", "CX": "CXR", "CY": "CYP",
    "CZ": "CZE", "DE": "DEU", "DJ": "DJI", "DK": "DNK", "DM": "DMA",
    "DO": "DOM", "DZ": "DZA", "EC": "ECU", "EE": "EST", "EG": "EGY",
    "EH": "ESH", "ER": "ERI", "ES": "ESP", "ET": "ETH", "FI": "FIN",
    "FJ": "FJI", "FK": "FLK", "FM": "FSM", "FO": "FRO", "FR": "FRA",
    "GA": "GAB", "GB": "GBR", "GD": "GRD", "GE": "GEO", "GF": "GUF",
    "GG": "GGY", "GH": "GHA", "GI": "GIB", "GL": "GRL", "GM": "GMB",
    "GN": "GIN", "GP": "GLP", "GQ": "GNQ", "GR": "GRC", "GS": "SGS",
    "GT": "GTM", "GU": "GUM", "GW": "GNB", "GY": "GUY", "HK": "HKG",
    "HM": "HMD", "HN": "HND", "HR": "HRV", "HT": "HTI", "HU": "HUN",
    "ID": "IDN", "IE": "IRL", "IL": "ISR", "IM": "IMN", "IN": "IND",
    "IO": "IOT", "IQ": "IRQ", "IR": "IRN", "IS": "ISL", "IT": "ITA",
    "JE": "JEY", "JM": "JAM", "JO": "JOR", "JP": "JPN", "KE": "KEN",
    "KG": "KGZ", "KH": "KHM", "KI": "KIR", "KM": "COM", "KN": "KNA",
    "KP": "PRK", "KR": "KOR", "KW": "KWT", "KY": "CYM", "KZ": "KAZ",
    "LA": "LAO", "LB": "LBN", "LC": "LCA", "LI": "LIE", "LK": "LKA",
    "LR": "LBR", "LS": "LSO", "LT": "LTU", "LU": "LUX", "LV": "LVA",
    "LY": "LBY", "MA": "MAR", "MC": "MCO", "MD": "MDA", "ME": "MNE",
    "MF": "MAF", "MG": "MDG", "MH": "MHL", "MK": "MKD", "ML": "MLI",
    "MM": "MMR", "MN": "MNG", "MO": "MAC", "MP": "MNP", "MQ": "MTQ",
    "MR": "MRT", "MS": "MSR", "MT": "MLT", "MU": "MUS", "MV": "MDV",
    "MW": "MWI", "MX": "MEX", "MY": "MYS", "MZ": "MOZ", "NA": "NAM",
    "NC": "NCL", "NE": "NER", "NF": "NFK", "NG": "NGA", "NI": "NIC",
    "NL": "NLD", "NO": "NOR", "NP": "NPL", "NR": "NRU", "NU": "NIU",
    "NZ": "NZL", "OM": "OMN", "PA": "PAN", "PE": "PER", "PF": "PYF",
    "PG": "PNG", "PH": "PHL", "PK": "PAK", "PL": "POL", "PM": "SPM",
    "PN": "PCN", "PR": "PRI", "PS": "PSE", "PT": "PRT", "PW": "PLW",
    "PY": "PRY", "QA": "QAT", "RE": "REU", "RO": "ROU", "RS": "SRB",
    "RU": "RUS", "RW": "RWA", "SA": "SAU", "SB": "SLB", "SC": "SYC",
    "SD": "SDN", "SE": "SWE", "SG": "SGP", "SH": "SHN", "SI": "SVN",
    "SJ": "SJM", "SK": "SVK", "SL": "SLE", "SM": "SMR", "SN": "SEN",
    "SO": "SOM", "SR": "SUR", "SS": "SSD", "ST": "STP", "SV": "SLV",
    "SX": "SXM", "SY": "SYR", "SZ": "SWZ", "TC": "TCA", "TD": "TCD",
    "TF": "ATF", "TG": "TGO", "TH": "THA", "TJ": "TJK", "TK": "TKL",
    "TL": "TLS", "TM": "TKM", "TN": "TUN", "TO": "TON", "TR": "TUR",
    "TT": "TTO", "TV": "TUV", "TW": "TWN", "TZ": "TZA", "UA": "UKR",
    "UG": "UGA", "UM": "UMI", "US": "USA", "UY": "URY", "UZ": "UZB",
    "VA": "VAT", "VC": "VCT", "VE": "VEN", "VG": "VGB", "VI": "VIR",
    "VN": "VNM", "VU": "VUT", "WF": "WLF", "WS": "WSM", "YE": "YEM",
    "YT": "MYT", "ZA": "ZAF", "ZM": "ZMB", "ZW": "ZWE",
}


def classify(code: str) -> Kind:
    """Kind of a WIPO entity code. Unknown code -> ValueError (never guessed as a country)."""
    if code in REGIONAL_OFFICES:
        return "regional_office"
    if code in AGGREGATES:
        return "aggregate"
    if code in HISTORICAL:
        return "historical"
    if code in ISO2_TO_ISO3:
        return "country"
    raise ValueError(f"unknown WIPO entity code {code!r}: add it to pipeline/entities.py")


def iso3(code: str) -> str | None:
    """ISO 3166-1 alpha-3 for a country code; None for anything else."""
    return ISO2_TO_ISO3.get(code)
