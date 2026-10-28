// Conference wallboard (`?view=wallboard` on index.html; spec "Conference wallboard"): a full-screen, in-page carousel of
// one chart per slide (`cfg.wallboard.slides`, each an embed query) for a TV, driven by keyboard, presentation clicker or
// remote. No header or footer; the bottom bar names the slide, its sources, the data version and the WIPO disclaimer.
// Draws what the embed draws (renderSlide); computes no figure. Never navigates (office `?rotate=` does: rotation.ts);
// reloads its own address only when a full cycle finds a new data version.
import { isListSource, loadFresh, loadJson, setFetchTimeout, type Config, type Entities, type Manifest, type Overview } from "./data";
import { h } from "./dom";
import { renderSlide, type SlideResult } from "./embed";
import { echoValue, isRotationSeconds, readParams, type Params } from "./params";
import { DISCLAIMER, releaseLabel } from "./provenance";

export const WALLBOARD_VIEW = "wallboard";
/** The board always draws in this theme (charts bake its colours; its tokens size the board for a room). */
export const WALLBOARD_THEME = "wallboard";

export type BoardAction = "pause" | "next" | "previous" | "fullscreen" | "slides" | "help";
/** Every key of the board: drives the handler (and the help overlay and methods text). `key` = KeyboardEvent.key, letters
 * lower case. Keys with Ctrl, Meta or Alt are never the board's. */
export const WALLBOARD_KEYS: { key: string; action: BoardAction; label: string }[] = [
  { key: " ", action: "pause", label: "Space" },
  { key: "Enter", action: "pause", label: "Enter" },
  { key: "MediaPlayPause", action: "pause", label: "Play/Pause media key" },
  { key: "k", action: "pause", label: "K" },
  { key: "ArrowRight", action: "next", label: "Right arrow" },
  { key: "PageDown", action: "next", label: "Page Down" },
  { key: "MediaTrackNext", action: "next", label: "Next track media key" },
  { key: "ArrowLeft", action: "previous", label: "Left arrow" },
  { key: "PageUp", action: "previous", label: "Page Up" },
  { key: "MediaTrackPrevious", action: "previous", label: "Previous track media key" },
  { key: "f", action: "fullscreen", label: "F" },
  { key: "s", action: "slides", label: "S" },
  { key: "h", action: "help", label: "H" },
  { key: "?", action: "help", label: "?" },
];
export const BOARD_ACTION_LABELS: Record<BoardAction, string> = {
  pause: "Pause or resume", next: "Next slide", previous: "Previous slide", fullscreen: "Full screen on or off",
  slides: "Slide picker", help: "Help",
};
/** "S, H or ?": the labels joined for a sentence. */
const joinWithOr = (labels: string[]): string => labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
/** Not in the key table: the browser's own `<dialog>` handling closes an overlay on Esc. The overlay keys come from the table. */
export const BOARD_ESCAPE_NOTE = `Esc closes the slide picker or help; its own key (${
  joinWithOr(WALLBOARD_KEYS.filter((entry) => entry.action === "slides" || entry.action === "help").map((entry) => entry.label))
}) and the Close button do too.`;

/** Spec: these colours of the board keep at least this contrast on its background (also at the lightest point of its
 * gradient) and on its card colour (`--surface`). Chart marks are graphics, not text, and not covered. Tokens as the theme
 * names them; the methods text and the e2e test read this list. */
export const BOARD_MIN_CONTRAST = 7;
export const BOARD_CONTRAST_COLOURS = [
  { token: "--ink", name: "text" }, { token: "--muted", name: "muted text" },
  { token: "--accent", name: "accent" }, { token: "--error-ink", name: "error text" },
];

/** The key table grouped by action, in table order: what the help overlay and the methods page list. */
export function keyTableRows(): { action: BoardAction; label: string; keys: string[] }[] {
  const rows: { action: BoardAction; label: string; keys: string[] }[] = [];
  for (const entry of WALLBOARD_KEYS) {
    const row = rows.find((candidate) => candidate.action === entry.action);
    if (row) row.keys.push(entry.label);
    else rows.push({ action: entry.action, label: BOARD_ACTION_LABELS[entry.action], keys: [entry.label] });
  }
  return rows;
}

