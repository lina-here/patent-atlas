// Women-inventor cards of the country page (`entity-women`: the country beside its region and the World) and of the
// region / continent page (`group-women`: the group beside the World). Both measures (genderText GENDER_TITLES) are named
// apart and never share an axis. Every figure is read from entity/<code>.json, group/<id>.json and overview.json; a
// group value is WIPO's printed figure in `wipo_years` (labelled WIPO, cited), else computed (labelled as such). A null
// year shows "–" and its reason, a line stops at a gap, nothing is 0 or bridged. All by PUBLICATION year.
import type { GroupFigures, GroupGenderSource, GroupItem } from "./atlas";
import type { CountryRegion } from "./entityPage";
import type { ChartTable, TableCell } from "./chartCard";
import { lineChart, type LinePoint } from "./charts";
import type { Entities, EntityFile, GenderMeasure, GenderNullReason, Overview, SourceBlock, YearMap } from "./data";
import { h } from "./dom";
import { fixedPercent } from "./format";
import { GENDER_BASIS_LABEL, GENDER_TITLES, formatShare, coverageFloorText, genderCaveat, genderDecimals, genderNullText, unlistedMembersText } from "./genderText";
import { REDRAW_ATTRIBUTE, type CardContent } from "./overview";

export const ENTITY_WOMEN_CARD_ID = "entity-women";
export const GROUP_WOMEN_CARD_ID = "group-women";

const MEASURES: GenderMeasure[] = ["women_any", "women_share"];
const WORLD_LABEL = "World";
/** The measures in a sentence (notes, table notes). */
const MEASURE_NAME: Record<GenderMeasure, string> = { women_any: "applications with a woman inventor", women_share: "women's share" };
const CARD_TITLE = "Women inventors in PCT applications, by publication year";
/** Class of the sentence that stands in place of a chart with no value. */
const NO_VALUE_CLASS = "women-none";

/** One compared line: a country, a group or the World. Groups carry how their value came about. */
type Entry = {
  label: string;
  value: YearMap;
  reason: Record<string, GenderNullReason>;
  group?: GroupSide;
};
type GroupSide = {
  /** m of "n of m": the members with a PCT publications row; `total` = members of the group in all, `unlisted` = those left out (labels). */
  members: number;
  total: number;
  unlisted: string[];
  reporting: Record<string, number | null>;
  coverage: Record<string, number | null>;
  wipoYears: number[];
  source?: GroupGenderSource;
};

/** What a card compares per measure: `main` (the card's subject), `beside` (the country's region), the World. */
type Comparison = { main: Entry | null; beside: Entry | null; world: Entry };

const valueAt = (entry: Entry, year: number): number | null => entry.value[String(year)] ?? null;
const hasValue = (entry: Entry | null, last: number): boolean =>
  entry !== null && Object.entries(entry.value).some(([year, value]) => value !== null && Number(year) <= last);

function countryEntry(file: EntityFile, measure: GenderMeasure): Entry | null {
  const block = file.gender?.[measure];
  return block ? { label: file.label, value: block.value, reason: block.null_reason } : null;
}

/** Labels ("Guernsey (GG)") of members by code, for the footnote. */
const unlistedLabels = (codes: string[], entities: Entities): string[] => {
  const labels = new Map(entities.map((entity) => [entity.code, entity.label]));
  return codes.map((code) => `${labels.get(code) ?? code} (${code})`);
};

/** A group's entry; its `unlisted` members (file field: no PCT publications row, which "n of m" leaves out) are named by label. */
function groupEntry(figures: GroupFigures | undefined, group: GroupItem, entities: Entities, measure: GenderMeasure): Entry | null {
  const block = figures?.gender?.[measure];
  if (!block) return null;
  return { label: group.label, value: block.value, reason: block.null_reason,
    group: { members: block.members, total: group.members.length, unlisted: unlistedLabels(block.unlisted, entities), reporting: block.reporting, coverage: block.coverage, wipoYears: block.wipo_years,
      source: figures?.sources?.[measure] } };
}

type Shown = { value: string; detail: string };

/** A value as text ("–" for none) and its basis: WIPO's published figure, WIPO's printed group figure, computed from
 * members ("n of m", coverage) or the reason it is missing. */
