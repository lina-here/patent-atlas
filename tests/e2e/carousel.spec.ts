import { test, expect, type Locator, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { RESIZE_SETTLE_MS } from "./siteConstants";
import { FONT_VARIANTS, expectWideFonts, useWideFonts } from "./wideFonts";

// Dashboard carousel (`?view=dashboard`, spec 2a Carousel, WCAG 2.2.2): Play/Pause, Previous, Next, position; default paused;
// a user pause is sticky (only Play ends it), holds are transient (pointer moving over it, keyboard focus inside, hidden tab,
// an open tool panel or details); the shared slide engine's failures, stale renders and manifest re-check; fit and unique ids
// on every slide. Values from config.json, manifest.json and site source, never copies.

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const config = readJson("site/config.json");
const manifest = readJson("site/data/manifest.json");
const carouselSource = readFileSync("site/src/carousel.ts", "utf8");
const CAROUSEL_PREFIX = /^export const CAROUSEL_PREFIX = "([^"]+)";/m.exec(carouselSource)![1];
const UNAVAILABLE = /^const UNAVAILABLE = "([^"]+)";/m.exec(carouselSource)![1];
const THEME_ANIMATION = /--rotate-animation:\s*([a-z-]+)/.exec(readFileSync(`site/themes/${config.defaultTheme}.css`, "utf8"))![1];
const { minSeconds, resumeAfterSeconds, pauseMovePixels } = config.rotation;
type WallSlide = { id: string; label: string; params: string };
const wallSlides: WallSlide[] = config.wallboard.slides;
const slides: WallSlide[] = config.dashboard.slides.map((id: string) => wallSlides.find((slide) => slide.id === id)!);
const chartOf = (slide: WallSlide): string => new URLSearchParams(slide.params).get("chart")!;
const SLIDE_MS = config.dashboard.seconds * 1000;
const ROTATE_MS = minSeconds * 1000; // `&rotate=<minSeconds>`
const IDLE_MS = resumeAfterSeconds * 1000;
const STEP_MS = 1000; // a margin past a deadline, well under any interval

const DASHBOARD = "/?view=dashboard";
const STAGE = ".dashboard-stage";
const BEHAVIOUR_SIZE = { width: 1440, height: 1000 };

const control = (page: Page, name: string): Locator => page.locator(`${STAGE} .carousel-controls`).getByRole("button", { name, exact: true });
const position = (page: Page): Locator => page.locator(`${STAGE} .carousel-position`);
const status = (page: Page): Locator => page.locator(`${STAGE} .carousel-status`);
const at = (page: Page, n: number, total = slides.length) => expect(position(page)).toHaveText(`${n} of ${total}`);
const ready = (page: Page, id: string) =>
  expect(page.locator(`${STAGE} .carousel-slot[data-slide="${id}"]`)).toHaveAttribute("data-state", "ready");
/** Running = the live region is off (spec: aria-live off while playing, polite otherwise). */
const running = (page: Page, on: boolean) => expect(status(page)).toHaveAttribute("aria-live", on ? "off" : "polite");

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** config.json with `dashboard` fields replaced. */
async function routeDashboard(page: Page, changes: Record<string, unknown>): Promise<void> {
  await page.route("**/config.json", (route) => route.fulfill({ json: { ...config, dashboard: { ...config.dashboard, ...changes } } }));
}

/** The dashboard on the page clock, its first slide drawn. */
async function openCarousel(page: Page, query = "", firstId = slides[0].id): Promise<void> {
  await page.setViewportSize(BEHAVIOUR_SIZE);
  await page.clock.install();
  await page.goto(`${DASHBOARD}${query}`);
  await ready(page, firstId);
}

/** Real pointer travel over the carousel, past `pauseMovePixels` (inside the window: a move outside it is never sent). */
async function hover(page: Page): Promise<void> {
  const viewport = page.locator(`${STAGE} .carousel-viewport`);
  await viewport.scrollIntoViewIfNeeded();
  const box = (await viewport.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 2 * pauseMovePixels;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 2 * pauseMovePixels, y + pauseMovePixels);
}
const leave = (page: Page) => page.mouse.move(0, 0);

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** Keyboard focus into the shown slide (Tab from Next). */
async function tabIntoSlide(page: Page): Promise<void> {
  await control(page, "Next").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".carousel-slot")))).toBe(true);
}
const focusOutside = (page: Page) => page.locator(".dashboard-tile .tool-button").first().focus();

