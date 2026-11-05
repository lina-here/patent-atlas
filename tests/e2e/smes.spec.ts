import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// SMEs and patents page (`?view=smes`, smePage.ts) and its dashboard panel. Every expected value, label and link is read
// from site/sme/policies.json; nothing is typed here.
type Fee = { category: string; reduction_pct: number | null; as_published: string; fees: string; since: string | null; source_url: string; as_published_lang?: string };
type Office = { code: string; name: string; short: string; definitions: { category: string; text: string; source_url: string }[];
  fee_reductions: Fee[]; support: { name: string; text: string; url: string }[] };
type Share = { id: string; year: number; scope: string; rows: { label: string; pct: number }[]; citation: string; page: string; url: string; note?: string };
type Policies = { checked_on: string; offices: Office[]; shares: Share[]; resources: { title: string; publisher: string; text: string; url: string }[] };

const policies: Policies = JSON.parse(readFileSync("site/sme/policies.json", "utf8"));
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const DISCLAIMER = /^export const DISCLAIMER =\s*"([^"]+)";/m.exec(readFileSync("site/src/provenance.ts", "utf8"))![1];
const smeSource = readFileSync("site/src/smePage.ts", "utf8");
/** The dashboard panel's share and row (smePage.ts constants). */
const TILE_SHARE = /^export const SME_TILE_SHARE = "([^"]+)";/m.exec(smeSource)![1];
const TILE_ROW = /^export const SME_TILE_ROW = "([^"]+)";/m.exec(smeSource)![1];
const LANG_NAMES: Record<string, string> = { ko: "Korean", zh: "Chinese" };

const SMES = "/?view=smes";
const pct = (value: number): string => `${value}%`;
const clone = (): Policies => JSON.parse(JSON.stringify(policies));

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function servePolicies(page: Page, data: unknown): Promise<void> {
  await page.route("**/sme/policies.json", (route) => route.fulfill({ json: data }));
}

async function openSmes(page: Page, search = ""): Promise<void> {
  await page.goto(`${SMES}${search}`);
  await expect(page.locator("h1")).toHaveText("SMEs and patents");
  await expect(page.locator(".sme-fee-table")).toBeAttached();
}

for (const theme of config.themes as string[]) {
  test(`?view=smes renders in theme ${theme}: title, sections, checked date, disclaimer, no errors`, async ({ page }) => {
    const errors = trackErrors(page);
    await openSmes(page, `&theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveClass(/theme-ready/);
    for (const id of ["sme-shares", "sme-fees", "sme-definitions", "sme-support", "sme-resources"]) {
      await expect(page.locator(`section#${id} > h2`), id).toBeVisible();
    }
    await expect(page.locator(".page-intro .lede")).toContainText(policies.checked_on);
    await expect(page.locator(".sme-checked")).toContainText(policies.checked_on);
    await expect(page.locator("footer")).toContainText(DISCLAIMER);
    expect(errors).toEqual([]);
  });
}

test("intro names the IP5 offices from the data; headings never rank them", async ({ page }) => {
  await openSmes(page);
  const lede = page.locator(".page-intro .lede");
  await expect(lede).toContainText("IP5");
  for (const office of policies.offices) await expect(lede).toContainText(office.short);
  await expect(page.locator("#sme-fees > h2")).toHaveText("Fee reductions for SMEs at the IP5 offices");
  await expect(page.locator("main")).not.toContainText("five largest offices");
});

test("wording claims no more than the data: no typed counts, no per-row definition or office-wording promise", async ({ page }) => {
  await openSmes(page);
  const main = page.locator("main");
  // the number of share sources and of matched definitions follows the data
  await expect(main).not.toContainText(/\b(two|three|four|five) published/i);
  await expect(main).not.toContainText("each row shows that office's own");
  await expect(main).not.toContainText("the office's own wording");
  await expect(page.locator("#sme-fees > p")).toContainText("what the office's page states");
  await expect(page.locator("#sme-definitions > p")).toContainText("Summarised from each office's own pages");
  await expect(page.locator("#sme-support > p")).toHaveText("Other help each office lists for smaller applicants, beyond fee reductions.");
});

