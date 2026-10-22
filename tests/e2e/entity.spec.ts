import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { entityBreakNote, fixtureBreak, routeSeriesBreaks } from "./seriesBreaks";

// Country and office pages + picker. Expected figures are read from the data files (no value typed here).
type YearMap = Record<string, number | null>;
type SeriesBlock = { types: Record<string, YearMap>; derived: { yoy: YearMap; cagr10: number | null; rank: YearMap; share: YearMap; resident_share: YearMap } };
type EntityFile = { code: string; label: string; kind: string; series: Record<string, SeriesBlock> };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson("site/data/manifest.json");
const overview = readJson("site/data/overview.json");
const entities: { code: string; label: string; kind: string }[] = readJson("site/data/entities.json");
const entity = (code: string): EntityFile => readJson(`site/data/entity/${code}.json`);
const count = (value: number): string => value.toLocaleString("en-US");
const decimals = overview.method.rounding.decimals;

const COUNTRY_CHARTS = ["origin-apps", "office-apps", "pct-origin"];

/** First entity in entities.json whose every value is null (the no-data case, picked from data). */
function allNullCode(): string {
  const found = entities.find((ref) => Object.values(entity(ref.code).series)
    .every((block) => Object.values(block.types).every((years) => Object.values(years).every((value) => value === null))));
  if (!found) throw new Error("no all-null entity in the data");
  return found.code;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("country page: three chart cards and tiles; origin total of the latest year matches entity/CH.json", async ({ page }) => {
  const errors = trackErrors(page);
  const swiss = entity("CH");
  await page.goto("/?country=CH");
  await expect(page.locator("h1")).toHaveText(swiss.label);
  for (const id of COUNTRY_CHARTS) {
    await expect(page.locator(`.chart-card[data-chart="${id}"] svg`).first()).toBeVisible();
  }
  const tiles = page.locator('.chart-card[data-chart="entity-tiles"]');
  await expect(tiles).toHaveCount(1);
  const last = String(overview.last_year.origin_apps);
  const total = swiss.series.origin_apps.types.total[last] as number;
  const originTiles = tiles.locator('[data-series="origin_apps"]');
  await expect(originTiles.locator(".tile", { hasText: `Applications, ${last}` }).locator(".tile-value")).toHaveText(count(total));
  // the origin chart's figures table carries the same value for the same year
  const origin = page.locator('.chart-card[data-chart="origin-apps"]');
  await origin.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(origin.locator("tbody tr").first().locator("td").first()).toHaveText(last);
  await expect(origin.locator("tbody tr").first().locator("td").nth(1)).toHaveText(count(total));
  expect(errors).toEqual([]);
});

test("country tiles: world share, rank, growth period and resident share from the data", async ({ page }) => {
  const swiss = entity("CH");
  await page.goto("/?country=CH");
  const last = String(overview.last_year.origin_apps);
  const derived = swiss.series.origin_apps.derived;
  const originTiles = page.locator('.chart-card[data-chart="entity-tiles"] [data-series="origin_apps"]');
  const share = originTiles.locator(".tile", { hasText: overview.share_denominator.origin_apps });
  await expect(share.locator(".tile-value")).toHaveText(`${(derived.share[last] as number).toFixed(decimals.share)}%`);
  await expect(originTiles.locator(".tile", { hasText: "Rank" }).locator(".tile-value")).toHaveText(String(derived.rank[last]));
  const years = overview.method.cagr_years;
  const period = `${Number(last) - years}–${last}`;
  await expect(originTiles.locator(".tile", { hasText: period }).locator(".tile-value"))
    .toContainText((derived.cagr10 as number).toFixed(decimals.cagr));
  const pctLast = String(overview.last_year.pct_origin);
  const pctTiles = page.locator('.chart-card[data-chart="entity-tiles"] [data-series="pct_origin"]');
  await expect(pctTiles.locator(".tile", { hasText: `Applications, ${pctLast}` }).locator(".tile-value"))
    .toHaveText(count(swiss.series.pct_origin.types.total[pctLast] as number));
  await expect(pctTiles.locator(".tile", { hasText: overview.share_denominator.pct_origin })).toHaveCount(1);
  const officeLast = String(overview.last_year.office_apps);
  const officeTiles = page.locator('.chart-card[data-chart="entity-tiles"] [data-series="office_apps"]');
  await expect(officeTiles.locator(".tile", { hasText: "Resident share" }).locator(".tile-value"))
    .toHaveText(`${(swiss.series.office_apps.derived.resident_share[officeLast] as number).toFixed(decimals.resident_share)}%`);
});

test("every card on country and office pages has a source line and a citation with the series' release", async ({ page }) => {
  for (const url of ["/?country=CH", "/?office=EP"]) {
    await page.goto(url);
    await expect(page.locator('.chart-card[data-chart="office-apps"] svg').first()).toBeVisible(); // cards filled (one pass)
    const cards = page.locator(".chart-card");
    for (const card of await cards.all()) {
      await expect(card.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
      await card.getByRole("button", { name: "Cite this", exact: true }).click();
      await expect(card.locator(".cite-text")).toContainText(manifest.retrieved);
    }
  }
  // PCT figures cite the PCT tab's release, patent figures the patent tab's
  await page.goto("/?country=CH");
  const pmh = manifest.releases.pmh.replace(/^Last updated:\s*/i, "");
  const ips = manifest.releases.ips.replace(/^Last updated:\s*/i, "");
  await expect(page.locator('.chart-card[data-chart="pct-origin"] .source-line')).toContainText(pmh);
  await expect(page.locator('.chart-card[data-chart="origin-apps"] .source-line')).toContainText(ips);
  // the tiles card mixes both tabs: one source line each, and its citation names both releases
  const tilesCard = page.locator('.chart-card[data-chart="entity-tiles"]');
  await expect(tilesCard.locator(".source-line")).toHaveCount(2);
  await tilesCard.getByRole("button", { name: "Cite this", exact: true }).click();
  await expect(tilesCard.locator(".cite-text")).toContainText(ips);
  await expect(tilesCard.locator(".cite-text")).toContainText(pmh);
  const originCard = page.locator('.chart-card[data-chart="origin-apps"]');
  await originCard.getByRole("button", { name: "Cite this", exact: true }).click();
  await expect(originCard.locator(".cite-text")).toContainText(ips);
  await expect(originCard.locator(".cite-text")).not.toContainText(pmh);
});

test("rank tiles name what each series ranks among, as the methods page does", async ({ page }) => {
  await page.goto("/?country=CH");
  const basis = async (series: string): Promise<string> => {
    const label = await page.locator(`[data-series="${series}"] .tile-label`, { hasText: "Rank among" }).textContent();
    const match = /^Rank among (.+), \d{4}$/.exec(label ?? "");
    expect(match, label ?? "").not.toBeNull();
    return (match as RegExpExecArray)[1];
  };
  const origin = await basis("origin_apps");
  const office = await basis("office_apps");
  expect(await basis("pct_origin")).toBe(origin);
  expect(office).not.toBe(origin); // offices are ranked among offices, origins among origins
  await page.goto("/methods.html");
  await expect(page.locator("#formulas")).toContainText(`among ${origin}`);
  await expect(page.locator("#formulas")).toContainText(`among ${office}`);
});

test("a missing rank shows a dash, never 'null'", async ({ page }) => {
  const last = String(overview.last_year.origin_apps);
  await page.route("**/data/entity/CH.json", async (route) => {
    const swiss = entity("CH");
    (swiss.series.origin_apps.derived.rank as YearMap)[last] = null;
    await route.fulfill({ json: swiss });
  });
  await page.goto("/?country=CH");
  const rank = page.locator('[data-series="origin_apps"] .tile', { hasText: "Rank among" }).locator(".tile-value");
  await expect(rank).toHaveText("–");
  for (const text of await page.locator(".tile-value").allTextContents()) expect(text).not.toMatch(/null|undefined|NaN/);
});

test("end labels of a multi-line chart are at least one font size apart", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
  await page.goto("/?country=CH");
  const labels = page.locator('.chart-card[data-chart="office-apps"] .chart-end-label text');
  await expect(labels).toHaveCount(3);
  const placed = await labels.evaluateAll((texts) => texts.map((text) => ({
    y: Number(/translate\([^,]+,\s*([-\d.e]+)\)/.exec(text.getAttribute("transform") ?? "")?.[1]),
    size: parseFloat(getComputedStyle(text).fontSize),
  })));
  const ys = placed.map((label) => label.y).sort((a, b) => a - b);
  for (let index = 1; index < ys.length; index++) expect(ys[index] - ys[index - 1]).toBeGreaterThanOrEqual(placed[0].size);
  expect(warnings).toEqual([]);
});

test("office page shows the office chart only, with resident share and no rank", async ({ page }) => {
  const errors = trackErrors(page);
  const epo = entity("EP");
  await page.goto("/?office=EP");
  await expect(page.locator("h1")).toHaveText(epo.label);
  await expect(page.locator('.chart-card[data-chart="office-apps"] svg').first()).toBeVisible();
  for (const id of ["origin-apps", "pct-origin"]) await expect(page.locator(`.chart-card[data-chart="${id}"]`)).toHaveCount(0);
  const last = String(overview.last_year.office_apps);
  const tiles = page.locator('.chart-card[data-chart="entity-tiles"]');
  await expect(tiles.locator(".tile", { hasText: "Resident share" }).locator(".tile-value"))
    .toHaveText(`${(epo.series.office_apps.derived.resident_share[last] as number).toFixed(decimals.resident_share)}%`);
  await expect(tiles.locator(".tile", { hasText: "Rank" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// site/src/methods.ts PCT_LATE_FILINGS: one wording on every page that shows the newest PCT year
const PCT_LATE_FILINGS = "Recent PCT years still rise as late filings are processed.";

test("PCT late-filing caveat on country PCT cards and tiles, worded as on the overview and methods pages", async ({ page }) => {
  const errors = trackErrors(page);
  for (const code of ["CH", "IN"]) {
    await page.goto(`/?country=${code}`);
    await expect(page.locator('.chart-card[data-chart="pct-origin"] .chart-note')).toContainText(PCT_LATE_FILINGS);
    await expect(page.locator('.chart-card[data-chart="entity-tiles"] .chart-note')).toContainText(PCT_LATE_FILINGS);
  }
  await page.goto("/?office=EP"); // office page: no PCT series, no caveat
  await expect(page.locator('.chart-card[data-chart="entity-tiles"] .chart-note')).not.toContainText(PCT_LATE_FILINGS);
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="pct-world-trend"] .chart-note')).toContainText(PCT_LATE_FILINGS);
  await page.goto("/methods.html");
  await expect(page.locator("#revisions")).toContainText(PCT_LATE_FILINGS);
  expect(errors).toEqual([]);
});

test("no-data country: 'no data reported', no charts, no zeros", async ({ page }) => {
  const errors = trackErrors(page);
  const code = allNullCode();
  await page.goto(`/?country=${code}`);
  await expect(page.locator("h1")).toHaveText(entity(code).label);
  await expect(page.locator("main")).toContainText("No data reported");
  await expect(page.locator(".chart-card")).toHaveCount(0);
  await expect(page.locator(".tile-value")).toHaveCount(0);
  await expect(page.locator("#notices")).toBeHidden();
  expect(errors).toEqual([]);
});

test("partial data (VA patched: office all null, PCT one value): all-null series named as not reported, not drawn", async ({ page }) => {
  await page.route("**/data/entity/VA.json", async (route) => {
    const holySee = entity("VA");
    for (const years of Object.values(holySee.series.office_apps.types)) for (const year of Object.keys(years)) years[year] = null;
    holySee.series.pct_origin.types.total[String(overview.last_year.pct_origin)] = 3;
    await route.fulfill({ json: holySee });
  });
  await page.goto("/?country=VA");
  await expect(page.locator('.chart-card[data-chart="pct-origin"] svg').first()).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="office-apps"]')).toHaveCount(0);
  await expect(page.locator(".entity-missing")).toContainText("No data reported");
});

test("former entity: badge and no rank tile", async ({ page }) => {
  const soviet = entity("SU");
  await page.goto("/?country=SU");
  await expect(page.locator("h1")).toContainText(soviet.label);
  await expect(page.locator(".badge")).toHaveText("former");
  await expect(page.locator('.chart-card[data-chart="entity-tiles"]')).toHaveCount(1);
  await expect(page.locator(".tile", { hasText: "Rank" })).toHaveCount(0);
  // tiles of a former entity show its last reported year, not a column of dashes
  const years = Object.entries(soviet.series.origin_apps.types.total).filter(([, value]) => value !== null).map(([year]) => year);
  const final = years[years.length - 1];
  await expect(page.locator('[data-series="origin_apps"] .tile', { hasText: `Applications, ${final}` }).locator(".tile-value"))
    .toHaveText(count(soviet.series.origin_apps.types.total[final] as number));
});

test("picker: search lists matches in groups; keyboard selection opens the page and keeps the theme", async ({ page }) => {
  await page.goto("/?theme=paper");
  const search = page.getByRole("combobox", { name: /country or office/i });
  await search.fill("swi");
  const results = page.locator(".picker-results");
  await expect(results.getByRole("option", { name: /Switzerland/ })).toBeVisible();
  await search.fill("soviet");
  await expect(results.locator(".picker-group", { hasText: "Former" }).getByRole("option", { name: /Soviet Union/ })).toBeVisible();
  await search.fill("ep");
  await expect(results.locator(".picker-group", { hasText: "Regional offices" }).getByRole("option", { name: /European Patent Office/ })).toBeVisible();
  await search.fill("swi");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page).toHaveURL(/country=CH/);
  await expect(page).toHaveURL(/theme=paper/);
  await expect(page.locator("h1")).toHaveText(entity("CH").label);
  // the picker is on entity pages too; an office opens the office page
  await page.getByRole("combobox", { name: /country or office/i }).fill("European Patent");
  await page.getByRole("option", { name: /European Patent Office/ }).click();
  await expect(page).toHaveURL(/office=EP/);
  await expect(page).not.toHaveURL(/country=/);
});

for (const [query, continent] of [["Europe", "europe"], ["Africa", "africa"], ["Asia", "asia"]]) {
  test(`picker: "${query}" + Enter, nothing chosen, opens the continent (exact name beats an office or country listed first)`, async ({ page }) => {
    await page.goto("/");
    const search = page.getByRole("combobox", { name: /country or office/i });
    await search.fill(query);
    await expect(page.locator(".picker-results").getByRole("option").first()).toBeVisible();
    await search.press("Enter");
    await expect(page).toHaveURL(new RegExp(`[?&]continent=${continent}(&|$)`));
  });
}

test("picker: the best match is listed first and active (announced); Europe lists the continent before the office", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: /country or office/i });
  await search.fill("Europe");
  const first = page.locator(".picker-results").getByRole("option").first();
  await expect(first).toContainText("Europe");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id")) ?? "");
  await expect(page.locator(".picker-results .picker-group").first()).toContainText("Regions and continents");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]continent=europe(&|$)/);
});

