import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { fixtureBreak, includesBreakNote, routeSeriesBreaks } from "./seriesBreaks";
import { FONT_VARIANTS, useWideFonts } from "./wideFonts";

const manifest = JSON.parse(readFileSync("site/data/manifest.json", "utf8"));
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const groupsFile = JSON.parse(readFileSync("site/data/groups.json", "utf8"));

const OVERVIEW_CHARTS = ["world-map", "world-trend", "top-origins", "fastest-growers", "pct-world-trend", "rank-race", "continent-share",
  "treemap", "share-shift", "size-growth", "pct-monthly"];
/** Overview cards that count applications by origin: each carries the pre-ORIGIN_ABROAD_FROM note. */
const ORIGIN_CARDS = ["world-map", "top-origins", "fastest-growers", "rank-race", "continent-share", "size-growth", "treemap", "share-shift"];

/** World years shown (<= world_last_year) and those among them with a null value. */
function worldYears(world: "world_office" | "pct_world"): { shown: string[]; nulls: string[] } {
  const last = overview.world_last_year[world];
  const shown = Object.keys(overview[world]).filter((year) => Number(year) <= last);
  return { shown, nulls: shown.filter((year) => overview[world][year] === null) };
}

/** Vertices and subpaths ("M" moves) in an SVG path `d`. */
function pathShape(d: string): { moves: number; vertices: number } {
  return { moves: (d.match(/M/g) ?? []).length, vertices: (d.match(/[ML]/g) ?? []).length };
}

/** Runs of consecutive non-null values: each is one subpath of the line (a null is a gap). */
function definedRuns(values: (number | null)[]): number {
  return values.filter((value, index) => value !== null && (index === 0 || values[index - 1] === null)).length;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("overview shows the world chart cards (map first), each with an SVG chart and a WIPO source line", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".chart-card").first()).toHaveAttribute("data-chart", "world-map");
  for (const id of OVERVIEW_CHARTS) {
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.locator("svg").first()).toBeVisible();
    await expect(card.locator(".source-line")).toContainText("WIPO Statistics Database");
    await expect(card.locator(".source-line")).toContainText(manifest.retrieved);
  }
  expect(errors).toEqual([]);
});

test("overview shows treemap and share-shift after continent-share", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".chart-card").last()).toHaveAttribute("data-chart", "pct-monthly");
  const order = await page.locator("#charts .chart-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-chart")));
  const at = order.indexOf("continent-share");
  expect(at).toBeGreaterThan(-1);
  expect(order.slice(at, at + 3)).toEqual(["continent-share", "treemap", "share-shift"]);
  await expect(page.locator('.chart-card[data-chart="treemap"]')).toHaveClass(/chart-card--wide/);
});

