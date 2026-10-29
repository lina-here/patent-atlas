import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { RESIZE_SETTLE_MS, WOMEN_CARD_IDS } from "./siteConstants";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// Header controls: theme switcher and wallboard rotation. Values come from config.json and the theme files.
const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const { minSeconds, resumeAfterSeconds, pauseMovePixels, views }: { minSeconds: number; resumeAfterSeconds: number; pauseMovePixels: number; views: string[] } =
  config.rotation;
const RUN_MS = minSeconds * 1000;
const IDLE_MS = resumeAfterSeconds * 1000;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** `--name: #rrggbb` of a theme file as the rgb() text a browser reports for a computed colour. */
function themeColour(theme: string, name: string): string {
  const css = readFileSync(`site/themes/${theme}.css`, "utf8");
  const hex = new RegExp(`${name}:\\s*#([0-9a-f]{6})`, "i").exec(css)?.[1];
  if (!hex) throw new Error(`${name} not a hex colour in ${theme}.css`);
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const axisLabelFill = (page: Page): Promise<string> =>
  page.locator('.chart-card svg [aria-label$="tick label"] text').first().evaluate((el) => getComputedStyle(el).fill);

const search = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

/** Rotation is armed once the page has built its header: the status element exists. Advancing the page clock before
 * that spends the step on a page whose timer is not yet set (a flake under load); waiting on state needs no timeout. */
const rotationArmed = (page: Page) => expect(page.locator(".rotation-status")).toBeVisible();

/** Advances the paused page clock one view at a time, each after the new page armed its timer, until the address
 * carries every key of `expected`; at most one full round of the views. */
async function rotateUntil(page: Page, expected: URLSearchParams): Promise<void> {
  const reached = (url: URL): boolean => [...expected].every(([key, value]) => url.searchParams.get(key) === value);
  for (let step = 0; step < views.length && !reached(new URL(page.url())); step += 1) {
    await rotationArmed(page);
    const before = page.url();
    await page.clock.runFor(RUN_MS);
    await page.waitForURL((url) => url.href !== before);
  }
  expect(reached(new URL(page.url())), `rotation reached ${expected}`).toBe(true);
}

test("theme switch lists the themes except the embed theme, current one selected", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?theme=paper");
  const select = page.locator("#theme-switch");
  const options = await select.locator("option").allTextContents();
  expect(options).toEqual(config.themes.filter((theme: string) => theme !== config.embedTheme));
  await expect(select).toHaveValue("paper");
  await page.goto("/");
  await expect(select).toHaveValue(config.defaultTheme);
  expect(errors).toEqual([]);
});

test("theme switch navigates with the new ?theme= and keeps other params; charts redraw in the new tokens", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`/?country=CH&year=2000`);
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  expect(await axisLabelFill(page)).toBe(themeColour(config.defaultTheme, "--muted"));
  await page.locator("#theme-switch").selectOption("paper");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/theme=paper/);
  expect(search(page).get("country")).toBe("CH");
  expect(search(page).get("year")).toBe("2000");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  expect(await axisLabelFill(page)).toBe(themeColour("paper", "--muted"));
  expect(errors).toEqual([]);
});

test("header controls exist on methods and about, not on embed", async ({ page }) => {
  for (const url of ["/methods.html", "/about.html"]) {
    await page.goto(url);
    await expect(page.locator("#theme-switch")).toHaveCount(1);
  }
  await page.goto("/embed.html?chart=world-trend");
  await expect(page.locator("#theme-switch")).toHaveCount(0);
});