test("controls: Play first, Previous, Next, position; a carousel region, the shown slide a labelled slide", async ({ page }) => {
  const errors = trackErrors(page);
  await openCarousel(page);
  const stage = page.locator(STAGE);
  await expect(stage).toHaveAttribute("aria-roledescription", "carousel");
  expect(await stage.getAttribute("aria-label")).toBeTruthy();
  const buttons = await page.locator(`${STAGE} .carousel-controls button`).allTextContents();
  expect(buttons).toEqual(["Play", "Previous", "Next"]);
  await at(page, 1);
  const slot = page.locator(`${STAGE} .carousel-slot`);
  await expect(slot).toHaveAttribute("role", "group");
  await expect(slot).toHaveAttribute("aria-roledescription", "slide");
  await expect(slot).toHaveAttribute("aria-label", slides[0].label);
  await expect(slot.locator(".chart-card")).toHaveAttribute("data-chart", chartOf(slides[0]));
  expect(errors).toEqual([]);
});

test("default paused: the same slide after 3 intervals; Play (a mouse click) advances after dashboard.seconds", async ({ page }) => {
  await openCarousel(page);
  await page.clock.runFor(3 * SLIDE_MS + STEP_MS);
  await at(page, 1);
  await running(page, false);
  await control(page, "Play").click(); // the pointer is over the carousel: a click on Play still plays
  await expect(control(page, "Pause")).toHaveCount(1);
  await running(page, true);
  await page.clock.runFor(SLIDE_MS - STEP_MS);
  await at(page, 1);
  await page.clock.runFor(2 * STEP_MS);
  await at(page, 2);
  await ready(page, slides[1].id);
});

test("user Pause is sticky: hover, leave, keyboard focus in and out, hidden and visible -> still paused; Play resumes", async ({ page }) => {
  await openCarousel(page, `&rotate=${minSeconds}`);
  await expect(control(page, "Pause")).toHaveCount(1);
  await control(page, "Pause").dispatchEvent("click");
  await expect(control(page, "Play")).toHaveCount(1);
  await hover(page);
  await leave(page);
  await tabIntoSlide(page);
  await focusOutside(page);
  await setHidden(page, true);
  await setHidden(page, false);
  await expect(control(page, "Play")).toHaveCount(1);
  await running(page, false);
  await page.clock.runFor(2 * ROTATE_MS + STEP_MS);
  await at(page, 1);
  await control(page, "Play").dispatchEvent("click");
  await running(page, true);
  await page.clock.runFor(ROTATE_MS + STEP_MS);
  await at(page, 2);
});

test("playing: hover holds, leave resumes with the time left; keyboard focus inside holds; a mouse click on Next does not", async ({ page }) => {
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  await page.clock.runFor(SLIDE_MS / 2);
  await hover(page);
  await running(page, false);
  await page.clock.runFor(SLIDE_MS);
  await at(page, 1);
  await leave(page);
  await running(page, true);
  await page.clock.runFor(SLIDE_MS / 2 + STEP_MS); // the time left, not a full interval
  await at(page, 2);
  // keyboard focus inside holds; focus leaving releases
  await tabIntoSlide(page);
  await running(page, false);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2);
  await focusOutside(page);
  await running(page, true);
  // a mouse click on Next moves and focuses it, but never parks the carousel: once the pointer leaves, it runs
  await control(page, "Next").click();
  await at(page, 3);
  await leave(page);
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Next");
  await running(page, true);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 4);
});

test("playing: a hidden tab holds; visible again, it runs", async ({ page }) => {
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  await setHidden(page, true);
  await running(page, false);
  await page.clock.runFor(2 * SLIDE_MS);
  await at(page, 1);
  await setHidden(page, false);
  await running(page, true);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2);
});

