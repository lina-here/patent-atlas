# WIPO women-inventor indicators (pmh 1040/1041/1042): shape, basis, omissions, weights — 2026-10-21

Live probes 2026-10-21: WIPO Data Center API (~14 requests, 1 s apart, `pipeline/wipo_client.py` headers), PCT
Yearly Review 2026 PDF (URL in `pipeline/golden.json` entry `pct_applications_2025`). Raw responses in scratch only.
Release at probe: pmh "Last updated: October 2026". Numbers below = dated measurements (retrieved 2026-10-21), not
living values; living constants live in `pipeline/series.py` / `pipeline/gender.py`.

## 1. Rule summary

- 1040/1042 = WIPO shares by PUBLICATION year (published applications, publication date), not filing year (§3).
- Group weights = PCT publications by origin (pmh 1010, class "Total"), same publication year, never `pct_origin`
  filings (§4). Cross-check vs WIPO's World row within `GENDER_CROSSCHECK_TOLERANCE` (gender.py; §4).
- WIPO omits origin-years; not by size alone (§5). Shown as "not published by WIPO for this year", never "too few".
- Denominator (all applications vs applications with gender-attributed inventors): not stated by WIPO in the PDF;
  method on WIPO pages (www.wipo.int/web/ip-statistics, www.wipo.int/en/web/economics). Open.
- The Data Center API (pmh 1040-1042) publishes shares only: no counts, no R1-R6 values, no country x field split.
  The PCT Yearly Review 2026 prints more (continent shares 2025, region x field, top-10 origin x field): §3.

## 2. Request shapes and table facts

- `pmh-search/formcontrols?selectedTab=pct` labels: 1040 "13 - Share of applications with at least one women inventor
  (yearly statistics)"; 1041 "14 - Share of applications with at least one women inventor by technology (yearly
  statistics)"; 1042 "15 - Share of women inventors (yearly statistics)"; 1010 "4 - PCT publications by language";
  reportType 4001 "Yearly statistics". pmh years 1995..2026. No indicator help text in the API
  (`pmh-search/chart-options` = chart flags only; `pmh-search/indicator-info` 404).
- `loadOffOrgClassList?indicator=1040|1042`: `pmhOriginList` 209 codes (same codes as 1001), no `pmhOffList`.
  Non-country codes: ZZ Total, `**` Unknown, R1-R6 (Africa, Asia, Europe, LAC, Northern America, Oceania), AN
  (historical). Every code classifies (`entities.classify`).
- `loadOffOrgClassList?indicator=1041`: `pmhClassList` 35 ids "1".."35" (= ips technology field labels),
  `pmhClassLabel` "Field of technology"; no origin list.
- `loadOffOrgClassList?indicator=1010`: `pmhOriginList` 209, `pmhClassList` 11 ("109" Total + 10 languages),
  `pmhClassLabel` "Publication language"; no office list.
- Origin table: `table-result?selectedTab=pct&indicator=1040|1042&reportType=4001&fromYear=1995&toYear=2026&
  pmhOriSelValues=<all 209>`, NO `pmhOffSelValues` (with `pmhOffSelValues=ZZ`: 0 rows, columns null).
  Columns `selectedOrigin` + 32 years; no `selectedOffice` column.
  - 91 rows each = ZZ + `**` + 89 countries; R1-R6 no row; 118 listed codes no row.
  - Years with values 2000-2025 (rows with a value: 2000 46, 2010 70, 2019/2020 77, 2025 72); 2026 all null.
  - 30 rows with interior gaps (e.g. Armenia 2 of 15 years); 1040 and 1042 null patterns identical.
  - `**` "Unknown" row has values in some years (2009, 2010, 2013-15, 2017-20, 2023-24).
  - Values: strings, one decimal, no separators; missing = null. 1040 range 1.9-100.0; 1042 0.9-57.1.
    ZZ 2025: 1040 38.1, 1042 18.1. CH 2024: 1040 33.0, 1042 16.9.
  - Every row: one `<year>_SeqOrder` key per year column; non-null `_SeqOrder` count == non-null value count in every
    row (0 mismatches, all four tables). `_SeqOrder` = rounded sort value (CH 2016 26.6 -> 27.0), not the value.
