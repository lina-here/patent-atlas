// Treemap card "Who files the world's patents?": WIPO applications by origin in the newest complete year, one rectangle
// per country, per "Other <continent>" and for the part of the world total no continent accounts for. Area = applications
// (spec 2a): the layout is squarified on the values with no padding, borders are strokes only. Every figure is a pipeline
// field (overview.json `treemap`); this module draws and words them, it computes none.
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import type { CardBuilder, CardContent } from "./overview";
import type { Overview, Treemap, TreemapContinent } from "./data";
import { formatCount } from "./dom";
import { fixedHalfAway } from "./format";
import { nullReasonText } from "./groupText";
import { originAbroadNote } from "./methods";
import { FALLBACK_WIDTH, minChartHeight, readTheme, textWidth, type ChartTheme } from "./charts";
import { hatchDefs } from "./overviewCharts";

export const TREEMAP_CARD_ID = "treemap";
/** Pattern id of the hatched not-attributable rectangle, after the card's id prefix: each treemap defines its own pattern in
 * its own svg and its rest and key swatch reference it by a `fill` attribute (a pattern inside a hidden slide does not paint,
 * so no treemap may reference another's). */
export const TREEMAP_HATCH_ID = "treemap-hatch";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Layout ratios: chart height against its width and against the theme's chart height (a phone gets a taller plot). */
const HEIGHT_PER_WIDTH = 0.5;
const MIN_HEIGHT_FACTOR = 1.5;
/** Layout ratios (font sizes): label line height, text inset in a rectangle, key row height and swatch size. */
const LINE_EM = 1.25;
const PAD_X_EM = 0.4;
const PAD_Y_EM = 0.3;
const TEXT_HEIGHT_EM = 1.25;
const KEY_ROW_EM = 1.7;
const KEY_SWATCH_EM = 1.3;
/** A continent's number in its key swatch and, set tight, in its largest rectangle (a digit needs only its cap height); the
 * fit ratios are exposed as data attributes on the svg (`data-number-*`) for the tests. The digit's size in the key is CSS
 * (`.treemap-key-number`). */
const NUMBER_PAD_EM = 0.1;
const NUMBER_CAP_EM = 0.72;
/** Text widths are measured on a canvas: tabular digits and rounding in the page can differ a little. */
const TEXT_SLACK = 1.04;
/** Most lines a rectangle's label may wrap to. */
const MAX_LABEL_LINES = 4;

type Leaf = {
  code: string;
  kind: "country" | "other" | "residual";
  continent: string;
  /** Text the rectangle is named by (the continent's name for a continent folded into one rectangle). */
  name: string;
  title: string;
  value: number;
  share: number | null;
  /** The rectangle is the whole continent, named for it. */
  namesContinent?: boolean;
};
type TreeNode = { children?: TreeNode[]; leaf?: Leaf; value?: number; continent?: string };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

function shareText(share: number | null, decimals: number): string | null {
  return share === null ? null : `${fixedHalfAway(share, decimals)}%`;
}

function rgbOf(colour: string): [number, number, number] {
  const canvas = document.createElement("canvas").getContext("2d");
  if (!canvas) return [0, 0, 0];
  canvas.fillStyle = "#000";
  canvas.fillStyle = colour;
  const resolved = canvas.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  if (resolved.startsWith("#")) return [1, 3, 5].map((at) => parseInt(resolved.slice(at, at + 2), 16)) as [number, number, number];
  return (/rgba?\(([^)]+)\)/.exec(resolved)?.[1] ?? "0,0,0").split(",").slice(0, 3).map(Number) as [number, number, number];
}

function luminance(colour: string): number {
  const [r, g, b] = rgbOf(colour).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** The text colour (ink or surface) that contrasts more with `fill`. */
function textOn(fill: string, theme: ChartTheme): string {
  return contrast(theme.ink, fill) >= contrast(theme.surface, fill) ? theme.ink : theme.surface;
}

/** `text` broken at spaces into lines no wider than `width`; null when a word alone is wider. */
function wrapWords(text: string, width: number, theme: ChartTheme): string[] | null {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const joined = lines.length > 0 ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length > 0 && textWidth(joined, theme) * TEXT_SLACK <= width) lines[lines.length - 1] = joined;
    else if (textWidth(word, theme) * TEXT_SLACK <= width) lines.push(word);
    else return null;
  }
  return lines;
}