test("playing: open Show figures holds until closed; the Cite and Embed panels and open details hold too", async ({ page }) => {
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  const card = page.locator(`${STAGE} .chart-card`);
  const openers: [string, Locator, Locator][] = [
    ["Show figures", card.getByRole("button", { name: "Show figures", exact: true }), card.locator(".chart-figures")],
    ["Cite this", card.getByRole("button", { name: "Cite this", exact: true }), card.locator(".chart-cite")],
    ["Embed", card.getByRole("button", { name: "Embed", exact: true }), card.locator(".chart-embed")],
    ["details", card.locator("details.card-details > summary"), card.locator("details.card-details[open]")],
  ];
  for (const [name, opener, panel] of openers) {
    await opener.click();
    await leave(page); // the click's pointer travel is a hover hold of its own
    await expect(panel, name).toBeVisible();
    await running(page, false);
    await page.clock.runFor(SLIDE_MS + STEP_MS);
    await at(page, 1);
    await (name === "Show figures" ? card.getByRole("button", { name: "Hide figures", exact: true }) : opener).click();
    await leave(page);
    await expect(panel, name).toBeHidden();
    await running(page, true);
  }
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2);
});

test("parked pointer: the hover hold ends after resumeAfterSeconds without movement", async ({ page }) => {
  expect(IDLE_MS).toBeGreaterThan(SLIDE_MS + 2 * STEP_MS);
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  await hover(page);
  await running(page, false);
  await page.clock.runFor(IDLE_MS - STEP_MS);
  await at(page, 1);
  await page.clock.runFor(2 * STEP_MS);
  await running(page, true);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 2);
});

test("playing: a pointermove without travel (layout shifted under a still pointer) does not restart the hover hold's wait", async ({ page }) => {
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  await hover(page);
  await running(page, false);
  await page.clock.runFor(IDLE_MS - STEP_MS);
  await page.locator(`${STAGE} .carousel-viewport`).dispatchEvent("pointermove", { movementX: 0, movementY: 0 });
  await page.clock.runFor(2 * STEP_MS);
  await running(page, true);
});

test("Previous and Next move one slide, wrap, update the position and announce politely; a move resets the timer", async ({ page }) => {
  await openCarousel(page);
  const last = slides.length;
  await control(page, "Next").dispatchEvent("click");
  await at(page, 2);
  await ready(page, slides[1].id);
  await expect(status(page)).toHaveText(`Slide 2 of ${last}: ${slides[1].label}`);
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
  await control(page, "Previous").dispatchEvent("click");
  await at(page, 1);
  await expect(status(page)).toHaveText(`Slide 1 of ${last}: ${slides[0].label}`);
  await control(page, "Previous").dispatchEvent("click");
  await at(page, last);
  await ready(page, slides[last - 1].id);
  await expect(status(page)).toHaveText(`Slide ${last} of ${last}: ${slides[last - 1].label}`);
  // playing: Next restarts the slide's time
  await control(page, "Play").dispatchEvent("click");
  await page.clock.runFor(SLIDE_MS - 2 * STEP_MS);
  await at(page, last);
  await control(page, "Next").dispatchEvent("click");
  await at(page, 1);
  await page.clock.runFor(SLIDE_MS - 2 * STEP_MS); // past the old deadline
  await at(page, 1);
  await page.clock.runFor(3 * STEP_MS);
  await at(page, 2);
});

test("aria-live is off while playing (automatic moves not announced), polite when paused", async ({ page }) => {
  await openCarousel(page, `&rotate=${minSeconds}`);
  await expect(status(page)).toHaveAttribute("aria-live", "off");
  await page.clock.runFor(ROTATE_MS + STEP_MS);
  await at(page, 2);
  await expect(status(page)).toHaveText("");
  await control(page, "Pause").dispatchEvent("click");
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
});

test("playing: a move with no hold (a tap, assistive technology) is announced; the next automatic move is not", async ({ page }) => {
  await openCarousel(page);
  await control(page, "Play").dispatchEvent("click");
  await running(page, true);
  await control(page, "Next").dispatchEvent("click"); // no pointer travel, no keyboard focus: nothing holds
  await at(page, 2);
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
  await expect(status(page)).toHaveText(`Slide 2 of ${slides.length}: ${slides[1].label}`);
  await ready(page, slides[1].id);
  await page.clock.runFor(SLIDE_MS + STEP_MS); // never held: it ran on
  await at(page, 3);
  await expect(status(page)).toHaveText("");
  await expect(status(page)).toHaveAttribute("aria-live", "off");
});

