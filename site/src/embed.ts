// Embed page (embed.html?chart=<id>&country=<code>|office=<code>|region=<m49>|continent=<slug>&theme=<name>): one chart
// card in compact mode (title, chart, source line, link to the full page), sized for an iframe. Bad requests get a
// message and a link home, never an empty chart. main.ts has already checked country/office against entities.json;
// region/continent are checked here, against the atlas' groups. The women-inventors cards (womenPage.ts) need no entity.
import { loadAtlas, missingGroupsNotice, lazyMetricsFor, type Atlas, type GroupItem } from "./atlas";
import { CONTINENT_NAMES_PROBLEM } from "./chartCard";
import { MAP_CARD_ID, checkMapParams } from "./map";
import type { CardBuilder } from "./overview";
import { renderCards, worldCards } from "./overview";
import { REGION_COMPARE_CARD_ID, SCALE_CARD_ID, SERIES_CARD_IDS, TILES_CARD_ID, entityCards, loadCountryRegion, loadGroups, type EntityPageContext } from "./entityPage";
import { GROUP_CARD_IDS, findGroup, groupCards } from "./regionPage";
import { loadJson, type CardSource, type EntityFile } from "./data";
import { ENTITY_WOMEN_CARD_ID } from "./genderCards";
import { h } from "./dom";
import { PAGE_PARAMS, addressTheme, echoValue, shareUrl, withParams, type Params } from "./params";
import { DISCLAIMER } from "./provenance";
import { themeLoaded } from "./theme";
import { WOMEN_CARD_IDS, WOMEN_RANKING_ID, loadWomenRanking, womenCards } from "./womenPage";
import { keyFigureCards } from "./dashboard";

/** Overview cards that name continents (their display names come from groups.json): only groups.json is loaded for them,
 * and a failure to load it is the card's error (no guessed names). */
const CONTINENT_CARD_IDS = ["continent-share", "size-growth"];
const ENTITY_CARD_IDS: string[] = [TILES_CARD_ID, SCALE_CARD_ID, ...Object.values(SERIES_CARD_IDS), REGION_COMPARE_CARD_ID, ENTITY_WOMEN_CARD_ID];
/** Entity cards that show the country's region (its group file is loaded for them). */
const REGION_CARD_IDS = [REGION_COMPARE_CARD_ID, SCALE_CARD_ID, ENTITY_WOMEN_CARD_ID];

/** Footer of the embed: the WIPO disclaimer only (the source line sits under the chart). */
export function renderEmbedFooter(el: HTMLElement): void {
  el.replaceChildren(h("p", { class: "disclaimer" }, DISCLAIMER));
}

/** Message in place of a chart, with a link to the site home (theme kept). Opens in a new tab: the page sits in a host's iframe. */
function showProblem(el: HTMLElement, ctx: EntityPageContext, ...message: string[]): void {
  const home = shareUrl(ctx.cfg, withParams({ ...PAGE_PARAMS, theme: addressTheme(ctx.cfg) }, "./"));
  document.title = `${message[0]} – ${ctx.cfg.siteName}`;
  el.replaceChildren(h("div", { class: "notice embed-problem", role: "alert" },
    message.map((line, index) => h("p", index === 0 ? { class: "embed-problem-title" } : {}, line)),
    h("p", {}, h("a", { href: home, target: "_blank", rel: "noopener" }, `Charts and data on ${ctx.cfg.siteName}`)),
  ));
}

/** A card to show (with notices: map params adjusted to the data) or the problem lines to show instead. */
type Found = { builder: CardBuilder; notices?: string[] } | { problem: string[] };

/** An overview card (the atlas loaded for the map, groups.json for the continent cards; a failure is the card's error),
 * else undefined. */
