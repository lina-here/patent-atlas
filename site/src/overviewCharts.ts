// Patent Atlas overview charts: rank race, continent share, size vs growth, PCT monthly heat strip. Split from charts.ts;
// theme reading and layout helpers are shared from there. Every visual value comes from the theme (see charts.ts).
import { areaY, axisX, axisY, cell, dot, gridY, line, plot, pointer, rect, ruleY, scale, text, tip } from "@observablehq/plot";
import { formatCount } from "./dom";
import {
  FALLBACK_WIDTH, axisFormat, cssLength, fitHeight, readTheme, textWidth, widest, type ChartTheme,
} from "./charts";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Pattern ids for "no data" fills (colour is never the only cue), after the card's id prefix: each chart's marks reference
 * the pattern in its own SVG, so a chart shown twice on a page (overview family, dashboard carousel) never borrows another's
 * (a pattern in a hidden or removed slide does not paint). */
export const SHARE_HATCH_ID = "continent-share-hatch";
export const HEAT_HATCH_ID = "pct-monthly-hatch";
/** Fallback hatch spacing (px) when the theme sets no `--map-hatch-gap`. */
const UNTHEMED_HATCH_GAP = 4;
const HATCH_ANGLE = 45;
/** Marker shapes per continent (Plot symbol names): shape tells continents apart without colour. */
const SYMBOLS = ["circle", "square", "triangle", "diamond", "cross", "star"];
/** Layout ratios (font sizes): legend line height, legend swatch size, marker size against the dot radius. */
const LEGEND_LINE_EM = 1.6;
const SWATCH_RADIUS_EM = 0.5;
const MARKER_SCALE = 1.6;
/** Rank-race point size against the dot radius (the lines are the figure; the points mark each year). */
const RANK_POINT_SCALE = 0.6;
/** Points of the scatter that carry a name: the largest and the fastest-growing. */
const LABELLED_LARGEST = 2;
const LABELLED_FASTEST = 2;
/** Share of the chart width one rank-race end label may take. */
const RANK_LABEL_SHARE = 0.22;
/** Width (px) of the surface-coloured halo behind a rank-race label that sits inside the plot. */
const RUN_LABEL_HALO = 3;
/** Rank-race run labels: the line height a label needs (font sizes), and how many such steps a label may move off its point. */
const RUN_LABEL_LINE_EM = 1.1;
const RUN_LABEL_MAX_STEPS = 3;

type PlacedLabel<T> = T & { labelRank: number };

/** Run-end labels moved up or down (in whole text lines, nearest first) off the first spot where they would overprint a
 * label already placed or an end label; a label with no free spot stays on its point. Positions in px follow the plot's
 * linear scales: the rank axis runs from rank 0.5 at the top. */
function placeRunLabels<T extends { label: string; year: number; rank: number }>(runEnds: T[], ends: { label: string; rank: number }[], plotBox: {
  left: number; innerWidth: number; top: number; innerHeight: number; first: number; last: number; ranks: number; gap: number;
  lineHeight: number; cap: number; widthOf: (label: string) => number }): PlacedLabel<T>[] {
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const pitch = plotBox.innerHeight / plotBox.ranks;
  const xOf = (year: number): number => plotBox.left + ((year - plotBox.first) / Math.max(1, plotBox.last - plotBox.first)) * plotBox.innerWidth;
  const yOf = (rank: number): number => plotBox.top + (rank - 0.5) * pitch;
  const boxAt = (x: number, y: number, label: string, limit: number): Box => ({
    x0: x + plotBox.gap, x1: x + plotBox.gap + Math.min(plotBox.widthOf(label), limit), y0: y - plotBox.lineHeight / 2, y1: y + plotBox.lineHeight / 2 });
  const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const taken: Box[] = ends.map((entry) => boxAt(xOf(plotBox.last), yOf(entry.rank), entry.label, Infinity));
  const steps = [0, ...Array.from({ length: RUN_LABEL_MAX_STEPS }, (_, index) => [-(index + 1), index + 1]).flat()];
  return [...runEnds].sort((a, b) => a.year - b.year).map((entry) => {
    const x = xOf(entry.year);
    const y = yOf(entry.rank);
    const step = steps.find((candidate) => !taken.some((box) => overlaps(box, boxAt(x, y + candidate * plotBox.lineHeight, entry.label, plotBox.cap)))) ?? 0;
    taken.push(boxAt(x, y + step * plotBox.lineHeight, entry.label, plotBox.cap));
    return { ...entry, labelRank: entry.rank + (step * plotBox.lineHeight) / pitch };
  });
}

