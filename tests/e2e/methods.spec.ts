import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { fixtureBreak, routeSeriesBreaks } from "./seriesBreaks";
import { BOARD_FALLBACK } from "./siteConstants";
import { stateInProse } from "./pctProse";

// Methods page (methods.html): home of methods-page tests from v0.2b on. Wording checks quote the page's own text;
// figures are read from data files, never typed.

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("series breaks section lists each break with its note, publication link and page (fixture, audit F1)", async ({ page }) => {
  const errors = trackErrors(page);
  const entry = fixtureBreak();
  await routeSeriesBreaks(page, [entry]);
  await page.goto("/methods.html");
  const section = page.locator("#series-breaks");
  await expect(section.locator("h2")).toHaveText("Series breaks");
  const item = section.locator("li", { hasText: `${entry.label}, ${entry.year}` });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(entry.note);
  await expect(item).toContainText(entry.page);
  await expect(item.locator("a")).toHaveAttribute("href", entry.url);
  await expect(item.locator("a")).toHaveText(entry.citation);
  await expect(page.locator('.toc a[href="#series-breaks"]')).toHaveCount(1);
  // review M2: the empty-figure rule names series breaks and links the section
  const rule = page.locator("#formulas p", { hasText: "A figure is left empty" });
  await expect(rule).toContainText("the two years straddle a series break (see Series breaks)");
  await expect(rule.locator("a")).toHaveAttribute("href", "#series-breaks");
  expect(errors).toEqual([]);
});

test("no series_breaks in the data (before the refresh that adds it): no series breaks section, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await routeSeriesBreaks(page, null);
  await page.goto("/methods.html#world-totals");
  await expect(page.locator("#world-totals")).toBeVisible();
  await expect(page.locator("#series-breaks")).toHaveCount(0);
  await expect(page.locator('.toc a[href="#series-breaks"]')).toHaveCount(0);
  const rule = page.locator("#formulas p", { hasText: "A figure is left empty" });
  await expect(rule).toContainText("the two years straddle a series break; it is never filled with an estimate");
  await expect(rule.locator("a")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("world totals: WD holds WIPO's estimates, ZZ the applications in WIPO's database; latest PCT year published as estimates (audit F2)", async ({ page }) => {
  await page.goto("/methods.html");
  const world = page.locator("#world-totals");
  await expect(world).toContainText("WD includes WIPO's estimates for offices that did not report");
  await expect(world).toContainText("ZZ counts the applications recorded in WIPO's database at retrieval");
  await expect(world).toContainText("WIPO's published figures for the latest PCT year are estimates and can differ slightly");
});

test("definitions: origin figures are absolute counts, a regional filing counts once (audit F4)", async ({ page }) => {
  await page.goto("/methods.html");
  const origin = page.locator("#definitions dt", { hasText: /^Origin$/ }).locator("xpath=following-sibling::dd[1]");
  await expect(origin).toContainText("absolute count");
  await expect(origin).toContainText("counts once");
  await expect(origin).toContainText("Origin figures are absolute counts (WIPO 'total count'): an application at a regional office counts once.");
});

// --- v0.2b scale measures: #scale, #ratio-check, regression lines of the checks section --------------------------------
// Every number is read from the data files (or from a patched copy served for the test); only wording is typed.
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const overview = readJson("site/data/overview.json");
const manifest = readJson("site/data/manifest.json");
const method = overview.method.ratios;
const WIPO_IDS: string[] = method.wipo_ratio_ids;
const GROUPED = (value: number): string => value.toLocaleString("en-US");
/** A constant ratio as a percentage without trailing zeros (0.005 -> "0.5", 0.1 -> "10"). */
const percentOf = (ratio: number): string => String(Number((ratio * 100).toPrecision(8)));
/** 1000000 -> "1 million", 10000000000 -> "10 billion" (independent of the page's formatter). */
const words = (value: number): string => {
  if (value >= 1e12) return `${value / 1e12} trillion`;
  if (value >= 1e9) return `${value / 1e9} billion`;
  if (value >= 1e6) return `${value / 1e6} million`;
  return GROUPED(value);
};

async function patchData(page: Page, change: (files: { overview: any; manifest: any }) => void): Promise<void> {
  for (const name of ["overview", "manifest"] as const) {
    await page.route(`**/data/${name}.json`, async (route) => {
      const files = { overview: structuredClone(overview), manifest: structuredClone(manifest) };
      change(files);
      await route.fulfill({ json: files[name] });
    });
  }
}

test("scale section: WIPO labels, formulas, thresholds, GDP basis and WDI credit come from the data", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const scale = page.locator("#scale");
  await expect(scale.locator("h2")).toHaveText("Per capita and per GDP");
  await expect(page.locator('.toc a[href="#scale"]')).toHaveCount(1);
  for (const id of WIPO_IDS) await expect(scale).toContainText(manifest.ratio_labels[id]);
  await expect(scale).toContainText(`constant ${manifest.wdi_denominators.gdp_ppp.gdp_base} international $`);
  await expect(scale).toContainText(manifest.wdi_denominators.gdp_ppp.name);
  await expect(scale).toContainText(manifest.wdi_denominators.population.name);
  await expect(scale).not.toContainText("Indicators 2025 states"); // M1: no claim about WIPO's base beyond its own label
  await expect(scale).toContainText(`× ${words(method.scale.per_million)}`);
  await expect(scale).toContainText(`× ${words(method.scale.per_gdp)}`);
  await expect(scale).toContainText(`population ${words(method.wipo_threshold.population)}`);
  await expect(scale).toContainText(`GDP PPP USD ${words(method.wipo_threshold.gdp_ppp)}`);
  await expect(scale).toContainText(`${percentOf(overview.method.group_attribution_min)}%`);
  await expect(scale).not.toContainText("below_wipo_threshold"); // I2: reason text, never the raw key
  await expect(scale).toContainText("reporting members' total is at or below WIPO's threshold (population");
  await expect(scale).toContainText("World Bank WDI (CC BY 4.0)");
  await expect(scale).toContainText(`retrieved ${manifest.retrieved}, WDI last updated ${manifest.wdi_denominators.gdp_ppp.last_updated}`);
  await expect(scale).toContainText("computed from WIPO counts and World Bank WDI");
  await expect(scale).toContainText(`${method.decimals === 1 ? "one decimal" : `${method.decimals} decimals`}`);
  expect(errors).toEqual([]);
});

test("scale section follows patched data: thresholds, scales, labels, base year, floor", async ({ page }) => {
  const errors = trackErrors(page);
  await patchData(page, ({ overview: o, manifest: m }) => {
    o.method.ratios.wipo_threshold.population = 3000000;
    o.method.ratios.wipo_threshold.gdp_ppp = 25000000000;
    o.method.ratios.scale.per_million = 10000;
    o.method.group_attribution_min = 0.65;
    m.ratio_labels.per_million = "Patched WIPO per-million label";
    m.wdi_denominators.gdp_ppp.gdp_base = 2030;
    m.wdi_denominators.gdp_ppp.name = "GDP, PPP (constant 2030 international $)";
  });
  await page.goto("/methods.html");
  const scale = page.locator("#scale");
  await expect(scale).toContainText("Patched WIPO per-million label");
  await expect(scale).toContainText("population 3 million");
  await expect(scale).toContainText("GDP PPP USD 25 billion");
  await expect(scale).toContainText("× 10,000");
  await expect(scale).toContainText("65%");
  await expect(scale).toContainText("constant 2030 international $");
  expect(errors).toEqual([]);
});

test("ratio check: tolerances, blocking and warning tests, World row and counts per ratio from the manifest", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const check = page.locator("#ratio-check");
  await expect(check.locator("h2")).toHaveText("Cross-check with WIPO");
  await expect(page.locator('.toc a[href="#ratio-check"]')).toHaveCount(1);
  await expect(check).toContainText(`${method.abs_tolerance} + ${percentOf(method.rel_tolerance)}%`);
  await expect(check).toContainText("The World row always blocks");
  await expect(check).toContainText(`within ${method.wdi_max_lag} years`);
  await expect(check).toContainText("revises GDP and population after WIPO's release");
  for (const id of WIPO_IDS) {
    const block = manifest.checks.ratios[id];
    const part = check.locator(`[data-ratio-check="${id}"]`);
    await expect(part).toHaveCount(1);
    await expect(part.locator(".ratio-counts")).toContainText(`${GROUPED(block.compared)} compared`);
    await expect(part.locator(".ratio-counts")).toContainText(`${GROUPED(block.failing_count)} outside tolerance`);
    await expect(part.locator(".ratio-counts")).toContainText(`World row: ${block.world}`);
    const test = method.blocking_test[id];
    if (test === "cell_share") {
      await expect(part.locator(".ratio-blocking")).toContainText(`${percentOf(method.fail_share_max)}% of the compared cells`);
      await expect(part.locator(".ratio-warning-only")).toContainText(`${percentOf(method.country_factor_max)}%`);
    } else {
      await expect(part.locator(".ratio-blocking")).toContainText(`${percentOf(method.country_share_max)}% of the compared countries`);
      await expect(part.locator(".ratio-blocking")).toContainText(`${percentOf(method.country_factor_max)}%`);
      await expect(part.locator(".ratio-warning-only")).toContainText(`${percentOf(method.fail_share_max)}% of the compared cells`);
    }
    for (const warning of block.warnings) await expect(part.locator(".ratio-warnings")).toContainText(warning);
    const vintage = part.locator(".ratio-vintage");
    await expect(vintage).toContainText(`${block.vintage_factors.length} countries`);
    await expect(vintage).toContainText(`${percentOf(method.vintage_note_min)}%`);
    for (const item of block.vintage_factors.slice(0, 5)) await expect(vintage).toContainText(`${item.code} ${item.median_factor}`);
    if (block.vintage_factors.length > 5) {
      await expect(vintage).not.toContainText(`${block.vintage_factors[5].code} ${block.vintage_factors[5].median_factor}`);
    }
    await expect(vintage).toContainText("For countries with very small values, rounding to one decimal alone can move this factor far from 1.");
    for (const line of block.failing.slice(0, 3)) await expect(part.locator(".ratio-failing")).toContainText(line);
  }
  expect(errors).toEqual([]);
});

