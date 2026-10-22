// Single entry for every page (esbuild bundles this file only). The page kind comes from
// <body data-page="overview|methods|about|embed">; index.html shows the overview, a country / office page
// for `?country=` / `?office=`, a region / continent page for `?region=` / `?continent=` (regionPage.ts), or the
// women-inventors page for `?view=women-inventors` (womenPage.ts), or the data versions for `?view=releases` (releasesPage.ts);
// embed.html shows one chart card (embed.ts). `?view=wallboard` = the conference wallboard (wallboard.ts): its own branch in
// start(), with no header, footer or office rotation.
import { loadAtlas, missingGroupsNotice, lazyMetricsFor, type Atlas, type GroupsFile } from "./atlas";
import { loadFresh, loadJson, setFetchTimeout, type Config, type Entities, type EntityFile, type Manifest, type Overview } from "./data";
import { h } from "./dom";
import { renderEmbed, renderEmbedFooter } from "./embed";
import { SERIES_TITLES, presentSources, renderMethods, type GeoSource } from "./methods";
import { addressParams, addressView, echoValue, pageLink, readParams, shareUrl, withParams, type Params } from "./params";
import { DISCLAIMER, citeText, releaseLabel, renderFooter } from "./provenance";
import { renderEntityPage } from "./entityPage";
import { checkMapParams } from "./map";
import { focusCard, renderCards, renderWorldCharts } from "./overview";
import { renderPicker } from "./picker";
import { renderGroupPage, resolveGroupParams } from "./regionPage";
import { RELEASES_VIEW, renderReleases } from "./releasesPage";
import { WOMEN_VIEW, renderWomenPage } from "./womenPage";
import { WALLBOARD_THEME, WALLBOARD_VIEW, boardFetchTimeoutSeconds, startWallboard } from "./wallboard";
import { markViewReady, startRotation } from "./rotation";
import { applyTheme, revealPage, themeLoaded } from "./theme";

type Page = "overview" | "methods" | "about" | "embed";

const NAV: { page: Page; href: string; label: string }[] = [
  { page: "overview", href: "./", label: "Overview" },
  { page: "methods", href: "methods.html", label: "Methods" },
  { page: "about", href: "about.html", label: "About" },
];

function currentPage(): Page {
  const page = document.body.dataset.page;
  return page === "methods" || page === "about" || page === "embed" ? page : "overview";
}

/** Theme switch: Apply navigates to this address with the new `?theme=` (charts bake colours at draw time, so
 * a live stylesheet swap would leave them stale). Navigating on `change` would fire on every arrow key of a
 * keyboard user (WCAG 3.2.2), so the choice is committed by Apply. The embed theme is for iframes and is not
 * offered, unless the address already uses it. */
function themeSwitch(cfg: Config, params: Params): HTMLElement {
  const current = params.theme;
  const offered = cfg.themes.filter((theme) => theme !== cfg.embedTheme || theme === current);
  const select = h("select", { id: "theme-switch" },
    offered.map((theme) => h("option", { value: theme, ...(theme === current ? { selected: "" } : {}) }, theme)));
  const apply = h("button", { type: "submit", class: "theme-apply", disabled: "" }, "Apply");
  select.addEventListener("change", () => { apply.disabled = select.value === current; });
  const form = h("form", { class: "theme-switch" }, h("label", {}, "Theme ", select), apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const theme = select.value === cfg.defaultTheme ? undefined : select.value;
    location.assign(withParams({ ...addressParams(cfg, params), theme }));
  });
  return form;
}

function renderHeader(el: HTMLElement, cfg: Config, page: Page, params: Params): void {
  el.replaceChildren(
    h("a", { class: "brand", href: pageLink(cfg, params, "./") },
      h("span", { class: "brand-name" }, cfg.siteName),
      h("span", { class: "brand-tagline" }, "Patent and PCT statistics"),
    ),
    h("nav", { class: "site-nav", "aria-label": "Main" },
      NAV.map((item) => h("a", {
        href: pageLink(cfg, params, item.href),
        ...(item.page === page ? { "aria-current": "page" } : {}),
      }, item.label)),
    ),
    h("div", { class: "header-controls" }, themeSwitch(cfg, params), startRotation(cfg, params)),
  );
}

