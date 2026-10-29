// Share-shift card "Who gained and lost ground?": each top origin's change in its share of the world's applications
// between two years, as a diverging bar chart (gains right of zero, losses left). Every figure is a pipeline field
// (overview.json `share_shift`): `change_pp` is the difference of the published shares and is displayed, never recomputed.
import { WORLD_SERIES, type CardBuilder, type CardContent } from "./overview";
import type { Overview, ShareShiftRow } from "./data";
import { barChart, barLabelRoom, barValueWidth, readTheme, textWidth, type ChartTheme } from "./charts";
import { fixedHalfAway } from "./format";
import { nullReasonText } from "./groupText";
import { originAbroadNote, seriesBreakNotes, seriesBreaksIn } from "./methods";

export const SHARE_SHIFT_CARD_ID = "share-shift";

const DAGGER = "†";
/** Text widths are measured on a canvas: tabular digits and rounding in the page can differ a little (as in treemap.ts). */
const TEXT_SLACK = 1.04;

/** `+x.xx pp` / `-x.xx pp`; "+" only when the rounded text is non-zero, a zero change has no sign. */
function changeText(change: number, decimals: number): string {
  const text = fixedHalfAway(change, decimals);
  return `${change > 0 && /[1-9]/.test(text) ? "+" : ""}${text} pp`;
}

const daggerOf = (row: ShareShiftRow): string => (row.breaks.length > 0 ? ` ${DAGGER}` : "");
const labelOf = (row: ShareShiftRow): string => `${row.label}${daggerOf(row)}`;

/** A cut name keeps at least this many letters, else the origin's code stands for it (a phone narrower than ~360 px). */
const MIN_NAME_LETTERS = 4;

/** The axis label of `row` in `room` px: the name, cut with an ellipsis if it must be, `suffix` (the dagger) kept; the code when
 * the cut would leave too few letters. The cut is measured with the page font: the chart's own cut uses an estimate that, in a wide
 * fallback font, leaves the label past the plot's left edge. The full name stays in the bar's tooltip and the table. */
function fitLabel(row: ShareShiftRow, room: number, theme: ChartTheme): string {
  const suffix = daggerOf(row);
  const fits = (text: string): boolean => textWidth(text, theme) * TEXT_SLACK <= room;
  if (fits(row.label + suffix)) return row.label + suffix;
  let end = row.label.length;
  while (end > 0 && !fits(`${row.label.slice(0, end).trimEnd()}…${suffix}`)) end -= 1;
  return end >= MIN_NAME_LETTERS ? `${row.label.slice(0, end).trimEnd()}…${suffix}` : row.code + suffix;
}

/** The share-shift card; left out when the data has no `share_shift` (older data), a message in its place for a null reason. */
export function shareShiftCard(overview: Overview): CardBuilder {
  const block = overview.share_shift;
  const decimals = overview.method.rounding.decimals.share;
  if (!block || typeof decimals !== "number") return { id: SHARE_SHIFT_CARD_ID, build: () => null };
  const title = `Who gained and lost ground? Change in share of world applications, ${block.base_year}–${block.year}`;
  const message = block.null_reason ? nullReasonText(block.null_reason, overview) : null;
  return {
    id: SHARE_SHIFT_CARD_ID,
    ...(message ? { problem: { title, message: `Not shown: ${message}.` } } : {}),
    build: (): CardContent | null => {
      const source = overview.sources.origin_apps;
      if (message || !source) return null;
      const plotted = block.rows
        .filter((row): row is ShareShiftRow & { change_pp: number } => row.change_pp !== null)
        .sort((a, b) => b.change_pp - a.change_pp || a.rank - b.rank);
      if (plotted.length === 0) return null;
      const denominator = overview.share_denominator.origin_apps;
      const unplotted = block.rows.filter((row) => row.change_pp === null).map((row) => row.label);
      const scope = { world: true, series: "origin_apps" as const, first: block.base_year, last: block.year };
      const breakNotes = seriesBreakNotes(overview, scope);
      // every share divides by WD, the office world total: only a break in that series runs through the denominator
      const worldBreaks = seriesBreaksIn(overview, { ...scope, series: WORLD_SERIES.world_office });
      return {
        title,
        note: `Percentage points (pp): the origin's share of the ${denominator} in ${block.year} minus its share in ${block.base_year}; ` +
          `the top ${overview.top_n} origins of ${block.year}. Gains lie right of zero, losses left.` +
          (worldBreaks.length > 0
            ? ` Every share's denominator, the ${denominator}, includes ${worldBreaks.map((entry) => `${entry.label}'s series break in ${entry.year}`).join(" and ")}.`
            : ""),
        // colours read at each draw (theme switch); gain = chart colour 1, loss = chart colour 2
        draw: (width, height) => {
          const theme = readTheme();
          const [gain, loss] = theme.series;
          // at least the widest code: a label never goes below that, the plot gives way (the values and labels stay whole)
          const codeRoom = Math.max(...plotted.map((row) => textWidth(row.code + daggerOf(row), theme))) * TEXT_SLACK;
          const room = Math.max(codeRoom, barLabelRoom(width, barValueWidth(plotted.map((row) => changeText(row.change_pp, decimals)), theme),
            plotted.some((row) => row.change_pp < 0), theme));
          // keyed by code (cut names may coincide); the tooltip names the origin whole
          return barChart(plotted.map((row) => ({ label: fitLabel(row, room, theme), value: row.change_pp, key: row.code, title: labelOf(row) })), {
            width, height, labelRoom: room, format: (value) => changeText(value, decimals), fill: (row) => (row.value < 0 ? loss : gain),
          });
        },
        table: {
          headers: ["Origin", `Rank ${block.year}`, `Share ${block.base_year}`, `Share ${block.year}`, "Change (pp)"],
          rows: block.rows.map((row) => [
            labelOf(row), row.rank,
            row.share_base === null ? null : `${fixedHalfAway(row.share_base, decimals)}%`,
            row.share === null ? null : `${fixedHalfAway(row.share, decimals)}%`,
            row.change_pp === null ? null : changeText(row.change_pp, decimals).replace(" pp", ""),
          ]),
          numeric: [false, true, true, true, true],
        },
        footnotes: [
          ...(unplotted.length > 0 ? [`Not plotted, no data ${block.base_year}: ${unplotted.join(", ")}.`] : []),
          ...(block.rows.some((row) => row.breaks.length > 0) ? [`${DAGGER} series break inside the period.`] : []),
          ...breakNotes,
          originAbroadNote(overview),
        ],
        source,
      };
    },
  };
}
