import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";
import { fixedHalfAway } from "../../site/src/format";

// Dashboard (`?view=dashboard`): four key-figure tiles, a carousel stage (one wallboard slide, full card), the world map,
// the treemap and the share-shift card. Every expected figure is read from overview.json, every id and setting from
// config.json or the site source.
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const dashboardSource = readFileSync("site/src/dashboard.ts", "utf8");
const TILE_IDS: string[] = JSON.parse(/^export const DASHBOARD_TILE_IDS = (\[[^\]]+\]);/m.exec(dashboardSource)![1]);
const CAROUSEL_PREFIX = /^export const CAROUSEL_PREFIX = "([^"]+)";/m.exec(readFileSync("site/src/carousel.ts", "utf8"))![1];
const PCT_LATE_FILINGS = /^export const PCT_LATE_FILINGS = "([^"]+)";/m.exec(readFileSync("site/src/methods.ts", "utf8"))![1];
const MIN_CHART_HEIGHT_EM = Number(/^const MIN_CHART_HEIGHT_EM = (\d+);/m.exec(readFileSync("site/src/charts.ts", "utf8"))![1]);
const methodsSource = readFileSync("site/src/methods.ts", "utf8");
const SERIES_TITLE: Record<string, string> = Object.fromEntries(["origin_apps", "office_apps"].map((id) =>
  [id, new RegExp(`^  ${id}: "([^"]+)",`, "m").exec(methodsSource)![1]]));
const mapValues: Record<string, any> = Object.fromEntries(["origin_apps", "office_apps"].map((id) =>
  [id, JSON.parse(readFileSync(`site/data/map/${id}.json`, "utf8"))]));
const { minSeconds } = config.rotation;
const decimals = overview.method.rounding.decimals;

const DASHBOARD = "/?view=dashboard";
const STAGE = ".dashboard-stage";
const tile = (page: Page, id: string): Locator => page.locator(`.dashboard-tile > .chart-card[data-chart="${id}"]`);
/** The overview chart each key-figure tile links to (spec 2a: tiles link to the full charts). */
const KEY_LINKS: Record<string, string> = {
  "key-world-patents": "world-trend", "key-world-pct": "pct-world-trend", "key-top-origin": "top-origins", "key-top-grower": "size-growth",
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function editOverview(page: Page, edit: (data: any) => void): Promise<void> {
  await page.route("**/data/overview.json", async (route) => {
    const body = await (await route.fetch()).json();
    edit(body);
    await route.fulfill({ json: body });
  });
}

/** Opens the dashboard and waits until every tile and the carousel slide have drawn. */
async function openDashboard(page: Page, search = ""): Promise<void> {
  await page.goto(`${DASHBOARD}${search}`);
  await expect(page.locator(`${STAGE} .chart-card`)).toHaveCount(1);
  await expect(page.locator(`${STAGE} .chart-figure > svg`)).toBeVisible();
  await expect(tile(page, "world-map").locator(".map-svg")).toBeVisible();
  await expect(tile(page, "treemap").locator("svg.treemap-chart")).toBeVisible();
  await expect(tile(page, "share-shift").locator(".chart-figure svg").first()).toBeVisible();
}

const signed = (value: number, places: number): string => `${value > 0 ? "+" : ""}${fixedHalfAway(value, places)}%`;

test("?view=dashboard renders the 7 tiles and the carousel stage", async ({ page }) => {
  const errors = trackErrors(page);
  await openDashboard(page);
  expect(TILE_IDS.length).toBe(7);
  const drawn = await page.locator(".dashboard-tile > .chart-card").evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.chart));
  expect([...drawn].sort()).toEqual([...TILE_IDS].sort());
  // the stage shows the first configured slide, prefixed ids, chart id kept in data-chart
  const first = config.wallboard.slides.find((slide: any) => slide.id === config.dashboard.slides[0]);
  const chart = new URLSearchParams(first.params).get("chart");
  const slide = page.locator(`${STAGE} .chart-card`);
  await expect(slide).toHaveAttribute("data-chart", chart!);
  await expect(slide).toHaveAttribute("id", `${CAROUSEL_PREFIX}${chart}`);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("body")).toContainText("WIPO Statistics Database");
  expect(errors).toEqual([]);
});