function renderNotices(el: HTMLElement, notices: string[]): void {
  el.replaceChildren(...notices.map((text) => h("p", { class: "notice" }, text)));
  el.hidden = notices.length === 0;
}

/** Unknown codes are dropped with a notice (the page then shows the overview). Wrong-kind codes move to
 * their page with a notice and the address is rewritten: `?office=CH` (a national office) -> the country
 * page, which shows that office's series; `?country=EP` (a regional office) -> the office page. Country
 * and office together: the country page wins. */
function resolveEntityParams(cfg: Config, params: Params, entities: Entities): string[] {
  const notices: string[] = [];
  const byCode = new Map(entities.map((entity) => [entity.code, entity]));
  const isCountry = (code: string): boolean => byCode.get(code)?.kind !== "regional_office";
  let moved = false;
  if (params.country) {
    const entity = byCode.get(params.country);
    if (!entity) {
      notices.push(`Unknown country: ${echoValue(params.country)}`);
      delete params.country;
    } else if (!isCountry(entity.code)) {
      notices.push(params.office
        ? `${entity.code} is a regional office, not a country: left out.`
        : `${entity.code} is a regional office: showing its office page.`);
      params.office ??= entity.code;
      delete params.country;
      moved = true;
    }
  }
  if (params.office) {
    const entity = byCode.get(params.office);
    if (!entity) {
      notices.push(`Unknown office: ${echoValue(params.office)}`);
      delete params.office;
    } else if (isCountry(entity.code)) {
      notices.push(params.country
        ? `Showing the country page only; office ${entity.code} left out.`
        : `${entity.code} is a national office: its applications are on the ${entity.label} country page.`);
      params.country ??= entity.code;
      delete params.office;
      moved = true;
    } else if (params.country) {
      notices.push(`Showing the country page only; office ${entity.code} left out.`);
      delete params.office;
      moved = true;
    }
  }
  if (moved) history.replaceState(null, "", withParams(addressParams(cfg, params)));
  return notices;
}

function renderEdition(manifest: Manifest, overview: Overview): HTMLElement {
  const worlds = overview.world_last_year;
  return h("dl", { class: "edition" },
    h("div", {},
      h("dt", {}, "Patent data"),
      h("dd", {}, `WIPO release ${releaseLabel(manifest.releases.ips)}, complete through `,
        h("span", { class: "pulse" }, String(worlds.world_office))),
    ),
    h("div", {},
      h("dt", {}, "PCT data"),
      h("dd", {}, `WIPO release ${releaseLabel(manifest.releases.pmh)}, complete through `,
        h("span", { class: "pulse" }, String(worlds.pct_world))),
    ),
    h("div", {},
      h("dt", {}, "Retrieved"),
      h("dd", {}, manifest.retrieved),
    ),
  );
}

/** The atlas, or the load error as a value: a map that cannot load leaves the rest of the page standing. Loads the
 * ratio or share map file only when the address' metric is one (M6). */
function loadAtlasOrError(metric: string | undefined): Promise<Atlas | Error> {
  return loadAtlas(lazyMetricsFor(metric)).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
}

/** The atlas for the overview (null with a notice when it could not load); map params checked against it. */
async function overviewAtlas(load: Promise<Atlas | Error>, cfg: Config, overview: Overview, params: Params, notices: string[]): Promise<Atlas | null> {
  const atlas = await load;
  if (atlas instanceof Error) {
    notices.push(`The world map could not be loaded: ${atlas.message}`);
    return null;
  }
  notices.push(...checkMapParams(atlas, overview, params, cfg));
  const missing = missingGroupsNotice(atlas);
  if (missing) notices.push(missing);
  return atlas;
}

