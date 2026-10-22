// Country / office / region picker: a search box (ARIA combobox) listing matches by name or code (WIPO code, M49
// region code) in four groups. Arrow keys move through the matches, Enter opens one (the best match across groups when
// none is chosen: the best match, listed first and active), Escape closes the list, a second Escape clears the box and its matches; a click opens one too. Opening = navigating to the country, office, region or continent page.
import type { GroupItem } from "./atlas";
import type { CardContext } from "./chartCard";
import type { Entities, EntityKind, Overview } from "./data";
import { h } from "./dom";
import { groupPageTarget } from "./map";
import { PAGE_PARAMS, withParams, type Params } from "./params";

/** `tie` = rank among sections when the best match is picked and scores tie on an exact name or code: groups and
 * countries before offices (final review I3: "Europe" opens the continent, not the European Patent Office). At a
 * looser score the groups come last (N3: "America" opens the United States, not Central America). */
const GROUPS: { title: string; kind: EntityKind; tie: number }[] = [
  { title: "Countries", kind: "country", tie: 1 },
  { title: "Regional offices", kind: "regional_office", tie: 3 },
  { title: "Former", kind: "historical", tie: 2 },
];
const GROUP_PAGES_TITLE = "Regions and continents";
const GROUP_PAGES_TIE = 0;

/** One match: `code` matched exactly and shown beside the label; `id` unique in the list. */
type Item = { id: string; code: string; label: string; href: string };