test("key figures equal overview.json: value, change, year in the label; PCT carries the late-filings note", async ({ page }) => {
  await openDashboard(page);
  for (const [id, world] of [["key-world-patents", "world_office"], ["key-world-pct", "pct_world"]]) {
    const card = tile(page, id);
    const year = overview.world_last_year[world];
    const value = overview[world][String(year)];
    const change = overview.world_yoy[world].yoy[String(year)];
    await expect(card.locator('[data-figure="value"] .tile-value')).toHaveText(value.toLocaleString("en-US"));
    await expect(card.locator('[data-figure="value"] .tile-label')).toContainText(String(year));
    await expect(card.locator('[data-figure="change"] .tile-value')).toHaveText(signed(change, decimals.yoy));
    await expect(card.locator('[data-figure="change"] .tile-label')).toContainText(`${year - 1}`);
    await expect(card.locator("h2")).toContainText(String(year));
    await expect(card.locator(".source-line")).toContainText("WIPO Statistics Database");
  }
  await expect(tile(page, "key-world-pct")).toContainText(PCT_LATE_FILINGS);
  await expect(tile(page, "key-world-patents")).not.toContainText(PCT_LATE_FILINGS);
  const top = [...overview.top_origins].sort((a: any, b: any) => a.rank - b.rank)[0];
  const origin = tile(page, "key-top-origin");
  await expect(origin.locator('[data-figure="origin"] .tile-value')).toHaveText(top.label);
  await expect(origin.locator('[data-figure="value"] .tile-value')).toHaveText(top.value.toLocaleString("en-US"));
  await expect(origin.locator('[data-figure="share"] .tile-value')).toHaveText(`${fixedHalfAway(top.share, decimals.share)}%`);
  await expect(origin.locator('[data-figure="share"] .tile-label')).toContainText(String(overview.top_year));
});

test("key figures: a null change shows – with its reason (series break), never 0", async ({ page }) => {
  const year = overview.world_last_year.world_office;
  await editOverview(page, (data) => {
    data.world_yoy.world_office.yoy[String(year)] = null;
    data.world_yoy.world_office.yoy_null_reason[String(year)] = "series_break";
  });
  await openDashboard(page);
  const change = tile(page, "key-world-patents").locator('[data-figure="change"]');
  await expect(change.locator(".tile-value")).toHaveText("–");
  await expect(change.locator(".tile-reason")).toContainText("series break");
});