test("picker: the groups-first tie applies only to exact names (America opens the USA); equal scores favour the larger origin (Korea opens KR)", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: /country or office/i });
  for (const [query, url] of [["America", /[?&]country=US(&|$)/], ["Korea", /[?&]country=KR(&|$)/]] as const) {
    await page.goto("/");
    await search.fill(query);
    await expect(page.locator(".picker-results").getByRole("option").first()).toBeVisible();
    await search.press("Enter");
    await expect(page, query).toHaveURL(url);
  }
});

test("picker: Enter with nothing chosen prefers a prefix over a word match, and a code still opens its entity", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: /country or office/i });
  await search.fill("ch");
  await expect(page.locator(".picker-results").getByRole("option").first()).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(/country=CH(&|$)/);
  await page.goto("/");
  await search.fill("European Patent");
  await expect(page.locator(".picker-results").getByRole("option").first()).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(/office=EP(&|$)/);
});

test("picker: Escape closes the list, a second Escape clears the box and its matches (no stale list or Enter)", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: /country or office/i });
  const results = page.locator(".picker-results");
  await search.fill("swi");
  await expect(results.getByRole("option").first()).toBeVisible();
  await search.press("Escape");
  await expect(results).toBeHidden();
  await expect(search).toHaveValue("swi");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(results.getByRole("option")).toHaveCount(0);
  await expect(page.locator(".picker-status")).toHaveText("");
  await search.press("ArrowDown");
  await expect(results).toBeHidden();
  await search.blur();
  await search.focus();
  await expect(results).toBeHidden();
  await search.press("Enter");
  await expect(page).not.toHaveURL(/country=/);
});