test("show figures reveals a table with the latest year", async ({ page }) => {
  const reported = worldYears("world_office").shown.filter((year) => overview.world_office[year] !== null);
  const gap = reported[Math.floor(reported.length / 2)]; // patched null inside the shown years
  await editOverview(page, (data) => { data.world_office[gap] = null; });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="world-trend"]');
  const table = card.locator("table");
  await expect(table).toBeHidden();
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(table).toBeVisible();
  const latest = String(overview.world_last_year.world_office);
  await expect(table.locator("tbody tr", { hasText: latest })).toHaveCount(1);
  // provisional years after world_last_year are not shown
  await expect(table.locator("tbody tr", { hasText: String(overview.world_last_year.world_office + 1) })).toHaveCount(0);
  // missing years (null) are shown as a dash, never 0
  const nulls = [...worldYears("world_office").nulls, gap];
  for (const year of nulls) {
    const row = table.locator("tbody tr").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${year}$`) }) });
    await expect(row.locator("td").nth(1)).toHaveText("–");
  }
  // year and count columns align right
  await expect(table.locator("thead th").first()).toHaveClass(/num/);
});

test("world charts: 'To reproduce' names the WIPO row and the years the chart shows", async ({ page }) => {
  await page.goto("/");
  for (const [id, world, row] of [["world-trend", "world_office", "WD"], ["pct-world-trend", "pct_world", "ZZ"]] as const) {
    const last = overview.world_last_year[world];
    const first = worldYears(world).shown.find((year) => overview[world][year] !== null);
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    await expect(card.locator("h2")).toHaveText(new RegExp(`, ${first}–${last}$`));
    await expect(card.locator(".chart-query")).toContainText(`entity: ${row}; years ${first}-${last}.`);
  }
});

test("null years are gaps in the line and area, never plotted as zero", async ({ page }) => {
  await page.goto("/");
  for (const [id, world] of [["world-trend", "world_office"], ["pct-world-trend", "pct_world"]] as const) {
    const { shown } = worldYears(world);
    const values = shown.map((year) => overview[world][year] as number | null);
    const defined = values.filter((value) => value !== null).length;
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    const line = pathShape((await card.locator('g[aria-label="line"] path').getAttribute("d")) ?? "");
    expect(line, id).toEqual({ moves: definedRuns(values), vertices: defined });
    // area: top and bottom edge per defined point, one closed shape per run
    const area = pathShape((await card.locator('g[aria-label="area"] path').getAttribute("d")) ?? "");
    expect(area, id).toEqual({ moves: definedRuns(values), vertices: defined * 2 });
  }
});

test("top-origins: first row is the rank 1 origin from overview.json", async ({ page }) => {
  await page.goto("/");
  const first = overview.top_origins.find((row: { rank: number }) => row.rank === 1);
  const card = page.locator('.chart-card[data-chart="top-origins"]');
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(card.locator("tbody tr").first()).toContainText(first.label);
  await expect(card.locator("h2")).toContainText(String(overview.top_year));
});

/** Table body cells, row by row (hidden tables too: textContent). */
async function tableRows(card: Locator): Promise<string[][]> {
  return card.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => [...row.querySelectorAll("td, th")].map((cell) => (cell.textContent ?? "").trim())));
}

/** Count as the site shows it; written here, not imported (dom.ts formatCount is the code under test). */
const count = (value: number): string => value.toLocaleString("en-US");

type TopRow = { rank: number; label: string; value: number };
type GrowerRow = { label: string; cagr10: number };

test("top-origins and fastest-growers tables equal overview.json", async ({ page }) => {
  await page.goto("/");
  const top = page.locator('.chart-card[data-chart="top-origins"]');
  await expect(top.locator("svg").first()).toBeVisible();
  const ranked = [...(overview.top_origins as TopRow[])].sort((a, b) => a.rank - b.rank);
  expect(await tableRows(top)).toEqual(ranked.map((row) => [String(row.rank), row.label, count(row.value)]));
  const decimals = overview.method.rounding.decimals.cagr;
  const growers = page.locator('.chart-card[data-chart="fastest-growers"]');
  expect(await tableRows(growers)).toEqual((overview.fastest_growers as GrowerRow[])
    .map((row) => [row.label, `${row.cagr10.toFixed(decimals)}%`]));  // cagr10 already rounded by the pipeline
  const trend = page.locator('.chart-card[data-chart="world-trend"]');
  const latest = String(overview.world_last_year.world_office);
  expect((await tableRows(trend))[0]).toEqual([latest, count(overview.world_office[latest])]);
});

test("cite text names author, release and retrieval date; theme selector rewrites the URL", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="top-origins"]');
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  const cite = card.locator(".cite-text");
  await expect(cite).toBeVisible();
  await expect(cite).toContainText(config.author);
  await expect(cite).toContainText(manifest.retrieved);
  const release = String(manifest.releases.ips).replace(/^Last updated:\s*/i, "");
  await expect(cite).toContainText(release);
  await expect(cite).toContainText("chart=top-origins");
  await expect(cite).toContainText(`theme=${config.defaultTheme}`);
  await card.locator(".chart-cite select").selectOption("paper");
  await expect(cite).toContainText("theme=paper");
  await expect(cite).not.toContainText(`theme=${config.defaultTheme}`);
});

test("embed snippet points at embed.html with the chart id", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="pct-world-trend"]');
  await card.getByRole("button", { name: "Embed", exact: true }).click();
  const snippet = card.locator(".embed-snippet");
  await expect(snippet).toContainText("<iframe");
  await expect(snippet).toContainText("embed.html?");
  await expect(snippet).toContainText("chart=pct-world-trend");
  await expect(snippet).toContainText(`theme=${config.embedTheme}`);
  await expect(snippet).toContainText(`height="${config.embedHeight}"`);
  await card.locator(".chart-embed select").selectOption("wallboard");
  await expect(snippet).toContainText("theme=wallboard");
  await expect(snippet).not.toContainText(`theme=${config.embedTheme}`);
});

test("copy citation: clipboard when allowed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="world-trend"]');
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  await card.getByRole("button", { name: "Copy citation" }).click();
  await expect(card.locator(".chart-cite .copy-status")).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await card.locator(".cite-text").textContent());
});

test("copy citation without clipboard access selects the text instead", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="world-trend"]');
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  await card.getByRole("button", { name: "Copy citation" }).click();
  await expect(card.locator(".chart-cite .copy-status")).toContainText("Ctrl+C");
  const selected = await page.evaluate(() => getSelection()?.toString());
  expect(selected).toBe(await card.locator(".cite-text").textContent());
  expect(errors).toEqual([]);
});

test("charts redraw at the new width when the window is resized", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const svg = page.locator('.chart-card[data-chart="world-trend"] .chart-figure > svg');
  const wide = Number(await svg.getAttribute("width"));
  await page.setViewportSize({ width: 420, height: 900 });
  await expect.poll(async () => Number(await svg.getAttribute("width"))).toBeLessThan(wide);
  const narrow = Number(await svg.getAttribute("width"));
  const cardWidth = await page.locator('.chart-card[data-chart="world-trend"] .chart-figure').evaluate((el) => el.clientWidth);
  expect(Math.abs(narrow - cardWidth)).toBeLessThanOrEqual(1);
});

test("every theme defines each token the charts read", () => {
  const source = readFileSync("site/src/charts.ts", "utf8");
  const tokens = [...new Set([...source.matchAll(/"(--[a-z0-9-]+)"/g)].map((match) => match[1]))];
  expect(tokens.length).toBeGreaterThan(10);
  for (const theme of config.themes as string[]) {
    const css = readFileSync(`site/themes/${theme}.css`, "utf8");
    expect(tokens.filter((token) => !new RegExp(`^\\s*${token}:`, "m").test(css)), theme).toEqual([]);
  }
});

test("contract: every chart card has a caption with the source line, a cite text and a WIPO query link", async ({ page }) => {
  await page.goto("/");
  const cards = page.locator(".chart-card");
  await expect(cards).toHaveCount(OVERVIEW_CHARTS.length);
  for (const card of await cards.all()) {
    await expect(card.locator("figcaption .source-line")).toContainText(
      /^Source: WIPO Statistics Database \(release .+, retrieved \d{4}-\d{2}-\d{2}, data version \S+\); analysis: Patent Atlas$/,
    );
    await expect(card.locator(".cite-text")).toHaveText(new RegExp(config.author));
    await expect(card.locator(".chart-query a")).toHaveAttribute("href", /^https:\/\/www3\.wipo\.int\/ipstats\//);
    await expect(card.locator(".chart-query")).toContainText("indicator");
  }
});

test("growers wording uses the CAGR years from overview.json", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="fastest-growers"]');
  const years = overview.method.cagr_years;
  await expect(card).toContainText(`${overview.top_year - years}–${overview.top_year}`);
  await expect(card).toContainText(`${years} years`);
});

test("chart param scrolls to that card", async ({ page }) => {
  await page.goto("/?chart=pct-world-trend");
  await expect(page.locator('.chart-card[data-chart="pct-world-trend"]')).toBeInViewport();
});

for (const theme of config.themes as string[]) {
  test(`overview renders all charts in theme ${theme}`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/?theme=${theme}`);
    await expect(page.locator(".chart-card svg").first()).toBeVisible();
    await expect(page.locator(".chart-card")).toHaveCount(OVERVIEW_CHARTS.length);
    expect(errors).toEqual([]);
  });
}