/** The label lines that fit a rectangle `width` x `height` with `taken` lines already used at its top: "name, share" on one
 * line, else the name wrapped with the share on its own line, else the name alone; null = nothing fits. */
function labelLines(name: string, share: string | null, width: number, height: number, taken: number, theme: ChartTheme): string[] | null {
  const room = width - 2 * PAD_X_EM * theme.fontSize;
  const lineHeight = theme.fontSize * LINE_EM;
  const rows = Math.floor((height - 2 * PAD_Y_EM * theme.fontSize - TEXT_HEIGHT_EM * theme.fontSize) / lineHeight) + 1 - taken;
  const limit = Math.min(rows, MAX_LABEL_LINES);
  if (limit < 1 || room <= 0) return null;
  const candidates: (string[] | null)[] = [];
  if (share) candidates.push(wrapWords(`${name}, ${share}`, room, theme));
  const wrapped = wrapWords(name, room, theme);
  if (wrapped && share && textWidth(share, theme) * TEXT_SLACK <= room) candidates.push([...wrapped, share]);
  candidates.push(wrapped);
  return candidates.find((lines): lines is string[] => lines !== null && lines.length <= limit) ?? null;
}

function buildTree(block: Treemap, decimals: number): TreeNode {
  const children: TreeNode[] = [];
  for (const continent of block.continents) {
    const leaves: TreeNode[] = continent.countries.flatMap((country): TreeNode[] => (country.value === null || country.value <= 0 ? [] : [{
      value: country.value, continent: continent.id,
      leaf: { code: country.code, kind: "country", continent: continent.id, name: country.label, value: country.value, share: country.share,
        title: `${country.label}: ${formatCount(country.value)} applications, ${shareText(country.share, decimals) ?? "–"}` },
    }]));
    const other = continent.other;
    if (other && other.value > 0) {
      const alone = leaves.length === 0; // no country is drawn: the "Other" rectangle is the continent
      const name = alone ? continent.label : `Other ${continent.label}`;
      leaves.push({
        value: other.value, continent: continent.id,
        leaf: { code: "", kind: "other", continent: continent.id, name, value: other.value, share: other.share, namesContinent: alone,
          title: `${name} (${other.codes.length} origins): ${formatCount(other.value)} applications, ${shareText(other.share, decimals) ?? "–"}` },
      });
    }
    if (leaves.length > 0) children.push({ children: leaves, continent: continent.id });
  }
  const residual = block.residual;
  if (residual && residual.value !== null && residual.value > 0) {
    children.push({
      value: residual.value, continent: "residual",
      leaf: { code: "", kind: "residual", continent: "residual", name: residual.label, value: residual.value, share: residual.share,
        title: `${residual.label}: ${formatCount(residual.value)} applications, ${shareText(residual.share, decimals) ?? "–"}` },
    });
  }
  return { children };
}

/** A key row under the plot: swatch + name per continent with a rectangle (the order of the data) and the rest; wrapped to
 * `width`. Returns its group and height. */
