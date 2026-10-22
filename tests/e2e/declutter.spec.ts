import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";

// Less clutter around charts (spec: "Less clutter around charts"): footnotes and "To reproduce" lines sit in one closed
// <details> per card; the source line, credits and tools stay visible; card and section text fills its container.
const SUMMARY = "Sources, notes and how to reproduce";
const entities: { code: string; label: string; kind: string }[] = JSON.parse(readFileSync("site/data/entities.json", "utf8"));
const COUNTRY = entities.find((entity) => entity.code === "CH");

const PAGES = [
  { name: "overview", url: "/" },
  { name: "country", url: "/?country=CH" },
  { name: "region", url: "/?region=155" },
  { name: "continent", url: "/?continent=africa" },
  { name: "women inventors", url: "/?view=women-inventors" },
];

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".chart-card h2").first()).toBeVisible();
  await expect(page.locator(".chart-card .chart-tools").first()).toBeVisible();
}

for (const { name, url } of PAGES) {
  test(`${name}: every chart card folds footnotes and 'To reproduce' into one closed details; source line and tools stay`, async ({ page }) => {
    expect(COUNTRY, "CH in entities.json").toBeTruthy();
    await page.goto(url);
    await settled(page);
    const cards = page.locator(".chart-card:not(.chart-card--problem)");
    const total = await cards.count();
    expect(total).toBeGreaterThan(0);
    for (let index = 0; index < total; index++) {
      const card = cards.nth(index);
      const id = await card.getAttribute("data-chart");
      const details = card.locator("details.card-details");
      await expect(details, id ?? "").toHaveCount(1);
      await expect(details, id ?? "").not.toHaveAttribute("open", /.*/);
      await expect(details.locator("> summary"), id ?? "").toHaveText(SUMMARY);
      await expect(card.locator(".source-line").first(), id ?? "").toBeVisible();
      await expect(card.locator(".chart-tools"), id ?? "").toBeVisible();
      // nothing removed from the DOM: the reproduce line is inside the details, hidden while it is closed
      await expect(details.locator(".chart-query").first(), id ?? "").toContainText("To reproduce");
      await expect(details.locator(".chart-query").first(), id ?? "").toBeHidden();
      // footnotes live only inside the details
      await expect(card.locator(".chart-footnote:not(.card-details .chart-footnote)"), id ?? "").toHaveCount(0);
      await expect(card.locator(".chart-query:not(.card-details .chart-query)"), id ?? "").toHaveCount(0);
      await details.locator("> summary").click();
      await expect(details, id ?? "").toHaveAttribute("open", "");
      await expect(details.locator(".chart-query").first(), id ?? "").toBeVisible();
      for (const footnote of await details.locator(".chart-footnote").all()) await expect(footnote, id ?? "").toBeVisible();
    }
  });

  test(`${name}: print shows every card's details open`, async ({ page }) => {
    await page.goto(url);
    await settled(page);
    await page.emulateMedia({ media: "print" });
    const queries = page.locator(".chart-card details.card-details .chart-query");
    const total = await queries.count();
    expect(total).toBeGreaterThan(0);
    for (let index = 0; index < total; index++) await expect(queries.nth(index)).toBeVisible();
    // the stored state is untouched: the details are still closed in the DOM
    await expect(page.locator(".chart-card details.card-details[open]")).toHaveCount(0);
  });
}

test("the details opens from the keyboard", async ({ page }) => {
  await page.goto("/?country=CH");
  await settled(page);
  const details = page.locator(".chart-card details.card-details").first();
  await details.locator("> summary").focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(details).not.toHaveAttribute("open", /.*/);
});

test("the beforeprint handler opens closed details and afterprint closes them again", async ({ page }) => {
  await page.goto("/?country=CH");
  await settled(page);
  const first = page.locator(".chart-card details.card-details").first();
  await first.locator("> summary").click(); // opened by the reader: stays open
  const closedBefore = await page.locator(".chart-card details.card-details:not([open])").count();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.locator(".chart-card details.card-details:not([open])")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator(".chart-card details.card-details:not([open])")).toHaveCount(closedBefore);
  await expect(first).toHaveAttribute("open", "");
});

