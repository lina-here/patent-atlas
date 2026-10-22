import { test, expect, type Locator, type Page } from "./fixtures";
import { openNotes } from "./notes";
import { existsSync, readFileSync } from "node:fs";
import { BREAK_CODE, fixtureBreak, includesBreakNote, routeSeriesBreaks } from "./seriesBreaks";

// Region and continent pages (`?region=`, `?continent=`), the country page's region comparison and the picker's group
// matches. Expected figures, labels and years are read from the data files (none typed here).
type YearMap = Record<string, number | null>;
type GroupSeries = {
  basis: string; total: YearMap; reporting: Record<string, number>; members: number; null_reason: Record<string, string>;
  member_sum?: YearMap; panel?: { first: number | null; last: number | null; members: string[]; total: YearMap };
};
type GroupFile = { id: string; label: string; kind: string; series: Record<string, GroupSeries>;
  former_notes: { former: string; members: string[]; until: number }[] };
type GroupItem = { id: string; kind: string; label: string; continent: string; members: string[] };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const overview = readJson("site/data/overview.json");
const entities: { code: string; label: string; kind: string }[] = readJson("site/data/entities.json");
const groups: GroupItem[] = readJson("site/data/groups.json").items;
const groupFile = (id: string): GroupFile => readJson(`site/data/group/${id}.json`);
const mapValues = (series: string): Record<string, YearMap> => readJson(`site/data/map/${series}.json`).values;
const entityFile = (code: string) => readJson(`site/data/entity/${code}.json`);
const LABELS = new Map(entities.map((entity) => [entity.code, entity.label]));
const count = (value: number): string => value.toLocaleString("en-US");
const card = (page: Page, id: string): Locator => page.locator(`.chart-card[data-chart="${id}"]`);
const lastYear = (years: Record<string, unknown>): string => Object.keys(years).sort().at(-1) as string;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function showFigures(target: Locator): Promise<Locator> {
  await target.getByRole("button", { name: "Show figures", exact: true }).click();
  return target.locator(".chart-figures table").first().locator("tbody tr");
}

/** Region of a country (kind region, member list), from groups.json. */
const regionOf = (code: string): GroupItem => groups.find((group) => group.kind === "region" && group.members.includes(code)) as GroupItem;
const hasOrigin = (code: string): boolean => existsSync(`site/data/entity/${code}.json`) && Boolean(entityFile(code).series.origin_apps);
/** Another member of `code`'s region with an origin series. */
const partnerOf = (code: string): string => regionOf(code).members.find((member) => member !== code && hasOrigin(member)) as string;

/** Serves the region file of `code` with its origin panel set by the test: `members` over `code`'s years with origin
 * applications, total = the members' sum. No assertion rests on the panel the data has. */
async function patchPanel(page: Page, code: string, members: string[]): Promise<{ first: number; last: number }> {
  const region = regionOf(code);
  const totals = (member: string): YearMap => entityFile(member).series.origin_apps.types.total;
  const years = Object.entries(totals(code)).filter(([, value]) => (value ?? 0) > 0).map(([year]) => Number(year));
  const first = Math.min(...years);
  const last = Math.max(...years);
  const total: YearMap = {};
  for (let year = first; year <= last; year += 1) {
    total[String(year)] = members.reduce((sum, member) => sum + (totals(member)[String(year)] ?? 0), 0);
  }
  await page.route(`**/data/group/${region.id}.json`, async (route) => {
    const file = groupFile(region.id);
    file.series.origin_apps.panel = { first, last, members, total };
    await route.fulfill({ json: file });
  });
  return { first, last };
}

