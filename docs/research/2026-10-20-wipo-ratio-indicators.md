# WIPO ratio indicators (per GDP, per population): what WIPO publishes, how to fetch, Stage B basis — 2026-10-20

Live probes 2026-10-20: WIPO Data Center API (~20 small requests, 1 s apart, same headers as `pipeline/wipo_client.py`),
World Bank API, WIPI 2025 PDF, WIPO statistical country profiles. Raw responses in scratch only, none in repo.
Releases at probe: ips "Last updated: May 2026"; country profiles "6/2026", ranking lists "7/2026"; WDI
`lastupdated` 2026-10-08. Numbers below = dated examples (retrieved 2026-10-20), not living values.

## 1. How the pipeline calls the API (for reuse)

- Base `API_BASE` = `https://api.ipstatsdc.deda.prd.web1.wipo.int/api/v1/public` (`pipeline/wipo_client.py:22`);
  headers Accept/Accept-Language en/Referer `https://www3.wipo.int/`/User-Agent; 1 s between requests.
- Form controls: `{tab}-search/formcontrols?selectedTab=patent|pct` (`collect.py:69-85`) -> `ipsIndicatorMap`,
  `ipsRpTypeMap`, `ipsFYears`, `ipsToYearList` (pmh: same with `pmh` prefix).
- Entity list: `ips-search/loadOffOrgTechList?indicator=<id>&rpType=<rp>`; pmh `pmh-search/loadOffOrgClassList?indicator=<id>` (`collect.py:88-95`).
- Table: `{tab}-search/table-result` with `selectedTab`, `indicator`, `reportType`, `fromYear`, `toYear`,
  `ipsOriSelValues`|`ipsOffSelValues`|`pmhOriSelValues`, ips `ipsTechSelValues` (type ids), pmh `pmhOffSelValues=ZZ`
  (`collect.py:106-114`). Labels checked against `recordInfo` (`collect.py:62-66`, `series.API_LABELS`).
- Current series (`pipeline/series.py:42-73`): ips 10 rp 13 types 910/911/912 (origin); ips 10 rp 11 types
  900/901/902 (office); pmh 1001 rp 4001 (PCT origin); pmh 4003 monthly. v0.2 spec adds ips 17/22/25/26, pmh
  1003/1040-1042.
- Front-end bundle `https://www3.wipo.int/ipstats/main.<hash>.js`: ips tab also serves `selectedTab=utility|trademark|industrial|geographical`
  on the same endpoints; `key-search/indicator` = landing page.

## 2. Ratio indicators WIPO publishes in the Data Center

Rule: only per-GDP and per-population, by origin, resident only. No per-R&D, no PCT ratio, no utility-model
ratio, no regional/income aggregates. Evidence: full `ipsIndicatorMap` of patent/utility/trademark/industrial tabs,
`pmhIndicatorMap` (30 PCT indicators, none a ratio), probed 2026-10-20.

| tab (`selectedTab`) | indicator | label (as API echoes, 2026-10-20) | reportType | first year with values |
|---|---|---|---|---|
| patent | 100 | "9 - Resident applications per 100 billion USD GDP (2017 PPP) (by origin)" | 13 | 1990 |
| patent | 101 | "10 - Resident applications per million population (by origin)" | 13 | 1990 |
| trademark | 103 | "8 - Resident class count per 100 billion USD GDP (2017 PPP) (by origin)" | 13 | 2004 (CH, CN, KR) |
| trademark | 104 | "9 - Resident class count per million population (by origin)" | 13 | 2004 (CH, CN, KR) |
| industrial | 105 | "8 - Resident design count per 100 billion USD GDP (2017 PPP) (by origin)" | 13 | 1990 (CN); varies |
| industrial | 106 | "9 - Resident design count per million population (by origin)" | 13 | 1990 (CN); varies |
| utility | — | none (6 indicators, counts only) | | |
| pct (pmh) | — | none | | |

Fetch (patents):
```
ips-search/loadOffOrgTechList?indicator=100&rpType=13          -> ipsOriginList (208 codes), ipsTechList null
ips-search/table-result?selectedTab=patent&indicator=100&reportType=13&fromYear=1980&toYear=2024&ipsOriSelValues=<codes>
```
- No type column: `ipsTechList` null, records have no `selectedTechnology`; `ipsTechSelValues` omitted or empty
  both work (tested). Same shape as pmh tables -> treat as one type (`parse.NO_TYPE`).