/** index.html: the overview, or a country / office page when the params name one, else a region / continent page
 * (unknown group: notice, overview). */
async function renderIndex(app: HTMLElement, cfg: Config, params: Params, manifest: Manifest): Promise<string[]> {
  if (params.view === RELEASES_VIEW) { // needs no chart data; params.ts has dropped `view` when an entity or group is asked for
    await renderReleases(app, { cfg, manifest, params });
    return [];
  }
  // preloaded with the page data when the address asks for the overview (no country or office)
  const atlasLoad = params.country || params.office || params.view ? null : loadAtlasOrError(params.metric);
  const [entities, overview] = await Promise.all([
    loadJson<Entities>("data/entities.json"),
    loadJson<Overview>("data/overview.json"),
  ]);
  const notices = resolveEntityParams(cfg, params, entities);
  const ctx = { cfg, manifest, params, entities, overview };
  if (params.country || params.office) {
    await renderEntityPage(app, (params.country ?? params.office) as string, params.country ? "country" : "office", ctx);
    return notices;
  }
  if (params.view === WOMEN_VIEW) { // params.ts has dropped `view` when a country, office, region or continent is asked for
    await renderWomenPage(app, ctx);
    return notices;
  }
  if (params.region || params.continent) {
    const loaded = await (atlasLoad ?? loadAtlasOrError(params.metric));
    if (loaded instanceof Error) {
      notices.push(`The region data could not be loaded: ${loaded.message}`);
      delete params.region;
      delete params.continent;
    } else {
      notices.push(...resolveGroupParams(cfg, params, loaded.groups));
      const id = params.continent ?? params.region;
      if (id) {
        notices.push(...checkMapParams(loaded, overview, params, cfg));
        const missing = missingGroupsNotice(loaded);
        if (missing) notices.push(missing);
        await renderGroupPage(app, id, params.continent ? "continent" : "region", { ...ctx, atlas: loaded });
        return notices;
      }
    }
  }
  const atlas = await overviewAtlas(atlasLoad ?? loadAtlasOrError(params.metric), cfg, overview, params, notices);
  const grid = h("div", { id: "charts", class: "chart-grid" });
  const focus = focusCard(overview, atlas, { cfg, manifest, params });
  if (focus) {
    // wallboard rotation on a `chart=` view: the card alone, full width
    const heading = h("h1", { class: "visually-hidden" });
    app.replaceChildren(heading, grid);
    await themeLoaded();
    document.documentElement.classList.add("focus-layout");
    // chart cleared: renderCards would scroll the lone card to the top, hiding the header and its status; fit: the card
    // takes only the viewport height (no page scroll)
    renderCards(grid, [{ ...focus, wide: true }], { cfg, manifest, params: { ...params, chart: undefined }, openNotes: true }, { fit: true });
    heading.textContent = `${cfg.siteName}: ${grid.querySelector("h2")?.textContent ?? focus.id}`;
    return notices;
  }
  const picker = h("div", { class: "picker" });
  renderPicker(picker, entities, atlas?.groups ?? null, ctx, overview.size_growth);
  app.replaceChildren(
    h("header", { class: "page-intro hero" },
      h("h1", {}, "Patent applications around the world"),
      h("p", { class: "lede" },
        "Yearly patent and PCT statistics from the WIPO Statistics Database, with growth, world shares and ranks ",
        "computed and cross-checked by Patent Atlas. Every figure names its source and release."),
      renderEdition(manifest, overview),
      picker,
    ),
    grid,
  );
  await themeLoaded();
  renderWorldCharts(grid, overview, atlas, { cfg, manifest, params });
  return notices;
}

/** embed.html: one chart in compact mode. Own default theme (cfg.embedTheme) when `?theme=` is absent or
 * unknown; a bad theme needs no notice there. */
