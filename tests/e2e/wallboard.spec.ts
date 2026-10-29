import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { BOARD_CONTRAST_COLOURS, BOARD_FALLBACK, BOARD_MIN_CONTRAST, RESIZE_SETTLE_MS, WALLBOARD_KEYS } from "./siteConstants";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// Conference wallboard (?view=wallboard): in-page carousel, keys, controls, failures, fit at TV sizes. Values from
// config.json, the manifest and the key table in wallboard.ts; the page clock drives the interval.
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("site/config.json");
const manifest = readJson("site/data/manifest.json");
const board = config.wallboard;
const slides: { id: string; label: string; params: string }[] = board.slides;
const SLIDE_MS = board.seconds * 1000;
const HIDE_MS = board.hideControlsSeconds * 1000;
const TIMEOUT_MS = board.fetchTimeoutSeconds * 1000;
const STEP_MS = 1000; // a margin past a deadline, well under any interval
/** Before config.json loads the board knows no configured timeout: its default is the fetch timeout and retry delay. */
const BOOT_RETRY_MS = BOARD_FALLBACK.fetchTimeoutSeconds * 1000;
const DISCLAIMER =
  "The Secretariat of WIPO assumes no liability or responsibility with regard to the transformation or translation of the original content.";
const keysFor = (action: string) => WALLBOARD_KEYS.filter((entry) => entry.action === action);
/** Playwright's name of a KeyboardEvent.key. */
const pressName = (key: string): string => (key === " " ? "Space" : key);
const releaseLabel = (release: string) => release.replace(/^Last updated:\s*/i, "").trim();

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const count = (page: Page) => page.locator(".board-count");
const slot = (page: Page) => page.locator(".board-slot:not(.board-slot--pending)");
const at = (page: Page, position: number, total: number) => expect(count(page)).toHaveText(`${position} / ${total}`);
const ready = (page: Page, id: string) => expect(page.locator(`.board-slot[data-slide="${id}"]`)).toHaveAttribute("data-state", "ready");

/** Width in px of an element's left border and its colour equals the element's text colour (an error mark beside the colour). */
const leftRule = (locator: Locator): Promise<number> => locator.evaluate((element) => {
  const style = getComputedStyle(element);
  return style.borderLeftStyle === "solid" && style.borderLeftColor === style.color ? parseFloat(style.borderLeftWidth) : 0;
});

/** Fullscreen and Wake Lock stubs: calls recorded on window; `refuse` = requestFullscreen rejects. */
async function stubPlatform(page: Page, refuse = false): Promise<void> {
  await page.addInitScript((refused) => {
    const w = window as any;
    w.__fullscreenCalls = 0;
    w.__wakeCalls = 0;
    Element.prototype.requestFullscreen = function () {
      w.__fullscreenCalls += 1;
      return refused ? Promise.reject(new TypeError("refused")) : Promise.resolve();
    };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: () => { w.__wakeCalls += 1; return Promise.resolve({ release: () => Promise.resolve() }); } },
    });
  }, refuse);
}

/** The board on the page clock, its first slide drawn. */
async function openBoard(page: Page, query = "", firstId = slides[0].id): Promise<void> {
  await page.clock.install();
  await page.goto(`/?view=wallboard${query}`);
  await ready(page, firstId);
}

test("never navigates: the address is unchanged after two intervals; ?rotate= is the board's interval", async ({ page }) => {
  const errors = trackErrors(page);
  const seconds = config.rotation.minSeconds;
  await openBoard(page, `&rotate=${seconds}`);
  const address = page.url();
  for (let step = 2; step <= 3; step += 1) {
    await page.clock.runFor(seconds * 1000 + STEP_MS);
    await at(page, step, slides.length);
    await ready(page, slides[step - 1].id);
  }
  expect(page.url()).toBe(address);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "wallboard");
  await expect(page.locator("header, footer, nav")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("advances after the configured seconds, not before", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  await at(page, 1, slides.length);
  await page.clock.runFor(SLIDE_MS - 2 * STEP_MS);
  await at(page, 1, slides.length);
  await page.clock.runFor(3 * STEP_MS);
  await at(page, 2, slides.length);
  await expect(page.locator(".board-label")).toHaveText(slides[1].label);
  expect(errors).toEqual([]);
});

test("next and previous keys move one slide each and reset the timer", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  let position = 1;
  for (const entry of keysFor("next")) {
    await page.keyboard.press(pressName(entry.key));
    position += 1;
    await at(page, position, slides.length);
  }
  for (const entry of keysFor("previous")) {
    await page.keyboard.press(pressName(entry.key));
    position -= 1;
    await at(page, position, slides.length);
  }
  await page.keyboard.press(pressName(keysFor("previous")[0].key)); // wraps to the last slide
  await at(page, slides.length, slides.length);
  await ready(page, slides[slides.length - 1].id); // loaded before the clock jumps: a pending fetch would hit its timeout
  // reset: most of an interval passes, a key moves on, the next interval is counted from the key
  await page.clock.runFor(SLIDE_MS - 2 * STEP_MS);
  await page.keyboard.press(pressName(keysFor("next")[0].key));
  await at(page, 1, slides.length);
  await page.clock.runFor(SLIDE_MS - 2 * STEP_MS);
  await at(page, 1, slides.length);
  await page.clock.runFor(3 * STEP_MS);
  await at(page, 2, slides.length);
  expect(errors).toEqual([]);
});

test("pause keys toggle with the Paused badge; paused, the board stays", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  const badge = page.locator(".board-paused");
  await expect(badge).toBeHidden();
  for (const entry of keysFor("pause")) {
    await page.keyboard.press(pressName(entry.key));
    await expect(badge, entry.label).toBeVisible();
    await page.clock.runFor(2 * SLIDE_MS);
    await at(page, 1, slides.length);
    await page.keyboard.press(pressName(entry.key));
    await expect(badge, entry.label).toBeHidden();
  }
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, slides.length);
  expect(errors).toEqual([]);
});

const boardLive = (page: Page) => page.locator(".board > div.visually-hidden[aria-live='polite']");

test("live text: a key move announces the slide, pause and resume keys say Paused and Resumed; an automatic move adds nothing", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  const live = boardLive(page);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, slides.length);
  await expect(live).toHaveText("");
  await page.keyboard.press(pressName(keysFor("next")[0].key));
  await at(page, 3, slides.length);
  await expect(live).toHaveText(`Slide 3 of ${slides.length}: ${slides[2].label}`);
  const pause = pressName(keysFor("pause")[0].key);
  await page.keyboard.press(pause);
  await expect(live).toHaveText("Paused");
  await page.keyboard.press(pause);
  await expect(live).toHaveText("Resumed");
  await ready(page, slides[2].id);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 4, slides.length);
  await expect(live).toHaveText("Resumed");
  expect(errors).toEqual([]);
});