/** The "no data" hatch pattern, drawn from the map's classes and tokens (`--map-hatch*`). */
export function hatchDefs(id: string): SVGDefsElement {
  const gap = cssLength("--map-hatch-gap", UNTHEMED_HATCH_GAP);
  const make = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    return element;
  };
  const pattern = make("pattern", { id, patternUnits: "userSpaceOnUse", width: gap, height: gap, patternTransform: `rotate(${HATCH_ANGLE})` });
  pattern.append(make("rect", { class: "map-hatch-bg", width: gap, height: gap }),
    make("line", { class: "map-hatch-line", x1: 0, y1: 0, x2: 0, y2: gap }));
  const defs = make("defs", {});
  defs.append(pattern);
  return defs;
}

type LegendItem = { label: string; symbol: string; fill?: string; className?: string };

/** A legend row inside the plot's top margin: swatch + label per item, wrapped to `width`. `topPad` = margin kept above the
 * plot frame below the legend, so the margin needed is `height + topPad`. Plot places a mark with `frameAnchor` and no x/y
 * relative to the plot frame. */
function legendMarks(items: LegendItem[], theme: ChartTheme, width: number, marginLeft: number, topPad: number): { marks: unknown[]; height: number } {
  const line = theme.fontSize * LEGEND_LINE_EM;
  const radius = theme.fontSize * SWATCH_RADIUS_EM;
  const gap = theme.fontSize * 0.5;
  const placed: { item: LegendItem; x: number; row: number }[] = [];
  let cursor = 0;
  let row = 0;
  for (const item of items) {
    const itemWidth = radius * 2 + (item.label ? gap + textWidth(item.label, theme) : 0) + gap * 2;
    if (cursor > 0 && cursor + itemWidth > width) {
      cursor = 0;
      row += 1;
    }
    placed.push({ item, x: cursor, row });
    cursor += itemWidth;
  }
  const height = (row + 1) * line;
  const marks = placed.flatMap(({ item, x, row: at }) => {
    const dy = (at + 0.5) * line - height - topPad;
    const dx = x - marginLeft;
    return [
      dot([item.label], { frameAnchor: "top-left", dx: dx + radius, dy, symbol: item.symbol, r: radius, fill: item.fill ?? theme.ink,
        stroke: theme.surface, className: item.className }),
      ...(item.label ? [text([item.label], { frameAnchor: "top-left", dx: dx + radius * 2 + gap, dy, textAnchor: "start", fill: theme.ink })] : []),
    ];
  });
  return { marks, height };
}

export type RankRaceRow = { label: string; ranks: Record<string, number | null> };

/** One line per origin, rank (1 at the top) by year; only ranks within `top` are drawn (a rank below leaves a gap). The
 * start of a line at the first year and the end of every contiguous run (a run is a stretch of consecutive years inside
 * `top`) carry the origin's name, so each line is named without its colour; the lines cycle through the chart colours. */