async function renderEmbedPage(app: HTMLElement, cfg: Config, params: Params, manifest: Manifest): Promise<string[]> {
  const [entities, overview] = await Promise.all([
    loadJson<Entities>("data/entities.json"),
    loadJson<Overview>("data/overview.json"),
  ]);
  const notices = resolveEntityParams(cfg, params, entities);
  notices.push(...(await renderEmbed(app, { cfg, manifest, params, entities, overview })));
  return notices;
}

async function renderAbout(app: HTMLElement, cfg: Config, params: Params, manifest: Manifest): Promise<void> {
  const overview = await loadJson<Overview>("data/overview.json");
  const exampleUrl = shareUrl(cfg, pageLink(cfg, params, "./"));
  const [first] = presentSources(overview);
  const example = first ? citeText(cfg, SERIES_TITLES[first[0]], exampleUrl, manifest, first[1]) : null;
  const dataCenter = "WIPO IP Statistics Data Center";
  app.replaceChildren(
    h("header", { class: "page-intro" },
      h("h1", {}, `About ${cfg.siteName}`),
      h("p", { class: "lede" },
        `${cfg.siteName} turns WIPO's yearly patent and PCT statistics into charts with its own analysis: growth, world shares, `,
        "ranks and comparisons between countries and offices. It is made for patent office staff, researchers and students who need figures they can trace and cite."),
    ),
    h("div", { class: "prose" },
      h("section", { id: "author" },
        h("h2", {}, "Author"),
        h("p", {}, `Written and maintained by ${cfg.author}.`,
          cfg.contact ? [" Contact: ", h("a", { href: `mailto:${cfg.contact}` }, cfg.contact), "."] : null),
      ),
      h("section", { id: "cite" },
        h("h2", {}, "How to cite"),
        h("p", {}, "Every chart has a “Cite this” button with the exact text for that chart, including a link that keeps the theme you chose.",
          example ? " It reads like this:" : null),
        example ? h("blockquote", { class: "cite-example" }, example) : null,
      ),
      h("section", { id: "data" },
        h("h2", {}, "Data and terms"),
        h("p", {}, "Figures come from the WIPO Statistics Database. Patent Atlas does not republish WIPO's datasets: to download data, use the ",
          first ? h("a", { href: first[1].url, rel: "noopener" }, dataCenter) : dataCenter, ". ",
          "Sources, formulas and checks are on the ", h("a", { href: pageLink(cfg, params, "methods.html") }, "methods page"), "."),
        h("p", { class: "disclaimer" }, DISCLAIMER),
        h("p", {}, `${cfg.siteName} is independent and not affiliated with or endorsed by WIPO.`),
      ),
    ),
  );
}

async function renderMethodsPage(app: HTMLElement, cfg: Config, params: Params, manifest: Manifest): Promise<void> {
  const [overview, entities, swiss, groups, geo] = await Promise.all([
    loadJson<Overview>("data/overview.json"),
    loadJson<Entities>("data/entities.json"),
    loadJson<EntityFile>("data/entity/CH.json").catch(() => null), // example only; page stands without it
    loadJson<GroupsFile>("data/groups.json"),
    loadJson<{ sources: GeoSource[] }>("geo/points.json").catch(() => null), // credit only; page stands without it
  ]);
  renderMethods(app, { cfg, params, manifest, overview, entities, swiss, groups, geoSources: geo?.sources ?? [] });
}

function showError(app: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  app.replaceChildren(
    h("div", { class: "notice notice-error", role: "alert" },
      h("p", {}, "The data for this page could not be loaded, so no figures are shown."),
      h("p", {}, message),
      h("p", {}, "If you opened the file directly, start the local server described in the README and open the page from it."),
    ),
  );
}

/** The board's boot loads (config.json, the manifest): an unattended TV may boot before its network, so a failure
 * shows the error UI, visible (no theme may have loaded yet), and the load is tried again every `retrySeconds`.
 * Loaded fresh (past the browser cache): after a new-version reload the board must load the version its
 * cache-bypassing check saw, else it reloads again until the cache expires. */