test("?region=030 lists Eastern Asia's members incl. CN; totals with coverage and null reasons per year", async ({ page }) => {
  const errors = trackErrors(page);
  const group = groups.find((item) => item.id === "030") as GroupItem;
  const file = groupFile("030");
  await page.goto("/?region=030");
  await expect(page.locator("h1")).toHaveText(group.label);
  const members = card(page, "group-members");
  await expect(members.locator(".chart-figure table tbody tr")).toHaveCount(group.members.length);
  const china = members.locator(".chart-figure").getByRole("link", { name: LABELS.get("CN"), exact: true });
  await expect(china).toHaveAttribute("href", /\?country=CN(&|$)/);
  const origin = file.series.origin_apps;
  const year = lastYear(origin.total);
  const chinaValue = mapValues("origin_apps").CN[year] as number;
  const chinaRow = members.locator(".chart-figure tbody tr").filter({ has: page.locator("td:nth-child(2)", { hasText: /^CN$/ }) });
  await expect(chinaRow).toContainText(count(chinaValue));
  // every year of the group file is a row: total or its null reason, and "n of m" members reporting
  const rows = await showFigures(card(page, "origin-apps"));
  await expect(rows).toHaveCount(Object.keys(origin.total).length);
  const latest = rows.first();
  await expect(latest.locator("td").first()).toHaveText(year);
  await expect(latest.locator("td").nth(1)).toHaveText(count(origin.total[year] as number));
  await expect(latest.locator("td").nth(2)).toHaveText(`${origin.reporting[year]} of ${origin.members}`);
  const nullYear = Object.keys(origin.null_reason).sort()[0];
  const nullRow = rows.filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${nullYear}$`) }) });
  await expect(nullRow.locator("td").nth(1)).toHaveText("–");
  const reasonText: Record<string, string> = {
    no_wipo_regional_total: "no WIPO regional total", no_wipo_world_total: "no complete WIPO world total for this year",
    none_reported: "no member country reported", attribution_floor: "below the attribution floor",
  };
  expect(reasonText[origin.null_reason[nullYear]], `reason key ${origin.null_reason[nullYear]}`).toBeTruthy();
  await expect(nullRow.locator("td").last()).toContainText(reasonText[origin.null_reason[nullYear]]);
  expect(errors).toEqual([]);
});

test("region page map: zoomed to the members (CN inside the frame, BR outside)", async ({ page }) => {
  await page.goto("/?region=030");
  const svg = card(page, "world-map").locator("svg.map-svg");
  await expect(svg).toBeVisible();
  const inFrame = async (code: string): Promise<boolean> => svg.evaluate((element, wanted) => {
    const frame = (element as SVGSVGElement).viewBox.baseVal;
    const shape = element.querySelector<SVGGraphicsElement>(`[data-code="${wanted}"]`);
    if (!shape) return false;
    const box = shape.getBBox();
    return box.x < frame.x + frame.width && box.x + box.width > frame.x && box.y < frame.y + frame.height && box.y + box.height > frame.y;
  }, code);
  expect(await inFrame("CN")).toBe(true);
  expect(await inFrame("BR")).toBe(false);
  await expect(card(page, "world-map").locator(".chart-note")).toContainText("Eastern Asia");
});

test("a region with a former entity names it (Soviet Union, Eastern Europe)", async ({ page }) => {
  const id = groups.find((group) => group.kind === "region" &&
    groupFile(group.id).former_notes.some((note) => note.former === "SU"))?.id as string;
  await page.goto(`/?region=${id}`);
  await openNotes(card(page, "origin-apps"));
  await expect(card(page, "origin-apps").locator(".chart-footnote", { hasText: LABELS.get("SU") as string })).toBeVisible();
});

test("member sum names a former entity's figure it leaves out in that year (fixture: SU reports 2000 for RU)", async ({ page }) => {
  const id = regionOf("RU").id;
  const year = lastYear(groupFile(id).series.origin_apps.total);
  await page.route("**/data/map/origin_apps.json", async (route) => {
    const file = readJson("site/data/map/origin_apps.json");
    file.values.RU[year] = null;
    file.values.SU[year] = 1234;
    await route.fulfill({ json: file });
  });
  await page.route("**/data/groups.json", async (route) => {
    const file = readJson("site/data/groups.json");
    const covered = file.successors.SU.find((successor: { code: string }) => successor.code === "RU");
    covered.to_year = Number(year);
    await route.fulfill({ json: file });
  });
  await page.goto(`/?region=${id}`);
  const rows = await showFigures(card(page, "origin-apps"));
  await expect(rows.first()).toContainText(`Excludes figures reported under ${LABELS.get("SU")} (${count(1234)})`);
});

test("?continent=europe: basis per series, cross-check note, and the true 'n of m' (members WIPO lists)", async ({ page }) => {
  const errors = trackErrors(page);
  const group = groups.find((item) => item.id === "europe") as GroupItem;
  const file = groupFile("europe");
  await page.goto("/?continent=europe");
  await expect(page.locator("h1")).toHaveText(group.label);
  await expect(card(page, "pct-origin").locator(".chart-note")).toContainText("WIPO's own regional total");
  await expect(card(page, "origin-apps").locator(".chart-note")).toContainText("Sum of the member countries");
  await openNotes(card(page, "pct-origin"));
  await expect(card(page, "pct-origin").locator(".chart-footnote", { hasText: "Cross-check" })).toBeVisible();
  await expect(card(page, "origin-apps").locator(".chart-footnote", { hasText: "Cross-check" })).toHaveCount(0);
  // a member WIPO does not list for the series is named; m = the listed members
  const origin = file.series.origin_apps;
  const listed = mapValues("origin_apps");
  const unlisted = group.members.filter((code) => !(code in listed));
  expect(unlisted.length).toBe(group.members.length - origin.members);
  const coverage = card(page, "origin-apps").locator(".chart-footnote", { hasText: "n of m" });
  await expect(coverage).toContainText(`${origin.members} members WIPO lists`);
  for (const code of unlisted) await expect(coverage).toContainText(`${LABELS.get(code)} (${code})`);
  await expect(card(page, "world-map")).toBeVisible();
  expect(errors).toEqual([]);
});

test("?region=021 (same members as Northern America) shows the continent page", async ({ page }) => {
  const continent = groups.find((item) => item.id === "northern-america") as GroupItem;
  await page.goto("/?region=021");
  await expect(page.locator("h1")).toHaveText(continent.label);
  await expect.poll(() => new URL(page.url()).searchParams.get("continent")).toBe("northern-america");
  expect(new URL(page.url()).searchParams.has("region")).toBe(false);
  await expect(page.locator(".entity-intro .lede")).toContainText("Continent");
});

test("unknown region or continent: notice, and the overview", async ({ page }) => {
  for (const [url, text] of [["/?region=999", "Unknown region: 999"], ["/?continent=atlantis", "Unknown continent: atlantis"]]) {
    await page.goto(url);
    await expect(page.locator("#notices")).toContainText(text);
    await expect(page.locator(".hero h1")).toBeVisible();
  }
});

test("?country=BR: region-compare names South America; both lines start at 100 in the panel's first year", async ({ page }) => {
  const errors = trackErrors(page);
  const region = regionOf("BR");
  const panel = groupFile(region.id).series.origin_apps.panel as NonNullable<GroupSeries["panel"]>;
  // amendment: the panel window starts after the last year the attribution floor fails
  const floorYears = Object.entries(groupFile(region.id).series.origin_apps.null_reason)
    .filter(([, reason]) => reason === "attribution_floor").map(([year]) => Number(year));
  expect(floorYears.length, "the region has attribution-floor years").toBeGreaterThan(0);
  expect(panel.first as number).toBeGreaterThan(Math.max(...floorYears));
  await page.goto("/?country=BR");
  const compare = card(page, "region-compare");
  await expect(compare.locator("h2")).toContainText(region.label);
  await expect(compare.locator(".chart-note")).toContainText(`${panel.first}–${panel.last}`);
  await expect(compare.locator("svg").first()).toBeVisible();
  const rows = await showFigures(compare);
  const first = rows.last();
  await expect(first.locator("td").first()).toHaveText(String(panel.first));
  await expect(first.locator("td").nth(1)).toHaveText("100.0");
  await expect(first.locator("td").nth(2)).toHaveText("100.0");
  expect(errors).toEqual([]);
});

/** Serves BR's origin total and its region's panel total at the panel's last year, and share decimals 2, so the
 * share footnote and table cell have a literal oracle. */
async function patchCompareShare(page: Page, brazil: number, panelTotal: number): Promise<string> {
  const region = regionOf("BR");
  const last = String((groupFile(region.id).series.origin_apps.panel as NonNullable<GroupSeries["panel"]>).last);
  await page.route("**/data/entity/BR.json", async (route) => {
    const file = entityFile("BR");
    file.series.origin_apps.types.total[last] = brazil;
    await route.fulfill({ json: file });
  });
  await page.route(`**/data/group/${region.id}.json`, async (route) => {
    const file = groupFile(region.id);
    (file.series.origin_apps.panel as NonNullable<GroupSeries["panel"]>).total[last] = panelTotal;
    await route.fulfill({ json: file });
  });
  await page.route("**/data/overview.json", async (route) => {
    const file = readJson("site/data/overview.json");
    file.method.rounding.decimals.share = 2;
    await route.fulfill({ json: file });
  });
  return last;
}

// 43 / 4,000 = 1.075%: binary (43 / 4000) * 100 = 1.0749... -> toFixed "1.07%"; the stated rule gives "1.08%".
for (const [brazil, panelTotal, expected] of [[250, 1000, "25.00%"], [12_345, 100_000, "12.35%"], [43, 4_000, "1.08%"]] as [number, number, string][]) {
  test(`region-compare share: BR ${brazil} of panel ${panelTotal} = ${expected} (half away from zero)`, async ({ page }) => {
    const last = await patchCompareShare(page, brazil, panelTotal);
    await page.goto("/?country=BR");
    const compare = card(page, "region-compare");
    await expect(compare.locator(".chart-footnote", { hasText: "Share of" })).toContainText(`${expected} in ${last}.`);
    const rows = await showFigures(compare);
    await expect(rows.first().locator("td").first()).toHaveText(last);
    await expect(rows.first().locator("td").nth(5)).toHaveText(expected);
  });
}

test("country not in its region's panel: no region-compare card, a note says why", async ({ page }) => {
  const region = regionOf("BR");
  const panel = groupFile(region.id).series.origin_apps.panel as NonNullable<GroupSeries["panel"]>;
  const outside = region.members.find((code) => !panel.members.includes(code) && LABELS.has(code)) as string;
  await page.goto(`/?country=${outside}`);
  await expect(page.locator("h1")).toHaveText(LABELS.get(outside) as string);
  await expect(card(page, "region-compare")).toHaveCount(0);
  await expect(page.locator(".region-compare-note")).toContainText(region.label);
});

test("embed: region-compare for a country and a continent's totals", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=region-compare&country=BR");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  await expect(page.locator(".chart-card h2")).toContainText(regionOf("BR").label);
  await page.goto("/embed.html?chart=pct-origin&continent=europe");
  await expect(page.locator(".chart-card h2")).toContainText("Europe");
  await expect(page.locator(".chart-card svg").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("picker finds South America (region page) and Europe (continent page)", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: /country or office/i });
  const results = page.locator(".picker-results .picker-group", { hasText: "Regions and continents" });
  const south = groups.find((group) => group.label === "South America") as GroupItem;
  await search.fill("South America");
  await expect(results.getByRole("option", { name: /South America/ }).first()).toHaveAttribute("data-href", new RegExp(`\\?region=${south.id}(&|$)`));
  await search.fill("Europe");
  const europe = results.getByRole("option", { name: /^Europe$/ });
  await expect(europe).toHaveAttribute("data-href", /\?continent=europe(&|$)/);
  await europe.click();
  await expect(page.locator("h1")).toHaveText("Europe");
});

test("wipo_total cross-check: label, key and column name the codes the sum adds (Europe office applications)", async ({ page }) => {
  const errors = trackErrors(page);
  const extra: string[] = overview.method.group_crosscheck_assignment.office_apps.europe;
  expect(extra.length).toBeGreaterThan(0);
  const figures = groupFile("europe").series.office_apps;
  const year = lastYear(figures.member_sum as YearMap);
  const members = (groups.find((item) => item.id === "europe") as GroupItem).members;
  const listed = mapValues("office_apps");
  // the added codes (regional offices, a former state) have entity files, not map rows
  const extraSum = extra.reduce((sum, code) => sum + (entityFile(code).series.office_apps.types.total[year] ?? 0), 0);
  const membersOnly = members.reduce((sum, code) => sum + (listed[code]?.[year] ?? 0), 0);
  const expected = membersOnly + extraSum;
  expect(extraSum).toBeGreaterThan(0);
  expect(figures.member_sum?.[year]).toBe(expected);
  await page.goto("/?continent=europe");
  const office = card(page, "office-apps");
  const label = `Sum of member countries + ${extra.map((code) => LABELS.get(code)).join(", ")} (cross-check)`;
  expect(extra.every((code) => LABELS.has(code))).toBe(true);
  await expect(office.locator(".chart-note")).toContainText(label);
  await expect(office.locator("svg").first()).toContainText(label);
  const rows = await showFigures(office);
  const headers = await office.locator(".chart-figures table thead th").allTextContents();
  expect(headers).toContain(label);
  const latest = rows.filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${year}$`) }) });
  await expect(latest.locator("td").nth(headers.indexOf(label))).toHaveText(count(expected));
  // PCT origin for Europe adds no code: the plain label stays
  const plain = "Sum of member countries (cross-check)";
  expect(overview.method.group_crosscheck_assignment.pct_origin?.europe ?? []).toEqual([]);
  await showFigures(card(page, "pct-origin"));
  expect(await card(page, "pct-origin").locator(".chart-figures table thead th").allTextContents()).toContain(plain);
  expect(errors).toEqual([]);
});