test("a pause mid-slide keeps the time left: the progress bar stands still while paused; resumed, the slide ends after the time left", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  const width = () => page.locator(".board-progress-fill").evaluate((element) => parseFloat((element as HTMLElement).style.width));
  const pause = pressName(keysFor("pause")[0].key);
  await page.clock.runFor(SLIDE_MS / 2);
  await page.keyboard.press(pause);
  await expect(page.locator(".board-paused")).toBeVisible();
  const frozen = await width();
  expect(frozen).toBeGreaterThan(40);
  expect(frozen).toBeLessThan(60);
  for (let interval = 0; interval < 3; interval += 1) {
    await page.clock.runFor(SLIDE_MS);
    expect(await width()).toBe(frozen);
    await at(page, 1, slides.length);
  }
  await page.keyboard.press(pause);
  await page.clock.runFor(SLIDE_MS / 2 - STEP_MS);
  await at(page, 1, slides.length);
  await page.clock.runFor(2 * STEP_MS);
  await at(page, 2, slides.length);
  expect(errors).toEqual([]);
});

test("Space on a focused button acts once; modifier keys are not the board's", async ({ page }) => {
  const errors = trackErrors(page);
  await stubPlatform(page);
  await openBoard(page);
  await page.mouse.move(10, 10);
  await page.mouse.move(200, 200);
  const next = page.locator(".board-controls button[data-action='next']");
  await next.focus();
  await page.keyboard.press("Space");
  await at(page, 2, slides.length);
  await expect(page.locator(".board-paused")).toBeHidden();
  await page.locator("body").focus();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const fullscreen = keysFor("fullscreen")[0].key;
  await page.keyboard.press(`Control+${fullscreen}`);
  await page.keyboard.press(`Control+${pressName(keysFor("next")[0].key)}`);
  await page.keyboard.press(`Alt+${pressName(keysFor("pause")[0].key)}`);
  await at(page, 2, slides.length);
  await expect(page.locator(".board-paused")).toBeHidden();
  expect(await page.evaluate(() => (window as any).__fullscreenCalls)).toBe(0);
  await page.keyboard.press(fullscreen);
  expect(await page.evaluate(() => (window as any).__fullscreenCalls)).toBe(1);
  expect(errors).toEqual([]);
});

test("pointer movement shows the controls and never pauses; they hide after the delay, not while focused", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  const controls = page.locator(".board-controls");
  await expect(controls).toBeHidden();
  await page.mouse.move(10, 10);
  await page.mouse.move(300, 300);
  await expect(controls).toBeVisible();
  await expect(page.locator(".board-paused")).toBeHidden();
  await page.clock.runFor(HIDE_MS + STEP_MS);
  await expect(controls).toBeHidden();
  await page.mouse.move(320, 320);
  await expect(controls).toBeVisible();
  await controls.locator("button").first().focus();
  await page.clock.runFor(2 * HIDE_MS + STEP_MS);
  await expect(controls).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.clock.runFor(2 * HIDE_MS + STEP_MS);
  await expect(controls).toBeHidden();
  // the mouse never paused the board: it moved on with the timer
  await page.clock.runFor(SLIDE_MS);
  await at(page, 2, slides.length);
  expect(errors).toEqual([]);
});

test("full screen refused: notice in the bar, the board runs on; Wake Lock asked at start and when visible again", async ({ page }) => {
  const errors = trackErrors(page);
  await stubPlatform(page, true);
  await openBoard(page);
  expect(await page.evaluate(() => (window as any).__wakeCalls)).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(await page.evaluate(() => (window as any).__wakeCalls)).toBe(2);
  await page.keyboard.press(keysFor("fullscreen")[0].key);
  await expect(page.locator(".board-bar")).toContainText("Full screen was refused");
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, slides.length);
  expect(errors).toEqual([]);
});

test("a slide whose file is missing shows its error slot; the next slide shows", async ({ page }) => {
  await page.route("**/data/map/per_million.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.clock.install();
  await page.goto("/?view=wallboard&slides=map-per-million,world-trend");
  await expect(page.locator(".board-unavailable")).toHaveText("Data unavailable for this chart");
  expect(await leftRule(page.locator(".board-unavailable"))).toBeGreaterThan(0); // not colour alone
  await expect(page.locator(".board-label")).toHaveText(slides.find((slide) => slide.id === "map-per-million")!.label);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await ready(page, "world-trend");
  await expect(page.locator(".board-unavailable")).toHaveCount(0);
});

test("a hanging fetch times out; the rotation continues", async ({ page }) => {
  await page.route("**/data/map/per_million.json", () => {}); // never answered
  await page.clock.install();
  const asked = page.waitForRequest("**/data/map/per_million.json");
  await page.goto("/?view=wallboard&slides=map-per-million,world-trend");
  await asked; // its timeout is armed: the clock may run
  await expect(page.locator(".board-slot")).toHaveAttribute("data-state", "loading");
  await page.clock.runFor(TIMEOUT_MS + STEP_MS);
  await expect(page.locator(".board-unavailable")).toBeVisible();
  await at(page, 1, 2);
  await page.clock.runFor(SLIDE_MS - TIMEOUT_MS);
  await ready(page, "world-trend");
});

test("every slide failing: one error screen, then a retry next cycle", async ({ page }) => {
  await page.route("**/data/overview.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.clock.install();
  await page.goto("/?view=wallboard&slides=world-trend,top-origins");
  await expect(page.locator(".board-unavailable")).toBeVisible();
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await expect(page.locator(".board-error")).toContainText("could not be loaded");
  await expect(page.locator(".board-error")).toHaveCount(1);
  expect(await leftRule(page.locator(".board-error"))).toBeGreaterThan(0);
  await page.unroute("**/data/overview.json");
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await ready(page, "world-trend");
  await expect(page.locator(".board-error")).toHaveCount(0);
  await expect(page.locator(".board-label")).toHaveText(slides.find((slide) => slide.id === "world-trend")!.label);
});

test("quick double Next: the later slide only, its own label and chart", async ({ page }) => {
  const errors = trackErrors(page);
  const ids = ["world-trend", "map-origin", "pct-world-trend"];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/geo/countries-110m.json", async (route) => { await held; await route.continue(); });
  await openBoard(page, `&slides=${ids.join(",")}`, ids[0]);
  const next = pressName(keysFor("next")[0].key);
  await page.keyboard.press(next);
  await page.keyboard.press(next);
  await ready(page, ids[2]);
  release(); // the map's data arrives after: its stale render is dropped
  await page.waitForTimeout(RESIZE_SETTLE_MS * 4);
  await expect(page.locator(".board-slot")).toHaveCount(1);
  await expect(slot(page).locator(".chart-card")).toHaveAttribute("id", ids[2]);
  await expect(page.locator(".map-svg")).toHaveCount(0);
  await expect(page.locator(".board-label")).toHaveText(slides.find((slide) => slide.id === ids[2])!.label);
  expect(errors).toEqual([]);
});

test("bar: the slide's own credits (a per-GDP slide names World Bank WDI), data version, site name, disclaimer", async ({ page }) => {
  const errors = trackErrors(page);
  const perGdp = { id: "test-per-gdp", label: "Per GDP", params: "chart=world-map&metric=per_gdp" };
  await page.route("**/config.json", (route) =>
    route.fulfill({ json: { ...config, wallboard: { ...board, slides: [...slides, perGdp] } } }));
  await openBoard(page, `&slides=world-trend,${perGdp.id}`, "world-trend");
  const bar = page.locator(".board-bar");
  await expect(page.locator(".board-credits")).toHaveText(`Source: WIPO Statistics Database (release ${releaseLabel(manifest.releases.ips)})`);
  await expect(bar).toContainText(`Data version ${manifest.version}`);
  await expect(bar).toContainText(config.siteName);
  await expect(page.locator(".board-disclaimer")).toHaveText(DISCLAIMER);
  await page.keyboard.press(pressName(keysFor("next")[0].key));
  await ready(page, perGdp.id);
  await expect(page.locator(".board-label")).toHaveText(perGdp.label);
  await expect(page.locator(".board-credits")).toContainText("World Bank WDI");
  await expect(page.locator(".board-credits")).toContainText("WIPO Statistics Database (release ");
  expect(errors).toEqual([]);
});

test("bar: a PCT membership slide names WIPO's PCT list with its count and status date, not the Statistics Database", async ({ page }) => {
  const errors = trackErrors(page);
  const pct = readJson("site/data/overview.json").pct_membership;
  const member = { id: "test-pct-member", label: "PCT membership", params: "chart=world-map&metric=pct_member" };
  await page.route("**/config.json", (route) =>
    route.fulfill({ json: { ...config, wallboard: { ...board, slides: [...slides, member] } } }));
  await openBoard(page, `&slides=${member.id}`, member.id);
  await expect(page.locator(".board-credits")).toHaveText(
    `Source: WIPO, PCT Contracting States (${pct.count[pct.last_year]} States on ${pct.status_on})`);
  await expect(page.locator(".board-disclaimer")).toHaveText(DISCLAIMER);
  expect(errors).toEqual([]);
});

test("?slides= keeps the order given, drops duplicates and unknown ids with a notice; all unknown -> every slide", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page, `&slides=${slides[2].id},nope,${slides[0].id},${slides[2].id}`, slides[2].id);
  await at(page, 1, 2);
  await expect(page.locator(".board-notices")).toContainText("Unknown slides: nope");
  await page.keyboard.press(pressName(keysFor("next")[0].key));
  await ready(page, slides[0].id);
  await page.goto("/?view=wallboard&slides=nope,zilch");
  await ready(page, slides[0].id);
  await at(page, 1, slides.length);
  await expect(page.locator(".board-notices")).toContainText("No known slide");
  expect(errors).toEqual([]);
});

