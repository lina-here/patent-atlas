import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";

// Data versions: the version named in cite text and source lines, and the releases page (`?view=releases`).
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson("site/data/manifest.json");
const releases: { version: string; wipo_releases: Record<string, string>; wdi_last_updated: Record<string, string>; pipeline_sha: string; changed: string[] }[] =
  readJson("site/data/releases.json");
const VERSION_TEXT = `data version ${manifest.version}`;
const NO_VERSIONS = "No data versions recorded yet.";
/** Git tag prefix of a data version (pipeline/releases.py `TAG_PREFIX`, read from its source: no copy kept here). */
const TAG_PREFIX = /^TAG_PREFIX = "([^"]+)"/m.exec(readFileSync("pipeline/releases.py", "utf8"))![1];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The first overview card's cite text. */
async function citeOfFirstCard(page: Page): Promise<string> {
  const card = page.locator(".chart-card").first();
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  return (await card.locator(".cite-text").textContent()) ?? "";
}

test("data files: manifest.version is the newest entry of releases.json", () => {
  expect(manifest.version).toBeTruthy();
  expect(releases[0].version).toBe(manifest.version);
});

test("cite text and source line name the data version", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const card = page.locator(".chart-card").first();
  await expect(card.locator(".source-line")).toContainText(`retrieved ${manifest.retrieved}, ${VERSION_TEXT})`);
  expect(await citeOfFirstCard(page)).toContain(`retrieved ${manifest.retrieved}, ${VERSION_TEXT}.`);
  expect(errors).toEqual([]);
});

test("without manifest.version: no version in cite text or source line, never 'undefined'", async ({ page }) => {
  const errors = trackErrors(page);
  await page.route("**/data/manifest.json", async (route) => {
    const patched = { ...manifest };
    delete patched.version;
    await route.fulfill({ json: patched });
  });
  await page.goto("/");
  const card = page.locator(".chart-card").first();
  await expect(card.locator(".source-line")).toContainText(`retrieved ${manifest.retrieved})`);
  await expect(card.locator(".source-line")).not.toContainText("data version");
  const cite = await citeOfFirstCard(page);
  expect(cite).toContain(`retrieved ${manifest.retrieved}.`);
  expect(cite).not.toMatch(/data version|undefined/);
  expect(errors).toEqual([]);
});

test("embed: disclaimer-only footer, source line names the version", async ({ page }) => {
  await page.goto("/embed.html?chart=world-trend");
  await expect(page.locator(".source-line")).toContainText(VERSION_TEXT);
  await expect(page.locator("footer")).not.toContainText("Data versions");
  await expect(page.locator("footer a")).toHaveCount(0);
});

test("footer links to the data versions on index, methods and about", async ({ page }) => {
  for (const path of ["/", "/methods.html", "/about.html"]) {
    await page.goto(path);
    await expect(page.locator("footer").getByRole("link", { name: "Data versions" })).toHaveAttribute("href", /view=releases/);
  }
  await page.goto("/?theme=paper");
  await expect(page.locator("footer").getByRole("link", { name: "Data versions" })).toHaveAttribute("href", /theme=paper/);
  await page.goto("/methods.html");
  await expect(page.locator("#sources").getByRole("link", { name: "all data versions" })).toHaveAttribute("href", /view=releases/);
  await expect(page.locator("#sources")).toContainText(manifest.version);
});

const config = readJson("site/config.json");
/** Short sha as the page shows it: 7 hex digits, a "-dirty" mark kept. */
const shortSha = (sha: string): string => sha.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1");
/** WDI's own indicator name for a key of `wdi_last_updated` (the manifest names the current ones). */
const wdiName = (indicator: string): string => manifest.wdi_denominators[indicator]?.name ?? indicator;

test("page: every entry is one row, newest first, with releases, vintages, labelled changes and commit", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?view=releases");
  await expect(page.locator("h1")).toHaveText("Data versions");
  const rows = page.locator(".releases-table tbody tr");
  await expect(rows).toHaveCount(releases.length);
  for (const [index, release] of releases.entries()) {
    const row = rows.nth(index);
    await expect(row.locator("th")).toHaveText(release.version);
    for (const text of Object.values(release.wipo_releases)) await expect(row).toContainText(text.replace(/^Last updated:\s*/, ""));
    for (const [indicator, date] of Object.entries(release.wdi_last_updated)) await expect(row).toContainText(`${wdiName(indicator)}: ${date}`);
    await expect(row.locator("code")).toHaveText(shortSha(release.pipeline_sha));
    if (release.pipeline_sha.endsWith("-dirty")) await expect(row.locator("code")).toContainText("-dirty");
    // "all" is shown as a label, not the raw id
    if (release.changed.includes("all")) await expect(row.locator("td").nth(2)).toContainText("Everything");
  }
  // WDI indicator keys are labelled by WDI's own names, not shown raw
  await expect(rows.first()).not.toContainText("gdp_ppp");
  await expect(page.locator("footer")).toContainText("The Secretariat of WIPO");
  expect(errors).toEqual([]);
});