export function rankRaceChart(rows: RankRaceRow[], opts: { top: number; years: number[]; width?: number; height?: number }): SVGElement {
  const theme = readTheme();
  const width = opts.width ?? FALLBACK_WIDTH;
  const gap = theme.fontSize * 0.6;
  const first = opts.years[0];
  const last = opts.years[opts.years.length - 1];
  type Entry = { label: string; year: number; rank: number | null; colour: string };
  const entries: Entry[] = rows.flatMap((row, index) => opts.years.map((year) => {
    const rank = row.ranks[String(year)] ?? null;
    return { label: row.label, year, rank: rank !== null && rank <= opts.top ? rank : null,
      colour: theme.series[index % theme.series.length] };
  }));
  const drawn = entries.filter((entry): entry is Entry & { rank: number } => entry.rank !== null);
  const starts = drawn.filter((entry) => entry.year === first);
  const ends = drawn.filter((entry) => entry.year === last);
  // a run ends before the last year where the next year of the same origin is not drawn
  const drawnKeys = new Set(drawn.map((entry) => `${entry.label}|${entry.year}`));
  const yearAfter = new Map(opts.years.map((year, index) => [year, opts.years[index + 1]]));
  // a one-point run at the first year is named by its start label already
  const runEnds = drawn.filter((entry) => entry.year > first && entry.year < last && !drawnKeys.has(`${entry.label}|${yearAfter.get(entry.year)}`));
  const cap = width * RANK_LABEL_SHARE;
  const sideWidth = (list: Entry[]): number => Math.min(widest(list.map((entry) => entry.label), theme), cap);
  const startWidth = sideWidth(starts);
  const endWidth = sideWidth(ends);
  const cut = (labels: Entry[], capped: number): object => widest(labels.map((entry) => entry.label), theme) > capped
    ? { textOverflow: "ellipsis", lineWidth: capped / theme.fontSize } : {};
  const ticks = Array.from({ length: opts.top }, (_, index) => index + 1);
  const rankTickWidth = widest([String(opts.top)], theme);
  const height = fitHeight(opts.height, theme);
  const marginTop = theme.fontSize * 1.2;
  const marginBottom = theme.fontSize * 2;
  const marginLeft = rankTickWidth + gap + startWidth + gap * 2;
  const marginRight = endWidth + gap * 3;
  const runLabels = placeRunLabels(runEnds, ends, {
    left: marginLeft, innerWidth: width - marginLeft - marginRight, top: marginTop, innerHeight: height - marginTop - marginBottom,
    first, last, ranks: opts.top, gap: gap * 1.6, lineHeight: theme.fontSize * RUN_LABEL_LINE_EM, cap: sideWidth(runEnds),
    widthOf: (label) => textWidth(label, theme),
  });
  return plot({
    width,
    height,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    x: { type: "linear", label: null, domain: [first, last] },
    y: { type: "linear", label: null, domain: [opts.top + 0.5, 0.5] },
    marks: [
      gridY({ stroke: theme.grid, strokeOpacity: 1, ticks }),
      axisY({ ticks, tickSize: 0, tickFormat: "d", color: theme.muted, label: null, tickPadding: startWidth + gap * 2 }),
      axisX({ tickFormat: "d", color: theme.muted, label: null, ticks: Math.max(2, Math.floor(width / theme.xTickGap)) }),
      line(entries, { x: "year", y: "rank", z: "label", stroke: "colour", className: "chart-line" }),
      dot(drawn, { x: "year", y: "rank", r: theme.dotRadius * RANK_POINT_SCALE, fill: "colour", className: "rank-point" }),
      text(starts, { x: "year", y: "rank", text: "label", dx: -gap * 1.6, textAnchor: "end", fill: theme.ink, ...cut(starts, startWidth) }),
      text(ends, { x: "year", y: "rank", text: "label", dx: gap * 1.6, textAnchor: "start", fill: theme.ink,
        className: "chart-end-label", ...cut(ends, endWidth) }),
      // a run that stops before the last year: named where it stops, over a halo so crossing lines do not hide it
      text(runLabels, { x: "year", y: "labelRank", text: "label", dx: gap * 1.6, textAnchor: "start", fill: theme.ink,
        stroke: theme.surface, strokeWidth: RUN_LABEL_HALO, paintOrder: "stroke",
        className: "rank-run-label", ...cut(runEnds, sideWidth(runEnds)) }),
      tip(drawn, pointer({ x: "year", y: "rank", fill: theme.surface, stroke: theme.grid,
        title: (entry: Entry) => `${entry.label}\n${entry.year}: rank ${entry.rank}` })),
    ],
  }) as SVGElement;
}

/** Half the width, in years, of the bar that stands for a kept year with no kept neighbour. */
const SINGLE_YEAR_HALF_WIDTH = 0.25;
/** Least distance between two band names, in font sizes. */
const END_LABEL_GAP_EM = 1.2;
/** Share of the chart width the band names at the right edge may take. */
const LABEL_SHARE = RANK_LABEL_SHARE;

/** Name positions for the bands of one year: each at its band's middle (y in 0..1, 1 = top), pushed apart to at least
 * `minGap` px within a plot of `inner` px, order kept. */