test("national office code redirects to its country page; regional code as country to its office page", async ({ page }) => {
  await page.goto("/?office=CH");
  await expect(page).toHaveURL(/country=CH/);
  await expect(page).not.toHaveURL(/office=/);
  await expect(page.locator("#notices")).toContainText("national office");
  await expect(page.locator('.chart-card[data-chart="office-apps"]')).toHaveCount(1);
  await page.goto("/?country=EP");
  await expect(page).toHaveURL(/office=EP/);
  await expect(page.locator("h1")).toHaveText(entity("EP").label);
  // country and office together: the country page, the office left out with a notice
  await page.goto("/?country=CH&office=EP");
  await expect(page.locator("h1")).toHaveText(entity("CH").label);
  await expect(page).not.toHaveURL(/office=/);
  await expect(page.locator("#notices")).toContainText("left out");
});

test("chart param scrolls to that card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/?country=CH&chart=pct-origin");
  await expect(page.locator('.chart-card[data-chart="pct-origin"]')).toBeInViewport();
});

test("a share that rounds to 0 with applications above 0 shows '<0.01%', never '0.00%'", async ({ page }) => {
  // route-patched, not picked from data, so a refresh cannot leave the test without a case: CH share at top_year
  // set to the rounded 0 the pipeline writes for tiny shares, CH total stays above 0
  const year = String(overview.top_year);
  await page.route("**/data/entity/CH.json", async (route) => {
    const swiss = entity("CH");
    expect(swiss.series.origin_apps.types.total[year] ?? 0).toBeGreaterThan(0);
    (swiss.series.origin_apps.derived.share as YearMap)[year] = 0;
    await route.fulfill({ json: swiss });
  });
  await page.goto("/?country=CH");
  const share = page.locator('[data-series="origin_apps"] .tile', { hasText: overview.share_denominator.origin_apps });
  await expect(share.locator(".tile-label")).toContainText(year);
  await expect(share.locator(".tile-value")).toHaveText(`<${(10 ** -decimals.share).toFixed(decimals.share)}%`);
});