test("text in Korean or Chinese outside the published wording carries its lang", async ({ page }) => {
  await openSmes(page);
  const hangul = /[\uAC00-\uD7AF\u1100-\u11FF]/;
  const han = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
  for (const office of policies.offices) {
    for (const section of ["sme-definitions", "sme-support"]) {
      const block = page.locator(`#${section} [data-office="${office.code}"]`);
      const text = (await block.textContent()) ?? "";
      if (hangul.test(text)) await expect(block.locator('[lang="ko"]').first(), `${section} ${office.code}`).toBeAttached();
      if (han.test(text)) await expect(block.locator('[lang="zh"], [lang="ko"]').first(), `${section} ${office.code}`).toBeAttached();
      // every Hangul or Han character sits inside an element with a lang
      const bare = await block.evaluate((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const found: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (/[\uAC00-\uD7AF\u1100-\u11FF\u3400-\u4DBF\u4E00-\u9FFF]/.test(node.textContent ?? "") && !node.parentElement?.closest("[lang]")) found.push(node.textContent ?? "");
        }
        return found;
      });
      expect(bare, `${section} ${office.code}`).toEqual([]);
    }
  }
  const korean = page.locator('#sme-definitions [data-office="KR"] [lang="ko"]');
  if (policies.offices.some((office) => office.code === "KR" && office.definitions.some((item) => /[\uAC00-\uD7AF]/.test(item.text)))) {
    expect(await korean.count()).toBeGreaterThan(0);
  }
});

test("header nav: SMEs follows Dashboard, is current on the page and keeps the theme", async ({ page }) => {
  await openSmes(page, "&theme=paper");
  const nav = page.locator(".site-nav a");
  const labels = await nav.allTextContents();
  expect(labels.indexOf("SMEs")).toBe(labels.indexOf("Dashboard") + 1);
  const link = page.locator(".site-nav").getByRole("link", { name: "SMEs", exact: true });
  await expect(link).toHaveAttribute("aria-current", "page");
  const href = new URL((await link.getAttribute("href"))!, page.url());
  expect(href.searchParams.get("view")).toBe("smes");
  expect(href.searchParams.get("theme")).toBe("paper");
  expect(await page.locator(".site-nav").getByRole("link", { name: "Overview", exact: true }).getAttribute("aria-current")).toBeNull();
  await page.goto("/?view=dashboard");
  await expect(page.locator(".site-nav").getByRole("link", { name: "SMEs", exact: true })).not.toHaveAttribute("aria-current", "page");
});

test("fee table (wide): column headers, one row group per office in data order, every row's values from the data", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSmes(page);
  const table = page.getByRole("table", { name: "Fee reductions for SMEs at the IP5 offices" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(5);
  await expect(table.locator("thead th[scope='col']")).toHaveCount(5);
  expect(await table.locator("tbody").evaluateAll((groups) => groups.map((group) => group.getAttribute("data-office"))))
    .toEqual(policies.offices.map((office) => office.code));
  for (const office of policies.offices) {
    const group = table.locator(`tbody[data-office="${office.code}"]`);
    await expect(group.locator("th[scope='rowgroup']")).toContainText(office.short);
    const rows = group.locator("tr");
    await expect(rows).toHaveCount(office.fee_reductions.length);
    for (const [index, fee] of office.fee_reductions.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(fee.category);
      await expect(row).toContainText(fee.fees);
      const reduction = row.locator(".sme-reduction");
      if (fee.reduction_pct === null) await expect(reduction.locator(".sme-pct")).toHaveCount(0);
      else await expect(reduction.locator(".sme-pct")).toHaveText(pct(fee.reduction_pct));
      const published = reduction.locator(".sme-as-published");
      await expect(published.locator("[data-published]")).toHaveText(fee.as_published);
      if (fee.as_published_lang) {
        await expect(published.locator("[data-published]")).toHaveAttribute("lang", fee.as_published_lang);
        await expect(published).toContainText(`(${LANG_NAMES[fee.as_published_lang]})`);
      } else {
        await expect(published.locator("[lang]")).toHaveCount(0);
      }
      if (fee.since) await expect(row).toContainText(fee.since);
      await expect(row.locator(`td.sme-source a[href="${fee.source_url}"]`)).toHaveCount(1);
      const definition = office.definitions.find((item) => item.category === fee.category);
      const qualifies = row.locator(".sme-qualifies");
      if (definition) await expect(qualifies).toContainText(definition.text);
      else await expect(qualifies.getByRole("link", { name: "See source" })).toHaveAttribute("href", fee.source_url);
    }
  }
});

test("phone: the fee rows are cards with visible labels, the table is hidden; wide: the reverse", async ({ page }) => {
  const rowCount = policies.offices.reduce((sum, office) => sum + Math.max(1, office.fee_reductions.length), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await openSmes(page);
  await expect(page.locator(".sme-fee-table")).toBeHidden();
  const cards = page.locator(".sme-fee-card");
  await expect(cards).toHaveCount(rowCount);
  await expect(cards.first()).toBeVisible();
  for (const label of ["Office", "Who qualifies", "Reduction", "Which fees", "Source"]) {
    await expect(cards.first().locator("dt", { hasText: label }).first()).toBeVisible();
  }
  expect(await cards.evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute("data-office")))]))
    .toEqual(policies.offices.map((office) => office.code));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".sme-fee-table")).toBeVisible();
  await expect(cards.first()).toBeHidden();
});

