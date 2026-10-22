import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { RESIZE_SETTLE_MS } from "./siteConstants";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// Embed page: one compact chart card for an iframe. Expected text is read from the data files and config.
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("site/config.json");
const manifest = readJson("site/data/manifest.json");
const entities: { code: string; label: string; kind: string }[] = readJson("site/data/entities.json");
const entity = (code: string) => readJson(`site/data/entity/${code}.json`);

const DISCLAIMER =
  "The Secretariat of WIPO assumes no liability or responsibility with regard to the transformation or translation of the original content.";
const IFRAME_WIDTHS = [600, 390];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** First entity whose every value is null (the no-data case, picked from data). */
function allNullCode(): string {
  const found = entities.find((ref) => Object.values(entity(ref.code).series)
    .every((block: any) => Object.values(block.types).every((years: any) => Object.values(years).every((value) => value === null))));
  if (!found) throw new Error("no all-null entity in the data");
  return found.code;
}

test("world chart in the embed theme: one svg, source line, cite link, disclaimer, no toolbar", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=world-trend&theme=embed");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "embed");
  await expect(page.locator(".chart-card")).toHaveCount(1);
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await expect(page.locator(".source-line")).toContainText(`Source: WIPO Statistics Database (release `);
  await expect(page.locator(".source-line")).toContainText(`retrieved ${manifest.retrieved}`);
  await expect(page.locator(".source-line")).toContainText("analysis: Patent Atlas");
  await expect(page.locator("button")).toHaveCount(0);
  await expect(page.locator("footer")).toContainText(DISCLAIMER);
  await expect(page.locator("header.site-header")).toHaveCount(0);
  const link = page.locator(".chart-link a");
  await expect(link).toHaveAttribute("href", /chart=world-trend/);
  await expect(link).toHaveAttribute("target", "_blank");
  expect(errors).toEqual([]);
});

test("without ?theme the embed uses the configured embed theme; an unknown theme too, quietly", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=world-trend");
  await expect(page.locator("html")).toHaveAttribute("data-theme", config.embedTheme);
  await page.goto("/embed.html?chart=world-trend&theme=neon");
  await expect(page.locator("html")).toHaveAttribute("data-theme", config.embedTheme);
  await expect(page.locator("#notices")).toBeHidden();
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("country chart: origin-apps for CH, cite link keeps chart, country and the chosen theme", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=origin-apps&country=CH&theme=wallboard");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "wallboard");
  await expect(page.locator(".chart-card")).toHaveCount(1);
  await expect(page.locator(".chart-card h2")).toHaveText(/^Patent applications by applicant's origin, \d{4}–\d{4}$/);
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await expect(page.locator(".source-line")).toContainText("retrieved");
  const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
  const query = new URL(href, "http://x/").searchParams;
  expect(new URL(href, "http://x/").pathname).not.toContain("embed.html");
  expect(Object.fromEntries(query)).toEqual({ chart: "origin-apps", country: "CH", theme: "wallboard" });
  expect(errors).toEqual([]);
});

test("the cite link carries no theme when the address names none", async ({ page }) => {
  await page.goto("/embed.html?chart=origin-apps&country=CH");
  const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
  expect(Object.fromEntries(new URL(href, "http://x/").searchParams)).toEqual({ chart: "origin-apps", country: "CH" });
});

test("an unknown ?theme is not passed on by the cite link or the home link", async ({ page }) => {
  await page.goto("/embed.html?chart=origin-apps&country=CH&theme=neon");
  await expect(page.locator("html")).toHaveAttribute("data-theme", config.embedTheme);
  const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
  expect(Object.fromEntries(new URL(href, "http://x/").searchParams)).toEqual({ chart: "origin-apps", country: "CH" });
  await page.goto("/embed.html?chart=nope&theme=neon");
  expect(new URL((await page.locator("main a").getAttribute("href")) ?? "", "http://x/").searchParams.has("theme")).toBe(false);
});

test("a baseUrl without a closing slash keeps its folder in the cite link", async ({ page, baseURL }) => {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), baseUrl: `${baseURL}/atlas-folder` } });
  });
  await page.goto("/embed.html?chart=world-trend");
  const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
  expect(new URL(href).pathname).toBe("/atlas-folder/");
  expect(new URL(href).searchParams.get("chart")).toBe("world-trend");
});