test("ratio check follows patched counts, warnings, vintage list and unlisted codes", async ({ page }) => {
  const errors = trackErrors(page);
  const [first] = WIPO_IDS;
  await patchData(page, ({ overview: o, manifest: m }) => {
    o.method.ratios.abs_tolerance = 0.25;
    o.method.ratios.rel_tolerance = 0.02;
    o.method.ratios.wdi_max_lag = 4;
    o.method.ratios.country_share_max = 0.2;
    o.method.ratios.fail_share_max = 0.3;
    Object.assign(m.checks.ratios[first], {
      compared: 12345, failing_count: 678, failing: ["patched failing line 1", "patched failing line 2"],
      warnings: ["patched warning line"], world: "fail", world_failing: ["patched world line"],
      unlisted: [{ code: "ZZ", years: "1999-2001" }],
      vintage_factors: [1.5, 1.4, 1.3, 1.2, 1.1, 1.05, 1.04].map((median_factor, index) => ({ code: `V${index}`, median_factor })),
    });
  });
  await page.goto("/methods.html");
  const check = page.locator("#ratio-check");
  await expect(check).toContainText("0.25 + 2%");
  await expect(check).toContainText("within 4 years");
  const part = check.locator(`[data-ratio-check="${first}"]`);
  await expect(part.locator(".ratio-counts")).toContainText("12,345 compared");
  await expect(part.locator(".ratio-counts")).toContainText("678 outside tolerance");
  await expect(part.locator(".ratio-counts")).toContainText("World row: fail");
  await expect(part).toContainText("patched warning line");
  await expect(part).toContainText("patched world line");
  await expect(part.locator(".ratio-vintage")).toContainText("7 countries");
  await expect(part.locator(".ratio-vintage")).toContainText("V0 1.5, V1 1.4, V2 1.3, V3 1.2, V4 1.1");
  await expect(part.locator(".ratio-vintage")).not.toContainText("V5");
  await expect(part.locator(".ratio-unlisted")).toContainText("ZZ");
  await expect(part.locator(".ratio-unlisted")).toContainText("1999-2001");
  await expect(part).toContainText("patched failing line 2");
  await expect(part).toContainText("2 of 678");
  expect(errors).toEqual([]);
});