function keyGroup(items: { id: string; label: string; number?: number; fill?: string }[], theme: ChartTheme, width: number): { group: SVGGElement; height: number } {
  const row = theme.fontSize * KEY_ROW_EM;
  const swatch = theme.fontSize * KEY_SWATCH_EM;
  const gap = theme.fontSize * 0.5;
  const group = el("g", { class: "treemap-key" });
  let x = 0;
  let line = 0;
  for (const item of items) {
    const itemWidth = swatch + gap + textWidth(item.label, theme) * TEXT_SLACK + gap * 2;
    if (x > 0 && x + itemWidth > width) {
      x = 0;
      line += 1;
    }
    const middle = (line + 0.5) * row;
    group.append(el("g", { class: "treemap-key-item", "data-continent": item.id,
      ...(item.number !== undefined ? { "data-digit-width": textWidth(String(item.number), theme) } : {}) },
      el("rect", { class: `treemap-swatch${item.id === "residual" ? " treemap-residual" : ""}`, x, y: middle - swatch / 2, width: swatch, height: swatch,
        ...(item.fill ? { fill: item.fill } : {}) }),
      ...(item.number !== undefined && item.fill
        ? [Object.assign(el("text", { class: "treemap-key-number", x: x + swatch / 2, y: middle, "text-anchor": "middle", "dominant-baseline": "central",
          fill: textOn(item.fill, theme) }), { textContent: String(item.number) })]
        : []),
      Object.assign(el("text", { class: "treemap-key-name", x: x + swatch + gap, y: middle, "dominant-baseline": "central", fill: theme.ink }), { textContent: item.label })));
    x += itemWidth;
  }
  return { group, height: (line + 1) * row };
}