test("key figures: world_yoy and top_grower absent (older data): their figures read –, the page draws", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { delete data.world_yoy; data.top_grower = null; });
  await openDashboard(page);
  await expect(tile(page, "key-world-patents").locator('[data-figure="change"] .tile-value')).toHaveText("–");
  await expect(tile(page, "key-world-patents").locator('[data-figure="change"] .tile-reason')).not.toBeEmpty();
  await expect(tile(page, "key-top-grower").locator('[data-figure="origin"] .tile-value')).toHaveText("–");
  await expect(tile(page, "key-top-grower").locator(".tile-reason")).not.toBeEmpty();
  await expect(page.locator(".chart-card--problem")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("key figures: world_yoy without the PCT world: its change reads – with a reason, the page draws", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { delete data.world_yoy.pct_world; });
  await openDashboard(page);
  const change = tile(page, "key-world-pct").locator('[data-figure="change"]');
  await expect(change.locator(".tile-value")).toHaveText("–");
  await expect(change.locator(".tile-reason")).not.toBeEmpty();
  await expect(tile(page, "key-world-patents").locator('[data-figure="change"] .tile-value'))
    .toHaveText(signed(overview.world_yoy.world_office.yoy[String(overview.world_last_year.world_office)], decimals.yoy));
  await expect(page.locator(".chart-card--problem")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("fastest-grower tile = top_grower; its label names the top_n and the growth window", async ({ page }) => {
  await openDashboard(page);
  const grower = overview.top_grower;
  const card = tile(page, "key-top-grower");
  const period = `${overview.top_year - overview.method.cagr_years}–${overview.top_year}`;
  await expect(card.locator("h2")).toContainText(`among the top ${overview.top_n} origins`);
  await expect(card.locator("h2")).toContainText(period);
  await expect(card.locator('[data-figure="origin"] .tile-value')).toHaveText(grower.label);
  await expect(card.locator('[data-figure="growth"] .tile-value')).toHaveText(signed(grower.cagr10, decimals.cagr));
  await expect(card.locator('[data-figure="growth"] .tile-label')).toContainText(period);
  await expect(card.locator('[data-figure="value"] .tile-value')).toHaveText(grower.value.toLocaleString("en-US"));
  await expect(card.locator(".chart-footnote")).toHaveCount(grower.breaks.length);
});

test("fastest-grower tile: a break inside the growth window gets a footnote", async ({ page }) => {
  const year = overview.top_year - 2;
  await editOverview(page, (data) => { data.top_grower.breaks = [year]; });
  await openDashboard(page);
  const card = tile(page, "key-top-grower");
  await card.locator("details.card-details > summary").click();
  await expect(card.locator(".chart-footnote")).toHaveCount(1);
  await expect(card.locator(".chart-footnote")).toContainText(`Series break ${year}`);
});

test("each tile and the carousel card: Show figures, Cite, and an overview link in the same tab", async ({ page }) => {
  await openDashboard(page);
  const first = config.wallboard.slides.find((slide: any) => slide.id === config.dashboard.slides[0]);
  const cards: [Locator, string][] = [
    ...TILE_IDS.map((id): [Locator, string] => [tile(page, id), KEY_LINKS[id] ?? id]),
    [page.locator(`${STAGE} .chart-card`), new URLSearchParams(first.params).get("chart")!],
  ];
  for (const [card, chart] of cards) {
    await expect(card.getByRole("button", { name: "Show figures", exact: true })).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Cite this", exact: true })).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Embed", exact: true })).toHaveCount(1);
    const link = card.locator("p.chart-link > a");
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute("target")).toBeNull();
    const href = new URL((await link.getAttribute("href"))!, page.url());
    expect(href.pathname).toBe("/");
    expect(href.searchParams.get("chart")).toBe(chart);
    expect(href.searchParams.get("view")).toBeNull();
  }
  // the link keeps the theme
  await openDashboard(page, "&theme=paper");
  const link = tile(page, "key-world-patents").locator("p.chart-link > a");
  expect(new URL((await link.getAttribute("href"))!, page.url()).searchParams.get("theme")).toBe("paper");
});

async function idProblems(page: Page): Promise<{ duplicates: string[]; unresolved: string[] }> {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const unresolved: string[] = [];
    for (const attribute of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) unresolved.push(`${attribute}=${id}`);
        }
      }
    }
    return { duplicates, unresolved };
  });
}