function describe(entry: Entry, year: number, overview: Overview): Shown {
  const key = String(year);
  const value = valueAt(entry, year);
  const reason = entry.reason[key];
  const group = entry.group;
  const parts: string[] = [];
  if (value !== null) {
    const printed = group?.source?.printed?.[key];
    parts.push(!group ? GENDER_BASIS_LABEL.wipo
      : group.wipoYears.includes(year) ? `${GENDER_BASIS_LABEL.wipo}, printed${printed ? ` (figure ${printed.figure}, see notes)` : ""}`
        : GENDER_BASIS_LABEL.computed);
  } else {
    parts.push(`no data reported${reason ? `: ${genderNullText(reason, overview)}` : ""}`);
  }
  if (group && reason !== "not_computable") parts.push(...memberCoverageParts(group, key, overview));
  return { value: formatShare(value, genderDecimals(overview)), detail: parts.join("; ") };
}

/** "n of m members" and "coverage x%" of a group year (none where the year has no member count: WIPO's printed figure,
 * not computable). Shared by the cards and the map's group modes. */
export function memberCoverageParts(group: { members: number; reporting: Record<string, number | null>; coverage: Record<string, number | null> },
  key: string, overview: Overview): string[] {
  const parts: string[] = [];
  const reporting = group.reporting[key];
  if (reporting !== null && reporting !== undefined) parts.push(`${reporting} of ${group.members} members`);
  const coverage = group.coverage[key];
  if (coverage !== null && coverage !== undefined && reporting) parts.push(`coverage ${coverageText(coverage, overview)}`);
  return parts;
}

/** Coverage (a fraction) as a percentage with the pipeline's decimals (overview `method.gender.coverage_decimals`, a fraction's). */
export function coverageText(coverage: number, overview: Overview): string {
  const decimals = Math.max(0, (overview.method.gender?.coverage_decimals ?? 3) - 2);
  return `${fixedPercent(coverage, decimals)}%`;
}

function tileFigure(comparisons: Record<GenderMeasure, Comparison>, overview: Overview): HTMLElement {
  const gender = overview.gender!;
  return h("dl", { class: "tiles scale-tiles" }, MEASURES.map((measure) => {
    const { main, beside, world } = comparisons[measure];
    const year = gender.last_year[measure];
    const own = main ? describe(main, year, overview) : { value: "–", detail: "no data reported" };
    const next = beside ? describe(beside, year, overview) : null;
    const worldShown = describe(world, year, overview);
    return h("div", { class: "tile", "data-measure": measure },
      h("dt", { class: "tile-label" }, `${GENDER_TITLES[measure]}, ${year} (publication year)`),
      h("dd", { class: "tile-value" }, own.value),
      h("dd", { class: "tile-label tile-basis" }, own.detail),
      next && beside ? h("dd", { class: "tile-label tile-region" }, `${beside.label}: ${next.value}, ${next.detail}`) : null,
      h("dd", { class: "tile-label tile-world" }, `${WORLD_LABEL}: ${worldShown.value}${worldShown.value === "–" ? " (no data reported)" : ` (${GENDER_BASIS_LABEL.wipo})`}`));
  }));
}

/** The line chart of one measure: its subject, its region and the World, from the first year any has a value to the
 * measure's last year; a year without a value is a gap. */