test("?continent=africa PCT card: basis and cross-check notes name only members (+ listed codes), never offices or estimates; office card does", async ({ page }) => {
  const errors = trackErrors(page);
  const pct = groupFile("africa").series.pct_origin;
  expect(pct.basis).toBe("wipo_total");
  const extra: string[] = overview.method.group_crosscheck_assignment.pct_origin?.africa ?? [];
  await page.goto("/?continent=africa");
  const pctCard = card(page, "pct-origin");
  const pctNote = pctCard.locator(".chart-note");
  await expect(pctNote).toContainText("counts the member countries");
  for (const code of extra) await expect(pctNote).toContainText(`${LABELS.get(code)} (${code})`);
  await expect(pctNote).not.toContainText("regional offices");
  await expect(pctNote).not.toContainText("estimates");
  const pctCheck = pctCard.locator(".chart-footnote", { hasText: "Cross-check:" });
  await expect(pctCheck).toHaveCount(1);
  await expect(pctCheck).toContainText("as WIPO's total counts the same countries and codes");
  await expect(pctCheck).not.toContainText("estimates");
  // the office card keeps its own wording, from the same source
  const officeCard = card(page, "office-apps");
  await expect(officeCard.locator(".chart-note")).toContainText("regional offices and WIPO's estimates for offices that did not report");
  await expect(officeCard.locator(".chart-footnote", { hasText: "Cross-check:" })).toContainText("adds estimates for offices that do not report");
  expect(errors).toEqual([]);
});

