# Data sources: research 2026-10-19

Frozen record (web research by 5 agents, 2026-10-19). Numbers = as found that day. Unverified items marked.

## Verdict
- Nothing live. Freshest = WIPO monthly PCT (last 3 months hidden). Rest yearly; office-level lag ~11 months.
- Backbone = WIPO Statistics Database: ~all countries, most series from 1980, PCT from 2004.
- Cross-checks independent of WIPO: OECD SDMX, EPO yearly XLSX, IP5 report, UKIPO, DPMA.
- Dropped: PATENTSCOPE (terms forbid automation; web service paid), PatentsView API (paused), Google BigQuery (needs cloud account), Eurostat (frozen, ends 2017).
- Traditional knowledge: no countable data. GRATK Treaty (2024) not in force (needs 15 ratifications; 4 found, list maybe incomplete).

## WIPO IP Statistics Data Center
- Help/terms: https://www.wipo.int/ipstats/en/help.html. "users agree not to republish or commercially re-sell WIPO's statistical datasets". Cite "WIPO Statistics Database". General WIPO CC BY 4.0 does not clearly cover datasets.
- Data Center https://www3.wipo.int/ipstats/ = JS app, no API found.
- Bulk ZIP fetched OK unattended (3.9 MB, CSV inside): https://www.wipo.int/documents/d/ip-statistics/wipo-data-patent-indicators.zip. Listed on https://www.wipo.int/en/web/ip-statistics; scrape link, URL may change. Unconfirmed: ZIP holds applications/grants by office and origin.
- Top PCT applicants XLSX: https://www.wipo.int/documents/2948119/3215563/y_top_pct_applicants.xlsx
- Monthly/quarterly series: PCT, Madrid, Hague only. Which PCT indicators are monthly: unverified. Unattended monthly download: unverified.
- Annual release ~Nov (World IP Indicators); PCT yearly ~Mar.
- Gotchas: origin = first-named applicant residence; past years revised; re-fetch whole series, store retrieval date.

## PATENTSCOPE
- Terms https://www.wipo.int/en/web/patentscope/data/terms_patentscope §2.1: no automated queries, scraping, bulk download/redistribution. >10 searches/min/IP excessive.
- Web service CHF 600/2,000 per year; bulk SFTP CHF 400-3,900+/yr: https://www.wipo.int/en/web/patentscope/data
- Not usable.

## USPTO PatentsView / Open Data Portal
- API paused since move to ODP 2026-03-20: https://www.uspto.gov/subscription-center/2026/patentsview-migrating-uspto-open-data-portal-march-20
- Bulk TSV, no key: https://data.uspto.gov/bulkdata/datasets. Data to 2025-12-31 (released 2026-05-06). Roughly quarterly (third-party claim).
- Sizes: assignee ~331 MiB zip, CPC ~442 MiB zip. Feasible in Action with DuckDB; commit aggregates only.
- Licence: old site CC BY 4.0, "not official USPTO record"; current unverified -> EconomicsData@uspto.gov.
- Gotchas: multiple assignees (whole vs fractional count), missing assignee country, re-disambiguation changes counts.

## EPO
- Yearly XLSX (Technology Dashboard, ~Mar/Apr), list: https://epo.org/en/about-us/statistics/data-download. Applications + grants by applicant country of residence, by tech field, field x country, 2016-2025; top 100 applicants; national-office filings 2024. Filenames carry edition year.
- Website terms s.6 https://www.epo.org/footer/terms/terms.html: use allowed, display accurately, cite source, mark alterations.
- OPS: free 4 GB/week, registration; counts only via search total (cap 2,000 or 10,000, unverified); publication-date based -> won't match official stats. Terms 3.2: no making data "as such" public. Gap-filling only.
- Gotchas: EP filings only (direct + Euro-PCT entries); country = first applicant residence; 2025 total 201,974 vs 201,954 across two EPO pages.