function measureChart(measure: GenderMeasure, comparison: Comparison, overview: Overview, width: number): HTMLElement {
  const last = overview.gender!.last_year[measure];
  const decimals = genderDecimals(overview);
  const entries = [comparison.main, comparison.beside, comparison.world].filter((entry): entry is Entry => hasValue(entry, last));
  const years = [...new Set(entries.flatMap((entry) => Object.keys(entry.value).map(Number)))].filter((year) => year <= last)
    .filter((year) => entries.some((entry) => valueAt(entry, year) !== null)).sort((a, b) => a - b);
  const first = years[0];
  const points: LinePoint[] = [];
  for (let year = first; year <= last; year++) for (const entry of entries) points.push({ year, value: valueAt(entry, year), key: entry.label });
  const svg = lineChart(points, { width, keys: entries.map((entry) => entry.label),
    format: (value) => formatShare(value, decimals), tick: (value) => formatShare(value, 0) });
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${GENDER_TITLES[measure]}, by publication year`);
  return h("div", { class: "women-trend", "data-measure": measure }, h("h3", {}, `${GENDER_TITLES[measure]}, by publication year`), svg);
}

/** In place of a chart: why the card's subject has no value of the measure. */
function noValueText(measure: GenderMeasure, comparison: Comparison, overview: Overview, last: number): string {
  const subject = comparison.main;
  if (!subject) return `${GENDER_TITLES[measure]}: no data in this data set.`;
  if (!subject.group) return `WIPO publishes no “${GENDER_TITLES[measure]}” figure for ${subject.label}.`;
  const reasons = [...new Set(Object.entries(subject.reason).filter(([year]) => Number(year) <= last).map(([, reason]) => reason))];
  return `${GENDER_TITLES[measure]}: no value for ${subject.label} in any year` +
    (reasons.length ? `: ${reasons.map((reason) => genderNullText(reason, overview)).join("; ")}` : "") + ".";
}

function figuresTable(subjectLabel: string, comparisons: Record<GenderMeasure, Comparison>, overview: Overview): ChartTable {
  const gender = overview.gender!;
  const headers = ["Year"];
  const numeric = [true];
  const columns: { measure: GenderMeasure; entry: Entry | null; kind: "value" | "reporting" | "coverage" }[] = [];
  const add = (measure: GenderMeasure, entry: Entry | null, kind: "value" | "reporting" | "coverage", header: string, isNumber: boolean): void => {
    headers.push(header);
    numeric.push(isNumber);
    columns.push({ measure, entry, kind });
  };
  for (const measure of MEASURES) {
    const { main, beside, world } = comparisons[measure];
    const title = GENDER_TITLES[measure];
    add(measure, main, "value", `${title}: ${main?.label ?? subjectLabel}`, true);
    const grouped = main?.group ? main : beside?.group ? beside : null;
    if (beside) add(measure, beside, "value", `${title}: ${beside.label}`, true);
    if (measure === "women_any" && grouped) {
      add(measure, grouped, "reporting", `${title}: ${grouped.label}: members reporting`, false);
      add(measure, grouped, "coverage", `${title}: ${grouped.label}: coverage`, true);
    }
    add(measure, world, "value", `${title}: ${WORLD_LABEL}`, true);
  }
  headers.push("Note");
  numeric.push(false);
  const decimals = genderDecimals(overview);
  const lastAny = Math.max(...MEASURES.map((measure) => gender.last_year[measure]));
  const years = [...new Set(MEASURES.flatMap((measure) => [comparisons[measure].main, comparisons[measure].beside, comparisons[measure].world]
    .flatMap((entry) => (entry ? Object.keys(entry.value).map(Number) : []))))].filter((year) => year <= lastAny).sort((a, b) => b - a);
  const rows = years.map((year): TableCell[] => {
    const notes: string[] = [];
    const cells = columns.map(({ measure, entry, kind }): TableCell => {
      if (!entry || year > gender.last_year[measure]) return "–";
      const key = String(year);
      if (kind === "reporting") {
        const reporting = entry.group?.reporting[key];
        return reporting === null || reporting === undefined || entry.reason[key] === "not_computable" ? "–" : `${reporting} of ${entry.group!.members}`;
      }
      if (kind === "coverage") {
        const coverage = entry.group?.coverage[key];
        return coverage === null || coverage === undefined || !entry.group!.reporting[key] || entry.reason[key] === "not_computable" ? "–" : coverageText(coverage, overview);
      }
      const value = valueAt(entry, year);
      const reason = entry.reason[key];
      if (value === null && reason) {
        notes.push(`${MEASURE_NAME[measure]}, ${entry.label}: ${genderNullText(reason, overview)}`);
      } else if (value !== null && entry.group?.wipoYears.includes(year)) {
        notes.push(`${MEASURE_NAME[measure]}, ${entry.label}: ${GENDER_BASIS_LABEL.wipo}'s printed figure`);
      }
      return formatShare(value, decimals);
    });
    return [String(year), ...cells, notes.join("; ")];
  });
  return { headers, rows, numeric };
}