- Values = decimal strings, 1 decimal ("1505.6"). `parse._VALUE_PATTERN` (`parse.py:44`) accepts only `(\.0+)?`
  -> current `parse_value` raises `SchemaError` on these. Stage B needs a decimal parser for ratio series (no
  int truncation: small origins are 0.1-scale).
- Year range: tab offers 1980-2024; ratios null before 1990 (WDI GDP PPP starts 1990).
- Aggregates: origin list has WD "World" (values 1990-2024) and SU (no values). No R1-R6, no EU/R7, no income groups.
- Coverage (non-null origins incl. WD): per-GDP 63 (1990) -> 124 (2024); per-pop 65 (1990) -> 123 (2024).
  148/147 origins have any value.

### Definitions (verified)

- Numerator, countries = resident applications **by origin** = our `origin_apps` type 911 "Resident" (ips 10/13),
  not office type 901. Check: CH 2024 911 = 11,157; 11,157 / WDI `SP.POP.TOTL` CHE x1e6 = WIPO 1235 (office 901 =
  1,191 would give ~132). US, CN, DE, KR, JP, SG: implied population = WDI to <=0.1% (2018-2024). Resolves
  v0.2 spec "Measures" ambiguity (v0.2 design notes).
- Numerator, World (WD) = office-based world resident total `office_apps` WD type 901 (WIPO estimate incl.
  non-reporting offices). Check 2015-2024: 901 WD / WDI `WLD` reproduces WD per-pop within 0.1 and per-GDP within
  0.1% every year. Sum of country origin-residents (implied) 2024 = 2,700,350 vs WD 901 2,702,600 (0.08%).
- Population = World Bank WDI `SP.POP.TOTL`. GDP = WDI `NY.GDP.MKTP.PP.KD` ("GDP, PPP (constant 2021 international
  $)"). Per GDP = residents / GDP x 1e11; per pop = residents / pop x 1e6.
- **Data Center label "(2017 PPP)" is stale.** Values match current WDI 2021-base GDP (CN, KR, LU, US within 0.25%;
  WD within 0.1%); a 2017 base would shift every value by the 2017->2021 price change. WIPI 2025 states
  "GDP data are in 2021 US purchasing power parity (PPP) dollars" (figure A37 note; trademark B30 note; design C26
  note) and "Gross domestic product and population data are from the World Bank's World Development Indicators
  database" (Additional information, Data sources, p. 171). Sources line: "WIPO Statistics Database and World Bank,
  September 2025". WIPI 2025 PDF: https://www.wipo.int/edocs/pubdocs/en/wipo-pub-941-2025-en-world-intellectual-property-indicators-2025.pdf