/** Case- and accent-insensitive form for matching ("Côte" ~ "cote"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Lower = better: exact code or exact name, name start, word start, anywhere in the name; null = no match. */
function matchScore(entity: Item, query: string): number | null {
  const label = fold(entity.label);
  if (entity.code.toLowerCase() === query || label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.split(/[\s(,-]+/).some((word) => word.startsWith(query))) return 2;
  return label.includes(query) ? 3 : null;
}

/** Page link (theme kept unless it is the default). */
function link(target: Partial<Params>, ctx: CardContext): string {
  const theme = ctx.params.theme === ctx.cfg.defaultTheme ? undefined : ctx.params.theme;
  return withParams({ ...PAGE_PARAMS, theme, ...target }, "./");
}

/** The picker's sections: entities by kind (regional offices open the office page, every other entity its country page),
 * then regions and continents (a region equal to its continent, Northern America, only as the continent). */
function sections(entities: Entities, groups: GroupItem[] | null, ctx: CardContext): { title: string; tie: number; items: Item[] }[] {
  const entitySections = GROUPS.map((group) => ({
    title: group.title, tie: group.tie,
    items: entities.filter((entity) => entity.kind === group.kind).map((entity) => ({
      id: entity.code, code: entity.code, label: entity.label,
      href: link(entity.kind === "regional_office" ? { office: entity.code } : { country: entity.code }, ctx),
    })),
  }));
  const groupItems = (groups ?? []).filter((group) => groupPageTarget(groups ?? [], group).id === group.id).map((group) => ({
    id: `group-${group.id}`, code: group.kind === "region" ? group.id : "", label: group.label,
    href: link({ [group.kind]: group.id }, ctx),
  }));
  return [...entitySections, { title: GROUP_PAGES_TITLE, tie: GROUP_PAGES_TIE, items: groupItems }];
}

let pickerCount = 0;

/** Larger origins first among equal scores (N2: "Korea" opens the Republic of Korea): index in `sizes` (overview
 * `size_growth`, largest first); not listed or not loaded = after all listed, entities' own order. */
function originRanks(sizes: Overview["size_growth"] | null): Map<string, number> {
  return new Map((sizes ?? []).map((entry, index) => [entry.code, index]));
}

/** `groups` = groups.json items (null when not loaded: countries and offices only); `sizes` = overview `size_growth`
 * (null when not loaded: ties keep the entities' order). */
export function renderPicker(el: HTMLElement, entities: Entities, groups: GroupItem[] | null, ctx: CardContext,
  sizes: Overview["size_growth"] | null = null): void {
  const id = `picker-${++pickerCount}`;
  const listed = sections(entities, groups, ctx);
  const originRank = originRanks(sizes);
  const input = h("input", {
    id: `${id}-input`, type: "text", role: "combobox", autocomplete: "off", spellcheck: "false",
    "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": `${id}-list`,
    placeholder: groups ? "Name or code, e.g. Switzerland, CH, EP, Europe" : "Name or code, e.g. Switzerland, CH, EP",
  });
  const list = h("div", { id: `${id}-list`, class: "picker-results", role: "listbox",
    "aria-label": groups ? "Countries, offices, regions and continents" : "Countries and offices" });
  const status = h("p", { class: "picker-status", role: "status" });
  list.hidden = true;
  let options: HTMLElement[] = [];
  let active = -1;

  const setActive = (index: number): void => {
    options[active]?.setAttribute("aria-selected", "false");
    active = index;
    const option = options[active];
    if (option) {
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };
  const close = (): void => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActive(-1);
  };
  const open = (option: HTMLElement | undefined): void => {
    if (option?.dataset.href) location.assign(option.dataset.href);
  };

  const update = (): void => {
    const query = fold(input.value.trim());
    options = [];
    active = -1;
    input.removeAttribute("aria-activedescendant");
    if (!query) {
      list.replaceChildren();
      status.textContent = "";
      close();
      return;
    }
    type Match = { item: Item; score: number };
    const matched = listed.map((section, sectionIndex) => {
      const matches = section.items
        .map((item, order) => ({ item, order, score: matchScore(item, query) }))
        .filter((match): match is Match & { order: number } => match.score !== null)
        .sort((a, b) => a.score - b.score
          || (originRank.get(a.item.code) ?? Infinity) - (originRank.get(b.item.code) ?? Infinity) || a.order - b.order);
      return { section, sectionIndex, matches };
    }).filter((entry) => entry.matches.length > 0);
    // the best match: lowest score, then section tie; its section is listed first, so it is the first option
    const tieOf = (entry: (typeof matched)[number]): number =>
      entry.matches[0].score === 0 || entry.section.tie !== GROUP_PAGES_TIE ? entry.section.tie : Number.MAX_SAFE_INTEGER;
    const bestEntry = matched.reduce<(typeof matched)[number] | null>((best, entry) =>
      !best || entry.matches[0].score < best.matches[0].score
        || (entry.matches[0].score === best.matches[0].score && tieOf(entry) < tieOf(best)) ? entry : best, null);
    const found = (bestEntry ? [bestEntry, ...matched.filter((entry) => entry !== bestEntry)] : []).map(({ section, sectionIndex, matches }) => {
      const titleId = `${id}-group-${sectionIndex}`;
      return h("div", { class: "picker-group", role: "group", "aria-labelledby": titleId },
        h("div", { class: "picker-group-title", id: titleId, role: "presentation" }, section.title),
        matches.map(({ item }) => {
          const option = h("div", {
            id: `${id}-option-${item.id}`, class: "picker-option", role: "option", "aria-selected": "false",
            "data-href": item.href,
          }, item.label, item.code ? [" ", h("span", { class: "picker-code" }, item.code)] : null);
          options.push(option);
          return option;
        }),
      );
    });
    list.replaceChildren(...found);
    status.textContent = options.length === 1 ? "1 match" : `${options.length} matches`;
    list.hidden = options.length === 0;
    input.setAttribute("aria-expanded", String(options.length > 0));
    if (options.length > 0) setActive(0); // the best match: highlighted, announced, what Enter opens
  };

  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      if (list.hidden) {
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(options.length - 1, Math.max(0, active + step)));
    } else if (event.key === "Enter") {
      if (options.length === 0) return;
      event.preventDefault();
      open(options[active] ?? options[0]);
    } else if (event.key === "Escape") {
      if (list.hidden) {
        input.value = "";
        update(); // clears the matches too: ArrowDown or refocus must not reopen a stale list
      } else {
        close();
      }
    }
  });
  // keep focus in the input while a match is clicked (blur would close the list first)
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    open((event.target as Element).closest<HTMLElement>(".picker-option") ?? undefined);
  });
  input.addEventListener("blur", close);
  input.addEventListener("focus", () => { if (options.length) { list.hidden = false; input.setAttribute("aria-expanded", "true"); } });

  el.classList.add("picker");
  el.replaceChildren(
    h("label", { class: "picker-label", for: input.id }, groups ? "Find a country or office, region or continent" : "Find a country or office"),
    h("div", { class: "picker-box" }, input, list),
    status,
  );
}
