import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { FONT_VARIANTS, useWideFonts } from "./wideFonts";
import { openNotes } from "./notes";

// Treemap card, "Who files the world's patents?": rectangles = applications by origin (area is proportional to value),
// nested by continent. Expected counts, names and figures are read from overview.json and config.json.
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const treemap = overview.treemap;
const decimals: number = overview.method.rounding.decimals.share;

const CARD = '.chart-card[data-chart="treemap"]';
const WALLBOARD = { width: 1920, height: 1080 };
/** Body text on a rectangle: 4.5:1 (WCAG 1.4.3); the wallboard theme 7:1. */
const MIN_CONTRAST = 4.5;
const WALLBOARD_CONTRAST = 7;
/** area / value may differ from the chart-wide ratio by this share (stroke, pixel rounding aside; geometry read from attributes). */
const AREA_TOLERANCE = 0.01;
/** Rectangles under this size (px) carry no label: the area test reads the larger ones. */
const MIN_LABEL_SIZE = { width: 24, height: 14 };

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

/** Opens the treemap card on the overview (`embed`: the embed page) and returns its chart. */
async function openTreemap(page: Page, opts: { embed?: boolean; theme?: string; wide?: boolean; size?: { width: number; height: number } } = {}): Promise<Locator> {
  if (opts.wide) await useWideFonts(page);
  if (opts.size) await page.setViewportSize(opts.size);
  const theme = opts.theme ? `&theme=${opts.theme}` : "";
  await page.goto(opts.embed ? `/embed.html?chart=treemap${theme}` : `/?chart=treemap${theme}`);
  const chart = page.locator(`${CARD} svg.treemap-chart`);
  await expect(chart).toBeVisible();
  return chart;
}

/** Rectangles the data gives: one per country, one per "Other" and the not-attributable rest. */
function expectedRectangles(): number {
  const countries = treemap.continents.reduce((sum: number, continent: any) => sum + continent.countries.length + (continent.other ? 1 : 0), 0);
  return countries + (treemap.residual && treemap.residual.value > 0 ? 1 : 0);
}

const originAbroadNote = new RegExp(`Before ${overview.method.origin_abroad_from}, .*origin “Abroad” is near-empty`);

const percentText = (share: number): string => `${share.toFixed(decimals)}%`;

const SIZES = [{ width: 390, height: 900 }, { width: 1440, height: 900 }];

for (const { wide, suffix } of FONT_VARIANTS) for (const size of SIZES) {
  test(`treemap at ${size.width}px: one rectangle per country, per "Other" and the rest; area is proportional to applications${suffix}`, async ({ page }) => {
    const errors = trackErrors(page);
    const chart = await openTreemap(page, { wide, size });
    const rects = await chart.evaluate((svg) => [...svg.querySelectorAll<SVGRectElement>("rect.treemap-rect")].map((rect) => ({
      kind: rect.dataset.kind ?? "", code: rect.dataset.code ?? "", value: Number(rect.dataset.value),
      width: Number(rect.getAttribute("width")), height: Number(rect.getAttribute("height")),
    })));
    expect(rects.length).toBe(expectedRectangles());
    expect(rects.filter((rect) => rect.kind === "residual")).toHaveLength(1);
    expect(rects.filter((rect) => rect.kind === "country").map((rect) => rect.code).sort()).toEqual(
      treemap.continents.flatMap((continent: any) => continent.countries.map((country: any) => country.code)).sort());
    const total = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    const value = rects.reduce((sum, rect) => sum + rect.value, 0);
    const ratio = total / value;
    const measured = rects.filter((rect) => rect.width >= MIN_LABEL_SIZE.width && rect.height >= MIN_LABEL_SIZE.height);
    expect(measured.length).toBeGreaterThan(3);
    for (const rect of measured) {
      expect(Math.abs((rect.width * rect.height) / rect.value / ratio - 1), `${rect.kind} ${rect.code}`).toBeLessThanOrEqual(AREA_TOLERANCE);
    }
    // drawn at the card's width: no CSS scaling that would change areas unevenly
    const scale = await chart.evaluate((svg) => svg.getBoundingClientRect().width / Number(svg.getAttribute("width")));
    expect(scale).toBeCloseTo(1, 1);
    expect(errors).toEqual([]);
  });

  test(`treemap at ${size.width}px: every label fits inside its rectangle${suffix}`, async ({ page }) => {
    const chart = await openTreemap(page, { wide, size });
    const checked = await chart.evaluate((svg) => {
      const problems: string[] = [];
      const labels = [...svg.querySelectorAll<SVGTextElement>("text.treemap-label, text.treemap-continent-label")];
      for (const label of labels) {
        const rect = svg.querySelector<SVGRectElement>(`rect.treemap-rect[data-index="${label.dataset.index}"]`);
        if (!rect) { problems.push(`no rectangle for ${label.textContent}`); continue; }
        const box = label.getBBox();
        const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => Number(rect.getAttribute(name)));
        if (box.x < x - 0.5 || box.y < y - 0.5 || box.x + box.width > x + width + 0.5 || box.y + box.height > y + height + 0.5) {
          problems.push(`${label.textContent} (${box.width.toFixed(1)}x${box.height.toFixed(1)}) outside ${width.toFixed(1)}x${height.toFixed(1)}`);
        }
      }
      return { problems, labels: labels.length };
    });
    expect(checked.labels).toBeGreaterThan(2);
    expect(checked.problems).toEqual([]);
  });
}

