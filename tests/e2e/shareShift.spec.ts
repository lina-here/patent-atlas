import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { fixtureBreak, includesBreakNote, routeSeriesBreaks } from "./seriesBreaks";
import { FONT_VARIANTS, useWideFonts } from "./wideFonts";
import { openNotes } from "./notes";
import { fixedHalfAway } from "../../site/src/format";

// Share-shift card, "Who gained and lost ground?": each top origin's change in share of world applications, base year to
// year, as a diverging bar chart. Expected rows, order and figures are read from overview.json; change_pp is displayed as
// published, never recomputed here.
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const shift = overview.share_shift;
const decimals: number = overview.method.rounding.decimals.share;

const CARD = '.chart-card[data-chart="share-shift"]';

type Row = { code: string; label: string; rank: number; share_base: number | null; share: number | null; change_pp: number | null; breaks: number[] };

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

async function openCard(page: Page, opts: { wide?: boolean; width?: number } = {}): Promise<Locator> {
  if (opts.wide) await useWideFonts(page);
  if (opts.width) await page.setViewportSize({ width: opts.width, height: 900 });
  await page.goto("/");
  const card = page.locator(CARD);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("svg").first()).toBeVisible();
  return card;
}

/** Rows the chart plots: those with a change, by change descending then rank. */
function plotted(rows: Row[] = shift.rows): Row[] {
  return rows.filter((row) => row.change_pp !== null).sort((a, b) => (b.change_pp as number) - (a.change_pp as number) || a.rank - b.rank);
}

const labelOf = (row: Row): string => (row.breaks.length > 0 ? `${row.label} †` : row.label);

/** `+x.xx pp` / `-x.xx pp` / `0.00 pp` of a change, rounded as the method says (the code's own rounding, so a half-way value agrees). */
function valueText(change: number): string {
  const text = fixedHalfAway(change, decimals);
  return `${change > 0 && /[1-9]/.test(text) ? "+" : ""}${text} pp`;
}

test("share-shift: one bar per origin with a change in share", async ({ page }) => {
  const errors = trackErrors(page);
  const card = await openCard(page);
  expect(plotted().length).toBeGreaterThan(5);
  await expect(card.locator('svg g[aria-label="bar"] rect')).toHaveCount(plotted().length);
  await expect(card.locator("h2")).toHaveText(`Who gained and lost ground? Change in share of world applications, ${shift.base_year}–${shift.year}`);
  expect(errors).toEqual([]);
});

test("share-shift: bars run from the biggest gain to the biggest loss, ties by rank", async ({ page }) => {
  const card = await openCard(page);
  const labels = await card.locator('svg g[aria-label="y-axis tick label"] text').allTextContents();
  expect(labels).toEqual(plotted().map(labelOf));
});

test("share-shift: gains lie right of the zero rule, losses left, a zero change has no width", async ({ page }) => {
  await editOverview(page, (data) => {
    const row = data.share_shift.rows.find((entry: Row) => entry.code === "FR");
    row.change_pp = 0;
    row.share_base = row.share;
  });
  const card = await openCard(page);
  const geometry = await card.locator("svg").first().evaluate((svg) => {
    const rule = svg.querySelector('g[aria-label="rule"] line')!.getBoundingClientRect();
    return {
      rule: rule.left,
      bars: [...svg.querySelectorAll('g[aria-label="bar"] rect')].map((rect) => {
        const box = rect.getBoundingClientRect();
        return { left: box.left, right: box.right, width: Number(rect.getAttribute("width")), fill: getComputedStyle(rect).fill };
      }),
    };
  });
  const rows = plotted(shift.rows.map((row: Row) => (row.code === "FR" ? { ...row, change_pp: 0 } : row)));
  expect(geometry.bars).toHaveLength(rows.length);
  rows.forEach((row, index) => {
    const bar = geometry.bars[index];
    if (row.change_pp! > 0) expect(bar.left, row.label).toBeGreaterThanOrEqual(geometry.rule - 0.5);
    else if (row.change_pp! < 0) expect(bar.right, row.label).toBeLessThanOrEqual(geometry.rule + 0.5);
    else expect(bar.width, row.label).toBe(0);
  });
  // gains and losses differ in colour too (chart colours 1 and 2 of the theme)
  const fills = (sign: number) => new Set(rows.flatMap((row, index) => (Math.sign(row.change_pp!) === sign ? [geometry.bars[index].fill] : [])));
  expect(fills(1).size).toBe(1);
  expect(fills(-1).size).toBe(1);
  expect([...fills(1)][0]).not.toBe([...fills(-1)][0]);
});

