import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { fixedHalfAway } from "../../site/src/format";

// Scale cards (per million population, per $100bn GDP, PCT per million): country page tiles with the region and World
// beside, region page tiles and table, embed. Expected figures are read from the data files (no value typed here),
// except the literal oracles of patched values.
type YearMap = Record<string, number | null>;
type RatioBlock = { value: YearMap; computed: number[]; null_reason: Record<string, string> };
type GroupRatio = { value: YearMap; reporting: Record<string, number>; members: number; null_reason: Record<string, string> };
type GroupItem = { id: string; kind: string; label: string; members: string[] };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const overview = readJson("site/data/overview.json");
const manifest = readJson("site/data/manifest.json");
const groups: GroupItem[] = readJson("site/data/groups.json").items;
const entityFile = (code: string) => readJson(`site/data/entity/${code}.json`);
const groupFile = (id: string) => readJson(`site/data/group/${id}.json`);
const decimals: number = overview.method.ratios.decimals;
const lastYear: Record<string, number> = overview.ratio_last_year;
const RATIO_IDS = (overview.method.ratios.ratio_ids as string[]).filter((id) => id in lastYear);
const WIPO_LABEL = "WIPO";
const COMPUTED_LABEL = "computed from WIPO counts and World Bank WDI";
const PCT_THRESHOLD = "below the population threshold WIPO uses for its per-million figures";

/** Expected figure text: fixedHalfAway with the integer part grouped in thousands as counts are ("1,234.5"). */
const text = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "–";
  const [integer, fraction] = fixedHalfAway(value, decimals).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};
const card = (page: Page, id: string): Locator => page.locator(`.chart-card[data-chart="${id}"]`);
const tile = (scope: Locator, id: string): Locator => scope.locator(`.tile[data-ratio="${id}"]`);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const regionOf = (code: string): GroupItem => groups.find((item) => item.kind === "region" && item.members.includes(code)) as GroupItem;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Serves entity/<code>.json changed by `patch`. */
async function patchEntity(page: Page, code: string, patch: (file: any) => void): Promise<void> {
  await page.route(`**/data/entity/${code}.json`, async (route) => {
    const file = entityFile(code);
    patch(file);
    await route.fulfill({ json: file });
  });
}

async function patchGroup(page: Page, id: string, patch: (file: any) => void): Promise<void> {
  await page.route(`**/data/group/${id}.json`, async (route) => {
    const file = groupFile(id);
    patch(file);
    await route.fulfill({ json: file });
  });
}

test("CH scale tiles: values and basis from entity/CH.json; region value with n of m and World beside", async ({ page }) => {
  const errors = trackErrors(page);
  const swiss = entityFile("CH");
  const region = regionOf("CH");
  const figures = groupFile(region.id);
  await page.goto("/?country=CH");
  const scale = card(page, "entity-scale");
  await expect(scale).toHaveCount(1);
  for (const id of RATIO_IDS) {
    const year = String(lastYear[id]);
    const block: RatioBlock = swiss.ratios[id];
    const ratioTile = tile(scale, id);
    await expect(ratioTile.locator("dt")).toContainText(`, ${year}`);
    await expect(ratioTile.locator(".tile-value")).toHaveText(text(block.value[year]));
    await expect(ratioTile.locator(".tile-basis")).toHaveText(block.computed.includes(Number(year)) ? COMPUTED_LABEL : WIPO_LABEL);
    const group: GroupRatio = figures.ratios[id];
    await expect(ratioTile.locator(".tile-region")).toHaveText(
      `${region.label}: ${text(group.value[year])} (${group.reporting[year]} of ${group.members} members)`);
    await expect(ratioTile.locator(".tile-world")).toHaveText(`World: ${text(overview.world_ratios[id][year])}`);
  }
  // CH's per million values are WIPO's in the latest year (the data's own case, read above)
  expect(swiss.ratios.per_million.computed).not.toContain(lastYear.per_million);
  await expect(tile(scale, "per_million").locator(".tile-basis")).toHaveText(WIPO_LABEL);
  expect(errors).toEqual([]);
});