## Cross-check sources
- OECD SDMX `OECD.STI.PIE,DSD_PATENTS@DF_PATENTS,1.0`: EPO/USPTO/PCT/IP5/triadic, by inventor/applicant country, priority/application/grant date. Header `Accept: application/vnd.sdmx.data+csv;version=1.0.0`. PATSTAT-based -> compare trends, not exact values. Licence CC BY 4.0 (from 2024-07-01; Data Explorer wording unconfirmed).
- World Bank WDI IP.PAT.RESD / IP.PAT.NRES: re-publishes WIPO -> ingestion check only. CC BY 4.0. API works.
- IP5 report https://www.fiveipoffices.org/resources/annualreports: big-five office counts; format/licence unverified.
- UKIPO Facts and Figures XLSX, OGL v3, yearly, hashed URL -> scrape GOV.UK page.
- DPMA yearly statistics; format/licence unverified.

## WIPO terms for derived analysis (follow-up, 2026-10-19)
- Only stats terms: "Conditions of use" https://www.wipo.int/en/web/ip-statistics/about: "not to republish or commercially re-sell WIPO's statistical datasets"; cite "WIPO Statistics Database". Older (2021-22) wording "any of the data" (snippets only, unverified).
- Publications (World IP Indicators 2025, PCT Yearly Review 2025, IP Facts and Figures 2025) = CC BY 4.0. Derivatives need disclaimer: "The Secretariat of WIPO assumes no liability or responsibility with regard to the transformation or translation of the original content." No WIPO logo.
- No WIPO text on dashboards/embedding. Precedent: World Bank WDI + Our World in Data chart WIPO figures under CC BY with no-responsibility note.
- Verdict: charts + derived figures with citation = likely allowed; derived JSON in public repo = grey (static site serves chart data publicly anyway); raw CSV copies = not allowed.
- Permission contact: form https://www.wipo.int/contact/en/area.jsp?area=ipstats (no email published).

## WIPO Data Center backend (probed 2026-10-19)
- Bulk patent ZIP = technology tables only, dated 2023-12 (`dc_indicator_patent_4/5_*`, cols year,office,origin,tec_id,count). No office/origin totals there.
- Data Center JS app calls undocumented public JSON API, no login: base `https://api.ipstatsdc.deda.prd.web1.wipo.int/api/v1/public`. Headers sent by app: `accept: application/json`, `accept-language: en`, `referer: https://www3.wipo.int/`. curl with those works.
- Endpoints seen: `ips-search/formcontrols?selectedTab=patent` (indicator ids), `ips-search/loadOffOrgTechList?indicator=&rpType=`, `ips-search/table-result?selectedTab=patent&indicator=10&reportType=13&fromYear=&toYear=&ipsOriSelValues=CH,US&ipsTechSelValues=910,911,912`, `ips-search/chart-options?indicator=`, `ips-search/en/last-updated` (text; "Last updated: May 2026"; 406 with accept json), `pmh-search/formcontrols?selectedTab=pct`.
- Patent indicator 10 = total applications; reportType 13 = by applicant's origin; tech 910/911/912 = Total/Resident/Abroad (913/914 = equivalent counts). Years 1980-2024 on 2026-10-19.
- PCT indicators (pmh): 1001 applications by filing date, 1002 by receipt at IB, 1040-1042 women inventors, more.
- Response: records[] with per-year string values; e.g. Switzerland origin Total 2024 = 41341.
- Definitions differ: World Bank CHE residents 2024 = 1191 = office-based (Swiss office); WIPO origin "Resident" 2024 = 11157 (Swiss origin; regional EPO filings count as resident). Cross-checks must compare like with like.
- Undocumented -> may change without notice; terms on automated use unclear -> part of WIPO permission request.