test("rotation shows the views in turn, wraps round, and keeps theme, rotate and other params", async ({ page }) => {
  const errors = trackErrors(page);
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&theme=paper&year=2000`);
  await expect(page.locator(".rotation-status")).toContainText(`${minSeconds} s`);
  for (let step = 0; step < views.length + 1; step += 1) {
    const expected = new URLSearchParams(views[step % views.length]);
    await rotationArmed(page);
    await page.clock.runFor(RUN_MS);
    await page.waitForURL((url) => [...expected].every(([key, value]) => url.searchParams.get(key) === value));
    const now = search(page);
    expect(now.get("theme")).toBe("paper");
    expect(now.get("rotate")).toBe(String(minSeconds));
    expect(now.get("year")).toBe("2000");
    // only the current view's own keys
    expect([...now.keys()].filter((key) => !["theme", "rotate", "year", ...expected.keys()].includes(key))).toEqual([]);
    await expect(page.locator("main")).not.toBeEmpty();
  }
  expect(errors).toEqual([]);
});

test("rotation reaches the per-million map view and draws it (wallboard)", async ({ page }) => {
  const errors = trackErrors(page);
  const view = views.find((entry) => new URLSearchParams(entry).get("metric") === "per_million");
  expect(view, "a per-million map view in rotation.views").toBeDefined();
  const expected = new URLSearchParams(view);
  expect(expected.get("chart")).toBe("world-map");
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&theme=wallboard`);
  await rotateUntil(page, expected);
  for (const [key, value] of expected) expect(search(page).get(key)).toBe(value);
  expect(search(page).get("rotate")).toBe(String(minSeconds));
  await expect(page.locator('.chart-card[data-chart="world-map"] svg').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("rotation reaches the women-inventors view and draws its page (wallboard)", async ({ page }) => {
  const errors = trackErrors(page);
  const view = views.find((entry) => new URLSearchParams(entry).get("view") === "women-inventors");
  expect(view, "a view=women-inventors entry in rotation.views").toBeDefined();
  const expected = new URLSearchParams(view);
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&theme=wallboard`);
  await rotateUntil(page, expected);
  expect(search(page).get("rotate")).toBe(String(minSeconds));
  await expect(page.locator("h1")).toContainText("Women inventors");
  await expect(page.locator(".chart-card")).toHaveCount(WOMEN_CARD_IDS.length);
  for (const id of WOMEN_CARD_IDS) await expect(page.locator(`.chart-card[data-chart="${id}"]`)).toHaveCount(1);
  await expect(page.locator("html")).toHaveClass(/view-ready/);
  await rotationArmed(page);
  await page.clock.runFor(RUN_MS); // the view after it: the women page's keys do not leak
  await page.waitForURL((url) => url.searchParams.get("view") === null);
  expect(errors).toEqual([]);
});

test("rotation from a page outside the views leaves no page param behind", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&office=EP`);
  await rotationArmed(page);
  await page.clock.runFor(RUN_MS);
  await page.waitForURL(/chart=/);
  expect(search(page).get("office")).toBeNull();
  expect(search(page).get("rotate")).toBe(String(minSeconds));
});

test("any pointer or keyboard use pauses rotation; the resume button restarts it, focus kept off <body>", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await expect(page.locator(".rotation-resume")).toBeHidden();
  await page.mouse.move(200, 300);
  await page.mouse.move(260, 340);
  const resume = page.getByRole("button", { name: /resume rotation/i });
  await expect(resume).toBeVisible();
  await expect(page.locator(".rotation-status")).toHaveText("Rotation paused");
  await page.clock.runFor(RUN_MS * 3);
  expect(search(page).get("chart")).toBeNull();
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(resume).toBeHidden();
  await expect(page.locator(".rotation-status")).toBeFocused();
  await page.clock.runFor(RUN_MS);
  await page.waitForURL(/chart=/);
  await expect(page.locator("main")).not.toBeEmpty();
  // keyboard pauses too
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /resume rotation/i })).toBeVisible();
  await page.clock.runFor(RUN_MS * 3);
  expect(search(page).get("chart")).toBe(new URLSearchParams(views[0]).get("chart"));
});