test("a computed country year is labelled 'computed from WIPO counts and World Bank WDI'", async ({ page }) => {
  const year = lastYear.per_million;
  await patchEntity(page, "CH", (file) => { file.ratios.per_million.computed.push(year); });
  await page.goto("/?country=CH");
  await expect(tile(card(page, "entity-scale"), "per_million").locator(".tile-basis")).toHaveText(COMPUTED_LABEL);
});

test("LU per million: – with 'below WIPO's threshold' and the threshold from overview.method.ratios", async ({ page }) => {
  const year = String(lastYear.per_million);
  const lux = entityFile("LU");
  expect(lux.ratios.per_million.value[year]).toBeNull();
  expect(lux.ratios.per_million.null_reason[year]).toBe("below_wipo_threshold");
  expect(overview.method.ratios.wipo_threshold.population).toBe(1000000); // literal oracle of the words below
  await page.goto("/?country=LU");
  const ratioTile = tile(card(page, "entity-scale"), "per_million");
  await expect(ratioTile.locator(".tile-value")).toHaveText("–");
  await expect(ratioTile.locator(".tile-basis")).toContainText("below WIPO's threshold (population 1 million or less)");
});

test("PCT per million below threshold: WIPO's per-million population threshold, never 'WIPO's threshold'", async ({ page }) => {
  const year = lastYear.pct_per_million;
  await patchEntity(page, "CH", (file) => {
    const block = file.ratios.pct_per_million;
    block.value[String(year)] = null;
    block.null_reason[String(year)] = "below_wipo_threshold";
    block.computed = block.computed.filter((item: number) => item !== year);
  });
  await page.goto("/?country=CH");
  const basis = tile(card(page, "entity-scale"), "pct_per_million").locator(".tile-basis");
  await expect(basis).toContainText(PCT_THRESHOLD);
  await expect(basis).not.toContainText("WIPO's threshold");
});

test("ratio values are rounded half away from zero: a patched 12.25 shows 12.3", async ({ page }) => {
  await patchEntity(page, "CH", (file) => { file.ratios.per_million.value[String(lastYear.per_million)] = 12.25; });
  await page.goto("/?country=CH");
  await expect(tile(card(page, "entity-scale"), "per_million").locator(".tile-value")).toHaveText("12.3");
});

test("ratio values of 1000 or more group thousands without re-rounding: 1234.5 -> 1,234.5; 4,976.5 fits its tile", async ({ page }) => {
  const perMillion = String(lastYear.per_million);
  const perGdp = String(lastYear.per_gdp);
  await patchEntity(page, "CH", (file) => {
    file.ratios.per_million.value[perMillion] = 1234.5;
    file.ratios.per_gdp.value[perGdp] = 4976.5;
  });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/?country=CH");
    const scale = card(page, "entity-scale");
    await expect(tile(scale, "per_million").locator(".tile-value")).toHaveText("1,234.5");
    const wide = tile(scale, "per_gdp").locator(".tile-value");
    await expect(wide).toHaveText("4,976.5");
    const fits = await wide.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(fits, `4,976.5 fits .tile-value at ${width}px`).toBe(true);
  }
});

test("World is shown for the tile year, never a later one", async ({ page }) => {
  const year = lastYear.pct_per_million;
  await page.route("**/data/overview.json", async (route) => {
    const patched = readJson("site/data/overview.json");
    patched.world_ratios.pct_per_million[String(year + 1)] = 98765.4;
    await route.fulfill({ json: patched });
  });
  await page.goto("/?country=CH");
  const world = tile(card(page, "entity-scale"), "pct_per_million").locator(".tile-world");
  await expect(world).toHaveText(`World: ${text(overview.world_ratios.pct_per_million[String(year)])}`);
});