test("regression lines in the checks section: threshold, count, listed revisions and accepted lines", async ({ page }) => {
  const errors = trackErrors(page);
  await patchData(page, ({ manifest: m }) => {
    m.checks.regression = {
      warn_pct: 7, revision_count: 31, revisions: ["CH origin_apps resident 2019: 100 -> 120 (+20.0%)"],
      accepted: ["series last year moved back: origin_apps 2024 -> 2023"],
    };
  });
  await page.goto("/methods.html");
  const section = page.locator("#check-regression");
  await expect(section).toHaveText("Against the data already published");
  const body = page.locator("#cross-checks");
  await expect(body).toContainText("more than 7% ");
  await expect(body).toContainText("31 revisions, the first 1 listed");
  await expect(body).toContainText("CH origin_apps resident 2019: 100 -> 120 (+20.0%)");
  await expect(body).toContainText("series last year moved back: origin_apps 2024 -> 2023");
  expect(errors).toEqual([]);
});

test("regression lines from the committed manifest; none recorded in an older manifest", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const regression = manifest.checks.regression;
  await expect(page.locator("#cross-checks")).toContainText(`more than ${regression.warn_pct}% `);
  await expect(page.locator("#cross-checks")).toContainText(`${regression.revision_count} revisions`);
  await patchData(page, ({ manifest: m }) => { delete m.checks.regression; });
  await page.goto("about:blank"); // a hash-only change would keep the page drawn from the unpatched manifest
  await page.goto("/methods.html#check-regression");
  await expect(page.locator("#check-regression")).toBeVisible();
  await expect(page.locator("#cross-checks")).toContainText("Not recorded in this release.");
  expect(errors).toEqual([]);
});

test("data written before v0.2b (no ratio method, no ratio checks): no scale or ratio-check section, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await patchData(page, ({ overview: o, manifest: m }) => {
    delete o.method.ratios;
    delete m.checks.ratios;
    delete m.ratio_labels;
    delete m.wdi_denominators;
  });
  await page.goto("/methods.html#cross-checks");
  await expect(page.locator("#cross-checks")).toBeVisible();
  await expect(page.locator("#scale")).toHaveCount(0);
  await expect(page.locator("#ratio-check")).toHaveCount(0);
  await expect(page.locator('.toc a[href="#scale"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// --- final review fixes on the methods page (I2, M1, M3, M7) ------------------------------------------------------------

const entityLabels = new Map((readJson("site/data/entities.json") as { code: string; label: string; kind: string }[])
  .map((entity) => [entity.code, entity]));

test("I2: 'No denominator' names the countries without WDI population or GDP from the data, with the cards' reason text", async ({ page }) => {
  const noDenominator: Record<string, string[]> = overview.ratio_no_denominator;
  expect(noDenominator.population.length).toBeGreaterThan(0); // data guard: the bullet has names to show
  await page.goto("/methods.html");
  const bullet = page.locator("#scale [data-no-denominator]");
  for (const code of [...noDenominator.population, ...noDenominator.gdp_ppp]) {
    await expect(bullet).toContainText(`${entityLabels.get(code)?.label} (${code})`);
  }
  await expect(bullet).toContainText("“no population data (World Bank WDI)”");
  await expect(bullet).toContainText("“no GDP data (World Bank WDI)”");
  const former = [...entityLabels.values()].filter((entity) => entity.kind === "historical").map((entity) => entity.label);
  for (const label of former) await expect(bullet).toContainText(label);
  await expect(bullet).not.toContainText("Taiwan");
  await expect(bullet).not.toContainText("population/GDP");
});

test("I2: without ratio_no_denominator in the data the bullet says 'not recorded', no error", async ({ page }) => {
  const errors = trackErrors(page);
  await patchData(page, ({ overview: o }) => { delete o.ratio_no_denominator; });
  await page.goto("/methods.html");
  await expect(page.locator("#scale [data-no-denominator]")).toContainText("Without WDI population in any year: not recorded");
  expect(errors).toEqual([]);
});

test("M1: GDP base sentence quotes WIPO's label as published and our WDI base from the manifest", async ({ page }) => {
  await page.goto("/methods.html");
  const sentence = page.locator("#scale .gdp-base");
  await expect(sentence).toContainText(`WIPO's per-GDP label, as published: “${manifest.ratio_labels.per_gdp}”`);
  await expect(sentence).toContainText(`constant ${manifest.wdi_denominators.gdp_ppp.gdp_base} PPP GDP`);
  await expect(sentence).toContainText(manifest.wdi_denominators.gdp_ppp.name);
  await expect(sentence).toContainText("earlier WDI release");
  await expect(sentence).not.toContainText("match");
  await expect(sentence.locator('a[href="#ratio-check"]')).toHaveCount(1);
});

test("M2, M3: the years sentence states the below-precision rule and PCT per million's first year from the data", async ({ page }) => {
  await page.goto("/methods.html");
  const sentence = page.locator("#scale .ratio-years");
  await expect(sentence).toContainText("“under 0.05 at one decimal; WIPO publishes no figure”");
  await expect(sentence).toContainText("(PCT and group figures: “under 0.05 at one decimal”)");
  const pctFirst = Math.min(...Object.keys(overview.world_ratios.pct_per_million).map(Number));
  await expect(sentence).toContainText(`Ratios start in ${method.ratio_from}`);
  if (pctFirst > method.ratio_from) await expect(sentence).toContainText(`PCT per million starts in ${pctFirst}`);
});

test("M7: thresholds list per million before per GDP; the known-drift sentence says it once", async ({ page }) => {
  await page.goto("/methods.html");
  await expect(page.locator("#scale dl.facts dt")).toHaveText(["Per million", "Per GDP"]);
  const drift = page.locator("#ratio-check p", { hasText: "Known drift" });
  await expect(drift).not.toContainText("(WDI revisions after WIPO's release)");
  await expect(drift).toContainText("by one factor.");
});

// --- women inventors (Stage W, Task 6) ----------------------------------------------------------------------------------
// Every number in #women-inventors comes from a data file: the baseline test reads the committed files, the patched test
// routes changed copies and expects the page to follow.
type Json = Record<string, any>;
const GENDER_TITLES = {
  women_any: "PCT applications with at least one woman inventor",
  women_share: "Women's share of PCT inventors",
  women_any_by_field: "Applications with at least one woman inventor, by technology field (world)",
};
const groupItems = readJson("site/data/groups.json").items as { id: string; kind: string; label: string; members: string[] }[];
const shareText = (value: number, decimals: number): string => `${(Math.round(value * 10 ** decimals) / 10 ** decimals).toFixed(decimals)}%`;
const entityName = (code: string): string => `${entityLabels.get(code)?.label ?? code} (${code})`;

type WomenFiles = { overview: Json; manifest: Json };
const committedWomenFiles = (): WomenFiles => ({ overview: structuredClone(overview), manifest: structuredClone(manifest) });

/** The methods page reads gender facts from overview.json and the manifest only: routes changed copies of the two. */
async function routeWomenFiles(page: Page, change: (files: WomenFiles) => void): Promise<WomenFiles> {
  const files = committedWomenFiles();
  change(files);
  await page.route("**/data/overview.json", (route) => route.fulfill({ json: files.overview }));
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: files.manifest }));
  return files;
}