function bandNames(bands: { label: string; low: number; high: number }[], inner: number, minGap: number): { label: string; y: number }[] {
  const placed = bands.map((band) => ({ label: band.label, top: (1 - (band.low + band.high) / 2) * inner }))
    .sort((a, b) => a.top - b.top);
  for (let index = 1; index < placed.length; index++) placed[index].top = Math.max(placed[index].top, placed[index - 1].top + minGap);
  const overflow = (placed.at(-1)?.top ?? 0) - inner;
  if (overflow > 0) {
    placed[placed.length - 1].top = inner;
    for (let index = placed.length - 2; index >= 0; index--) placed[index].top = Math.min(placed[index].top, placed[index + 1].top - minGap);
  }
  return placed.map((entry) => ({ label: entry.label, y: 1 - entry.top / inner }));
}

/** `shares[year]` = fraction of the world total (0..1); null = the year is left out for every layer. */
export type ShareLayer = { key: string; label: string; hatched?: boolean; shares: Record<number, number | null> };

/** Stacked areas, one per layer in order, filling 0-100% of the world total. A year where any layer is null is left out:
 * the areas are drawn in separate segments (one per run of kept years), never bridged across it. A `hatched` layer is
 * hatched, not coloured; every layer is also named in text at the right edge of its band. */
export function shareAreaChart(layers: ShareLayer[], opts: {
  years: number[]; width?: number; height?: number; format: (share: number) => string; idPrefix?: string }): SVGElement {
  const theme = readTheme();
  const hatchId = `${opts.idPrefix ?? ""}${SHARE_HATCH_ID}`;
  const hatchFill = `url(#${hatchId})`;
  const width = opts.width ?? FALLBACK_WIDTH;
  const gap = theme.fontSize * 0.6;
  type Slice = { key: string; label: string; year: number; segment: number; low: number | null; high: number | null; share: number | null };
  let segment = 0;
  let previousComplete = false;
  const slices: Slice[] = opts.years.flatMap((year) => {
    const complete = layers.every((layer) => layer.shares[year] != null);
    if (complete && !previousComplete) segment += 1; // a new run of kept years starts here
    previousComplete = complete;
    let base = 0;
    return layers.map((layer) => {
      const share = complete ? (layer.shares[year] as number) : null;
      const low = share === null ? null : base;
      base += share ?? 0;
      return { key: layer.key, label: layer.label, year, segment, low, high: share === null ? null : base, share };
    });
  });
  const colourOf = new Map(layers.map((layer, index) => [layer.key, theme.continent(layer.key, index)]));
  const solid = layers.filter((layer) => !layer.hatched);
  const hatched = layers.filter((layer) => layer.hatched);
  // a run of one year has no width as an area: it is drawn as a short bar per band instead, so no kept year is invisible
  const yearsInSegment = new Map<number, number>();
  for (const slice of slices) if (slice.share !== null && slice.key === layers[0].key) yearsInSegment.set(slice.segment, (yearsInSegment.get(slice.segment) ?? 0) + 1);
  const defined = slices.filter((slice): slice is Slice & { low: number; high: number; share: number } => slice.share !== null);
  const percentTicks = [0, 0.25, 0.5, 0.75, 1];
  const marginLeft = widest(["100%"], theme) + gap;
  const topPad = theme.fontSize * 0.6;
  const legend = legendMarks(layers.map((layer) => layer.hatched
    ? { label: layer.label, symbol: "square", fill: hatchFill, className: "hatch-continent-share" }
    : { label: layer.label, symbol: "square", fill: colourOf.get(layer.key) }), theme, width, marginLeft, topPad);
  const height = fitHeight(opts.height, theme);
  const marginTop = legend.height + topPad;
  const marginBottom = theme.fontSize * 2;
  // band names at the right edge of the last kept year, moved apart vertically so thin bands do not overprint
  const lastYear = defined.reduce((latest, slice) => Math.max(latest, slice.year), opts.years[0]);
  const nameWidth = Math.min(widest(layers.map((layer) => layer.label), theme), width * LABEL_SHARE);
  const names = bandNames(defined.filter((slice) => slice.year === lastYear), height - marginTop - marginBottom, theme.fontSize * END_LABEL_GAP_EM);
  const svg = plot({
    width,
    height,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight: nameWidth + gap * 3,
    x: { type: "linear", label: null, domain: [opts.years[0], opts.years[opts.years.length - 1]] },
    y: { label: null, domain: [0, 1] },
    marks: [
      gridY({ stroke: theme.grid, strokeOpacity: 1, ticks: percentTicks }),
      axisY({ ticks: percentTicks, tickSize: 0, tickFormat: (value: number) => `${Math.round(value * 100)}%`, color: theme.muted, label: null }),
      axisX({ tickFormat: "d", color: theme.muted, label: null, ticks: Math.max(2, Math.floor(width / theme.xTickGap)) }),
      ...solid.map((layer) => areaY(defined.filter((slice) => slice.key === layer.key), {
        x: "year", y1: "low", y2: "high", z: "segment", fill: colourOf.get(layer.key), stroke: theme.surface, className: "share-area",
      })),
      ...hatched.map((layer) => areaY(defined.filter((slice) => slice.key === layer.key), {
        x: "year", y1: "low", y2: "high", z: "segment", fill: hatchFill, stroke: theme.surface, className: "hatch-continent-share share-area share-band",
      })),
      text(names, { x: lastYear, y: "y", text: "label", dx: gap * 1.6, textAnchor: "start", fill: theme.ink, className: "share-label",
        ...(widest(layers.map((layer) => layer.label), theme) > nameWidth ? { textOverflow: "ellipsis", lineWidth: nameWidth / theme.fontSize } : {}) }),
      ...[solid, hatched].map((group, index) => rect(defined.filter((slice) => yearsInSegment.get(slice.segment) === 1 &&
        group.some((layer) => layer.key === slice.key)), {
        // clamped to the x domain: Plot does not clip, a bar at the first or last year would spill over the axis or names
        x1: (slice: { year: number }) => Math.max(opts.years[0], slice.year - SINGLE_YEAR_HALF_WIDTH),
        x2: (slice: { year: number }) => Math.min(opts.years[opts.years.length - 1], slice.year + SINGLE_YEAR_HALF_WIDTH),
        y1: "low", y2: "high", fill: index === 0 ? ((slice: { key: string }) => colourOf.get(slice.key)) : hatchFill,
        stroke: theme.surface, className: index === 0 ? "share-single" : "hatch-continent-share share-single",
      })),
      ...legend.marks as never[],
      tip(defined, pointer({ x: "year", y: (slice: { low: number; high: number }) => (slice.low + slice.high) / 2,
        fill: theme.surface, stroke: theme.grid,
        title: (slice: Slice & { share: number }) => `${slice.label}\n${slice.year}: ${opts.format(slice.share)}` })),
    ],
  }) as SVGElement;
  svg.prepend(hatchDefs(hatchId));
  return svg;
}

