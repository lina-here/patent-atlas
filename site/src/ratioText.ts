// Wording and number format of the scale ratios (per million population, per $100bn GDP, PCT per million): one source
// for every card that shows them. Thresholds and decimals come from
// overview `method.ratios`, WDI names and dates from the manifest; nothing is typed here. PCT per million borrows WIPO's
// per-million population threshold: its text never calls it WIPO's threshold (WIPO publishes no PCT ratio; M3).
import type { Manifest, Overview, RatioDenominator, RatioId, RatioNullReason, WipoRatioId } from "./data";
import { fixedHalfAway } from "./format";
import { nullReasonText } from "./groupText";

export const RATIO_TITLES: Record<RatioId, string> = {
  per_million: "Resident patent applications per million population",
  per_gdp: "Resident patent applications per $100 billion GDP (PPP)",
  pct_per_million: "PCT applications per million population",
};

/** Lower-case names for running text and table headers. */
export const RATIO_SHORT: Record<RatioId, string> = {
  per_million: "per million population",
  per_gdp: "per $100 billion GDP (PPP)",
  pct_per_million: "PCT per million population",
};

/** Basis of a shown value: WIPO's published figure, or ours (spec Measures: exact wording). */
export const RATIO_BASIS_LABEL = { wipo: "WIPO", computed: "computed from WIPO counts and World Bank WDI" } as const;

const NOT_RECORDED = "not recorded";
const DENOMINATOR_WORDS: Record<RatioDenominator, string> = { population: "population", gdp_ppp: "GDP PPP USD" };
const MAGNITUDES: [number, string][] = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]];

/** 1000000 -> "1 million", 10000000000 -> "10 billion"; below a million: the digits with separators. */
export function amountWords(value: number): string {
  for (const [size, word] of MAGNITUDES) if (value >= size) return `${value / size} ${word}`;
  return value.toLocaleString("en-US");
}

/** 1 -> "one decimal", 2 -> "2 decimals". */
export function decimalsWords(count: number): string {
  return count === 1 ? "one decimal" : `${count} decimals`;
}

/** Below precision (pipeline/scale.py BELOW_PRECISION): a computed value under half the last shown decimal, from a count
 * above 0, in words ("under 0.05 at one decimal"); "not recorded" without method data. */
export function belowPrecisionWords(overview: Overview): string {
  const decimals = overview.method.ratios?.decimals;
  if (decimals === undefined) return NOT_RECORDED;
  return `under ${(0.5 * 10 ** -decimals).toFixed(decimals + 1)} at ${decimalsWords(decimals)}`;
}

/** WIPO's threshold of the ratio's denominator in words ("population 1 million"); "not recorded" without method data. */
export function thresholdWords(ratioId: RatioId, overview: Overview): string {
  const method = overview.method.ratios;
  if (!method) return NOT_RECORDED;
  const denominator = method.denominator[ratioId];
  return `${DENOMINATOR_WORDS[denominator]} ${amountWords(method.wipo_threshold[denominator])}`;
}

/** Ratios with a tile year (overview `ratio_last_year`), in `method.ratios.ratio_ids` order; none in data before v0.2b. */
export function shownRatios(overview: Overview): { id: RatioId; year: number }[] {
  const ids = overview.method.ratios?.ratio_ids ?? [];
  return ids.flatMap((id) => {
    const year = overview.ratio_last_year?.[id];
    return year === undefined ? [] : [{ id, year }];
  });
}

/** Whether WIPO publishes the ratio (its values shown as published); the others are always computed. */
export function isWipoRatio(id: RatioId, overview: Overview): id is WipoRatioId {
  return (overview.method.ratios?.wipo_ratio_ids as RatioId[] | undefined)?.includes(id) ?? false;
}

/** The card note's World sentence: which World figures are WIPO's and which are computed. */
export function worldBasisText(ids: RatioId[], overview: Overview): string {
  const wipo = ids.filter((id) => isWipoRatio(id, overview)).map((id) => RATIO_SHORT[id]);
  const computed = ids.filter((id) => !isWipoRatio(id, overview)).map((id) => RATIO_SHORT[id]);
  return [wipo.length ? `WIPO's own world figure (${wipo.join("; ")})` : "",
    computed.length ? `${computed.join("; ")} ${RATIO_BASIS_LABEL.computed}` : ""].filter(Boolean).join("; ");
}

/** Why a ratio year has no value, in words. `subject` "group": below_wipo_threshold concerns the reporting members' summed
 * denominator; group keys reuse the group totals' text (map `nullReasonText`). */
export function ratioNullText(reason: RatioNullReason, ratioId: RatioId, overview: Overview, subject: "country" | "group" = "country"): string {
  switch (reason) {
    case "below_wipo_threshold": {
      const threshold = thresholdWords(ratioId, overview);
      const pct = ratioId === "pct_per_million";
      if (subject === "group") {
        return pct
          ? `reporting members' total is at or below the population threshold WIPO uses for its per-million figures (${threshold})`
          : `reporting members' total is at or below WIPO's threshold (${threshold})`;
      }
      return pct
        ? `below the population threshold WIPO uses for its per-million figures (${threshold} or less)`
        : `below WIPO's threshold (${threshold} or less)`;
    }
    case "no_population": return "no population data (World Bank WDI)";
    case "no_gdp": return "no GDP data (World Bank WDI)";
    case "no_applications": return "no applications reported by WIPO for this year";
    case "below_precision": // WIPO leaves these empty only in its own country ratios; PCT and group figures are ours alone
      return subject === "country" && ratioId !== "pct_per_million"
        ? `${belowPrecisionWords(overview)}; WIPO publishes no figure` : belowPrecisionWords(overview);
    default: return nullReasonText(reason, overview);
  }
}

/** A ratio value to `decimals` places, half away from zero, thousands grouped as counts are ("1,234.5"); null -> "–".
 * Groups the rounded string's integer part: no second rounding. */
export function formatRatio(value: number | null, decimals: number): string {
  if (value === null) return "–";
  const [integer, fraction] = fixedHalfAway(value, decimals).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** WDI's last-updated date(s): one date when population and GDP agree, else each named. */
function wdiUpdated(manifest: Manifest): string {
  const population = manifest.wdi_denominators?.population.last_updated ?? NOT_RECORDED;
  const gdp = manifest.wdi_denominators?.gdp_ppp.last_updated ?? NOT_RECORDED;
  return population === gdp ? population : `${population} (population), ${gdp} (GDP)`;
}

/** Credit line of every card using WDI population or GDP. */
export function wdiCredit(manifest: Manifest): string {
  const wdi = manifest.wdi_denominators;
  return `Population and GDP: World Bank WDI (CC BY 4.0), ${wdi?.population.name ?? "population"}, ` +
    `${wdi?.gdp_ppp.name ?? "GDP PPP"}; retrieved ${manifest.retrieved}, WDI last updated ${wdiUpdated(manifest)}`;
}

/** GDP label (plan Global Constraints): base year from WDI's indicator name (manifest `gdp_base`), never WIPO's label. */
export function gdpBasisLabel(manifest: Manifest): string {
  const gdp = manifest.wdi_denominators?.gdp_ppp;
  return `GDP PPP, constant ${gdp?.gdp_base ?? NOT_RECORDED} international $ (World Bank WDI, retrieved ${manifest.retrieved}, ` +
    `WDI last updated ${gdp?.last_updated ?? NOT_RECORDED})`;
}
