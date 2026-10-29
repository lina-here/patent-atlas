// Wallboard rotation: `?rotate=<seconds>` (checked in readParams) shows `cfg.rotation.views` in turn by navigating
// to the next one. A view is a query string relative to index.html (`chart=world-trend`, `country=CN`). A full
// navigation, not a redraw: charts bake theme colours at draw time. Any pointer or keyboard use pauses it; after
// `cfg.rotation.resumeAfterSeconds` without use it resumes by itself.
import type { Config } from "./data";
import { h } from "./dom";
import { PAGE_KEYS, addressParams, isPauseMovePixels, isRotationSeconds, withParams, type Params } from "./params";

const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"];

/** Index of the view the address shows now (all its keys equal, case-insensitive; the view with most keys wins, so
 * `chart=world-map&metric=per_million` is not taken for the plain `chart=world-map`), -1 when none. */
function currentViewIndex(views: string[], search: string): number {
  const current = new URLSearchParams(search);
  let best = -1;
  let bestKeys = -1;
  views.forEach((view, index) => {
    const pairs = [...new URLSearchParams(view)];
    if (pairs.length > bestKeys && pairs.every(([key, value]) => current.get(key)?.trim().toLowerCase() === value.toLowerCase())) {
      best = index;
      bestKeys = pairs.length;
    }
  });
  return best;
}

/** Link to the view after the current one (the first when the address matches none), built from the checked
 * `params`. Keeps theme, rotate and any state no view sets (a fixed `?year=` for the whole wallboard); clears the
 * keys that pick a page and every key some view sets, so one view's keys never leak into the next. */
export function nextViewLink(cfg: Config, params: Params, search: string): string {
  const { views } = cfg.rotation;
  const next = new URLSearchParams(views[(currentViewIndex(views, search) + 1) % views.length]);
  const cleared: Partial<Params> = {};
  for (const key of PAGE_KEYS) cleared[key] = undefined;
  for (const view of views) for (const key of new URLSearchParams(view).keys()) cleared[key as keyof Params] = undefined;
  return withParams({ ...addressParams(cfg, params), ...cleared, ...Object.fromEntries(next) }, "./");
}

/** The page has drawn its view: ends the hidden state `html.rotating` holds it in and starts the fade-in. */
export function markViewReady(): void {
  document.documentElement.classList.add("view-ready");
}

/** Starts rotating when `params.rotate` is set; returns the header status + resume control, else null. */
export function startRotation(cfg: Config, params: Params): HTMLElement | null {
  const { views, resumeAfterSeconds, pauseMovePixels } = cfg.rotation;
  // an invalid delay was reported in readParams: a pause then lasts until the user resumes
  const autoResume = isRotationSeconds(cfg, resumeAfterSeconds);
  // an invalid threshold was reported in readParams: any travel then pauses
  const pauseThreshold = isPauseMovePixels(pauseMovePixels) ? pauseMovePixels : 0;
  if (!params.rotate || views.length === 0) return null;
  const seconds = Number(params.rotate);
  document.documentElement.classList.add("rotating");
  const runningText = `Rotating every ${seconds} s`;
  const status = h("span", { class: "rotation-status", role: "status", tabindex: "-1" }, runningText);
  const resume = h("button", { type: "button", class: "rotation-resume", hidden: "" }, "Resume rotation");
  let timer: number | undefined;
  let idleTimer: number | undefined;
  let movedPixels = 0; // pointer travel since the last resume

  const arm = (): void => {
    timer = window.setTimeout(() => location.replace(nextViewLink(cfg, params, location.search)), seconds * 1000);
  };
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    if (!autoResume) return;
    idleTimer = window.setTimeout(resumeRotation, resumeAfterSeconds * 1000);
  };
  function resumeRotation(): void {
    clearTimeout(idleTimer);
    // a hidden button would drop focus to <body>: the status takes it
    const hadFocus = document.activeElement === resume;
    movedPixels = 0;
    resume.hidden = true;
    status.textContent = runningText;
    if (hadFocus) status.focus();
    arm();
  }
  const interaction = (event: Event): void => {
    if (event.type === "pointermove") {
      // jitter, or a pointer that has not moved (layout shift under it), is not use: only real travel is
      // movementX/Y can be missing or NaN (synthetic events): counted as 0
      const { movementX, movementY } = event as PointerEvent;
      const travel = Math.hypot(Number.isFinite(movementX) ? movementX : 0, Number.isFinite(movementY) ? movementY : 0);
      if (travel === 0) return; // nor restarts the auto-resume wait
      movedPixels += travel;
      if (movedPixels < pauseThreshold) return;
    }
    if (timer === undefined) return;
    if (resume.hidden) {
      clearTimeout(timer);
      resume.hidden = false;
      status.textContent = "Rotation paused";
    }
    armIdle();
  };
  resume.addEventListener("click", resumeRotation);
  for (const type of INTERACTION_EVENTS) document.addEventListener(type, interaction, { capture: true, passive: true });
  arm();
  return h("span", { class: "rotation-control" }, status, resume);
}