const KEY_SIZES = [{ width: 390, height: 900 }, { width: 1440, height: 900 }];
for (const { wide, suffix } of FONT_VARIANTS) {
  for (const size of [...KEY_SIZES, WALLBOARD]) {
    const wallboard = size.width === WALLBOARD.width;
    test(`treemap key at ${size.width}x${size.height}${wallboard ? " (wallboard)" : ""}: names every continent with a rectangle, inside the chart${suffix}`, async ({ page }) => {
      const chart = await openTreemap(page, { wide, size, theme: wallboard ? "wallboard" : undefined });
      const key = await chart.evaluate((svg) => {
        const frame = svg.getBoundingClientRect();
        return [...svg.querySelectorAll<SVGGElement>("g.treemap-key-item")].map((item) => {
          const box = item.getBoundingClientRect();
          return { id: item.dataset.continent ?? "", text: (item.textContent ?? "").trim(), inside: box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.bottom <= frame.bottom + 1 };
        });
      });
      for (const continent of treemap.continents.filter((entry: any) => entry.countries.length > 0 || entry.other)) {
        expect(key.find((item) => item.id === continent.id)?.text, continent.id).toBe(continent.label);
      }
      expect(key.find((item) => item.id === "residual")?.text).toBe(treemap.residual.label);
      expect(key.filter((item) => !item.inside)).toEqual([]);
    });
  }
}

test("treemap: a continent folded into one rectangle is labelled with the continent's name, not \"Other\"", async ({ page }) => {
  const folded = treemap.continents.filter((continent: any) => continent.countries.length === 0 && continent.other);
  expect(folded.length).toBeGreaterThan(0);
  const chart = await openTreemap(page, { size: WALLBOARD, theme: "wallboard" });
  for (const continent of folded) {
    const rect = chart.locator(`rect.treemap-rect[data-continent="${continent.id}"]`);
    await expect(rect).toHaveCount(1);
    await expect(rect.locator("title")).toContainText(continent.label);
    const label = chart.locator(`text.treemap-label[data-continent="${continent.id}"]`);
    // a label is drawn only where measured text fits; when drawn it names the continent
    if (await label.count() > 0) await expect(label).toContainText(continent.label);
  }
  // a rectangle too small for text keeps its name in the title and in the key (always shown)
  for (const continent of folded) await expect(chart.locator(`g.treemap-key-item[data-continent="${continent.id}"]`)).toContainText(continent.label);
});

test("treemap: every rectangle has a title with its name and share", async ({ page }) => {
  const chart = await openTreemap(page);
  const titles = await chart.locator("rect.treemap-rect > title").allTextContents();
  expect(titles.length).toBe(expectedRectangles());
  const usa = treemap.continents.flatMap((continent: any) => continent.countries).find((country: any) => country.code === "US");
  expect(titles).toContain(`${usa.label}: ${usa.value.toLocaleString("en-US")} applications, ${percentText(usa.share)}`);
  expect(titles).toContain(`${treemap.residual.label}: ${treemap.residual.value.toLocaleString("en-US")} applications, ${percentText(treemap.residual.share)}`);
});

test("treemap: the rest is hatched with its own pattern, defined once in the treemap svg and named with the data's label", async ({ page }) => {
  const chart = await openTreemap(page);
  await expect(chart.locator("pattern#treemap-hatch")).toHaveCount(1);
  const residual = chart.locator('rect.treemap-rect[data-kind="residual"]');
  await expect(residual).toHaveCount(1);
  await expect(residual).toHaveCSS("fill", /url\(.*#treemap-hatch.*\)/);
  await expect(residual.locator("title")).toContainText(treemap.residual.label);
  // the id is unique in the page (the continent-share card keeps its own pattern)
  expect(await page.evaluate(() => document.querySelectorAll('[id="treemap-hatch"]').length)).toBe(1);
  expect(await page.evaluate(() => document.querySelectorAll('[id="continent-share-hatch"]').length)).toBe(1);
  await expect(page.locator(".chart-card svg pattern[id]")).not.toHaveCount(0);
  const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.id));
  expect(ids.length).toBe(new Set(ids).size);
});