test("a manual move to a slide whose file 404s announces the slide and that its data is unavailable", async ({ page }) => {
  const failing = wallSlides.find((slide) => slide.id === "map-per-million")!;
  await routeDashboard(page, { slides: [slides[0].id, failing.id] });
  await page.route("**/data/map/per_million.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await openCarousel(page);
  await control(page, "Next").dispatchEvent("click");
  await expect(page.locator(`${STAGE} .carousel-unavailable`)).toHaveText(UNAVAILABLE);
  await expect(status(page)).toHaveText(`Slide 2 of 2: ${failing.label}. ${UNAVAILABLE}`);
  await expect(status(page)).toHaveAttribute("aria-live", "polite");
});

const slotAnimation = (page: Page) => page.locator(`${STAGE} .carousel-slot`).evaluate((element) => getComputedStyle(element).animationName);

test("reduced motion: no auto-start, no transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openCarousel(page);
  await page.clock.runFor(2 * SLIDE_MS + STEP_MS);
  await at(page, 1);
  await expect(control(page, "Play")).toHaveCount(1);
  expect(await slotAnimation(page)).toBe("none");
});

test("reduced motion: ?rotate=N still plays, at N seconds", async ({ page }) => {
  const seconds = config.dashboard.seconds + 5;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openCarousel(page, `&rotate=${seconds}`);
  await expect(control(page, "Pause")).toHaveCount(1);
  await page.clock.runFor(SLIDE_MS + STEP_MS);
  await at(page, 1);
  await page.clock.runFor((seconds - config.dashboard.seconds) * 1000);
  await at(page, 2);
});

test("motion allowed: a slide fades in with the theme's animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openCarousel(page);
  expect(THEME_ANIMATION).not.toBe("none");
  expect(await slotAnimation(page)).toBe(THEME_ANIMATION);
});

test("quick double Next: the later slide only, its own chart", async ({ page }) => {
  const errors = trackErrors(page);
  const ids = [slides[0].id, "map-per-million", slides[1].id];
  await routeDashboard(page, { slides: ids });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/data/map/per_million.json", async (route) => { await held; await route.continue(); });
  await openCarousel(page);
  await control(page, "Next").dispatchEvent("click");
  await control(page, "Next").dispatchEvent("click");
  await ready(page, ids[2]);
  release(); // the map's data arrives after: its stale render is dropped
  await page.waitForTimeout(RESIZE_SETTLE_MS * 4);
  await expect(page.locator(`${STAGE} .carousel-slot`)).toHaveCount(1);
  await expect(page.locator(`${STAGE} .chart-card`)).toHaveAttribute("data-chart", chartOf(slides[1]));
  await expect(page.locator(`${STAGE} .map-svg`)).toHaveCount(0);
  await at(page, 3, 3);
  expect(errors).toEqual([]);
});

test("a slide whose file 404s: its unavailable message (a rule, not colour alone), then the next slide shows", async ({ page }) => {
  await routeDashboard(page, { slides: ["map-per-million", slides[0].id] });
  await page.route("**/data/map/per_million.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.setViewportSize(BEHAVIOUR_SIZE);
  await page.clock.install();
  await page.goto(`${DASHBOARD}&rotate=${minSeconds}`);
  const unavailable = page.locator(`${STAGE} .carousel-unavailable`);
  await expect(unavailable).toHaveText("Data unavailable for this chart");
  await expect(page.locator(`${STAGE} .carousel-slot`)).toHaveAttribute("data-state", "failed");
  expect(await unavailable.evaluate((element) => getComputedStyle(element).borderLeftStyle)).toBe("solid");
  await at(page, 1, 2);
  await page.clock.runFor(ROTATE_MS + STEP_MS);
  await ready(page, slides[0].id);
  await expect(unavailable).toHaveCount(0);
});

test("each full cycle re-reads manifest.json: a new data version reloads the dashboard, the same one does not", async ({ page }) => {
  let manifestRequests = 0;
  let served = manifest;
  await page.route("**/data/manifest.json", (route) => {
    manifestRequests += 1;
    return route.fulfill({ json: served });
  });
  const ids = [slides[0].id, slides[1].id];
  await routeDashboard(page, { slides: ids });
  await openCarousel(page, `&rotate=${minSeconds}`);
  const atStart = manifestRequests;
  await page.evaluate(() => { (window as any).__sameDocument = true; });
  await page.clock.runFor(ROTATE_MS + STEP_MS);
  await at(page, 2, 2);
  expect(manifestRequests).toBe(atStart); // not mid-cycle
  await page.clock.runFor(ROTATE_MS);
  await at(page, 1, 2); // a full cycle
  await expect.poll(() => manifestRequests).toBe(atStart + 1);
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true); // same version: no reload
  served = { ...manifest, version: `${manifest.version}.9` };
  await page.clock.runFor(2 * ROTATE_MS);
  await expect.poll(() => page.evaluate(() => (window as any).__sameDocument).catch(() => true)).toBeUndefined();
  await ready(page, ids[0]);
  const url = new URL(page.url());
  expect(url.searchParams.get("view")).toBe("dashboard");
  expect(url.searchParams.get("rotate")).toBe(String(minSeconds));
});