test("LU null per million: table row has '–' and 'no data reported: below WIPO's threshold' in the basis cell", async ({ page }) => {
  const year = String(lastYear.per_million);
  const lux = entityFile("LU");
  expect(lux.ratios.per_million.value[year]).toBeNull();
  await page.goto("/?country=LU");
  const scale = card(page, "entity-scale");
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  const measure = (await tile(scale, "per_million").locator("dt").textContent() ?? "").replace(`, ${year}`, "");
  const row = scale.locator(".chart-figures tbody tr")
    .filter({ has: page.locator("td:nth-child(1)", { hasText: new RegExp(`^${escapeRegExp(measure)}$`) }) })
    .filter({ has: page.locator("td:nth-child(2)", { hasText: new RegExp(`^${year}$`) }) });
  await expect(row).toHaveCount(1);
  await expect(row.locator("td:nth-child(3)")).toHaveText("–");
  await expect(row.locator("td:nth-child(4)")).toContainText("no data reported: below WIPO's threshold (population 1 million or less)");
});

test("country without region figures: no Region line, table region cells '–', no error", async ({ page }) => {
  const errors = trackErrors(page);
  const region = regionOf("CH");
  await patchGroup(page, region.id, (file) => { delete file.ratios; });
  await page.goto("/?country=CH");
  const scale = card(page, "entity-scale");
  await expect(scale).toHaveCount(1);
  await expect(scale.locator(".tile-region")).toHaveCount(0);
  await expect(tile(scale, "per_million").locator(".tile-value")).toHaveText(text(entityFile("CH").ratios.per_million.value[String(lastYear.per_million)]));
  await expect(scale.locator(".chart-note")).not.toContainText(region.label + ": the sum");
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  const first = scale.locator(".chart-figures tbody tr").first().locator("td");
  await expect(first.nth(4)).toHaveText("–");
  await expect(first.nth(5)).toHaveText("–");
  expect(errors.filter((message) => !message.includes("Failed to load resource"))).toEqual([]);
});

test("failed region load: the scale card stands without the region", async ({ page }) => {
  const region = regionOf("CH");
  await page.route(`**/data/group/${region.id}.json`, (route) => route.abort());
  await page.goto("/?country=CH");
  const scale = card(page, "entity-scale");
  await expect(scale).toHaveCount(1);
  await expect(scale.locator(".tile-region")).toHaveCount(0);
  await expect(tile(scale, "per_million").locator(".tile-value")).toHaveText(text(entityFile("CH").ratios.per_million.value[String(lastYear.per_million)]));
  await expect(tile(scale, "per_million").locator(".tile-world")).toBeVisible();
  await expect(page.locator(".region-compare-note")).toHaveText("The comparison with the region could not be loaded.");
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(scale.locator(".chart-figures tbody tr").first().locator("td").nth(4)).toHaveText("–");
});

test("region line of a null group value names n of m members", async ({ page }) => {
  const region = regionOf("CH");
  const year = String(lastYear.per_million);
  await patchGroup(page, region.id, (file) => {
    file.ratios.per_million.value[year] = null;
    file.ratios.per_million.null_reason[year] = "below_wipo_threshold";
    file.ratios.per_million.reporting[year] = 0;
  });
  await page.goto("/?country=CH");
  const members = groupFile(region.id).ratios.per_million.members;
  await expect(tile(card(page, "entity-scale"), "per_million").locator(".tile-region"))
    .toHaveText(new RegExp(`^${escapeRegExp(region.label)}: – \\(no data reported: .+, 0 of ${members} members\\)$`));
});

test("country card note: GDP basis label from the manifest when a computed per-GDP value shows", async ({ page }) => {
  await page.route("**/data/manifest.json", async (route) => {
    const patched = readJson("site/data/manifest.json");
    patched.retrieved = "2031-04-05";
    patched.wdi_denominators.gdp_ppp.gdp_base = 2029;
    patched.wdi_denominators.gdp_ppp.last_updated = "2031-03-02";
    await route.fulfill({ json: patched });
  });
  await patchEntity(page, "CH", (file) => { file.ratios.per_gdp.computed.push(lastYear.per_gdp); });
  await page.goto("/?country=CH");
  const note = card(page, "entity-scale").locator(".chart-note");
  await expect(note).toContainText("GDP PPP, constant 2029 international $ (World Bank WDI, retrieved 2031-04-05, WDI last updated 2031-03-02)");
  await expect(note).toContainText("PCT per million uses the population threshold WIPO uses for its per-million figures");
  await expect(note).not.toContainText("WIPO's threshold");
});