test("?continent=europe PCT card: the basis names Europe's unlisted origins, as the methods page does", async ({ page }) => {
  await page.goto("/?continent=europe");
  const pctCard = card(page, "pct-origin");
  await expect(pctCard.locator(".chart-note")).toContainText(`${(groups.find((item) => item.id === "europe") as GroupItem).label} also counts a few origins WIPO does not list`);
  await expect(pctCard.locator(".chart-footnote", { hasText: "Cross-check:" })).toContainText("also counts a few origins it does not list as countries");
});

test("country without an origin series: the note blames the country, not the region's panel (BR with its origin series removed)", async ({ page }) => {
  const region = regionOf("BR");
  expect(groupFile(region.id).series.origin_apps.panel?.members.length, "region has a panel").toBeGreaterThan(0);
  await page.route("**/data/entity/BR.json", async (route) => {
    const file = entityFile("BR");
    delete file.series.origin_apps;
    delete file.sources.origin_apps;
    await route.fulfill({ json: file });
  });
  await page.goto("/?country=BR");
  await expect(card(page, "region-compare")).toHaveCount(0);
  const note = page.locator(".region-compare-note");
  await expect(note).toContainText(`${LABELS.get("BR")} has no applications by origin reported by WIPO`);
  await expect(note).not.toContainText("no fixed panel");
});