/** The page's config.json with wallboard settings changed. */
async function routeBoardConfig(page: Page, changes: Record<string, unknown>): Promise<void> {
  await page.route("**/config.json", (route) => route.fulfill({ json: { ...config, wallboard: { ...board, ...changes } } }));
}

test("keys aimed at a focused map link are the link's: no pause, no advance (Space, Enter)", async ({ page, context }) => {
  const errors = trackErrors(page);
  context.on("page", (popup) => { void popup.close(); }); // the link's own target=_blank
  await openBoard(page, "&slides=map-origin,world-trend", "map-origin");
  const link = page.locator(".board-slot .map-svg a").first();
  await link.focus();
  expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("a");
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.press(key); // each alone: two board presses would pause and resume
    await at(page, 1, 2);
    await expect(page.locator(".board-paused")).toBeHidden();
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Space"); // control: nothing focused, the board's again
  await expect(page.locator(".board-paused")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a held key (repeat events) acts once: no repeated next, pause or full screen", async ({ page }) => {
  const errors = trackErrors(page);
  await stubPlatform(page);
  await openBoard(page);
  const press = (key: string, repeat: boolean) => page.evaluate(
    ([name, again]) => { document.dispatchEvent(new KeyboardEvent("keydown", { key: name as string, repeat: again as boolean, bubbles: true, cancelable: true })); },
    [key, repeat]);
  const next = keysFor("next")[0].key;
  await press(next, false);
  await at(page, 2, slides.length);
  await press(next, true);
  await press(next, true);
  await at(page, 2, slides.length);
  const pause = keysFor("pause")[0].key;
  await press(pause, false);
  await expect(page.locator(".board-paused")).toBeVisible();
  await press(pause, true);
  await press(pause, true);
  await expect(page.locator(".board-paused")).toBeVisible();
  await press(keysFor("fullscreen")[0].key, false);
  await press(keysFor("fullscreen")[0].key, true);
  expect(await page.evaluate(() => (window as any).__fullscreenCalls)).toBe(1);
  expect(errors).toEqual([]);
});

test("manifest.json failing at start: the error screen retries each fetch timeout and the board starts when it serves", async ({ page }) => {
  let manifestRequests = 0;
  await page.route("**/data/manifest.json", (route) => {
    manifestRequests += 1;
    return manifestRequests === 1 ? route.fulfill({ status: 503, body: "down" }) : route.fallback();
  });
  await page.clock.install();
  await page.goto("/?view=wallboard");
  await expect(page.locator(".notice-error")).toBeVisible();
  await expect(page.locator(".board")).toHaveCount(0);
  expect(manifestRequests).toBe(1);
  await page.clock.runFor(TIMEOUT_MS - STEP_MS);
  expect(manifestRequests).toBe(1); // not before the timeout
  await page.clock.runFor(2 * STEP_MS);
  await ready(page, slides[0].id);
  expect(manifestRequests).toBe(2);
  await expect(page.locator(".notice-error")).toHaveCount(0);
});

test("config.json failing at start: the error screen retries each default fetch timeout; the board starts when it serves (final review I1)", async ({ page }) => {
  let requests = 0;
  await page.route("**/config.json", (route) => {
    requests += 1;
    return requests <= 2 ? route.fulfill({ status: 503, body: "down" }) : route.fallback();
  });
  await page.clock.install();
  await page.goto("/?view=wallboard");
  const error = page.locator(".notice-error");
  await expect(error).toBeVisible();
  await expect(page.locator("#app")).toContainText(`Trying again in ${BOARD_FALLBACK.fetchTimeoutSeconds} seconds.`);
  await expect(page.locator("#app")).toContainText(DISCLAIMER);
  expect(requests).toBe(1);
  await page.clock.runFor(BOOT_RETRY_MS - STEP_MS);
  expect(requests).toBe(1); // not before the delay
  await page.clock.runFor(2 * STEP_MS);
  await expect.poll(() => requests).toBe(2);
  await expect(error).toBeVisible();
  await page.clock.runFor(BOOT_RETRY_MS + STEP_MS);
  await ready(page, slides[0].id);
  expect(requests).toBe(3);
  await expect(error).toHaveCount(0);
  await expect(page.locator("header, footer, nav")).toHaveCount(0);
});

test("config.json hanging at start: never a blank screen; the default timeout shows the error, the retry starts the board (final review I1)", async ({ page }) => {
  let requests = 0;
  await page.route("**/config.json", (route) => {
    requests += 1;
    if (requests > 1) return route.fallback(); // the first is never answered
  });
  await page.clock.install();
  const asked = page.waitForRequest("**/config.json");
  await page.goto("/?view=wallboard");
  await asked; // its timeout is armed: the clock may run
  await page.clock.runFor(BOOT_RETRY_MS + STEP_MS);
  await expect(page.locator(".notice-error")).toBeVisible(); // visible: the page is revealed without a theme
  await expect(page.locator(".notice-error")).toContainText(`no answer within ${BOARD_FALLBACK.fetchTimeoutSeconds} s`);
  await page.clock.runFor(BOOT_RETRY_MS + STEP_MS);
  await ready(page, slides[0].id);
  expect(requests).toBe(2);
});

test("a mouse click on a control, then a clicker key: the control bar still hides; a control focused by keyboard keeps it (final review M4)", async ({ page }) => {
  await openBoard(page, "&slides=world-trend,top-origins", "world-trend");
  const board = page.locator(".board");
  const controls = page.locator(".board-controls");
  const nextKey = pressName(keysFor("next").find((entry) => entry.key !== " " && entry.key !== "Enter")!.key);
  await page.mouse.move(10, 10);
  await page.mouse.move(300, 300);
  await controls.locator("button[data-action='next']").click();
  await ready(page, "top-origins");
  await page.keyboard.press(nextKey);
  await ready(page, "world-trend");
  await page.clock.runFor(HIDE_MS + STEP_MS);
  await expect(board).toHaveAttribute("data-idle", "");
  await expect(controls).toBeHidden();
  // focus that did not come from a pointer press (Tab, script) holds the bar up, keys and all
  await page.mouse.move(320, 320);
  await expect(controls).toBeVisible();
  await controls.locator("button[data-action='next']").focus();
  await expect(controls.locator("button[data-action='next']")).toBeFocused();
  await page.keyboard.press(nextKey);
  await ready(page, "top-origins");
  await page.clock.runFor(2 * HIDE_MS + STEP_MS);
  await expect(controls).toBeVisible();
});

test("each full cycle re-reads manifest.json: a new data version reloads the board, the same one does not (final review M6)", async ({ page }) => {
  let manifestRequests = 0;
  let served = manifest;
  await page.route("**/data/manifest.json", (route) => {
    manifestRequests += 1;
    return route.fulfill({ json: served });
  });
  await openBoard(page, "&slides=world-trend,top-origins", "world-trend");
  expect(manifestRequests).toBe(1);
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, 2);
  expect(manifestRequests).toBe(1); // not mid-cycle
  await page.clock.runFor(SLIDE_MS);
  await at(page, 1, 2); // a full cycle
  await expect.poll(() => manifestRequests).toBe(2);
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true); // same version: no reload
  served = { ...manifest, version: `${manifest.version}.9` };
  await page.clock.runFor(2 * SLIDE_MS);
  await expect.poll(() => page.evaluate(() => (window as any).__sameDocument).catch(() => true)).toBeUndefined();
  await ready(page, "world-trend");
  await expect(page.locator(".board-version")).toHaveText(`Data version ${served.version}`);
  expect(page.url()).toContain("view=wallboard");
  expect(page.url()).toContain("slides=world-trend,top-origins");
});