test("the live region holds the status text alone; the resume button is its sibling", async ({ page }) => {
  await page.goto(`/?rotate=${minSeconds}`);
  const status = page.locator('.rotation-control [role="status"]');
  await expect(status).toHaveCount(1);
  await expect(status).toHaveClass(/rotation-status/);
  await expect(status.locator("button")).toHaveCount(0);
  await expect(page.locator(".rotation-control > button.rotation-resume")).toHaveCount(1);
});

test(`pause ends by itself after resumeAfterSeconds without use; each use restarts that wait`, async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await page.mouse.move(200, 300);
  await page.mouse.move(260, 340);
  await expect(page.locator(".rotation-resume")).toBeVisible();
  await page.clock.runFor(IDLE_MS - 1000);
  await page.keyboard.press("Shift"); // use: the idle wait starts again
  await page.clock.runFor(IDLE_MS - 1000);
  await expect(page.locator(".rotation-resume")).toBeVisible();
  expect(search(page).get("chart")).toBeNull();
  await page.clock.runFor(1000); // idle wait over: rotation runs again
  await expect(page.locator(".rotation-resume")).toBeHidden();
  await expect(page.locator(".rotation-status")).toContainText(`${minSeconds} s`);
  await page.clock.runFor(RUN_MS);
  await page.waitForURL(/chart=/);
});

test("auto-resume while the resume button has focus moves focus to the status, not <body>", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".rotation-resume")).toBeVisible();
  await page.locator(".rotation-resume").focus();
  expect(await page.evaluate(() => document.activeElement?.className)).toBe("rotation-resume");
  await page.clock.runFor(IDLE_MS);
  await expect(page.locator(".rotation-resume")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.className)).toContain("rotation-status");
});

