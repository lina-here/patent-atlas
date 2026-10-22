import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Series-break route patches (audit F1), shared by the entity, overview, region and methods specs. Committed data gain
// `series_breaks` / `yoy_null_reason` only at the next refresh (Task 3b), so every test patches them in or strips them:
// no assertion rests on committed data. The break is China's (code, label and groups from the data files); note,
// citation and page are fixture text.
type Json = Record<string, any>;

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const entities: { code: string; label: string }[] = readJson("site/data/entities.json");
const groupItems: { id: string; kind: string; members: string[] }[] = readJson("site/data/groups.json").items;

export const BREAK_CODE = "CN";

export type FixtureBreak = {
  code: string; label: string; year: number; series: string[]; note: string; citation: string; url: string; page: string;
  groups: string[];
};

/** China's break in `year`: office and origin series, groups = its region and continent (groups.json). */
export function fixtureBreak(year = 2017): FixtureBreak {
  const groupOf = (kind: string): string => {
    const found = groupItems.find((item) => item.kind === kind && item.members.includes(BREAK_CODE));
    if (!found) throw new Error(`no ${kind} lists ${BREAK_CODE}`);
    return found.id;
  };
  return {
    code: BREAK_CODE,
    label: entities.find((entity) => entity.code === BREAK_CODE)?.label ?? BREAK_CODE,
    year,
    series: ["office_apps", "origin_apps"],
    note: "fixture summary: data before the break year are not comparable with later years",
    citation: "Fixture Author (2025). Fixture Indicators 2025. Geneva: Fixture Press",
    url: "https://www.wipo.int/edocs/pubdocs/en/fixture-break.pdf",
    page: "fixture figure note, p. 9",
    groups: [groupOf("region"), groupOf("continent")],
  };
}

/** Footnote a chart of the break's own country shows (site/src/methods.ts seriesBreakNotes, entity scope). */
export function entityBreakNote(entry: FixtureBreak): string {
  return `Series break ${entry.year}: ${entry.note} (summarised from WIPO, ${entry.citation.split(".")[0]}, ${entry.page}). ` +
    `Growth from ${entry.year - 1} to ${entry.year} is not computed.`;
}

/** Footnote a world or group chart that includes the break's country shows. */
export function includesBreakNote(entry: FixtureBreak): string {
  return `Includes ${entry.label}: Series break ${entry.year}: ${entry.note} (summarised from WIPO, ` +
    `${entry.citation.split(".")[0]}, ${entry.page}).`;
}

/** overview.json with `series_breaks` = `breaks`, or without the field (`null`: data written before Task 3b); entity
 * files with the matching yoy nulled and `yoy_null_reason` set, or the field stripped. */
export async function routeSeriesBreaks(page: Page, breaks: FixtureBreak[] | null): Promise<void> {
  await page.route("**/data/overview.json", async (route) => {
    const overview: Json = await (await route.fetch()).json();
    delete overview.series_breaks;
    await route.fulfill({ json: breaks ? { ...overview, series_breaks: breaks } : overview });
  });
  await page.route("**/data/entity/*.json", async (route) => {
    const file: Json = await (await route.fetch()).json();
    for (const [series, block] of Object.entries<Json>(file.series ?? {})) {
      if (!breaks) {
        delete block.derived.yoy_null_reason;
        continue;
      }
      block.derived.yoy_null_reason = {};  // as the pipeline writes it: {} when the series has no break
      for (const entry of breaks) {
        if (entry.code !== file.code || !entry.series.includes(series)) continue;
        block.derived.yoy[String(entry.year)] = null;
        block.derived.yoy_null_reason[String(entry.year)] = "series_break";
      }
    }
    await route.fulfill({ json: file });
  });
}
