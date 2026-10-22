import { test, expect, type Page } from "./fixtures";
import { openNotes } from "./notes";
import { readFileSync } from "node:fs";
import { fixedHalfAway, fixedPercent } from "../../site/src/format";
import { RESIZE_SETTLE_MS } from "./siteConstants";

// Women-inventors page (`?view=women-inventors`) and its three embeddable charts. Expected figures are read from the data
// files; the group-label check reads the pipeline's own constant.
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const overview = readJson("site/data/overview.json");
const manifest = readJson("site/data/manifest.json");
const entities: { code: string; label: string; kind: string }[] = readJson("site/data/entities.json");
const entity = (code: string) => readJson(`site/data/entity/${code}.json`);
const share = (value: number | null): string => (value === null ? "–" : `${fixedHalfAway(value, 1)}%`);
const count = (value: number): string => value.toLocaleString("en-US");

const IDS = ["women-world-trend", "women-by-field", "women-ranking"];
const MEASURES = {
  women_any: "PCT applications with at least one woman inventor",
  women_share: "Women's share of PCT inventors",
};
const BY_FIELD_TITLE = "Applications with at least one woman inventor, by technology field (world)";
const NOT_PUBLISHED = "not published by WIPO";
const gender = overview.gender;
const method = overview.method.gender;
/** The ranking's year: the last year both measures have a World value. */
const rankYear = String(Math.min(gender.last_year.women_any, gender.last_year.women_share));

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const countries = (): { code: string; label: string }[] => entities.filter((ref) => ref.kind === "country");
/** First country with no published women_any share in the ranking year. */
function unpublishedCode(): string {
  const found = countries().find((ref) => entity(ref.code).gender.women_any.value[rankYear] === null);
  if (!found) throw new Error("no country without a published share in the data");
  return found.code;
}

test("page: three chart cards and the caveat with WIPO's method note", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?view=women-inventors");
  await expect(page.locator("h1")).toContainText("Women inventors");
  await expect(page.locator(".chart-card")).toHaveCount(3);
  for (const id of IDS) await expect(page.locator(`.chart-card[data-chart="${id}"]`)).toBeVisible();
  const caveat = page.locator(".women-caveat");
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText("Gender is attributed by WIPO");
  await expect(caveat).toContainText("publication year");
  await expect(caveat).toContainText(method.method_note.citation);
  for (const id of IDS) {
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    await expect(card.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
    await expect(card.locator(".source-line").first()).toContainText("Source: WIPO Statistics Database (release ");
  }
  expect(errors).toEqual([]);
});

test("world trend: two charts, one measure each; values equal overview.json", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-world-trend"]');
  const charts = card.locator(".chart-figure svg");
  await expect(charts).toHaveCount(2);
  await expect(charts.nth(0)).toHaveAttribute("aria-label", MEASURES.women_any);
  await expect(charts.nth(1)).toHaveAttribute("aria-label", MEASURES.women_share);
  await expect(card.locator("h3")).toHaveText([MEASURES.women_any, MEASURES.women_share]);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const tables = card.locator(".chart-figures table");
  await expect(tables).toHaveCount(2);
  for (const [index, measure] of (["women_any", "women_share"] as const).entries()) {
    const years = Object.keys(gender.world[measure]).filter((year) => Number(year) <= gender.last_year[measure]).sort().reverse();
    const rows = tables.nth(index).locator("tbody tr");
    await expect(rows).toHaveCount(years.length);
    expect(await rows.locator("td").allTextContents()).toEqual(years.flatMap((year) => [year, share(gender.world[measure][year])]));
    await expect(tables.nth(index).locator("thead th").nth(1)).toContainText(MEASURES[measure]);
  }
});

test("by field: 35 world bars, last year, sorted; values equal overview.json", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-by-field"]');
  await expect(card.locator("h2")).toContainText(BY_FIELD_TITLE);
  await expect(card.locator("h2")).toContainText(String(gender.last_year.women_any_by_field));
  await expect(card.locator(".chart-figure svg")).toHaveCount(1);
  const fields = Object.values(gender.by_field) as { label: string; value: number | null }[];
  const shown = fields.filter((field) => field.value !== null).sort((a, b) => (b.value as number) - (a.value as number));
  expect(shown).toHaveLength(35);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const rows = card.locator(".chart-figures tbody tr");
  await expect(rows).toHaveCount(shown.length);
  const texts = await rows.locator("td").allTextContents();
  const expected = shown.flatMap((field) => [field.label, share(field.value)]);
  // equal values may come in either label order: compare as sorted pairs and check the values descend
  const pairs = (list: string[]): string[] => list.flatMap((_, index) => (index % 2 ? [] : [`${list[index]}|${list[index + 1]}`])).sort();
  expect(pairs(texts)).toEqual(pairs(expected));
  expect(texts.filter((_, index) => index % 2).map((text) => parseFloat(text))).toEqual(shown.map((field) => field.value));
});