const originAbroadNote = new RegExp(`Before ${overview.method.origin_abroad_from}, .*origin “Abroad” is near-empty`);

/** Serves overview.json with `edit` applied (a copy of the real file). */
async function editOverview(page: Page, edit: (data: any) => void): Promise<void> {
  await page.route("**/data/overview.json", async (route) => {
    const body = await (await route.fetch()).json();
    edit(body);
    await route.fulfill({ json: body });
  });
}

const yearsOf = (keys: string[]): number[] => keys.map(Number).sort((a, b) => a - b);

test("new overview cards: source line, cite text and the WIPO query each", async ({ page }) => {
  await page.goto("/");
  for (const id of ["rank-race", "continent-share", "size-growth", "pct-monthly"]) {
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    await expect(card.locator(".source-line")).toHaveText(
      /^Source: WIPO Statistics Database \(release .+, retrieved \d{4}-\d{2}-\d{2}, data version \S+\); analysis: Patent Atlas$/);
    await card.getByRole("button", { name: "Cite this", exact: true }).click();
    await expect(card.locator(".cite-text")).toContainText(config.author);
    await expect(card.locator(".cite-text")).toContainText(`chart=${id}`);
    await expect(card.locator(".chart-query")).toContainText("indicator");
  }
});

test("rank race: `top` points in every year, one per rank; both ends of each line are named", async ({ page }) => {
  await page.goto("/");
  const race = overview.rank_race;
  const years = yearsOf(Object.keys(race.rows[0].ranks));
  const card = page.locator('.chart-card[data-chart="rank-race"]');
  const points = card.locator("g.rank-point circle");
  expect(race.top).toBeGreaterThan(0);
  await expect(points).toHaveCount(race.top * years.length);
  // per year (one x position each): exactly `top` points
  const perColumn = await points.evaluateAll((circles) => {
    const counts = new Map<string, number>();
    for (const circle of circles) counts.set(circle.getAttribute("cx") ?? "", (counts.get(circle.getAttribute("cx") ?? "") ?? 0) + 1);
    return [...counts.values()];
  });
  expect(perColumn).toHaveLength(years.length);
  expect(new Set(perColumn)).toEqual(new Set([race.top]));
  // the table has the same data: rank 1 of the latest year
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const latest = String(years[years.length - 1]);
  const first = race.rows.find((row: any) => row.ranks[latest] === 1);
  await expect(card.locator("tbody tr").first()).toContainText(latest);
  await expect(card.locator("tbody tr").first().locator("td").nth(1)).toHaveText(first.label);
  // every year and rank: each country ranked in the top is in its rank's cell (ties included, final review I2)
  const cells = await card.locator("tbody tr").evaluateAll((rows) =>
    Object.fromEntries(rows.map((row) => {
      const texts = [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
      return [texts[0], texts.slice(1)];
    })));
  let ties = 0;
  for (const year of years) {
    for (const row of race.rows) {
      const rank = row.ranks[String(year)];
      if (rank == null || rank > race.top) continue;
      const cell = cells[String(year)][rank - 1];
      expect(cell, `${year} rank ${rank}`).toContain(row.label);
      if (race.rows.filter((other: any) => other.ranks[String(year)] === rank).length > 1) {
        ties += 1;
        expect(cell, `${year} rank ${rank} tie`).toContain("(tied)");
      }
    }
  }
  // the live data has a tie (2020: India and Switzerland, both rank 8): it is listed, not dropped
  expect(ties, "a tie in the live data").toBeGreaterThan(0);
});

test("rank race: a mocked tie names both countries in one cell and marks the rank it skips", async ({ page }) => {
  const race = overview.rank_race;
  const years = yearsOf(Object.keys(race.rows[0].ranks));
  const year = String(years[years.length - 1]);
  const at = (rank: number): any => race.rows.find((row: any) => row.ranks[year] === rank);
  const [one, two, three] = [at(1), at(2), at(3)];
  await editOverview(page, (data) => {
    data.rank_race.rows.find((row: any) => row.code === two.code).ranks[year] = 1; // two countries at rank 1, none at 2
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="rank-race"]');
  await expect(card.locator(".chart-note")).toContainText("share a rank");
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const row = card.locator("tbody tr").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${year}$`) }) });
  const rankCell = (rank: number) => row.locator("td").nth(rank); // column 0 = year
  await expect(rankCell(1)).toContainText(one.label);
  await expect(rankCell(1)).toContainText(two.label);
  await expect(rankCell(1)).toContainText("(tied)");
  await expect(rankCell(2)).toHaveText("– (tie above)");
  await expect(rankCell(3)).toHaveText(three.label);
});

test("rank race: every line carries its country name, also a line that stops or starts inside the chart", async ({ page }) => {
  const race = overview.rank_race;
  const years = yearsOf(Object.keys(race.rows[0].ranks));
  await editOverview(page, (data) => {
    // a country in the top only in the middle years: no end at either side of the chart
    const ranks: Record<string, number | null> = {};
    for (const year of Object.keys(data.rank_race.rows[0].ranks)) ranks[year] = null;
    ranks[String(years[3])] = 4;
    ranks[String(years[4])] = 3;
    ranks[String(years[8])] = 5;
    data.rank_race.rows.push({ code: "MM", label: "Midland", ranks });
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="rank-race"]');
  await expect(card.locator("g.rank-point circle").first()).toBeVisible();
  // a cut label reads "United States of…United States of America" (cut text, then the full name as the title)
  const texts = (await card.locator("svg text").allTextContents()).map((text) => text.split("…")[0]).filter((text) => text.length > 0);
  const named = (label: string): boolean => texts.some((text) => label.startsWith(text)); // a long name may be cut with an ellipsis
  const plotted = [...race.rows, { label: "Midland", ranks: { [String(years[3])]: 4 } }]
    .filter((row: any) => Object.values(row.ranks).some((rank) => rank !== null && (rank as number) <= race.top));
  expect(plotted.length).toBeGreaterThan(1);
  for (const row of plotted) expect(named(row.label), `${row.label} has a text label`).toBe(true);
  // Midland has two runs (two years, then one): both are named where they stop
  await expect(card.locator("g.rank-run-label text", { hasText: "Midland" })).toHaveCount(2);
});

test("rank race: a run that starts and ends at the first year gets one name, not two", async ({ page }) => {
  const years = yearsOf(Object.keys(overview.rank_race.rows[0].ranks));
  await editOverview(page, (data) => {
    const ranks: Record<string, number | null> = {};
    for (const year of Object.keys(data.rank_race.rows[0].ranks)) ranks[year] = null;
    ranks[String(years[0])] = 4;
    data.rank_race.rows.push({ code: "DL", label: "Dawnland", ranks });
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="rank-race"]');
  await expect(card.locator("g.rank-point circle").first()).toBeVisible();
  await expect(card.locator("svg text", { hasText: "Dawnland" })).toHaveCount(1);
  await expect(card.locator("g.rank-run-label text", { hasText: "Dawnland" })).toHaveCount(0);
});

test("continent share: areas are shares that fill 100%; the hatched band is hatched; years left out are named with their reasons", async ({ page }) => {
  await page.goto("/");
  const block = overview.continent_share.origin_apps;
  const ids = Object.keys(block.continent);
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  // one area per continent plus the unallocated band, the band filled with the hatch pattern (not a colour alone)
  await expect(card.locator("g.share-area")).toHaveCount(ids.length + 1);
  expect(await card.locator("g.share-band").first().evaluate((el) => getComputedStyle(el).fill)).toMatch(/^url\(.*continent-share-hatch/);
  await expect(card.locator("pattern#continent-share-hatch")).toHaveCount(1);
  // legend names the band
  await expect(card.locator("svg")).toContainText(new RegExp(block.unallocated_label, "i"));
  // years left out = those with no band or no continent total (null reason named) or a negative band
  const years = yearsOf(Object.keys(block.unallocated));
  const omitted = years.filter((year) => block.unallocated[String(year)] === null || block.unallocated[String(year)] < 0 ||
    block.negative_years.includes(year) || ids.some((id) => block.continent[id][String(year)] === null));
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const rows = card.locator("tbody tr");
  await expect(rows).toHaveCount(years.length);
  for (const year of years) {
    const row = rows.filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${year}$`) }) });
    const lastCell = row.locator("td").last();
    if (omitted.includes(year)) {
      await expect(lastCell).toContainText("no");
      const reason = block.null_reason[String(year)];
      if (reason === "no_wipo_world_total") await expect(lastCell).toContainText("no complete WIPO world total");
      if (reason === "attribution_floor") await expect(lastCell).toContainText("attribution floor");
    } else {
      await expect(lastCell).toHaveText("yes");
      // band is never negative in a year the chart shows; the table holds the real value
      expect(block.unallocated[String(year)]).toBeGreaterThanOrEqual(0);
    }
  }
  // the notes under the chart list exactly the omitted years ("1980–1984, 1990 (reason)")
  const listed = new Set<number>();
  for (const line of await card.locator(".chart-footnote").allTextContents()) {
    const spans = /^Left out of the chart: ([^(]*)\(/.exec(line)?.[1] ?? "";
    for (const [, from, to] of spans.matchAll(/(\d{4})(?:–(\d{4}))?/g)) {
      for (let year = Number(from); year <= Number(to ?? from); year += 1) listed.add(year);
    }
  }
  expect([...listed].sort()).toEqual(omitted);
});