test("?country=GG (patched: no origin series; its region given a panel): no page claims the region has no panel", async ({ page }) => {
  await page.route("**/data/entity/GG.json", async (route) => {
    const file = entityFile("GG");
    delete file.series.origin_apps;
    delete file.sources.origin_apps;
    await route.fulfill({ json: file });
  });
  const partner = partnerOf("GG");
  await patchPanel(page, partner, [partner]);
  await page.goto("/?country=GG");
  await expect(page.locator("main")).toContainText("No data reported for");
  await expect(page.locator("main")).not.toContainText("no fixed panel");
});

test("a panel of one (Central Asia, UZ): no region-compare card, a note says so; a 2-of-2 panel keeps its card", async ({ page }) => {
  const { first, last } = await patchPanel(page, "UZ", ["UZ"]);
  await page.goto("/?country=UZ");
  await expect(card(page, "region-compare")).toHaveCount(0);
  await expect(page.locator(".region-compare-note")).toContainText(
    `is the only member of the region's fixed panel (the members reporting applications by origin in every year ${first}–${last})`);
  await patchPanel(page, "US", ["US", partnerOf("US")]);
  await page.goto("/?country=US");
  await expect(card(page, "region-compare")).toBeVisible();
});

test("region-compare footnote lists the panel members by name, not WIPO code", async ({ page }) => {
  const panel = groupFile(regionOf("BR").id).series.origin_apps.panel as NonNullable<GroupSeries["panel"]>;
  const names = panel.members.map((code) => LABELS.get(code) as string).sort((a, b) => a.localeCompare(b));
  await page.goto("/?country=BR");
  const footnote = card(page, "region-compare").locator(".chart-footnote", { hasText: "Panel members" });
  await expect(footnote).toHaveText(`Panel members: ${names.join(", ")}.`);
  await expect(footnote).not.toContainText("WIPO codes");
});