/** Counters on the page (`__counts()`): live ResizeObservers and MutationObservers, and listeners on window and document
 * (`__track(name, target)` adds a target, such as the stage). */
async function installCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    const live = new Set<unknown>();
    const Native = window.ResizeObserver;
    w.ResizeObserver = class extends Native {
      constructor(callback: ResizeObserverCallback) { super(callback); live.add(this); }
      disconnect() { live.delete(this); super.disconnect(); }
    };
    const observing = new Set<unknown>();
    const NativeMutation = window.MutationObserver;
    w.MutationObserver = class extends NativeMutation {
      observe(target: Node, options?: MutationObserverInit) { observing.add(this); super.observe(target, options); }
      disconnect() { observing.delete(this); super.disconnect(); }
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
    w.__track = track;
    w.__counts = () => ({
      observers: live.size,
      mutationObservers: observing.size,
      listeners: Object.fromEntries([...listeners].filter(([, n]) => n > 0).sort()),
    });
  });
}
const counts = (page: Page) => page.evaluate(() => (window as any).__counts());

test("30 slide changes leave the ResizeObserver and listener counts where they were", async ({ page }) => {
  const errors = trackErrors(page);
  await installCounters(page);
  await openCarousel(page);
  // one move first: the test driver's own window listeners (added on its first action) are then counted in both
  await control(page, "Next").dispatchEvent("click");
  await ready(page, slides[1].id);
  const before = await counts(page);
  for (let step = 2; step <= 31; step += 1) {
    await control(page, "Next").dispatchEvent("click");
    await ready(page, slides[step % slides.length].id);
  }
  expect(await counts(page)).toEqual(before);
  await expect(page.locator(`${STAGE} .carousel-slot`)).toHaveCount(1);
  expect(errors).toEqual([]);
});

/** The site bundle with `startCarousel` wrapped, for this test only (the page never tears the carousel down, so the
 * production code has no handle to reach): `__carousel` = the last start's handle, `__restartCarousel()` starts it again
 * with the same arguments (same stage). */
async function bundleWithCarouselHandle(): Promise<string> {
  const declaration = "export function startCarousel(";
  expect(carouselSource).toContain(declaration);
  const wrapped = `${carouselSource.replace(declaration, "function startCarouselOnce(")}
export function startCarousel(...args: Parameters<typeof startCarouselOnce>): ReturnType<typeof startCarouselOnce> {
  const w = window as any;
  w.__restartCarousel = () => { w.__carousel = startCarouselOnce(...args); };
  w.__carousel = startCarouselOnce(...args);
  return w.__carousel;
}
`;
  const result = await build({
    entryPoints: ["site/src/main.ts"], bundle: true, format: "esm", platform: "browser", write: false,
    plugins: [{ name: "carousel-handle", setup(bundler) {
      bundler.onLoad({ filter: /[\\/]site[\\/]src[\\/]carousel\.ts$/ }, () => ({ contents: wrapped, loader: "ts" }));
    } }],
  });
  return result.outputFiles[0].text;
}