for (const theme of config.themes as string[]) {
  test(`treemap labels in theme ${theme}: label colour against its rectangle is at least ${theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST}:1`, async ({ page }) => {
    const chart = await openTreemap(page, { theme, size: theme === "wallboard" ? WALLBOARD : { width: 1440, height: 900 } });
    const need = theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST;
    const ratios = await chart.evaluate((svg) => {
      const channels = (colour: string): number[] => (/rgba?\(([^)]+)\)/.exec(colour)?.[1] ?? "").split(",").slice(0, 3).map(Number);
      const luminance = (colour: string): number => {
        const [r, g, b] = channels(colour).map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return [...svg.querySelectorAll<SVGTextElement>("text.treemap-label, text.treemap-continent-label")].map((label) => {
        // a label on the hatched rest sits on its solid plate
        const ground = svg.querySelector(`rect.treemap-plate[data-index="${label.dataset.index}"]`)
          ?? svg.querySelector(`rect.treemap-rect[data-index="${label.dataset.index}"]`);
        const high = Math.max(luminance(getComputedStyle(label).fill), luminance(getComputedStyle(ground as Element).fill));
        const low = Math.min(luminance(getComputedStyle(label).fill), luminance(getComputedStyle(ground as Element).fill));
        return { text: label.textContent ?? "", ratio: (high + 0.05) / (low + 0.05) };
      });
    });
    expect(ratios.length).toBeGreaterThan(2);
    expect(ratios.filter((entry) => entry.ratio < need)).toEqual([]);
  });
}

test("treemap figures table equals overview.treemap: country, \"Other\", rest and unattributed rows", async ({ page }) => {
  await page.goto("/?chart=treemap");
  const card = page.locator(CARD);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  const headers = await card.locator("thead th").allTextContents();
  expect(headers).toEqual(["Continent", "Origin", "Applications", `Share of ${overview.share_denominator.origin_apps}`]);
  const rows = (await card.locator("tbody tr").all()).length;
  const cells = await card.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
  const expected: string[][] = [];
  for (const continent of treemap.continents) {
    for (const country of continent.countries) {
      expected.push([continent.label, country.label, country.value.toLocaleString("en-US"), percentText(country.share)]);
    }
    if (continent.other) {
      expected.push([continent.label, `Other ${continent.label}`, continent.other.value.toLocaleString("en-US"), percentText(continent.other.share)]);
    }
  }
  expected.push(["–", treemap.residual.label, treemap.residual.value.toLocaleString("en-US"), percentText(treemap.residual.share)]);
  for (const row of treemap.unattributed) {
    expected.push(["–", `${row.label} (counted in “${treemap.residual.label}”)`, row.value.toLocaleString("en-US"), percentText(row.share)]);
  }
  expect(rows).toBe(expected.length);
  expect(cells).toEqual(expected);
});

test("treemap card: title, fold rule, listed origins without a value (code lists in the notes), WIPO's total as denominator", async ({ page }) => {
  await page.goto("/?chart=treemap");
  const card = page.locator(CARD);
  await expect(card.locator("h2")).toHaveText(`Who files the world's patents? Applications by origin, ${treemap.year}`);
  await openNotes(card);
  const notes = card.locator(".chart-footnote");
  await expect(notes.filter({ hasText: "folded" })).toContainText(`${overview.method.treemap.fold_share_pct}%`);
  const noValue = notes.filter({ hasText: "no value" });
  for (const origin of treemap.no_value) await expect(noValue).toContainText(origin.label);
  for (const continent of treemap.continents.filter((entry: any) => entry.other)) {
    const line = notes.filter({ hasText: `Other ${continent.label}:` });
    await expect(line).toContainText(continent.other.codes.join(", "));
  }
  await expect(notes.filter({ hasText: "near-empty" })).toHaveText(originAbroadNote);
});

for (const { wide, suffix } of FONT_VARIANTS) {
  test(`treemap in the embed at 390px: the long list of origins without a value wraps inside the card, no horizontal scroll${suffix}`, async ({ page }) => {
    await openTreemap(page, { embed: true, wide, size: { width: 390, height: 900 } });
    const noValue = page.locator(`${CARD} .chart-footnote`, { hasText: "no value" });
    await expect(noValue).toBeVisible();
    const fit = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    expect(fit.overflow).toBeLessThanOrEqual(0);
    const box = await noValue.boundingBox();
    const card = await page.locator(CARD).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(card!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
    expect(box!.height).toBeGreaterThan(40); // wrapped onto several lines
  });
}

test("treemap card: reason from the data (null_reason) replaces the chart; no error", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => {
    data.treemap = { ...data.treemap, null_reason: "attribution_floor", continents: [], residual: null, unattributed: [], no_value: [] };
  });
  await page.goto("/");
  const card = page.locator(CARD);
  await expect(card).toHaveCount(1);
  await expect(card.locator("svg")).toHaveCount(0);
  await expect(card).toContainText("below the attribution floor");
  await expect(card.locator("h2")).toContainText("Who files the world's patents?");
  expect(errors).toEqual([]);
});

test("treemap card: no treemap in the data (older data) leaves the card out; no error", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { delete data.treemap; });
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="world-trend"]')).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("treemap card: a negative rest is never drawn; the card says so", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { data.treemap.residual.value = -5; data.treemap.residual.share = -0.01; });
  await page.goto("/");
  const card = page.locator(CARD);
  await expect(card).toHaveCount(1);
  await expect(card.locator("svg")).toHaveCount(0);
  await expect(card).toContainText("negative");
  expect(errors).toEqual([]);
});