/** Page coordinates of a point in a Plot chart with linear axes, from the translate() of its axis tick labels; `at` is in the
 * units the tick labels print (years; percent). */
async function plotPoint(card: Locator, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return card.locator("svg").first().evaluate((svg, target) => {
    const ticks = (axis: string): { value: number; x: number; y: number }[] => [...svg.querySelectorAll(`[aria-label="${axis}-axis tick label"] text`)]
      .flatMap((node) => {
        const match = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(node.getAttribute("transform") ?? "");
        const value = parseFloat(node.textContent ?? "");
        return match && Number.isFinite(value) ? [{ value, x: Number(match[1]), y: Number(match[2]) }] : [];
      }).sort((a, b) => a.value - b.value);
    const xs = ticks("x");
    const ys = ticks("y");
    const lerp = (v: number, from: { value: number }, to: { value: number }, a: number, b: number): number =>
      a + ((v - from.value) * (b - a)) / (to.value - from.value);
    const box = svg.getBoundingClientRect();
    return {
      x: box.left + lerp(target.x, xs[0], xs[xs.length - 1], xs[0].x, xs[xs.length - 1].x),
      y: box.top + lerp(target.y, ys[0], ys[ys.length - 1], ys[0].y, ys[ys.length - 1].y),
    };
  }, at);
}

/** Subpath boxes (left, right) of the first area of a share chart, left to right: one per run of kept years. */
async function areaSegments(card: Locator): Promise<{ left: number; right: number }[]> {
  return card.locator("g.share-area").first().locator("path").evaluateAll((paths) => paths.map((path) => {
    const box = (path as SVGGraphicsElement).getBBox();
    return { left: box.x, right: box.x + box.width };
  }).sort((a, b) => a.left - b.left));
}

/** Gap check: the areas break at the left-out `years`, each gap as wide as the missing years need. */
async function expectBreaksAt(card: Locator, first: number, gaps: number[]): Promise<void> {
  const segments = await areaSegments(card);
  expect(segments).toHaveLength(gaps.length + 1);
  // pixels per year from the first segment: it runs from `first` to the year before the first gap
  const unit = (segments[0].right - segments[0].left) / (gaps[0] - 1 - first);
  for (let index = 0; index < gaps.length; index++) {
    // the segment after a gap starts one year after it; a bridged area would leave no gap here
    expect((segments[index + 1].left - segments[index].right) / unit).toBeCloseTo(2, 0);
  }
}