/** Message the picker shows when Apply finds no slide ticked. */
const PICKER_EMPTY = "Tick at least one slide.";
/** Marks the bar notices that come from `?slides=`: they stop being true once the picker rewrites the address. */
const SLIDES_NOTICE_ATTRIBUTE = "data-slides-notice";

/** Used only when config.json's value is missing or invalid (a notice says so), or before it loads (main.ts);
 * config.json holds the values in force. */
const FALLBACK = { seconds: 30, hideControlsSeconds: 4, fetchTimeoutSeconds: 15, safeAreaPercent: 3 };
/** Overscan padding above this would leave no room for the slide. */
const MAX_SAFE_AREA_PERCENT = 20;
/** Progress bar update step; the theme's transition smooths it, reduced motion shows the steps. */
const PROGRESS_STEP_MS = 1000;
const UNAVAILABLE = "Data unavailable for this chart";

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** `wallboard.fetchTimeoutSeconds`, or the fallback when invalid (boardSettings reports it) or config.json is not
 * loaded yet (no `cfg`). */
export function boardFetchTimeoutSeconds(cfg?: Config): number {
  const seconds = cfg?.wallboard?.fetchTimeoutSeconds;
  return isPositive(seconds) ? seconds : FALLBACK.fetchTimeoutSeconds;
}

type BoardSlide = { id: string; label: string; params: Params };
type Settings = {
  seconds: number; hideControlsSeconds: number; fetchTimeoutSeconds: number; safeAreaPercent: number;
  /** every valid configured slide, in config order (the picker's choices) */
  available: BoardSlide[];
  /** the slides shown: `available`, or the `?slides=` choice */
  slides: BoardSlide[];
  /** notices about `?slides=` (kept apart from the others: the picker clears them) */
  slidesNotices: string[];
};

/** Checked settings: an invalid value -> notice, fallback used; invalid slides dropped with a notice; `?slides=` keeps
 * the order given, drops duplicates (silently) and unknown ids (notice), empty or all unknown -> every slide. */
function boardSettings(cfg: Config, params: Params, notices: string[]): Settings {
  const board = (cfg.wallboard ?? {}) as Partial<Config["wallboard"]>;
  if (!cfg.wallboard) notices.push("No wallboard settings in config.json: defaults used");
  const checked = (key: keyof typeof FALLBACK, valid: (value: unknown) => boolean, rule: string): number => {
    const value = board[key];
    if (valid(value)) return value as number;
    if (cfg.wallboard) notices.push(`Invalid wallboard.${key} in config.json: ${String(value)} (${rule}): ${FALLBACK[key]} used`);
    return FALLBACK[key];
  };
  const configured = checked("seconds", (value) => typeof value === "number" && isRotationSeconds(cfg, value),
    `whole seconds, at least ${cfg.rotation.minSeconds}`);
  const settings: Settings = {
    seconds: params.rotate ? Number(params.rotate) : configured,
    hideControlsSeconds: checked("hideControlsSeconds", isPositive, "seconds above 0"),
    fetchTimeoutSeconds: checked("fetchTimeoutSeconds", isPositive, "seconds above 0"),
    safeAreaPercent: checked("safeAreaPercent",
      (value) => typeof value === "number" && value >= 0 && value <= MAX_SAFE_AREA_PERCENT, `0 to ${MAX_SAFE_AREA_PERCENT}`),
    available: [],
    slides: [],
    slidesNotices: [],
  };
  const all: BoardSlide[] = [];
  for (const slide of Array.isArray(board.slides) ? board.slides : []) {
    const valid = slide && typeof slide.id === "string" && typeof slide.label === "string" && typeof slide.params === "string" &&
      slide.id && !all.some((other) => other.id === slide.id);
    if (!valid) {
      notices.push(`Invalid wallboard slide in config.json left out: ${JSON.stringify(slide)}`);
      continue;
    }
    const read = readParams(`?${slide.params}`, cfg);
    if (!read.params.chart) {
      notices.push(`Wallboard slide ${slide.id} names no chart: left out`);
      continue;
    }
    notices.push(...read.notices.map((line) => `Wallboard slide ${slide.id}: ${line}`));
    all.push({ id: slide.id, label: slide.label, params: { ...read.params, theme: WALLBOARD_THEME } });
  }
  settings.available = all;
  settings.slides = all;
  if (params.slides === undefined) return settings;
  const asked = [...new Set(params.slides.split(",").map((id) => id.trim()).filter(Boolean))];
  const unknown = asked.filter((id) => !all.some((slide) => slide.id === id));
  const chosen = asked.flatMap((id) => all.filter((slide) => slide.id === id));
  // judged as one value: one word per id must not spell a sentence
  if (unknown.length) settings.slidesNotices.push(`Unknown slides: ${echoValue(unknown.join(","))}`);
  if (chosen.length) settings.slides = chosen;
  else if (asked.length) settings.slidesNotices.push("No known slide in ?slides=: showing every slide");
  return settings;
}