async function expectWomenSection(page: Page, files: WomenFiles): Promise<void> {
  const { overview: ov, manifest: mf } = files;
  const gm = ov.method.gender;
  const section = page.locator("#women-inventors");
  await expect(section.locator("h2")).toHaveText("Women inventors");
  await expect(page.locator('.toc a[href="#women-inventors"]')).toHaveCount(1);
  // the two measures, named apart, with WIPO's table labels and years
  const facts = section.locator("#women-measures dl.facts");
  await expect(facts.locator("dt")).toHaveText([GENDER_TITLES.women_any, GENDER_TITLES.women_share, GENDER_TITLES.women_any_by_field]);
  for (const [index, id] of (["women_any", "women_share", "women_any_by_field"] as const).entries()) {
    const text = facts.locator("dd").nth(index);
    await expect(text).toContainText(mf.gender_labels[id]);
    if (id === "women_any_by_field") continue;
    await expect(text).toContainText(`${gm.first_year} to ${ov.gender.last_year[id]}`);
  }
  // the field table holds the years of its source block (last year only today), never the measures' first to last year
  const [fieldFrom, fieldTo] = ov.sources.women_any_by_field.years.split("-");
  const fieldText = facts.locator("dd").nth(2);
  await expect(fieldText).toContainText(fieldFrom === fieldTo ? `${fieldFrom} only (last year)` : `${fieldFrom} to ${fieldTo}`);
  await expect(fieldText).not.toContainText(`${gm.first_year} to`);
  await expect(fieldText).toContainText("world only");
  // basis, denominator, omissions: wording, never "too few"
  await expect(section).toContainText("publication year");
  await expect(section).toContainText(gm.method_note.citation);
  await expect(section.locator(`a[href="${gm.method_note.url}"]`).first()).toBeVisible();
  await expect(section).toContainText("docs/research/2026-10-21-wipo-women-inventors.md");
  // claims limited to what the research note supports
  await expect(section).toContainText("WIPO's Data Center publishes shares only (no counts)");
  await expect(section).toContainText("not stated in the PCT Yearly Review 2026");
  await expect(section).toContainText("methodology pages are not checked here");
  await expect(section).not.toContainText("name-gender");
  await expect(section).not.toContainText("never as counts");
  const methodologyHost = /methodology: (\S+?)\)/.exec(gm.method_note.page)?.[1];
  expect(methodologyHost, "a methodology URL in the method note's page text").toBeTruthy();
  const methodologyUrl = `https://${methodologyHost}`; // the note writes it without a scheme
  await expect(section.locator(`#women-basis a[href="${methodologyUrl}"]`)).toHaveCount(1);
  await expect(section).toContainText("not published by WIPO for this year");
  await expect(section).not.toContainText("too few");
  await expect(section).toContainText(`Listed origins with no value in any year: ${GROUPED(mf.absent_rows.women_any)} for ${GENDER_TITLES.women_any}, ${GROUPED(mf.absent_rows.women_share)} for ${GENDER_TITLES.women_share}`);
  await expect(section).not.toContainText("Rows WIPO returned empty");
  await expect(section.locator("#women-omissions")).toContainText("not explained by size alone");
  await expect(section.locator("#women-omissions")).not.toContainText("many publications");
  // group method: floor and coverage decimals from method.gender, left-out members named per group
  const groupPart = section.locator("#women-groups");
  await expect(groupPart).toContainText(`${Math.round(gm.group_coverage_min * 100)}%`);
  await expect(groupPart).toContainText("computed from WIPO shares weighted by PCT publications");
  await expect(groupPart).toContainText("not computable (WIPO publishes no inventor counts)");
  const summary: Record<string, Json> = ov.gender.groups;
  const leftOut = groupItems.filter((item) => (summary[item.id]?.unlisted ?? []).length > 0);
  expect(leftOut.length).toBeGreaterThan(0);
  const leftItems = groupPart.locator(".women-left-out li");
  await expect(leftItems).toHaveCount(leftOut.length);
  for (const item of leftOut) {
    const names: string[] = summary[item.id].unlisted.map(entityName);
    await expect(leftItems.filter({ hasText: `${item.label}: ` }).first()).toHaveText(`${item.label}: without PCT publications data: ${names.join(", ")} (${item.members.length} members in all)`);
  }
  // printed group figures: value, group, measure and year from overview.gender.groups; citation and link from printed_source
  const printed = groupItems.flatMap((item) => Object.entries<Json>(summary[item.id]?.printed ?? {})
    .flatMap(([measure, years]) => Object.entries<number>(years).map(([year, value]) => ({ item, measure: measure as "women_any" | "women_share", year, value }))));
  expect(printed.length).toBeGreaterThan(0);
  const printedItems = groupPart.locator(".women-printed li");
  await expect(printedItems).toHaveCount(printed.length);
  for (const { item, measure, year, value } of printed) {
    const line = printedItems.filter({ hasText: `: ${item.kind === "region" ? `${item.label}, region ${item.id}` : item.label}, ${GENDER_TITLES[measure]}, ${year}` });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(shareText(value, gm.decimals));
    const ref = summary[item.id].printed_refs[measure][year]; // figure and page cited from the data, never typed
    expect(ref.figure && ref.page).toBeTruthy();
    await expect(line).toContainText(`figure ${ref.figure}, ${ref.page}`);
  }
  const cited = groupPart.locator(".women-printed-source");
  await expect(cited).toContainText(ov.gender.printed_source.citation);
  await expect(cited.locator(`a[href="${ov.gender.printed_source.url}"]`)).toHaveCount(1);
  // technology fields: world only
  await expect(section.locator("#women-fields")).toContainText("world only");
  await expect(section.locator("#women-fields")).toContainText("region and technology field) and a figure (A27: by top-10 origin and technology field); they are not in this version");
  await expect(section.locator("#women-fields")).toContainText("a table (A26: women's share by region and technology field)");
  await expect(section.locator("#women-fields")).not.toContainText("two more tables");
  // cross-check: tolerance, compared years, largest gap and the years over tolerance from the manifest / method
  const check = mf.checks.gender;
  const checkFacts = section.locator("#women-crosscheck dl.facts");
  await expect(checkFacts).toContainText(`${shareText(gm.crosscheck_tolerance_pp, gm.decimals).replace("%", "")} pp`);
  await expect(checkFacts).toContainText(`${check.compared} years`);
  await expect(checkFacts).toContainText(check.max_gap_pp === null ? "none compared" : `${shareText(check.max_gap_pp, gm.decimals).replace("%", "")} pp`);
  await expect(checkFacts).toContainText(check.gap_years.length ? check.gap_years.join(", ") : "none");
  for (const warning of check.warnings) await expect(section.locator("#women-crosscheck")).toContainText(warning);
  // the stop rule as run.py enforces it: at most half the compared years = warnings, more than half = refresh blocked
  await expect(section.locator("#women-crosscheck")).toContainText("at most half of the compared years, the refresh goes on with the warnings");
  await expect(section.locator("#women-crosscheck")).toContainText("in more than half of them, the weighting no longer reproduces WIPO and the refresh is blocked");
  await expect(section.locator("#women-crosscheck")).not.toContainText("warning only)");
  // continent cross-check sentence from the data: printed continent women_any figures, none today
  const printedAny: number = Object.values<Json>(ov.gender.groups).reduce((sum: number, group: Json) => sum + Object.keys(group.printed?.women_any ?? {}).length, 0);
  if (printedAny === 0) {
    await expect(section.locator("#women-crosscheck")).toContainText("prints no continent figure for");
    await expect(section.locator("#women-crosscheck")).toContainText("compares nothing in this release; it runs when one is entered");
    await expect(section.locator("#women-crosscheck")).not.toContainText("continent figure WIPO prints in its report");
  } else {
    await expect(section.locator("#women-crosscheck")).toContainText("continent figure WIPO prints in its report");
    await expect(section.locator("#women-crosscheck")).toContainText(`(${printedAny} ${printedAny === 1 ? "figure" : "figures"} in this release)`);
    await expect(section.locator("#women-crosscheck")).toContainText("a warning only, listed here; it never blocks the refresh");
    await expect(section.locator("#women-crosscheck")).not.toContainText("compares nothing");
  }
  // golden lines of the women figures
  const golden = section.locator("#women-golden");
  const lines: string[] = mf.checks.golden.filter((line: string) => line.startsWith("women_"));
  expect(lines.length).toBeGreaterThan(0);
  await expect(golden.locator("ul.check-lines li")).toHaveText(lines);
  await expect(golden).toContainText(`within ${ov.method.golden_tolerance_pct}% of its printed value, a relative tolerance`);
  for (const source of mf.checks.golden_sources.filter((entry: Json) => entry.id.startsWith("women_")))
    await expect(golden.locator(".women-golden-sources li", { hasText: source.id })).toContainText(source.page);
  // caveat with WIPO's method note
  await expect(section.locator("#women-caveat")).toContainText("Gender is attributed by WIPO");
  await expect(section.locator("#women-caveat")).toContainText("The PCT Yearly Review 2026 does not state the denominator");
  await expect(section.locator("#women-caveat")).toContainText(gm.method_note.page);
}

