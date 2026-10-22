// Wording and number format of the women-inventor figures: one source for every card that shows them (page, embed, country
// and region cards). Constants (coverage floor, decimals) and WIPO's method note come from overview `method.gender`;
// nothing numeric is typed here. Everything is by PUBLICATION year (WIPO's basis).
import type { GenderMeasure, GenderNullReason, Overview } from "./data";
import { fixedHalfAway } from "./format";
import { nullReasonText } from "./groupText";
import type { GroupNullReason } from "./atlas";

/** Chart ids and titles. The two measures are named apart and never share an axis (spec Women inventors). */
export const GENDER_TITLES: Record<GenderMeasure | "women_any_by_field", string> = {
  women_any: "PCT applications with at least one woman inventor",
  women_share: "Women's share of PCT inventors",
  women_any_by_field: "Applications with at least one woman inventor, by technology field (world)",
};

/** Basis of a shown value: WIPO's published figure, or ours (exact wording; pipeline/write.py GROUP_COMPUTED_LABEL). */
export const GENDER_BASIS_LABEL = { wipo: "WIPO", computed: "computed from WIPO shares weighted by PCT publications" } as const;

/** Ranking cell of a country-year WIPO does not publish (the reason's long form, `genderNullText`, is in the note). */
export const NOT_PUBLISHED_SHORT = "not published by WIPO";

/** The coverage floor (overview `method.gender.group_coverage_min`) as "65%"; null when the data carry none. One text for every card. */
export function coverageFloorText(overview: Overview): string | null {
  const min = overview.method.gender?.group_coverage_min;
  return min === undefined ? null : `${fixedHalfAway(min * 100, 0)}%`;
}

/** "without PCT publications data: Guernsey (GG) (45 members in all)" for the members outside m of "n of m" (names already
 * labelled "Label (CODE)"); "" with none. One text for the cards, the map and the methods page. */
export function unlistedMembersText(names: string[], total: number): string {
  return names.length === 0 ? "" : `without PCT publications data: ${names.join(", ")} (${total} members in all)`;
}

/** Why a gender value is missing, in words. Group floor reasons (no member reported, ...) read as on the map. */
export function genderNullText(reason: GenderNullReason, overview: Overview): string {
  switch (reason) {
    case "not_published": return "not published by WIPO for this year";
    case "low_coverage": {
      return `members with a published share hold under ${coverageFloorText(overview) ?? "the floor"} of the group's PCT publications`;
    }
    case "not_computable": return "not computable (WIPO publishes no inventor counts)";
    default: return nullReasonText(reason as GroupNullReason, overview);
  }
}

/** The method caveat every women card carries (spec Women inventors), as footnote lines: what the shares are, then WIPO's
 * method note (citation, page and link). */
export function genderCaveat(overview: Overview): string[] {
  const note = overview.method.gender?.method_note;
  return [
    "Gender is attributed by WIPO (method: WIPO's methodology page). Shares are by publication year and describe PCT applications, " +
      "not all patents. The PCT Yearly Review 2026 does not state the denominator (all applications or only those with " +
      "attributed inventors); WIPO's methodology pages are not checked here.",
    note ? `WIPO's method note: ${note.citation}, ${note.page}. ${note.url}` : "WIPO's method note: not recorded.",
  ];
}

/** Decimals of a shown share: overview `method.gender.decimals`. */
export function genderDecimals(overview: Overview): number {
  return overview.method.gender?.decimals ?? DEFAULT_DECIMALS;
}

const DEFAULT_DECIMALS = 1;

/** "38.1%" (one decimal; callers pass `genderDecimals(overview)`), half away from zero; "–" for no figure (never 0). */
export function formatShare(value: number | null, decimals = DEFAULT_DECIMALS): string {
  return value === null ? "–" : `${fixedHalfAway(value, decimals)}%`;
}
