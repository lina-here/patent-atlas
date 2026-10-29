// Dashboard carousel (spec 2a Carousel, WCAG 2.2.1/2.2.2): `dashboard.slides` (ids of `wallboard.slides`) one at a time on the
// wallboard's slide engine (slideDeck.ts), each a full card with prefixed ids. Controls: Play/Pause first, Previous, Next,
// position. Default paused (a reader is reading); `?rotate=` starts it playing (office screen), also under reduced motion.
// A user pause is sticky: only Play ends it. Holds are transient, each ended by its own end: the pointer moving over it
// (rotation.ts travel rule, released on leave or after `rotation.resumeAfterSeconds` still), keyboard focus inside (never the
// Play/Pause button), a hidden tab, an open tool panel or sources-and-notes details. Live region off while playing, polite
// otherwise; a visitor's move announces the slide (polite for it, also while playing). Computes no figure.
import type { Config, Entities, Manifest, Overview } from "./data";
import { h } from "./dom";
import { renderSlide } from "./embed";
import { isPauseMovePixels, isRotationSeconds, readParams, type Params } from "./params";
import { createSlideDeck, type DeckSlide } from "./slideDeck";

/** Put before every id of a carousel slide: a chart the overview family shows elsewhere keeps unique ids here. */
export const CAROUSEL_PREFIX = "carousel-";

const UNAVAILABLE = "Data unavailable for this chart";
/** An open tool panel (figures, cite, embed) or sources-and-notes details in the slide: the carousel holds. */
const OPEN_PANEL = ".chart-panel:not([hidden]), details.card-details[open]";
const SLOT = { slotClass: "carousel-slot", pendingClass: "carousel-slot--pending", slideAttribute: "data-slide", stateAttribute: "data-state" };

/** `dashboard.slides` resolved against `wallboard.slides`: an unknown id or a slide naming no chart left out with a notice. */
function carouselSlides(cfg: Config, notices: string[]): DeckSlide[] {
  const ids: unknown[] = Array.isArray(cfg.dashboard?.slides) ? cfg.dashboard.slides : [];
  const available = Array.isArray(cfg.wallboard?.slides) ? cfg.wallboard.slides : [];
  const slides: DeckSlide[] = [];
  for (const id of ids) {
    const slide = available.find((entry) => entry && entry.id === id);
    if (!slide) {
      notices.push(`Unknown dashboard slide in config.json left out: ${String(id)}`);
      continue;
    }
    if (typeof slide.label !== "string" || typeof slide.params !== "string") {
      notices.push(`Malformed wallboard slide in config.json left out of the carousel: ${String(id)} (its label and params must be text)`);
      continue;
    }
    const read = readParams(`?${slide.params}`, cfg);
    if (!read.params.chart) {
      notices.push(`Dashboard slide ${slide.id} names no chart: left out`);
      continue;
    }
    notices.push(...read.notices.map((line) => `Dashboard slide ${slide.id}: ${line}`));
    slides.push({ id: slide.id, label: slide.label, params: read.params });
  }
  return slides;
}

/** Seconds per slide: `?rotate=` (checked in readParams), else `dashboard.seconds`; invalid -> notice, `rotation.minSeconds`. */
function carouselSeconds(cfg: Config, params: Params, notices: string[]): number {
  if (params.rotate) return Number(params.rotate);
  const configured: unknown = cfg.dashboard?.seconds;
  if (typeof configured === "number" && isRotationSeconds(cfg, configured)) return configured;
  const { minSeconds } = cfg.rotation;
  notices.push(`Invalid dashboard.seconds in config.json: ${String(configured)} (whole seconds, at least ${minSeconds}): ${minSeconds} used`);
  return minSeconds;
}

/** The carousel in `root` (the dashboard stage); its notices go to `notices`. `data` = the page's entities and overview, the
 * slides' context (never the page params: view and rotate are the page's). */