async function worldBuilder(ctx: EntityPageContext, id: string): Promise<Found | undefined> {
  let atlas: Atlas | null = null;
  let groups: GroupItem[] | null = null;
  const notices: string[] = [];
  if (id === MAP_CARD_ID) {
    try {
      atlas = await loadAtlas(lazyMetricsFor(ctx.params.metric));
    } catch (error) {
      console.error(error); // detail for the embedder's console, as for entity files
      return { problem: ["The world map could not be loaded."] };
    }
    notices.push(...checkMapParams(atlas, ctx.overview, ctx.params, ctx.cfg));
    const missing = missingGroupsNotice(atlas);
    if (missing) notices.push(missing);
  } else if (CONTINENT_CARD_IDS.includes(id)) {
    groups = (await loadGroups())?.items ?? null;
    if (!groups) return { problem: [CONTINENT_NAMES_PROBLEM] };
  }
  const builder = [...worldCards(ctx.overview, atlas, { ...ctx, compact: true }, groups ?? atlas?.groups ?? null), ...keyFigureCards(ctx.overview)]
    .find((card) => card.id === id);
  return builder ? { builder, notices } : undefined;
}

/** A women-inventors card: the ranking loads the two women map files, the others need only overview.json. */
async function womenBuilder(ctx: EntityPageContext, id: string): Promise<Found> {
  const ranking = id === WOMEN_RANKING_ID ? await loadWomenRanking(ctx.entities) : null;
  if (ranking instanceof Error) return { problem: ["The country data could not be loaded."] };
  const builder = womenCards(ctx.overview, ranking, { ...ctx, compact: true }).find((card) => card.id === id);
  const content = builder?.build();
  if (!builder || !content) return { problem: [`No data to draw “${id}”.`] };
  return { builder: { ...builder, build: () => content } };
}

async function entityBuilder(ctx: EntityPageContext, id: string): Promise<Found> {
  const { country, office } = ctx.params;
  const code = country ?? office;
  if (!code) {
    return { problem: ["This chart needs a country or an office.", `Add country=<code> (for example country=CH) or office=<code> to the address, as in ?chart=${id}&country=CH.`] };
  }
  const kind = country ? "country" : "office";
  // main.ts checks the embed's address; a wallboard slide's params come from config.json: checked here too, before a path
  // is built from the code
  if (!ctx.entities.some((entity) => entity.code === code)) return { problem: [`Unknown ${kind}: ${echoValue(code)}.`] };
  let file: EntityFile;
  try {
    file = await loadJson<EntityFile>(`data/entity/${code}.json`);
  } catch (error) {
    console.error(error); // detail for the embedder's console; visitors of the host page see only the fixed sentence
    return { problem: [`The data for ${code} could not be loaded.`] };
  }
  const region = REGION_CARD_IDS.includes(id) && kind === "country" ? await loadCountryRegion(file.code, await loadGroups()) : null;
  if (region instanceof Error) console.error(region);
  if (region instanceof Error && id === REGION_COMPARE_CARD_ID) {
    return { problem: [`The comparison of ${file.label} with its region could not be loaded.`] };
  }
  // the scale and women cards stand without their region, as on the country page
  const builder = entityCards(file, ctx.overview, ctx.manifest, kind, ctx.entities, region instanceof Error ? null : region).find((card) => card.id === id);
  const content = builder?.build();
  if (!builder || !content) {
    return { problem: [`Unknown chart for ${file.label}: “${id}” is not available (no data reported, or not a series of a ${kind} page).`] };
  }
  return { builder: { ...builder, build: () => content } }; // built once: renderCards would build it again
}

/** A region / continent card (`?region=` / `?continent=` without country or office): from the atlas' groups and figures. */
async function groupBuilder(ctx: EntityPageContext, id: string): Promise<Found> {
  let atlas: Atlas;
  try {
    atlas = await loadAtlas(id === MAP_CARD_ID ? lazyMetricsFor(ctx.params.metric) : []);
  } catch (error) {
    console.error(error);
    return { problem: ["The region data could not be loaded."] };
  }
  const asked = ctx.params.continent ? `continent: ${echoValue(ctx.params.continent)}` : ctx.params.region ? `region: ${echoValue(ctx.params.region)}` : null; // findGroup drops unknown ids
  const { group } = findGroup(atlas.groups, ctx.params);
  if (!group) return { problem: asked ? [`Unknown ${asked}.`] : ["No region or continent chosen.", "Add region=<id> or continent=<slug> to the address."] };
  const notices = id === MAP_CARD_ID ? checkMapParams(atlas, ctx.overview, ctx.params, ctx.cfg) : [];
  const builder = groupCards(atlas, ctx.overview, group, { ...ctx, compact: true }).find((card) => card.id === id);
  const content = builder?.build();
  if (!builder || !content) return { problem: [`Unknown chart for ${group.label}: “${id}” is not available (no data reported, or not a chart of its page).`] };
  return { builder: { ...builder, build: () => content }, notices };
}