test("ranking: CH row equals entity/CH.json, publications equal pct_publications", async ({ page }) => {
  const errors = trackErrors(page);
  const swiss = entity("CH");
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-ranking"]');
  const row = card.locator('.ranking-table tr[data-code="CH"]');
  await expect(row).toHaveCount(1);
  const cells = row.locator("td");
  await expect(cells.nth(0)).toHaveText(swiss.label);
  await expect(cells.nth(0).locator("a")).toHaveAttribute("href", /country=CH/);
  await expect(cells.nth(1)).toHaveText(count(swiss.pct_publications[rankYear]));
  await expect(cells.nth(2)).toHaveText(share(swiss.gender.women_any.value[rankYear]));
  await expect(cells.nth(3)).toHaveText(share(swiss.gender.women_share.value[rankYear]));
  const headers = card.locator(".ranking-table thead th");
  await expect(headers.nth(1)).toContainText("PCT publications");
  await expect(headers.nth(1)).toContainText(rankYear);
  await expect(headers.nth(2)).toContainText(MEASURES.women_any);
  await expect(headers.nth(3)).toContainText(MEASURES.women_share);
  await expect(card.locator(".ranking-table tbody tr")).toHaveCount(countries().length);
  // every country: label, count and both shares equal its entity file
  const table = await card.locator(".ranking-table tbody tr").evaluateAll((trs) => trs.map((tr) =>
    [(tr as HTMLElement).dataset.code, ...[...tr.querySelectorAll("td")].map((td) => td.textContent)]));
  expect(table).toHaveLength(countries().length);
  for (const [code, label, publications, any, shareText] of table) {
    const file = entity(code as string);
    expect(label).toBe(file.label);
    expect(publications).toBe(file.pct_publications[rankYear] === null ? "–" : count(file.pct_publications[rankYear]));
    expect(any).toBe(file.gender.women_any.value[rankYear] === null ? NOT_PUBLISHED : share(file.gender.women_any.value[rankYear]));
    expect(shareText).toBe(file.gender.women_share.value[rankYear] === null ? NOT_PUBLISHED : share(file.gender.women_share.value[rankYear]));
  }
  expect(errors).toEqual([]);
});

test("the page and the ranking embed request no entity file", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.includes("/data/entity/")) requested.push(request.url()); });
  await page.goto("/?view=women-inventors");
  await expect(page.locator('.chart-card[data-chart="women-ranking"] .ranking-table tr[data-code="CH"]')).toHaveCount(1);
  await page.goto("/embed.html?chart=women-ranking&theme=embed");
  await expect(page.locator('.ranking-table tr[data-code="CH"]')).toHaveCount(1);
  expect(requested).toEqual([]);
});

test("ranking: an unpublished share reads 'not published by WIPO', never 0; publications still shown", async ({ page }) => {
  const code = unpublishedCode();
  const file = entity(code);
  await page.goto("/?view=women-inventors");
  const row = page.locator(`.chart-card[data-chart="women-ranking"] .ranking-table tr[data-code="${code}"]`);
  await expect(row.locator("td").nth(2)).toContainText(NOT_PUBLISHED);
  await expect(row.locator("td").nth(2)).not.toHaveText(/^0/);
  const pubs = file.pct_publications[rankYear];
  await expect(row.locator("td").nth(1)).toHaveText(pubs === null ? "–" : count(pubs));
});

test("ranking: sortable by each column, nulls last, default women_any descending", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-ranking"]');
  const table = card.locator(".ranking-table");
  const any = (code: string): number | null => entity(code).gender.women_any.value[rankYear];
  const published = countries().map((ref) => ({ ref, value: any(ref.code) })).filter((item) => item.value !== null);
  const top = Math.max(...published.map((item) => item.value as number));
  const firstShare = async (): Promise<string> => (await table.locator("tbody tr").first().locator("td").nth(2).textContent()) ?? "";
  expect(await firstShare()).toBe(share(top));
  await expect(table.locator("thead th").nth(2)).toHaveAttribute("aria-sort", "descending");
  const lastRow = table.locator("tbody tr").last();
  await expect(lastRow.locator("td").nth(2)).toContainText(NOT_PUBLISHED);
  // publications: largest first on the first click, smallest (with a value) first on the second
  const pubsOf = (code: string): number | null => entity(code).pct_publications[rankYear];
  const largest = Math.max(...countries().map((ref) => pubsOf(ref.code) ?? -1));
  await table.locator("thead th").nth(1).getByRole("button").click();
  await expect(table.locator("thead th").nth(1)).toHaveAttribute("aria-sort", "descending");
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText(count(largest));
  await table.locator("thead th").nth(1).getByRole("button").click();
  await expect(table.locator("thead th").nth(1)).toHaveAttribute("aria-sort", "ascending");
  const smallest = Math.min(...countries().map((ref) => pubsOf(ref.code)).filter((value): value is number => value !== null));
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText(count(smallest));
  // country column: alphabetical
  await table.locator("thead th").nth(0).getByRole("button").click();
  await expect(table.locator("thead th").nth(0)).toHaveAttribute("aria-sort", "ascending");
  const labels = countries().map((ref) => ref.label).sort((a, b) => a.localeCompare(b));
  await expect(table.locator("tbody tr").first().locator("td").nth(0)).toHaveText(labels[0]);
});