/** Squarified treemap of `block` in a `width` x `height` svg (height = plot and key together). */
export function treemapChart(block: Treemap, opts: { width: number; height?: number; decimals: number; idPrefix?: string }): SVGElement {
  const theme = readTheme();
  const width = opts.width > 0 ? opts.width : FALLBACK_WIDTH;
  const decimals = opts.decimals;
  const natural = Math.max(theme.height * MIN_HEIGHT_FACTOR, width * HEIGHT_PER_WIDTH);
  const total = opts.height === undefined ? natural : Math.max(minChartHeight(), Math.min(opts.height, natural));

  const hatchId = `${opts.idPrefix ?? ""}${TREEMAP_HATCH_ID}`;
  const hatchFill = `url(#${hatchId})`;
  const tree = buildTree(block, decimals);
  // continents with a rectangle, numbered 1..n in the order of the data (the key and each continent's largest rectangle carry the number)
  const drawn = (tree.children ?? []).map((band) => band.continent ?? "").filter((id) => id !== "residual" && id !== "");
  const numberOf = (id: string): number => drawn.indexOf(id) + 1;
  const residualShown = block.residual !== null && block.residual.value !== null && block.residual.value > 0;
  const labelFor = (id: string): string => block.continents.find((continent) => continent.id === id)?.label ?? id;
  const keyItems = [
    ...drawn.map((id) => ({ id, label: labelFor(id), number: numberOf(id), fill: theme.continent(id, block.continents.findIndex((continent) => continent.id === id)) })),
    ...(residualShown && block.residual ? [{ id: "residual", label: block.residual.label, fill: hatchFill }] : []),
  ];
  const key = keyGroup(keyItems, theme, width);
  const keyGap = theme.fontSize * 0.8;
  const plotHeight = Math.max(theme.fontSize * 4, total - key.height - keyGap);

  const root = hierarchy<TreeNode>(tree, (node) => node.children)
    .sum((node) => node.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  treemap<TreeNode>().size([width, plotHeight]).tile(treemapSquarify).paddingInner(0).paddingOuter(0).round(false)(root);
  const laid = root as HierarchyRectangularNode<TreeNode>;

  const svg = el("svg", { class: "treemap-chart", width, height: plotHeight + keyGap + key.height, viewBox: `0 0 ${width} ${plotHeight + keyGap + key.height}` });
  svg.style.maxWidth = "100%";
  svg.dataset.fontSize = String(theme.fontSize);
  svg.dataset.numberCapEm = String(NUMBER_CAP_EM);
  svg.dataset.numberPadEm = String(NUMBER_PAD_EM);
  svg.dataset.textSlack = String(TEXT_SLACK);
  svg.append(hatchDefs(hatchId));
  const plateColour = getComputedStyle(document.documentElement).getPropertyValue("--treemap-residual").trim() || theme.surface;

  const labels = el("g", { class: "treemap-labels" });
  const bands = el("g", { class: "treemap-bands" });
  let index = 0;
  for (const band of laid.children ?? []) {
    const leaves = band.leaves();
    // the continent's name sits at the top left of its largest rectangle when it fits, else its number when a digit fits (a
    // rectangle that is the whole continent is named by its own label)
    const largest = leaves.reduce((best, node) => ((node.value ?? 0) > (best.value ?? 0) ? node : best));
    for (const node of leaves) {
      const leaf = node.data.leaf as Leaf;
      const x = node.x0;
      const y = node.y0;
      const w = node.x1 - node.x0;
      const h = node.y1 - node.y0;
      const at = index;
      index += 1;
      const residual = leaf.kind === "residual";
      const fill = residual ? plateColour : theme.continent(leaf.continent, block.continents.findIndex((continent) => continent.id === leaf.continent));
      svg.append(el("rect", {
        class: `treemap-rect${residual ? " treemap-residual" : ""}`, x, y, width: w, height: h, "data-index": at, "data-kind": leaf.kind,
        "data-continent": leaf.continent, "data-code": leaf.code, "data-value": leaf.value,
        fill: residual ? hatchFill : fill,
      }, Object.assign(el("title"), { textContent: leaf.title })));
      const colour = textOn(fill, theme);
      let taken = 0;
      if (largest === node && !residual) {
        const name = labelFor(leaf.continent);
        const lines = labelLines(name, null, w, h, 0, theme);
        const digit = String(numberOf(leaf.continent));
        const digitFits = w >= textWidth(digit, theme) * TEXT_SLACK + 2 * NUMBER_PAD_EM * theme.fontSize
          && h >= (NUMBER_CAP_EM + 2 * NUMBER_PAD_EM) * theme.fontSize;
        if (lines && lines.length === 1 && !leaf.namesContinent) {
          labels.append(textBlock([name], x, y, 0, colour, "treemap-continent-label", at, leaf.continent, theme));
          taken = 1;
        } else if (digitFits && !(leaf.namesContinent && lines)) {
          const pad = NUMBER_PAD_EM * theme.fontSize;
          labels.append(Object.assign(el("text", { class: "treemap-continent-number", x: x + pad, y: y + pad + NUMBER_CAP_EM * theme.fontSize, fill: colour,
            "data-index": at, "data-continent": leaf.continent }), { textContent: digit }));
          taken = 1;
        }
      }
      const lines = labelLines(leaf.name, shareText(leaf.share, decimals), w, h, taken, theme);
      if (!lines) continue;
      if (residual) {
        const blockWidth = Math.max(...lines.map((line) => textWidth(line, theme))) * TEXT_SLACK + PAD_X_EM * theme.fontSize;
        svg.append(el("rect", { class: "treemap-plate", "data-index": at, x: x + PAD_X_EM * theme.fontSize / 2, y: y + PAD_Y_EM * theme.fontSize / 2,
          width: Math.min(blockWidth, w - PAD_X_EM * theme.fontSize), height: Math.min(lines.length * theme.fontSize * LINE_EM + PAD_Y_EM * theme.fontSize, h - PAD_Y_EM * theme.fontSize),
          fill: plateColour }));
      }
      labels.append(textBlock(lines, x, y, taken, colour, "treemap-label", at, leaf.continent, theme));
    }
    bands.append(el("rect", { class: "treemap-band", x: band.x0, y: band.y0, width: band.x1 - band.x0, height: band.y1 - band.y0, "data-continent": band.data.continent ?? "" }));
  }
  svg.append(bands, labels);
  svg.append(el("g", { transform: `translate(0 ${plotHeight + keyGap})` }, key.group));
  return svg;
}

/** Label lines as one text element, starting after `taken` lines at the top left of the rectangle at (x, y). */
function textBlock(lines: string[], x: number, y: number, taken: number, fill: string, className: string, index: number, continent: string,
  theme: ChartTheme): SVGTextElement {
  const lineHeight = theme.fontSize * LINE_EM;
  const left = x + PAD_X_EM * theme.fontSize;
  const first = y + PAD_Y_EM * theme.fontSize + theme.fontSize + taken * lineHeight;
  const text = el("text", { class: className, x: left, y: first, fill, "data-index": index, "data-continent": continent });
  lines.forEach((line, row) => text.append(Object.assign(el("tspan", { x: left, y: first + row * lineHeight }), { textContent: line })));
  return text;
}

function figuresRows(block: Treemap, decimals: number): (string | number | null)[][] {
  const share = (value: number | null): string | null => shareText(value, decimals);
  const rows: (string | number | null)[][] = [];
  for (const continent of block.continents) {
    for (const country of continent.countries) rows.push([continent.label, country.label, country.value, share(country.share)]);
    // a continent with no country of its own is one rectangle: its row is named for the continent
    if (continent.other) rows.push([continent.label, continent.countries.length === 0 ? continent.label : `Other ${continent.label}`, continent.other.value, share(continent.other.share)]);
  }
  if (block.residual) rows.push(["–", block.residual.label, block.residual.value, share(block.residual.share)]);
  for (const row of block.unattributed) {
    rows.push(["–", `${row.label} (counted in “${block.residual?.label ?? ""}”)`, row.value, share(row.share)]);
  }
  return rows;
}

function foldedNotes(continents: TreemapContinent[]): string[] {
  return continents.filter((continent) => continent.other).map((continent) => `Other ${continent.label}: ${(continent.other?.codes ?? []).join(", ")}.`);
}

const NEGATIVE_REST = (year: number): string =>
  `The part of the world total that no continent accounts for is negative in ${year}, so the treemap is not drawn.`;

/** The treemap card; left out when the data has no `treemap` (older data), a message in its place when the year cannot be drawn
 * (a null reason, or a negative rest). */
export function treemapCard(overview: Overview, idPrefix = ""): CardBuilder {
  const block = overview.treemap;
  const title = block ? `Who files the world's patents? Applications by origin, ${block.year}` : "";
  const negative = Boolean(block?.residual && block.residual.value !== null && block.residual.value < 0);
  const message = block?.null_reason ? nullReasonText(block.null_reason, overview) : negative && block ? NEGATIVE_REST(block.year) : null;
  // the share decimals come from the method; without them the card is left out, like any other absent data (no guessed rounding)
  const decimals = overview.method.rounding.decimals.share;
  if (typeof decimals !== "number") return { id: TREEMAP_CARD_ID, wide: true, build: () => null };
  return {
    id: TREEMAP_CARD_ID,
    wide: true, // area carries the figure: the plot takes the whole grid row, where small rectangles still hold a label
    ...(block && message ? { problem: { title, message } } : {}),
    build: (): CardContent | null => {
      const source = overview.sources.origin_apps;
      if (!block || !source || message || !block.residual) return null;
      const denominator = overview.share_denominator.origin_apps;
      const fold = overview.method.treemap?.fold_share_pct;
      const unattributed = block.unattributed.map((row) => row.label);
      return {
        title,
        note: `Each rectangle's area is the patent applications filed by applicants from that origin in ${block.year}, grouped by continent ` +
          `(outlined, named in the key); labels give the share of the ${denominator}.`,
        draw: (width, height) => treemapChart(block, { width, height, decimals, idPrefix }),
        table: {
          headers: ["Continent", "Origin", "Applications", `Share of ${denominator}`],
          rows: figuresRows(block, decimals),
          numeric: [false, false, true, true],
        },
        footnotes: [
          `Origins under ${fold === undefined ? "the fold share" : `${fold}%`} of the ${denominator} are folded into “Other <continent>”; ` +
            "a continent with no larger origin is one rectangle named for the continent. The codes folded are listed below.",
          ...foldedNotes(block.continents),
          `The hatched rectangle (“${block.residual.label}”) is the part of the ${denominator} that no continent accounts for` +
            `${unattributed.length > 0 ? `; it includes ${unattributed.join(", ")}` : ""}.`,
          ...(block.no_value.length > 0
            ? [`Listed by WIPO with no value in ${block.year}, so not drawn (never counted as 0): ${block.no_value.map((origin) => origin.label).join(", ")}.`]
            : []),
          originAbroadNote(overview),
        ],
        source,
      };
    },
  };
}