test("the board's boot loads (config.json, manifest.json) bypass the browser cache: a new-version reload gets that version (final re-review N2)", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__cacheModes = {} as Record<string, string>;
    const native = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input instanceof Request ? input.url : input);
      for (const name of ["config.json", "manifest.json"]) {
        if (path.endsWith(name) && !(name in w.__cacheModes)) w.__cacheModes[name] = init?.cache ?? "default";
      }
      return native(input, init);
    };
  });
  await openBoard(page, "&slides=world-trend", "world-trend");
  expect(await page.evaluate(() => (window as any).__cacheModes)).toEqual({ "config.json": "no-store", "manifest.json": "no-store" });
});

test("30 slide changes leave the ResizeObserver and listener counts where they were", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const w = window as any;
    const live = new Set<unknown>();
    const Native = window.ResizeObserver;
    w.ResizeObserver = class extends Native {
      constructor(callback: ResizeObserverCallback) { super(callback); live.add(this); }
      disconnect() { live.delete(this); super.disconnect(); }
    };
    const listeners = new Map<string, number>();
    const track = (name: string, target: EventTarget & { addEventListener: any; removeEventListener: any }) => {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      const seen = new Set<string>();
      let ids = 0;
      const idOf = new WeakMap<object, number>();
      const key = (type: string, fn: any, options: any) => {
        if (!fn) return "";
        if (!idOf.has(fn)) idOf.set(fn, ++ids);
        return `${type}|${idOf.get(fn)}|${typeof options === "object" ? Boolean(options?.capture) : Boolean(options)}`;
      };
      target.addEventListener = (type: string, fn: any, options?: any) => {
        const id = key(type, fn, options);
        if (id && !seen.has(id)) { seen.add(id); listeners.set(`${name}:${type}`, (listeners.get(`${name}:${type}`) ?? 0) + 1); }
        return add(type, fn, options);
      };
      target.removeEventListener = (type: string, fn: any, options?: any) => {
        const id = key(type, fn, options);
        if (id && seen.delete(id)) listeners.set(`${name}:${type}`, (listeners.get(`${name}:${type}`) ?? 1) - 1);
        return remove(type, fn, options);
      };
    };
    track("window", window);
    track("document", document);
    w.__counts = () => ({
      observers: live.size,
      listeners: Object.fromEntries([...listeners].filter(([, n]) => n > 0).sort()),
    });
  });
  await openBoard(page);
  const before = await page.evaluate(() => (window as any).__counts());
  expect(before.observers).toBe(1);
  const next = pressName(keysFor("next")[0].key);
  for (let step = 1; step <= 30; step += 1) {
    await page.keyboard.press(next);
    await ready(page, slides[step % slides.length].id);
  }
  expect(await page.evaluate(() => (window as any).__counts())).toEqual(before);
  await expect(page.locator(".board-slot")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a slide still unsettled at its end is skipped as failed: two in a row -> the error screen, before any timeout", async ({ page }) => {
  await routeBoardConfig(page, { fetchTimeoutSeconds: 10 * board.seconds });
  await page.route("**/data/overview.json", () => {}); // never answered
  await page.clock.install();
  const asked = page.waitForRequest("**/data/overview.json");
  await page.goto("/?view=wallboard&slides=world-trend,top-origins");
  await asked;
  await at(page, 1, 2);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, 2); // the board moved on; the first slide's fetch is still open
  await expect(page.locator(".board-error")).toHaveCount(0);
  await page.clock.runFor(SLIDE_MS);
  await expect(page.locator(".board-error")).toContainText("could not be loaded");
});