test("a data file that fails to load shows a fixed sentence, not the raw error", async ({ page }) => {
  await page.route("**/data/entity/CH.json", (route) => route.fulfill({ status: 500, body: "secret internal detail" }));
  await page.goto("/embed.html?chart=origin-apps&country=CH");
  const main = page.locator("main");
  await expect(main).toContainText("The data for CH could not be loaded.");
  await expect(main).not.toContainText(/HTTP|500|secret|Could not load/);
  await expect(page.locator("svg")).toHaveCount(0);
});

test("key-figure tiles and an office chart can be embedded", async ({ page }) => {
  await page.goto("/embed.html?chart=entity-tiles&country=CH");
  await expect(page.locator(".chart-card .tile").first()).toBeVisible();
  await page.goto("/embed.html?chart=office-apps&office=EP");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await page.goto("/embed.html?chart=office-apps&country=EP"); // regional office given as country: moved to office
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
});

test("unknown chart: message and a link to the site, theme kept, no svg", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=nope&theme=paper");
  await expect(page.locator("main")).toContainText("Unknown chart");
  await expect(page.locator("svg")).toHaveCount(0);
  const home = page.locator("main a");
  await expect(home).toHaveAttribute("href", /theme=paper/);
  expect(new URL((await home.getAttribute("href")) ?? "", "http://x/").pathname).not.toContain("embed.html");
  expect(errors).toEqual([]);
});

test("no chart given: message, not an empty page", async ({ page }) => {
  await page.goto("/embed.html");
  await expect(page.locator("main")).toContainText("No chart chosen");
  await expect(page.locator("main a")).toHaveCount(1);
});