test("rotation replaces the history entry instead of adding one per view", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  const before = await page.evaluate(() => history.length);
  for (let step = 0; step < 2; step += 1) {
    await rotationArmed(page);
    await page.clock.runFor(RUN_MS);
    await page.waitForURL((url) => url.search.includes(`chart=${new URLSearchParams(views[step]).get("chart")}`));
  }
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("rotation and theme switch link from the checked params: invalid raw values are not carried along", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&year=20x&map=sphere&theme=paper`);
  await expect(page.locator("#notices")).toContainText("Unknown year: 20x");
  await page.clock.runFor(RUN_MS);
  await page.waitForURL(/chart=/);
  expect(search(page).get("year")).toBeNull();
  expect(search(page).get("map")).toBeNull();
  expect(search(page).get("theme")).toBe("paper");
  await expect(page.locator("#notices")).toBeHidden();

  await page.goto("/?year=20x&theme=neon&country=CH");
  await page.locator("#theme-switch").selectOption("paper");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/theme=paper/);
  expect(search(page).get("year")).toBeNull();
  expect(search(page).get("country")).toBe("CH");
  await expect(page.locator("#notices")).toBeHidden();
});

for (const bad of ["0", "-5", "abc", String(minSeconds - 1), "20.5", "99999999999", "1e3"]) {
  test(`invalid rotate=${bad}: notice, no rotation, page renders`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.clock.install();
    await page.goto(`/?rotate=${bad}`);
    await expect(page.locator("#notices")).toContainText(`Invalid rotate: ${bad}`);
    await expect(page.locator("#notices")).toContainText(`at least ${minSeconds}`);
    await expect(page.locator(".rotation-status")).toHaveCount(0);
    await expect(page.locator("main")).not.toBeEmpty();
    await page.clock.runFor(RUN_MS * 3);
    expect(search(page).get("chart")).toBeNull();
    expect(errors).toEqual([]);
  });
}

test("reduced motion: no transition between views", async ({ page }) => {
  await page.clock.install();
  const animationName = (): Promise<string> => page.locator("main.page").evaluate((el) => getComputedStyle(el).animationName);
  await page.goto(`/?rotate=${minSeconds}&theme=wallboard`);
  await expect(page.locator("html")).toHaveClass(/view-ready/);
  expect(await animationName()).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await animationName()).toBe("none");
});

test("cite link at ?country=CH&year=2000 keeps both; bad new params are dropped with notices", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?country=CH&year=2000&region=154&continent=europe&map=continent&metric=office_apps&rotate=30");
  await expect(page.locator("#notices")).toBeHidden();
  const card = page.locator('.chart-card[data-chart="origin-apps"]');
  await card.getByRole("button", { name: "Cite this", exact: true }).click();
  const link = await card.locator(".cite-text").textContent();
  const cited = new URL(/https?:\/\/\S+?(?=\.\s)/.exec(link ?? "")?.[0] ?? "");
  expect(Object.fromEntries(cited.searchParams)).toMatchObject({
    country: "CH", year: "2000", region: "154", continent: "europe", map: "continent",
    metric: "office_apps", chart: "origin-apps",
  });
  expect(cited.searchParams.has("rotate")).toBe(false); // a cite link must not rotate away from the cited chart
  await card.getByRole("button", { name: "Embed", exact: true }).click();
  const embed = await card.locator(".embed-snippet").textContent();
  const embedSrc = new URL(/src="([^"]+)"/.exec(embed ?? "")?.[1].replaceAll("&amp;", "&") ?? "");
  expect(Object.fromEntries(embedSrc.searchParams)).toMatchObject({
    country: "CH", year: "2000", region: "154", continent: "europe", map: "continent",
    metric: "office_apps", chart: "origin-apps",
  });
  expect(embedSrc.searchParams.has("rotate")).toBe(false);

  await page.goto("/?region=abc&continent=A_B&map=sphere&metric=gold&year=20x&view=!!"); // "!!" is outside params.ts ECHO_SAFE: not repeated
  const notices = page.locator("#notices");
  for (const text of ["Unknown region: abc", "Unknown continent: A_B", "Unknown map mode: sphere", "Unknown metric: gold", "Unknown year: 20x", "Unknown view: (not shown)"]) {
    await expect(notices).toContainText(text);
  }
  // a card without state of its own (the map's cite link carries its metric and year)
  const first = page.locator('.chart-card[data-chart="world-trend"]');
  await first.getByRole("button", { name: "Cite this", exact: true }).click();
  const dropped = await first.locator(".cite-text").textContent();
  for (const key of ["region", "continent", "map", "metric", "year", "view"]) expect(dropped).not.toContain(`${key}=`);
  expect(errors).toEqual([]);
});

test("theme switch is committed by Apply, never by arrow keys: keyboard reaches wallboard from atlas", async ({ page }) => {
  await page.goto("/");
  const select = page.locator("#theme-switch");
  await expect(select).toHaveValue("atlas");
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await select.focus();
  await page.keyboard.type("w"); // type-ahead; the arrow keys open the list on macOS Chromium
  await expect(select).toHaveValue("wallboard");
  expect(new URL(page.url()).search).toBe(""); // choosing alone navigates nowhere
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Apply" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL(/theme=wallboard/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "wallboard");
});

test("switching to the default theme leaves ?theme= out", async ({ page }) => {
  await page.goto("/?theme=paper&country=CH");
  await page.locator("#theme-switch").selectOption(config.defaultTheme);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL((url) => !url.searchParams.has("theme") && url.searchParams.get("country") === "CH");
});

test("current theme = embed theme: still offered and selected", async ({ page }) => {
  await page.goto(`/?theme=${config.embedTheme}`);
  const select = page.locator("#theme-switch");
  await expect(select).toHaveValue(config.embedTheme);
  expect(await select.locator("option").allTextContents()).toContain(config.embedTheme);
});

test("navigation links carry only the theme; the picker's carry the theme and their target", async ({ page }) => {
  await page.goto("/?region=154&map=continent&rotate=30&year=2000&theme=paper");
  await expect(page.locator(".site-nav a").first()).toBeVisible(); // evaluateAll does not wait: the header is drawn by script
  const hrefs = await page.locator(".brand, .site-nav a, .footer-links a").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThanOrEqual(5);
  // the "Data versions", "Conference wallboard" and "Dashboard" links name their page by `view`; no figure state travels with any link
  for (const href of hrefs) {
    const keys = [...new URL(href, "http://x/").searchParams.keys()];
    expect(keys, href).toEqual(/view=(releases|wallboard|dashboard)/.test(href) ? ["theme", "view"] : ["theme"]);
  }
  await page.locator(".picker input").fill("Switzerland");
  const picked = await page.locator(".picker-option").first().getAttribute("data-href");
  expect(Object.fromEntries(new URL(picked ?? "", "http://x/").searchParams)).toEqual({ theme: "paper", country: "CH" });
});

test("rotate on methods and about: ignored with a notice, nothing rotates, theme switch drops it", async ({ page }) => {
  for (const url of ["/methods.html", "/about.html"]) {
    await page.clock.install();
    await page.goto(`${url}?rotate=${minSeconds}`);
    await expect(page.locator("#notices")).toContainText("overview page only");
    await expect(page.locator(".rotation-control")).toHaveCount(0);
    await page.clock.runFor(RUN_MS * 2);
    expect(new URL(page.url()).pathname).toBe(url);
  }
  await page.locator("#theme-switch").selectOption("paper");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/theme=paper/);
  expect(search(page).has("rotate")).toBe(false);
});

test("valid rotate with no views configured: notice, no rotation", async ({ page }) => {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.rotation.views = [];
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator("#notices")).toContainText("no views configured");
  await expect(page.locator(".rotation-control")).toHaveCount(0);
  await expect(page.locator("main")).not.toBeEmpty();
});

test("the page stays hidden until its view is drawn, then fades in", async ({ page }) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/data/overview.json", async (route) => {
    await held; // the view cannot be drawn until the test lets its data through
    await route.continue();
  });
  await page.goto(`/?rotate=${minSeconds}&theme=wallboard`, { waitUntil: "domcontentloaded" });
  const html = page.locator("html");
  const main = page.locator("main.page");
  await expect(html).toHaveClass(/rotating/);
  await expect(main).toHaveCSS("opacity", "0");
  await expect(html).not.toHaveClass(/view-ready/);
  release();
  await expect(html).toHaveClass(/view-ready/);
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await expect(main).toHaveCSS("opacity", "1");
  expect(await main.evaluate((el) => getComputedStyle(el).animationName)).toBe("rotate-in");
});

test("rotation with a chart view shows that card alone, full width; otherwise the whole overview", async ({ page }) => {
  await page.goto(`/?rotate=${minSeconds}&chart=top-origins`);
  const cards = page.locator(".chart-card");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("data-chart", "top-origins");
  await expect(page.locator(".hero")).toHaveCount(0);
  await expect(page.locator(".site-header")).toBeInViewport(); // the lone card is not scrolled over the header
  await expect(cards.locator("svg").first()).toBeVisible();
  const grid = (await page.locator("#charts").boundingBox())!;
  const card = (await cards.boundingBox())!;
  expect(card.width).toBeGreaterThanOrEqual(grid.width - 1);

  await page.goto(`/?rotate=${minSeconds}&chart=nope`);
  await expect(page.locator(".chart-card").nth(1)).toBeVisible(); // drawn: more than the one card of a chart view
  expect(await page.locator(".chart-card").count()).toBeGreaterThan(1);
  await page.goto("/?chart=top-origins");
  await expect(page.locator(".chart-card svg").first()).toBeVisible(); // drawn first: before the render there are 0 cards
  expect(await page.locator(".chart-card").count()).toBeGreaterThan(1);
  await expect(page.locator(".hero")).toHaveCount(1);
});

test("methods page names the wallboard minimum, resume delay and view count from config", async ({ page }) => {
  await page.goto("/methods.html");
  const text = page.locator("#wallboard");
  await expect(text).toContainText(`at least ${minSeconds}`);
  await expect(text).toContainText(`${resumeAfterSeconds} seconds without use`);
  await expect(text).toContainText(`${views.length} views`);
});

test("focus layout has one h1 (site name and card title), visually hidden", async ({ page }) => {
  await page.goto(`/?rotate=${minSeconds}&chart=top-origins`);
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  const h1 = page.locator("h1");
  await expect(h1).toHaveCount(1);
  const title = await page.locator(".chart-card h2").textContent();
  await expect(h1).toHaveText(`${config.siteName}: ${title}`);
  const box = (await h1.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1);
  expect(box.height).toBeLessThanOrEqual(1);
});

test("a throw while the page is built never leaves a rotating page hidden", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
      if (this.id === "site-footer") throw new Error("patched failure");
      return original.apply(this, nodes);
    };
  });
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator("html")).toHaveClass(/view-ready/);
  await expect(page.locator("main.page")).toHaveCSS("opacity", "1");
});

test("an invalid resumeAfterSeconds in config: notice, and a pause lasts until the user resumes", async ({ page }) => {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.rotation.resumeAfterSeconds = minSeconds - 1;
    await route.fulfill({ response, json: body });
  });
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator("#notices")).toContainText("rotation.resumeAfterSeconds");
  await expect(page.locator(".rotation-status")).toBeVisible();
  await page.mouse.move(200, 300);
  await page.mouse.move(300, 400);
  await expect(page.locator(".rotation-resume")).toBeVisible();
  await page.clock.runFor(IDLE_MS * 3);
  await expect(page.locator(".rotation-resume")).toBeVisible();
  expect(search(page).get("chart")).toBeNull();
  await page.locator(".rotation-resume").click();
  await expect(page.locator(".rotation-resume")).toBeHidden();
});

test("after a resume, pointer jitter does not pause again; real movement, keys and clicks do", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}`);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await page.mouse.move(200, 300);
  await page.mouse.move(400, 500);
  const resume = page.locator(".rotation-resume");
  await expect(resume).toBeVisible();
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(resume).toBeHidden();
  const jitter = Math.max(1, Math.floor(pauseMovePixels / 8));
  for (let step = 1; step <= 3; step += 1) await page.mouse.move(400 + step * jitter, 500);
  await expect(resume).toBeHidden();
  await page.mouse.move(400 + pauseMovePixels * 4, 500 + pauseMovePixels * 4);
  await expect(resume).toBeVisible();
  // a click pauses at once
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(resume).toBeHidden();
  await page.mouse.down();
  await expect(resume).toBeVisible();
  await page.mouse.up();
});