test("invalid config values: a notice in the bar for each, the defaults used", async ({ page }) => {
  await routeBoardConfig(page, { seconds: 3, hideControlsSeconds: -1, fetchTimeoutSeconds: "soon", safeAreaPercent: 99 });
  await page.clock.install();
  await page.goto("/?view=wallboard");
  await ready(page, slides[0].id);
  const notices = page.locator(".board-notices");
  for (const key of ["seconds", "hideControlsSeconds", "fetchTimeoutSeconds", "safeAreaPercent"]) {
    await expect(notices).toContainText(`Invalid wallboard.${key} in config.json`);
  }
  await expect(page.locator(".board-notices .board-notice")).toHaveCount(4);
  await expect(page.locator(".board")).toHaveCSS("padding-left", /^[1-9]/);
  await page.clock.runFor(29 * 1000);
  await at(page, 1, slides.length); // the default interval (30 s), not the invalid 3 s
  await page.clock.runFor(2 * STEP_MS);
  await at(page, 2, slides.length);
});

test("an invalid ?rotate= on the board: a notice, the configured interval", async ({ page }) => {
  await openBoard(page, "&rotate=soon");
  await expect(page.locator(".board-notices")).toContainText("default interval used");
  await page.clock.runFor(SLIDE_MS - STEP_MS);
  await at(page, 1, slides.length);
  await page.clock.runFor(2 * STEP_MS);
  await at(page, 2, slides.length);
});

const TV_SIZES = [
  { width: 1920, height: 1080, deviceScaleFactor: 1 },
  { width: 1280, height: 720, deviceScaleFactor: 1 },
  { width: 3840, height: 2160, deviceScaleFactor: 2 },
];

for (const size of TV_SIZES) {
  test.describe(`at ${size.width}x${size.height} dpr ${size.deviceScaleFactor}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.deviceScaleFactor });

    for (const { wide, suffix } of FONT_VARIANTS) test(`every configured slide draws without overflow; every request is the site's own${suffix}`, async ({ page, baseURL }) => {
      test.setTimeout(slides.length * 5000 + 30000);
      if (wide) await useWideFonts(page);
      const errors = trackErrors(page);
      const foreign: string[] = [];
      page.on("request", (request) => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) foreign.push(request.url()); });
      await openBoard(page);
      for (let index = 0; index < slides.length; index += 1) {
        if (index > 0) await page.keyboard.press(pressName(keysFor("next")[0].key));
        const { id } = slides[index];
        await ready(page, id);
        await page.clock.runFor(RESIZE_SETTLE_MS * 2); // the first resize redraw, fitted again
        if (wide) await expectWideFonts(page);
        const fit = await page.evaluate(() => {
          const box = document.querySelector<HTMLElement>(".board-slot")!;
          const card = box.querySelector<HTMLElement>(".chart-card")!.getBoundingClientRect();
          const room = box.getBoundingClientRect();
          const root = document.documentElement;
          return {
            slot: box.scrollHeight <= box.clientHeight && box.scrollWidth <= box.clientWidth,
            card: card.bottom <= room.bottom + 0.5 && card.right <= room.right + 0.5,
            page: root.scrollHeight <= innerHeight && root.scrollWidth <= innerWidth,
            problem: Boolean(box.querySelector(".chart-card--problem, .board-unavailable")),
          };
        });
        expect.soft(fit, id).toEqual({ slot: true, card: true, page: true, problem: false });
      }
      expect(foreign).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

// ---- Slide picker, help, readability, entry (Task 4) ----

const slidesKey = keysFor("slides")[0].key;
const helpKeys = keysFor("help").map((entry) => entry.key);
const pickerDialog = (page: Page) => page.locator('dialog[data-overlay="slides"]');
const helpDialog = (page: Page) => page.locator('dialog[data-overlay="help"]');
/** The key table grouped by action, in table order (what help and methods must list). */
const keyGroups = (): { action: string; labels: string[] }[] => {
  const groups: { action: string; labels: string[] }[] = [];
  for (const entry of WALLBOARD_KEYS) {
    const group = groups.find((candidate) => candidate.action === entry.action);
    if (group) group.labels.push(entry.label); else groups.push({ action: entry.action, labels: [entry.label] });
  }
  return groups;
};

test("picker: a subset in the chosen order, the address follows, no reload; the board restarts at the first chosen slide", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  await page.evaluate(() => { (window as any).__noReload = true; });
  await page.keyboard.press(slidesKey);
  const dialog = pickerDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator(".board-paused")).toBeVisible(); // open pauses
  await expect(dialog.locator("li")).toHaveCount(slides.length);
  await expect(dialog.locator("input:checked")).toHaveCount(slides.length);
  const [first, second, third] = [slides[0], slides[1], slides[2]];
  for (const slide of slides.slice(3)) await dialog.locator(`li[data-slide="${slide.id}"] input`).uncheck();
  await dialog.locator(`li[data-slide="${first.id}"] input`).uncheck();
  // order: third, second (move the third up twice: above second, above first)
  await dialog.locator(`li[data-slide="${third.id}"]`).getByRole("button", { name: /^Up/ }).click();
  await dialog.locator(`li[data-slide="${third.id}"]`).getByRole("button", { name: /^Up/ }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();
  const ids = [third.id, second.id];
  await expect.poll(() => new URL(page.url()).searchParams.get("slides")).toBe(ids.join(","));
  expect(new URL(page.url()).searchParams.get("view")).toBe("wallboard");
  expect(page.url()).toContain(`slides=${ids.join(",")}`); // commas stay readable
  await at(page, 1, 2);
  await ready(page, third.id);
  await expect(page.locator(".board-label")).toHaveText(third.label);
  await expect(page.locator(".board-paused")).toBeHidden(); // running before: running after
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2, 2);
  await ready(page, second.id);
  // the same address, opened fresh, gives the same board
  await page.goto(`/?view=wallboard&slides=${ids.join(",")}`);
  await ready(page, third.id);
  await at(page, 1, 2);
  // reopening lists the shown slides first, in their order, ticked
  await page.keyboard.press(slidesKey);
  await expect(dialog.locator("li").nth(0)).toHaveAttribute("data-slide", third.id);
  await expect(dialog.locator("li").nth(1)).toHaveAttribute("data-slide", second.id);
  await expect(dialog.locator("input:checked")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("picker: Apply with everything ticked in the configured order drops ?slides=; with none ticked it asks for one", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page, `&slides=${slides[1].id}`, slides[1].id);
  await page.keyboard.press(slidesKey);
  const dialog = pickerDialog(page);
  await dialog.locator("input:checked").first().uncheck();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText("Tick at least one slide.");
  expect(await leftRule(dialog.getByRole("alert"))).toBeGreaterThan(0);
  await page.clock.runFor(SLIDE_MS); // still open: still paused
  await expect(page.locator(".board-count")).toHaveText("1 / 1");
  for (const slide of slides) await dialog.locator(`li[data-slide="${slide.id}"] input`).check();
  // rows are in the shown-first order: move the first configured slide back to the top
  const firstUp = dialog.locator(`li[data-slide="${slides[0].id}"]`).getByRole("button", { name: /^Up/ });
  while (await firstUp.isEnabled()) await firstUp.click(); // disabled once the row is on top
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();
  await at(page, 1, slides.length);
  expect(new URL(page.url()).searchParams.has("slides")).toBe(false);
  expect(new URL(page.url()).searchParams.get("view")).toBe("wallboard");
  expect(errors).toEqual([]);
});