async function loadWithRetry<T>(app: HTMLElement, path: string, retrySeconds: number): Promise<T> {
  for (;;) {
    try {
      return await loadFresh<T>(path);
    } catch (error) {
      showError(app, error);
      app.append(h("p", {}, `Trying again in ${retrySeconds} seconds.`), h("p", { class: "disclaimer" }, DISCLAIMER));
      revealPage();
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
    }
  }
}

/** The conference wallboard: the wallboard theme forced, header and footer left out; the board cites the manifest's
 * releases and data version, so a manifest that cannot load is the page's error, retried until it loads. */
async function startBoard(app: HTMLElement, cfg: Config, params: Params, notices: string[]): Promise<void> {
  params.theme = WALLBOARD_THEME;
  applyTheme(params.theme);
  document.getElementById("site-header")?.remove();
  document.getElementById("site-footer")?.remove();
  const retrySeconds = boardFetchTimeoutSeconds(cfg);
  setFetchTimeout(retrySeconds); // a hanging manifest too: the error UI, never a blank screen
  const manifest = await loadWithRetry<Manifest>(app, "data/manifest.json", retrySeconds);
  await themeLoaded();
  startWallboard(app, cfg, manifest, params, notices);
}

async function start(): Promise<void> {
  const app = document.getElementById("app") as HTMLElement;
  const noticeArea = document.getElementById("notices") as HTMLElement;
  let cfg: Config;
  if (currentPage() === "overview" && addressView(location.search) === WALLBOARD_VIEW) {
    // the board before config.json: no configured timeout yet, so its default is the timeout and the retry delay
    const bootSeconds = boardFetchTimeoutSeconds();
    setFetchTimeout(bootSeconds); // hanging: the error UI, never a blank or stuck page
    cfg = await loadWithRetry<Config>(app, "config.json", bootSeconds);
  } else {
    try {
      cfg = await loadJson<Config>("config.json");
    } catch (error) {
      revealPage();
      renderFooter(document.getElementById("site-footer") as HTMLElement);
      showError(app, error);
      return;
    }
  }
  // a throw anywhere below shows the error UI; markViewReady in `finally` so a rotating page is never left hidden (opacity 0)
  try {
    const page = currentPage();
    const { params, notices } = readParams(location.search, cfg);
    if (params.rotate && page !== "overview") {
      notices.push("Rotation runs on the overview page only: rotate ignored");
      delete params.rotate;
    }
    if (page === "overview" && params.view === WALLBOARD_VIEW) {
      // before the header: its startRotation would navigate away from the board (`rotate` is the board's interval here)
      await startBoard(app, cfg, params, notices.filter((line) => !line.startsWith("Unknown theme")));
      return;
    }
    if (page === "embed") {
      const asked = new URLSearchParams(location.search).get("theme")?.trim();
      if (!asked || !cfg.themes.includes(asked)) params.theme = cfg.embedTheme;
      notices.length = 0;
    }
    applyTheme(params.theme);
    if (page === "embed") renderEmbedFooter(document.getElementById("site-footer") as HTMLElement);
    else {
      renderHeader(document.getElementById("site-header") as HTMLElement, cfg, page, params);
      renderFooter(document.getElementById("site-footer") as HTMLElement, cfg, params);
    }
    renderNotices(noticeArea, notices);
    try {
      const manifest = await loadJson<Manifest>("data/manifest.json");
      if (page === "embed") notices.push(...(await renderEmbedPage(app, cfg, params, manifest)));
      else if (page === "methods") await renderMethodsPage(app, cfg, params, manifest);
      else if (page === "about") await renderAbout(app, cfg, params, manifest);
      else notices.push(...(await renderIndex(app, cfg, params, manifest)));
    } catch (error) {
      showError(app, error);
    }
    renderNotices(noticeArea, notices);
  } catch (error) {
    showError(app, error);
  } finally {
    markViewReady();
  }
}

void start();