/** What the board runs with, for the methods page: boardSettings' checked seconds and slide ids (its fallbacks when
 * config.json lacks or breaks a value), never config.json's raw values. */
export function boardFacts(cfg: Config): { seconds: number; slideIds: string[] } {
  const settings = boardSettings(cfg, { theme: WALLBOARD_THEME }, []);
  return { seconds: settings.seconds, slideIds: settings.available.map((slide) => slide.id) };
}

/** A slide or its failure, never a throw (a load error or timeout = failed). */
async function drawSlide(slot: HTMLElement, slide: BoardSlide, cfg: Config, manifest: Manifest): Promise<SlideResult> {
  try {
    const [entities, overview] = await Promise.all([loadJson<Entities>("data/entities.json"), loadJson<Overview>("data/overview.json")]);
    return await renderSlide(slot, slide.params, { cfg, manifest, entities, overview }, true);
  } catch (error) {
    console.error(error);
    return { ok: false, title: "", sources: [], dataCredits: [], notices: [], problem: [String(error)], dispose: () => {} };
  }
}

/** "Source: WIPO Statistics Database (release May 2026); World Bank WDI" (a published list: its name and status): the slide's own source blocks, each distinct
 * name and release once, plus World Bank WDI when the slide uses it (its full credit line stays in the card). */
function creditsText(result: SlideResult, manifest: Manifest): string {
  const names = result.sources.map((src) => (isListSource(src) ? `${src.name} (${src.status})`
    : `${src.name} (release ${releaseLabel(manifest.releases[src.tab])})`));
  if (result.dataCredits.some((line) => line.includes("World Bank WDI"))) names.push("World Bank WDI (CC BY 4.0)");
  return `Source: ${[...new Set(names)].join("; ")}`;
}

function isFormField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

/** A focused button, link (an SVG map link too) or form control: Space and Enter are its own (one press, one action). */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, summary, input, select, textarea") !== null;
}

/** Starts the board in `app` (header and footer already left out by main.ts). `notices` = the address' notices, shown in
 * the bar with the board's own. */