test("ranking note does not call the publications the base of the shares; the method note carries its link", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-ranking"]');
  await expect(card.locator(".chart-note")).toContainText("the PCT Yearly Review 2026 does not state the denominator");
  await expect(card.locator(".chart-note")).not.toContainText("base of both");
  for (const id of IDS) {
    await expect(page.locator(`.chart-card[data-chart="${id}"] .chart-footnote`, { hasText: method.method_note.url })).toHaveCount(1);
  }
});

test("a footnote names the newer year when the two measures' last years differ", async ({ page }) => {
  await page.route("**/data/overview.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.gender.last_year.women_any += 1; // no World value for that year: the trend stops where its values do
    body.gender.world.women_any[String(body.gender.last_year.women_any)] = null;
    await route.fulfill({ json: body });
  });
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-ranking"]');
  await expect(card.locator("h2")).toContainText(rankYear);
  await expect(card.locator(".chart-footnote", { hasText: `${MEASURES.women_any} also has ${Number(rankYear) + 1}` })).toHaveCount(1);
});

test("the trend charts redraw when the window resizes", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/?view=women-inventors");
  const svgs = page.locator('.chart-card[data-chart="women-world-trend"] .chart-figure svg');
  await expect(svgs).toHaveCount(2);
  const widths = async (): Promise<number[]> => svgs.evaluateAll((list) => list.map((svg) => svg.getBoundingClientRect().width));
  const before = await widths();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect.poll(async () => (await widths()).every((width, index) => width < before[index]), { timeout: RESIZE_SETTLE_MS * 40 }).toBe(true);
  await expect(svgs).toHaveCount(2);
});

test("an unknown country beside the view: no claim that a country page is shown", async ({ page }) => {
  await page.goto("/?view=women-inventors&country=XX");
  await expect(page.locator("#notices")).toContainText("Unknown country: XX");
  await expect(page.locator("#notices")).not.toContainText("page only");
  await expect(page.locator("h1")).toHaveText("Patent applications around the world");
});

test("an embed with a stray country: its full-page link keeps the women chart, not the country", async ({ page }) => {
  await page.goto("/embed.html?chart=women-ranking&country=CH&theme=embed");
  await expect(page.locator('.ranking-table tr[data-code="CH"]')).toHaveCount(1);
  const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
  const params = new URL(href, page.url()).searchParams;
  expect(params.get("view")).toBe("women-inventors");
  expect(params.get("chart")).toBe("women-ranking");
  expect(params.has("country")).toBe(false);
});

test("the trend's y-axis ticks carry a percent sign", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const svg = page.locator('.chart-card[data-chart="women-world-trend"] .chart-figure svg').first();
  const texts = await svg.evaluate((element) => [...element.querySelectorAll("text")].map((text) => text.textContent ?? ""));
  expect(texts.filter((text) => /^\d+%$/.test(text)).length).toBeGreaterThan(1); // axis ticks: whole percents
});

test("unknown view: notice, overview shown", async ({ page }) => {
  await page.goto("/?view=bogus");
  await expect(page.locator("#notices")).toContainText("Unknown view: bogus");
  await expect(page.locator("h1")).toHaveText("Patent applications around the world");
  await expect(page.locator('.chart-card[data-chart="women-ranking"]')).toHaveCount(0);
});

test("a country page wins over the view, with a notice", async ({ page }) => {
  await page.goto("/?view=women-inventors&country=CH");
  await expect(page.locator("h1")).toHaveText(entity("CH").label);
  await expect(page.locator("#notices")).toContainText("View women-inventors left out");
  await expect(page.locator('.chart-card[data-chart="women-ranking"]')).toHaveCount(0);
  for (const key of ["region=154", "continent=europe", "office=EP"]) {
    await page.goto(`/?view=women-inventors&${key}`);
    await expect(page.locator("#notices")).toContainText("View women-inventors left out");
  }
});