test("the address rewrite for a wrong-kind code is built from the checked params", async ({ page }) => {
  await page.goto("/?office=CH&theme=neon&year=20x&rotate=5");
  await expect(page.locator("h1")).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("?country=CH");
});

test("page links take the checked theme: an unknown or default one is not passed on", async ({ page }) => {
  for (const query of ["?theme=neon", `?theme=${config.defaultTheme}`]) {
    for (const url of ["/", "/about.html"]) {
      await page.goto(`${url}${query}`);
      const hrefs = await page.locator(".brand, .site-nav a, .footer-links a").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
      expect(hrefs.length).toBeGreaterThanOrEqual(5);
      for (const href of hrefs) expect(href, `${url}${query}`).not.toContain("theme=");
    }
  }
  await page.goto("/about.html?theme=neon");
  await expect(page.locator(".cite-example")).not.toContainText("theme=");
  // positive: a checked non-default theme is passed on by every internal page link
  for (const url of ["/", "/about.html"]) {
    await page.goto(`${url}?theme=paper`);
    const links = await page.locator(".brand, .site-nav a, .footer-links a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const href of links) expect(new URL(href, "http://x/").searchParams.get("theme"), `${url} ${href}`).toBe("paper");
  }
});

/** Opens `/?rotate=` with `rotation` fields of config.json overridden. */
async function gotoWithRotationConfig(page: Page, path: string, override: Record<string, unknown>): Promise<void> {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.rotation, override);
    await route.fulfill({ response, json: body });
  });
  await page.goto(path);
}