test("region-compare: a zero panel total in the base year blames the panel, not the country", async ({ page }) => {
  const region = regionOf("BR");
  const panelFirst = (groupFile(region.id).series.origin_apps.panel as NonNullable<GroupSeries["panel"]>).first as number;
  await page.route(`**/data/group/${region.id}.json`, async (route) => {
    const file = groupFile(region.id);
    (file.series.origin_apps.panel as NonNullable<GroupSeries["panel"]>).total[String(panelFirst)] = 0;
    await route.fulfill({ json: file });
  });
  await page.goto("/?country=BR");
  await expect(card(page, "region-compare")).toHaveCount(0);
  await expect(page.locator(".region-compare-note")).toContainText(`the region's fixed panel reported no applications by origin in ${panelFirst}`);
});

test("embed: unknown region or continent names the id asked for", async ({ page }) => {
  for (const [query, text] of [["region=999", "Unknown region: 999."], ["continent=atlantis", "Unknown continent: atlantis."]]) {
    await page.goto(`/embed.html?chart=group-members&${query}`);
    await expect(page.locator("body")).toContainText(text);
    await expect(page.locator("body")).not.toContainText("undefined");
  }
});

test("?region=021&continent=atlantis: the unknown continent is dropped first; the region moves to its continent page", async ({ page }) => {
  await page.goto("/?region=021&continent=atlantis");
  await expect(page.locator("#notices")).toContainText("Unknown continent: atlantis");
  await expect(page.locator("h1")).toHaveText((groups.find((item) => item.id === "northern-america") as GroupItem).label);
  await expect.poll(() => new URL(page.url()).searchParams.get("continent")).toBe("northern-america");
});