test("continent share: a negative band year (ints, as the pipeline writes them) and a null year are left out; the areas break there", async ({ page }) => {
  await editOverview(page, (data) => {
    const block = data.continent_share.origin_apps;
    block.unallocated["2005"] = -1234;
    block.negative_years = [2005];
    block.continent.asia["2010"] = null;
    block.null_reason["2010"] = "none_reported";
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  await expect(card.locator(".chart-footnote", { hasText: "2005" })).toContainText("unallocated band is negative");
  await expect(card.locator(".chart-footnote", { hasText: "2010" })).toContainText("no member country reported");
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const negative = card.locator("tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^2005$/ }) });
  await expect(negative).toContainText("-1,234");
  await expect(negative.locator("td").last()).toContainText("negative");
  await expect(negative.locator("td").last()).not.toHaveText("yes");
  const empty = card.locator("tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^2010$/ }) });
  await expect(empty.locator("td").last()).toContainText("no member country reported");
  // omitted from the chart: both years are gaps in every area, never bridged
  await expectBreaksAt(card, 1994, [2005, 2010]);
});

test("continent share: a band below 0 is left out even when negative_years does not list it", async ({ page }) => {
  await editOverview(page, (data) => {
    const block = data.continent_share.origin_apps;
    block.unallocated["2005"] = -50;
    block.negative_years = [];
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  await expect(card.locator(".chart-footnote", { hasText: "2005" })).toContainText("unallocated band is negative");
  await expectBreaksAt(card, 1994, [2005]);
});

test("continent share: a share is the continent's value over the world total (all continents plus the band); bands are named in text", async ({ page }) => {
  await editOverview(page, (data) => {
    // fixed figures for the last year, so the expected share does not depend on a data refresh
    const block = data.continent_share.origin_apps;
    const last = String(Math.max(...Object.keys(block.unallocated).map(Number)));
    const values: Record<string, number> = { africa: 1000, asia: 6000, europe: 2000, "latin-america-caribbean": 500, "northern-america": 1500, oceania: 250 };
    for (const [id, value] of Object.entries(values)) block.continent[id][last] = value;
    block.unallocated[last] = 750;
    delete block.null_reason[last];
  });
  await page.goto("/");
  const block = overview.continent_share.origin_apps;
  const last = Math.max(...Object.keys(block.unallocated).map(Number));
  const values: Record<string, number> = { africa: 1000, asia: 6000, europe: 2000, "latin-america-caribbean": 500, "northern-america": 1500, oceania: 250 };
  const world = Object.values(values).reduce((sum, value) => sum + value, 0) + 750; // 12 000
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  // bands in the stacking order: the layers before "asia" sit below it
  const below = values.africa / world;
  const share = values.asia / world;
  await card.scrollIntoViewIfNeeded();
  const at = await plotPoint(card, { x: last, y: (below + share / 2) * 100 });
  await page.mouse.move(at.x, at.y);
  const tip = card.locator('g[aria-label="tip"]');
  await expect(tip).toContainText(`${last}: ${(share * 100).toFixed(overview.method.rounding.decimals.share)}%`);
  await expect(tip).toContainText("Asia");
  // every band, the hatched one included, is named in text at the right edge; colour is not the only cue
  const names = await card.locator("g.share-label text").allTextContents();
  expect(names).toHaveLength(Object.keys(values).length + 1);
  for (const expected of ["Africa", "Asia", "Europe", "Oceania", new RegExp(block.unallocated_label, "i")]) {
    expect(names.some((name) => (typeof expected === "string" ? name === expected : expected.test(name)))).toBe(true);
  }
});

test("size and growth: one marker per origin with a growth rate; the others are listed under the chart", async ({ page }) => {
  await page.goto("/");
  const entries = overview.size_growth;
  const plotted = entries.filter((entry: any) => entry.cagr10 !== null);
  const unplotted = entries.filter((entry: any) => entry.cagr10 === null);
  const card = page.locator('.chart-card[data-chart="size-growth"]');
  await expect(card.locator("g.size-point > *")).toHaveCount(plotted.length);
  for (const entry of unplotted) await expect(card.locator(".chart-footnote").first()).toContainText(entry.label);
  // continents differ by shape as well as colour: more than one marker shape
  const shapes = await card.locator("g.size-point > path").evaluateAll((paths) => new Set(paths.map((path) => path.getAttribute("d"))).size);
  expect(shapes).toBeGreaterThan(1);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(card.locator("tbody tr")).toHaveCount(entries.length);
});

for (const { wide, suffix } of FONT_VARIANTS) for (const width of [390, 768, 1440]) {
  test(`size and growth at ${width}px: country names, the y axis title and the y tick labels never overlap; names stay inside the chart${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const card = page.locator('.chart-card[data-chart="size-growth"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("g.size-name text").first()).toBeVisible();
    const boxes = await card.locator("svg").first().evaluate((svg) => {
      const box = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const pick = (selector: string, kind: string) => [...svg.querySelectorAll(selector)].map((element) => ({ kind, text: element.textContent ?? "", ...box(element) }));
      return { frame: box(svg), labels: [...pick("g.size-name text", "name"), ...pick("g.size-axis-title text", "title"),
        ...pick('g[aria-label="y-axis tick label"] text', "tick")] };
    });
    const names = boxes.labels.filter((label) => label.kind === "name");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.left, name.text).toBeGreaterThanOrEqual(boxes.frame.left);
      expect(name.right, name.text).toBeLessThanOrEqual(boxes.frame.right);
    }
    const overlaps: string[] = [];
    boxes.labels.forEach((a, index) => boxes.labels.slice(index + 1).forEach((b) => {
      if (a.kind === "tick" && b.kind === "tick") return;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${a.text} / ${b.text}`);
    }));
    expect(overlaps).toEqual([]);
  });
}

test("size and growth: the not-plotted note names a zero base too; the tooltip shows growth with the pipeline's decimals", async ({ page }) => {
  await editOverview(page, (data) => {
    data.size_growth[0].cagr10 = null;
    data.size_growth[1].cagr10 = 123.4;
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="size-growth"]');
  const unplotted = overview.size_growth[0].label;
  await expect(card.locator(".chart-footnote").first()).toContainText(unplotted);
  await expect(card.locator(".chart-footnote").first()).toContainText("or a zero value then");
  // the second entry is the first plotted marker
  await card.scrollIntoViewIfNeeded();
  await card.locator("g.size-point > *").first().hover({ force: true });
  const tip = card.locator('g[aria-label="tip"]');
  await expect(tip).toContainText(overview.size_growth[1].label);
  await expect(tip).toContainText(`${(123.4).toFixed(overview.method.rounding.decimals.cagr)}% a year`);
});

test("size and growth and PCT monthly with no figure to draw show the embed's empty state, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => {
    for (const entry of data.size_growth) entry.cagr10 = null;
    for (const year of Object.keys(data.pct_monthly)) data.pct_monthly[year] = data.pct_monthly[year].map(() => null);
  });
  for (const id of ["size-growth", "pct-monthly"]) {
    await page.goto(`/embed.html?chart=${id}`);
    await expect(page.locator(".embed-problem")).toContainText("no data to draw it");
    await page.goto("/");
    await expect(page.locator('.chart-card[data-chart="rank-race"] svg').first()).toBeVisible(); // the cards are drawn
    await expect(page.locator(`.chart-card[data-chart="${id}"]`)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

const CONTINENT_NAMES_PROBLEM = "The continent names could not be loaded.";

test("continent names come from the groups data: without them each continent card stays, with the message in the card; no guessed names", async ({ page }) => {
  await page.route("**/data/groups.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.items = body.items.filter((item: any) => item.kind !== "continent");
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="rank-race"] svg').first()).toBeVisible(); // the cards are drawn
  for (const id of ["continent-share", "size-growth"]) {
    const card = page.locator(`.chart-card[data-chart="${id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.locator("h2")).not.toBeEmpty();
    await expect(card.locator(".card-problem")).toHaveText(CONTINENT_NAMES_PROBLEM);
    await expect(card.locator("svg")).toHaveCount(0);
  }
  // the page grid keeps every card (none silently missing)
  await expect(page.locator("#charts .chart-card")).toHaveCount(OVERVIEW_CHARTS.length);
});

for (const end of ["first", "last"] as const) {
  test(`continent share: a one-year run at the chart's ${end} year stays inside the plot area`, async ({ page }) => {
    const years = Object.keys(overview.continent_share.origin_apps.unallocated).sort();
    const shown = years.filter((year) => overview.continent_share.origin_apps.continent.asia[year] !== null);
    // leave out the year next to the end: the end year becomes a run of one
    const gapYear = end === "first" ? shown[1] : shown[shown.length - 2];
    await editOverview(page, (data) => {
      data.continent_share.origin_apps.continent.asia[gapYear] = null;
      data.continent_share.origin_apps.null_reason[gapYear] = "none_reported";
    });
    await page.goto("/");
    const card = page.locator('.chart-card[data-chart="continent-share"]');
    const bars = card.locator("g.share-single rect");
    await expect(bars.first()).toBeVisible();
    const { bars: boxes, plot } = await card.locator("svg").first().evaluate((svg) => {
      const grid = [...svg.querySelectorAll("g[aria-label='y-grid'] line")].map((line) => line.getBoundingClientRect());
      return {
        bars: [...svg.querySelectorAll("g.share-single rect")].map((rect) => { const box = rect.getBoundingClientRect(); return { left: box.left, right: box.right }; }),
        plot: { left: Math.min(...grid.map((box) => box.left)), right: Math.max(...grid.map((box) => box.right)) },
      };
    });
    expect(Number.isFinite(plot.left) && plot.right > plot.left, "plot frame from the y grid").toBe(true);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(plot.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(plot.right + 0.5);
      expect(box.right - box.left).toBeGreaterThan(1);
    }
  });
}

test("continent share: a kept year between two left-out years is drawn as a bar per band, not invisible", async ({ page }) => {
  await editOverview(page, (data) => {
    const block = data.continent_share.origin_apps;
    for (const year of ["2005", "2007"]) {
      block.continent.asia[year] = null;
      block.null_reason[year] = "none_reported";
    }
  });
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  const ids = Object.keys(overview.continent_share.origin_apps.continent);
  const bars = card.locator("g.share-single rect");
  await expect(bars).toHaveCount(ids.length + 1); // one per band, the hatched one included
  const boxes = await bars.evaluateAll((rects) => rects.map((node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  for (const box of boxes) expect(box.right - box.left).toBeGreaterThan(1);
  // the bars sit in one column, between the areas of the runs before 2005 and after 2007 (the gap of 2005-2007 around 2006)
  const segments = await areaSegments(card);
  expect(new Set(boxes.map((box) => Math.round(box.left))).size).toBe(1);
  const svgLeft = await card.locator("svg").first().evaluate((svg) => svg.getBoundingClientRect().left);
  const barLeft = boxes[0].left - svgLeft;
  const before = segments.filter((segment) => segment.right < barLeft).at(-1);
  const after = segments.find((segment) => segment.left > barLeft);
  expect(before, "area before the bar").toBeDefined();
  expect(after, "area after the bar").toBeDefined();
  // together the bands stack from 0 to the top of the plot
  const stackHeight = Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top));
  const plotHeight = await card.locator("g[aria-label='y-axis tick label'] text").evaluateAll((labels) => {
    const ys = labels.map((label) => label.getBoundingClientRect().top);
    return Math.max(...ys) - Math.min(...ys);
  });
  expect(stackHeight).toBeGreaterThan(plotHeight * 0.9);
});

test("size-growth without any growth rate is left out, also when the continent names are missing; the other continent card keeps its message", async ({ page }) => {
  await page.route("**/data/groups.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.items = body.items.filter((item: any) => item.kind !== "continent");
    await route.fulfill({ json: body });
  });
  await editOverview(page, (data) => { data.size_growth = []; });
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="continent-share"] .card-problem')).toHaveText(CONTINENT_NAMES_PROBLEM);
  await expect(page.locator('.chart-card[data-chart="size-growth"]')).toHaveCount(0);
  await expect(page.locator("#charts .chart-card")).toHaveCount(OVERVIEW_CHARTS.length - 1);
});

test("wallboard focus on a card with no data: the focus layout with a message, not a blank grid; rotation still runs", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { data.size_growth = []; });
  await page.goto(`/?rotate=${config.rotation.minSeconds}&theme=wallboard&chart=size-growth`);
  await expect(page.locator("html.view-ready")).toHaveCount(1);
  await expect(page.locator("html.focus-layout")).toHaveCount(1);
  const card = page.locator("main .chart-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator("h2")).not.toBeEmpty();
  await expect(card.locator(".card-problem")).toHaveText("There is no data to draw this chart.");
  await expect(page.locator(".rotation-status")).toContainText("Rotating every");
  expect(errors).toEqual([]);
});

test("embed: a known chart with no data says so, not 'Unknown chart'", async ({ page }) => {
  await editOverview(page, (data) => { data.size_growth = []; });
  await page.goto("/embed.html?chart=size-growth");
  const problem = page.locator(".embed-problem");
  await expect(problem).toContainText("No data to draw");
  await expect(problem).not.toContainText("Unknown chart");
  await expect(page.locator("svg")).toHaveCount(0);
});

test("embed: continent groups missing from the data show the same message in the card", async ({ page }) => {
  await page.route("**/data/groups.json", async (route) => {
    const body = await (await route.fetch()).json();
    body.items = body.items.filter((item: any) => item.kind !== "continent");
    await route.fulfill({ json: body });
  });
  await page.goto("/embed.html?chart=size-growth");
  await expect(page.locator(".chart-card .card-problem")).toHaveText(CONTINENT_NAMES_PROBLEM);
});

test("embed: continent cards show an error when the continent names cannot be loaded", async ({ page }) => {
  await page.route("**/data/groups.json", (route) => route.abort());
  await page.goto("/embed.html?chart=continent-share");
  await expect(page.locator(".embed-problem")).toContainText("The continent names could not be loaded.");
});

test("embed continent cards load groups.json only: no geometry, map values or group files", async ({ page }) => {
  for (const id of ["continent-share", "size-growth"]) {
    const asked: string[] = [];
    page.on("request", (request) => asked.push(new URL(request.url()).pathname));
    await page.goto(`/embed.html?chart=${id}`);
    await expect(page.locator(".chart-card svg").first()).toBeVisible();
    expect(asked.some((path) => path.endsWith("/data/groups.json")), id).toBe(true);
    expect(asked.filter((path) => /\/geo\/|\/data\/map\/|\/data\/group\//.test(path)), id).toEqual([]);
    page.removeAllListeners("request");
  }
});

test("one group file failing drops only that group: notice, map, continent cards and the picker's groups stay", async ({ page }) => {
  const africa = groupsFile.items.find((item: any) => item.id === "africa");
  await page.route("**/data/group/africa.json", (route) => route.fulfill({ status: 404, body: "missing" }));
  await page.goto("/?map=continent");
  await expect(page.locator("#notices")).toContainText(`The figures of ${africa.label} could not be loaded`);
  const mapCard = page.locator('.chart-card[data-chart="world-map"]');
  await expect(mapCard.locator("svg path[data-code]").first()).toBeVisible();
  await expect(mapCard.locator(".chart-footnote", { hasText: `The figures of ${africa.label} could not be loaded` })).toHaveCount(1);
  const member = africa.members.find((code: string) => code === "NG") ?? africa.members[0];
  await expect(mapCard.locator(`path[data-code="${member}"] title`)).toContainText("figures could not be loaded");
  for (const id of ["continent-share", "size-growth"]) {
    await expect(page.locator(`.chart-card[data-chart="${id}"] svg`).first()).toBeVisible();
  }
  const search = page.getByRole("combobox", { name: /country or office/i });
  await search.fill("Europe");
  await expect(page.getByRole("option", { name: /^Europe\b/ }).first()).toBeVisible();
  // the group's own page stands: its members, and a card saying the figures could not be loaded
  await page.goto("/?continent=africa");
  await expect(page.locator("h1")).toHaveText(africa.label);
  await expect(page.locator('.chart-card[data-chart="group-members"] .chart-figure table tbody tr')).toHaveCount(africa.members.length);
  await expect(page.locator("#notices")).toContainText(`The figures of ${africa.label} could not be loaded`);
});

test("PCT monthly: a cell per month and year; a month without a figure is hatched and in the legend, never the lowest shade", async ({ page }) => {
  await editOverview(page, (data) => { data.pct_monthly["2010"][4] = null; });
  await page.goto("/");
  const years = Object.keys(overview.pct_monthly);
  const card = page.locator('.chart-card[data-chart="pct-monthly"]');
  await expect(card.locator("g.heat-cell rect")).toHaveCount(years.length * 12);
  await expect(card.locator("g.heat-null rect")).toHaveCount(1);
  expect(await card.locator("g.heat-null").evaluate((el) => getComputedStyle(el).fill)).toMatch(/^url\(.*pct-monthly-hatch/);
  await expect(card.locator("svg")).toContainText("no data reported");
  await expect(card.locator(".chart-note")).toContainText("Recent PCT years still rise as late filings are processed.");
  await expect(card.locator(".chart-note")).not.toContainText(/darker|lighter/i);
  await expect(card.locator(".chart-note")).toContainText("see legend");
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const row = card.locator("tbody tr").filter({ has: page.locator("td:first-child", { hasText: /^2010$/ }) });
  await expect(row.locator("td").nth(5)).toHaveText("–");
});

for (const theme of ["wallboard", "atlas"]) {
  test(`PCT monthly legend (${theme}): the theme's colour scale with the lowest and highest month at its ends`, async ({ page }) => {
    await page.goto(`/?theme=${theme}`);
    const card = page.locator('.chart-card[data-chart="pct-monthly"]');
    await expect(card.locator("g.heat-cell rect").first()).toBeVisible();
    const bins = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const colours: string[] = [];
      for (let bin = 1; bin < 20; bin++) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(`--map-bin-${bin}`).trim();
        if (!value) break;
        probe.style.color = value;
        colours.push(getComputedStyle(probe).color);
      }
      probe.remove();
      return colours;
    });
    expect(bins.length).toBeGreaterThan(1);
    const swatches = await card.locator("g.heat-legend-swatch path").evaluateAll((paths) => paths.map((path) => getComputedStyle(path).fill));
    expect(swatches).toEqual(bins);
    const values = Object.values(overview.pct_monthly).flat().filter((value): value is number => value !== null);
    const legend = await card.locator("svg text").allTextContents();
    expect(legend).toContain(Math.min(...values).toLocaleString("en-US"));
    expect(legend).toContain(Math.max(...values).toLocaleString("en-US"));
    await expect(card.locator(".chart-note")).not.toContainText(/darker|lighter/i);
  });
}

test("origin cards show the note that origin Abroad is near-empty before the year in overview.json; other cards do not", async ({ page }) => {
  await page.goto("/");
  for (const id of OVERVIEW_CHARTS) {
    const note = page.locator(`.chart-card[data-chart="${id}"] .chart-footnote`, { hasText: /near-empty/ });
    if (ORIGIN_CARDS.includes(id)) await expect(note, id).toHaveText(originAbroadNote);
    else await expect(note, id).toHaveCount(0);
  }
  // the map shows it for the origin metric only
  await page.goto("/?metric=office_apps");
  await expect(page.locator('.chart-card[data-chart="world-map"] .chart-footnote', { hasText: /near-empty/ })).toHaveCount(0);
});

test("the year in the origin note is read from overview.json", async ({ page }) => {
  await editOverview(page, (data) => { data.method.origin_abroad_from = 1987; });
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="rank-race"] .chart-footnote', { hasText: /near-empty/ })).toContainText("Before 1987,");
});

test("methods page documents each overview view", async ({ page }) => {
  await page.goto("/methods.html");
  for (const name of ["Rank race", "Region share of world", "Size versus growth", "PCT monthly heat strip"]) {
    const term = page.locator("#formulas dt", { hasText: name });
    await expect(term).toHaveCount(1);
    await expect(term.locator("xpath=following-sibling::dd[1]")).not.toBeEmpty();
  }
  await expect(page.locator("#formulas dd", { hasText: "world total minus the sum" })).toHaveCount(1);
  // the continent share is by origin only: the other series' band labels are not named
  const share = page.locator("#formulas dt", { hasText: "Region share of world" }).locator("xpath=following-sibling::dd[1]");
  await expect(share).toContainText("by origin only");
  await expect(share).toContainText(overview.continent_share.origin_apps.unallocated_label);
  for (const other of ["office_apps", "pct_origin"]) await expect(share).not.toContainText(overview.continent_share[other].unallocated_label);
  await expect(page.locator("#formulas")).toContainText(`Before ${overview.method.origin_abroad_from}, `);
});

test("the new charts embed", async ({ page }) => {
  const errors = trackErrors(page);
  for (const id of ["rank-race", "continent-share", "size-growth", "pct-monthly"]) {
    await page.goto(`/embed.html?chart=${id}`);
    await expect(page.locator(`.chart-card[data-chart="${id}"] svg`).first()).toBeVisible();
  }
  // continent names are the atlas' names, not ids
  await page.goto("/embed.html?chart=continent-share");
  await expect(page.locator(".chart-card svg").first()).toContainText("Latin America and the Caribbean");
  expect(errors).toEqual([]);
});

test("series break (fixture, audit F1): the world office trend notes it includes China's break; the PCT trend does not", async ({ page }) => {
  const errors = trackErrors(page);
  const entry = fixtureBreak();
  await routeSeriesBreaks(page, [entry]);
  await page.goto("/");
  const note = page.locator('.chart-card[data-chart="world-trend"] .chart-footnote', { hasText: "Series break" });
  await expect(note).toContainText(`Includes ${entry.label}`);
  await expect(note).toHaveText(includesBreakNote(entry));
  await expect(page.locator('.chart-card[data-chart="pct-world-trend"] svg').first()).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="pct-world-trend"] .chart-footnote', { hasText: "Series break" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("series break (fixture, review I1): the continent-share card, whose Asia includes China, carries the note", async ({ page }) => {
  const errors = trackErrors(page);
  const entry = fixtureBreak();
  await routeSeriesBreaks(page, [entry]);
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="continent-share"]');
  await expect(card.locator("svg").first()).toBeVisible();
  await expect(card.locator(".chart-footnote", { hasText: "Series break" })).toHaveText(includesBreakNote(entry));
  expect(errors).toEqual([]);
});