/** A slide drawn by `renderSlide`: `ok` false = no chart; `problem` = the lines saying why, for the caller to show (the stage
 * left as it was), empty when the stage holds the card's own problem message (a card that cannot be drawn); `sources` and
 * `dataCredits` = the card's own source blocks and other data credits (World Bank WDI); `dispose` removes the slide's
 * observers and listeners (the wallboard calls it before dropping the slide). */
export type SlideResult = {
  ok: boolean; title: string; sources: CardSource[]; dataCredits: string[]; notices: string[]; problem: string[];
  dispose(): void;
};

/** How `renderSlide` draws: `fitToStage` = fitted to the stage's height (wallboard, dashboard carousel), else to the viewport's
 * (the embed's iframe); `full` = a full card (Show figures, Cite, Embed, sources and notes) with a same-tab link to the chart on
 * the overview (dashboard), else compact; `idPrefix` = put before every id the slide makes (CardContext.idPrefix). */
export type SlideOptions = { fitToStage?: boolean; full?: boolean; idPrefix?: string };

/** One chart card in `stage` (spec §Rendering): the chart named by `params.chart`
 * (with country/office for entity charts, region/continent for group charts). The atlas is loaded only for the charts
 * that need it. Fitted and redrawn on any resize (`opts.fitToStage`). Embed page, wallboard and dashboard carousel. */
export async function renderSlide(stage: HTMLElement, params: Params, ctx: Omit<EntityPageContext, "params">,
  opts: SlideOptions = {}): Promise<SlideResult> {
  const { fitToStage = false, full = false, idPrefix } = opts;
  const failed = (...problem: string[]): SlideResult => ({ ok: false, title: "", sources: [], dataCredits: [], notices: [], problem, dispose: () => {} });
  const slideCtx: EntityPageContext = { ...ctx, params, idPrefix };
  const id = params.chart;
  if (!id) return failed("No chart chosen.", "Add chart=<id> to the address, for example ?chart=world-trend.");
  const groupChart = Boolean(params.region || params.continent) && !params.country && !params.office && GROUP_CARD_IDS.includes(id);
  let found = WOMEN_CARD_IDS.includes(id) ? await womenBuilder(slideCtx, id)
    : groupChart ? await groupBuilder(slideCtx, id) : await worldBuilder(slideCtx, id);
  if (!found) {
    if (!ENTITY_CARD_IDS.includes(id)) return failed(`Unknown chart: “${echoValue(id)}”.`);
    found = await entityBuilder(slideCtx, id);
  }
  if ("problem" in found) return failed(...found.problem);
  const { builder, notices = [] } = found;
  const content = builder.build();
  if (!content && !builder.problem) return failed(`No data to draw “${id}”.`, "There is no data to draw it.");
  const grid = h("div", { id: `${idPrefix ?? ""}charts`, class: "chart-grid embed-grid" });
  stage.replaceChildren(grid);
  await themeLoaded();
  // built once above: renderCards would build it again; no content = the card's problem message (renderCards)
  const dispose = renderCards(grid, [{ ...builder, build: () => content, wide: true }], { cfg: ctx.cfg, manifest: ctx.manifest, params, compact: !full, linkOverview: full, idPrefix },
    fitToStage ? { fitTo: stage } : { fit: true });
  const title = grid.querySelector("h2")?.textContent ?? "";
  if (!content) return { ...failed(), title, dispose };
  return { ok: true, title, sources: [content.source].flat(), dataCredits: content.dataCredits ?? [], notices, problem: [], dispose };
}

/** embed.html: the slide in `el` (the page's main), titled; a bad request or missing data gets its message instead.
 * Returns notices (map params adjusted to the data). */
export async function renderEmbed(el: HTMLElement, ctx: EntityPageContext): Promise<string[]> {
  const { params, ...rest } = ctx;
  const slide = await renderSlide(el, params, rest);
  if (slide.problem.length) {
    showProblem(el, ctx, ...slide.problem);
    return [];
  }
  document.title = `${slide.title} – ${ctx.cfg.siteName}`;
  return slide.notices;
}