test("embeds and wallboard slides carry no details; the embed keeps its footnotes under the chart", async ({ page }) => {
  await page.goto("/embed.html?chart=world-trend");
  await expect(page.locator(".chart-card h2")).toBeVisible();
  await expect(page.locator("details.card-details")).toHaveCount(0);
  await expect(page.locator(".chart-query")).toHaveCount(0);
  await page.goto("/?view=wallboard");
  await expect(page.locator(".board-slot .chart-card h2").first()).toBeVisible();
  await expect(page.locator("details.card-details")).toHaveCount(0);
});

// Text blocks of cards and sections: as wide as the box that holds them, and carrying no max-width cap (prose on methods and
// about, the page lede and the footer disclaimer keep their reading measure and are checked below).
const TEXT_BLOCKS = ".chart-note, .chart-footnote, .chart-query, .chart-credit, .source-line, .map-disclaimer, .notice, .entity-missing, .region-compare-note, .women-caveat, .women-none";

const WIDTH_PAGES = [...PAGES, { name: "office", url: "/?office=EP" }, { name: "country with no data", url: "/?country=VA" }];

for (const width of [1440, 1920]) {
  for (const { name, url } of WIDTH_PAGES) {
    test(`${name} at ${width}px: card and section text fills its container`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(url);
      await expect(page.locator("h1").first()).toBeVisible();
      for (const summary of await page.locator("details.card-details > summary").all()) await summary.click();
      const found = await page.evaluate((selector) => {
        const narrow: string[] = [];
        const capped: string[] = [];
        let measured = 0;
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement;
          if (box.width === 0 || !parent) continue;
          const label = `${element.className || element.tagName}`;
          if (getComputedStyle(element).maxWidth !== "none") capped.push(label);
          const style = getComputedStyle(parent);
          const rowFlex = style.display.includes("flex") && !style.flexDirection.startsWith("column");
          const multiTrack = style.display.includes("grid") && style.gridTemplateColumns.split(" ").length > 1;
          if (rowFlex || multiTrack) continue; // items sized by their track or siblings
          measured++;
          const room = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          if (box.width < room - 1) narrow.push(`${label}: ${Math.round(box.width)} of ${Math.round(room)}`);
        }
        return { narrow, capped, measured };
      }, TEXT_BLOCKS);
      expect(found.capped, "no max-width cap").toEqual([]);
      expect(found.narrow).toEqual([]);
      expect(found.measured).toBeGreaterThan(0);
    });
  }

  test(`at ${width}px the lede, prose and footer disclaimer cap at --measure-wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const [url, selector] of [["/", ".lede"], ["/methods.html", ".prose"], ["/about.html", ".prose"], ["/", ".site-footer .disclaimer"]]) {
      await page.goto(url);
      const element = page.locator(selector).first();
      await expect(element, `${url} ${selector}`).toBeVisible();
      const [cap, wide] = await element.evaluate((node) => {
        const probe = document.createElement("div");
        probe.style.width = "var(--measure-wide)";
        node.parentElement!.append(probe);
        const resolved = getComputedStyle(probe).width;
        probe.remove();
        return [getComputedStyle(node).maxWidth, resolved];
      });
      expect(cap, `${url} ${selector}`).toBe(wide);
    }
  });
}

test("a map card keeps its details open when a control redraws the card", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="world-map"]');
  await expect(card.locator("details.card-details")).toHaveCount(1);
  await card.locator("details.card-details > summary").click();
  await expect(card.locator("details.card-details")).toHaveAttribute("open", "");
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(card.locator(".chart-query").first()).toContainText("To reproduce");
  await expect(card.locator("details.card-details")).toHaveAttribute("open", "");
  await expect(card.locator(".chart-query").first()).toBeVisible();
});

test("a map card redrawn with its details closed keeps them closed", async ({ page }) => {
  await page.goto("/");
  const card = page.locator('.chart-card[data-chart="world-map"]');
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(card.locator(".chart-query").first()).toContainText("To reproduce");
  await expect(card.locator("details.card-details")).not.toHaveAttribute("open", /.*/);
});