test("a country chart without a country, or for an unknown or no-data country, says so", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=origin-apps");
  await expect(page.locator("main")).toContainText("needs a country or an office");
  await page.goto("/embed.html?chart=origin-apps&country=ZZ");
  await expect(page.locator("#notices")).toContainText("Unknown country: ZZ");
  await expect(page.locator("main")).toContainText("needs a country or an office");
  const empty = allNullCode();
  await page.goto(`/embed.html?chart=origin-apps&country=${empty}`);
  await expect(page.locator("main")).toContainText("Unknown chart for");
  await page.goto("/embed.html?chart=origin-apps&office=EP"); // office page has office-apps only
  await expect(page.locator("main")).toContainText("Unknown chart for");
  await expect(page.locator("svg")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of config.themes as string[]) {
  test(`theme ${theme}: world and country charts render without console errors`, async ({ page }) => {
    const errors = trackErrors(page);
    for (const query of [`chart=world-trend`, `chart=origin-apps&country=CH`]) {
      await page.goto(`/embed.html?${query}&theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".chart-card")).toHaveCount(1);
      await expect(page.locator(".chart-card svg").first()).toBeVisible();
      await expect(page.locator(".source-line")).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });
}

// The snippet height (config.embedHeight) is tuned for the embed theme's line charts, the kind the Embed tool
// shows first: no inner scrollbar. Rankings, key figures and the larger themes are taller (see the Task 12 report);
// in every theme nothing may overflow sideways.
const FITTING_CHARTS = ["chart=world-trend", "chart=pct-world-trend", "chart=origin-apps&country=CH", "chart=office-apps&country=CH", "chart=pct-origin&country=CH", "chart=nope"];

for (const { wide, suffix } of FONT_VARIANTS) for (const width of IFRAME_WIDTHS) {
  test(`inside an iframe ${width}px wide and embedHeight high: embed-theme line charts have no scrollbars, no theme overflows sideways${suffix}`, async ({ page, baseURL }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width: width + 40, height: config.embedHeight + 40 });
    for (const theme of config.themes as string[]) {
      for (const query of FITTING_CHARTS.concat(["chart=top-origins", "chart=entity-tiles&country=CH"])) {
        await page.setContent(`<body style="margin:0"><iframe id="f" src="${baseURL}/embed.html?${query}&theme=${theme}" ` +
          `width="${width}" height="${config.embedHeight}" style="border:0"></iframe></body>`);
        const frame = page.frameLocator("#f");
        await expect(frame.locator(".chart-card svg, .tile, .embed-problem").first()).toBeVisible();
        const measure = () => page.frames()[1].evaluate(() => {
          const root = document.documentElement;
          return { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
        });
        // settled: two successive reads, more than a resize settle period apart, agree (a pending redraw lands between)
        let last = "";
        await expect.poll(async () => {
          const now = JSON.stringify(await measure());
          const same = now === last;
          last = now;
          return same;
        }, { intervals: [2 * RESIZE_SETTLE_MS] }).toBe(true);
        if (wide) await expectWideFonts(page.frames()[1]);
        const size: Awaited<ReturnType<typeof measure>> = JSON.parse(last);
        const where = `${query} ${theme} ${width}px: ${JSON.stringify(size)}`;
        expect(size.scrollWidth, where).toBeLessThanOrEqual(size.clientWidth);
        if (theme === config.embedTheme && FITTING_CHARTS.includes(query)) {
          expect(size.scrollHeight, where).toBeLessThanOrEqual(size.clientHeight);
        }
      }
    }
  });
}

// Text laid out after the chart is drawn (a notice: unknown country) takes room too: the chart is fitted again, no scrollbar.
const NARROWEST_IFRAME = Math.min(...IFRAME_WIDTHS);
test(`inside an iframe ${NARROWEST_IFRAME}px wide and embedHeight high: a notice shown after the chart is drawn leaves no scrollbar`, async ({ page, baseURL }) => {
  const width = NARROWEST_IFRAME;
  await page.setViewportSize({ width: width + 40, height: config.embedHeight + 40 });
  await page.setContent(`<body style="margin:0"><iframe id="f" src="${baseURL}/embed.html?chart=world-trend&country=ZZ" ` +
    `width="${width}" height="${config.embedHeight}" style="border:0"></iframe></body>`);
  const frame = page.frameLocator("#f");
  await expect(frame.locator(".notice")).toContainText("ZZ");
  await expect(frame.locator(".chart-card svg").first()).toBeVisible();
  await expect.poll(() => page.frames()[1].evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight),
    { intervals: [2 * RESIZE_SETTLE_MS] }).toBeLessThanOrEqual(0);
});

test("embed wrong-kind code: the address rewrite carries the embed theme", async ({ page }) => {
  await page.goto("/embed.html?chart=office-apps&office=CH");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("theme")).toBe(config.embedTheme);
  expect(new URL(page.url()).searchParams.get("country")).toBe("CH");
});

test("embed chart=top-origins: bars equal overview.json top_origins in rank order (compact card: no table)", async ({ page }) => {
  await page.goto("/embed.html?chart=top-origins");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  const bars = await page.locator('.chart-card g[aria-label="bar"] rect').evaluateAll((rects) => rects
    .map((rect) => [Number(rect.getAttribute("y")), rect.querySelector("title")?.textContent ?? ""] as [number, string])
    .sort((a, b) => a[0] - b[0]).map(([, title]) => title));
  const top: { rank: number; label: string; value: number }[] = readJson("site/data/overview.json").top_origins;
  const ranked = [...top].sort((a, b) => a.rank - b.rank);
  expect(bars).toEqual(ranked.map((row) => `${row.label}: ${row.value.toLocaleString("en-US")}`));
  // the figure a reader sees is the text mark (same formatter as the tooltip), one label per bar
  const labels = await page.locator('.chart-card g[aria-label="text"] text').evaluateAll((nodes) => nodes
    .map((node) => [Number(node.getAttribute("y") ?? "0"), node.textContent ?? ""] as [number, string])
    .sort((a, b) => a[0] - b[0]).map(([, text]) => text));
  expect(labels).toEqual(ranked.map((row) => row.value.toLocaleString("en-US")));
});

// Every chart id the embed offers renders and its cite link keeps the params that chose the figure.
const overviewData = readJson("site/data/overview.json");
const pctYear = String(overviewData.last_year.pct_origin);
const EMBED_FIGURES = [
  "chart=world-trend", "chart=pct-world-trend", "chart=top-origins", "chart=fastest-growers",
  "chart=rank-race", "chart=continent-share", "chart=size-growth", "chart=pct-monthly",
  "chart=world-map", `chart=world-map&metric=pct_origin&map=continent&year=${pctYear}`,
  "chart=entity-tiles&country=CH", "chart=origin-apps&country=US", "chart=region-compare&country=BR",
  "chart=group-members&continent=europe", "chart=origin-apps&region=155", "chart=office-apps&continent=europe",
  "chart=pct-origin&continent=europe", "chart=world-map&region=155",
  "chart=entity-scale&country=CH", "chart=group-scale&region=155", "chart=group-scale&continent=europe",
  "chart=world-map&metric=per_million", "chart=world-map&metric=per_gdp",
  "chart=world-map&metric=women_any", "chart=world-map&metric=women_share",
  `chart=world-map&metric=women_any&map=continent&year=${overviewData.gender.last_year.women_any}`,
  "chart=women-world-trend", "chart=women-by-field", "chart=women-ranking",
  "chart=entity-women&country=CH", "chart=group-women&region=155",
];

for (const query of EMBED_FIGURES) {
  test(`embed ${query}: renders and the cite link keeps its params`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/embed.html?${query}`);
    await expect(page.locator(".chart-card")).toHaveCount(1);
    await expect(page.locator(".chart-card svg, .chart-card table, .chart-card .tile").first()).toBeVisible();
    await expect(page.locator(".source-line").first()).toBeVisible();
    const href = (await page.locator(".chart-link a").getAttribute("href")) ?? "";
    const kept = Object.fromEntries(new URL(href, "http://x/").searchParams);
    for (const [key, value] of new URLSearchParams(query)) expect(kept[key], `${key} in ${href}`).toBe(value);
    expect(errors).toEqual([]);
  });
}

// Scale figures use World Bank WDI: the embed's credit lines carry the WDI credit (names, licence, dates from the manifest).
const SCALE_EMBEDS = ["chart=entity-scale&country=CH", "chart=group-scale&region=155", "chart=world-map&metric=per_gdp"];
for (const query of SCALE_EMBEDS) {
  test(`embed ${query}: source line and WDI credit with licence and dates`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/embed.html?${query}`);
    await expect(page.locator(".chart-card")).toHaveCount(1);
    await expect(page.locator(".source-line").first()).toContainText("Source: WIPO Statistics Database (release ");
    const credit = page.locator(".chart-credit", { hasText: "World Bank WDI" });
    await expect(credit).toHaveCount(1);
    await expect(credit).toContainText("(CC BY 4.0)");
    await expect(credit).toContainText(manifest.wdi_denominators.population.name);
    await expect(credit).toContainText(manifest.wdi_denominators.gdp_ppp.name);
    await expect(credit).toContainText(`retrieved ${manifest.retrieved}, WDI last updated ${manifest.wdi_denominators.population.last_updated}`);
    await expect(page.locator("footer")).toContainText(DISCLAIMER);
    expect(errors).toEqual([]);
  });
}

// The embed fits its chart to the viewport (the host's iframe): a shorter frame refits it, nothing scrolls; a width change redraws.
test("embed fits its chart to the viewport: a height-only resize refits it, a width change redraws it", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: config.embedHeight });
  await page.goto("/embed.html?chart=world-trend");
  const chart = page.locator(".chart-figure > svg").first();
  await expect(chart).toBeVisible();
  const height = async () => (await page.locator(".chart-figure > svg").first().boundingBox())!.height;
  const tall = await height();
  await page.setViewportSize({ width: 600, height: config.embedHeight - 100 });
  await expect.poll(height).toBeLessThan(tall);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  await chart.evaluate((svg) => { (svg as any).__mark = true; });
  const marked = () => page.evaluate(() => Boolean((document.querySelector(".chart-figure > svg") as any)?.__mark));
  await page.setViewportSize({ width: 500, height: config.embedHeight - 100 });
  await expect.poll(marked).toBe(false);
});