test("cite and embed links of a women card carry the view and the chart", async ({ page }) => {
  await page.goto("/?view=women-inventors");
  const card = page.locator('.chart-card[data-chart="women-by-field"]');
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  const text = (await card.locator(".cite-text").textContent()) ?? "";
  const cited = new URL(/https?:\/\/\S+?(?=\.\s)/.exec(text)?.[0] ?? "");
  expect(cited.searchParams.get("view")).toBe("women-inventors");
  expect(cited.searchParams.get("chart")).toBe("women-by-field");
  await card.getByRole("button", { name: "Embed", exact: true }).click();
  const snippet = (await card.locator(".embed-snippet").textContent()) ?? "";
  const src = new URL(/src="([^"]+)"/.exec(snippet)?.[1].replaceAll("&amp;", "&") ?? "");
  expect(src.pathname).toMatch(/embed\.html$/);
  expect(src.searchParams.get("chart")).toBe("women-by-field");
});

for (const id of IDS) {
  test(`embed ${id}: chart, source line, caveat, link to the full page`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/embed.html?chart=${id}&theme=embed`);
    const card = page.locator(".chart-card");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-chart", id);
    await expect(page.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
    await expect(page.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
    await expect(page.locator(".chart-footnote").last()).toContainText(method.method_note.citation);
    const link = page.locator(".chart-link a");
    await expect(link).toHaveAttribute("href", /view=women-inventors/);
    await expect(link).toHaveAttribute("href", new RegExp(`chart=${id}`));
    if (id === "women-ranking") await expect(page.locator('.ranking-table tr[data-code="CH"]')).toHaveCount(1);
    else await expect(page.locator(".chart-figure svg").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("the group basis label equals the pipeline's GROUP_COMPUTED_LABEL and the group files' wording", async () => {
  const pipeline = /^GROUP_COMPUTED_LABEL = "([^"]+)"/m.exec(readFileSync("pipeline/write.py", "utf8"))?.[1];
  const site = /computed: "([^"]+)"/.exec(readFileSync("site/src/genderText.ts", "utf8"))?.[1];
  expect(pipeline).toBeTruthy();
  expect(site).toBe(pipeline);
  expect(readJson("site/data/group/europe.json").sources.women_any.description).toContain(pipeline as string);
});

// ---- Country and region cards (entity-women, group-women) ----
const group = (id: string) => readJson(`site/data/group/${id}.json`);
const groups = readJson("site/data/groups.json").items as { id: string; kind: string; label: string; members: string[] }[];
const ENTITY_CARD = "entity-women";
const MEASURES_KEYS = ["women_any", "women_share"] as const;
const GENDER_BASIS = { wipo: "WIPO" };
const GROUP_CARD = "group-women";
const lastYear = (measure: "women_any" | "women_share"): string => String(gender.last_year[measure]);
const covered = (coverage: number): string => `${fixedPercent(coverage, method.coverage_decimals - 2)}%`;
const floorText = `${fixedHalfAway(method.group_coverage_min * 100, 0)}%`;
const CHE = entity("CH");
const REGION = group("155");
const REGION_LABEL = "Western Europe";

/** Opens a "Show figures" panel and returns the table rows (year first, newest first) as cell texts. */
async function figureRows(card: ReturnType<Page["locator"]>): Promise<string[][]> {
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  return card.locator(".chart-figures tbody tr").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")));
}

test("country card: CH tiles equal the files (country, region with n of m and coverage, World), basis per value", async ({ page }) => {
  const errors = trackErrors(page);
  expect(groups.find((item) => item.id === "155")?.label).toBe(REGION_LABEL);
  expect(groups.find((item) => item.kind === "region" && item.members.includes("CH"))?.id).toBe("155");
  await page.goto("/?country=CH");
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator("h2")).toContainText("by publication year");
  await expect(card.locator(".chart-note")).toContainText("WIPO's shares and, for the group, values computed from them or printed by WIPO (see notes)"); // its region tile is a group
  for (const measure of ["women_any", "women_share"] as const) {
    const year = lastYear(measure);
    const tile = card.locator(`.tile[data-measure="${measure}"]`);
    await expect(tile.locator(".tile-label").first()).toContainText(`${MEASURES[measure]}, ${year}`);
    await expect(tile.locator(".tile-value")).toHaveText(share(CHE.gender[measure].value[year]));
    await expect(tile.locator(".tile-basis")).toHaveText("WIPO");
    await expect(tile.locator(".tile-world")).toHaveText(`World: ${share(gender.world[measure][year])} (WIPO)`);
  }
  const any = REGION.gender.women_any;
  const region = card.locator('.tile[data-measure="women_any"] .tile-region');
  const year = lastYear("women_any");
  await expect(region).toContainText(`${REGION_LABEL}: ${share(any.value[year])}`);
  await expect(region).toContainText(`${any.reporting[year]} of ${any.members} members`);
  await expect(region).toContainText(`coverage ${covered(any.coverage[year])}`);
  await expect(region).toContainText("computed from WIPO shares weighted by PCT publications");
  await expect(card.locator('.tile[data-measure="women_share"] .tile-region')).toContainText(`${REGION_LABEL}: –`);
  await expect(card.locator('.tile[data-measure="women_share"] .tile-region')).toContainText("not computable");
  await expect(card.locator(".chart-figure svg")).toHaveCount(2);
  await expect(card.locator(".source-line").first()).toContainText("Source: WIPO Statistics Database (release ");
  expect(errors).toEqual([]);
});

test("country card: the figures table equals CH, its region and the World year by year", async ({ page }) => {
  await page.goto("/?country=CH");
  const rows = await figureRows(page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`));
  const years = Object.keys(CHE.gender.women_any.value).filter((year) => Number(year) <= gender.last_year.women_any).sort().reverse();
  expect(rows.map((row) => row[0])).toEqual(years);
  const any = REGION.gender.women_any;
  for (const row of rows) {
    const year = row[0];
    const reporting = any.reporting[year];
    expect(row.slice(1, 9)).toEqual([
      share(CHE.gender.women_any.value[year]), share(any.value[year]),
      reporting === null || reporting === undefined ? "–" : `${reporting} of ${any.members}`,
      any.coverage[year] === null || any.coverage[year] === undefined ? "–" : covered(any.coverage[year]),
      share(gender.world.women_any[year]),
      share(CHE.gender.women_share.value[year]), share(REGION.gender.women_share.value[year]),
      share(gender.world.women_share[year]),
    ]);
  }
});

