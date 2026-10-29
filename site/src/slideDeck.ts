// Slide engine of the wallboard (spec "Conference wallboard") and the dashboard carousel (spec 2a, Carousel): one slide at a
// time in `stage`, each drawn into its own slot. A render token per slide: a stale render (a later slide shown) is disposed,
// never shown. The timer runs from the slide's start and keeps its remaining time across a pause; a slide not settled at its
// end counts as failed; every slide failing in a row -> the error screen until one draws. Once per full cycle the manifest is
// read past every cache: a new data version reloads the page (same address). Computes no figure.
import { loadFresh, type Manifest } from "./data";
import { h } from "./dom";
import type { SlideResult } from "./embed";
import type { Params } from "./params";

export type DeckSlide = { id: string; label: string; params: Params };
/** Why the deck is held (transient pauses, each released by its own end); a user pause is apart: only Play clears it. */
export type HoldReason = "overlay" | "hover" | "focus" | "hidden" | "panel";

export type DeckHooks = {
  /** Draws `slide` into `slot`; a throw or rejection = failed (logged). */
  draw(slot: HTMLElement, slide: DeckSlide): Promise<SlideResult>;
  /** A slide was placed and its timer armed; `manual` = a visitor's move (announce it). */
  onShow(slide: DeckSlide, index: number, total: number, manual: boolean): void;
  /** The slide shown now drew (the error screen, if up, gave way to it). */
  onReady(slide: DeckSlide, result: SlideResult): void;
  /** `paused` or the user pause changed; `byUser` = by setUserPaused. */
  onPausedChange(paused: boolean, byUser: boolean): void;
  /** Every slide in a row failed: the error screen is up. */
  onAllFailed(): void;
  errorScreen(): HTMLElement;
  /** What a failed slide's slot shows. */
  unavailable(): HTMLElement;
};

/** The slot's class, the class of a slot loading behind the error screen, and its slide id and state attributes
 * (`loading` | `ready` | `failed`). */
export type SlotMarkup = { slotClass: string; pendingClass: string; slideAttribute: string; stateAttribute: string };

export type SlideDeck = {
  readonly index: number;
  /** Not running: a user pause or any hold. */
  readonly paused: boolean;
  readonly userPaused: boolean;
  show(index: number, manual: boolean): void;
  next(manual: boolean): void;
  previous(manual: boolean): void;
  setUserPaused(value: boolean): void;
  hold(reason: HoldReason, on: boolean): void;
  /** Replaces the slides and starts again at `start` (a manual move); failures and the error screen are reset. */
  setSlides(slides: DeckSlide[], start: number): void;
  /** Share of the shown slide's time gone, 0 to 1. */
  progress(): number;
  /** Stops the timer, disposes the shown slide and drops any render still running. */
  dispose(): void;
};