test("dashboard: no duplicate ids; every aria-controls and aria-labelledby resolves", async ({ page }) => {
  await openDashboard(page);
  expect(await idProblems(page)).toEqual({ duplicates: [], unresolved: [] });
  // the carousel's ids carry its prefix, and its aria refs stay inside the stage
  const stage = await page.locator(STAGE).evaluate((element, prefix) => {
    const ids = [...element.querySelectorAll("[id]")].map((node) => node.id);
    const unprefixed = ids.filter((id) => !id.startsWith(prefix));
    const outside: string[] = [];
    for (const attribute of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
      for (const node of element.querySelectorAll(`[${attribute}]`)) {
        for (const id of (node.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
          if (!element.querySelector(`[id="${id}"]`)) outside.push(`${attribute}=${id}`);
        }
      }
    }
    return { count: ids.length, unprefixed, outside };
  }, CAROUSEL_PREFIX);
  expect(stage.count).toBeGreaterThan(1);
  expect(stage.unprefixed).toEqual([]);
  expect(stage.outside).toEqual([]);
});

/** A map card's state checks: heading names the measure and year; Canada's tooltip and figures row hold
 * map/<measure>.json's value for that year. */
async function expectMapShows(page: Page, card: Locator, metric: string, year: number): Promise<void> {
  const value = (mapValues[metric].values.CA[String(year)] as number).toLocaleString("en-US");
  await expect(card.locator("h2")).toContainText(`${SERIES_TITLE[metric]}, ${year}`);
  await expect(card.locator('[data-code="CA"] title').first()).toHaveText(`Canada: ${value} (${year})`);
  const table = card.locator(".data-table").first();
  await expect(table.locator("th").filter({ hasText: `Applications, ${year}` })).toHaveCount(1);
  await expect(table.locator("tr", { has: page.locator("td", { hasText: /^CA$/ }) })).toContainText(value);
}

test("map tile stays live: a year or measure change redraws its heading, tooltips and figures from map/<measure>.json", async ({ page }) => {
  await openDashboard(page);
  const card = tile(page, "world-map");
  const slider = card.locator('input[type="range"]');
  const start = Number(await slider.inputValue());
  const steps = 5;
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await slider.focus();
  for (let step = 0; step < steps; step += 1) await page.keyboard.press("ArrowLeft");
  await expectMapShows(page, card, "origin_apps", start - steps);
  await card.locator("select").nth(1).selectOption("office_apps");
  await expectMapShows(page, card, "office_apps", Number(await slider.inputValue()));
});

for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`dashboard opens at the top at ${size.width}x${size.height}: the carousel slide does not scroll the page`, async ({ page }) => {
    await page.setViewportSize(size);
    await openDashboard(page);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });
}

test("treemap tile: its hatch pattern id is unique and its rest references the pattern in its own svg", async ({ page }) => {
  await openDashboard(page);
  const chart = tile(page, "treemap").locator("svg.treemap-chart");
  const pattern = await chart.locator("pattern").getAttribute("id");
  expect(pattern).toBeTruthy();
  expect(await page.evaluate((id) => document.querySelectorAll(`[id="${id}"]`).length, pattern)).toBe(1);
  const residual = chart.locator('rect.treemap-rect[data-kind="residual"]');
  await expect(residual).toHaveAttribute("fill", `url(#${pattern})`);
  await expect(residual).toHaveCSS("fill", new RegExp(`url\\(.*#${pattern}.*\\)`));
  await expect(chart.locator(".treemap-swatch.treemap-residual")).toHaveAttribute("fill", `url(#${pattern})`);
});

test("config: dashboard.slides are wallboard slide ids; no slide's chart is a tile's chart", () => {
  const slides = config.wallboard.slides;
  expect(config.dashboard.slides.length).toBeGreaterThan(0);
  expect(Number.isInteger(config.dashboard.seconds) && config.dashboard.seconds >= minSeconds).toBe(true);
  for (const id of config.dashboard.slides) {
    const slide = slides.find((entry: any) => entry.id === id);
    expect(slide, id).toBeDefined();
    expect(TILE_IDS, id).not.toContain(new URLSearchParams(slide.params).get("chart"));
  }
});

test("?view=dashboard&rotate=<minSeconds>: stays on the dashboard over 2 intervals, no office rotation", async ({ page }) => {
  await page.clock.install();
  await openDashboard(page, `&rotate=${minSeconds}`);
  const before = page.url();
  await page.clock.runFor(minSeconds * 1000 * 2 + 1000);
  expect(page.url()).toBe(before);
  await expect(page.locator(".rotation-status")).toHaveCount(0);
  await expect(page.locator(`${STAGE} .chart-card`)).toHaveCount(1);
  await expect(page.locator("#notices")).not.toContainText("rotate");
});

