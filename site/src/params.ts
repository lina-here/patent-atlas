// URL params shared by every page. Stable: shared links depend on them. Every key is listed in `Params` and
// `PARAM_KEYS`; PAGE_PARAMS, `linkParams` and rotation derive from that list, so cite, share and embed links
// reproduce the exact figure (`rotate` excepted: a link to a figure must not rotate away from it).
import { MAP_METRICS } from "./atlas";
import type { Config } from "./data";

export type Params = {
  theme: string; country?: string; office?: string; chart?: string;
  region?: string; continent?: string; map?: string; metric?: string; year?: string; rotate?: string; view?: string;
  /** Wallboard slide ids, comma separated (checked against `wallboard.slides` by wallboard.ts). */
  slides?: string;
};

/** Values of `?view=` (a named page of the overview family); index.html shows the overview for any other. */
export const VIEWS = ["women-inventors", "releases", "wallboard"] as const;
/** Keys that name a page of their own: they win over `view`. */
const ENTITY_PAGE_KEYS = ["country", "office", "region", "continent"] as const;

/** Keys that choose which page or figure the address shows. */
export const PAGE_KEYS = ["country", "office", "chart", "region", "continent", "view"] as const;
/** Figure state a rotation view may set or leave alone. */
const STATE_KEYS = ["map", "metric", "year"] as const;
const PARAM_KEYS = ["theme", ...PAGE_KEYS, ...STATE_KEYS, "rotate", "slides"] as const;

/** Everything but the theme, as undefined: passed to `withParams` it makes a link to another page (the theme
 * stays; a chosen figure, map state or wallboard rotation does not travel with a navigation link). */
export const PAGE_PARAMS: Partial<Params> = Object.fromEntries(
  PARAM_KEYS.filter((key) => key !== "theme").map((key) => [key, undefined]));

/** Every key of the checked `params`, explicit (absent = undefined): a link built from it never picks up the
 * address's raw, possibly invalid values (`withParams` reads the address for keys it is not given). */
export function linkParams(params: Params): Partial<Params> {
  return Object.fromEntries(PARAM_KEYS.map((key) => [key, params[key]]));
}

/** The checked `params` as link params: every key explicit, the theme left out when it is the default. A link
 * built from it never carries the address's raw, possibly invalid values. */
export function addressParams(cfg: Config, params: Params): Partial<Params> {
  return { ...linkParams(params), theme: params.theme === cfg.defaultTheme ? undefined : params.theme };
}

/** Link to another `page`: theme only, from the checked `params` (none when the config or params are not known). */
export function pageLink(cfg: Config | undefined, params: Params | undefined, page: string): string {
  const theme = cfg && params && params.theme !== cfg.defaultTheme ? params.theme : undefined;
  return withParams({ ...PAGE_PARAMS, theme }, page);
}

/** Link to a view of the full site (`?view=releases`, `?view=wallboard`): theme only, as `pageLink` (the wallboard draws in its
 * own theme). */
export function viewLink(cfg: Config | undefined, params: Params | undefined, view: "releases" | "wallboard"): string {
  const theme = cfg && params && params.theme !== cfg.defaultTheme ? params.theme : undefined;
  return withParams({ ...PAGE_PARAMS, theme, view }, "./");
}

/** Shape checks for the map params (value sets are checked where the data is known). */
const MAP_MODES = ["country", "region", "continent"];
const REGION_ID = /^\d{3}$/; // UN M49 region code
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const YEAR = /^\d{4}$/;
const WHOLE_NUMBER = /^\d+$/;
/** setTimeout fires at once beyond 2^31-1 ms; longer intervals are refused, not wrapped. */
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** Address values a notice may repeat: letters, digits, `_ . , -`, 1 to 24 characters. Any other value, a sentence
 * above all, is shown as NOT_SHOWN: a link must not put its own words on the site's origin, an embed or a TV
 * (README "Security"). */
const ECHO_SAFE = /^[\w.,-]{1,24}$/;
const NOT_SHOWN = "(not shown)";

/** `value` from the address as a notice may repeat it (ECHO_SAFE), else NOT_SHOWN: the notice still says it was ignored. */
export function echoValue(value: string): string {
  return ECHO_SAFE.test(value) ? value : NOT_SHOWN;
}

/** Theme falls back to the default (with a notice). Country/office are only normalised here (trimmed,
 * upper case); main.ts checks them against entities.json once it loads. */