export type ScatterPoint = { label: string; key: string; x: number; y: number };

/** Log x, linear y; marker colour and shape by `key` (`keys` order and labels); the largest points are named. */
export function scatterChart(points: ScatterPoint[], keys: { key: string; label: string }[], opts: {
  xLabel: string; yLabel: string; formatY: (value: number) => string; formatTip: (value: number) => string;
  width?: number; height?: number }): SVGElement {
  const theme = readTheme();
  const width = opts.width ?? FALLBACK_WIDTH;
  const gap = theme.fontSize * 0.6;
  const colours = keys.map((entry, index) => theme.continent(entry.key, index));
  const symbols = keys.map((_, index) => SYMBOLS[index % SYMBOLS.length]);
  const named = [...new Set([...[...points].sort((a, b) => b.x - a.x).slice(0, LABELLED_LARGEST),
    ...[...points].sort((a, b) => b.y - a.y).slice(0, LABELLED_FASTEST)])];
  const xs = points.map((point) => point.x);
  // no point: one decade, so the axes still draw
  const lowTick = xs.length === 0 ? 0 : Math.floor(Math.log10(Math.min(...xs)));
  const highTick = xs.length === 0 ? lowTick + 1 : Math.max(lowTick + 1, Math.ceil(Math.log10(Math.max(...xs))));
  const xTicks = Array.from({ length: highTick - lowTick + 1 }, (_, index) => 10 ** (lowTick + index));
  const marginLeft = widest(["-88%", "88%"], theme) + gap * 2;
  const topPad = theme.fontSize * 2.4; // room for the y axis title above the plot frame, clear of the top tick label
  const legend = legendMarks(keys.map((entry, index) => ({ label: entry.label, symbol: symbols[index], fill: colours[index] })),
    theme, width, marginLeft, topPad);
  const height = fitHeight(opts.height, theme);
  const markerArea = Math.PI * (theme.dotRadius * MARKER_SCALE) ** 2;
  const offset = theme.dotRadius * MARKER_SCALE + theme.fontSize * 0.3; // a name's gap from its marker's centre
  // Names placed in pixels, measured in the font in use (wide fallback fonts too), each at the first free spot of: beside
  // its marker facing the plot's middle, the other side, above, below; inside the plot and clear of names already
  // placed, else left out (the tooltip and the figures table still name it). Centred above its marker, a name ran over
  // the y tick labels, the axis title or another name on a narrow card.
  const marginRight = offset + gap; // names never go right of the plot: only the rightmost marker needs room
  const marginTop = legend.height + topPad;
  const marginBottom = theme.fontSize * 3.4;
  const plotLeft = marginLeft;
  const plotRight = width - marginRight;
  const plotTop = marginTop;
  const plotBottom = height - marginBottom;
  const decades = highTick - lowTick;
  const toPixel = (value: number): number => plotLeft + ((Math.log10(value) - lowTick) / decades) * (plotRight - plotLeft);
  const toValue = (pixel: number): number => 10 ** (lowTick + ((pixel - plotLeft) / (plotRight - plotLeft)) * decades);
  // the y domain fixed here (0 always in it: the zero rule), so the pixels computed below are the ones Plot draws
  const ys = [0, ...points.map((point) => point.y)];
  const yScale = scale({ y: { domain: [Math.min(...ys), Math.max(...ys)], range: [plotBottom, plotTop], nice: true } }) as
    unknown as { domain: number[]; apply: (value: number) => number; invert: (pixel: number) => number };
  const lineHeight = theme.fontSize * 1.2;
  const taken: { left: number; right: number; top: number; bottom: number }[] = [];
  const nameMarks: ScatterPoint[] = [];
  for (const point of named) {
    const px = toPixel(point.x);
    const py = yScale.apply(point.y);
    const labelWidth = widest([point.label], theme);
    const centred = Math.max(plotLeft, Math.min(px - labelWidth / 2, plotRight - labelWidth));
    const besideStart = { left: px + offset, middle: py };
    const besideEnd = { left: px - offset - labelWidth, middle: py };
    const sides = px - plotLeft < (plotRight - plotLeft) / 2 ? [besideStart, besideEnd] : [besideEnd, besideStart];
    const candidates = [...sides, { left: centred, middle: py - offset - lineHeight / 2 }, { left: centred, middle: py + offset + lineHeight / 2 }];
    const spot = candidates.map((candidate) => ({ left: candidate.left, right: candidate.left + labelWidth,
      top: candidate.middle - lineHeight / 2, bottom: candidate.middle + lineHeight / 2 })).find((box) =>
      box.left >= plotLeft && box.right <= plotRight && box.top >= plotTop && box.bottom <= plotBottom &&
      taken.every((other) => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top));
    if (!spot) continue;
    taken.push(spot);
    nameMarks.push({ ...point, x: toValue(spot.left), y: yScale.invert((spot.top + spot.bottom) / 2) });
  }
  return plot({
    width,
    height,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    x: { type: "log", domain: [10 ** lowTick, 10 ** highTick], label: null },
    y: { label: null, domain: yScale.domain },
    symbol: { domain: keys.map((entry) => entry.key), range: symbols },
    color: { domain: keys.map((entry) => entry.key), range: colours },
    marks: [
      gridY({ stroke: theme.grid, strokeOpacity: 1, ticks: theme.yTicks }),
      axisY({ ticks: theme.yTicks, tickSize: 0, tickFormat: opts.formatY, color: theme.muted, label: null }),
      // own title: Plot's top-anchored y label sits at the top of the svg, where the legend is
      text([opts.yLabel], { frameAnchor: "top-left", lineAnchor: "bottom", dx: -marginLeft + gap, dy: -theme.fontSize, textAnchor: "start", fill: theme.muted,
        className: "size-axis-title" }),
      axisX({ ticks: xTicks, tickFormat: axisFormat, color: theme.muted, label: opts.xLabel, labelAnchor: "center", labelArrow: "none",
        labelOffset: theme.fontSize * 2.4 }),
      ruleY([0], { stroke: theme.muted }),
      dot(points, { x: "x", y: "y", symbol: "key", fill: "key", stroke: theme.surface, strokeWidth: 0.8,
        r: Math.sqrt(markerArea / Math.PI), className: "size-point" }),
      text(nameMarks, { x: "x", y: "y", text: "label", textAnchor: "start", lineAnchor: "middle", fill: theme.ink,
        stroke: theme.surface, strokeWidth: theme.fontSize * 0.25, paintOrder: "stroke", className: "size-name" }),
      ...legend.marks as never[],
      tip(points, pointer({ x: "x", y: "y", fill: theme.surface, stroke: theme.grid,
        title: (point: ScatterPoint) => `${point.label}\n${formatCount(point.x)} applications\n${opts.formatTip(point.y)} a year` })),
    ],
  }) as SVGElement;
}

