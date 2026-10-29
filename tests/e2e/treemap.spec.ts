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
/** Rectangles at least this size (px) must show most of their fill, whatever the strokes (band outline, rectangle stroke). */
const MIN_FILL_SIZE = { width: 24, height: 14 };
const MIN_VISIBLE_FILL = 0.8;

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

/** The value overview.json gives the rectangle: a country by code, an "Other" by continent, the rest. */
function expectedValue(kind: string, code: string, continentId: string): number | undefined {
  if (kind === "residual") return treemap.residual.value;
  const continent = treemap.continents.find((entry: any) => entry.id === continentId);
  if (kind === "other") return continent?.other?.value;
  return continent?.countries.find((country: any) => country.code === code)?.value;
}

const originAbroadNote = new RegExp(`Before ${overview.method.origin_abroad_from}, .*origin “Abroad” is near-empty`);

const percentText = (share: number): string => `${share.toFixed(decimals)}%`;

const SIZES = [{ width: 390, height: 900 }, { width: 1440, height: 900 }];

for (const { wide, suffix } of FONT_VARIANTS) for (const size of SIZES) {
  test(`treemap at ${size.width}px: one rectangle per country, per "Other" and the rest; area is proportional to applications${suffix}`, async ({ page }) => {
    const errors = trackErrors(page);
    const chart = await openTreemap(page, { wide, size });
    const rects = await chart.evaluate((svg) => [...svg.querySelectorAll<SVGRectElement>("rect.treemap-rect")].map((rect) => ({
      kind: rect.dataset.kind ?? "", code: rect.dataset.code ?? "", continent: rect.dataset.continent ?? "", value: Number(rect.dataset.value),
      width: Number(rect.getAttribute("width")), height: Number(rect.getAttribute("height")),
    })));
    expect(rects.length).toBe(expectedRectangles());
    expect(rects.filter((rect) => rect.kind === "residual")).toHaveLength(1);
    expect(rects.filter((rect) => rect.kind === "country").map((rect) => rect.code).sort()).toEqual(
      treemap.continents.flatMap((continent: any) => continent.countries.map((country: any) => country.code)).sort());
    const total = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    const value = rects.reduce((sum, rect) => sum + rect.value, 0);
    const ratio = total / value;
    // geometry is exact attribute by attribute, so every rectangle is checked, the smallest too
    for (const rect of rects) {
      expect(Math.abs((rect.width * rect.height) / rect.value / ratio - 1), `${rect.kind} ${rect.code}`).toBeLessThanOrEqual(AREA_TOLERANCE);
      expect(rect.value, `${rect.kind} ${rect.code} ${rect.continent}`).toBe(expectedValue(rect.kind, rect.code, rect.continent));
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
      // a continent's number is a single digit set tight in a small rectangle: its glyph box (a cap height above the baseline) must lie inside
      for (const number of svg.querySelectorAll<SVGTextElement>("text.treemap-continent-number")) {
        const rect = svg.querySelector<SVGRectElement>(`rect.treemap-rect[data-index="${number.dataset.index}"]`);
        if (!rect) { problems.push(`no rectangle for number ${number.textContent}`); continue; }
        const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => Number(rect.getAttribute(name)));
        const box = number.getBBox();
        const baseline = Number(number.getAttribute("y"));
        const cap = Number(svg.getAttribute("data-font-size")) * Number(svg.getAttribute("data-number-cap-em"));
        if (!(cap > 0)) throw new Error("fit numbers missing on the svg");
        if (box.x < x - 0.5 || box.x + box.width > x + width + 0.5 || baseline - cap < y - 0.5 || baseline > y + height + 0.5) {
          problems.push(`number ${number.textContent} (${box.width.toFixed(1)} wide, baseline ${(baseline - y).toFixed(1)}) outside ${width.toFixed(1)}x${height.toFixed(1)}`);
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
          return { id: item.dataset.continent ?? "", text: (item.querySelector("text.treemap-key-name")?.textContent ?? "").trim(),
            number: item.querySelector("text.treemap-key-number")?.textContent ?? null, inside: box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.bottom <= frame.bottom + 1 };
        });
      });
      // numbered 1..n in the order of the data; the rest is hatched, not numbered
      const drawn = treemap.continents.filter((entry: any) => entry.countries.length > 0 || entry.other);
      drawn.forEach((continent: any, at: number) => {
        const item = key.find((entry) => entry.id === continent.id);
        expect(item?.text, continent.id).toBe(continent.label);
        expect(item?.number, continent.id).toBe(String(at + 1));
      });
      expect(key.find((item) => item.id === "residual")?.text).toBe(treemap.residual.label);
      expect(key.find((item) => item.id === "residual")?.number).toBeNull();
      expect(key.filter((item) => !item.inside)).toEqual([]);
    });
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("treemap: a continent folded into one rectangle is named for the continent in its title, never \"Other\"", async ({ page }) => {
  const folded = treemap.continents.filter((continent: any) => continent.countries.length === 0 && continent.other);
  expect(folded.length).toBeGreaterThan(0);
  const chart = await openTreemap(page, { size: WALLBOARD, theme: "wallboard" });
  for (const continent of folded) {
    const rect = chart.locator(`rect.treemap-rect[data-continent="${continent.id}"]`);
    await expect(rect).toHaveCount(1);
    const title = rect.locator("title");
    await expect(title).toHaveText(new RegExp(`^${escapeRegExp(continent.label)} \\(`));
    await expect(title).not.toContainText("Other");
    await expect(chart.locator(`g.treemap-key-item[data-continent="${continent.id}"] text.treemap-key-name`)).toHaveText(continent.label);
  }
  // the table names it too
  await page.locator(CARD).getByRole("button", { name: "Show figures", exact: true }).click();
  const rows = await page.locator(`${CARD} tbody tr`).evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
  for (const continent of folded) {
    expect(rows.filter((cells) => cells[0] === continent.label && cells[1] === continent.label), continent.id).toHaveLength(1);
    expect(rows.filter((cells) => cells[1] === `Other ${continent.label}`), continent.id).toHaveLength(0);
  }
});