test("who files: each share is its own table; labels, values, bars, note and source from the data", async ({ page }) => {
  await openSmes(page);
  const blocks = page.locator(".sme-share");
  await expect(blocks).toHaveCount(policies.shares.length);
  for (const [index, share] of policies.shares.entries()) {
    const block = blocks.nth(index);
    await expect(block).toHaveAttribute("data-share", share.id);
    const table = block.locator("table");
    await expect(table.locator("caption")).toContainText(share.scope);
    await expect(table.locator("caption")).toContainText(String(share.year));
    await expect(table.locator("thead th[scope='col']")).toHaveCount(2);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(share.rows.length);
    for (const [at, row] of share.rows.entries()) {
      await expect(rows.nth(at).locator("th[scope='row']")).toHaveText(row.label);
      await expect(rows.nth(at).locator(".sme-share-value")).toHaveText(pct(row.pct));
      expect(await rows.nth(at).locator(".sme-bar-fill").evaluate((bar) => (bar as HTMLElement).style.width)).toBe(pct(row.pct));
    }
    if (share.note) await expect(block.locator(".sme-share-note")).toHaveText(share.note);
    else await expect(block.locator(".sme-share-note")).toHaveCount(0);
    const source = block.locator(".sme-share-source");
    await expect(source.getByRole("link", { name: share.citation })).toHaveAttribute("href", share.url);
    await expect(source).toContainText(share.page);
  }
});

test("definitions, other support and resources: every entry from the data, in order", async ({ page }) => {
  await openSmes(page);
  for (const office of policies.offices) {
    const definitions = page.locator(`#sme-definitions [data-office="${office.code}"]`);
    await expect(definitions.locator("h3")).toContainText(office.name);
    expect(await definitions.locator("dt").allTextContents()).toEqual(office.definitions.map((item) => item.category));
    for (const [index, item] of office.definitions.entries()) {
      const dd = definitions.locator("dd").nth(index);
      await expect(dd).toContainText(item.text);
      await expect(dd.locator(`a[href="${item.source_url}"]`)).toHaveCount(1);
    }
    const support = page.locator(`#sme-support [data-office="${office.code}"]`);
    await expect(support.locator("h3")).toContainText(office.name);
    const items = support.locator("li");
    await expect(items).toHaveCount(office.support.length);
    for (const [index, item] of office.support.entries()) {
      await expect(items.nth(index).getByRole("link", { name: item.name, exact: true })).toHaveAttribute("href", item.url);
      await expect(items.nth(index)).toContainText(item.text);
    }
  }
  const resources = page.locator("#sme-resources li");
  await expect(resources).toHaveCount(policies.resources.length);
  for (const [index, item] of policies.resources.entries()) {
    await expect(resources.nth(index).getByRole("link", { name: item.title, exact: true })).toHaveAttribute("href", item.url);
    await expect(resources.nth(index)).toContainText(item.publisher);
    await expect(resources.nth(index)).toContainText(item.text);
  }
});

test("every source link on the page is a URL from the data, and every URL in the data is linked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSmes(page);
  const expected = new Set<string>([
    ...policies.offices.flatMap((office) => [...office.definitions.map((item) => item.source_url), ...office.fee_reductions.map((item) => item.source_url), ...office.support.map((item) => item.url)]),
    ...policies.shares.map((share) => share.url), ...policies.resources.map((item) => item.url),
  ]);
  const external = (await page.locator("main a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")))
    .filter((href) => /^https?:/.test(href));
  expect(external.filter((href) => !expected.has(href))).toEqual([]);
  expect([...expected].filter((url) => !external.includes(url))).toEqual([]);
  // the footer note links to the methods section
  await expect(page.locator(".sme-checked a[href*='methods.html']")).toHaveAttribute("href", /#smes$/);
});

test("empty lists and unmatched categories never leave a blank: the office's own link instead", async ({ page }) => {
  const data = clone();
  const [first, second] = data.offices;
  const firstLink = first.definitions[0].source_url;
  first.fee_reductions = [];
  second.support = [];
  second.definitions = [];
  await servePolicies(page, data);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSmes(page);
  const group = page.locator(`.sme-fee-table tbody[data-office="${first.code}"]`);
  await expect(group.locator("tr")).toHaveCount(1);
  await expect(group).toContainText(`Not covered in this version; see ${first.short}'s website`);
  await expect(group.locator(`a[href="${firstLink}"]`)).toHaveCount(1);
  const support = page.locator(`#sme-support [data-office="${second.code}"]`);
  await expect(support).toContainText(`Not covered in this version; see ${second.short}'s website`);
  await expect(support.locator(`a[href="${second.fee_reductions[0].source_url}"]`)).toHaveCount(1);
  await expect(page.locator(`#sme-definitions [data-office="${second.code}"]`)).toContainText("Not covered in this version");
  // no definition matches a category of the second office now: each row links to its source
  for (const [index, fee] of second.fee_reductions.entries()) {
    const row = page.locator(`.sme-fee-table tbody[data-office="${second.code}"] tr`).nth(index);
    await expect(row.locator(".sme-qualifies").getByRole("link", { name: "See source" })).toHaveAttribute("href", fee.source_url);
  }
});