test("?view=dashboard: an invalid rotate is a notice, the carousel stays paused", async ({ page }) => {
  await openDashboard(page, `&rotate=${minSeconds - 1}`);
  await expect(page.locator("#notices")).toContainText(
    `Invalid rotate: ${minSeconds - 1} (whole seconds, at least ${minSeconds}): the carousel stays paused`);
  await expect(page.locator(".rotation-status")).toHaveCount(0);
});

test("header nav: Dashboard is current on the dashboard, Overview is not; footer link on every page; theme kept", async ({ page }) => {
  await openDashboard(page, "&theme=paper");
  const nav = page.locator(".site-nav");
  await expect(nav.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
  expect(await nav.getByRole("link", { name: "Overview", exact: true }).getAttribute("aria-current")).toBeNull();
  for (const path of ["/?theme=paper", "/methods.html?theme=paper", "/about.html?theme=paper", "/?view=releases&theme=paper", `${DASHBOARD}&theme=paper`, "/?country=CH&theme=paper"]) {
    await page.goto(path);
    for (const link of [page.locator(".site-nav").getByRole("link", { name: "Dashboard", exact: true }),
      page.locator(".footer-links").getByRole("link", { name: "Dashboard", exact: true })]) {
      await expect(link, path).toHaveCount(1);
      const href = new URL((await link.getAttribute("href"))!, page.url());
      expect(href.searchParams.get("view"), path).toBe("dashboard");
      expect(href.searchParams.get("theme"), path).toBe("paper");
    }
  }
  await page.goto("/");
  await expect(page.locator(".site-nav").getByRole("link", { name: "Dashboard", exact: true })).not.toHaveAttribute("aria-current", "page");
});

/** Page-level box checks: no horizontal page scroll; each card inside its tile with no part sticking out sideways. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) problems.push(`page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`);
    for (const card of document.querySelectorAll<HTMLElement>(".dashboard .chart-card")) {
      const frame = card.getBoundingClientRect();
      const holder = (card.closest(".dashboard-tile, .dashboard-stage") as HTMLElement).getBoundingClientRect();
      const name = card.id;
      if (frame.left < holder.left - 1 || frame.right > holder.right + 1) problems.push(`${name} wider than its tile`);
      for (const part of card.querySelectorAll<Element>("h2, p, svg, .tile, .chart-toolbar, summary, .map-controls")) {
        const box = part.getBoundingClientRect();
        if (box.width === 0) continue;
        if (box.left < frame.left - 1 || box.right > frame.right + 1) problems.push(`${name}: ${part.tagName}.${part.getAttribute("class") ?? ""} outside the card`);
      }
    }
    return problems;
  });
}

/** The stage's box and the slide's: the slide fits when it does not overflow the stage. */
async function stageFit(page: Page): Promise<{ height: number; fits: boolean; chart: number; minChart: number }> {
  return page.locator(STAGE).evaluate((stage, em) => {
    const card = stage.querySelector(".chart-card") as HTMLElement;
    const svg = card.querySelector(".chart-figure > svg") as SVGElement;
    const font = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chart-font-size"));
    const fits = stage.scrollHeight <= stage.clientHeight + 1 && card.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 1;
    return { height: stage.getBoundingClientRect().height, fits, chart: svg.getBoundingClientRect().height, minChart: font * em };
  }, MIN_CHART_HEIGHT_EM);
}

// 900: one column above the phone breakpoint (the stage alone in its row)
for (const { wide, suffix } of FONT_VARIANTS) for (const size of [{ width: 390, height: 844 }, { width: 900, height: 1000 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  test(`dashboard fits at ${size.width}x${size.height}: no page sideways scroll, cards inside their tiles, slide fits its stage${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    await openDashboard(page);
    if (wide) await expectWideFonts(page);
    await page.waitForTimeout(400); // resize settle (the fit redraws after it)
    expect(await layoutProblems(page)).toEqual([]);
    const fit = await stageFit(page);
    expect(fit.fits).toBe(true);
    expect(fit.chart).toBeGreaterThanOrEqual(fit.minChart - 1);
    await expect(page.locator(".chart-card--problem")).toHaveCount(0);
    if (size.width === 1440) { // stage and map side by side: the stage fills its row, no blank under the slide
      const [stage, map] = await Promise.all([page.locator(STAGE), page.locator('.dashboard-tile:has(> .chart-card[data-chart="world-map"])')]
        .map((locator) => locator.evaluate((element) => element.getBoundingClientRect().bottom)));
      expect(Math.abs(stage - map)).toBeLessThanOrEqual(1);
    }
  });
}

for (const { wide, suffix } of FONT_VARIANTS) for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`carousel slide at ${size.width}x${size.height}: an open panel or details grows the stage, reachable; closed, the stage is back${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    await openDashboard(page);
    await page.waitForTimeout(400);
    const closed = await stageFit(page);
    const besideMap = await page.locator(STAGE).evaluate((stage) => {
      const map = document.querySelector('.dashboard-tile:has(> .chart-card[data-chart="world-map"])') as HTMLElement;
      return Math.abs(stage.getBoundingClientRect().top - map.getBoundingClientRect().top) <= 1;
    });
    const card = page.locator(`${STAGE} .chart-card`);
    const openers: [string, Locator, Locator][] = [
      ...["Show figures", "Cite this", "Embed"].map((name, index): [string, Locator, Locator] =>
        [name, card.locator(".tool-button").nth(index), card.locator(".chart-panel").nth(index)]),
      ["details", card.locator("details.card-details > summary"), card.locator("details.card-details")],
    ];
    for (const [name, opener, panel] of openers) {
      await opener.click();
      await expect(panel, name).toBeVisible();
      await page.waitForTimeout(400);
      const open = await stageFit(page);
      expect(open.fits, `${name}: stage holds the open panel`).toBe(true);
      // alone in its row (phone): a fixed-height stage, so it grows; beside the map it has the row's height, and a panel
      // that fits in it needs no growth: never smaller, and it holds the panel (fits, above)
      if (!besideMap) expect(open.height, `${name}: stage grew`).toBeGreaterThan(closed.height);
      else expect(open.height, `${name}: stage kept or grew`).toBeGreaterThanOrEqual(closed.height - 1);
      expect(open.chart, name).toBeGreaterThanOrEqual(open.minChart - 1);
      const reach = await panel.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { bottom: box.bottom + scrollY, page: document.documentElement.scrollHeight };
      });
      expect(reach.bottom, `${name}: panel reachable`).toBeLessThanOrEqual(reach.page + 1);
      const panelInStage = await panel.evaluate((element, stageSelector) => {
        const stage = document.querySelector(stageSelector) as HTMLElement;
        return element.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 1;
      }, STAGE);
      expect(panelInStage, `${name}: open panel inside the stage`).toBe(true);
      expect(await layoutProblems(page), name).toEqual([]);
      await opener.click(); // closes it
      await page.waitForTimeout(400);
      const after = await stageFit(page);
      expect(Math.abs(after.height - closed.height), `${name}: stage back to its height`).toBeLessThanOrEqual(1);
      expect(after.fits, name).toBe(true);
    }
  });
}

for (const path of [DASHBOARD, "/"]) {
  test(`${path} at 320px with wide fonts: the footer links wrap, no page sideways scroll`, async ({ page }) => {
    await useWideFonts(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(path);
    await expect(page.locator(".footer-links a").first()).toBeVisible();
    await expect(page.locator(".chart-card").first()).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("embed.html?chart=key-world-patents draws the key-figure card", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=key-world-patents");
  const card = page.locator('.chart-card[data-chart="key-world-patents"]');
  const year = overview.world_last_year.world_office;
  await expect(card.locator('[data-figure="value"] .tile-value')).toHaveText(overview.world_office[String(year)].toLocaleString("en-US"));
  await expect(page.locator(".embed-problem")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dashboard: every request is same-origin", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openDashboard(page);
  const origin = new URL(page.url()).origin;
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});