test("picker: unknown ids in the address give a notice that Apply clears; unknown ids never reach the picker", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page, `&slides=nope,${slides[1].id}`, slides[1].id);
  await expect(page.locator(".board-notices")).toContainText("Unknown slides: nope");
  await page.keyboard.press(slidesKey);
  const dialog = pickerDialog(page);
  await expect(dialog.locator('li[data-slide="nope"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".board-notices")).not.toContainText("Unknown slides");
  expect(new URL(page.url()).searchParams.get("slides")).toBe(slides[1].id);
  expect(errors).toEqual([]);
});

for (const overlay of [{ name: "picker", dialog: pickerDialog, keys: [slidesKey] }, { name: "help", dialog: helpDialog, keys: helpKeys }]) {
  for (const openKey of overlay.keys) {
    test(`${overlay.name} (${openKey}): open pauses; its key, Esc and Close restore the pause state from before`, async ({ page }) => {
      const errors = trackErrors(page);
      await openBoard(page);
      const dialog = overlay.dialog(page);
      const badge = page.locator(".board-paused");
      for (const pausedBefore of [false, true]) {
        if (pausedBefore) await page.keyboard.press(pressName(keysFor("pause")[0].key));
        for (const how of ["key", "Escape", "Close"]) {
          await page.keyboard.press(openKey);
          await expect(dialog, how).toBeVisible();
          await expect(badge, how).toBeVisible();
          await page.clock.runFor(2 * SLIDE_MS); // open: the board stays
          await at(page, 1, slides.length);
          if (how === "key") await page.keyboard.press(openKey);
          else if (how === "Escape") await page.keyboard.press("Escape");
          else await dialog.getByRole("button", { name: "Close" }).click();
          await expect(dialog, how).toBeHidden();
          if (pausedBefore) await expect(badge, how).toBeVisible(); else await expect(badge, how).toBeHidden();
        }
      }
      // paused before: closing leaves it paused; resume once, and the timer runs again
      await page.keyboard.press(pressName(keysFor("pause")[0].key));
      await expect(badge).toBeHidden();
      await page.clock.runFor(SLIDE_MS + STEP_MS);
      await at(page, 2, slides.length);
      expect(errors).toEqual([]);
    });
  }
}

test("with an overlay open, board keys do nothing and a tick box keeps its Space; the other overlay's key is ignored", async ({ page }) => {
  const errors = trackErrors(page);
  await openBoard(page);
  await page.keyboard.press(slidesKey);
  const dialog = pickerDialog(page);
  const box = dialog.locator("input").first();
  await box.focus();
  await page.keyboard.press("Space"); // the tick box's own
  await expect(box).not.toBeChecked();
  await page.keyboard.press(pressName(keysFor("next")[0].key));
  await page.keyboard.press(helpKeys[0]);
  await expect(helpDialog(page)).toBeHidden();
  await at(page, 1, slides.length);
  await page.keyboard.press(slidesKey); // closes even with a tick box focused
  await expect(dialog).toBeHidden();
  await page.keyboard.press(`Control+${slidesKey}`);
  await expect(dialog).toBeHidden(); // modifiers are never the board's
  expect(errors).toEqual([]);
});

test("the control bar has Slides and Help buttons that open the overlays", async ({ page }) => {
  await openBoard(page);
  await page.mouse.move(10, 10);
  await page.mouse.move(300, 300);
  await page.locator(".board-controls").getByRole("button", { name: "Slides" }).click();
  await expect(pickerDialog(page)).toBeVisible();
  await pickerDialog(page).getByRole("button", { name: "Close" }).click();
  await page.locator(".board-controls").getByRole("button", { name: "Help" }).click();
  await expect(helpDialog(page)).toBeVisible();
});

test("help lists exactly the key table, grouped by action", async ({ page }) => {
  await openBoard(page);
  await page.keyboard.press(helpKeys[helpKeys.length - 1]); // "?" opens it too
  const dialog = helpDialog(page);
  await expect(dialog).toBeVisible();
  const listed = await dialog.locator("dd").allTextContents();
  expect(listed).toEqual(keyGroups().map((group) => group.labels.join(", ")));
  expect(await dialog.locator("dt").count()).toBe(keyGroups().length);
  await expect(dialog).toContainText("Esc");
});

test("help and methods: the Esc note names the overlay keys of the key table", async ({ page }) => {
  const names = [...keysFor("slides"), ...keysFor("help")].map((entry) => entry.label);
  const note = `its own key (${names.slice(0, -1).join(", ")} or ${names[names.length - 1]})`;
  await openBoard(page);
  await page.keyboard.press(helpKeys[0]);
  await expect(helpDialog(page)).toContainText(note);
  await page.goto("/methods.html");
  await expect(page.locator("#wallboard")).toContainText(note);
});

test("focus returns to the opener after Close, Esc and the overlay's key", async ({ page }) => {
  await openBoard(page);
  await page.mouse.move(10, 10);
  await page.mouse.move(300, 300);
  for (const [button, dialog] of [["Slides", pickerDialog(page)], ["Help", helpDialog(page)]] as const) {
    const opener = page.locator(".board-controls").getByRole("button", { name: button });
    for (const how of ["Close", "Escape", "key"]) {
      await opener.focus();
      await page.keyboard.press("Enter"); // the focused button acts on Enter, once
      await expect(dialog, `${button} ${how}`).toBeVisible();
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `${button} ${how}: focus inside while open`).toBe(true);
      if (how === "Close") await dialog.getByRole("button", { name: "Close" }).click();
      else if (how === "Escape") await page.keyboard.press("Escape");
      else await page.keyboard.press(button === "Slides" ? slidesKey : helpKeys[0]);
      await expect(dialog, `${button} ${how}`).toBeHidden();
      await expect(opener, `${button} ${how}: focus back on the opener`).toBeFocused();
    }
  }
});

test("picker: edits not applied are discarded on Close and on Esc", async ({ page }) => {
  await openBoard(page);
  const dialog = pickerDialog(page);
  const state = () => dialog.locator("li").evaluateAll((rows) => rows.map((row) =>
    `${row.getAttribute("data-slide")}:${(row.querySelector("input") as HTMLInputElement).checked}`));
  await page.keyboard.press(slidesKey);
  const before = await state();
  expect(before).toEqual(slides.map((slide) => `${slide.id}:true`));
  for (const how of ["Close", "Escape"]) {
    if (how === "Close") await expect(dialog).toBeVisible(); else await page.keyboard.press(slidesKey);
    await dialog.locator("input").first().uncheck();
    await dialog.locator("li").nth(1).getByRole("button", { name: /^Down/ }).click(); // reorder too
    expect(await state(), how).not.toEqual(before);
    if (how === "Close") await dialog.getByRole("button", { name: "Close" }).click(); else await page.keyboard.press("Escape");
    await expect(dialog, how).toBeHidden();
    expect(new URL(page.url()).searchParams.has("slides"), how).toBe(false); // nothing applied
    await at(page, 1, slides.length);
    await page.keyboard.press(slidesKey);
    expect(await state(), `${how}: reopened`).toEqual(before);
    if (how === "Close") await page.keyboard.press(slidesKey); // closed again for the next round
  }
});