test("women inventors: every figure of the section equals the committed data files", async ({ page }) => {
  const errors = trackErrors(page);
  const files = await routeWomenFiles(page, () => undefined);
  await page.goto("/methods.html#women-inventors");
  await expectWomenSection(page, files);
  expect(errors).toEqual([]);
});

test("women inventors: patched data files change every figure of the section", async ({ page }) => {
  const errors = trackErrors(page);
  const files = await routeWomenFiles(page, ({ overview: ov, manifest: mf }) => {
    ov.method.gender.crosscheck_tolerance_pp = 0.7;
    ov.method.gender.group_coverage_min = 0.65;
    ov.method.gender.first_year = 2003;
    ov.method.golden_tolerance_pct = 3;
    ov.method.gender.method_note.page = "p. 1 (methodology: www.example.org/patched-method)";
    ov.sources.women_any_by_field.years = "2020-2021";
    ov.gender.groups.europe.printed_refs.women_share["2025"] = { figure: "A99", page: "patched page 77" };
    ov.gender.last_year = { women_any: 2023, women_share: 2022, women_any_by_field: 2021 };
    mf.gender_labels = { women_any: "label A (patched)", women_share: "label B (patched)", women_any_by_field: "label C (patched)" };
    mf.absent_rows.women_any = 7777;
    mf.checks.gender = { compared: 17, gap_years: [2011, 2012], max_gap_pp: 0.9, warnings: ["2011: patched gap 0.9 pp over 0.7 pp"] };
    mf.checks.golden = [...mf.checks.golden, "women_any_world_2030: live 11.1 vs published 11.1 (+0.00%)"];
    mf.checks.golden_sources = [...mf.checks.golden_sources,
      { id: "women_any_world_2030", citation: "Patched Citation", page: "patched page 99", url: "https://example.org/patched.pdf" }];
    ov.gender.groups.europe.unlisted = ["GG", "CH"]; // Switzerland drops out of "m" of its continent
    ov.gender.groups.europe.printed.women_share["2025"] = 12.3;
    ov.gender.groups.oceania.printed.women_share["2025"] = 9.9;
    ov.gender.groups.europe.printed.women_any = { "2025": 16.3 }; // WIPO prints a continent women_any figure: the check compares
    ov.gender.groups.europe.printed_refs.women_any = { "2025": { figure: "A24", page: "patched page 9" } };
    ov.gender.printed_source = { citation: "Patched Printed Citation (2030)", url: "https://example.org/printed.pdf" };
  });
  await page.goto("/methods.html#women-inventors");
  await expectWomenSection(page, files);
  await expect(page.locator("#women-groups .women-left-out")).toContainText("Switzerland (CH)");
  await expect(page.locator("#women-crosscheck")).toContainText("(1 figure in this release)");
  await expect(page.locator("#women-groups .women-printed")).toContainText("12.3%");
  await expect(page.locator("#women-groups .women-printed")).toContainText("9.9%");
  await expect(page.locator("#women-groups .women-printed")).toContainText("figure A99, patched page 77");
  await expect(page.locator("#women-measures dl.facts dd").nth(2)).toContainText("2020 to 2021");
  await expect(page.locator('#women-basis a[href="https://www.example.org/patched-method"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("women inventors: the methods page requests no group file and no PCT origin map file; no gender data, no section", async ({ page }) => {
  const errors = trackErrors(page);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.goto("/methods.html#women-inventors");
  await expect(page.locator("#women-inventors")).toBeVisible();
  await expect(page.locator("#women-groups .women-left-out li").first()).toBeVisible();
  expect(requested.filter((url) => url.includes("/data/group/") || url.includes("map/pct_origin.json"))).toEqual([]);
  expect(errors).toEqual([]);
  const bare = await page.context().newPage();
  await bare.route("**/data/overview.json", async (route) => {
    const ov: Json = await (await route.fetch()).json();
    delete ov.gender;
    delete ov.method.gender;
    await route.fulfill({ json: ov });
  });
  await bare.goto("/methods.html#world-totals");
  await expect(bare.locator("#world-totals")).toBeVisible();
  await expect(bare.locator("#women-inventors")).toHaveCount(0);
  await expect(bare.locator('.toc a[href="#women-inventors"]')).toHaveCount(0);
});

test("wallboard section names the women-inventors page among the views", async ({ page }) => {
  await page.goto("/methods.html");
  const wallboard = page.locator("#wallboard");
  await expect(wallboard).toContainText(`shows ${JSON.parse(readFileSync("site/config.json", "utf8")).rotation.views.length} views`);
  await expect(wallboard).toContainText("women-inventors page");
});

test("wallboard section states what the board runs with: no wallboard block or an invalid one -> the board's defaults, page intact (final review M3)", async ({ page }) => {
  const errors = trackErrors(page);
  const config = JSON.parse(readFileSync("site/config.json", "utf8"));
  const { wallboard, ...withoutBoard } = config;
  let served: unknown = withoutBoard;
  await page.route("**/config.json", (route) => route.fulfill({ json: served }));
  await page.goto("/methods.html");
  const section = page.locator("#wallboard");
  await expect(section).toContainText(`of 0 charts, one per slide, each for ${BOARD_FALLBACK.seconds} seconds`);
  await expect(section).not.toContainText("Text is at least"); // no configured minimums: no claim
  await expect(section).not.toContainText("undefined");
  await expect(page.locator(".notice-error")).toHaveCount(0);
  await expect(page.locator("#notices")).toBeHidden();
  await expect(page.locator("footer")).toContainText("The Secretariat of WIPO");

  served = { ...config, wallboard: { ...wallboard, seconds: config.rotation.minSeconds - 1 } };
  await page.reload();
  await expect(section).toContainText(`of ${wallboard.slides.length} charts, one per slide, each for ${BOARD_FALLBACK.seconds} seconds`);
  await expect(section).toContainText(`Text is at least ${wallboard.minTextPx} px`);
  await expect(page.locator(".notice-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function expectPctSection(page: Page, pct: any): Promise<void> {
  const section = page.locator("#pct-membership");
  await expect(section.locator("h2")).toHaveText("PCT membership");
  await expect(page.locator('.toc a[href="#pct-membership"]')).toHaveCount(1);
  // both WIPO documents, linked: the page (rows) and the PDF list (count, status date)
  await expect(section.locator(`a[href="${pct.source_url}"]`)).toHaveCount(1);
  await expect(section.locator(`a[href="${pct.count_check_url}"]`)).toHaveCount(1);
  await expect(section).toContainText(`${pct.count[pct.last_year]} States on ${pct.status_on}`);
  await expect(section).toContainText(`retrieved ${pct.retrieved}`);
  // member rule: bound by 31 December; the latest year as of the status date; slider from the treaty's first year
  await expect(section).toContainText("bound by the PCT by 31 December of that year");
  await expect(section).toContainText(`the latest year, ${pct.last_year}, shows the list as of ${pct.status_on}`);
  await expect(section).toContainText(`The year slider starts in ${pct.first_year}`);
  await expect(section).toContainText("today's Contracting States bound by 31 December of each year; territories and former entities are not counted");
  await expect(section).toContainText("A former entity (");
  await expect(section).toContainText("never shown as a non-member");
  await expect(section).not.toContainText("former State (");
  // territories: WIPO's page footnotes, each with its State and date, from the overview
  await expect(section).toContainText("Where a footnote on WIPO's page says the PCT applies to a territory through a Contracting State");
  for (const territory of pct.territories) {
    for (const p of territory.periods) {
      await expect(section).toContainText(`through ${stateInProse(p.state)} ${p.to ? `${p.from} to ${p.to}` : `since ${p.from}`}`);
      for (const cited of p.sources) if (cited.url !== pct.source_url) await expect(section.locator(`a[href="${cited.url}"]`)).toHaveCount(1);
      // the sources of one period, as read: "footnote" for WIPO's page, else each document's name, ", " between
      const named = p.sources.map((cited: { url: string; document: string }) => (cited.url === pct.source_url ? "footnote" : cited.document.split(" (")[0])).join(", ");
      await expect(section).toContainText(`${p.to ? `${p.from} to ${p.to}` : `since ${p.from}`} (${named})`);
    }
  }
  await expect(section).toContainText("PCT Notification No. 34, PCT Notification No. 122"); // Hong Kong before 1997
  // successor States: the rule stated neutrally, no "part of" wording, no reason clause
  await expect(section).toContainText("years while its territory's treaty status depended on a former State, or on a State it left, are not shown");
  await expect(section).not.toContainText("part of");
  await expect(section).not.toContainText("gives no dates for former States");
  // successor States: ISO 3166-3 (ISO 3166-1 for a State that left a continuing one); each predecessor, its States, note
  await expect(section).toContainText("Successor States follow ISO 3166-3 (former country codes)");
  const items = section.locator("ul.pct-successors li");
  await expect(items).toHaveCount(pct.successors.length);
  for (const [index, entry] of (pct.successors as { name: string; source: string; from: string | null; to: string; end_source: string; codes: string[]; own_dates: Record<string, string>; note: string }[]).entries()) {
    await expect(items.nth(index)).toContainText(`${entry.name} (${entry.source}), ${entry.from ?? pct.first_year} to ${entry.to} (end: ${entry.end_source}): `);
    for (const code of entry.codes) {
      await expect(items.nth(index)).toContainText(`${entityLabels.get(code)?.label ?? code} (${code})${entry.own_dates[code] ? `, own date ${entry.own_dates[code]}` : ""}`);
    }
    if (entry.note) await expect(items.nth(index)).toContainText(entry.note);
  }
  for (const state of pct.continuing) await expect(section).toContainText(`${state.name} (continuing ${state.continues})`);
  await expect(section).toContainText("date as printed by WIPO");
  await expect(section).toContainText("WIPO's PDF list prints the code MT for Mauritius");
  await expect(section).toContainText(`named under the map: ${pct.unmatched.length ? pct.unmatched.join(", ") : "none"}.`);
  await expect(section).toContainText("updated by hand");
}

test("PCT membership section: both WIPO documents, count, status date, member rule and continuing States from the overview; TOC links it", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  await expectPctSection(page, overview.pct_membership);
  expect(errors).toEqual([]);
});

test("PCT membership section follows patched data; without pct_membership no section, no error", async ({ page }) => {
  const errors = trackErrors(page);
  const patched = structuredClone(overview.pct_membership);
  Object.assign(patched, { status_on: "2027-02-01", retrieved: "2027-02-03", last_year: 2027, first_year: 1979, unmatched: ["QZ"],
    continuing: [{ code: "RU", continues: "Testland", in_force: "1978-03-29", name: "Russian Federation" }] });
  patched.count["2027"] = 161;
  await patchData(page, ({ overview: ov }) => { ov.pct_membership = patched; });
  await page.goto("/methods.html");
  await expectPctSection(page, patched);
  expect(errors).toEqual([]);
  const bare = await page.context().newPage();
  const bareErrors = trackErrors(bare);
  await bare.route("**/data/overview.json", async (route) => {
    const ov = await (await route.fetch()).json();
    delete ov.pct_membership;
    await route.fulfill({ json: ov });
  });
  await bare.goto("/methods.html#map");
  await expect(bare.locator("#map")).toBeVisible();
  await expect(bare.locator("#pct-membership")).toHaveCount(0);
  await expect(bare.locator('.toc a[href="#pct-membership"]')).toHaveCount(0);
  expect(bareErrors).toEqual([]);
});

// --- v2a: treemap, share shift, world change, golden rules, dashboard ---------------------------------------------------
// Numbers are read from overview.json and config.json; only wording is typed.
const config = readJson("site/config.json");
const term = (page: Page, name: string) => page.locator("#formulas dt", { hasText: new RegExp(`^${name}$`) }).locator("xpath=following-sibling::dd[1]");

test("methods: the treemap term states fold rule, residual, denominator, floor and the negative-rest rule", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const dd = term(page, "Treemap");
  const { fold_share_pct: fold } = overview.method.treemap;
  await expect(dd).toContainText(`below ${fold} % of WD, exact, before rounding`);
  await expect(dd).toContainText("a folded origin may show as");
  await expect(dd).toContainText("“Other <continent>”");
  await expect(dd).toContainText("one rectangle named after the continent");
  await expect(dd).toContainText(`“${overview.treemap.residual.label}”`);
  await expect(dd).toContainText(overview.share_denominator.origin_apps);
  await expect(dd).toContainText(`grouped countries of all continents together account for at least ${Math.round(overview.method.group_attribution_min * 100)}% of the world total (the attribution floor)`);
  await expect(dd).toContainText("the WIPO world total is present and not provisional");
  await expect(dd).not.toContainText("A continent total counts only");
  await expect(dd).toContainText("is a warning in the continent-share history");
  await expect(dd).toContainText("blocks at the treemap year: the refresh stops and the last good data stays");
  await expect(dd).toContainText("The refresh also stops when origins without a continent exceed that rest");
  await expect(dd).toContainText("each rounded on their own");
  await expect(dd).toContainText("add up to 100");
  expect(errors).toEqual([]);
});

test("methods: the share shift term states the base year, the change rule, the bound, the gaps and the breaks", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const dd = term(page, "Share shift");
  const { cagr_years: years, share_shift: shift } = overview.method;
  const bound = (10 ** -shift.decimals).toFixed(shift.decimals);
  await expect(dd).toContainText(`of the top ${overview.top_n} origins of ${overview.share_shift.year}`);
  await expect(dd).toContainText(`${years} years before`);
  await expect(dd).toContainText(`${overview.share_shift.base_year}`);
  await expect(dd).toContainText("percentage points");
  await expect(dd).toContainText(shift.change);
  await expect(dd).toContainText(`rounded to ${shift.decimals} decimals`);
  await expect(dd).toContainText(`within ${bound} pp of the exact difference`);
  await expect(dd).toContainText("sign never flips");
  await expect(dd).toContainText("no figure in the base year is listed under the chart, not plotted");
  await expect(dd).toContainText("series break");
  expect(errors).toEqual([]);
});

test("methods: world change is defined, and the golden sentence states both tolerance rules", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const change = term(page, "World change");
  await expect(change).toContainText("WD");
  await expect(change).toContainText("ZZ");
  await expect(change).toContainText("computed from WIPO's totals");
  const { golden_tolerance_pct: pct, golden_growth_tolerance_pp: pp } = overview.method;
  const sentence = page.locator("#cross-checks p", { hasText: "Headline figures from WIPO" });
  await expect(sentence).toContainText(`every figure except growth within ${pct}% (relative)`);
  await expect(sentence).toContainText(`growth figures within ${pp} percentage points (absolute)`);
  // the checks list shows both growth figures, from the manifest
  const growthIds: string[] = manifest.checks.golden_sources.map((source: Json) => source.id).filter((id: string) => id.includes("_growth_"));
  expect(growthIds.length).toBe(2);
  for (const id of growthIds) {
    await expect(page.locator("#cross-checks .check-lines li", { hasText: id })).toHaveCount(1);
    await expect(page.locator("#cross-checks .golden-sources li", { hasText: id })).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test("methods: the treemap, share shift and growth tolerance are left out of data that lacks them, without error", async ({ page }) => {
  const errors = trackErrors(page);
  await page.route("**/data/overview.json", async (route) => {
    const ov: Json = await (await route.fetch()).json();
    delete ov.method.treemap;
    delete ov.method.share_shift;
    delete ov.method.golden_growth_tolerance_pp;
    delete ov.treemap;
    delete ov.share_shift;
    await route.fulfill({ json: ov });
  });
  await page.goto("/methods.html#formulas");
  await expect(page.locator("#formulas")).toBeVisible();
  await expect(page.locator("#formulas dt", { hasText: /^Treemap$/ })).toHaveCount(0);
  await expect(page.locator("#formulas dt", { hasText: /^Share shift$/ })).toHaveCount(0);
  await expect(page.locator("#cross-checks")).not.toContainText("percentage points (absolute)");
  expect(errors).toEqual([]);
});

test("methods: the dashboard section lists the tiles, the controls, the holds and ?rotate=", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const section = page.locator("#dashboard");
  await expect(section.locator("h2")).toHaveText("Dashboard");
  await expect(page.locator('.toc a[href="#dashboard"]')).toHaveCount(1);
  await expect(section).toContainText("?view=dashboard");
  // one list entry per tile of the dashboard, in page order (dashboard.ts DASHBOARD_TILE_IDS, read from the source)
  const tileIds: string[] = JSON.parse(/^export const DASHBOARD_TILE_IDS = (\[[^\]]+\]);/m.exec(readFileSync("site/src/dashboard.ts", "utf8"))![1]);
  await expect(section.locator(".dashboard-tiles li")).toHaveCount(tileIds.length);
  expect(await section.locator(".dashboard-tiles li").evaluateAll((items) => items.map((item) => item.getAttribute("data-tile")))).toEqual(tileIds);
  await expect(section).toContainText("Next to the world map, a carousel shows");
  await expect(section).not.toContainText("Beside the key figures");
  await expect(section).toContainText("links to its full chart on the overview");
  await expect(section).toContainText(`${config.dashboard.slides.length} charts`);
  await expect(section).toContainText(`${config.dashboard.seconds} seconds`);
  for (const name of ["Play", "Pause", "Previous", "Next"]) await expect(section.locator("code", { hasText: new RegExp(`^${name}$`) })).toHaveCount(1);
  const { resumeAfterSeconds, pauseMovePixels, minSeconds } = config.rotation;
  const holds = section.locator("ul.carousel-holds li");
  await expect(holds).toHaveCount(4);
  await expect(holds.nth(0)).toContainText(`at least ${pauseMovePixels} pixels`);
  await expect(holds.nth(0)).toContainText(`${resumeAfterSeconds} seconds without movement`);
  await expect(holds.nth(1)).toContainText("Keyboard focus inside the carousel");
  await expect(holds.nth(1)).toContainText("A mouse click on a button does not");
  await expect(holds.nth(2)).toContainText("hidden browser tab");
  await expect(holds.nth(3)).toContainText("open figures, cite or embed panel");
  await expect(holds.nth(3)).toContainText("open sources and notes box");
  await expect(section).toContainText("Play also ends a pointer hold");
  await expect(section).toContainText("only Play ends that pause");
  await expect(section).toContainText("it never starts by itself");
  await expect(section).toContainText("even with reduced motion; reduced motion only turns off the fade between slides");
  await expect(section).toContainText(`?rotate=<seconds>`);
  await expect(section).toContainText(`at least ${minSeconds}`);
  expect(errors).toEqual([]);
});
