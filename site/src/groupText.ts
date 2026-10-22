// Wording on WIPO's regional totals, per series: one source for the methods page and the region/continent pages, so the
// two cannot drift (final review I1). WIPO's regional totals differ by series (data note §2): filing-office totals add
// regional offices and estimates for offices that did not report; PCT origin totals hold the member countries plus the
// cross-check's extra codes (overview `method.group_crosscheck_assignment`), Europe also a few origins WIPO does not list.
import type { GroupNullReason } from "./atlas";
import type { Overview, SeriesId } from "./data";

/** Groups whose WIPO PCT origin total also counts origins WIPO lists as no country (data note §2: R3). */
export const PCT_UNLISTED_ORIGIN_GROUPS: readonly string[] = ["europe"];

/** What a series' WIPO regional total counts, as a clause starting "counts". `added` = labelled extra codes counted in the
 * total; `unlisted` = labels of the groups whose total also counts unlisted origins (PCT only). */
export function wipoTotalCounts(series: SeriesId, added: string[], unlisted: string[]): string {
  if (series === "office_apps") return "counts regional offices and WIPO's estimates for offices that did not report";
  return "counts the member countries" + (added.length ? ` plus ${added.join(", ")}` : "") +
    (unlisted.length ? `; ${unlisted.join(", ")} also counts a few origins WIPO does not list` : "");
}

/** Why a series' WIPO regional total can differ from the cross-check sum. `countsUnlisted` = the group (or, on the methods
 * page, some group) also counts unlisted origins. */
export function wipoTotalGapCause(series: SeriesId, countsUnlisted: boolean): string {
  if (series === "office_apps") return "WIPO's total adds estimates for offices that do not report";
  return countsUnlisted
    ? "WIPO's total also counts a few origins it does not list as countries"
    : "WIPO's total counts the same countries and codes";
}

/** A group null year's reason, in words (pipeline/groups.py keys; the region page uses the same text). */
export function nullReasonText(reason: GroupNullReason, overview: Overview): string {
  switch (reason) {
    case "no_wipo_regional_total": return "no WIPO regional total";
    case "no_wipo_world_total": return "no complete WIPO world total for this year";
    case "none_reported": return "no member country reported";
    case "attribution_floor": return `below the attribution floor: the countries that belong to a group account for less than ` +
      `${Math.round(overview.method.group_attribution_min * 100)}% of the series' world total this year`;
  }
}