/** Never shows a slide by itself: the caller calls `show(0, false)` once its hooks can read the deck. `slides` not empty. */
export function createSlideDeck(stage: HTMLElement, slides: DeckSlide[], slideMs: number, manifest: Manifest, hooks: DeckHooks,
  start: { userPaused: boolean }, markup: SlotMarkup): SlideDeck {
  let list = slides;
  let index = 0;
  let token = 0; // the render of the slide shown now; an older render is stale: disposed, never shown
  let current: { token: number; settled: boolean; dispose: () => void } = { token: 0, settled: true, dispose: () => {} };
  let failuresInRow = 0; // slides failed since the last that drew: all of them -> error screen
  let errorShown = false;
  let userPaused = start.userPaused;
  const holds = new Set<HoldReason>();
  let paused = userPaused;
  let timer: number | undefined;
  let remainingMs = slideMs;
  let segmentStart = 0;
  let disposed = false;

  const stopTimer = (): void => {
    if (!paused) remainingMs = Math.max(0, remainingMs - (performance.now() - segmentStart));
    clearTimeout(timer);
  };
  const armTimer = (): void => {
    clearTimeout(timer);
    segmentStart = performance.now();
    if (paused || disposed) return;
    timer = window.setTimeout(slideEnded, remainingMs);
  };

  async function draw(slot: HTMLElement, slide: DeckSlide): Promise<SlideResult> {
    try {
      return await hooks.draw(slot, slide);
    } catch (error) {
      console.error(error);
      return { ok: false, title: "", sources: [], dataCredits: [], notices: [], problem: [String(error)], dispose: () => {} };
    }
  }

  /** The slide `slot` holds failed (or was not ready at its end: `shown` false, it is left at once). */
  function slideFailed(slot: HTMLElement, shown: boolean): void {
    failuresInRow += 1;
    if (failuresInRow >= list.length) {
      failuresInRow = 0;
      errorShown = true;
      stage.replaceChildren(hooks.errorScreen());
      hooks.onAllFailed();
      return;
    }
    if (errorShown) slot.remove();
    else if (shown) slot.replaceChildren(hooks.unavailable());
  }

  function show(next: number, manual: boolean): void {
    if (disposed) return;
    index = (next + list.length) % list.length;
    const slide = list[index];
    const mine = ++token;
    current.dispose();
    const slot = h("div", { class: markup.slotClass, [markup.slideAttribute]: slide.id, [markup.stateAttribute]: "loading" });
    if (errorShown) {
      // the error screen stays until a slide draws; the slide loads hidden behind it
      stage.querySelector(`.${markup.slotClass}`)?.remove();
      slot.classList.add(markup.pendingClass);
      stage.append(slot);
    } else {
      stage.replaceChildren(slot);
    }
    const entry = { token: mine, settled: false, dispose: () => {} };
    current = entry;
    remainingMs = slideMs;
    armTimer();
    hooks.onShow(slide, index, list.length, manual);
    void draw(slot, slide).then((result) => {
      if (mine !== token) { // stale: a later slide is shown
        result.dispose();
        slot.remove();
        return;
      }
      entry.settled = true;
      entry.dispose = result.dispose;
      slot.setAttribute(markup.stateAttribute, result.ok ? "ready" : "failed");
      if (!result.ok) {
        slideFailed(slot, true);
        return;
      }
      failuresInRow = 0;
      if (errorShown) {
        errorShown = false;
        slot.classList.remove(markup.pendingClass);
        stage.replaceChildren(slot);
      }
      hooks.onReady(slide, result);
    });
  }

  function slideEnded(): void {
    if (!current.settled) slideFailed(stage.querySelector<HTMLElement>(`.${markup.slotClass}`) ?? stage, false);
    if (index + 1 >= list.length) void reloadOnNewVersion();
    show(index + 1, false);
  }

  /** Once per full cycle: a deploy since the page started -> reload (same address), so it never cites the old manifest's
   * releases and version for files first loaded after the deploy. Offline: the next cycle tries again. */
  async function reloadOnNewVersion(): Promise<void> {
    try {
      const latest = await loadFresh<Manifest>("data/manifest.json");
      if (latest.version !== manifest.version && !disposed) location.reload();
    } catch (error) {
      console.warn(error);
    }
  }

  /** Running = no user pause and no hold; the timer keeps its remaining time across a pause. */
  function sync(byUser: boolean, userBefore: boolean): void {
    const next = userPaused || holds.size > 0;
    const changed = next !== paused;
    if (changed) {
      stopTimer();
      paused = next;
      armTimer();
    }
    if (changed || userPaused !== userBefore) hooks.onPausedChange(paused, byUser);
  }

  return {
    get index() { return index; },
    get paused() { return paused; },
    get userPaused() { return userPaused; },
    show,
    next: (manual) => show(index + 1, manual),
    previous: (manual) => show(index - 1, manual),
    setUserPaused(value) {
      const before = userPaused;
      userPaused = value;
      sync(true, before);
    },
    hold(reason, on) {
      if (on === holds.has(reason)) return;
      if (on) holds.add(reason);
      else holds.delete(reason);
      sync(false, userPaused);
    },
    setSlides(next, first) {
      list = next;
      failuresInRow = 0;
      errorShown = false;
      show(first, true);
    },
    progress() {
      const running = paused ? 0 : performance.now() - segmentStart;
      return Math.min(1, (slideMs - remainingMs + running) / slideMs);
    },
    dispose() {
      disposed = true;
      token += 1;
      clearTimeout(timer);
      current.dispose();
    },
  };
}