test("country card: a gap year breaks the line; a missing last year reads – and its reason, never 0", async ({ page }) => {
  const gapYear = "2022";
  const last = lastYear("women_any");
  await page.route("**/data/entity/CH.json", async (route) => {
    const body = await (await route.fetch()).json();
    for (const year of [gapYear, last]) {
      body.gender.women_any.value[year] = null;
      body.gender.women_any.null_reason[year] = "not_published";
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/?country=CH");
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  const tile = card.locator('.tile[data-measure="women_any"]');
  await expect(tile.locator(".tile-value")).toHaveText("–");
  await expect(tile.locator(".tile-basis")).toContainText("no data reported: not published by WIPO for this year");
  await expect(tile.locator(".tile-value")).not.toHaveText(/^0/);
  // the country's line is the first of the measure's chart; one sub-path per unbroken stretch
  const path = card.locator('.women-trend[data-measure="women_any"] .chart-line path').first();
  const segments = ((await path.getAttribute("d")) ?? "").match(/M/g) ?? [];
  expect(segments.length).toBeGreaterThanOrEqual(2);
  const rows = await figureRows(card);
  const gapRow = rows.find((row) => row[0] === gapYear)!;
  expect(gapRow[1]).toBe("–");
  expect(gapRow[9]).toContain("not published by WIPO for this year");
  expect(rows.flatMap((row) => row.slice(1, 9)).filter((cell) => /^0(\.0+)?%?$/.test(cell))).toEqual([]);
});

test("country card: a region year below the coverage floor shows – and the low-coverage reason with its coverage", async ({ page }) => {
  const last = lastYear("women_any");
  await page.route("**/data/group/155.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.gender.women_any.value[last] = null;
    body.gender.women_any.null_reason[last] = "low_coverage";
    body.gender.women_any.coverage[last] = 0.5;
    body.gender.women_any.reporting[last] = 2;
    await route.fulfill({ json: body });
  });
  await page.goto("/?country=CH");
  const region = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"] .tile[data-measure="women_any"] .tile-region`);
  await expect(region).toContainText(`${REGION_LABEL}: –`);
  await expect(region).toContainText(`hold under ${floorText} of the group's PCT publications`);
  await expect(region).toContainText(`2 of ${REGION.gender.women_any.members} members`);
  await expect(region).toContainText(`coverage ${covered(0.5)}`);
  await expect(region).not.toContainText(/: 0(\.0)?%/);
});

test("country card: a country with no value in any year shows one line, no tiles or charts", async ({ page }) => {
  const none = countries().find((ref) => MEASURES_KEYS.every((measure) => Object.values(entity(ref.code).gender[measure].value).every((value) => value === null)));
  if (!none) throw new Error("no country without any share in the data");
  await page.goto(`/?country=${none.code}`);
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  await expect(card.locator(".women-none")).toHaveText(`WIPO publishes no women-inventor share for ${none.label}`);
  await expect(card.locator(".tile")).toHaveCount(0);
  await expect(card.locator(".chart-figure svg")).toHaveCount(0);
  await expect(card.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
  await expect(card.locator(".chart-footnote", { hasText: method.method_note.url })).toHaveCount(1);
});

test("country card: a country with values in few years keeps WIPO's other years and says why the rest are missing", async ({ page }) => {
  const partial = countries().find((ref) => {
    const values = Object.values(entity(ref.code).gender.women_any.value);
    return values.some((value) => value !== null) && values.some((value) => value === null);
  });
  if (!partial) throw new Error("no country with gaps in the data");
  await page.goto(`/?country=${partial.code}`);
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  await expect(card.locator(".chart-figure svg").first()).toBeVisible();
  const rows = await figureRows(card);
  const file = entity(partial.code);
  for (const row of rows) expect(row[1]).toBe(share(file.gender.women_any.value[row[0]]));
  const missing = rows.filter((row) => row[1] === "–");
  expect(missing.length).toBeGreaterThan(0);
  for (const row of missing) expect(row[row.length - 1]).toContain("not published by WIPO for this year");
});

test("country card: US compares with Northern America, whose 2025 women_share is WIPO's printed 18.2%", async ({ page }) => {
  const northern = group("021");
  const year = lastYear("women_share");
  expect(northern.gender.women_share.wipo_years).toContain(Number(year));
  expect(northern.gender.women_share.value[year]).toBe(18.2);
  await page.goto("/?country=US");
  const region = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"] .tile[data-measure="women_share"] .tile-region`);
  await expect(region).toContainText(`Northern America: ${share(18.2)}`);
  await expect(region).toContainText(`${GENDER_BASIS.wipo}, printed`);
  await expect(region).not.toContainText("computed");
});

test("charts: an isolated published value gets a dot; unbroken lines get only their end dots", async ({ page }) => {
  const circles = async (id: string): Promise<number> => {
    await expect(page.locator(`.chart-card[data-chart="${id}"] .women-trend[data-measure="women_any"] svg`)).toBeVisible();
    return page.locator(`.chart-card[data-chart="${id}"] .women-trend[data-measure="women_any"] svg circle`).count();
  };
  await page.goto("/?country=CH");
  expect(await circles(ENTITY_CARD)).toBe(6); // three lines, ring + dot at each end
  const values = entity("AM").gender.women_any.value as Record<string, number | null>;
  const years = Object.keys(values).sort();
  const isolated = years.filter((year, index) => values[year] !== null && values[years[index - 1]] == null && values[years[index + 1]] == null &&
    years.findIndex((other) => values[other] !== null && Number(other) > Number(year)) !== -1).length;
  expect(isolated).toBeGreaterThan(0);
  await page.goto("/?country=AM");
  expect(await circles(ENTITY_CARD)).toBeGreaterThanOrEqual(2 * 3 + isolated);
});

test("country card: the one-line card has no chart note, gap footnote or table of dashes", async ({ page }) => {
  const none = countries().find((ref) => MEASURES_KEYS.every((measure) => Object.values(entity(ref.code).gender[measure].value).every((value) => value === null)))!;
  await page.goto(`/?country=${none.code}`);
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  await expect(card.locator(".chart-note")).toHaveCount(0);
  await expect(card.locator(".chart-footnote")).toHaveCount(2); // the caveat and WIPO's method note only
  await expect(card.locator(".chart-footnote", { hasText: "gap in a line" })).toHaveCount(0);
  await expect(card.locator(".chart-query")).toHaveCount(2); // its own two queries, no region or World
  const rows = await figureRows(card);
  expect(rows).toHaveLength(2);
});

test("group card: n of m names the members with PCT publications data, and any left out", async ({ page }) => {
  const europe = group("europe");
  expect(europe.gender.women_any.unlisted).toEqual(["GG"]);
  await page.goto("/?continent=europe");
  const note = page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .chart-footnote`, { hasText: "n of m members" });
  await expect(note).toContainText(`of the ${europe.gender.women_any.members} members with PCT publications data`);
  await expect(note).toContainText("without PCT publications data: Guernsey (GG) (45 members in all)");
  // the country page names the left-out member of its region the same way
  await page.goto("/?country=SE");
  expect(groups.find((item) => item.kind === "region" && item.members.includes("SE"))?.id).toBe("154");
  await expect(page.locator(`.chart-card[data-chart="${ENTITY_CARD}"] .chart-footnote`, { hasText: "n of m members" }))
    .toContainText("without PCT publications data: Guernsey (GG) (11 members in all)");
});

test("women cards: no parenthesis inside a parenthesis", async ({ page }) => {
  const nested = /\([^()]*\([^()]*\)/;
  for (const url of ["/?country=CH", "/?country=AM", "/?country=US", "/?region=155", "/?continent=europe", "/?region=011"]) {
    await page.goto(url);
    const card = page.locator(".chart-card[data-chart$='-women']");
    await expect(card).toHaveCount(1);
    const text = (await card.textContent()) ?? "";
    expect(nested.test(text), `${url}: ${nested.exec(text)?.[0]}`).toBe(false);
  }
});

test("source lines name country, region and World; a group's women_share has no indicator 15 query", async ({ page }) => {
  await page.goto("/?country=CH");
  const queries = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"] .chart-query`);
  await openNotes(page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`));
  await expect(queries.first()).toBeVisible();
  const texts = await queries.allTextContents();
  expect(texts.filter((text) => text.includes("entity: Switzerland (CH)"))).toHaveLength(2);
  expect(texts.filter((text) => text.includes("entity: World (ZZ)"))).toHaveLength(2);
  expect(texts.filter((text) => text.includes(`entity: ${REGION_LABEL}`))).toHaveLength(1);
  expect(texts.filter((text) => text.includes(`entity: ${REGION_LABEL}`))[0]).toContain("indicator 13");
  await page.goto("/?continent=europe");
  await openNotes(page.locator(`.chart-card[data-chart="${GROUP_CARD}"]`));
  await expect(page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .chart-query`).first()).toBeVisible();
  const groupTexts = await page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .chart-query`).allTextContents();
  expect(groupTexts.filter((text) => text.includes("entity: Europe"))).toHaveLength(1);
  expect(groupTexts.filter((text) => text.includes("indicator 15"))).toHaveLength(1); // World's own row only
});

test("group not-computable years carry their reason in the Note column", async ({ page }) => {
  await page.goto("/?region=155");
  const rows = await figureRows(page.locator(`.chart-card[data-chart="${GROUP_CARD}"]`));
  for (const row of rows) expect(row[row.length - 1]).toContain("not computable (WIPO publishes no inventor counts)");
  for (const row of rows) expect(row.join(" | ")).not.toMatch(/\b(0|null|undefined) of \d/);
  // a group card says its values are computed or printed, not all "WIPO's figures"
  const note = page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .chart-note`);
  await expect(note).toContainText("WIPO's shares and, for the group, values computed from them or printed by WIPO (see notes)");
  await expect(note).not.toContainText("WIPO's figures");
});

