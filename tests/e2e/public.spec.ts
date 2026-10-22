import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";

// Going public (j63, Lina's rules): the WIPO citation and disclaimer on every page; the methods line verbatim; credit
// "Lina" only; no download buttons or links to raw data files.

const provenance = readFileSync("site/src/provenance.ts", "utf8");
const DISCLAIMER = /^export const DISCLAIMER =\s*"([^"]+)";/m.exec(provenance)![1];
// Lina's wording, verbatim: the test holds its own copy so a change to the site text fails here
const METHODS_LINE = "Built with the help of AI coding tools. No AI runs on this site or produces its figures; every figure comes from WIPO or the World Bank and is checked against WIPO's published values.";

const PAGES = ["/", "/methods.html", "/about.html", "/?view=releases", "/embed.html?chart=world-trend", "/?view=wallboard"];

for (const path of PAGES) {
  test(`${path}: names the WIPO Statistics Database and carries WIPO's disclaimer; no download or raw-data link`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("body")).toContainText("WIPO Statistics Database");
    await expect(page.locator("body")).toContainText(DISCLAIMER);
    expect(await page.locator("a[download]").count()).toBe(0);
    const hrefs = await page.locator("a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    expect(hrefs.filter((href) => /(^|\/)data\/.*\.json|^blob:|^data:/.test(href))).toEqual([]);
  });
}

test("methods page shows the AI methods line verbatim", async ({ page }) => {
  await page.goto("/methods.html");
  await expect(page.locator(".methods-made")).toHaveText(METHODS_LINE);
});

test("the site credits Lina only", async ({ page }) => {
  await page.goto("/about.html");
  await expect(page.locator("#author")).toContainText("Written and maintained by Lina.");
  await expect(page.locator("body")).not.toContainText("Na Li");
  await expect(page.locator("a[href^='mailto:']")).toHaveCount(0);
});