test("share-shift: value texts carry the sign and pp; a zero change has none", async ({ page }) => {
  await editOverview(page, (data) => {
    const row = data.share_shift.rows.find((entry: Row) => entry.code === "FR");
    row.change_pp = 0;
    row.share_base = row.share;
  });
  const card = await openCard(page);
  const texts = await card.locator('svg g[aria-label="text"] text').allTextContents();
  const rows = plotted(shift.rows.map((row: Row) => (row.code === "FR" ? { ...row, change_pp: 0 } : row)));
  expect([...texts].sort()).toEqual(rows.map((row) => valueText(row.change_pp!)).sort());
  expect(texts).toContain("0.00 pp");
  expect(texts.filter((text) => text.startsWith("+")).length).toBe(rows.filter((row) => row.change_pp! > 0).length);
});

test("share-shift: the table lists every share_shift row of overview.json as published", async ({ page }) => {
  const card = await openCard(page);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(card.locator("thead th")).toHaveText(["Origin", `Rank ${shift.year}`, `Share ${shift.base_year}`, `Share ${shift.year}`, "Change (pp)"]);
  const cells = await card.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
  const share = (value: number | null): string => (value === null ? "–" : `${fixedHalfAway(value, decimals)}%`);
  expect(cells).toEqual(shift.rows.map((row: Row) => [
    labelOf(row), String(row.rank), share(row.share_base), share(row.share),
    row.change_pp === null ? "–" : valueText(row.change_pp).replace(" pp", ""),
  ]));
});

test("share-shift: China is marked † and the world break note and the denominator note show", async ({ page }) => {
  const entry = fixtureBreak();
  await routeSeriesBreaks(page, [entry]);
  const card = await openCard(page);
  await expect(card.locator('svg g[aria-label="y-axis tick label"] text', { hasText: "†" })).toHaveText(`${entry.label} †`);
  await expect(card.locator('svg g[aria-label="y-axis tick label"] text', { hasText: "†" })).toHaveCount(shift.rows.filter((row: Row) => row.breaks.length > 0 && row.change_pp !== null).length);
  await openNotes(card);
  await expect(card.locator(".chart-footnote", { hasText: "† series break inside the period" })).toBeVisible();
  await expect(card.locator(".chart-footnote", { hasText: /^Includes .*Series break \d{4}/ })).toHaveText(includesBreakNote(entry));
  await expect(card.locator(".chart-note")).toContainText(`${overview.share_denominator.origin_apps}`);
  await expect(card.locator(".chart-note")).toContainText(`${entry.label}'s series break in ${entry.year}`);
});

test("share-shift: a window with no world break carries no break or denominator note", async ({ page }) => {
  await routeSeriesBreaks(page, null);
  const card = await openCard(page);
  await openNotes(card);
  await expect(card.locator(".chart-footnote", { hasText: /^Includes .*Series break \d{4}/ })).toHaveCount(0);
  await expect(card.locator(".chart-note")).not.toContainText("series break");
});

test("share-shift: an origin with no share in the base year is listed under the chart, not plotted", async ({ page }) => {
  const missing = shift.rows.find((row: Row) => row.code === "DE");
  await editOverview(page, (data) => {
    const row = data.share_shift.rows.find((entry: Row) => entry.code === "DE");
    row.share_base = null;
    row.change_pp = null;
  });
  const card = await openCard(page);
  await expect(card.locator('svg g[aria-label="bar"] rect')).toHaveCount(plotted().length - 1);
  await expect(card.locator('svg g[aria-label="y-axis tick label"] text', { hasText: missing.label })).toHaveCount(0);
  await openNotes(card);
  await expect(card.locator(".chart-footnote", { hasText: "Not plotted" })).toHaveText(`Not plotted, no data ${shift.base_year}: ${missing.label}.`);
  await card.getByRole("button", { name: "Show figures", exact: true }).click();
  await expect(card.locator("tbody tr")).toHaveCount(shift.rows.length);
});