test("dispose: listeners, observers and timers go; the counts are back where they were before the carousel started", async ({ page }) => {
  const errors = trackErrors(page);
  const bundle = await bundleWithCarouselHandle();
  await page.route("**/js/main.js", (route) => route.fulfill({ body: bundle, contentType: "text/javascript" }));
  await installCounters(page);
  await openCarousel(page);
  // warm-up: the test driver's own listeners (first click, pointer) counted in the baseline too
  await control(page, "Next").dispatchEvent("click");
  await ready(page, slides[1].id);
  await hover(page);
  await leave(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__carousel.dispose();
    w.__track("stage", document.querySelector(".dashboard-stage"));
  });
  const baseline = await counts(page);
  await page.evaluate(() => (window as any).__restartCarousel());
  await ready(page, slides[0].id);
  await control(page, "Play").dispatchEvent("click");
  await control(page, "Next").dispatchEvent("click");
  await ready(page, slides[1].id);
  await hover(page); // a hover hold: its idle timer armed
  await running(page, false);
  const started = await counts(page);
  expect(started.observers).toBeGreaterThan(baseline.observers);
  expect(started.mutationObservers).toBeGreaterThan(baseline.mutationObservers);
  expect(Object.keys(started.listeners).filter((name) => name.startsWith("stage:")).length).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__carousel.dispose());
  expect(await counts(page)).toEqual(baseline);
  // no timer left: neither the slide's nor the hover hold's
  await leave(page);
  await page.clock.runFor(IDLE_MS + 2 * SLIDE_MS);
  await at(page, 2);
  expect(errors).toEqual([]);
});

/** Page ids unique, aria refs resolve; in the stage every id carries the prefix, its aria refs resolve inside it, and every
 * `url(#id)` in a stage svg names an element of that same svg. */
async function idProblems(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const problems: string[] = [];
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    for (const id of ids.filter((value, index) => ids.indexOf(value) !== index)) problems.push(`duplicate id ${id}`);
    const stage = document.querySelector(".dashboard-stage") as HTMLElement;
    for (const attribute of ["aria-controls", "aria-labelledby", "aria-describedby"]) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) problems.push(`${attribute}=${id} unresolved`);
          else if (stage.contains(element) && !stage.querySelector(`[id="${id}"]`)) problems.push(`${attribute}=${id} outside the stage`);
        }
      }
    }
    for (const element of stage.querySelectorAll("[id]")) if (!element.id.startsWith(prefix)) problems.push(`unprefixed id ${element.id}`);
    for (const svg of stage.querySelectorAll("svg")) {
      for (const element of [svg, ...svg.querySelectorAll("*")]) {
        for (const attribute of element.getAttributeNames()) {
          for (const [, id] of (element.getAttribute(attribute) ?? "").matchAll(/url\(#([^)]+)\)/g)) {
            if (!svg.querySelector(`[id="${id}"]`)) problems.push(`${attribute}=url(#${id}) not in its svg`);
          }
        }
      }
    }
    return problems;
  }, CAROUSEL_PREFIX);
}

test("every slide: no duplicate ids, aria refs resolve, ids prefixed, svg url refs in their own svg", async ({ page }) => {
  await openCarousel(page);
  for (let step = 0; step < slides.length; step += 1) {
    if (step > 0) await control(page, "Next").dispatchEvent("click");
    await ready(page, slides[step].id);
    expect(await idProblems(page), slides[step].id).toEqual([]);
  }
});

test("config: an unknown slide id and an invalid dashboard.seconds: a notice each, the others run at rotation.minSeconds", async ({ page }) => {
  await routeDashboard(page, { seconds: minSeconds - 1, slides: ["no-such-slide", slides[0].id, slides[1].id] });
  await openCarousel(page);
  const notices = page.locator("#notices");
  await expect(notices).toContainText("Unknown dashboard slide in config.json left out: no-such-slide");
  await expect(notices).toContainText(
    `Invalid dashboard.seconds in config.json: ${minSeconds - 1} (whole seconds, at least ${minSeconds}): ${minSeconds} used`);
  await at(page, 1, 2);
  await control(page, "Play").dispatchEvent("click");
  await page.clock.runFor(ROTATE_MS - STEP_MS);
  await at(page, 1, 2);
  await page.clock.runFor(2 * STEP_MS);
  await at(page, 2, 2);
  await ready(page, slides[1].id);
});

test("config: a wallboard slide with a label or params that is not text: a malformed-slide notice, left out", async ({ page }) => {
  const malformed = { ...slides[0], label: 7 };
  await page.route("**/config.json", (route) => route.fulfill({ json: {
    ...config, wallboard: { ...config.wallboard, slides: wallSlides.map((slide) => (slide.id === malformed.id ? malformed : slide)) } } }));
  await openCarousel(page, "", slides[1].id);
  const notices = page.locator("#notices");
  await expect(notices).toContainText(`Malformed wallboard slide in config.json left out of the carousel: ${malformed.id} (its label and params must be text)`);
  await expect(notices).not.toContainText("Unknown dashboard slide");
  await at(page, 1, slides.length - 1);
});

