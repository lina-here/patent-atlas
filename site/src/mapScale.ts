// Map colour scale from config.json `map` (bins of powers of `logBase`; ratios: `map.ratio`; shares: linear, `map.share`), checked against the colours the themes and
// base.css define (one `--map-bin-N` token and one `[data-bin="N"]` rule per bin up to MAX_MAP_BINS). No imports
// beyond a type: the e2e tests read MAX_MAP_BINS from here, so the limit lives in one place.
import type { Config, GenderMeasure } from "./data";

/** Bins with a fill rule in base.css and a token in every theme (tests/e2e/map.spec.ts keeps the three in step). */
export const MAX_MAP_BINS = 7;
export const DEFAULT_MAP_SCALE = { logBase: 10, bins: MAX_MAP_BINS };

/** The scale to draw: config values, each replaced by its default when invalid (whole `bins` 1..MAX_MAP_BINS,
 * whole `logBase` of at least 2 so bin labels stay whole numbers); a notice per replaced value. */
export function mapScale(map: Config["map"] | undefined): { scale: { logBase: number; bins: number }; notices: string[] } {
  const notices: string[] = [];
  const { logBase, bins } = map ?? ({} as Partial<Config["map"]>);
  const validBins = Number.isInteger(bins) && (bins as number) >= 1 && (bins as number) <= MAX_MAP_BINS;
  if (!validBins) {
    notices.push(`Invalid map.bins in config.json: ${String(bins)} (a whole number from 1 to ${MAX_MAP_BINS}): using ${DEFAULT_MAP_SCALE.bins}`);
  }
  const validBase = Number.isInteger(logBase) && (logBase as number) >= 2;
  if (!validBase) {
    notices.push(`Invalid map.logBase in config.json: ${String(logBase)} (a whole number, at least 2): using ${DEFAULT_MAP_SCALE.logBase}`);
  }
  return {
    scale: { logBase: validBase ? logBase as number : DEFAULT_MAP_SCALE.logBase, bins: validBins ? bins as number : DEFAULT_MAP_SCALE.bins },
    notices,
  };
}

/** Scale of the ratio metrics (config `map.ratio`): bin k ends at `lowest` × `logBase` ** k. */
export type RatioScale = { logBase: number; bins: number; lowest: number };
export const DEFAULT_RATIO_SCALE: RatioScale = { logBase: 10, bins: 5, lowest: 0.1 };

/** The ratio scale to draw: config `map.ratio` values, each replaced by its default when invalid (whole `bins`
 * 1..MAX_MAP_BINS, whole `logBase` of at least 2, `lowest` a positive finite number); a notice per replaced value.
 * An absent `map.ratio` is the default scale, without a notice (optional key). */
export function ratioScale(map: Config["map"] | undefined): { scale: RatioScale; notices: string[] } {
  const ratio = map?.ratio;
  if (ratio === undefined) return { scale: { ...DEFAULT_RATIO_SCALE }, notices: [] };
  const notices: string[] = [];
  const { logBase, bins, lowest } = (ratio ?? {}) as Partial<RatioScale>;
  const validBins = Number.isInteger(bins) && (bins as number) >= 1 && (bins as number) <= MAX_MAP_BINS;
  if (!validBins) {
    notices.push(`Invalid map.ratio.bins in config.json: ${String(bins)} (a whole number from 1 to ${MAX_MAP_BINS}): using ${DEFAULT_RATIO_SCALE.bins}`);
  }
  const validBase = Number.isInteger(logBase) && (logBase as number) >= 2;
  if (!validBase) {
    notices.push(`Invalid map.ratio.logBase in config.json: ${String(logBase)} (a whole number, at least 2): using ${DEFAULT_RATIO_SCALE.logBase}`);
  }
  const validLowest = typeof lowest === "number" && Number.isFinite(lowest) && lowest > 0;
  if (!validLowest) {
    notices.push(`Invalid map.ratio.lowest in config.json: ${String(lowest)} (a positive number): using ${DEFAULT_RATIO_SCALE.lowest}`);
  }
  return {
    scale: {
      logBase: validBase ? logBase as number : DEFAULT_RATIO_SCALE.logBase,
      bins: validBins ? bins as number : DEFAULT_RATIO_SCALE.bins,
      lowest: validLowest ? lowest as number : DEFAULT_RATIO_SCALE.lowest,
    },
    notices,
  };
}