- Field table: `indicator=1041 ... pmhClassSelValues=1,...,35`, no origin param (with any `pmhOriSelValues`, even ZZ:
  0 rows). 35 rows, column `selectedClass` (labels = class list); every field has values 2000-2025.
- Publications table: `indicator=1010 ... pmhOriSelValues=<all 209>&pmhClassSelValues=109`, no `pmhOffSelValues`.
  189 rows, all class "Total"; columns `selectedOrigin`, `selectedClass`, years; counts with thousands commas
  ("265,154"). ZZ row = sum of origin rows incl. Unknown (2025: 265,154 vs 265,153). ZZ has values from 1995.
- `GENDER_MIN_COUNTRY_ROWS` (living value: `pipeline/series.py`), chosen 2026-10-21 as 80: live 89
  country rows with a value; ~10 % margin lets WIPO drop a few small origins without failing the
  refresh; a truncated table falls far below.
- `GENDER_LAST_YEAR_ROW_SHARE_MIN` (living value: `pipeline/series.py`), chosen 2026-10-21 as 0.85: country rows with
  a value in the last year must reach this share of the year before's count. A per-year floor of 80 does not fit
  (live 2025: 71 country rows with a value in 1040 and 1042, against 89 over all years), and the any-year floor
  above misses a table cut only in its newest year. Live 2025/2024 = 71/72 = 0.986; worst year-on-year ratio
  2005-2025 = 0.956 (2011); 2015-2025 counts 69-75. 0.85 = ~0.1 below the worst observed ratio; at ~71 rows it
  lets 10 country rows drop, fails a table cut to a handful.

## 3. Date basis (stop condition (a), triggered)

- PCT Yearly Review 2026 p. 28 (PDF p. 29) figs A22 (share of women inventors) and A23 (applications with at least
  one woman inventor): x-axis "Publication year"; 2025 = 18.1 % / 38.1 % = Data Center 1042 / 1040 ZZ 2025.
- Fig A25 note (p. 29, PDF p. 30): "Data are based on published applications and on the publication date." Same
  wording on the PDF's other publication-based figures ("For confidentiality reasons, ...").
- A25 vs Data Center 2025 (PDF "March 2026" database vs October release): 1040 ES 41.1/41.3, CN 52.7/52.6, US
  40.5/40.4, CH 33.8/33.8; 1042 ES 28.7/28.7, CN 24.1/24.0. Small revisions between releases.
- Region x field table A26 pools publications 2023-2025, cells need >= 10 inventors (its note). No origin threshold
  stated.
- What the Yearly Review prints beyond the Data Center API (checked against the extracted text, printed page = PDF
  page - 1):
  - Continent women's shares of inventors, 2025 (same measure as 1042): p. 9 (PDF p. 10) text "LAC ... 24.5%, Asia
    (18.8%), Northern America (18.2%), Africa (18.1%), Oceania (16.7%) and Europe (16.3%) (figure A24)". Fig A24
    (p. 29, PDF p. 30) charts the same regions for 2015, 2020 and 2025 plus World; the extracted text carries no
    value labels for 2015 and 2020. Source note "WIPO Statistics Database, March 2026".
  - Region x technology field, women's share of inventors, publications 2023-2025: table A26 (p. 30, PDF p. 31).
  - Top-10 origins x technology field, women's share of inventors, 2025: fig A27 (p. 31, PDF p. 32); top-20 origin
    shares: fig A25 (p. 29, PDF p. 30).
  - So "WIPO publishes no R1-R6 values / no country x field split" holds for the Data Center API only. The PDF's
    continent figures are WIPO-published and win over a computed value for 2025 (WIPO-first, j43): Task 2a.

## 4. Cross-check: weighted mean of country 1040 vs ZZ 1040 (stop condition (b))

Weighted mean over countries with a published 1040 value, per year 2000-2025.