/** The shown slide's fit: no overflow of the stage or slot, the card inside the stage, no part sideways out of the card, no
 * page sideways scroll. */
async function fitProblems(page: Page): Promise<string[]> {
  return page.locator(STAGE).evaluate((stage) => {
    const problems: string[] = [];
    const slot = stage.querySelector(".carousel-slot") as HTMLElement;
    const card = slot.querySelector(".chart-card") as HTMLElement;
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) problems.push(`page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`);
    if (stage.scrollHeight > stage.clientHeight + 1) problems.push(`stage overflows by ${stage.scrollHeight - stage.clientHeight}px`);
    if (slot.scrollHeight > slot.clientHeight + 1) problems.push(`slot overflows by ${slot.scrollHeight - slot.clientHeight}px`);
    const box = stage.getBoundingClientRect();
    const frame = card.getBoundingClientRect();
    if (frame.bottom > box.bottom + 1 || frame.left < box.left - 1 || frame.right > box.right + 1) problems.push("card outside the stage");
    for (const part of card.querySelectorAll<Element>("h2, p, svg, .tile, .chart-toolbar, summary")) {
      const rect = part.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.left < frame.left - 1 || rect.right > frame.right + 1) problems.push(`${part.tagName}.${part.getAttribute("class") ?? ""} outside the card`);
    }
    return problems;
  });
}

/** Next through every dashboard slide from the first, `check` on each once its fit has settled. */
async function eachSlide(page: Page, check: (id: string) => Promise<void>): Promise<void> {
  for (let step = 0; step < slides.length; step += 1) {
    if (step > 0) await control(page, "Next").dispatchEvent("click");
    await ready(page, slides[step].id);
    await page.waitForTimeout(RESIZE_SETTLE_MS * 3); // the fit redraws after the resize settles
    await check(slides[step].id);
  }
}

async function expectEverySlideFits(page: Page): Promise<void> {
  await eachSlide(page, async (id) => {
    expect.soft(await fitProblems(page), id).toEqual([]);
    await expect.soft(page.locator(`${STAGE} .chart-card--problem`), id).toHaveCount(0);
  });
}

for (const { wide, suffix } of FONT_VARIANTS) for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`every dashboard slide fits the stage at ${size.width}x${size.height}${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize(size);
    await page.goto(DASHBOARD);
    if (wide) await expectWideFonts(page);
    await expectEverySlideFits(page);
  });
}

// each theme's own phone stage token (`--dashboard-stage-phone-height`); the default theme is the loop above
for (const theme of (config.themes as string[]).filter((name) => name !== config.defaultTheme)) for (const { wide, suffix } of FONT_VARIANTS) {
  test(`?theme=${theme}: every dashboard slide fits the phone stage at 390x844${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DASHBOARD}&theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (wide) await expectWideFonts(page);
    await expectEverySlideFits(page);
  });
}

/** The blank band in the shown card (the room its foot, `.chart-tools`, is pushed down by, above it) and the card's text line. */
function spareBand(page: Page): Promise<{ band: number; line: number }> {
  return page.locator(`${STAGE} .carousel-slot .chart-card`).evaluate((card) => {
    const tools = card.querySelector(":scope > .chart-tools")!;
    const above = tools.previousElementSibling!;
    const band = tools.getBoundingClientRect().top - above.getBoundingClientRect().bottom - parseFloat(getComputedStyle(above).marginBottom);
    return { band, line: parseFloat(getComputedStyle(card).lineHeight) };
  });
}

for (const { wide, suffix } of FONT_VARIANTS) {
  test(`1440: every slide's chart fills its card, no blank band over one text line above the toolbar, nothing overflows${suffix}`, async ({ page }) => {
    if (wide) await useWideFonts(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DASHBOARD);
    if (wide) await expectWideFonts(page);
    await eachSlide(page, async (id) => {
      const { band, line } = await spareBand(page);
      expect.soft(band, `${id}: blank band (px) under one line of ${line}px`).toBeLessThanOrEqual(line);
      expect.soft(await fitProblems(page), id).toEqual([]);
    });
  });
}