test("?continent=europe&region=021: stays on Europe, no 'showing the continent page' notice", async ({ page }) => {
  await page.goto("/?continent=europe&region=021");
  await expect(page.locator("h1")).toHaveText((groups.find((item) => item.id === "europe") as GroupItem).label);
  await expect(page.locator("#notices")).toContainText("region 021 left out");
  await expect(page.locator("#notices")).not.toContainText("showing the continent page");
  expect(new URL(page.url()).searchParams.get("continent")).toBe("europe");
  expect(new URL(page.url()).searchParams.has("region")).toBe(false);
});

test("embed group chart with neither region nor continent never prints 'undefined'", async ({ page }) => {
  await page.goto("/embed.html?chart=group-members");
  await expect(page.locator("body")).not.toContainText("undefined");
  await expect(page.locator("body")).toContainText("Unknown chart");
});

test("series break (fixture, audit F1): China's continent and region totals carry 'Includes China' on office and origin, not PCT", async ({ page }) => {
  const errors = trackErrors(page);
  const entry = fixtureBreak();
  const region = regionOf(BREAK_CODE);
  await routeSeriesBreaks(page, [entry]);
  for (const [address, cards] of [[`/?continent=${region.continent}`, ["origin-apps", "office-apps"]],
    [`/?region=${region.id}`, ["origin-apps"]]] as const) {
    await page.goto(address);
    for (const id of cards) {
      const note = card(page, id).locator(".chart-footnote", { hasText: "Series break" });
      await expect(note, `${address} ${id}`).toContainText(`Includes ${entry.label}`);
      await expect(note, `${address} ${id}`).toHaveText(includesBreakNote(entry));
    }
    await expect(card(page, "pct-origin").locator("svg").first()).toBeVisible();
    await expect(card(page, "pct-origin").locator(".chart-footnote", { hasText: "Series break" }), address).toHaveCount(0);
  }
  await page.goto("/?continent=europe");
  await expect(card(page, "origin-apps").locator("svg").first()).toBeVisible();
  await expect(page.locator(".chart-card", { hasText: "Series break" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("series break (fixture): the region comparison of JP, in China's region, carries the note", async ({ page }) => {
  const errors = trackErrors(page);
  const member = "JP";
  const region = regionOf(BREAK_CODE);
  expect(regionOf(member).id).toBe(region.id);
  const panel = groupFile(region.id).series.origin_apps.panel;
  expect(panel?.members).toContain(member);
  // break year inside the panel window, so the test holds whichever years a refresh moves the window to
  const entry = fixtureBreak((panel!.first as number) + 1);
  await routeSeriesBreaks(page, [entry]);
  await page.goto(`/?country=${member}`);
  const note = card(page, "region-compare").locator(".chart-footnote", { hasText: "Series break" });
  await expect(note).toHaveText(includesBreakNote(entry));
  // a break in the window's first year: the year before is not charted, so the chart spans no break
  await page.unrouteAll();
  await routeSeriesBreaks(page, [fixtureBreak(panel!.first as number)]);
  await page.goto(`/?country=${member}`);
  await expect(card(page, "region-compare").locator("svg").first()).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("group pages without series_breaks (data before the refresh that adds it): no break note, no error", async ({ page }) => {
  const errors = trackErrors(page);
  await routeSeriesBreaks(page, null);
  await page.goto(`/?continent=${regionOf(BREAK_CODE).continent}`);
  await expect(card(page, "origin-apps").locator("svg").first()).toBeVisible();
  await expect(page.getByText("Series break")).toHaveCount(0);
  expect(errors).toEqual([]);
});