test("policies.json missing: the page says so, never a blank page", async ({ page }) => {
  await page.route("**/sme/policies.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(SMES);
  await expect(page.locator("h1")).toHaveText("SMEs and patents");
  await expect(page.locator(".sme-missing")).toContainText("could not be loaded");
});

for (const { wide, suffix } of FONT_VARIANTS) for (const size of [{ width: 390, height: 844 }, { width: 1000, height: 900 }, { width: 1440, height: 900 }]) {
  test(`?view=smes fits at ${size.width}x${size.height}: no sideways scroll${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    await openSmes(page);
    if (wide) await expectWideFonts(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const outside = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll<HTMLElement>("main *")].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && el.offsetParent !== null && (box.left < -1 || box.right > width + 1);
      }).map((el) => `${el.tagName}.${el.className}`);
    });
    expect(outside).toEqual([]);
  });
}

for (const { wide, suffix } of FONT_VARIANTS) {
  test(`?view=smes at 1000px: the fee table shows, inside the page, every column at least a few words wide${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width: 1000, height: 900 });
    await openSmes(page);
    if (wide) await expectWideFonts(page);
    const table = page.locator(".sme-fee-table");
    await expect(table).toBeVisible();
    await expect(page.locator(".sme-fee-card").first()).toBeHidden();
    const fit = await table.evaluate((element) => {
      const em = parseFloat(getComputedStyle(element).fontSize);
      const box = element.getBoundingClientRect();
      const columns = [...element.querySelectorAll("thead th")].map((th) => th.getBoundingClientRect().width / em);
      return { right: box.right, page: document.documentElement.clientWidth, columns };
    });
    expect(fit.right).toBeLessThanOrEqual(fit.page);
    // narrowest column (Source: a host name) still holds a short word per line
    for (const width of fit.columns) expect(width).toBeGreaterThanOrEqual(5);
  });
}

// Dashboard panel: its own row, not a chart card; the EPO share row with scope, year and source from the data.
test("dashboard: the SMEs panel shows the share from the data and links to the page", async ({ page }) => {
  const share = policies.shares.find((item) => item.id === TILE_SHARE)!;
  const row = share.rows.find((item) => item.label === TILE_ROW)!;
  await page.goto("/?view=dashboard&theme=paper");
  const panel = page.locator("section.dashboard-sme");
  await expect(panel.locator(".tile-label")).toHaveText(row.label);
  await expect(panel.locator(".tile-value")).toHaveText(pct(row.pct));
  await expect(panel.locator(".sme-tile-scope")).toContainText(share.scope);
  await expect(panel.locator(".sme-tile-scope")).toContainText(String(share.year));
  await expect(panel.locator(".sme-tile-source")).toContainText("Source:");
  await expect(panel.locator(".sme-tile-source").getByRole("link", { name: share.citation })).toHaveAttribute("href", share.url);
  const link = panel.getByRole("link", { name: "Compare SME fee reductions at the IP5 offices" });
  const href = new URL((await link.getAttribute("href"))!, page.url());
  expect(href.searchParams.get("view")).toBe("smes");
  expect(href.searchParams.get("theme")).toBe("paper");
  await expect(panel.locator(".chart-card")).toHaveCount(0);
  await expect(page.locator(".page-intro .lede")).toContainText("The SMEs panel links to a page with patent offices' own figures.");
  // the panel sits after the last tile row
  expect(await page.locator(".dashboard > *").last().evaluate((el) => el.classList.contains("dashboard-sme"))).toBe(true);
});

test("dashboard: policies.json missing: the panel reads – with its reason, the other tiles draw", async ({ page }) => {
  await page.route("**/sme/policies.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/?view=dashboard");
  const panel = page.locator("section.dashboard-sme");
  await expect(panel.locator(".tile-value")).toHaveText("–");
  await expect(panel.locator(".tile-reason")).toContainText("could not be loaded");
  await expect(panel.getByRole("link", { name: "Compare SME fee reductions at the IP5 offices" })).toBeVisible();
  await expect(page.locator(".dashboard-tile > .chart-card")).toHaveCount(7);
});