/** Upper bound of ratio bin `k` (1-based): `lowest` × `logBase` ** k, binary product noise stripped. */
function ratioBound(k: number, scale: RatioScale): number {
  return Number((scale.lowest * scale.logBase ** k).toPrecision(12));
}

/** Bin of a ratio value: "null" (no data), "zero" (WIPO 0.0 or computed 0.0), else 1..`bins`: bin 1 = above 0 and below
 * bound 1, bin k = from bound k-1 up to (not including) bound k, the last open-ended. */
export function ratioBinOf(value: number | null, scale: RatioScale): string {
  if (value === null) return "null";
  if (value <= 0) return "zero";
  let bin = 1;
  while (bin < scale.bins && value >= ratioBound(bin, scale)) bin += 1;
  return String(bin);
}

function boundText(bound: number): string {
  return bound.toLocaleString("en-US", { maximumFractionDigits: 12 });
}

/** Range of ratio bin `bin` (1-based), half-open: "under 1", "1 to under 10", last "1,000 or more". */
export function ratioBinLabel(bin: number, scale: RatioScale): string {
  if (scale.bins === 1) return "above 0";
  if (bin === 1) return `under ${boundText(ratioBound(1, scale))}`;
  if (bin === scale.bins) return `${boundText(ratioBound(bin - 1, scale))} or more`;
  return `${boundText(ratioBound(bin - 1, scale))} to under ${boundText(ratioBound(bin, scale))}`;
}

/** Scale of a women-inventor share metric (config `map.share.<measure>`): linear percent bins, bin k = [(k-1) x `step`,
 * k x `step`), the last open-ended. 0.0 is a real share (bin 1): no zero state. */
export type ShareScale = { step: number; bins: number };
export const DEFAULT_SHARE_SCALE: Record<GenderMeasure, ShareScale> = {
  women_any: { step: 10, bins: 6 },
  women_share: { step: 5, bins: 6 },
};

/** The share scale of `measure` to draw: config `map.share.<measure>` values, each replaced by its default when invalid
 * (whole `bins` 1..MAX_MAP_BINS, `step` a positive finite number); a notice per replaced value. An absent `map.share` is the
 * default scale, without a notice (optional key); a present one missing the measure is invalid. */
export function shareScale(map: Config["map"] | undefined, measure: GenderMeasure): { scale: ShareScale; notices: string[] } {
  const fallback = DEFAULT_SHARE_SCALE[measure];
  if (map?.share === undefined) return { scale: { ...fallback }, notices: [] };
  const notices: string[] = [];
  const { step, bins } = (map.share?.[measure] ?? {}) as Partial<ShareScale>;
  const validStep = typeof step === "number" && Number.isFinite(step) && step > 0;
  if (!validStep) notices.push(`Invalid map.share.${measure}.step in config.json: ${String(step)} (a positive number): using ${fallback.step}`);
  const validBins = Number.isInteger(bins) && (bins as number) >= 1 && (bins as number) <= MAX_MAP_BINS;
  if (!validBins) {
    notices.push(`Invalid map.share.${measure}.bins in config.json: ${String(bins)} (a whole number from 1 to ${MAX_MAP_BINS}): using ${fallback.bins}`);
  }
  return { scale: { step: validStep ? step as number : fallback.step, bins: validBins ? bins as number : fallback.bins }, notices };
}

/** Upper bound of share bin `k` (1-based): k x `step`, binary product noise stripped (3 x 0.1). */
function shareBound(k: number, scale: ShareScale): number {
  return Number((scale.step * k).toPrecision(12));
}

/** Bin of a share: "null" (no figure), else "1".."bins": bin 1 = under the first bound (0.0 included), bin k = from bound
 * k-1 up to (not including) bound k, the last open-ended. */
export function shareBinOf(value: number | null, scale: ShareScale): string {
  if (value === null) return "null";
  let bin = 1;
  while (bin < scale.bins && value >= shareBound(bin, scale)) bin += 1;
  return String(bin);
}

/** Range of share bin `bin` (1-based), half-open: "under 10%", "10% to under 20%", last "50% or more". */
export function shareBinLabel(bin: number, scale: ShareScale): string {
  if (scale.bins === 1) return "0% or more";
  if (bin === 1) return `under ${boundText(shareBound(1, scale))}%`;
  if (bin === scale.bins) return `${boundText(shareBound(bin - 1, scale))}% or more`;
  return `${boundText(shareBound(bin - 1, scale))}% to under ${boundText(shareBound(bin, scale))}%`;
}