test("share-shift: share_shift absent -> the card is left out, the rest of the page draws", async ({ page }) => {
  const errors = trackErrors(page);
  await editOverview(page, (data) => { delete data.share_shift; });
  await page.goto("/");
  await expect(page.locator('.chart-card[data-chart="top-origins"] svg').first()).toBeVisible();
  await expect(page.locator(CARD)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("share-shift: a null_reason shows its message in the card, no chart", async ({ page }) => {
  await editOverview(page, (data) => { data.share_shift.null_reason = "no_wipo_world_total"; data.share_shift.rows = []; });
  await page.goto("/");
  const card = page.locator(CARD);
  await expect(card.locator("p.card-problem")).toContainText("no complete WIPO world total");
  await expect(card.locator("svg")).toHaveCount(0);
});

for (const { wide, suffix } of FONT_VARIANTS) for (const width of [320, 360, 390, 1440]) {
  test(`share-shift at ${width}px: no label is clipped, outside the chart or overlapping another${suffix}`, async ({ page }) => {
    const card = await openCard(page, { wide, width });
    const measured = await card.locator("svg").first().evaluate((svg) => {
      const box = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const labels = [...svg.querySelectorAll('g[aria-label="y-axis tick label"] text, g[aria-label="text"] text')]
        .map((element) => ({ text: element.textContent ?? "", ...box(element) }));
      return { frame: box(svg), labels, card: svg.closest(".chart-card")!.getBoundingClientRect().right - document.documentElement.clientWidth };
    });
    // the card stays inside the window (the page footer, not this card, may be wider than a 320 px window)
    expect(measured.card).toBeLessThanOrEqual(0);
    expect(measured.labels.length).toBe(plotted().length * 2);
    for (const label of measured.labels) {
      expect(label.left, label.text).toBeGreaterThanOrEqual(measured.frame.left - 0.5);
      expect(label.right, label.text).toBeLessThanOrEqual(measured.frame.right + 0.5);
    }
    const overlaps: string[] = [];
    measured.labels.forEach((a, index) => measured.labels.slice(index + 1).forEach((b) => {
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${a.text} / ${b.text}`);
    }));
    expect(overlaps).toEqual([]);
    // a name cut to fit still reads as the start of the full name, or is the origin's code on a very narrow phone
    const names = await card.locator('svg g[aria-label="y-axis tick label"] text').allTextContents();
    expect(names).toHaveLength(plotted().length);
    names.forEach((name, index) => {
      const row = plotted()[index];
      const full = labelOf(row);
      const dagger = full.endsWith(" †") ? " †" : "";
      expect(name.endsWith(" †"), name).toBe(dagger !== "");
      const bare = name.slice(0, name.length - dagger.length).replace(/…$/, "");
      if (name !== full) expect(row.label.startsWith(bare) || bare === row.code, name).toBe(true);
    });
  });
}

test("share-shift: each bar's tooltip names the origin whole, never the cut label", async ({ page }) => {
  const card = await openCard(page, { width: 360 });
  const titles = await card.locator('svg g[aria-label="bar"] rect > title').allTextContents();
  expect(titles).toEqual(plotted().map((row) => `${labelOf(row)}: ${valueText(row.change_pp!)}`));
});

test("share-shift: origins whose names cut to the same text stay separate bars", async ({ page }) => {
  const prefix = "Federation of the Very Long Named Territories and Dependencies of ";
  await editOverview(page, (data) => {
    data.share_shift.rows.find((row: Row) => row.code === "IT").label = `${prefix}Alpha`;
    data.share_shift.rows.find((row: Row) => row.code === "CA").label = `${prefix}Beta`;
  });
  const card = await openCard(page, { width: 390 });
  const bars = await card.locator('svg g[aria-label="bar"] rect').evaluateAll((rects) => rects.map((rect) => Number(rect.getAttribute("y"))));
  expect(bars).toHaveLength(plotted().length);
  expect(new Set(bars).size).toBe(bars.length);
});

// ---- Rotation focus: ?rotate=<minSeconds>&chart=share-shift (the size and theme set of controls.spec "every rotation chart view fits") ----
const FOCUS_SIZES = [{ width: 1920, height: 1080 }, { width: 1280, height: 900 }, { width: 1366, height: 768 }];
for (const { wide, suffix } of FONT_VARIANTS) for (const size of FOCUS_SIZES) {
  test(`?rotate=<minSeconds>&chart=share-shift focus layout fits ${size.width}x${size.height} in every theme${suffix}`, async ({ page }) => {
    const errors = trackErrors(page);
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    for (const theme of config.themes.filter((name: string) => name !== config.embedTheme)) {
      await page.goto(`/?rotate=${config.rotation.minSeconds}&theme=${theme}&chart=share-shift`);
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