test("overview without series_breaks (data before the refresh that adds it): no break note, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await routeSeriesBreaks(page, null);
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="world-trend"] svg').first()).toBeVisible();
  await expect(page.locator('.chart-card[data-chart="continent-share"] svg').first()).toBeVisible();
  // the share-shift card's dagger line says "series break" in lower case: only the notes are meant. Every break note starts
  // "Series break <year>:" (methods.ts seriesBreakNotes), also after "Includes <label>: "; a note without that form would slip through.
  await expect(page.getByText(/Series break \d{4}:/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const { wide, suffix } of FONT_VARIANTS) for (const width of [390, 768, 1440]) {
  test(`PCT membership map at ${width}px: no page overflow; controls, legend, notes and source line stay inside the card${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?metric=pct_member");
    const card = page.locator('.chart-card[data-chart="world-map"]');
    await expect(card.locator('path[data-bin="nonmember"]').first()).toBeVisible();
    const fit = await card.evaluate((element) => {
      const frame = element.getBoundingClientRect();
      const parts = [...element.querySelectorAll(".map-controls label, .map-legend li, .chart-note, .source-line, .map-disclaimer, .map-svg")]
        .map((part) => ({ text: (part.textContent ?? part.tagName).slice(0, 40), left: part.getBoundingClientRect().left, right: part.getBoundingClientRect().right }));
      return { left: frame.left, right: frame.right, parts,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.parts.length).toBeGreaterThan(5);
    for (const part of fit.parts) {
      expect(part.left, part.text).toBeGreaterThanOrEqual(fit.left - 1);
      expect(part.right, part.text).toBeLessThanOrEqual(fit.right + 1);
    }
  });
}