export function startCarousel(root: HTMLElement, cfg: Config, manifest: Manifest, params: Params, notices: string[],
  data: { entities: Entities; overview: Overview }): { dispose(): void } {
  const slides = carouselSlides(cfg, notices);
  root.setAttribute("aria-roledescription", "carousel");
  root.setAttribute("aria-label", "Featured charts");
  if (slides.length === 0) {
    const text = "No carousel slide: config.json dashboard.slides names no wallboard slide.";
    notices.push(text);
    root.replaceChildren(h("p", { class: "notice notice-error" }, text));
    return { dispose: () => {} };
  }
  const slideMs = carouselSeconds(cfg, params, notices) * 1000;
  const { resumeAfterSeconds, pauseMovePixels } = cfg.rotation;
  // invalid: a hover hold lasts until the pointer leaves; any travel holds
  const autoResume = isRotationSeconds(cfg, resumeAfterSeconds);
  const pauseThreshold = isPauseMovePixels(pauseMovePixels) ? pauseMovePixels : 0;
  if (!autoResume) {
    notices.push(`Invalid rotation.resumeAfterSeconds in config.json: ${String(resumeAfterSeconds)} (whole seconds, at least ${cfg.rotation.minSeconds}): the carousel waits until the pointer leaves`);
  }
  if (!isPauseMovePixels(pauseMovePixels)) {
    notices.push(`Invalid rotation.pauseMovePixels in config.json: ${String(pauseMovePixels)} (a number of pixels, 0 or more): any pointer movement holds the carousel`);
  }

  const viewportId = `${CAROUSEL_PREFIX}slides`;
  const button = (action: string, text: string): HTMLButtonElement =>
    h("button", { type: "button", class: "carousel-button", "data-action": action, "aria-controls": viewportId }, text);
  const play = button("play", "Play");
  const previous = button("previous", "Previous");
  const next = button("next", "Next");
  const position = h("span", { class: "carousel-position" });
  const viewport = h("div", { class: "carousel-viewport", id: viewportId });
  const live = h("div", { class: "visually-hidden carousel-status", "aria-live": "polite", "aria-atomic": "true" });
  root.replaceChildren(h("div", { class: "carousel-controls" }, play, previous, next, position), viewport, live);

  const slideParams = (slide: DeckSlide): Params => ({ ...slide.params, theme: params.theme });
  let lastMoveManual = false; // the shown slide came by a visitor's move
  const deck = createSlideDeck(viewport, slides, slideMs, manifest, {
    draw: (slot, slide) => {
      slot.setAttribute("role", "group");
      slot.setAttribute("aria-roledescription", "slide");
      slot.setAttribute("aria-label", slide.label);
      return renderSlide(slot, slideParams(slide), { cfg, manifest, ...data },
        { fitToStage: true, fillStage: true, full: true, idPrefix: CAROUSEL_PREFIX });
    },
    onShow(slide, index, total, manual) {
      position.textContent = `${index + 1} of ${total}`;
      lastMoveManual = manual;
      // a visitor's move is announced even while running (a tap or assistive technology holds nothing): polite before the
      // text; an automatic move writes nothing and the region follows the pause state again
      live.setAttribute("aria-live", manual || deck.paused ? "polite" : "off");
      live.textContent = manual ? `Slide ${index + 1} of ${total}: ${slide.label}` : "";
      // the slide focused in was replaced: focus is gone from the carousel without a focusout
      syncFocus(document.activeElement);
    },
    onReady: () => {},
    onPausedChange(paused) {
      play.textContent = deck.userPaused ? "Play" : "Pause";
      live.setAttribute("aria-live", paused ? "polite" : "off");
    },
    onAllFailed: () => {},
    errorScreen: () => h("div", { class: "notice notice-error carousel-error" },
      h("p", {}, "The charts could not be loaded."),
      h("p", {}, "Next, or Play, tries again.")),
    unavailable: () => {
      // no role on the message (it would speak while running): a visitor's move announces it with the slide
      if (lastMoveManual) live.textContent = `${live.textContent}. ${UNAVAILABLE}`;
      return h("p", { class: "notice notice-error carousel-unavailable" }, UNAVAILABLE);
    },
  }, { userPaused: !params.rotate }, SLOT);

  // keyboard focus inside holds; a mouse click (no focus ring) or the Play/Pause button never does
  function syncFocus(target: Element | null): void {
    const held = target instanceof HTMLElement && target !== play && root.contains(target) && target.matches(":focus-visible");
    deck.hold("focus", held);
  }
  const onFocusIn = (event: FocusEvent): void => syncFocus(event.target as Element | null);
  const onFocusOut = (event: FocusEvent): void => {
    if (!(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))) deck.hold("focus", false);
  };

  // pointer travel since the hover hold last ended: jitter, or a layout shift under a still pointer, is not use
  let travel = 0;
  let idleTimer: number | undefined;
  const releaseHover = (): void => {
    clearTimeout(idleTimer);
    travel = 0;
    deck.hold("hover", false);
  };
  const onPointerMove = (event: PointerEvent): void => {
    // movementX/Y can be missing or NaN (synthetic events): counted as 0; no travel never holds nor restarts the wait
    const { movementX, movementY } = event;
    const step = Math.hypot(Number.isFinite(movementX) ? movementX : 0, Number.isFinite(movementY) ? movementY : 0);
    if (step === 0) return;
    travel += step;
    if (travel < pauseThreshold) return;
    deck.hold("hover", true);
    clearTimeout(idleTimer);
    // a parked pointer never holds an office screen for good
    if (autoResume) idleTimer = window.setTimeout(releaseHover, resumeAfterSeconds * 1000);
  };

  const onVisibility = (): void => deck.hold("hidden", document.hidden);
  const panels = new MutationObserver(() => deck.hold("panel", viewport.querySelector(OPEN_PANEL) !== null));

  play.addEventListener("click", () => {
    const starting = deck.userPaused;
    // the pointer that pressed Play is over the carousel: its travel so far is not a hold
    if (starting) releaseHover();
    deck.setUserPaused(!starting);
  });
  previous.addEventListener("click", () => deck.previous(true));
  next.addEventListener("click", () => deck.next(true));
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", releaseHover);
  document.addEventListener("visibilitychange", onVisibility);
  panels.observe(viewport, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "open"] });

  onVisibility();
  live.setAttribute("aria-live", deck.paused ? "polite" : "off");
  play.textContent = deck.userPaused ? "Play" : "Pause";
  deck.show(0, false);

  return {
    dispose() {
      clearTimeout(idleTimer);
      panels.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", releaseHover);
      deck.dispose();
    },
  };
}