export type HeatCell = { year: number; month: number; value: number | null };

export const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => new Date(2000, index, 1).toLocaleString("en", { month: "short" }));

/** Month (rows) x year (columns) grid, colour = value in equal steps between the lowest and highest month, on the theme's
 * own colour scale (`--map-bin-*`); the legend names the lowest and highest value at the ends of the scale. A null month is
 * hatched (never the lowest colour). */
export function heatStripChart(cells: HeatCell[], opts: {
  years: number[]; width?: number; height?: number; noDataLabel: string; valueLabel: string; idPrefix?: string }): SVGElement {
  const theme = readTheme();
  const hatchId = `${opts.idPrefix ?? ""}${HEAT_HATCH_ID}`;
  const hatchFill = `url(#${hatchId})`;
  const width = opts.width ?? FALLBACK_WIDTH;
  const gap = theme.fontSize * 0.6;
  const values = cells.flatMap((entry) => (entry.value === null ? [] : [entry.value]));
  const low = values.length === 0 ? 0 : Math.min(...values); // no value at all: the legend and cells still draw
  const high = values.length === 0 ? 0 : Math.max(...values);
  const colours = theme.bins.length > 0 ? theme.bins : [theme.series[0]];
  const steps = Array.from({ length: colours.length - 1 }, (_, index) => low + ((high - low) * (index + 1)) / colours.length);
  const defined = cells.filter((entry): entry is HeatCell & { value: number } => entry.value !== null);
  const missing = cells.filter((entry) => entry.value === null);
  const marginLeft = widest(MONTH_LABELS, theme) + gap;
  const ramp: LegendItem[] = colours.map((fill, index) => ({
    label: index === 0 ? formatCount(low) : index === colours.length - 1 ? formatCount(high) : "", symbol: "square", fill,
    className: "heat-legend-swatch" }));
  const topPad = theme.fontSize * 0.6;
  const legend = legendMarks([...ramp,
    ...(missing.length > 0 ? [{ label: opts.noDataLabel, symbol: "square", fill: hatchFill, className: "hatch-pct-monthly" }] : [])],
  theme, width, marginLeft, topPad);
  const height = fitHeight(opts.height, theme);
  const labelEvery = Math.max(1, Math.ceil(opts.years.length / Math.max(2, Math.floor(width / theme.xTickGap))));
  const svg = plot({
    width,
    height,
    marginTop: legend.height + topPad,
    marginBottom: theme.fontSize * 2,
    marginLeft,
    marginRight: gap,
    x: { type: "band", domain: opts.years, label: null },
    y: { type: "band", domain: MONTH_LABELS.map((_, index) => index + 1), label: null },
    color: { type: "threshold", domain: steps, range: colours },
    marks: [
      axisX({ tickSize: 0, color: theme.muted, label: null, tickFormat: (year: number) => (opts.years.indexOf(year) % labelEvery === 0 ? String(year) : "") }),
      axisY({ tickSize: 0, color: theme.muted, label: null, tickFormat: (month: number) => MONTH_LABELS[month - 1] }),
      cell(defined, { x: "year", y: "month", fill: "value", inset: 0.5, className: "heat-cell" }),
      cell(missing, { x: "year", y: "month", inset: 0.5, fill: hatchFill, className: "hatch-pct-monthly heat-cell heat-null" }),
      ...legend.marks as never[],
      tip(cells, pointer({ x: "year", y: "month", fill: theme.surface, stroke: theme.grid,
        title: (entry: HeatCell) => `${MONTH_LABELS[entry.month - 1]} ${entry.year}\n${entry.value === null ? opts.noDataLabel : `${formatCount(entry.value)} ${opts.valueLabel}`}` })),
    ],
  }) as SVGElement;
  svg.prepend(hatchDefs(hatchId));
  return svg;
}