### PCT (pmh) backend + client findings (Task 2, probed 2026-10-19, ~20 requests incl. browser)
- `pmh-search/en/last-updated` = own release date, text: "Source: WIPO statistics database. Last updated: October 2026" (ips on same day: "... May 2026"). Client `release_string(tab)` returns `Last updated: <Month Year>` (regex on text).
- `pmh-search/formcontrols?selectedTab=pct` -> keys `pmhIndicatorMap` (value/label, 30), `pmhRpTypeMap` (4001 Yearly, 4003 Monthly), `pmhFYears` (1995..2026), `pmhToYearList`. Years list includes current partial year.
- `pmh-search/loadOffOrgClassList?indicator=1001` (no rpType; `loadOffOrgTechList` = 404 on pmh) -> `pmhOriginList` {code: name}, `pmhOffList` {code: name} (RO), `*Seq` order maps. `ZZ` = "Total" in both. Codes = ISO-2 (CH, US...).
- Table: `pmh-search/table-result?selectedTab=pct&indicator=1001&reportType=4001&fromYear=Y&toYear=Y&pmhOffSelValues=ZZ&pmhOriSelValues=CH,US,ZZ`. App adds `pmhClassSelValues=` (empty) only to the page URL; table-result call works without it.
- `pmhOffSelValues` (RO filter) REQUIRED: omit with `pmhOriSelValues` set -> 200 but value strings garbled (RO rows concatenated, e.g. "1,1,1,2,209,..." for CH 2024; `_SeqOrder` = 2x real); omit both -> `records: null`; wrong param name (`ipsOriSelValues`) -> `records: null`. Always send `pmhOffSelValues=ZZ`. `records:null` = HTTP 200 with `recordInfo/columns/records` all null -> parser must treat as error.
- Response shape as ips: `recordInfo`, `columns[{code,value,type}]`, `records[]`. Record keys: `selectedOffice`, `selectedOrigin` (name, e.g. "Total", "Switzerland"), one key per column code, plus `<code>_SeqOrder` (numeric or null) and `selectedOrigin_SeqOrder`.
- Values: strings with thousands comma ("55,666", "5,423"); missing = JSON null (not "" / "-"). Yearly: columns "2022".."2026"; partial/unpublished year present with null. Rows come in WIPO order, not request order (CH, US, Total).
- Monthly (`reportType=4003`): columns `"YYYY/M"` no zero pad ("2025/1".."2026/9"); future months null; latest published month at probe = 2026/7 (lag ~2 months), 2026/8-9 null. Values "304", "1,234" style.
- Spot values: PCT 1001 CH 2023 = 5,423; US 2023 = 55,666; Total 2023 = 272,481; CH monthly 2025/1 = 304.
- Client notes: python.org macOS Python lacks CA bundle (`CERTIFICATE_VERIFY_FAILED`): run locally with `SSL_CERT_FILE=/etc/ssl/cert.pem`. ips `table-result` HTML-escapes text (`applicant&#39;s origin`).

### Collect findings (Task 6, probed 2026-10-19, ~21 requests)
- Form controls year range: `ipsFYears` (from-years "1980".."2024") + `ipsToYearList` (["2024"]); pmh `pmhFYears` ("1995".."2026") + `pmhToYearList` (["2026"]). Tab-level, no indicator param. `pipeline/collect.py` requires from-years without gaps ending at the to-year.
- Office table: `ipsOffSelValues=<codes>`, `ipsTechSelValues=900,901,902`; `selectedOffice` labels = `ipsOffList` labels (all 221 matched live, e.g. EP "European Patent Office").
- Tables omit a (code, type) row that is all null over the requested years: Holy See office no rows; Holy See origin only "Abroad" row (Total, Resident absent). Full range 2026-10-19: origin 58/627 rows absent-or-null (32 codes, e.g. EU, R7, small states), office 111/663 (46 codes: OAPI members, LI, small states), PCT 18/209. Collect fills them with null (`parse_table(allow_absent_rows=True)`).
- ips table echoes an unlisted code as a row labelled with the code itself (origin `ZZ` -> row "ZZ" with values): request listed codes only; parser rejects unknown labels.
- Office list has aggregates with data: `WD` "World" (Total 2024 = 3,725,000), R1-R7 regions -> a world cross-check is available (spec assumed no World entry).
- Monthly 4003 with fromYear = toYear = Y: only Y's month columns; current year stops at the last month (2026/9 on 2026-10-19), unpublished months null.