test("page: the lede names the WIPO Statistics Database, every kind of change that cuts a version, and its git tag (final review M1, M2)", async ({ page }) => {
  await page.goto("/?view=releases");
  const lede = page.locator(".lede");
  await expect(lede).toContainText("WIPO Statistics Database");
  await expect(lede).toContainText("World Bank WDI");
  await expect(lede).toContainText("Each time the data, or the code or method that writes them, change");
  await expect(lede).toContainText(`Each version is kept as the git tag ${TAG_PREFIX}<version>`);
  await expect(lede).not.toContainText("figures change");
});

test("page: many entries keep file order; known ids get labels, unknown ids stay raw", async ({ page }) => {
  const patched: unknown[] = [
    { version: "2031-01-02.2", wipo_releases: { ips: "Last updated: May 2031", pmh: "Not the usual wording", constructor: "Last updated: June 2031" }, wdi_last_updated: { gdp_ppp: null, population: "2031-01-01", other_indicator: "2031-01-02" },
      pipeline_sha: "0123456789abcdef", changed: ["origin_apps", "per_gdp", "women_share", "pct_monthly", "manifest", "overview", "constructor", "some_file_stem"] },
    { version: "2031-01-02", wipo_releases: {}, wdi_last_updated: {}, pipeline_sha: "fedcba9876543210-dirty", changed: ["all"] },
  ];
  await page.route("**/data/releases.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/?view=releases");
  const rows = page.locator(".releases-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("th")).toHaveText("2031-01-02.2");
  await expect(rows.nth(1).locator("th")).toHaveText("2031-01-02");
  await expect(rows.nth(0)).toContainText("Patent tab: May 2031");
  await expect(rows.nth(0)).toContainText("PCT tab: Not the usual wording");
  await expect(rows.nth(0)).toContainText("constructor: June 2031"); // not Object's function source
  await expect(rows.nth(0)).toContainText("Patent applications by applicant's origin");
  await expect(rows.nth(0)).toContainText("Women's share of PCT inventors");
  await expect(rows.nth(0)).toContainText("PCT monthly figures");
  await expect(rows.nth(0).locator("li").last()).toHaveText("some_file_stem");
  // stems of the manifest and overview files are labelled; an inherited name stays a raw id
  await expect(rows.nth(0)).toContainText("Data manifest");
  await expect(rows.nth(0)).toContainText("Overview figures");
  await expect(rows.nth(0).locator("li", { hasText: /^constructor$/ })).toHaveCount(1);
  // WDI keys: manifest names for known indicators, raw for unknown
  await expect(rows.nth(0)).toContainText(`${wdiName("gdp_ppp")}: not recorded`);
  await expect(rows.nth(0)).toContainText(`${wdiName("population")}: 2031-01-01`);
  await expect(rows.nth(0)).toContainText("other_indicator: 2031-01-02");
  await expect(rows.nth(0).locator("code")).toHaveText("0123456");
  await expect(rows.nth(1).locator("code")).toHaveText("fedcba9-dirty");
  await expect(page.locator(".releases-table")).not.toContainText(/undefined|null/);
});

test("page: missing releases file shows the empty sentence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/data/releases.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/?view=releases");
  await expect(page.locator(".releases-empty")).toHaveText(NO_VERSIONS);
  await expect(page.locator(".releases-table")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("page: manifest without a version still renders the table", async ({ page }) => {
  await page.route("**/data/manifest.json", async (route) => {
    const patched = { ...manifest };
    delete patched.version;
    await route.fulfill({ json: patched });
  });
  await page.goto("/?view=releases");
  await expect(page.locator(".releases-table tbody tr")).toHaveCount(releases.length);
  await expect(page.locator("main, #app")).not.toContainText("undefined");
});

test("page: an entry without a version, a null entry and non-entries never throw or print 'undefined'", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const patched = [null, 7, "text",
    { wipo_releases: {}, wdi_last_updated: {}, pipeline_sha: "abcdef0123", changed: ["all"] },
    { version: "2031-01-02", wipo_releases: {}, wdi_last_updated: {}, pipeline_sha: "abcdef0123", changed: ["all"] }];
  await page.route("**/data/releases.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/?view=releases");
  const rows = page.locator(".releases-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("th")).toHaveText("(entry without version)");
  await expect(rows.nth(1).locator("th")).toHaveText("2031-01-02");
  await expect(page.locator(".releases-table")).not.toContainText(/undefined|null/);
  expect(errors).toEqual([]);
});

test("page: only non-entries in the file show the empty sentence", async ({ page }) => {
  await page.route("**/data/releases.json", (route) => route.fulfill({ json: [null, 3] }));
  await page.goto("/?view=releases");
  await expect(page.locator(".releases-empty")).toHaveText(NO_VERSIONS);
});

test("page: the changed list has no bullets", async ({ page }) => {
  await page.goto("/?view=releases");
  const list = page.locator(".release-changed").first();
  await expect(list).toHaveCSS("list-style-type", "none");
  await expect(list).toHaveCSS("padding-left", "0px");
});

test("rotation: ?view=releases starts it as the women-inventors view does (header control, no notice)", async ({ page }) => {
  for (const view of ["women-inventors", "releases"]) {
    await page.goto(`/?view=${view}&rotate=${config.rotation.minSeconds}`);
    await expect(page.locator(".rotation-status")).toBeVisible();
    await expect(page.locator(".notice")).toHaveCount(0);
  }
});