/** Footnotes: what the group values are and how they came about (computed, printed, not computable), the WIPO citation of
 * each printed figure, then the method caveat. */
function footnotes(comparisons: Record<GenderMeasure, Comparison>, overview: Overview): string[] {
  const lines = ["A gap in a line = no value reported for that year; a missing value is never shown as 0 and never bridged. " +
    `${WORLD_LABEL} = WIPO's world figure (code ZZ), as published.`];
  const seen = new Set<string>();
  for (const measure of MEASURES) {
    const { main, beside } = comparisons[measure];
    for (const entry of [main, beside]) {
      if (!entry?.group || seen.has(`${measure}|${entry.label}`)) continue;
      seen.add(`${measure}|${entry.label}`);
      lines.push(...groupMeasureNotes(measure, entry.label, entry.group, overview));
    }
  }
  return [...lines, ...genderCaveat(overview)];
}

/** Footnote lines of one group measure: how its values came about (computed with "n of m" and coverage explained, or not
 * computable) and WIPO's citation of each printed figure. */
function groupMeasureNotes(measure: GenderMeasure, label: string,
  group: { members: number; total: number; unlisted: string[]; wipoYears: number[]; source?: GroupGenderSource }, overview: Overview): string[] {
  const lines: string[] = [];
  if (measure === "women_any") {
    const floor = coverageFloorText(overview);
    const { members, total, unlisted } = group;
    const left = unlisted.length ? `; ${unlistedMembersText(unlisted, total)}`
      : members < total ? `; ${total - members} of the ${total} members have no PCT publications data` : "";
    lines.push(`${label}: ${GENDER_BASIS_LABEL.computed}. “n of m members” = the members with a published share, of the ` +
      `${members} members with PCT publications data${left}. Coverage = the share of the group's PCT publications held by the members with ` +
      `a published share${floor === null ? "" : `, at least ${floor} for a value`}.`);
  } else {
    lines.push(`${label}: ${MEASURE_NAME[measure]} is ${genderNullText("not_computable", overview)}` +
      (group.wipoYears.length ? `, except where WIPO prints a figure (${group.wipoYears.join(", ")}).` : "."));
  }
  return [...lines, ...printedFigureLines(measure, label, group)];
}

/** WIPO's citation of each printed figure of a group measure in `wipoYears`. Shared by the cards and the map's group modes. */
export function printedFigureLines(measure: GenderMeasure, label: string, group: { wipoYears: number[]; source?: GroupGenderSource }): string[] {
  return group.wipoYears.flatMap((year) => {
    const printed = group.source?.printed?.[String(year)];
    return printed ? [`${label}, ${MEASURE_NAME[measure]}, ${year}: ${GENDER_BASIS_LABEL.wipo}'s printed figure ${printed.figure}: ${printed.citation}, ${printed.page}. ${printed.url}`] : [];
  });
}

type CardSpec = {
  /** Name of the card's subject (country or group). */
  label: string;
  comparisons: Record<GenderMeasure, Comparison>;
  sources: (SourceBlock | undefined)[];
  /** Sources of the subject alone: the one-line card cites no more. */
  ownSources: (SourceBlock | undefined)[];
  /** Country card: with no value in any year of either measure, one line stands in place of tiles and charts. */
  oneLineWhenEmpty: boolean;
};