test("picker: Up is off for the first row and Down for the last; buttons name their slide; a move is announced and keeps focus", async ({ page }) => {
  await openBoard(page);
  await page.keyboard.press(slidesKey);
  const dialog = pickerDialog(page);
  const rows = dialog.locator("li");
  await expect(rows.first().getByRole("button", { name: /^Up/ })).toBeDisabled();
  await expect(rows.first().getByRole("button", { name: /^Down/ })).toBeEnabled();
  await expect(rows.last().getByRole("button", { name: /^Down/ })).toBeDisabled();
  await expect(rows.last().getByRole("button", { name: /^Up/ })).toBeEnabled();
  for (const slide of slides) {
    await expect(dialog.getByRole("button", { name: `Up: ${slide.label}` })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: `Down: ${slide.label}` })).toHaveCount(1);
  }
  // the second row up to the top: Up goes off under focus, so focus passes to the row's Down
  const second = dialog.locator(`li[data-slide="${slides[1].id}"]`);
  const up = second.getByRole("button", { name: /^Up/ });
  await up.click();
  await expect(dialog.locator("li").first()).toHaveAttribute("data-slide", slides[1].id);
  await expect(dialog.locator('[aria-live="polite"]')).toHaveText(`${slides[1].label}: position 1 of ${slides.length}`);
  await expect(up).toBeDisabled();
  await expect(second.getByRole("button", { name: /^Down/ })).toBeFocused();
  const old = dialog.locator(`li[data-slide="${slides[0].id}"]`); // now the second row: one step down
  await old.getByRole("button", { name: /^Down/ }).click();
  await expect(dialog.locator('[aria-live="polite"]')).toHaveText(`${slides[0].label}: position 3 of ${slides.length}`);
  await expect(old.getByRole("button", { name: /^Down/ })).toBeFocused();
});

test("overlays open and close in full screen (stubbed): by key, button and Esc", async ({ page }) => {
  await stubPlatform(page);
  await openBoard(page);
  await page.keyboard.press(pressName(keysFor("fullscreen")[0].key));
  await expect.poll(() => page.evaluate(() => (window as any).__fullscreenCalls)).toBe(1);
  // the stub does not enter full screen: report it as on, as the browser would
  await page.evaluate(() => Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.documentElement }));
  const badge = page.locator(".board-paused");
  for (const [dialog, key] of [[pickerDialog(page), slidesKey], [helpDialog(page), helpKeys[0]]] as const) {
    await page.keyboard.press(key);
    await expect(dialog).toBeVisible();
    await expect(badge).toBeVisible();
    await page.keyboard.press(key);
    await expect(dialog).toBeHidden();
    await page.keyboard.press(key);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await page.keyboard.press(key);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(badge).toBeHidden(); // running before: running after
  }
});

test("methods page: the Wallboard section lists the key table and describes both modes and the picker", async ({ page }) => {
  await page.goto("/methods.html");
  const section = page.locator("#wallboard");
  await expect(section.locator("ul.board-keys-list li").first()).toBeVisible(); // drawn by script
  const items = await section.locator("ul.board-keys-list li").allTextContents();
  expect(items.map((text) => text.slice(text.indexOf(": ") + 2))).toEqual(keyGroups().map((group) => group.labels.join(", ")));
  await expect(section).toContainText("?rotate=<seconds>");
  await expect(section).toContainText("?view=wallboard");
  await expect(section).toContainText("Slide picker");
  await expect(section.locator('a[href*="view=wallboard"]')).toHaveCount(1);
  // the claims are the ones the tests measure
  const names = BOARD_CONTRAST_COLOURS.map((colour) => colour.name);
  await expect(section).toContainText(`${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} colours have a contrast of at least ${BOARD_MIN_CONTRAST}:1`);
  await expect(section).toContainText("chart colours are not covered");
  await expect(section).not.toContainText("every text and accent colour");
  await expect(section).toContainText("unknown ids are dropped with a notice (duplicates silently)");
  await expect(section).toContainText("a carousel made for full screen");
  for (const slide of slides) await expect(section).toContainText(slide.id);
});

test("footer link 'Conference wallboard' on every page with a footer", async ({ page }) => {
  for (const path of ["/", "/methods.html", "/about.html", "/?view=releases", "/?view=women-inventors", "/?country=CH&theme=paper"]) {
    await page.goto(path);
    const link = page.locator("footer").getByRole("link", { name: "Conference wallboard" });
    await expect(link, path).toHaveCount(1);
    expect(new URL((await link.getAttribute("href"))!, "http://x/").searchParams.get("view"), path).toBe("wallboard");
  }
  await page.locator("footer").getByRole("link", { name: "Conference wallboard" }).click();
  await expect(page.locator(".board")).toBeVisible();
});

/** Error text and accent must differ by at least this CIE76 distance (about 2 of "clearly different" steps; warm vs pink is ~40). */
const MIN_ERROR_ACCENT_DIFFERENCE = 30;

