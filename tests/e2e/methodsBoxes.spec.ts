import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// Methods page boxes: sections grouped in native <details>, closed by default; a link or #hash into a closed box opens
// it; print opens all. Section ids come from the page's own table of contents, themes from config.json.

const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const provenance = readFileSync("site/src/provenance.ts", "utf8");
const AI_LINE = /export const AI_METHODS_LINE =\s*"([^"]+)"/.exec(provenance)?.[1] ?? "";

const boxes = (page: Page) => page.locator("main details.prose-box");

async function ready(page: Page, path = "/methods.html"): Promise<void> {
  await page.goto(path);
  await expect(page.locator(".toc a").first()).toBeAttached();
}

async function tocIds(page: Page): Promise<string[]> {
  return page.locator(".toc a").evaluateAll((links) => links.map((link) => (link.getAttribute("href") ?? "").slice(1)));
}

/** Every <details> holding the element is open. */
async function openAround(page: Page, id: string): Promise<boolean> {
  return page.evaluate((target) => {
    const el = document.getElementById(target);
    if (!el) return false;
    for (let node: Element | null = el; node; node = node.parentElement) if (node instanceof HTMLDetailsElement && !node.open) return false;
    return true;
  }, id);
}

/** WCAG 2.x contrast ratio of two computed `rgb(...)` colours (opaque). */
function contrast(a: string, b: string): number {
  const lum = (colour: string): number => {
    const [r, g, bl] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("boxes are closed by default; title, intro, AI line, disclaimer and box list are visible", async ({ page }) => {
  expect(AI_LINE).not.toBe("");
  await ready(page);
  expect(await boxes(page).count()).toBeGreaterThanOrEqual(5);
  await expect(page.locator("main details.prose-box[open]")).toHaveCount(0);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.locator(".page-intro .lede")).toBeVisible();
  await expect(page.locator(".page-intro .methods-made")).toHaveText(AI_LINE);
  await expect(page.locator("#disclaimer .disclaimer")).toBeVisible();
  for (const box of await boxes(page).all()) {
    await expect(box.locator("> summary .box-title")).toBeVisible();
    await expect(box.locator("> summary .box-line")).not.toHaveText("");
    await expect(box.locator("> section").first()).toBeHidden();
  }
});

test("every table-of-contents entry is a section inside a box (disclaimer aside); no id twice on the page", async ({ page }) => {
  await ready(page);
  const ids = await tocIds(page);
  expect(ids.length).toBeGreaterThan(10);
  for (const id of ids) {
    await expect(page.locator(`section#${id}`), id).toHaveCount(1);
    if (id !== "disclaimer") await expect(page.locator(`details.prose-box section#${id}`), id).toHaveCount(1);
  }
  const all = await page.locator("[id]").evaluateAll((els) => els.map((el) => el.id));
  expect(all.filter((id, at) => all.indexOf(id) !== at)).toEqual([]);
});

test("loading methods.html#<id> opens its box and shows the target, for every section and the women parts", async ({ page }) => {
  await ready(page);
  const ids = [...await tocIds(page), ...await page.locator("#women-inventors [id]").evaluateAll((els) => els.map((el) => el.id))];
  for (const id of ids) {
    await page.goto("about:blank");
    await page.goto(`/methods.html#${id}`);
    await expect(page.locator(`[id="${id}"]`), id).toBeInViewport();
    expect(await openAround(page, id), id).toBe(true);
  }
});

test("a hash change, a table-of-contents click and an in-text link open the box holding their target", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { location.hash = "#map"; });
  await expect(page.locator("#map")).toBeInViewport();
  expect(await openAround(page, "map")).toBe(true);

  await page.locator('.toc a[href="#pct-membership"]').click();
  await expect(page.locator("#pct-membership")).toBeInViewport();
  expect(await openAround(page, "pct-membership")).toBe(true);
  // closed again by the reader, a second click on the same entry (no hash change) still opens it
  await page.locator("details.prose-box:has(#pct-membership) > summary").click();
  expect(await openAround(page, "pct-membership")).toBe(false);
  await page.locator('.toc a[href="#pct-membership"]').click();
  await expect(page.locator("#pct-membership")).toBeInViewport();
  expect(await openAround(page, "pct-membership")).toBe(true);

  // in-text link into another, closed box (formulas -> series breaks or world totals, whichever the data has)
  const link = page.locator('#formulas a[href^="#"]').first();
  const target = ((await link.getAttribute("href")) ?? "#").slice(1);
  await page.locator('.toc a[href="#formulas"]').click();
  await link.click();
  await expect(page.locator(`[id="${target}"]`)).toBeInViewport();
  expect(await openAround(page, target)).toBe(true);
});

test("summary keyboard: Enter on a focused box summary opens it, again closes it", async ({ page }) => {
  await ready(page);
  const first = boxes(page).first();
  await first.locator("> summary").focus();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(first).not.toHaveAttribute("open", "");
});

test("print opens every box; afterprint closes only the ones it opened", async ({ page }) => {
  await ready(page);
  const reader = boxes(page).nth(1);
  await reader.locator("> summary").click();
  const closedBefore = await page.locator("details.prose-box:not([open])").count();
  expect(closedBefore).toBeGreaterThan(0);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.locator("details.prose-box:not([open])")).toHaveCount(0);
  for (const box of await boxes(page).all()) await expect(box.locator("> section").first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("details.prose-box:not([open])")).toHaveCount(closedBefore);
  await expect(reader).toHaveAttribute("open", "");
});

for (const variant of FONT_VARIANTS) {
  for (const width of [390, 1440]) {
    test(`methods boxes fit at ${width} px, closed and open, no horizontal scroll${variant.suffix}`, async ({ page }) => {
      if (variant.wide) await useWideFonts(page);
      await page.setViewportSize({ width, height: 900 });
      await ready(page);
      if (variant.wide) await expectWideFonts(page);
      expect(await boxes(page).count()).toBeGreaterThan(0);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>("details.prose-box").forEach((box) => { box.open = true; }));
      expect(await overflow()).toBeLessThanOrEqual(0);
      for (const box of await boxes(page).all()) {
        const [boxRight, summaryRight] = await box.evaluate((el) => [el.getBoundingClientRect().right, el.querySelector("summary")!.getBoundingClientRect().right]);
        expect(summaryRight).toBeLessThanOrEqual(boxRight + 0.5);
        expect(boxRight).toBeLessThanOrEqual(width);
      }
    });
  }
}

for (const theme of config.themes as string[]) {
  test(`${theme}: boxes are drawn as panels; summary title and line >= 4.5:1 on the box`, async ({ page }) => {
    await ready(page, `/methods.html?theme=${theme}`);
    const box = boxes(page).first();
    const style = await box.evaluate((el) => {
      const own = getComputedStyle(el);
      const title = getComputedStyle(el.querySelector(".box-title")!);
      const line = getComputedStyle(el.querySelector(".box-line")!);
      return { background: own.backgroundColor, border: own.borderTopStyle, title: title.color, line: line.color };
    });
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.border).toBe("solid");
    expect(contrast(style.title, style.background), `${theme} title`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(style.line, style.background), `${theme} line`).toBeGreaterThanOrEqual(4.5);
  });
}