test("rank and share tiles use the world cut-off year when the series' last year is later", async ({ page }) => {
  // simulate a provisional world year: the series runs to `last`, the world (and so rank and share) stops a year before
  const last = String(overview.last_year.pct_origin);
  const cutoff = String(Number(last) - 1);
  const swiss = entity("CH");
  const derived = swiss.series.pct_origin.derived;
  await page.route("**/data/overview.json", async (route) => {
    await route.fulfill({ json: { ...overview, world_last_year: { ...overview.world_last_year, pct_world: Number(cutoff) } } });
  });
  await page.route("**/data/entity/CH.json", async (route) => {
    const patched = entity("CH");
    delete patched.series.pct_origin.derived.rank[last];
    delete patched.series.pct_origin.derived.share[last];
    await route.fulfill({ json: patched });
  });
  await page.goto("/?country=CH");
  const tiles = page.locator('.chart-card[data-chart="entity-tiles"] [data-series="pct_origin"]');
  await expect(tiles.locator(".tile", { hasText: `Applications, ${last}` })).toHaveCount(1);
  const rank = tiles.locator(".tile", { hasText: "Rank among" });
  await expect(rank.locator(".tile-label")).toContainText(cutoff);
  await expect(rank.locator(".tile-value")).toHaveText(String(derived.rank[cutoff]));
  const share = tiles.locator(".tile", { hasText: overview.share_denominator.pct_origin });
  await expect(share.locator(".tile-label")).toContainText(cutoff);
  await expect(share.locator(".tile-value")).toHaveText(`${(derived.share[cutoff] as number).toFixed(decimals.share)}%`);
});