test.describe("readability at 1920x1080", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("stage and bar text, slide label and fine print meet the configured minimums on every slide", async ({ page }) => {
    test.setTimeout(slides.length * 5000 + 30000);
    const errors = trackErrors(page);
    await openBoard(page);
    for (let index = 0; index < slides.length; index += 1) {
      if (index > 0) await page.keyboard.press(pressName(keysFor("next")[0].key));
      await ready(page, slides[index].id);
      await page.clock.runFor(RESIZE_SETTLE_MS * 2);
      const sizes = await page.evaluate(() => {
        // rendered size in px: the font size, times the scale of an SVG's user space
        const rendered = (element: Element): number => {
          const size = parseFloat(getComputedStyle(element).fontSize);
          return element instanceof SVGGraphicsElement ? size * (element.getScreenCTM()?.a ?? 1) : size;
        };
        const visible = (element: Element): boolean => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
        };
        const withText = (root: Element, skip: string): { text: string; size: number }[] =>
          [...root.querySelectorAll("*")].filter((element) => !element.closest(skip) &&
            [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) && visible(element))
            .map((element) => ({ text: element.textContent!.trim().slice(0, 40), size: rendered(element) }));
        return {
          stage: withText(document.querySelector(".board-stage")!, "script, style, .visually-hidden"),
          bar: withText(document.querySelector(".board-bar")!, ".board-label, .board-disclaimer"),
          label: rendered(document.querySelector(".board-label")!),
          fine: rendered(document.querySelector(".board-disclaimer")!),
        };
      });
      const small = (list: { text: string; size: number }[], minimum: number) =>
        list.filter((item) => item.size < minimum - 0.5).map((item) => `${item.text}: ${item.size.toFixed(1)}px`);
      expect.soft(small(sizes.stage, board.minTextPx), `${slides[index].id} stage text`).toEqual([]);
      expect.soft(small(sizes.bar, board.minTextPx), `${slides[index].id} bar text`).toEqual([]);
      expect.soft(sizes.stage.length, `${slides[index].id} has stage text`).toBeGreaterThan(0);
      expect.soft(sizes.label, "slide label").toBeGreaterThanOrEqual(board.minTitlePx - 0.5);
      expect.soft(sizes.fine, "fine print").toBeGreaterThanOrEqual(board.minFinePrintPx - 0.5);
    }
    expect(errors).toEqual([]);
  });

  test("picker and help text meet the minimum text size", async ({ page }) => {
    await openBoard(page);
    for (const [key, dialog] of [[slidesKey, pickerDialog(page)], [helpKeys[0], helpDialog(page)]] as const) {
      await page.keyboard.press(key);
      await expect(dialog).toBeVisible();
      const small = await dialog.evaluate((root, minimum) => [root, ...root.querySelectorAll("*")]
        .filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()))
        .filter((element) => parseFloat(getComputedStyle(element).fontSize) < minimum - 0.5)
        .map((element) => `${element.textContent!.trim().slice(0, 30)}: ${getComputedStyle(element).fontSize}`), board.minTextPx);
      expect(small, key).toEqual([]);
      await page.keyboard.press(key);
    }
  });

  test("text, muted, accent and error colours keep the minimum contrast on the background (also at its gradient peak) and the surface; error and accent differ; the pulse ring follows the accent", async ({ page }) => {
    await openBoard(page);
    const colours = await page.evaluate((tokens) => {
      // computed colours: a probe element resolves each token (and any token it refers to) to rgb()
      const probe = document.createElement("span");
      document.querySelector(".board")!.append(probe);
      const resolve = (token: string, property: "color" | "backgroundColor"): number[] => {
        probe.style.cssText = `${property === "color" ? "color" : "background-color"}: var(${token})`;
        const computed = getComputedStyle(probe)[property];
        const numbers = computed.match(/[\d.]+/g)!.map(Number);
        // Chrome serialises a colour-mix() as color(srgb r g b / a), channels 0..1
        return computed.startsWith("color(srgb") ? [...numbers.slice(0, 3).map((value) => value * 255), numbers[3] ?? 1] : numbers;
      };
      const bg = resolve("--bg", "backgroundColor").slice(0, 3);
      // the board's gradient is lightest at its centre: its first rgba() stop blended over --bg
      const stop = getComputedStyle(document.documentElement).getPropertyValue("--bg-image").match(/rgba\(([^)]+)\)/)?.[1].split(",").map(Number);
      const peak = stop ? bg.map((channel, index) => channel * (1 - stop[3]) + stop[index] * stop[3]) : null;
      const result = {
        foregrounds: Object.fromEntries(tokens.map((token) => [token, resolve(token, "color").slice(0, 3)])),
        backgrounds: { "--bg": bg, "--surface": resolve("--surface", "backgroundColor").slice(0, 3), ...(peak ? { "--bg-image peak": peak } : {}) },
        ring: resolve("--accent-soft", "backgroundColor"),
        accent: resolve("--accent", "color").slice(0, 3),
      };
      probe.remove();
      return result;
    }, BOARD_CONTRAST_COLOURS.map((colour) => colour.token));
    const luminance = ([red, green, blue]: number[]): number => {
      const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const ratio = (a: number[], b: number[]): number => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };
    const lab = ([red, green, blue]: number[]): number[] => {
      const linear = [red, green, blue].map((value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      const [x, y, z] = [
        (0.4124 * linear[0] + 0.3576 * linear[1] + 0.1805 * linear[2]) / 0.95047,
        0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2],
        (0.0193 * linear[0] + 0.1192 * linear[1] + 0.9505 * linear[2]) / 1.08883,
      ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const colourDifference = (a: number[], b: number[]): number => Math.hypot(...lab(a).map((value, index) => value - lab(b)[index]));
    expect(Object.keys(colours.foregrounds).sort()).toEqual(["--accent", "--error-ink", "--ink", "--muted"]); // the spec's four
    expect(Object.keys(colours.backgrounds)).toContain("--bg-image peak"); // the gradient is part of the claim
    for (const [foreground, rgb] of Object.entries(colours.foregrounds)) {
      for (const [background, backgroundRgb] of Object.entries(colours.backgrounds)) {
        expect.soft(ratio(rgb, backgroundRgb), `${foreground} on ${background}`).toBeGreaterThanOrEqual(BOARD_MIN_CONTRAST);
      }
    }
    // an error is told from the accent by more than the words: a clear colour difference (CIE76 dE in Lab). A luminance
    // ratio cannot do it: both stay >= 7:1 on a dark ground, so both are about as bright (ratio ~1.05 for warm vs pink)
    expect(colourDifference(colours.foregrounds["--error-ink"], colours.foregrounds["--accent"])).toBeGreaterThanOrEqual(MIN_ERROR_ACCENT_DIFFERENCE);
    // the pulse ring is the accent at half strength
    colours.accent.forEach((channel, index) => expect(Math.abs(colours.ring[index] - channel)).toBeLessThan(1.5));
    expect(colours.ring[3]).toBeCloseTo(0.5, 2);
  });
});

test("cursor is hidden with the controls and back with them", async ({ page }) => {
  await openBoard(page);
  const cursor = () => page.locator(".board").evaluate((element) => getComputedStyle(element).cursor);
  expect(await cursor()).toBe("none");
  await page.mouse.move(10, 10);
  await page.mouse.move(300, 300);
  await expect(page.locator(".board-controls")).toBeVisible();
  expect(await cursor()).not.toBe("none");
  await page.clock.runFor(HIDE_MS + STEP_MS);
  await expect(page.locator(".board-controls")).toBeHidden();
  expect(await cursor()).toBe("none");
});

test("reduced motion: no transitions on the bar and controls, the progress bar steps", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openBoard(page);
  const transitions = await page.evaluate(() => [".board-progress-fill", ".board-controls"].map(
    (selector) => getComputedStyle(document.querySelector(selector)!).transitionDuration));
  expect(transitions.map((value) => value.split(",").every((part) => parseFloat(part) === 0))).toEqual([true, true]);
  const width = () => page.locator(".board-progress-fill").evaluate((element) => (element as HTMLElement).style.width);
  const before = await width();
  await page.clock.runFor(STEP_MS * 3);
  expect(await width()).not.toBe(before); // stepped by the ticker, not animated
});

test("with motion allowed the progress bar animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openBoard(page);
  const duration = await page.locator(".board-progress-fill").evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(parseFloat(duration)).toBeGreaterThan(0);
});