test("country scale card: figures table rows, credit and GDP basis from the data", async ({ page }) => {
  const swiss = entityFile("CH");
  const region = regionOf("CH");
  const figures = groupFile(region.id);
  await page.goto("/?country=CH");
  const scale = card(page, "entity-scale");
  await expect(scale.locator(".chart-credit")).toContainText("World Bank WDI (CC BY 4.0)");
  await expect(scale.locator(".chart-credit")).toContainText(`retrieved ${manifest.retrieved}`);
  await expect(scale.locator(".chart-credit")).toContainText(`last updated ${manifest.wdi_denominators.population.last_updated}`);
  await expect(scale.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  const headers = await scale.locator(".chart-figures thead th").allTextContents();
  expect(headers).toEqual(["Measure", "Year", "Country", "Basis", "Region", "Members reporting", "World"]);
  const rows = scale.locator(".chart-figures tbody tr");
  for (const id of RATIO_IDS) {
    const year = String(lastYear[id]);
    const block: RatioBlock = swiss.ratios[id];
    const group: GroupRatio = figures.ratios[id];
    // measure = the tile title without its year
    const measure = (await tile(scale, id).locator("dt").textContent() ?? "").replace(`, ${year}`, "");
    const row = rows.filter({ has: page.locator("td:nth-child(1)", { hasText: new RegExp(`^${escapeRegExp(measure)}$`) }) })
      .filter({ has: page.locator("td:nth-child(2)", { hasText: new RegExp(`^${year}$`) }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td")).toHaveText([measure, year, text(block.value[year]),
      block.computed.includes(Number(year)) ? COMPUTED_LABEL : WIPO_LABEL, text(group.value[year]),
      `${group.reporting[year]} of ${group.members}`, text(overview.world_ratios[id][year])]);
  }
});

test("region page scale card: tiles and figures table equal group/155.json", async ({ page }) => {
  const errors = trackErrors(page);
  const id = "155";
  const figures = groupFile(id);
  await page.goto(`/?region=${id}`);
  const scale = card(page, "group-scale");
  await expect(scale).toHaveCount(1);
  for (const ratio of RATIO_IDS) {
    const year = String(lastYear[ratio]);
    const group: GroupRatio = figures.ratios[ratio];
    const ratioTile = tile(scale, ratio);
    await expect(ratioTile.locator(".tile-value")).toHaveText(text(group.value[year]));
    await expect(ratioTile.locator(".tile-basis")).toHaveText(`${COMPUTED_LABEL}, ${group.reporting[year]} of ${group.members} members`);
    await expect(ratioTile.locator(".tile-world")).toHaveText(`World: ${text(overview.world_ratios[ratio][year])}`);
  }
  await expect(scale.locator(".chart-note")).toContainText("sum");
  await expect(scale.locator(".chart-credit")).toContainText("retrieved");
  await expect(scale.locator(".chart-credit")).toContainText("last updated");
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  const rows = scale.locator(".chart-figures tbody tr");
  const years = [...new Set(RATIO_IDS.flatMap((ratio) => Object.keys(figures.ratios[ratio].value)
    .filter((year) => Number(year) <= lastYear[ratio])))].sort().reverse();
  await expect(rows).toHaveCount(years.length);
  for (const [index, year] of years.entries()) {
    const expected = [year, ...RATIO_IDS.flatMap((ratio) => {
      const group: GroupRatio = figures.ratios[ratio];
      if (Number(year) > lastYear[ratio] || !(year in group.value)) return ["–", "–", ""];
      return [text(group.value[year]), `${group.reporting[year]} of ${group.members}`, group.null_reason[year] ? /.+/ : ""];
    })];
    await expect(rows.nth(index).locator("td")).toHaveText(expected);
  }
  expect(errors).toEqual([]);
});

test("group below WIPO's threshold: per million names WIPO's threshold, PCT never does", async ({ page }) => {
  await patchGroup(page, "155", (file) => {
    for (const id of ["per_million", "pct_per_million"]) {
      const year = String(lastYear[id]);
      file.ratios[id].value[year] = null;
      file.ratios[id].null_reason[year] = "below_wipo_threshold";
    }
  });
  await page.goto("/?region=155");
  const scale = card(page, "group-scale");
  await expect(tile(scale, "per_million").locator(".tile-basis"))
    .toContainText("reporting members' total is at or below WIPO's threshold (population 1 million)");
  const pct = tile(scale, "pct_per_million").locator(".tile-basis");
  await expect(pct).toContainText(PCT_THRESHOLD.replace("below", "at or below"));
  await expect(pct).not.toContainText("WIPO's threshold");
});

test("region card note: GDP basis label from the manifest (WDI base year, retrieval and update dates)", async ({ page }) => {
  await page.route("**/data/manifest.json", async (route) => {
    const patched = readJson("site/data/manifest.json");
    patched.retrieved = "2031-04-05";
    patched.wdi_denominators.gdp_ppp.gdp_base = 2029;
    patched.wdi_denominators.gdp_ppp.last_updated = "2031-03-02";
    await route.fulfill({ json: patched });
  });
  await page.goto("/?region=155");
  await expect(card(page, "group-scale").locator(".chart-note")).toContainText(
    "GDP PPP, constant 2029 international $ (World Bank WDI, retrieved 2031-04-05, WDI last updated 2031-03-02)");
});

test("region card note: PCT per million uses the population threshold WIPO uses for its per-million figures", async ({ page }) => {
  await page.goto("/?region=155");
  const note = card(page, "group-scale").locator(".chart-note");
  await expect(note).toContainText("PCT per million uses the population threshold WIPO uses for its per-million figures");
  await expect(note).not.toContainText("WIPO's threshold");
});

test("continent page has the scale card; an office page has none", async ({ page }) => {
  await page.goto("/?continent=africa");
  await expect(card(page, "group-scale")).toHaveCount(1);
  await page.goto("/?office=EP");
  await expect(card(page, "entity-tiles")).toHaveCount(1);
  await expect(card(page, "entity-scale")).toHaveCount(0);
});

for (const address of ["chart=entity-scale&country=CH", "chart=group-scale&region=155"]) {
  test(`embed ${address}: card with source line and WDI credit`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/embed.html?${address}`);
    await expect(page.locator(".tile").first()).toBeVisible();
    await expect(page.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
    await expect(page.locator(".chart-credit")).toContainText("Population and GDP: World Bank WDI (CC BY 4.0)");
    expect(errors).toEqual([]);
  });
}

// --- final review fixes (I1, M2, M3, M4) --------------------------------------------------------------------------------

const WDI_CREDIT = "Population and GDP: World Bank WDI (CC BY 4.0)";

async function citeOf(scope: Locator): Promise<Locator> {
  await scope.getByRole("button", { name: "Cite this", exact: true }).click();
  return scope.locator(".cite-text");
}

for (const [address, id] of [["?country=CH", "entity-scale"], ["?region=155", "group-scale"], ["?metric=per_gdp", "world-map"],
  ["?metric=per_million", "world-map"]]) {
  test(`I1: the copied citation of ${id} at ${address} names World Bank WDI, its licence and dates`, async ({ page }) => {
    await page.goto(`/${address}`);
    const cite = await citeOf(card(page, id));
    await expect(cite).toContainText(WDI_CREDIT);
    await expect(cite).toContainText(`retrieved ${manifest.retrieved}, WDI last updated ${manifest.wdi_denominators.population.last_updated}`);
  });
}

test("I1: a count map's citation names WIPO only (no WDI figures shown)", async ({ page }) => {
  await page.goto("/?metric=origin_apps");
  const cite = await citeOf(card(page, "world-map"));
  await expect(cite).toContainText("Data: WIPO Statistics Database");
  await expect(cite).not.toContainText("World Bank");
});

test("M2: a below-precision year reads 'under 0.05 at one decimal; WIPO publishes no figure' (patched oracle)", async ({ page }) => {
  const year = String(lastYear.per_million);
  await patchEntity(page, "CH", (file) => {
    file.ratios.per_million.value[year] = null;
    file.ratios.per_million.computed = file.ratios.per_million.computed.filter((at: number) => at !== Number(year));
    file.ratios.per_million.null_reason[year] = "below_precision";
  });
  await page.goto("/?country=CH");
  await expect(tile(card(page, "entity-scale"), "per_million").locator(".tile-basis"))
    .toHaveText("no data reported: under 0.05 at one decimal; WIPO publishes no figure");
});

test("M2: a below-precision PCT year never claims WIPO publishes no figure (patched)", async ({ page }) => {
  const year = String(lastYear.pct_per_million);
  await patchEntity(page, "CH", (file) => {
    file.ratios.pct_per_million.value[year] = null;
    file.ratios.pct_per_million.computed = file.ratios.pct_per_million.computed.filter((at: number) => at !== Number(year));
    file.ratios.pct_per_million.null_reason[year] = "below_precision";
  });
  await page.goto("/?country=CH");
  const basis = tile(card(page, "entity-scale"), "pct_per_million").locator(".tile-basis");
  await expect(basis).toHaveText("no data reported: under 0.05 at one decimal");
});

test("M2: no computed ratio shows 0.0 from a count above 0 (data check)", () => {
  const numerator = overview.method.ratios.numerator as Record<string, { series: string; type: string }>;
  for (const code of Object.keys(readJson("site/data/map/per_million.json").values)) {
    const file = entityFile(code);
    for (const [id, block] of Object.entries(file.ratios as Record<string, RatioBlock>)) {
      const counts = file.series[numerator[id].series]?.types[numerator[id].type] ?? {};
      for (const year of block.computed) if (block.value[String(year)] === 0) expect(counts[String(year)], `${code} ${id} ${year}`).toBe(0);
    }
  }
});

test("M3: the PCT per million rows start at the PCT series' first year, never earlier", async ({ page }) => {
  const pctFirst = Math.min(...Object.keys(overview.pct_world).map(Number));
  expect(Math.min(...Object.keys(entityFile("CH").ratios.pct_per_million.value).map(Number))).toBe(pctFirst); // data guard
  await page.goto("/?country=CH");
  const scale = card(page, "entity-scale");
  const measure = (await tile(scale, "pct_per_million").locator("dt").textContent() ?? "").replace(`, ${lastYear.pct_per_million}`, "");
  await scale.getByRole("button", { name: "Show figures", exact: true }).click();
  const years = (await scale.locator(".chart-figures tbody tr")
    .filter({ has: page.locator("td:nth-child(1)", { hasText: new RegExp(`^${escapeRegExp(measure)}$`) }) })
    .locator("td:nth-child(2)").allTextContents()).map(Number);
  expect(Math.min(...years)).toBe(pctFirst);
});

const breaks: { code: string; year: number; groups: string[]; series: string[] }[] = overview.series_breaks ?? [];
const originBreak = breaks.find((entry) => entry.series.includes("origin_apps"));

test("M4: the scale card of a country with a break in its applications by origin carries the break note, no growth sentence", async ({ page }) => {
  test.skip(!originBreak, "no origin_apps break in the data");
  await page.goto(`/?country=${originBreak!.code}`);
  const notes = card(page, "entity-scale").locator(".chart-footnote");
  await expect(notes.filter({ hasText: `Series break ${originBreak!.year}` })).toHaveCount(1);
  await expect(notes.filter({ hasText: "Growth from" })).toHaveCount(0);
  await page.goto("/?country=CH");
  await expect(card(page, "entity-scale").locator(".chart-footnote", { hasText: "Series break" })).toHaveCount(0);
});

test("M4: the scale card of a group covering the break says it includes the country", async ({ page }) => {
  test.skip(!originBreak, "no origin_apps break in the data");
  const region = originBreak!.groups.find((id) => /^\d+$/.test(id)) as string;
  await page.goto(`/?region=${region}`);
  await expect(card(page, "group-scale").locator(".chart-footnote", { hasText: `Series break ${originBreak!.year}` }))
    .toContainText("Includes ");
});