test("country origin card and region comparison carry the pre-origin_abroad_from note; other cards do not", async ({ page }) => {
  await page.goto("/?country=US");
  const note = new RegExp(`Before ${overview.method.origin_abroad_from}, .*origin “Abroad” is near-empty`);
  const origin = page.locator('.chart-card[data-chart="origin-apps"]');
  await expect(origin.locator("svg").first()).toBeVisible();
  await expect(origin.locator(".chart-footnote", { hasText: /near-empty/ })).toHaveText(note);
  for (const id of ["office-apps", "pct-origin", "entity-tiles"]) {
    await expect(page.locator(`.chart-card[data-chart="${id}"] .chart-footnote`, { hasText: /near-empty/ }), id).toHaveCount(0);
  }
  const compare = page.locator('.chart-card[data-chart="region-compare"]');
  await expect(compare.locator(".chart-footnote", { hasText: /near-empty/ })).toHaveText(note);
});

test("key-figure tiles of a former entity whose origin year is before origin_abroad_from carry the origin note", async ({ page }) => {
  const from = overview.method.origin_abroad_from;
  const lastOrigin = (code: string): number => Math.max(...Object.entries(entity(code).series.origin_apps.types.total)
    .filter(([, value]) => value !== null).map(([year]) => Number(year)));
  const historical = entities.filter((ref) => ref.kind === "historical" && entity(ref.code).series.origin_apps
    && Object.values(entity(ref.code).series.origin_apps.types.total).some((value) => value !== null));
  const before = historical.find((ref) => lastOrigin(ref.code) < from);
  const after = historical.find((ref) => lastOrigin(ref.code) >= from);
  expect(before, "a former entity whose origin data end before origin_abroad_from").toBeTruthy();
  expect(after, "a former entity whose origin data reach origin_abroad_from").toBeTruthy();
  const note = new RegExp(`Before ${from}, .*origin “Abroad” is near-empty`);
  await page.goto(`/?country=${before!.code}`);
  const tiles = page.locator('.chart-card[data-chart="entity-tiles"]');
  await expect(tiles.locator('[data-series="origin_apps"]')).toBeVisible();
  await expect(tiles.locator(".chart-footnote", { hasText: /near-empty/ })).toHaveText(note);
  await page.goto(`/?country=${after!.code}`);
  await expect(page.locator('.chart-card[data-chart="entity-tiles"] [data-series="origin_apps"]')).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="entity-tiles"] .chart-footnote', { hasText: /near-empty/ })).toHaveCount(0);
});