test("treemap: a folded continent whose rectangle holds its full name is labelled with the name, not \"Other\"", async ({ page }) => {
  await editOverview(page, (data) => {
    const moved = 400000;
    const africa = data.treemap.continents.find((continent: any) => continent.id === "africa");
    const china = data.treemap.continents.flatMap((continent: any) => continent.countries).find((country: any) => country.code === "CN");
    const percent = (moved / data.treemap.world) * 100;
    africa.other.value += moved;
    africa.other.share += percent;
    china.value -= moved;
    china.share -= percent;
  });
  const chart = await openTreemap(page, { size: { width: 1440, height: 900 } });
  const label = chart.locator('text.treemap-label[data-continent="africa"]');
  await expect(label).toHaveCount(1);
  await expect(label).toBeVisible();
  const text = (await label.textContent()) ?? "";
  expect(text.startsWith("Africa")).toBe(true);
  expect(text).not.toContain("Other");
  await expect(chart.locator('rect.treemap-rect[data-continent="africa"] > title')).toHaveText(/^Africa \(/);
});

/** The code's own rule for "a digit fits" (treemap.ts `digitFits`), read from the data attributes it puts on the svg and on each
 * key item: width >= digit width x slack + 2 pad, height >= cap height + 2 pad. */
for (const { wide, suffix } of FONT_VARIANTS) {
  for (const size of [{ width: 390, height: 900 }, { width: 1440, height: 900 }, WALLBOARD]) {
    const wallboard = size.width === WALLBOARD.width;
    test(`treemap at ${size.width}x${size.height}${wallboard ? " (wallboard)" : ""}: each continent's largest rectangle shows its number or its name when a digit fits${suffix}`, async ({ page }) => {
      const chart = await openTreemap(page, { wide, size, theme: wallboard ? "wallboard" : undefined });
      const seen = await chart.evaluate((svg) => {
        const [fontSize, capEm, padEm, slack] = ["data-font-size", "data-number-cap-em", "data-number-pad-em", "data-text-slack"].map((name) => Number(svg.getAttribute(name)));
        if (![fontSize, capEm, padEm, slack].every((value) => value > 0)) throw new Error("fit numbers missing on the svg");
        const items = [...svg.querySelectorAll<SVGGElement>("g.treemap-key-item")].filter((item) => item.dataset.continent !== "residual");
        return items.map((item, at) => {
          const id = item.dataset.continent ?? "";
          const rects = [...svg.querySelectorAll<SVGRectElement>(`rect.treemap-rect[data-continent="${id}"]`)];
          const largest = rects.reduce((best, rect) => (Number(rect.dataset.value) > Number(best.dataset.value) ? rect : best));
          const [width, height] = [Number(largest.getAttribute("width")), Number(largest.getAttribute("height"))];
          // a rectangle that is the whole continent is named by its own label, which starts with the continent's name
          const marks = [...svg.querySelectorAll<SVGTextElement>(`text[data-continent="${id}"]`)]
            .filter((mark) => mark.dataset.index === largest.dataset.index && !mark.classList.contains("treemap-label"));
          const own = svg.querySelector<SVGTextElement>(`text.treemap-label[data-continent="${id}"][data-index="${largest.dataset.index}"]`);
          if (marks.length === 0 && own && largest.dataset.kind === "other" && rects.length === 1) marks.push(own);
          const digitWidth = Number(item.dataset.digitWidth);
          if (!(digitWidth > 0)) throw new Error(`no digit width on the key item of ${id}`);
          return { id, number: String(at + 1), fits: width >= digitWidth * slack + 2 * padEm * fontSize && height >= (capEm + 2 * padEm) * fontSize,
            marks: marks.map((mark) => ({ kind: mark.getAttribute("class"), text: mark.textContent })) };
        });
      });
      for (const entry of seen.filter((item) => item.fits)) {
        expect(entry.marks.length, `${entry.id} has a mark`).toBe(1);
        const [mark] = entry.marks;
        if (mark.kind === "treemap-continent-number") expect(mark.text).toBe(entry.number);
        else expect(mark.text?.startsWith(treemap.continents.find((continent: any) => continent.id === entry.id).label)).toBe(true);
      }
      // the large screens fit a digit in at least one continent's rectangle that no name fits
      if (size.width > 390) expect(seen.filter((item) => item.fits && item.marks[0]?.kind === "treemap-continent-number").length).toBeGreaterThan(0);
    });
  }
}

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

/** Runs in the page: contrast of each text matching `selector` with the solid plate or rectangle under it. Throws on a colour
 * that is not a plain rgb (a pattern fill, a gradient), so a label on a hatched ground fails instead of passing on NaN. */
function measureContrast(svg: Element, selector: string): { text: string; ratio: number }[] {
  const luminance = (colour: string, what: string): number => {
    const match = /^rgba?\(([^)]+)\)$/.exec(colour);
    if (!match) throw new Error(`${what} is not a plain colour: ${colour}`);
    const [r, g, b] = match[1].split(",").slice(0, 3).map((part) => {
      const channel = Number(part) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return [...svg.querySelectorAll<SVGTextElement>(selector)].map((label) => {
    // a label on the hatched rest sits on its solid plate; a key digit sits on its swatch
    const ground = label.classList.contains("treemap-key-number")
      ? label.parentElement?.querySelector("rect.treemap-swatch")
      : svg.querySelector(`rect.treemap-plate[data-index="${label.dataset.index}"]`) ?? svg.querySelector(`rect.treemap-rect[data-index="${label.dataset.index}"]`);
    if (!ground) throw new Error(`no ground under ${label.textContent}`);
    const [a, b] = [luminance(getComputedStyle(label).fill, "label colour"), luminance(getComputedStyle(ground).fill, "ground")];
    return { text: label.textContent ?? "", ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  });
}

for (const theme of config.themes as string[]) {
  test(`treemap labels in theme ${theme}: label colour against its rectangle is at least ${theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST}:1`, async ({ page }) => {
    const chart = await openTreemap(page, { theme, size: theme === "wallboard" ? WALLBOARD : { width: 1440, height: 900 } });
    const need = theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST;
    const ratios = await chart.evaluate(measureContrast, "text.treemap-label, text.treemap-continent-label, text.treemap-continent-number");
    expect(ratios.length).toBeGreaterThan(2);
    expect(ratios.filter((entry) => entry.ratio < need)).toEqual([]);
    // the digit in each key swatch, on that swatch
    const digits = await chart.evaluate(measureContrast, "text.treemap-key-number");
    expect(digits.length).toBe(treemap.continents.filter((entry: any) => entry.countries.length > 0 || entry.other).length);
    expect(digits.filter((entry) => entry.ratio < need)).toEqual([]);
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
      // a continent with no country of its own is one row named for the continent
      expected.push([continent.label, continent.countries.length === 0 ? continent.label : `Other ${continent.label}`, continent.other.value.toLocaleString("en-US"), percentText(continent.other.share)]);
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

for (const theme of ["atlas", "wallboard"]) {
  test(`treemap in theme ${theme}: the rest's label sits on its solid plate, inside it, at ${theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST}:1 or more`, async ({ page }) => {
    const errors = trackErrors(page);
    await editOverview(page, (data) => {
      const world = data.treemap.world;
      data.treemap.residual.value = Math.round(world * 0.06);
      data.treemap.residual.share = 6;
    });
    const chart = await openTreemap(page, { theme, size: theme === "wallboard" ? WALLBOARD : { width: 1440, height: 900 } });
    const label = chart.locator("text.treemap-label[data-continent=\"residual\"]");
    await expect(label).toHaveCount(1);
    await expect(chart.locator("rect.treemap-plate")).toHaveCount(1);
    const placed = await chart.evaluate((svg) => {
      const plate = svg.querySelector("rect.treemap-plate") as SVGRectElement;
      const box = (svg.querySelector("text.treemap-label[data-continent=\"residual\"]") as SVGTextElement).getBBox();
      const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => Number(plate.getAttribute(name)));
      return { inside: box.x >= x - 0.5 && box.y >= y - 0.5 && box.x + box.width <= x + width + 0.5 && box.y + box.height <= y + height + 0.5,
        plate: `${x},${y},${width},${height}`, label: `${box.x},${box.y},${box.width},${box.height}` };
    });
    expect(placed.inside, `${placed.label} in ${placed.plate}`).toBe(true);
    const ratios = await chart.evaluate(measureContrast, "text.treemap-label[data-continent=\"residual\"]");
    expect(ratios).toHaveLength(1);
    expect(ratios[0].ratio).toBeGreaterThanOrEqual(theme === "wallboard" ? WALLBOARD_CONTRAST : MIN_CONTRAST);
    expect(errors).toEqual([]);
  });
}

test("treemap contrast check fails on a hatched ground (named as the ground) instead of passing on NaN", async ({ page }) => {
  // a rest too small for a label: no plate, so a label placed on it has only the hatched rectangle under it
  await editOverview(page, (data) => { data.treemap.residual.value = 1; data.treemap.residual.share = 0; });
  const chart = await openTreemap(page);
  await expect(chart.locator("rect.treemap-plate")).toHaveCount(0);
  const fill = await chart.evaluate((svg) => {
    const rect = svg.querySelector("rect.treemap-rect[data-kind=\"residual\"]") as SVGRectElement;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "treemap-label");
    text.setAttribute("data-index", rect.dataset.index ?? "");
    text.setAttribute("fill", "#000");
    svg.append(text);
    return getComputedStyle(rect).fill;
  });
  expect(fill).toMatch(/url\(/);
  await expect(chart.evaluate(measureContrast, "text.treemap-label")).rejects.toThrow(/^.*ground is not a plain colour: url\(/);
});

/** Runs in the page: for each rectangle of at least MIN_FILL_SIZE, the share of its area that no stroke covers. A stroke is
 * centred on its edge, so half of it covers the rectangle; on an edge shared with a band outline the wider of the two counts. */
function visibleFillShares(chart: Locator) {
  return chart.evaluate((svg, min) => {
        const num = (element: Element, name: string): number => Number(element.getAttribute(name));
        const bands = [...svg.querySelectorAll<SVGRectElement>("rect.treemap-band")].map((band) => ({
          x0: num(band, "x"), y0: num(band, "y"), x1: num(band, "x") + num(band, "width"), y1: num(band, "y") + num(band, "height"),
          stroke: parseFloat(getComputedStyle(band).strokeWidth) }));
        const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
        const out: { name: string; width: number; height: number; share: number }[] = [];
        for (const rect of svg.querySelectorAll<SVGRectElement>("rect.treemap-rect")) {
          const [x, y, width, height] = ["x", "y", "width", "height"].map((name) => num(rect, name));
          if (width < min.width || height < min.height) continue;
          const own = parseFloat(getComputedStyle(rect).strokeWidth);
          // a stroke is centred on its edge: half of it covers the rectangle, the wider of the rectangle's and a band outline on that edge
          const cover = (edge: "x0" | "y0" | "x1" | "y1", at: number): number => Math.max(own,
            ...bands.filter((band) => near(band[edge], at)).map((band) => band.stroke)) / 2;
          const left = cover("x0", x);
          const right = cover("x1", x + width);
          const top = cover("y0", y);
          const bottom = cover("y1", y + height);
          out.push({ name: rect.dataset.code || rect.dataset.kind || "", width, height,
            share: ((width - left - right) * (height - top - bottom)) / (width * height) });
        }
        return out;
      }, MIN_FILL_SIZE);
}

for (const { wide, suffix } of FONT_VARIANTS) {
  for (const size of [{ width: 390, height: 900 }, { width: 1440, height: 900 }, WALLBOARD]) {
    const wallboard = size.width === WALLBOARD.width;
    test(`treemap at ${size.width}x${size.height}${wallboard ? " (wallboard)" : ""}: strokes leave most of each rectangle's fill visible${suffix}`, async ({ page }) => {
      const chart = await openTreemap(page, { wide, size, theme: wallboard ? "wallboard" : undefined });
      const shares = await visibleFillShares(chart);
      expect(shares.length).toBeGreaterThan(3);
      expect(shares.filter((entry) => entry.share < MIN_VISIBLE_FILL), "rectangles with too little fill visible").toEqual([]);
    });
  }
}

test("treemap on the wallboard: small folded continents (their rectangles near the smallest that carry a fill) keep most of their fill visible", async ({ page }) => {
  await editOverview(page, (data) => {
    for (const continent of data.treemap.continents) if (continent.countries.length === 0 && continent.other) continent.other.value = Math.round(continent.other.value / 2);
  });
  const chart = await openTreemap(page, { size: WALLBOARD, theme: "wallboard" });
  const shares = await visibleFillShares(chart);
  expect(shares.filter((entry) => entry.name === "other").length).toBeGreaterThan(2);
  expect(shares.filter((entry) => entry.share < MIN_VISIBLE_FILL), "rectangles with too little fill visible").toEqual([]);
});

test("treemap: a continent whose listed countries have no value is one rectangle named for the continent; a continent with nothing to draw has no key entry", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => {
    const europe = data.treemap.continents.find((continent: any) => continent.id === "europe");
    for (const country of europe.countries) { country.value = null; country.share = null; }
    const asia = data.treemap.continents.find((continent: any) => continent.id === "asia");
    for (const country of asia.countries) { country.value = null; country.share = null; }
    asia.other = null;
  });
  const chart = await openTreemap(page, { size: { width: 1440, height: 900 } });
  const europe = chart.locator('rect.treemap-rect[data-continent="europe"]');
  await expect(europe).toHaveCount(1);
  await expect(europe.locator("title")).toHaveText(/^Europe \(/);
  await expect(chart.locator('rect.treemap-rect[data-continent="asia"]')).toHaveCount(0);
  await expect(chart.locator('g.treemap-key-item[data-continent="asia"]')).toHaveCount(0);
  // numbers follow the continents drawn
  const numbers = await chart.locator("g.treemap-key-item text.treemap-key-number").allTextContents();
  expect(numbers).toEqual(numbers.map((_, at) => String(at + 1)));
  expect(errors).toEqual([]);
});

test("treemap card: no share decimals in the method leaves the card out, no guess", async ({ page }) => {
  await editOverview(page, (data) => { delete data.method.rounding.decimals.share; });
  await page.goto("/embed.html?chart=treemap");
  // positive wait first: the message shows only once the edited overview.json has arrived and been processed; absence alone
  // passes at once and ends the test while the routed fetch is still being read
  await expect(page.locator(".embed-problem-title")).toHaveText("No data to draw “treemap”.");
  await expect(page.locator(CARD)).toHaveCount(0);
  await expect(page.locator("svg.treemap-chart")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("could not be loaded");
});

// ---- Rotation focus: ?rotate=<minSeconds>&chart=treemap (the size and theme set of controls.spec "every rotation chart view fits") ----
const FOCUS_SIZES = [{ width: 1920, height: 1080 }, { width: 1280, height: 900 }, { width: 1366, height: 768 }];
for (const { wide, suffix } of FONT_VARIANTS) for (const size of FOCUS_SIZES) {
  test(`?rotate=<minSeconds>&chart=treemap focus layout fits ${size.width}x${size.height} in every theme${suffix}`, async ({ page }) => {
    const errors = trackErrors(page);
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    for (const theme of config.themes.filter((name: string) => name !== config.embedTheme)) {
      await page.goto(`/?rotate=${config.rotation.minSeconds}&theme=${theme}&chart=treemap`);
      await expect(page.locator("html.focus-layout.view-ready")).toHaveCount(1);
      await expect(page.locator(`${CARD} svg`).first()).toBeVisible();
      await page.waitForTimeout(600); // the first resize redraw, fitted again
      const fit = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>(".chart-card")!.getBoundingClientRect();
        const footer = document.querySelector<HTMLElement>(".site-footer")!.getBoundingClientRect();
        const root = document.documentElement;
        return {
          card: card.bottom <= footer.top + 0.5 && card.right <= innerWidth + 0.5 && card.left >= -0.5,
          page: root.scrollHeight <= innerHeight && root.scrollWidth <= innerWidth,
        };
      });
      expect(fit, theme).toEqual({ card: true, page: true });
    }
    expect(errors).toEqual([]);
  });
}