export function startWallboard(app: HTMLElement, cfg: Config, manifest: Manifest, params: Params, notices: string[] = []): void {
  const settings = boardSettings(cfg, params, notices);
  setFetchTimeout(settings.fetchTimeoutSeconds);
  let { slides } = settings;
  const slideMs = settings.seconds * 1000;
  const hideMs = settings.hideControlsSeconds * 1000;
  document.documentElement.classList.add("board-mode");

  const stage = h("div", { class: "board-stage" });
  const label = h("span", { class: "board-label" });
  const count = h("span", { class: "board-count" });
  const pausedBadge = h("span", { class: "board-paused", hidden: "" }, "Paused");
  const credits = h("p", { class: "board-credits" });
  const noticeList = h("div", { class: "board-notices" });
  const fullscreenNotice = h("p", { class: "board-notice", hidden: "" });
  const live = h("div", { class: "visually-hidden", "aria-live": "polite" });
  const fill = h("div", { class: "board-progress-fill" });
  const button = (action: BoardAction, text: string): HTMLButtonElement => {
    const element = h("button", { type: "button", class: "board-button", "data-action": action }, text);
    element.addEventListener("click", () => act(action, true));
    return element;
  };
  const pauseButton = button("pause", "Pause");
  const controls = h("div", { class: "board-controls", role: "toolbar", "aria-label": "Wallboard controls" },
    button("previous", "Previous"), pauseButton, button("next", "Next"), button("fullscreen", "Full screen"),
    button("slides", "Slides"), button("help", "Help"));
  const pickerList = h("ol", { class: "board-picker-list" });
  const pickerStatus = h("p", { class: "visually-hidden", "aria-live": "polite" }); // announces a reorder (the board's own live region is inert behind the dialog)
  const pickerMessage = h("p", { class: "board-picker-message", role: "alert", hidden: "" });
  const closeButton = (): HTMLButtonElement => h("button", { type: "button", class: "board-button", "data-close": "" }, "Close");
  const pickerDialog = h("dialog", { class: "board-dialog", "data-overlay": "slides", "aria-labelledby": "board-picker-title" },
    h("h2", { id: "board-picker-title" }, BOARD_ACTION_LABELS.slides),
    h("p", {}, "Tick the slides to show and move them into the order you want."),
    pickerList, pickerStatus, pickerMessage,
    h("div", { class: "board-dialog-actions" }, h("button", { type: "button", class: "board-button", "data-apply": "" }, "Apply"), closeButton()));
  const helpDialog = h("dialog", { class: "board-dialog", "data-overlay": "help", "aria-labelledby": "board-help-title" },
    h("h2", { id: "board-help-title" }, "Keys"),
    h("dl", { class: "board-keys" }, keyTableRows().map((row) => [h("dt", {}, row.label), h("dd", {}, row.keys.join(", "))])),
    h("p", {}, BOARD_ESCAPE_NOTE),
    h("div", { class: "board-dialog-actions" }, closeButton()));
  const overlays: Record<"slides" | "help", HTMLDialogElement> = { slides: pickerDialog, help: helpDialog };
  const versionText = typeof manifest.version === "string" && manifest.version ? `Data version ${manifest.version}` : null;
  const board = h("div", { class: "board", "data-idle": "" },
    h("h1", { class: "visually-hidden" }, `${cfg.siteName}: conference wallboard`),
    stage,
    controls,
    h("div", { class: "board-progress", "aria-hidden": "true" }, fill),
    h("div", { class: "board-bar" },
      h("p", { class: "board-title" }, label, count, pausedBadge),
      h("p", { class: "board-meta" }, credits,
        versionText ? h("span", { class: "board-version" }, versionText) : null,
        h("span", { class: "board-site" }, cfg.siteName)),
      noticeList, fullscreenNotice,
      h("p", { class: "board-disclaimer" }, DISCLAIMER)),
    live, pickerDialog, helpDialog);
  // TV overscan: the config's percent of each side (height for top and bottom, width for the sides)
  board.style.padding = `${settings.safeAreaPercent}vh ${settings.safeAreaPercent}vw`;
  noticeList.replaceChildren(...notices.map((text) => h("p", { class: "board-notice" }, text)),
    ...settings.slidesNotices.map((text) => h("p", { class: "board-notice", [SLIDES_NOTICE_ATTRIBUTE]: "" }, text)));
  app.replaceChildren(board);

  let index = 0;
  let token = 0; // the render of the slide shown now; an older render is stale: disposed, never shown
  let current: { token: number; settled: boolean; dispose: () => void } = { token: 0, settled: true, dispose: () => {} };
  let failuresInRow = 0; // slides failed since the last that drew: all of them -> error screen
  let errorShown = false;
  let paused = false;
  let timer: number | undefined;
  let ticker: number | undefined;
  let remainingMs = slideMs;
  let segmentStart = 0;

  const progress = (): void => {
    const running = paused ? 0 : performance.now() - segmentStart;
    const done = Math.min(1, (slideMs - remainingMs + running) / slideMs);
    fill.style.width = `${done * 100}%`;
  };
  const stopTimer = (): void => {
    if (!paused) remainingMs = Math.max(0, remainingMs - (performance.now() - segmentStart));
    clearTimeout(timer);
    clearInterval(ticker);
  };
  const armTimer = (): void => {
    clearTimeout(timer);
    clearInterval(ticker);
    segmentStart = performance.now();
    progress();
    if (paused) return;
    timer = window.setTimeout(slideEnded, remainingMs);
    ticker = window.setInterval(progress, PROGRESS_STEP_MS);
  };

  const errorScreen = (): HTMLElement => h("div", { class: "board-error", role: "alert" },
    h("p", { class: "board-error-title" }, "The charts could not be loaded."),
    h("p", {}, "Trying again with the next round of slides."));

  /** The slide `slot` holds failed (or was not ready at its end: `shown` false, it is left at once). */
  function slideFailed(slot: HTMLElement, shown: boolean): void {
    failuresInRow += 1;
    if (failuresInRow >= slides.length) {
      failuresInRow = 0;
      errorShown = true;
      label.textContent = "Data unavailable";
      credits.textContent = "";
      stage.replaceChildren(errorScreen());
      return;
    }
    if (errorShown) slot.remove();
    else if (shown) slot.replaceChildren(h("p", { class: "board-unavailable", role: "status" }, UNAVAILABLE));
  }

  function show(next: number, manual: boolean): void {
    index = (next + slides.length) % slides.length;
    const slide = slides[index];
    const mine = ++token;
    current.dispose();
    const slot = h("div", { class: "board-slot", "data-slide": slide.id, "data-state": "loading" });
    if (errorShown) {
      // the error screen stays until a slide draws; the slide loads hidden behind it
      stage.querySelector(".board-slot")?.remove();
      slot.classList.add("board-slot--pending");
      stage.append(slot);
    } else {
      stage.replaceChildren(slot);
      label.textContent = slide.label;
      credits.textContent = "";
    }
    count.textContent = `${index + 1} / ${slides.length}`;
    const entry = { token: mine, settled: false, dispose: () => {} };
    current = entry;
    remainingMs = slideMs;
    armTimer();
    if (manual) live.textContent = `Slide ${index + 1} of ${slides.length}: ${slide.label}`;
    void drawSlide(slot, slide, cfg, manifest).then((result) => {
      if (mine !== token) { // stale: a later slide is shown
        result.dispose();
        slot.remove();
        return;
      }
      entry.settled = true;
      entry.dispose = result.dispose;
      slot.dataset.state = result.ok ? "ready" : "failed";
      if (!result.ok) {
        slideFailed(slot, true);
        return;
      }
      failuresInRow = 0;
      if (errorShown) {
        errorShown = false;
        slot.classList.remove("board-slot--pending");
        stage.replaceChildren(slot);
      }
      label.textContent = slide.label;
      credits.textContent = creditsText(result, manifest);
    });
  }

  function slideEnded(): void {
    if (!current.settled) slideFailed(stage.querySelector<HTMLElement>(".board-slot") ?? stage, false);
    if (index + 1 >= slides.length) void reloadOnNewVersion();
    show(index + 1, false);
  }

  /** Once per full cycle: a deploy since the board started -> reload (same address), so the bar never cites the old
   * manifest's releases and version for files first loaded after the deploy. Offline: the next cycle tries again. */
  async function reloadOnNewVersion(): Promise<void> {
    try {
      const latest = await loadFresh<Manifest>("data/manifest.json");
      if (latest.version !== manifest.version) location.reload();
    } catch (error) {
      console.warn(error);
    }
  }

  function setPaused(value: boolean, announce = true): void {
    if (value === paused) return;
    stopTimer();
    paused = value;
    pausedBadge.hidden = !paused;
    pauseButton.textContent = paused ? "Resume" : "Pause";
    if (announce) live.textContent = paused ? "Paused" : "Resumed";
    armTimer();
  }

  // Overlays: open pauses; any close (Esc, its key, Close, Apply) restores the pause state from before opening.
  let openOverlay: "slides" | "help" | null = null;
  let pausedBeforeOverlay = false;
  function toggleOverlay(name: "slides" | "help"): void {
    syncOverlay();
    if (openOverlay === name) {
      closeOverlay(name);
      return;
    }
    if (openOverlay) return;
    if (name === "slides") fillPicker();
    openOverlay = name;
    pausedBeforeOverlay = paused;
    setPaused(true, false);
    overlays[name].showModal();
  }
  /** The dialog's `close` event comes later than `close()`: the state is restored here at once (so a quick next key
   * finds it right) and again, harmlessly, when the event arrives (Esc closes the dialog without calling this). */
  function closeOverlay(name: "slides" | "help"): void {
    overlays[name].close();
    restoreAfterOverlay(name);
  }
  /** Esc closes the dialog before its `close` event runs: a key or click arriving in between finds the state as is. */
  function syncOverlay(): void {
    if (openOverlay && !overlays[openOverlay].open) restoreAfterOverlay(openOverlay);
  }
  function restoreAfterOverlay(name: "slides" | "help"): void {
    if (openOverlay !== name) return;
    openOverlay = null;
    pickerMessage.hidden = true;
    // focus the browser has not yet moved out of the closed dialog would swallow the next key (a tick box or button)
    if (overlays[name].contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    setPaused(pausedBeforeOverlay, false);
  }
  for (const [name, dialog] of Object.entries(overlays) as ["slides" | "help", HTMLDialogElement][]) {
    dialog.addEventListener("close", () => { if (!dialog.open) restoreAfterOverlay(name); }); // not a stale event of an earlier close
    dialog.querySelector("[data-close]")?.addEventListener("click", () => closeOverlay(name));
  }

  /** One picker row per configured slide: the shown slides first, in their order, then the rest in config order. */
  function fillPicker(): void {
    const rest = settings.available.filter((slide) => !slides.includes(slide));
    pickerList.replaceChildren(...[...slides, ...rest].map((slide) => {
      const move = (step: -1 | 1, text: string): HTMLButtonElement => {
        const control = h("button", { type: "button", class: "board-button", "data-move": text.toLowerCase(), "aria-label": `${text}: ${slide.label}` }, text);
        control.addEventListener("click", () => {
          const row = control.closest("li")!;
          const other = step < 0 ? row.previousElementSibling : row.nextElementSibling;
          if (!other) return;
          if (step < 0) other.before(row); else other.after(row);
          refreshMoveButtons();
          pickerStatus.textContent = `${slide.label}: position ${[...pickerList.children].indexOf(row) + 1} of ${pickerList.children.length}`;
          // a button disabled by the move (the row reached an end) cannot keep focus: the opposite one takes it
          if (control.disabled) row.querySelector<HTMLButtonElement>(`button[data-move="${step < 0 ? "down" : "up"}"]`)?.focus();
          else control.focus();
        });
        return control;
      };
      const box = h("input", { type: "checkbox", value: slide.id });
      box.checked = slides.includes(slide);
      return h("li", { "data-slide": slide.id }, h("label", {}, box, " ", slide.label), move(-1, "Up"), move(1, "Down"));
    }));
    refreshMoveButtons();
    pickerStatus.textContent = "";
    pickerMessage.hidden = true;
  }
  /** Up is off for the first row, Down for the last. */
  function refreshMoveButtons(): void {
    const rows = [...pickerList.children];
    rows.forEach((row, position) => {
      row.querySelector<HTMLButtonElement>('button[data-move="up"]')!.disabled = position === 0;
      row.querySelector<HTMLButtonElement>('button[data-move="down"]')!.disabled = position === rows.length - 1;
    });
  }
  /** Shows exactly these slides, in this order, without a reload; the address follows (`?slides=` leaves when it
   * would only repeat the configured list). */
  function applySlides(ids: string[]): void {
    slides = ids.map((id) => settings.available.find((slide) => slide.id === id)!);
    const all = settings.available.map((slide) => slide.id);
    const url = new URL(location.href);
    url.searchParams.delete("slides");
    const rest = url.searchParams.toString();
    const repeatsConfig = ids.length === all.length && ids.every((id, position) => id === all[position]);
    const query = [rest, repeatsConfig ? "" : `slides=${ids.map(encodeURIComponent).join(",")}`].filter(Boolean).join("&");
    history.replaceState(history.state, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
    for (const notice of noticeList.querySelectorAll(`[${SLIDES_NOTICE_ATTRIBUTE}]`)) notice.remove();
    failuresInRow = 0;
    errorShown = false;
    show(0, true);
  }
  pickerDialog.querySelector("[data-apply]")?.addEventListener("click", () => {
    const ids = [...pickerList.querySelectorAll<HTMLInputElement>("li")].flatMap((row) => {
      const box = row.querySelector<HTMLInputElement>("input")!;
      return box.checked ? [box.value] : [];
    });
    if (ids.length === 0) {
      pickerMessage.textContent = PICKER_EMPTY;
      pickerMessage.hidden = false;
      return;
    }
    applySlides(ids);
    closeOverlay("slides");
  });

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (typeof document.documentElement.requestFullscreen === "function") await document.documentElement.requestFullscreen();
      else throw new Error("no Fullscreen API");
      fullscreenNotice.hidden = true;
    } catch {
      fullscreenNotice.textContent = "Full screen was refused here: use the browser's own full screen command (often F11).";
      fullscreenNotice.hidden = false;
    }
  }

  function act(action: BoardAction, manual: boolean): void {
    if (action === "pause") setPaused(!paused);
    else if (action === "next") show(index + 1, manual);
    else if (action === "previous") show(index - 1, manual);
    else if (action === "slides" || action === "help") toggleOverlay(action);
    else void toggleFullscreen();
  }

  // a control focused by a pointer press (not Tab or script): a key acting on the board gives its focus back, else a
  // clicker would hold the bar and cursor up for the rest of the run
  let pressedControl: Element | null = null;
  controls.addEventListener("pointerdown", (event) => { pressedControl = (event.target as Element).closest("button"); });
  controls.addEventListener("focusout", (event) => { if (event.target === pressedControl) pressedControl = null; });

  let hideTimer: number | undefined;
  const hideControls = (): void => {
    // never while the controls hold focus: a hidden button would drop it
    if (controls.contains(document.activeElement)) hideTimer = window.setTimeout(hideControls, hideMs);
    else board.setAttribute("data-idle", "");
  };
  const showControls = (): void => {
    board.removeAttribute("data-idle");
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hideControls, hideMs);
  };
  // pointer movement shows the controls, never pauses (a kiosk TV: people walk past the mouse)
  document.addEventListener("pointermove", showControls, { passive: true });
  document.addEventListener("pointerdown", showControls, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    showControls();
    if (event.repeat) return; // a held key (TV remote long press) acts once
    syncOverlay();
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const entry = WALLBOARD_KEYS.find((candidate) => candidate.key === key);
    if (openOverlay) {
      // an overlay is open: its own key closes it (even from a tick box); every other key is the dialog's (Esc: the
      // browser's own close), so Space on a tick box ticks it and the board never moves behind the dialog
      if (entry?.action === openOverlay) {
        event.preventDefault();
        toggleOverlay(openOverlay);
      }
      return;
    }
    // a key aimed at a control of a dialog that Esc just closed (focus not yet moved out) is the board's
    const target = event.target instanceof Node && Object.values(overlays).some((dialog) => !dialog.open && dialog.contains(event.target as Node))
      ? document.body : event.target;
    if (!entry || isFormField(target)) return;
    if ((key === " " || key === "Enter") && isControl(target)) return; // the focused control acts on it, once
    event.preventDefault();
    act(entry.action, true);
    if (pressedControl && document.activeElement === pressedControl) (pressedControl as HTMLElement).blur();
  });

  const keepAwake = (): void => {
    const lock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<unknown> } }).wakeLock;
    lock?.request("screen").catch(() => {}); // refused or unsupported: the board runs on
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
  keepAwake();

  if (slides.length === 0) {
    label.textContent = "No slides";
    stage.replaceChildren(h("div", { class: "board-error", role: "alert" },
      h("p", { class: "board-error-title" }, "No wallboard slides are configured."),
      h("p", {}, "Add slides to wallboard.slides in config.json.")));
    return;
  }
  show(0, false);
}
