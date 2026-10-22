// SVG charts (Observable Plot). Every visual value comes from the theme at render time: colours
// (--chart-1..4, --ink, --muted, --chart-grid, --chart-highlight, --surface), sizes Plot must know as
// numbers (--chart-height, --chart-bar-step, --chart-font-size, --chart-dot-radius, --chart-ring-radius,
// --chart-x-tick-gap) and plain numbers (--chart-area-opacity, --chart-ring-opacity, --chart-bar-padding,
// --chart-y-ticks). Fonts and stroke widths are set in base.css. Missing values (null) are gaps, never zero.
import { areaY, axisX, axisY, barX, dot, gridY, line, plot, pointerX, ruleX, ruleY, text, tip } from "@observablehq/plot";
import { formatCount } from "./dom";

export type LinePoint = { year: number; value: number | null; key?: string };
export type BarRow = { label: string; value: number };

/** Drawing width when the caller cannot measure its container (e.g. not yet in the page). */
export const FALLBACK_WIDTH = 640;
/** Layout ratio: share of the chart width the bar labels may take before they are cut with an ellipsis. */
const MAX_LABEL_SHARE = 0.42;
/** Only when the theme stylesheet failed to load (no tokens at all): keeps charts drawable and legible. */
const UNTHEMED = { fontSize: 12, areaOpacity: 0.1, ringOpacity: 0.5, barPadding: 0.3, yTicks: 5 };

export type ChartTheme = {
  series: string[];
  ink: string;
  muted: string;
  grid: string;
  highlight: string;
  surface: string;
  fontSize: number;
  fontFamily: string;
  height: number;
  barStep: number;
  dotRadius: number;
  ringRadius: number;
  xTickGap: number;
  areaOpacity: number;
  ringOpacity: number;
  barPadding: number;
  yTicks: number;
  /** `--continent-<id>` of a continent (index = fallback into the chart colours when a theme sets none). */
  continent: (id: string, index: number) => string;
  /** `--map-bin-1..` in order: the sequential colour scale (map and heat strip). */
  bins: string[];
};

function cssValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function cssNumber(styles: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = parseFloat(styles.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/** A length custom property in px, whatever unit the theme wrote it in (px, rem, clamp()). */
export function cssLength(name: string, fallback: number): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`;
  document.body.append(probe);
  const px = probe.getBoundingClientRect().width;
  probe.remove();
  return px > 0 ? px : fallback;
}

/** Upper limit on colour bins read from the theme (`--map-bin-1..`): stops at the first one the theme leaves out. */
const MAX_BINS = 12;

function binColours(styles: CSSStyleDeclaration): string[] {
  const colours: string[] = [];
  for (let bin = 1; bin <= MAX_BINS; bin++) {
    const colour = styles.getPropertyValue(`--map-bin-${bin}`).trim();
    if (!colour) break;
    colours.push(colour);
  }
  return colours;
}

// Fallbacks below are multiples of the font size: they apply only without a theme (see UNTHEMED).
export function readTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  const ink = cssValue(styles, "--ink", "currentColor");
  const muted = cssValue(styles, "--muted", ink);
  const first = cssValue(styles, "--chart-1", ink);
  const fontSize = cssLength("--chart-font-size", parseFloat(styles.fontSize) || UNTHEMED.fontSize);
  const series = ["--chart-1", "--chart-2", "--chart-3", "--chart-4"].map((name) => cssValue(styles, name, first));
  return {
    series,
    ink,
    muted,
    grid: cssValue(styles, "--chart-grid", muted),
    highlight: cssValue(styles, "--chart-highlight", first),
    surface: cssValue(styles, "--surface", "transparent"),
    fontSize,
    fontFamily: cssValue(styles, "--font-data", "sans-serif"),
    height: cssLength("--chart-height", fontSize * 22),
    barStep: cssLength("--chart-bar-step", fontSize * 2),
    dotRadius: cssLength("--chart-dot-radius", fontSize / 3),
    ringRadius: cssLength("--chart-ring-radius", fontSize * 0.75),
    xTickGap: cssLength("--chart-x-tick-gap", fontSize * 6),
    areaOpacity: cssNumber(styles, "--chart-area-opacity", UNTHEMED.areaOpacity),
    ringOpacity: cssNumber(styles, "--chart-ring-opacity", UNTHEMED.ringOpacity),
    barPadding: cssNumber(styles, "--chart-bar-padding", UNTHEMED.barPadding),
    yTicks: cssNumber(styles, "--chart-y-ticks", UNTHEMED.yTicks),
    continent: (id, index) => cssValue(styles, `--continent-${id}`, series[index % series.length]),
    bins: binColours(styles),
  };
}

let measureContext: CanvasRenderingContext2D | null = null;

export function textWidth(value: string, theme: ChartTheme): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return value.length * theme.fontSize * 0.6; // layout ratio: average glyph width, no canvas
  measureContext.font = `${theme.fontSize}px ${theme.fontFamily}`;
  return measureContext.measureText(value).width;
}

export function widest(values: string[], theme: ChartTheme): number {
  return Math.max(0, ...values.map((value) => textWidth(value, theme)));
}

/** Content width of a container (padding excluded), for drawing a chart at its real size so text is
 * shown at the theme's font size. */
export function chartWidth(el: HTMLElement): number {
  const styles = getComputedStyle(el);
  const width = el.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  return width > 0 ? Math.floor(width) : FALLBACK_WIDTH;
}

/** Axis ticks: "1.5M", "250k", "0"; each tick formatted on its own (no shared prefix, so never "0M"). */
export function axisFormat(value: number): string {
  const magnitude = Math.abs(value);
  const [divisor, suffix] = magnitude >= 1e6 ? [1e6, "M"] : magnitude >= 1e3 ? [1e3, "k"] : [1, ""];
  return `${Number((value / divisor).toPrecision(3))}${suffix}`;
}
/** Longest tick labels that format gives for counts; sizes the y-axis margin. */
const WIDEST_TICKS = ["8.8M", "888k"];

type Defined = { year: number; value: number; key: string };

/** Layout ratios (font sizes): shortest chart a fit may squeeze a chart to (room for its axis tick labels); least bar step
 * of a squeezed bar chart; shortest map (no text in the drawing: names and values are in its legend and tooltips). */
const MIN_CHART_HEIGHT_EM = 10;
const MIN_BAR_STEP_EM = 1.0;
const MIN_MAP_HEIGHT_EM = 8;

/** Shortest height (px) a wallboard fit may squeeze a chart to. */
export function minChartHeight(): number {
  return cssLength("--chart-font-size", UNTHEMED.fontSize) * MIN_CHART_HEIGHT_EM;
}

/** Shortest height (px) a wallboard fit may squeeze the map to. */
export function minMapHeight(): number {
  return cssLength("--chart-font-size", UNTHEMED.fontSize) * MIN_MAP_HEIGHT_EM;
}

/** The drawing height: the theme's, or `wanted` (wallboard fit) when given, never below MIN_CHART_HEIGHT_EM. */
export function fitHeight(wanted: number | undefined, theme: ChartTheme): number {
  return wanted === undefined ? theme.height : Math.max(theme.fontSize * MIN_CHART_HEIGHT_EM, Math.min(wanted, theme.height));
}

/** Layout ratio: least distance between two end labels, in font sizes. */
const END_LABEL_GAP = 1.2;

/** Moves the end labels of several lines apart vertically so close values do not overprint (order kept;
 * lines and dots stay put); labels stay above `bottom` (the x axis) where they fit. Plot places each label
 * with transform="translate(x,y)". */
function separateEndLabels(svg: SVGElement, gap: number, bottom: number, expected: number): void {
  const labels = [...svg.querySelectorAll<SVGTextElement>(".chart-end-label text")].flatMap((label) => {
    const match = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(label.getAttribute("transform") ?? "");
    return match ? [{ label, x: Number(match[1]), y: Number(match[2]) }] : [];
  }).sort((a, b) => a.y - b.y);
  // fewer found = Plot changed how it places text: labels may overprint (chart still drawn)
  if (labels.length < expected) console.warn(`lineChart: ${labels.length} of ${expected} end labels found to separate`);
  for (let index = 1; index < labels.length; index++) {
    labels[index].y = Math.max(labels[index].y, labels[index - 1].y + gap);
  }
  const last = labels.at(-1);
  if (last && last.y > bottom) {
    last.y = bottom;
    for (let index = labels.length - 2; index >= 0; index--) {
      labels[index].y = Math.min(labels[index].y, labels[index + 1].y - gap);
    }
  }
  for (const { label, x, y } of labels) label.setAttribute("transform", `translate(${x},${y})`);
}

/** One line per key (order = `opts.keys`, colours --chart-1..4); the newest point of each line is
 * marked and labelled (value for one line, key name for several); `opts.format` = the value text (default: a count), `opts.tick` = the y-axis tick text (default: axisFormat). */
export function lineChart(data: LinePoint[],
  opts: { keys?: string[]; width?: number; height?: number; format?: (value: number) => string; tick?: (value: number) => string } = {}): SVGElement {
  const theme = readTheme();
  const points = data.map((point) => ({ ...point, key: point.key ?? "" }));
  const keys = opts.keys ?? [...new Set(points.map((point) => point.key))];
  const colourOf = (key: string): string => theme.series[Math.max(0, keys.indexOf(key)) % theme.series.length];
  const defined = points.filter((point): point is Defined => point.value !== null);
  const ends = keys.flatMap((key) => {
    const last = defined.filter((point) => point.key === key).at(-1);
    return last ? [last] : [];
  });
  // a defined point whose neighbours (same key, previous and next) are null draws no line: it gets a dot
  const isolated = keys.flatMap((key) => {
    const series = points.filter((point) => point.key === key);
    return series.filter((point, index): point is Defined => point.value !== null && !ends.includes(point as Defined) &&
      (series[index - 1]?.value ?? null) === null && (series[index + 1]?.value ?? null) === null);
  });
  const single = keys.length <= 1;
  const format = opts.format ?? formatCount;
  const endLabel = (point: Defined): string => (single ? format(point.value) : point.key);
  const width = opts.width ?? FALLBACK_WIDTH;
  // Layout ratios (multiples of the font size): gaps and margins scale with the text.
  const gap = theme.fontSize * 0.6;

  const marginBottom = theme.fontSize * 2;
  const height = fitHeight(opts.height, theme);
  const svg = plot({
    width,
    height,
    marginTop: theme.fontSize * 1.2,
    marginBottom,
    marginLeft: widest(WIDEST_TICKS, theme) + gap,
    marginRight: widest(ends.map(endLabel), theme) + gap * 3,
    x: { type: "linear", label: null },
    y: { label: null, zero: true, nice: true },
    marks: [
      // strokeOpacity 1: the grid tone is the theme's --chart-grid colour itself
      gridY({ stroke: theme.grid, strokeOpacity: 1, ticks: theme.yTicks }),
      axisY({ ticks: theme.yTicks, tickSize: 0, tickFormat: opts.tick ?? axisFormat, color: theme.muted, label: null }),
      axisX({
        tickFormat: "d", color: theme.muted, label: null,
        ticks: Math.max(2, Math.floor(width / theme.xTickGap)),
      }),
      // y1/y2, not y: areaY's y stacks, and stacking reads null as 0 (an area where there is no data)
      single ? areaY(points, { x: "year", y1: 0, y2: "value", fill: colourOf(""), fillOpacity: theme.areaOpacity }) : null,
      ruleY([0], { stroke: theme.muted }),
      keys.map((key) => line(points.filter((point) => point.key === key), {
        x: "year", y: "value", stroke: colourOf(key), className: "chart-line",
      })),
      dot(isolated, { x: "year", y: "value", r: theme.dotRadius, fill: single ? theme.highlight : (d: Defined) => colourOf(d.key) }),
      dot(ends, { x: "year", y: "value", r: theme.ringRadius, fill: "none",
        stroke: single ? theme.highlight : (d: Defined) => colourOf(d.key), strokeOpacity: theme.ringOpacity }),
      dot(ends, { x: "year", y: "value", r: theme.dotRadius, fill: single ? theme.highlight : (d: Defined) => colourOf(d.key) }),
      text(ends, {
        x: "year", y: "value", text: endLabel, dx: gap * 1.6, textAnchor: "start",
        fill: theme.ink, className: "chart-end-label",
      }),
      tip(defined, pointerX({
        x: "year", y: "value", fill: theme.surface, stroke: theme.grid,
        title: (d: Defined) => [single ? null : d.key, String(d.year), format(d.value)].filter(Boolean).join("\n"),
      })),
    ],
  }) as SVGElement;
  if (!single) separateEndLabels(svg, theme.fontSize * END_LABEL_GAP, height - marginBottom, ends.length);
  return svg;
}

/** Horizontal bars in the given order (ranked lists), value printed at each bar end. */
export function barChart(rows: BarRow[], opts: { width?: number; height?: number; format?: (value: number) => string } = {}): SVGElement {
  const theme = readTheme();
  const format = opts.format ?? formatCount;
  const width = opts.width ?? FALLBACK_WIDTH;
  const gap = theme.fontSize * 0.5; // layout ratio: label-to-bar gap scales with the text
  const naturalWidth = widest(rows.map((row) => row.label), theme);
  const labelWidth = Math.min(naturalWidth, width * MAX_LABEL_SHARE);
  // Cut only labels past the cap; Plot's own text estimate (lineWidth, in ems) differs from the font.
  const cut = naturalWidth > labelWidth ? { textOverflow: "ellipsis" as const, lineWidth: labelWidth / theme.fontSize } : {};
  const valueWidth = widest(rows.map((row) => format(row.value)), theme) + gap * 2;
  const values = rows.map((row) => row.value);
  const hasNegative = values.some((value) => value < 0);
  // `opts.height` (wallboard fit) squeezes the bar step, never below the text's own height
  const barStep = opts.height === undefined ? theme.barStep
    : Math.min(theme.barStep, Math.max(theme.fontSize * MIN_BAR_STEP_EM, opts.height / Math.max(1, rows.length)));

  return plot({
    width,
    height: Math.max(1, rows.length) * barStep,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: labelWidth + gap + (hasNegative ? valueWidth : 0),
    marginRight: valueWidth,
    x: { axis: null, domain: [Math.min(0, ...values), Math.max(0, ...values)] },
    y: { domain: rows.map((row) => row.label), label: null, padding: theme.barPadding },
    marks: [
      axisY({
        tickSize: 0, tickPadding: gap + (hasNegative ? valueWidth : 0), color: theme.ink, label: null,
        ...cut,
      }),
      barX(rows, {
        x: "value", y: "label", fill: theme.series[0],
        title: (row: BarRow) => `${row.label}: ${format(row.value)}`,
      }),
      ruleX([0], { stroke: theme.muted }),
      text(rows.filter((row) => row.value >= 0), {
        x: "value", y: "label", text: (row: BarRow) => format(row.value), dx: gap, textAnchor: "start", fill: theme.ink,
      }),
      text(rows.filter((row) => row.value < 0), {
        x: "value", y: "label", text: (row: BarRow) => format(row.value), dx: -gap, textAnchor: "end", fill: theme.ink,
      }),
    ],
  }) as SVGElement;
}