test("country card: caveat and WIPO's method note, on the page and in the embed", async ({ page }) => {
  await page.goto("/?country=CH");
  const card = page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`);
  await expect(card.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
  await expect(card.locator(".chart-footnote", { hasText: method.method_note.url })).toHaveCount(1);
  await page.goto(`/embed.html?chart=${ENTITY_CARD}&country=CH&theme=embed`);
  await expect(page.locator(".chart-card")).toHaveAttribute("data-chart", ENTITY_CARD);
  await expect(page.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
  await expect(page.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
  await expect(page.locator('.tile[data-measure="women_any"] .tile-value')).toHaveText(share(CHE.gender.women_any.value[lastYear("women_any")]));
  await expect(page.locator(".chart-link a")).toHaveAttribute("href", new RegExp(`chart=${ENTITY_CARD}`));
  await expect(page.locator(".chart-link a")).toHaveAttribute("href", /country=CH/);
});

test("office pages have no women card", async ({ page }) => {
  await page.goto("/?office=EP");
  await expect(page.locator(`.chart-card[data-chart="${ENTITY_CARD}"]`)).toHaveCount(0);
});

test("region card: group women_any with n of m and coverage, women_share not computable, equal the group file", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?region=155");
  const card = page.locator(`.chart-card[data-chart="${GROUP_CARD}"]`);
  await expect(card).toHaveCount(1);
  const any = REGION.gender.women_any;
  const year = lastYear("women_any");
  const tile = card.locator('.tile[data-measure="women_any"]');
  await expect(tile.locator(".tile-value")).toHaveText(share(any.value[year]));
  await expect(tile.locator(".tile-basis")).toContainText(`${any.reporting[year]} of ${any.members} members`);
  await expect(tile.locator(".tile-basis")).toContainText(`coverage ${covered(any.coverage[year])}`);
  await expect(tile.locator(".tile-basis")).toContainText("computed from WIPO shares weighted by PCT publications");
  await expect(tile.locator(".tile-world")).toHaveText(`World: ${share(gender.world.women_any[year])} (WIPO)`);
  const shareTile = card.locator('.tile[data-measure="women_share"]');
  await expect(shareTile.locator(".tile-value")).toHaveText("–");
  await expect(shareTile.locator(".tile-basis")).toContainText("not computable (WIPO publishes no inventor counts)");
  await expect(card.locator(".women-none")).toContainText("not computable");
  await expect(card.locator(".chart-figure svg")).toHaveCount(1);
  await expect(card.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
  await expect(card.locator(".chart-footnote", { hasText: method.method_note.url })).toHaveCount(1);
  const rows = await figureRows(card);
  for (const row of rows) {
    const key = row[0];
    expect(row[1]).toBe(share(any.value[key]));
    expect(row[2]).toBe(any.reporting[key] === null || any.reporting[key] === undefined ? "–" : `${any.reporting[key]} of ${any.members}`);
    expect(row[3]).toBe(any.coverage[key] === null || any.coverage[key] === undefined ? "–" : covered(any.coverage[key]));
    expect(row[4]).toBe(share(gender.world.women_any[key]));
    expect(row[5]).toBe("–"); // women_share: not computable in every year of a sub-region
  }
  expect(errors).toEqual([]);
});

test("continent card: WIPO's printed 2025 women_share is labelled WIPO and cited; other years not computable", async ({ page }) => {
  const europe = group("europe");
  const wipoYear = String(europe.gender.women_share.wipo_years[0]);
  const printed = europe.sources.women_share.printed[wipoYear];
  await page.goto("/?continent=europe");
  const card = page.locator(`.chart-card[data-chart="${GROUP_CARD}"]`);
  const tile = card.locator('.tile[data-measure="women_share"]');
  await expect(tile.locator(".tile-value")).toHaveText(share(europe.gender.women_share.value[lastYear("women_share")]));
  await expect(tile.locator(".tile-basis")).toContainText(`${GENDER_BASIS.wipo}, printed (figure ${printed.figure}`);
  await expect(tile.locator(".tile-basis")).not.toContainText("computed");
  await expect(card.locator(".chart-footnote", { hasText: printed.page })).toHaveCount(1);
  await expect(card.locator(".chart-footnote", { hasText: printed.page })).toContainText(printed.citation);
  const rows = await figureRows(card);
  const wipoRow = rows.find((row) => row[0] === wipoYear)!;
  expect(wipoRow[5]).toBe(share(europe.gender.women_share.value[wipoYear]));
  const other = rows.find((row) => row[0] !== wipoYear)!;
  expect(other[5]).toBe("–");
  // women_any of the continent stays computed
  await expect(card.locator('.tile[data-measure="women_any"] .tile-basis')).toContainText("computed from WIPO shares weighted by PCT publications");
});

test("region card: a patched low_coverage year reads – with the reason and coverage; never 0", async ({ page }) => {
  const last = lastYear("women_any");
  await page.route("**/data/group/155.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.gender.women_any.value[last] = null;
    body.gender.women_any.null_reason[last] = "low_coverage";
    body.gender.women_any.coverage[last] = 0.5;
    await route.fulfill({ json: body });
  });
  await page.goto("/?region=155");
  const tile = page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .tile[data-measure="women_any"]`);
  await expect(tile.locator(".tile-value")).toHaveText("–");
  await expect(tile.locator(".tile-basis")).toContainText(`hold under ${floorText} of the group's PCT publications`);
  await expect(tile.locator(".tile-basis")).toContainText(`coverage ${covered(0.5)}`);
});