/** The light one-card rotation view, drawn, its clock then frozen: data loaded, the rotation timer can never fire mid-test
 * (`location.replace` would swap the page under the next move). Time moves only by `page.clock.runFor`. */
const ROTATING_CARD = `/?rotate=${minSeconds}&chart=world-trend`;
async function frozenOnceReady(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveClass(/view-ready/);
  await page.clock.pauseAt(Date.now() + 1000);
}

const syntheticMove = (page: Page, movementX: number, movementY: number): Promise<void> =>
  page.evaluate(([x, y]) => { document.dispatchEvent(new PointerEvent("pointermove", { movementX: x, movementY: y, bubbles: true })); }, [movementX, movementY]);

test("pauseMovePixels: movement under it does not pause; an invalid value is reported and any movement pauses", async ({ page }) => {
  await page.clock.install();
  await page.goto(ROTATING_CARD);
  await frozenOnceReady(page);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await syntheticMove(page, 1, 0);
  await expect(page.locator(".rotation-resume")).toBeHidden();
  await syntheticMove(page, pauseMovePixels, 0);
  await expect(page.locator(".rotation-resume")).toBeVisible();
});

test("paused rotation: a pointermove without travel (layout shifted under a still pointer) does not restart the auto-resume wait", async ({ page }) => {
  await page.clock.install();
  await page.goto(ROTATING_CARD);
  await frozenOnceReady(page);
  await expect(page.locator(".rotation-status")).toBeVisible();
  await syntheticMove(page, pauseMovePixels, 0);
  await expect(page.locator(".rotation-resume")).toBeVisible();
  await page.clock.runFor(IDLE_MS - 1000);
  await syntheticMove(page, 0, 0);
  await page.clock.runFor(1000);
  await expect(page.locator(".rotation-resume")).toBeHidden();
});