test("series break (fixture, audit F1): CN office and origin cards say growth into the year is not computed; CN PCT and CH cards do not", async ({ page }) => {
  const errors = trackErrors(page);
  const entry = fixtureBreak();
  await routeSeriesBreaks(page, [entry]);
  await page.goto("/?country=CN");
  for (const id of ["origin-apps", "office-apps"]) {
    const note = page.locator(`.chart-card[data-chart="${id}"] .chart-footnote`, { hasText: "Series break" });
    await expect(note, id).toContainText(`Series break ${entry.year}`);
    await expect(note, id).toContainText("summarised from WIPO");
    await expect(note, id).toHaveText(entityBreakNote(entry));
  }
  await expect(page.locator('.chart-card[data-chart="pct-origin"] svg').first()).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="pct-origin"] .chart-footnote', { hasText: "Series break" })).toHaveCount(0);
  await page.goto("/?country=CH");
  await expect(page.locator('.chart-card[data-chart="origin-apps"] svg').first()).toBeVisible();
  await expect(page.locator(".chart-card", { hasText: "Series break" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("data without series_breaks / yoy_null_reason (before the refresh that adds them): CN page has no break note, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await routeSeriesBreaks(page, null);
  await page.goto("/?country=CN");
  await expect(page.locator('.chart-card[data-chart="origin-apps"] svg').first()).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="region-compare"] svg').first()).toBeVisible();
  await expect(page.getByText("Series break")).toHaveCount(0);
  expect(errors).toEqual([]);
});