| weights | max abs gap | mean abs gap | years positive | years > 0.5 pp |
|---|---|---|---|---|
| `pct_origin` filings, same year | 0.94 pp (2016) | 0.27 | 21/26 | 5 (2014-2017, 2020) |
| filings, year - 1 | 0.45 | 0.15 | 23/24 | 0 |
| PCT publications (1010 Total), same year | 0.20 (2020) | 0.09 | 19/26 | 0 |

- Published countries hold 99.6-99.9 % of ZZ filings / publications, so the filing-weight gap is the wrong basis,
  not missing members. Publication weights: residual small upward bias (rounded member shares, ~0.1-0.4 % weight
  without a share).
- `GENDER_CROSSCHECK_TOLERANCE` (living value: `pipeline/gender.py`, Task 2a), chosen 2026-10-21 as 0.5 pp = 2.5x the
  publication-weighted max.

## 5. Omissions (stop condition (c), triggered on the filing basis)

Country origin-years 2000-2025 with > 0 of the base count.

| base | published, smallest | unpublished, largest | published < 10 | unpublished >= 10 |
|---|---|---|---|---|
| `pct_origin` filings | 2 (AG 2021, ID 2003) | 135 (AL 2025), 59 (PA 2016), 58 (ID 2023) | 44 of 1714 | 141 of 1404 |
| PCT publications | 10 (AM 2016, BA 2022, ...) | 37 (EG 2007), 36 (EG 2019), 30 (AG 2017) | 0 of 1714 | 52 of 1339 |

- Filing basis: shares impossible for the filing count (AG 2021: 2 filings, share 17.6 needs >= 17 applications).
- Publication basis: every published origin-year has >= 10 publications (inferred floor, not stated by WIPO); 52
  origin-years with 10-37 publications still unpublished (Belarus often; plausibly low name attribution; not
  measurable: WIPO publishes no counts). So omissions are not size alone.
- Consequence: no extra small-count rule of ours; null reason "not published by WIPO for this year".

## 6. Golden figures, method note, printed continent figures (Task 2a Step 1, 2026-10-21)

PCT Yearly Review 2026 (URL + citation: `pipeline/golden.json` `pct_applications_2025`), text extracted per page
(PDFKit); printed page = PDF page - 1. Only values printed as numbers entered.

- Golden (`pipeline/golden.json`), live = Data Center October release:
  - `women_any_world_2025` 38.1: p. 28 (PDF p. 29) text above fig A23; also p. 9 (PDF p. 10). Live ZZ 1040 38.1.
  - `women_share_world_2025` 18.1: p. 28 (PDF p. 29) fig A22 heading; also p. 9. Live ZZ 1042 18.1.
  - `women_share_es_2025` 28.7: p. 9 (PDF p. 10) text "Spain (28.7%)"; fig A25 label. Live ES 1042 28.7. Chosen over a
    women_any country value: the text prints country 1042 only (ES, TR, CN); A25's 1040 labels attach to bars by
    position only.
  - Golden tolerance relative (`GOLDEN_TOLERANCE_PCT` % of printed value): at a one-decimal share = fraction of a pp
    (1% of 18.1 = 0.181 pp); report "March 2026" database vs October release: revisions seen (§3) up to 0.1 pp on
    1042 fit; the 0.2 pp seen was ES 1040 at 41.1 (limit 0.41 pp). A 0.2 pp revision of World 1042 2025 would not
    fit: the check fails closed (blocks the run).
  - `crosscheck.load_golden` now takes a float value (share as printed); compare via `Decimal(repr)`.
- Method note (`gender.METHOD_NOTE`): no methodology section on gender in the PDF; figure notes only. A22 note
  (p. 28, PDF p. 29) -> www.wipo.int/en/web/economics; A23-A25 notes -> www.wipo.int/web/ip-statistics; A25 note
  (p. 29, PDF p. 30) "Data are based on published applications and on the publication date." A23 source line reads
  "WIPO Statistics Database, March 2025" (others March 2026): as printed, likely a typo.
- Continent figures (`pipeline/gender_published.json`, ruling C1): women_share 2025 for all six WIPO regions from
  p. 9 (PDF p. 10) text citing fig A24. Fig A24 (p. 29, PDF p. 30) bars carry no value labels (2015, 2020 not
  entered). No women_any by region printed -> file's `women_any` empty.