for (const bad of [-1, "x", null]) {
  test(`an invalid pauseMovePixels in config (${JSON.stringify(bad)}): notice, any movement pauses`, async ({ page }) => {
    await page.clock.install();
    await gotoWithRotationConfig(page, ROTATING_CARD, { pauseMovePixels: bad });
    await frozenOnceReady(page);
    await expect(page.locator("#notices")).toContainText("rotation.pauseMovePixels");
    await expect(page.locator(".rotation-status")).toBeVisible();
    await syntheticMove(page, Number.NaN, Number.NaN); // no usable travel: not use
    await expect(page.locator(".rotation-resume")).toBeHidden();
    await syntheticMove(page, 1, 0);
    await expect(page.locator(".rotation-resume")).toBeVisible();
  });
}

test("methods page: pointer-movement sentence from config; omitted when pauseMovePixels is invalid", async ({ page }) => {
  await page.goto("/methods.html");
  await expect(page.locator("#wallboard")).toContainText(`under ${pauseMovePixels} pixels do not pause`);
  await page.unroute("**/config.json");
  await gotoWithRotationConfig(page, "/methods.html", { pauseMovePixels: "x" });
  await expect(page.locator("#wallboard")).toContainText(`at least ${minSeconds}`);
  await expect(page.locator("#wallboard")).not.toContainText("pixels");
});

test("methods page: no auto-resume sentence when resumeAfterSeconds is invalid", async ({ page }) => {
  await gotoWithRotationConfig(page, "/methods.html", { resumeAfterSeconds: minSeconds - 1 });
  const text = page.locator("#wallboard");
  await expect(text).toContainText("Resume rotation");
  await expect(text).not.toContainText("without use");
  await expect(text).not.toContainText("restarts by itself");
});