export function readParams(search: string, cfg: Config): { params: Params; notices: string[] } {
  const query = new URLSearchParams(search);
  const notices: string[] = [];
  const params: Params = { theme: cfg.defaultTheme };

  const theme = query.get("theme")?.trim();
  if (theme) {
    if (cfg.themes.includes(theme)) params.theme = theme;
    else notices.push(`Unknown theme: ${echoValue(theme)}`);
  }
  readPageKeys(query, params, notices);
  const slides = query.get("slides")?.trim();
  if (slides !== undefined && params.view === "wallboard") params.slides = slides;
  const rotate = query.get("rotate")?.trim();
  if (rotate && params.view === "wallboard") {
    // the board's own interval (wallboard.ts): office rotation views and its pause settings do not apply
    const seconds = WHOLE_NUMBER.test(rotate) ? Number(rotate) : NaN;
    if (isRotationSeconds(cfg, seconds)) params.rotate = String(seconds);
    else notices.push(`Invalid rotate: ${echoValue(rotate)} (whole seconds, at least ${cfg.rotation.minSeconds}): default interval used`);
  } else if (rotate) {
    const seconds = WHOLE_NUMBER.test(rotate) ? Number(rotate) : NaN;
    if (cfg.rotation.views.length === 0) notices.push("Rotation has no views configured: no rotation");
    else if (isRotationSeconds(cfg, seconds)) {
      params.rotate = String(seconds);
      const { resumeAfterSeconds } = cfg.rotation;
      if (!isRotationSeconds(cfg, resumeAfterSeconds)) {
        notices.push(`Invalid rotation.resumeAfterSeconds in config.json: ${resumeAfterSeconds} (whole seconds, at least ${cfg.rotation.minSeconds}): a paused rotation stays paused until resumed`);
      }
      const { pauseMovePixels } = cfg.rotation;
      if (!isPauseMovePixels(pauseMovePixels)) {
        notices.push(`Invalid rotation.pauseMovePixels in config.json: ${pauseMovePixels} (a number of pixels, 0 or more): any pointer movement pauses`);
      }
    } else notices.push(`Invalid rotate: ${echoValue(rotate)} (whole seconds, at least ${cfg.rotation.minSeconds}): no rotation`);
  }
  return { params, notices };
}

/** The page and figure keys: they need no config.json. */
function readPageKeys(query: URLSearchParams, params: Params, notices: string[]): void {
  const country = query.get("country")?.trim().toUpperCase();
  if (country) params.country = country;
  const office = query.get("office")?.trim().toUpperCase();
  if (office) params.office = office;
  const chart = query.get("chart")?.trim();
  if (chart) params.chart = chart;
  readChecked(query, params, notices, "region", "region", (v) => REGION_ID.test(v));
  readChecked(query, params, notices, "continent", "continent", (v) => SLUG.test(v));
  readChecked(query, params, notices, "map", "map mode", (v) => MAP_MODES.includes(v));
  readChecked(query, params, notices, "metric", "metric", (v) => (MAP_METRICS as string[]).includes(v));
  readChecked(query, params, notices, "year", "year", (v) => YEAR.test(v));
  readChecked(query, params, notices, "view", "view", (v) => (VIEWS as readonly string[]).includes(v));
  const entityKey = ENTITY_PAGE_KEYS.find((key) => params[key]);
  if (params.view && entityKey) {
    // generic rule: an unknown country is only found out later, when entities.json loads
    notices.push(`View ${params.view} left out: a country, office, region or continent in the address wins over a view.`);
    delete params.view;
  }
}

/** The view the address shows, by readParams' rules, before config.json loads (main.ts: the wallboard retries it). */
export function addressView(search: string): string | undefined {
  const params: Params = { theme: "" };
  readPageKeys(new URLSearchParams(search), params, []);
  return params.view;
}

/** A rotation interval (`?rotate=`, `resumeAfterSeconds`): whole seconds, at least `minSeconds`. */
export function isRotationSeconds(cfg: Config, seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= cfg.rotation.minSeconds && seconds <= MAX_TIMER_SECONDS;
}

/** `pauseMovePixels`: pointer travel below it does not pause the rotation; a finite number, 0 or more. */
export function isPauseMovePixels(pixels: unknown): pixels is number {
  return typeof pixels === "number" && Number.isFinite(pixels) && pixels >= 0;
}

type CheckedKey = "region" | "continent" | "map" | "metric" | "year" | "view";

/** Keeps `?key=` when `isValid(value)`, else drops it with a notice naming `what`. */
function readChecked(
  query: URLSearchParams, params: Params, notices: string[],
  key: CheckedKey, what: string, isValid: (value: string) => boolean,
): void {
  const value = query.get(key)?.trim();
  if (!value) return;
  if (isValid(value)) params[key] = value;
  else notices.push(`Unknown ${what}: ${echoValue(value)}`);
}

/** Absolute URL for sharing and citing: `cfg.baseUrl` once the site has a public address, else this page's
 * address (local preview). A baseUrl naming a folder (GitHub Pages project site) gets its closing `/`, else
 * URL resolution would drop the folder. */
export function shareUrl(cfg: Config, link: string): string {
  const base = cfg.baseUrl && !cfg.baseUrl.endsWith("/") ? `${cfg.baseUrl}/` : cfg.baseUrl;
  return new URL(link, base || location.href).href;
}

/** The address's own `?theme=` when it names a known theme, else undefined: links to the full site carry
 * that and nothing else (an unknown theme is never passed on). */
export function addressTheme(cfg: Config): string | undefined {
  const asked = new URLSearchParams(location.search).get("theme")?.trim();
  return asked && cfg.themes.includes(asked) ? asked : undefined;
}

/** Link to `page` (default: current page) carrying the current URL's params merged with `p`.
 * A key present in `p` with value undefined drops that param. */
export function withParams(p: Partial<Params>, page?: string): string {
  const current = new URLSearchParams(location.search);
  const query = new URLSearchParams();
  for (const key of PARAM_KEYS) {
    const value = key in p ? p[key] : current.get(key);
    if (value) query.set(key, value);
  }
  const path = page ?? location.pathname;
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
