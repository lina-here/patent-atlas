import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";

// Search results and link previews, as a browser sees the served pages: title and description sized for results,
// canonical from site/config.json baseUrl, the preview image served as a 1200x630 PNG. The embed stays out of search.
// Uniqueness across pages, og:title/description and the sitemap: pipeline/tests/test_site_seo.py.

const BASE_URL: string = JSON.parse(readFileSync("site/config.json", "utf8")).baseUrl;
const INDEXED: Record<string, string> = { "/": "", "/methods.html": "methods.html", "/about.html": "about.html" };
const content = (page: Page, selector: string) =>
  page.locator(selector).first().getAttribute(selector.startsWith("link") ? "href" : "content");

for (const [path, file] of Object.entries(INDEXED)) {
  test(`${path}: a title and description sized for search results; canonical and preview tags from baseUrl`, async ({ page }) => {
    await page.goto(path);
    const title = await page.title();
    expect(title.length).toBeGreaterThanOrEqual(30);
    expect(title.length).toBeLessThanOrEqual(60);
    const description = (await content(page, 'meta[name="description"]')) ?? "";
    expect(description.length).toBeGreaterThanOrEqual(120);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(await content(page, 'link[rel="canonical"]')).toBe(BASE_URL + file);
    expect(await content(page, 'meta[property="og:url"]')).toBe(BASE_URL + file);
    expect(await content(page, 'meta[property="og:image"]')).toBe(`${BASE_URL}og/patent-atlas.png`);
    expect(await content(page, 'meta[name="twitter:card"]')).toBe("summary_large_image");
  });
}

test("the link-preview image is served as a 1200x630 PNG", async ({ request }) => {
  const response = await request.get("/og/patent-atlas.png");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("image/png");
  const body = await response.body();
  expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("the embed page is kept out of search and names no canonical", async ({ page }) => {
  await page.goto("/embed.html?chart=world-trend");
  expect(await content(page, 'meta[name="robots"]')).toBe("noindex");
  expect(await page.locator('link[rel="canonical"]').count()).toBe(0);
});