- Thresholds (country profile note 5, e.g. https://www.wipo.int/edocs/statistics-country-profile/en/kr.pdf;
  lists https://www.wipo.int/edocs/statistics-country-profile/en/_list/l3.pdf (per million), `_list/l4.pdf` (per GDP)):
  "per million population ... available for countries with a population greater than one million"; "indicator per
  GDP ... available for countries whose total GDP exceeds 10 billion US Dollar". Data Center applies them on the
  **PPP** GDP: smallest 2023 per-GDP origins BT 11.5 bn PPP (3.0 bn nominal), ME 17.0; smallest per-pop MU 1.25 M.
  LU: per-GDP yes, per-pop no (pop < 1 M).
- WIPI chart filters are stricter, chart-only: A37 GDP > USD 25 bn PPP and > 100 resident apps; A38 pop > 5 M and >
  100 resident apps; trademarks B30 GDP > 535 bn and >= 25,000 classes; B31 pop > 2.5 M.
- Missing GDP -> no ratio: WIPI 2025 excluded KR from per-GDP ("data on the Republic of Korea's 2024 GDP (in constant
  PPP dollars) is not available in the World Bank database", A37 note). Data Center now has KR 2024 = 6869.7
  (newer WDI vintage).
- Rounding: 1 decimal.

### Vintage (dated examples, retrieved 2026-10-20)

- WIPI 2025 (Nov 2025, WDI Sept 2025) vs Data Center (ips May 2026): per GDP 2024 CN 4,977 vs 4976.5; JP 4,150 vs
  4149.1; CH 1,506 vs 1505.6; US 1,053 vs 1052.8; DE 1,241 vs 1246.2 (+0.4%). Per pop KR 3,783 vs 3783.2; JP 1,913
  vs 1913; CH 1,235 vs 1235.
- Data Center vs current WDI (2026-10-08) implied GDP ratio: CN, KR, LU, US, DE within 0.25%; SG -0.6 to -1.5%; JP
  about -3%; CH about -3.7%; IN +3 to +5% (WDI revisions since WIPO's vintage, stable across years = level revision).
  Implied population: within 0.1% except rounding noise at small values (MG 0.1-scale) and single revised years
  (DE 2023 +0.7%, CH 2024 +0.3%).

## 3. Other WIPO ratios (not in the API)

- Country profiles (PDF only, latest year + global rank): "PCT applications per million inhabitants"; resident
  trademark/design filings per GDP and per million. No API; WIPO's base for the PCT one not stated (assume PCT
  origin count / WDI `SP.POP.TOTL`, unverified).
- WIPI 2025 A39 (resident apps per capita vs GDP per capita, PPP constant 2021 USD) and A40 (resident apps per
  capita vs R&D as % of GDP; "WIPO Statistics Database, OECD, UNESCO and World Bank, September 2025"): charts only.
  WDI equivalent for R&D share: `GB.XPD.RSDV.GD.ZS` (UNESCO UIS source). No WIPO per-R&D indicator exists.

## 4. Recommendations for Stage B

WIPO direct (authoritative, shown as published, cite indicator):
- Country + World per million: ips 101/13; per $100bn GDP: ips 100/13. Fetch one table per indicator for all 208
  codes (~240 KB each), years 1990..last complete. WD row = world figure.
- Label from source: GDP basis from WDI indicator name (`NY.GDP.MKTP.PP.KD` -> "constant 2021 international $"
  as of 2026-10-20), not WIPO's "(2017 PPP)" label. Methods page notes WIPO's label and WIPI's 2021-PPP statement.
- `_check_labels` should not pin the "(2017 PPP)" wording as meaningful (WIPO may relabel); pin indicator id +
  report label; record label text in manifest.

Computed (Patent Atlas, WDI denominators, marked "computed"):
- Regions, continents: sum(origin_apps type 911) / sum(`SP.POP.TOTL`) x1e6, sum(911) / sum(`NY.GDP.MKTP.PP.KD`)
  x1e11, over members with numerator and denominator both present that year (spec line 98 rule); coverage "n of m".
  No threshold inside sums (WIPO's world includes every country). Origin sums carry the `GROUP_ATTRIBUTION_MIN` /
  `ORIGIN_ABROAD_FROM` caveat already in the spec.
- Continent: no WIPO R1-R6 ratio exists -> always computed. Do not divide office R1-R6 totals (office-based,
  regional offices) by population: different basis from WIPO's origin-based country ratios.
- Missing country-years (WIPO null, 911 count + WDI both present, above WIPO thresholds): fill computed, marked;
  apply WIPO thresholds (pop > 1 M; GDP PPP > USD 10 bn) so the map matches WIPO's universe. Below threshold: null
  "below WIPO threshold". Before 1990: none (no PPP GDP; keep per-pop to 1990+ too, matching WIPO).
- PCT per million (by origin): pmh 1001/4001 origin / `SP.POP.TOTL` x1e6, computed only; no WIPO API to check;
  optional manual golden from country profile PDFs (latest year).
- Per R&D: Later; if built, WDI `GB.XPD.RSDV.GD.ZS` x `NY.GDP.MKTP.PP.KD` as R&D spend, computed only.
- Fetch WDI: `https://api.worldbank.org/v2/country/all/indicator/<id>?format=json&date=1990:<y>&per_page=20000`
  (one request per indicator; record `lastupdated` and indicator `name` in manifest). Map WIPO ISO2 -> WDI `country.id`
  (ISO2; WDI aggregates like `1W` excluded). Historical codes (SU, DD, YU, CS, AN, ZR) have no WDI rows.

Cross-check (report, never override WIPO):
- For every country-year with a WIPO value: recompute 911 / WDI x scale; compare with WIPO.
- Pass if |ours - wipo| <= 0.05 + 0.5% x wipo (0.05 = WIPO's 1-decimal rounding; 0.5% = typical vintage drift
  observed). Above -> warning listed in manifest (country, year, both values, % diff), not blocking: drift of 3-5%
  is known (CH, JP, IN GDP revisions, 2026-10-20). Blocking only if > 10% of compared cells fail or WD fails
  (systematic: wrong numerator type, wrong base, unit error). Tolerances in config, not code.
- Also check WD: office 901 WD / WDI `WLD` vs WIPO WD (observed within 0.1%).
- Display WIPO's value where it exists; computed fills and groups use current WDI, so a region's ratio can differ
  slightly from a member-weighted reading of WIPO's country values: methods page states both bases and the WDI date.