function womenCardContent(spec: CardSpec, overview: Overview): CardContent | null {
  const gender = overview.gender;
  const present = (blocks: (SourceBlock | undefined)[]): SourceBlock[] => blocks.filter((block): block is SourceBlock => Boolean(block));
  const source = present(spec.sources);
  if (!gender || source.length === 0 || MEASURES.some((measure) => !gender.world[measure])) return null;
  const { label } = spec;
  const valued = MEASURES.filter((measure) => hasValue(spec.comparisons[measure].main, gender.last_year[measure]));
  const empty = spec.oneLineWhenEmpty && valued.length === 0;
  const { comparisons } = spec;
  const hasGroup = MEASURES.some((measure) => comparisons[measure].main?.group || comparisons[measure].beside?.group);
  const basisNote = `${hasGroup ? "WIPO's shares and, for the group, values computed from them or printed by WIPO (see notes), by publication year." : "WIPO's figures, by publication year."} Two measures, one chart each: they count different things and are never drawn on one axis.`;
  if (empty) {
    return {
      title: `${CARD_TITLE}: ${label}`,
      draw: () => h("p", { class: NO_VALUE_CLASS }, `WIPO publishes no women-inventor share for ${label}`),
      table: { headers: ["Measure", "Figure", "Note"], numeric: [false, true, false],
        rows: MEASURES.map((measure): TableCell[] => [GENDER_TITLES[measure], "–", "no data reported: WIPO publishes no figure for any year"]) },
      footnotes: genderCaveat(overview),
      source: present(spec.ownSources),
    };
  }
  const draw = (width: number): HTMLElement => {
    return h("div", { class: "women-trends", [REDRAW_ATTRIBUTE]: "" }, [
      tileFigure(comparisons, overview),
      ...MEASURES.map((measure) => valued.includes(measure)
        ? measureChart(measure, comparisons[measure], overview, width)
        : h("p", { class: NO_VALUE_CLASS, "data-measure": measure },
          noValueText(measure, comparisons[measure], overview, gender.last_year[measure]))),
    ]);
  };
  return {
    title: `${CARD_TITLE}: ${label}`,
    note: basisNote,
    draw,
    table: figuresTable(label, comparisons, overview),
    footnotes: footnotes(comparisons, overview),
    source,
  };
}

const worldEntry = (overview: Overview, measure: GenderMeasure): Entry => ({ label: WORLD_LABEL, value: overview.gender!.world[measure], reason: {} });

/** A source block whose "To reproduce" line names what it fetched (country, region, World): the card shows several. */
const named = (source: SourceBlock | undefined, name: string): SourceBlock | undefined =>
  source && { ...source, entity: source.entity ? `${name} (${source.entity})` : name };

/** A group's source line: women_any is computed from its members' rows (weights named); women_share has no query (not
 * computable; WIPO's printed figures are cited in the footnotes). */
function groupSources(figures: GroupFigures, label: string): (SourceBlock | undefined)[] {
  const any = figures.sources?.women_any;
  return [any && named(any, `${label}, computed from its members' shares; weights: ${any.weights ?? "PCT publications"}`)];
}


/** Country card: tiles (last year of each measure, basis, region with "n of m" and coverage, World) and a chart per
 * measure: the country, its region (women_any) and the World. `region` = the country's UN M49 region with its figures. */
export function entityWomenCard(file: EntityFile, overview: Overview, region: CountryRegion | null | undefined, entities: Entities): CardContent | null {
  if (!file.gender || !overview.gender) return null;
  const comparisons = Object.fromEntries(MEASURES.map((measure) => [measure, {
    main: countryEntry(file, measure),
    beside: region ? groupEntry(region.figures, region.group, entities, measure) : null,
    world: worldEntry(overview, measure),
  }])) as Record<GenderMeasure, Comparison>;
  const own = MEASURES.map((measure) => named(file.sources[measure], file.label));
  return womenCardContent({
    label: file.label, comparisons, oneLineWhenEmpty: true, ownSources: own,
    sources: [...own, ...(region ? groupSources(region.figures, region.group.label) : []),
      ...MEASURES.map((measure) => named(overview.sources[measure], WORLD_LABEL))],
  }, overview);
}

/** Group card: tiles (value, basis, "n of m" members, coverage, World) and a chart per measure: the group beside the
 * World; `women_share` is not computable for a group except in the years WIPO prints a figure. */
export function groupWomenCard(figures: GroupFigures | undefined, group: GroupItem, overview: Overview, entities: Entities): CardContent | null {
  if (!figures?.gender || !overview.gender) return null;
  const comparisons = Object.fromEntries(MEASURES.map((measure) => [measure, {
    main: groupEntry(figures, group, entities, measure), beside: null, world: worldEntry(overview, measure),
  }])) as Record<GenderMeasure, Comparison>;
  return womenCardContent({
    label: group.label, comparisons, oneLineWhenEmpty: false, ownSources: [],
    sources: [...groupSources(figures, group.label), ...MEASURES.map((measure) => named(overview.sources[measure], WORLD_LABEL))],
  }, overview);
}
