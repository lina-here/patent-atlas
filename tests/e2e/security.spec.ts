import { readFileSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";

// Pre-public hardening (README "Security"): address values are repeated only in a short safe shape (params.ts
// ECHO_SAFE), entity codes are checked before any fetch, data labels render as text, the meta CSP is enforced.
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("site/config.json");

/** An attacker's sentence in the address; MARK is its one word found nowhere on the site (country codes are upper-cased). */
const SENTENCE = "Figures withdrawn by court order, read the notice at zorblax.example";
const MARK = /zorblax/i;
/** The same words as a slug (?continent= passes the slug shape check) and as a comma list (?slides= ids). */
const SLUG_SENTENCE = "figures-withdrawn-read-the-notice-at-zorblax";
const LIST_SENTENCE = "figures,withdrawn,read,zorblax,notice";
const NOT_SHOWN = "(not shown)";
const said = encodeURIComponent(SENTENCE);

async function expectNotEchoed(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toContainText(MARK);
  expect(await page.title()).not.toMatch(MARK);
}

test("full page: a sentence in any address value is not repeated; each notice still says the value was ignored", async ({ page }) => {
  await page.goto(`/?theme=${said}&country=${said}&office=${said}&chart=${said}&rotate=${said}&metric=${said}&view=${said}`);
  const notices = page.locator("#notices");
  for (const text of [`Unknown theme: ${NOT_SHOWN}`, `Unknown country: ${NOT_SHOWN}`, `Unknown office: ${NOT_SHOWN}`,
    `Invalid rotate: ${NOT_SHOWN}`, `Unknown metric: ${NOT_SHOWN}`, `Unknown view: ${NOT_SHOWN}`]) {
    await expect(notices).toContainText(text);
  }
  await expect(page.locator(".chart-card").first()).toBeVisible();
  await expectNotEchoed(page);
  await page.goto(`/?continent=${SLUG_SENTENCE}`);
  await expect(notices).toContainText(`Unknown continent: ${NOT_SHOWN}`);
  await expectNotEchoed(page);
});

test("full page: a short plain value is still repeated, as typed", async ({ page }) => {
  await page.goto("/?country=ZZ&theme=neon&year=20x");
  for (const text of ["Unknown country: ZZ", "Unknown theme: neon", "Unknown year: 20x"]) {
    await expect(page.locator("#notices")).toContainText(text);
  }
});

test("embed: a sentence in chart, country, theme or continent is not repeated", async ({ page }) => {
  await page.goto(`/embed.html?chart=${said}&country=${said}&theme=${said}`);
  await expect(page.locator("#notices")).toContainText(`Unknown country: ${NOT_SHOWN}`);
  await expect(page.locator(".embed-problem")).toContainText(`Unknown chart: “${NOT_SHOWN}”`);
  await expectNotEchoed(page);
  await page.goto(`/embed.html?chart=${said}&country=CH`);
  await expect(page.locator(".embed-problem")).toContainText(`Unknown chart: “${NOT_SHOWN}”`);
  await expectNotEchoed(page);
  await page.goto(`/embed.html?chart=origin-apps&continent=${SLUG_SENTENCE}`);
  await expect(page.locator(".embed-problem")).toContainText(`Unknown continent: ${NOT_SHOWN}`);
  await expectNotEchoed(page);
});

test("embed: markup in ?chart= is neither drawn nor repeated", async ({ page }) => {
  await page.goto(`/embed.html?chart=${encodeURIComponent("<b>zorblax</b>")}&country=CH`);
  await expect(page.locator(".embed-problem")).toContainText(`Unknown chart: “${NOT_SHOWN}”`);
  await expect(page.locator("main b")).toHaveCount(0);
  await expectNotEchoed(page);
});

test("dashboard: a sentence in rotate is not repeated; the notice still says it was ignored", async ({ page }) => {
  await page.goto(`/?view=dashboard&rotate=${said}`);
  await expect(page.locator("#notices")).toContainText(`Invalid rotate: ${NOT_SHOWN}`);
  await expect(page.locator(".dashboard .chart-card").first()).toBeVisible();
  await expectNotEchoed(page);
});

test("wallboard: a sentence in slides, theme, chart or rotate is not repeated", async ({ page }) => {
  await page.goto(`/?view=wallboard&slides=${said}&theme=${said}&chart=${said}&rotate=${said}`);
  const notices = page.locator(".board-notices");
  await expect(notices).toContainText(`Unknown slides: ${NOT_SHOWN}`);
  await expect(notices).toContainText(`Invalid rotate: ${NOT_SHOWN}`);
  await expect(page.locator(".board-slot[data-state=ready]").first()).toBeAttached();
  await expectNotEchoed(page);
  // one word per id: the ids are judged together, so the list cannot spell a sentence
  await page.goto(`/?view=wallboard&slides=${LIST_SENTENCE}`);
  await expect(notices).toContainText(`Unknown slides: ${NOT_SHOWN}`);
  await expectNotEchoed(page);
});

test("a slide's entity code is checked against entities.json before its file is fetched", async ({ page }) => {
  const probe = { id: "probe", label: "Probe", params: "chart=origin-apps&country=../../X" };
  await page.route("**/config.json", (route) => route.fulfill({
    json: { ...config, wallboard: { ...config.wallboard, slides: [probe, ...config.wallboard.slides] } } }));
  const fetched: string[] = [];
  page.on("request", (request) => fetched.push(new URL(request.url()).pathname));
  await page.goto("/?view=wallboard&slides=probe");
  await expect(page.getByRole("alert")).toContainText("could not be loaded"); // the slide failed: the board's error UI
  expect(fetched).toContain("/data/entities.json");
  expect(fetched.filter((path) => path.endsWith(".json") && !path.startsWith("/data/") && path !== "/config.json")).toEqual([]);
});

/** A label as the WIPO API could send it once html.unescape'd (pipeline/parse.py): markup with a script handler. */
const HOSTILE = `<img src=x onerror="window.__xss=1">Switzerland`;

test("a data label with markup renders as text and runs nothing", async ({ page }) => {
  await page.route("**/data/entities.json", async (route) => {
    const list: { code: string; label: string }[] = await (await route.fetch()).json();
    await route.fulfill({ json: list.map((item) => item.code === "CH" ? { ...item, label: HOSTILE } : item) });
  });
  await page.route("**/data/entity/CH.json", async (route) => {
    await route.fulfill({ json: { ...(await (await route.fetch()).json()), label: HOSTILE } });
  });
  for (const path of ["/?country=CH", "/embed.html?chart=origin-apps&country=CH"]) {
    await page.goto(path);
    await expect(page.locator("main")).toContainText(HOSTILE);
    await expect(page.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  }
});

const PAGES = ["/", "/methods.html", "/about.html", "/embed.html?chart=world-trend"];

for (const path of PAGES) {
  test(`${path}: the meta CSP is in force: an injected inline script is blocked and reported`, async ({ page, csp }) => {
    await page.goto(path);
    await expect(page.locator("main")).not.toBeEmpty();
    // the probe's own violation is expected; any other still fails the test (fixtures.ts)
    csp.allow(/inline|script-src|TrustedScript|trusted-types/i);
    const ran = await page.evaluate(() => {
      try {
        const script = document.createElement("script");
        script.textContent = "window.__inlineRan = true";
        document.head.append(script);
      } catch { /* Trusted Types refuse the text itself */ }
      return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
    });
    expect(ran).toBe(false);
    // Trusted Types in force: an HTML string into an HTML sink throws
    const htmlSinkRefused = await page.evaluate(() => {
      try { document.createElement("div").innerHTML = "<b>x</b>"; return false; } catch { return true; }
    });
    expect(htmlSinkRefused).toBe(true);
    await expect.poll(() => csp.violations.length).toBeGreaterThan(0);
  });
}