test("a group with no women_any value in any year shows its reasons, not a chart", async ({ page }) => {
  const empty = groups.find((item) => Object.values(group(item.id).gender.women_any.value).every((value) => value === null));
  if (!empty) throw new Error("no group without values in the data");
  await page.goto(`/?${empty.kind}=${empty.id}`);
  const card = page.locator(`.chart-card[data-chart="${GROUP_CARD}"]`);
  await expect(card.locator('.women-none[data-measure="women_any"]')).toContainText(`no value for ${empty.label} in any year`);
  await expect(card.locator('.tile[data-measure="women_any"] .tile-value')).toHaveText("–");
});

for (const [name, query] of [["region", "region=155"], ["continent", "continent=europe"]]) {
  test(`embed ${GROUP_CARD} (${name}): chart, source line, caveat, link to the full page`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/embed.html?chart=${GROUP_CARD}&${query}&theme=embed`);
    await expect(page.locator(".chart-card")).toHaveAttribute("data-chart", GROUP_CARD);
    await expect(page.locator(".chart-figure svg").first()).toBeVisible();
    await expect(page.locator(".source-line").first()).toContainText(`retrieved ${manifest.retrieved}`);
    await expect(page.locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
    await expect(page.locator(".chart-link a")).toHaveAttribute("href", new RegExp(`chart=${GROUP_CARD}`));
    expect(errors).toEqual([]);
  });
}

test("embed entity-women without a country: asks for one", async ({ page }) => {
  await page.goto(`/embed.html?chart=${ENTITY_CARD}&theme=embed`);
  await expect(page.locator(".embed-problem")).toContainText("needs a country");
});

test("left-out members come from the group file's unlisted field, not from the PCT origin file", async ({ page }) => {
  await page.route("**/data/group/europe.json", async (route) => {
    const file = await (await route.fetch()).json();
    file.gender.women_any.unlisted = ["CH"];
    await route.fulfill({ json: file });
  });
  await page.route("**/data/map/pct_origin.json", async (route) => {
    const file = await (await route.fetch()).json();
    delete file.values.SE;
    await route.fulfill({ json: file });
  });
  await page.goto("/?continent=europe");
  const note = page.locator(`.chart-card[data-chart="${GROUP_CARD}"] .chart-footnote`, { hasText: "n of m members" });
  await expect(note).toContainText("without PCT publications data: Switzerland (CH) (45 members in all)");
  await expect(note).not.toContainText("Guernsey");
  await expect(note).not.toContainText("Sweden");
});