// Wallboard: every rotation view that shows one chart (`chart=<id>`, the focus layout) must fit the screen without a page
// scroll, at the sizes the wallboard runs at. Country views are whole pages (many cards) and scroll by design.
const chartViews = views.filter((view) => new URLSearchParams(view).has("chart"));
for (const { wide, suffix } of FONT_VARIANTS) for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 900 }, { width: 1366, height: 768 }]) {
  test(`every rotation chart view fits ${size.width}x${size.height} without vertical overflow${suffix}`, async ({ page }) => {
    expect(chartViews.length).toBeGreaterThan(0);
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    for (const view of chartViews) {
      for (const theme of config.themes.filter((name: string) => name !== config.embedTheme)) {
        await page.goto(`/?rotate=${minSeconds}&theme=${theme}&${view}`);
        await expect(page.locator("html.view-ready")).toHaveCount(1);
        await expect(page.locator("main .chart-card")).toHaveCount(1);
        if (wide) await expectWideFonts(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
        expect(overflow, `${view} (${theme}) overflows the viewport by ${overflow} px`).toBeLessThanOrEqual(0);
      }
    }
  });
}

test("rotation views include the four new overview charts", () => {
  for (const id of ["rank-race", "continent-share", "size-growth", "pct-monthly"]) expect(chartViews).toContain(`chart=${id}`);
});

// A resize in fit mode redraws each chart and fits it again; the redraw must not set off further redraws (the chart's height
// changes the card's size, which the resize observer sees). Redraws counted = chart SVGs replaced after the resize.
const MAX_REDRAWS_PER_RESIZE = 4; // one pass replaces the chart twice (full height, then fitted); one more pass of slack

/** Waits for the next rendering step, where resize observers report (a new observer reports once; page.clock fakes
 * requestAnimationFrame, so it cannot be the signal). Observers report in creation order: the page's come first. */
const nextRendering = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => {
  const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
  observer.observe(document.documentElement);
}));

/** `count` settle periods on the paused page clock, each after a rendering step (a redraw's resize is observed there and
 * schedules the next redraw on the clock). */
async function settlePeriods(page: Page, count: number): Promise<void> {
  for (let period = 0; period < count; period += 1) {
    await nextRendering(page);
    await page.clock.runFor(RESIZE_SETTLE_MS);
  }
  await nextRendering(page);
}
test("wallboard focus: a resize settles, the redraw count after one resize is bounded", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  // Install before goto, never after: the page's debounce cancels its pending settle timer with clearTimeout, and
  // Playwright's fake clearTimeout ignores timers created before install (native ids). Installed after goto, that
  // timer would still fire in real time: one extra pass, redraws 4 -> 6. Installed first, no native timer exists.
  // The clock runs freely until paused before the resize.
  await page.clock.install();
  await page.goto(`/?rotate=${minSeconds}&theme=wallboard&chart=rank-race`);
  await expect(page.locator("html.view-ready")).toHaveCount(1);
  await expect(page.locator("main .chart-card svg").first()).toBeVisible();
  await page.evaluate(() => {
    const counter = window as unknown as { redraws: number };
    counter.redraws = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (node instanceof SVGElement && (record.target as Element).classList.contains("chart-figure")) counter.redraws += 1;
      }
    }).observe(document.querySelector("main") as HTMLElement, { childList: true, subtree: true });
  });
  // from here the clock is paused and moved one settle period at a time
  // 1 s ahead (far below rotation minSeconds): pauseAt throws "Cannot fast-forward to the past" if the page clock
  // has already passed the instant when the command lands, as under CI load with a margin of one settle period
  await page.clock.pauseAt(Date.now() + 1000);
  await settlePeriods(page, 4); // load-time timers due: none left pending before the resize
  const redraws = (): Promise<number> => page.evaluate(() => (window as unknown as { redraws: number }).redraws);
  const before = await redraws();
  await page.setViewportSize({ width: 1300, height: 740 });
  await settlePeriods(page, 4); // several settle periods: a redraw loop would keep counting
  const settled = (await redraws()) - before;
  expect(settled).toBeGreaterThan(0); // the resize did redraw
  await settlePeriods(page, 4);
  expect((await redraws()) - before).toBe(settled);
  expect(settled).toBeLessThanOrEqual(MAX_REDRAWS_PER_RESIZE);
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
});
