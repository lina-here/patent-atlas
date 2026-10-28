import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { DEFAULT_MAP_SCALE, DEFAULT_RATIO_SCALE, DEFAULT_SHARE_SCALE, MAX_MAP_BINS, ratioBinLabel, ratioBinOf, shareBinLabel, shareBinOf } from "../../site/src/mapScale";

type YearMap = Record<string, number | null>;
type MapFile = { values: Record<string, YearMap> };

const config = JSON.parse(readFileSync("site/config.json", "utf8"));
const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const entities: { code: string; kind: string; label: string; iso_numeric: string | null }[] =
  JSON.parse(readFileSync("site/data/entities.json", "utf8"));
const mapFile = (series: string): MapFile => JSON.parse(readFileSync(`site/data/map/${series}.json`, "utf8"));
const points: Record<string, [number, number]> = JSON.parse(readFileSync("site/geo/points.json", "utf8")).points;
type GroupsFile = { items: { id: string; kind: string; label: string; members: string[] }[];
  successors: Record<string, { code: string; from_year: number; to_year: number }[]> };
const groupsFile: GroupsFile = JSON.parse(readFileSync("site/data/groups.json", "utf8"));
type GroupSeries = { total: YearMap; reporting: Record<string, number>; members: number; null_reason: Record<string, string> };
const groupFile = (id: string): { series: Record<string, GroupSeries> } =>
  JSON.parse(readFileSync(`site/data/group/${id}.json`, "utf8"));
const LABELS = new Map(entities.map((entity) => [entity.code, entity.label]));

const COUNTRIES = new Map(entities.filter((entity) => entity.kind === "country").map((entity) => [entity.code, entity]));
const DISCLAIMER = "The boundaries and names shown and the designations used on this map do not imply official " +
  "endorsement or acceptance by Patent Atlas or WIPO.";
const map = (page: Page) => page.locator('.chart-card[data-chart="world-map"]');

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Serves map/origin_apps.json with CH's value in `year` replaced. */
async function patchSwiss(page: Page, year: string, value: number | null): Promise<void> {
  await page.route("**/data/map/origin_apps.json", async (route) => {
    const file = mapFile("origin_apps");
    file.values.CH[year] = value;
    await route.fulfill({ json: file });
  });
}

/** Serves site/data/<file> with `edit` applied to a copy of the committed file (the test sets the value it checks). */
async function patchData(page: Page, file: string, edit: (data: any) => void): Promise<void> {
  await page.route(`**/data/${file}`, async (route) => {
    const data = JSON.parse(readFileSync(`site/data/${file}`, "utf8"));
    edit(data);
    await route.fulfill({ json: data });
  });
}

/** Expected data-bin from the map file value and config.map; written differently from map.ts `binOf` (thresholds,
 * not a running bound) so a shared mistake cannot hide. */
function expectedBin(value: number | null | undefined, base: number, bins: number): string {
  if (value === null || value === undefined) return "null";
  if (value <= 0) return "zero";
  const thresholds = Array.from({ length: bins - 1 }, (_, index) => base ** (index + 1));
  return String(1 + thresholds.filter((threshold) => value >= threshold).length);
}

const swiss = (page: Page) => map(page).locator('path[data-code="CH"]');
/** Rows of the first figures table (the map's own; former entities follow in their own table). */
const figureRows = (page: Page) => map(page).locator(".chart-figures table").first().locator("tbody tr");

/** Former entity label a successor is reported under (spec successor rule), from the files; written apart from map.ts:
 * no own value that year, a value in some year, a covering former with a value that year. */
function formerOf(values: Record<string, YearMap>, code: string, year: string): string | undefined {
  const own = values[code];
  if (!own || (own[year] ?? null) !== null || !Object.values(own).some((value) => value !== null)) return undefined;
  for (const [former, successors] of Object.entries(groupsFile.successors)) {
    for (const successor of successors) {
      if (successor.code === code && successor.from_year <= Number(year) && Number(year) <= successor.to_year &&
        (values[former]?.[year] ?? null) !== null) return LABELS.get(former);
    }
  }
  return undefined;
}

test("default map: origin, top year; CN in a higher bin than CH (patched values); CH links to its page", async ({ page }) => {
  const errors = trackErrors(page);
  const year = String(overview.top_year);
  const [chinaValue, swissValue] = [1_500_000, 50_000];
  await patchData(page, "map/origin_apps.json", (file) => { file.values.CN[year] = chinaValue; file.values.CH[year] = swissValue; });
  await page.goto("/");
  await expect(map(page).locator("h2")).toHaveText(`Patent applications by applicant's origin, ${year}`);
  const china = await map(page).locator('path[data-code="CN"]').getAttribute("data-bin");
  const swissBin = await swiss(page).getAttribute("data-bin");
  expect(china).toBe(expectedBin(chinaValue, config.map.logBase, config.map.bins));
  expect(swissBin).toBe(expectedBin(swissValue, config.map.logBase, config.map.bins));
  expect(Number(china)).toBeGreaterThan(Number(swissBin));
  await expect(swiss(page).locator("xpath=..")).toHaveAttribute("href", /\?country=CH(&|$)/);
  await expect(swiss(page).locator("title")).toContainText("Switzerland");
  expect(errors).toEqual([]);
});

test("null year: hatched, labelled no data reported, never a colour bin", async ({ page }) => {
  const year = String(overview.top_year);
  await patchSwiss(page, year, null);
  await page.goto("/");
  await expect(swiss(page)).toHaveAttribute("data-bin", "null");
  const fill = await swiss(page).evaluate((element) => getComputedStyle(element).fill);
  expect(fill).toContain("world-map-hatch");
  expect(await map(page).locator('.map-legend li[data-bin="null"] rect').evaluate((element) => getComputedStyle(element).fill))
    .toContain("world-map-hatch");
  await expect(swiss(page).locator("title")).toHaveText(`Switzerland: no data reported (${year})`);
  await expect(map(page).locator('.map-legend li[data-bin="null"]')).toHaveText("No data reported");
});

test("reported 0: own swatch, shown as 0", async ({ page }) => {
  const year = String(overview.top_year);
  await patchSwiss(page, year, 0);
  await page.goto("/");
  await expect(swiss(page)).toHaveAttribute("data-bin", "zero");
  await expect(map(page).locator('.map-legend li[data-bin="zero"]')).toHaveText("0 reported");
  const fillOf = (selector: string) => map(page).locator(selector).evaluate((element) => getComputedStyle(element).fill);
  // WCAG 1.4.1: a pattern, not only a colour, tells a reported 0 from the lowest bin
  expect(await fillOf('path[data-code="CH"]')).toContain("world-map-zero");
  expect(await fillOf('.map-legend li[data-bin="zero"] rect')).toContain("world-map-zero");
  expect(await fillOf('.map-legend li[data-bin="1"] rect')).not.toContain("world-map-");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(map(page).locator("tr", { hasText: "Switzerland" }).locator("td").nth(2)).toHaveText("0");
});

for (const [value, bin] of [[9_999, "4"], [10_000, "5"]] as [number, string][]) {
  test(`bin boundaries: CH ${value} -> bin ${bin} (default scale, base ** k opens bin k + 1)`, async ({ page }) => {
    const year = String(overview.top_year);
    await patchMapConfig(page, DEFAULT_MAP_SCALE);
    await patchSwiss(page, year, value);
    await page.goto("/");
    expect(expectedBin(value, DEFAULT_MAP_SCALE.logBase, DEFAULT_MAP_SCALE.bins)).toBe(bin);
    await expect(swiss(page)).toHaveAttribute("data-bin", bin);
  });
}

for (const [series, query] of [["origin_apps", ""], ["office_apps", "?metric=office_apps&year=2000"], ["pct_origin", "?metric=pct_origin&year=2010"]]) {
  test(`${series}: every country with data is an area, a dot or listed as not drawn; table equals map file`, async ({ page }) => {
    await page.goto(`/${query}`);
    const year = query ? new URLSearchParams(query).get("year") as string : String(overview.top_year);
    await expect(map(page).locator("h2")).toContainText(year);
    const values = mapFile(series).values;
    const areas = new Set(await map(page).locator("path[data-code]").evaluateAll((els) => els.map((el) => el.getAttribute("data-code"))));
    const dots = new Set(await map(page).locator("circle[data-code]").evaluateAll((els) => els.map((el) => el.getAttribute("data-code"))));
    const notDrawn = (await map(page).locator(".map-not-drawn").count()) ? await map(page).locator(".map-not-drawn").textContent() : "";
    for (const [code, years] of Object.entries(values)) {
      const country = COUNTRIES.get(code);
      if (!country || years[year] === null || years[year] === undefined) continue;
      expect(areas.has(code) || dots.has(code) || (notDrawn ?? "").includes(country.label), `${code} drawn or listed`).toBe(true);
    }
    // every shape and dot carries the bin its value defines
    const drawn = await map(page).locator("path[data-code], circle[data-code]").evaluateAll((els) =>
      els.map((el) => [el.getAttribute("data-code"), el.getAttribute("data-bin")]));
    expect(drawn.length).toBeGreaterThan(100);
    for (const [code, bin] of drawn) {
      const expected = formerOf(values, code as string, year) ? "former"
        : expectedBin(values[code as string][year], config.map.logBase, config.map.bins);
      expect(bin, `${code} bin`).toBe(expected);
    }
    await map(page).getByRole("button", { name: "Show figures" }).click();
    const rows = await figureRows(page).evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")));
    expect(rows.length).toBeGreaterThan(100);
    // every country the file lists has a row, in particular each with a value for the year
    const rowCodes = new Set(rows.map((row) => row[1]));
    const listed = Object.keys(values).filter((code) => COUNTRIES.has(code));
    expect([...rowCodes].sort()).toEqual(listed.sort());
    const withValue = listed.filter((code) => values[code][year] !== null && values[code][year] !== undefined);
    expect(withValue.length).toBeGreaterThan(100);
    for (const code of withValue) expect(rowCodes.has(code), `${code} has a row`).toBe(true);
    for (const [, code, text] of rows) {
      const value = values[code][year];
      const former = formerOf(values, code, year);
      expect(text, code).toBe(former ? `reported under ${former}`
        : value === null || value === undefined ? "–" : value.toLocaleString("en-US"));
    }
  });
}

test("small countries are dots (SG); one with data and no shape or dot is listed not drawn", async ({ page }) => {
  await page.goto("/");
  await expect(map(page).locator('circle.map-dot[data-code="SG"]')).toHaveCount(1);
  expect(points.SG).toBeTruthy();
  await page.route("**/geo/points.json", async (route) => {
    const file = JSON.parse(readFileSync("site/geo/points.json", "utf8"));
    delete file.points.SG;
    await route.fulfill({ json: file });
  });
  await page.reload();
  await expect(map(page).locator('circle[data-code="SG"]')).toHaveCount(0);
  await expect(map(page).locator(".map-not-drawn")).toContainText("Not drawn on map");
  await expect(map(page).locator(".map-not-drawn")).toContainText("Singapore");
});

test("neutral polygons (W. Sahara 732, a feature without id): neutral class, no link; disclaimer and credit", async ({ page }) => {
  await page.goto("/");
  const sahara = map(page).locator('path[data-id="732"]');
  await expect(sahara).toHaveClass(/map-neutral/);
  await expect(sahara).not.toHaveAttribute("data-bin", /.*/);
  expect(await sahara.evaluate((el) => el.closest("a"))).toBeNull();
  const noId = map(page).locator('path[data-id=""]');
  expect(await noId.count()).toBeGreaterThan(0);
  await expect(noId.first()).toHaveClass(/map-neutral/);
  expect(await noId.first().evaluate((el) => el.closest("a"))).toBeNull();
  await expect(map(page).locator('path[data-id="158"]')).toHaveClass(/map-neutral/); // Taiwan: not in WIPO data
  // WCAG 1.4.1: hatched, not only grey; the legend swatch uses the same pattern
  for (const shape of [sahara, noId.first(), map(page).locator('.map-legend li[data-bin="neutral"] rect')]) {
    expect(await shape.evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-neutral");
  }
  await expect(map(page).locator(".map-disclaimer")).toHaveText(DISCLAIMER);
  await expect(map(page).locator(".chart-credit")).toContainText("Natural Earth");
  await expect(map(page).locator(".source-line")).toContainText("Source: WIPO Statistics Database");
});

test("metric and year controls redraw the map, rewrite the address and the cite link", async ({ page }) => {
  await page.goto("/");
  await page.locator("#world-map-metric").focus(); // keyboard user: focus survives the redraw
  await page.locator("#world-map-metric").selectOption("pct_origin");
  await expect(map(page).locator("h2")).toContainText("PCT applications by applicant's origin");
  await expect(page).toHaveURL(/metric=pct_origin/);
  await expect(page.locator("#world-map-metric")).toBeFocused();
  const slider = page.locator("#world-map-year");
  await slider.fill("2005");
  await expect(map(page).locator("h2")).toHaveText("PCT applications by applicant's origin, 2005");
  await expect(page).toHaveURL(/year=2005/);
  await map(page).getByRole("button", { name: "Cite this" }).click();
  await expect(map(page).locator(".cite-text")).toContainText("metric=pct_origin");
  await expect(map(page).locator(".cite-text")).toContainText("year=2005");
  await page.reload();
  await expect(map(page).locator("h2")).toHaveText("PCT applications by applicant's origin, 2005");
});

test("year outside the data: notice, clamped; region mode for office (none): notice, countries", async ({ page }) => {
  await page.goto("/?year=1900&map=region&metric=office_apps");
  await expect(page.locator("#notices")).toContainText("No map data for 1900");
  await expect(page.locator("#notices")).toContainText("Map mode “region” is not available for Patent applications by filing office: showing countries.");
  await expect(map(page).locator("h2")).not.toContainText("1900");
  await expect(map(page).locator("h2")).not.toContainText("by region");
  await expect(swiss(page)).toHaveAttribute("data-bin", /^\d+$/);
  await expect(swiss(page).locator("xpath=..")).toHaveAttribute("href", /\?country=CH(&|$)/);
});

for (const kind of ["continent", "region"]) {
  test(`${kind} mode: each member coloured by its group total; "n of m" in tooltip and table; links to the group page`, async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(`/?map=${kind}`);
    const year = String(overview.top_year);
    await expect(map(page).locator("h2")).toHaveText(`Patent applications by applicant's origin, by ${kind}, ${year}`);
    const groups = groupsFile.items.filter((group) => group.kind === kind);
    const groupOf = new Map(groups.flatMap((group) => group.members.map((code) => [code, group] as const)));
    const drawn = await map(page).locator("path[data-code], circle[data-code]").evaluateAll((els) =>
      els.map((el) => [el.getAttribute("data-code") as string, el.getAttribute("data-bin") as string]));
    expect(drawn.length).toBeGreaterThan(150);
    for (const [code, bin] of drawn) {
      const group = groupOf.get(code);
      expect(group, `${code} in a ${kind}`).toBeTruthy();
      expect(bin, code).toBe(expectedBin(groupFile(group!.id).series.origin_apps.total[year], config.map.logBase, config.map.bins));
    }
    const member = kind === "continent" ? { code: "DE", id: "europe", key: "continent" } : { code: "DE", id: "155", key: "region" };
    const figures = groupFile(member.id).series.origin_apps;
    const shape = map(page).locator(`path[data-code="${member.code}"]`);
    await expect(shape.locator("xpath=..")).toHaveAttribute("href", new RegExp(`\\?${member.key}=${member.id}(&|$)`));
    await expect(shape.locator("title")).toContainText(`${figures.reporting[year]} of ${figures.members} countries reporting`);
    await map(page).getByRole("button", { name: "Show figures" }).click();
    const label = groups.find((group) => group.id === member.id)!.label;
    const row = figureRows(page).filter({ has: page.locator("td", { hasText: new RegExp(`^${label}$`) }) });
    await expect(row.locator("td").nth(1)).toHaveText((figures.total[year] as number).toLocaleString("en-US"));
    await expect(row.locator("td").nth(2)).toHaveText(`${figures.reporting[year]} of ${figures.members}`);
    expect(errors).toEqual([]);
  });
}

for (const kind of ["continent", "region"]) {
  test(`${kind} mode: a member WIPO does not list for the series is named under the map, as on the group page`, async ({ page }) => {
    await page.goto(`/?map=${kind}&metric=origin_apps`);
    const listed = mapFile("origin_apps").values;
    const withUnlisted = groupsFile.items.filter((group) => group.kind === kind && group.members.some((code) => !(code in listed)));
    expect(withUnlisted.length, "a group with an unlisted member").toBeGreaterThan(0);
    for (const group of withUnlisted) {
      const figures = groupFile(group.id).series.origin_apps;
      const note = map(page).locator(".chart-footnote", { hasText: `${group.label}: “n of m”` });
      await expect(note).toContainText(`of the ${figures.members} members WIPO lists for this series`);
      for (const code of group.members.filter((member) => !(member in listed))) {
        await expect(note).toContainText(`${LABELS.get(code)} (${code})`);
      }
      await expect(note).toContainText(`(${group.members.length} members in all)`);
    }
    // a group whose members are all listed has no such note
    const complete = groupsFile.items.find((group) => group.kind === kind && group.members.every((code) => code in listed)) as { label: string };
    await expect(map(page).locator(".chart-footnote", { hasText: `${complete.label}: “n of m”` })).toHaveCount(0);
  });
}

test("region mode: a region equal to its continent links to the continent page; group names in the table are links", async ({ page }) => {
  await page.goto("/?map=region");
  const link = (code: string) => map(page).locator(`path[data-code="${code}"]`).locator("xpath=..");
  await expect(link("US")).toHaveAttribute("href", /\?continent=northern-america(&|$)/);
  await expect(link("CA")).toHaveAttribute("href", /\?continent=northern-america(&|$)/);
  await expect(link("DE")).toHaveAttribute("href", /\?region=155(&|$)/);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  // keyboard route to the group pages: real links in the figures table (map links are tabindex -1)
  const america = figureRows(page).locator("td").getByRole("link", { name: "Northern America" });
  await expect(america).toHaveAttribute("href", /\?continent=northern-america(&|$)/);
  const western = figureRows(page).locator("td").getByRole("link", { name: "Western Europe" });
  await expect(western).toHaveAttribute("href", /\?region=155(&|$)/);
  await western.focus();
  await expect(western).toBeFocused();
  await page.goto("/?map=continent");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(figureRows(page).locator("td").getByRole("link", { name: "Europe", exact: true })).toHaveAttribute("href", /\?continent=europe(&|$)/);
});

test("region mode: member sum names the former entity's figure it leaves out (Southern Europe, 2000)", async ({ page }) => {
  // patched: YU reports 2000; its successors in 2000 (RS, ME: groups.json successors, to 2003) do not, so they are
  // reported under YU (map.ts reportedUnder); the region total is non-null
  const yugoslavia = 4_321;
  const text = `Excludes figures reported under Yugoslavia (${yugoslavia.toLocaleString("en-US")})`;
  await patchData(page, "map/origin_apps.json", (file) => {
    file.values.YU["2000"] = yugoslavia;
    for (const code of ["RS", "ME"]) if (file.values[code]) file.values[code]["2000"] = null;
  });
  await patchData(page, "group/039.json", (file) => { file.series.origin_apps.total["2000"] ??= yugoslavia; });
  await patchData(page, "map/pct_origin.json", (file) => { if (file.values.YU) delete file.values.YU["2000"]; });
  await page.goto("/?map=region&year=2000");
  await expect(map(page).locator('path[data-code="HR"] title')).toContainText(text);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(figureRows(page).filter({ hasText: "Southern Europe" }).locator("td").nth(3)).toContainText(text);
  await expect(figureRows(page).filter({ hasText: "Western Europe" }).locator("td").nth(3)).not.toContainText("Excludes");
  // PCT: Yugoslavia has no PCT figure in 2000 (patched out): nothing to exclude
  await page.goto("/?map=region&metric=pct_origin&year=2000");
  await expect(map(page).locator('path[data-code="HR"] title')).not.toContainText("Excludes");
});

test("successor boundary years: RU 1992, RS 2004 numeric, CD 1985 no data; none reported under a former", async ({ page }) => {
  const origin = mapFile("origin_apps").values;
  for (const [code, year] of [["RU", "1992"], ["RS", "2004"], ["CD", "1985"]]) {
    await page.goto(`/?year=${year}`);
    const shape = map(page).locator(`path[data-code="${code}"]`);
    const value = origin[code][year] ?? null;
    await expect(shape.locator("title"), `${code} ${year}`).not.toContainText("reported under");
    await expect(shape).not.toHaveAttribute("data-bin", "former");
    await expect(shape.locator("title")).toContainText(value === null ? "no data reported" : value.toLocaleString("en-US"));
  }
});

test("continent office 1990 (patched null, no WIPO regional total): null year hatched with its reason", async ({ page }) => {
  await patchData(page, "group/europe.json", (file) => {
    file.series.office_apps.total["1990"] = null;
    file.series.office_apps.null_reason["1990"] = "no_wipo_regional_total";
  });
  await page.goto("/?map=continent&metric=office_apps&year=1990");
  const germany = map(page).locator('path[data-code="DE"]');
  await expect(germany).toHaveAttribute("data-bin", "null");
  await expect(germany).toHaveAttribute("data-reason", "no_wipo_regional_total");
  expect(await germany.evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-hatch");
  await expect(germany.locator("title")).toContainText("Europe (Germany): no data reported: no WIPO regional total (1990)");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const row = figureRows(page).filter({ hasText: "Europe" });
  await expect(row.locator("td").nth(1)).toHaveText("–");
  await expect(row.locator("td").nth(3)).toHaveText("no WIPO regional total");
});

test("origin continent in a floor-failing year: hatched with the attribution floor reason", async ({ page }) => {
  const year = Object.entries(groupFile("europe").series.origin_apps.null_reason)
    .find(([, reason]) => reason === "attribution_floor")![0];
  await page.goto(`/?map=continent&year=${year}`);
  const germany = map(page).locator('path[data-code="DE"]');
  await expect(germany).toHaveAttribute("data-bin", "null");
  await expect(germany).toHaveAttribute("data-reason", "attribution_floor");
  await expect(germany.locator("title")).toContainText("below the attribution floor");
  await expect(germany.locator("title")).toContainText(`${Math.round(overview.method.group_attribution_min * 100)}% of the series' world total`);
});

const formerFill = (page: Page, code: string) =>
  map(page).locator(`[data-code="${code}"]`).evaluate((el) => getComputedStyle(el).fill);

test("successors reported under a former entity: own pattern and text; DE 1985 not; legend entry", async ({ page }) => {
  await page.goto("/?year=1985");
  const russia = map(page).locator('path[data-code="RU"]');
  await expect(russia).toHaveAttribute("data-bin", "former");
  await expect(russia.locator("title")).toHaveText("Russian Federation: reported under Soviet Union (1985)");
  expect(await formerFill(page, "RU")).toContain("world-map-former");
  await expect(map(page).locator('path[data-code="DE"]')).toHaveAttribute("data-bin", /^\d+$/); // DD: none, DE reports
  const swatch = map(page).locator('.map-legend li[data-bin="former"]');
  await expect(swatch).toHaveText("Reported under a former entity");
  expect(await swatch.locator("rect").evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-former");
  await page.goto("/?year=1983");
  await expect(map(page).locator('path[data-code="CD"] title')).toHaveText("Democratic Republic of the Congo: reported under Zaire (1983)");
  await page.goto("/?year=2000");
  await expect(map(page).locator('path[data-code="RS"]')).toHaveAttribute("data-bin", "former");
  await expect(map(page).locator('path[data-code="RS"] title')).toHaveText("Serbia: reported under Yugoslavia (2000)");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(figureRows(page).filter({ hasText: "Serbia" }).locator("td").nth(2)).toHaveText("reported under Yugoslavia");
});

test("AN (PCT 2005): CW dot reported under Netherlands Antilles; SX, BQ no data, no dot; AN in the former-entities table", async ({ page }) => {
  const antillesValue = 321; // patched: AN reports 2005, CW (its successor) does not
  await patchData(page, "map/pct_origin.json", (file) => { file.values.AN["2005"] = antillesValue; if (file.values.CW) file.values.CW["2005"] = null; });
  await page.goto("/?metric=pct_origin&year=2005");
  for (const code of ["CW", "SX", "BQ"]) await expect(map(page).locator(`path[data-code="${code}"]`)).toHaveCount(0);
  const curacao = map(page).locator('circle[data-code="CW"]');
  await expect(curacao).toHaveAttribute("data-bin", "former");
  await expect(curacao.locator("title")).toHaveText("Curaçao: reported under Netherlands Antilles (2005)");
  expect(await formerFill(page, "CW")).toContain("world-map-former");
  await expect(map(page).locator('circle[data-code="SX"]')).toHaveCount(0);
  await expect(map(page).locator('circle[data-code="BQ"]')).toHaveCount(0);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const formers = map(page).locator(".chart-figures table").nth(1);
  await expect(formers.locator("caption")).toHaveText("Former entities");
  await expect(formers.locator("thead th")).toHaveText(["Former entity", "Years", "Successors", "Applications, 2005"]);
  const antilles = formers.locator("tbody tr", { hasText: "Netherlands Antilles (AN)" });
  await expect(antilles.locator("td").nth(2)).toContainText("Curaçao");
  await expect(antilles.locator("td").nth(3)).toHaveText(antillesValue.toLocaleString("en-US"));
  // AN is no country: its figure is in this table only, never a row of the map's own table
  await expect(figureRows(page).filter({ has: page.locator("td", { hasText: /^AN$/ }) })).toHaveCount(0);
});

test("mode control: switches to continents and back; region disabled for office", async ({ page }) => {
  await page.goto("/");
  await page.locator("#world-map-mode").selectOption("continent");
  await expect(map(page).locator("h2")).toContainText("by continent");
  await expect(page).toHaveURL(/map=continent/);
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(page.locator('#world-map-mode option[value="region"]')).toHaveAttribute("disabled", "");
  await expect(map(page).locator("h2")).toContainText("by continent");
  await page.locator("#world-map-mode").selectOption("country");
  await expect(page).not.toHaveURL(/map=/);
});

test("metric change from region mode to a metric without region data: notice, countries", async ({ page }) => {
  await page.goto("/?map=region");
  await expect(map(page).locator("h2")).toContainText("by region");
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(page.locator("#notices")).toContainText("Map mode “region” is not available for Patent applications by filing office: showing countries.");
  await expect(page.locator("#notices")).toBeVisible();
  await expect(map(page).locator("h2")).not.toContainText("by region");
  await expect(page.locator("#world-map-mode")).toHaveValue("country");
  await expect(page).not.toHaveURL(/map=/);
});

test("control notice goes when the controls change again; page-load notices stay", async ({ page }) => {
  await page.goto("/?map=region&year=1900");
  const fallback = "Map mode “region” is not available for Patent applications by filing office: showing countries.";
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(page.locator("#notices")).toContainText(fallback);
  await page.locator("#world-map-metric").selectOption("origin_apps");
  await page.locator("#world-map-mode").selectOption("region");
  await expect(map(page).locator("h2")).toContainText("by region");
  await expect(page.locator("#notices")).not.toContainText("showing countries");
  await expect(page.locator("#notices")).toContainText("No map data for 1900"); // raised at load: stays
  await page.goto("/?map=region");
  await page.locator("#world-map-metric").selectOption("office_apps");
  await expect(page.locator("#notices")).toBeVisible();
  await page.locator("#world-map-metric").selectOption("origin_apps");
  await expect(page.locator("#notices")).toBeHidden(); // nothing left: area hidden
});

test("embed: map without controls, links open the full site in a new tab", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/embed.html?chart=world-map&metric=office_apps");
  await expect(map(page).locator("h2")).toContainText("Patent applications by filing office");
  await expect(page.locator("#world-map-year")).toHaveCount(0);
  const link = map(page).locator('path[data-code="CH"]').locator("xpath=..");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", /\?country=CH(&|$)/);
  await expect(map(page).locator(".map-disclaimer")).toHaveText(DISCLAIMER);
  expect(errors).toEqual([]);
});

test("map fits a phone screen without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(map(page).locator(".map-svg")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

/** WCAG 2.x contrast ratio of two computed `rgb(...)` colours (opaque). */
function contrast(a: string, b: string): number {
  const lum = (colour: string): number => {
    const [r, g, bl] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

for (const theme of config.themes as string[]) {
  test(`${theme}: special-state marks >= 3:1 on their ground; shape edges >= 3:1 on the card; neutral cross-hatched (WCAG 1.4.1, 1.4.11)`, async ({ page }) => {
    await page.goto(`/?theme=${theme}`);
    await expect(map(page).locator("path[data-code]").first()).toBeVisible();
    const style = (selector: string, property: "fill" | "stroke") =>
      map(page).locator(selector).first().evaluate((el, prop) => getComputedStyle(el)[prop as "fill" | "stroke"], property);
    const pairs: [string, string, string, string, string][] = [
      ["zero dots", "pattern#world-map-zero .map-zero-mark", "fill", "pattern#world-map-zero .map-zero-bg", "fill"],
      ["no-data hatch", "pattern#world-map-hatch .map-hatch-line", "stroke", "pattern#world-map-hatch .map-hatch-bg", "fill"],
      ["neutral hatch", "pattern#world-map-neutral .map-neutral-line", "stroke", "pattern#world-map-neutral .map-neutral-bg", "fill"],
      ["former hatch", "pattern#world-map-former .map-former-line", "stroke", "pattern#world-map-former .map-former-bg", "fill"],
      ["PCT non-member dashes", "pattern#world-map-nonmember .map-nonmember-mark", "fill", "pattern#world-map-nonmember .map-nonmember-bg", "fill"],
    ];
    for (const [what, mark, markProperty, ground, groundProperty] of pairs) {
      const ratio = contrast(await style(mark, markProperty as "fill" | "stroke"), await style(ground, groundProperty as "fill" | "stroke"));
      expect(ratio, `${theme} ${what}`).toBeGreaterThanOrEqual(3);
    }
    const card = await map(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(contrast(await style("path[data-code]", "stroke"), card), `${theme} shape edge vs card`).toBeGreaterThanOrEqual(3);
    // the edge reads at 1x: at least 1px, and it does not scale with the map
    const shapeEdge = await map(page).locator("path[data-code]").first().evaluate((el) => {
      const css = getComputedStyle(el);
      return { width: parseFloat(css.strokeWidth), effect: css.vectorEffect };
    });
    expect(shapeEdge.width, `${theme} shape edge width`).toBeGreaterThanOrEqual(1);
    expect(shapeEdge.effect, `${theme} shape edge scaling`).toBe("non-scaling-stroke");
    // heat-strip cells sit on a card too: same edge
    const heat = page.locator('.chart-card[data-chart="pct-monthly"]');
    const heatStroke = await heat.locator("g.heat-cell rect").first().evaluate((el) => getComputedStyle(el).stroke);
    const heatCard = await heat.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(contrast(heatStroke, heatCard), `${theme} heat cell edge vs card`).toBeGreaterThanOrEqual(3);
    const heatEdge = await heat.locator("g.heat-cell rect").first().evaluate((el) => {
      const css = getComputedStyle(el);
      return { width: parseFloat(css.strokeWidth), effect: css.vectorEffect };
    });
    expect(heatEdge.width, `${theme} heat cell edge width`).toBeGreaterThanOrEqual(1);
    expect(heatEdge.effect, `${theme} heat cell edge scaling`).toBe("non-scaling-stroke");
    // neutral and no data differ by geometry, not only by ground: cross hatch (two lines) vs single hatch
    await expect(map(page).locator("pattern#world-map-neutral line")).toHaveCount(2);
    await expect(map(page).locator("pattern#world-map-hatch line")).toHaveCount(1);
  });
}

test("special-state patterns exist, with theme colours (dots visible on their ground)", async ({ page }) => {
  await page.goto("/");
  for (const id of ["world-map-hatch", "world-map-neutral", "world-map-zero", "world-map-former"]) {
    await expect(map(page).locator(`pattern#${id}`)).toHaveCount(1);
  }
  const fill = (selector: string) => map(page).locator(selector).evaluate((el) => getComputedStyle(el).fill);
  expect(await fill("pattern#world-map-zero .map-zero-mark")).not.toBe(await fill("pattern#world-map-zero .map-zero-bg"));
  expect(await fill("pattern#world-map-neutral .map-neutral-bg")).not.toBe(await fill("pattern#world-map-hatch .map-hatch-bg"));
  // former-entity hatch: own ground, leans the other way (differs from "no data" without colour)
  expect(await fill("pattern#world-map-former .map-former-bg")).not.toBe(await fill("pattern#world-map-hatch .map-hatch-bg"));
  const angle = (id: string) => map(page).locator(`pattern#${id}`).getAttribute("patternTransform");
  expect(await angle("world-map-former")).not.toBe(await angle("world-map-hatch"));
  for (const theme of config.themes as string[]) {
    const css = readFileSync(`site/themes/${theme}.css`, "utf8");
    for (const token of ["--map-former", "--map-former-line"]) expect(css, `${theme} ${token}`).toMatch(new RegExp(`^\\s*${token}:\\s*#[0-9a-fA-F]{3,8};`, "m"));
  }
});

test("every theme and base.css define fill rules for bins 1..MAX_MAP_BINS (and none beyond)", () => {
  const base = readFileSync("site/css/base.css", "utf8");
  const ruleBins = [...base.matchAll(/\.map-shape\[data-bin="(\d+)"\]\s*\{\s*fill:\s*var\(--map-bin-(\d+)\)/g)];
  expect(ruleBins.map((match) => [match[1], match[2]])).toEqual(
    Array.from({ length: MAX_MAP_BINS }, (_, index) => [String(index + 1), String(index + 1)]));
  expect(config.map.bins).toBeLessThanOrEqual(MAX_MAP_BINS);
  for (const theme of config.themes as string[]) {
    const css = readFileSync(`site/themes/${theme}.css`, "utf8");
    const defined = [...css.matchAll(/^\s*--map-bin-(\d+):\s*#[0-9a-fA-F]{3,8};/gm)].map((match) => Number(match[1]));
    expect(defined.sort((a, b) => a - b), theme).toEqual(Array.from({ length: MAX_MAP_BINS }, (_, index) => index + 1));
  }
});

/** Serves config.json with `map` replaced. */
async function patchMapConfig(page: Page, mapConfig: unknown): Promise<void> {
  await page.route("**/config.json", async (route) => {
    await route.fulfill({ json: { ...config, map: mapConfig } });
  });
}

for (const [label, mapConfig, message] of [
  ["bins above the themed count", { logBase: 10, bins: MAX_MAP_BINS + 1 }, "Invalid map.bins in config.json"],
  ["bins zero", { logBase: 10, bins: 0 }, "Invalid map.bins in config.json"],
  ["bins not whole", { logBase: 10, bins: 3.5 }, "Invalid map.bins in config.json"],
  ["logBase 1", { logBase: 1, bins: 7 }, "Invalid map.logBase in config.json"],
  ["logBase missing", { bins: 7 }, "Invalid map.logBase in config.json"],
] as [string, unknown, string][]) {
  test(`invalid config map (${label}): notice, default scale drawn, no bin without a fill rule`, async ({ page }) => {
    const errors = trackErrors(page);
    await patchMapConfig(page, mapConfig);
    await page.goto("/");
    await expect(page.locator("#notices")).toContainText(message);
    await expect(map(page).locator(".map-legend li[data-bin]:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])"))
      .toHaveCount(MAX_MAP_BINS);
    await expect(map(page).locator(".map-legend-title")).toHaveText("Log scale: bins of powers of 10");
    const bins = await map(page).locator("path[data-code], circle[data-code]").evaluateAll((els) =>
      [...new Set(els.map((el) => el.getAttribute("data-bin")))]);
    for (const bin of bins) expect(["zero", "null", ...Array.from({ length: MAX_MAP_BINS }, (_, index) => String(index + 1))]).toContain(bin);
    expect(errors).toEqual([]);
  });
}

test("valid smaller config map: that many bins, no notice", async ({ page }) => {
  await patchMapConfig(page, { logBase: 4, bins: 3 });
  await page.goto("/");
  await expect(page.locator("#notices")).toBeHidden();
  await expect(map(page).locator(".map-legend li[data-bin]:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])")).toHaveCount(3);
  const bins = await map(page).locator("path[data-code]").evaluateAll((els) => els.map((el) => [el.getAttribute("data-code"), el.getAttribute("data-bin")]));
  const values = mapFile("origin_apps").values;
  for (const [code, bin] of bins) expect(bin, code as string).toBe(expectedBin(values[code as string][String(overview.top_year)], 4, 3));
});

test("invalid config map on the embed page: notice, default scale", async ({ page }) => {
  await patchMapConfig(page, { logBase: 10, bins: 99 });
  await page.goto("/embed.html?chart=world-map");
  await expect(page.locator("#notices")).toContainText("Invalid map.bins in config.json");
  await expect(map(page).locator('.map-legend li[data-bin="7"]')).toHaveCount(1);
  await expect(map(page).locator('.map-legend li[data-bin="8"]')).toHaveCount(0);
});

// ---- ratio metrics: per million population, per $100 billion GDP ----

const RATIO_TITLE = {
  per_million: "Resident patent applications per million population",
  per_gdp: "Resident patent applications per $100 billion GDP (PPP)",
};
const COMPUTED_BASIS = "computed from WIPO counts and World Bank WDI";
const ratioConfig: { logBase: number; bins: number; lowest: number } = config.map.ratio;
const ratioYear = (metric: "per_million" | "per_gdp"): string => String(overview.ratio_last_year[metric]);
type RatioMapFile = MapFile & { computed: Record<string, number[]>; null_reason: Record<string, Record<string, string>> };
const ratioFile = (metric: string): RatioMapFile => mapFile(metric) as RatioMapFile;

/** Expected ratio bin from config.map.ratio, written as thresholds (lowest x base ** k, rounded to strip product noise),
 * apart from mapScale.ts `ratioBinOf`. */
function expectedRatioBin(value: number | null | undefined): string {
  if (value === null || value === undefined) return "null";
  if (value <= 0) return "zero";
  const thresholds = Array.from({ length: ratioConfig.bins - 1 }, (_, index) =>
    Number((ratioConfig.lowest * ratioConfig.logBase ** (index + 1)).toPrecision(12)));
  return String(1 + thresholds.filter((threshold) => value >= threshold).length);
}

test("ratioBinOf (default ratio scale): bin edges, zero, null; labels are half-open", () => {
  expect(DEFAULT_RATIO_SCALE).toEqual(ratioConfig);
  const bins = (values: (number | null)[]) => values.map((value) => ratioBinOf(value, DEFAULT_RATIO_SCALE));
  expect(bins([0.99, 1.0, 9.99, 10, 999.9, 1000, 0, null])).toEqual(["1", "2", "2", "3", "4", "5", "zero", "null"]);
  expect(bins([0.0001, 99.99, 100, 1e9])).toEqual(["1", "3", "4", "5"]);
  expect(Array.from({ length: DEFAULT_RATIO_SCALE.bins }, (_, index) => ratioBinLabel(index + 1, DEFAULT_RATIO_SCALE)))
    .toEqual(["under 1", "1 to under 10", "10 to under 100", "100 to under 1,000", "1,000 or more"]);
  // a fractional lowest keeps clean bounds (0.01 x 10 ** 2 is 1.0000000000000002 in binary)
  const fine = { logBase: 10, bins: 4, lowest: 0.01 };
  expect(ratioBinOf(1, fine)).toBe("3");
  expect(ratioBinOf(0.1, fine)).toBe("2");
  expect([1, 2, 3, 4].map((bin) => ratioBinLabel(bin, fine))).toEqual(["under 0.1", "0.1 to under 1", "1 to under 10", "10 or more"]);
});

test("metric select lists both ratio titles; ratio metric: title, year, legend labels", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator("#world-map-metric option")).toContainText(
    ["Patent applications by applicant's origin", "Patent applications by filing office",
      "PCT applications by applicant's origin", RATIO_TITLE.per_million, RATIO_TITLE.per_gdp]);
  await page.locator("#world-map-metric").selectOption("per_million");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_million}, ${ratioYear("per_million")}`);
  await expect(page).toHaveURL(/metric=per_million/);
  await expect(map(page).locator(".map-legend li:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])"))
    .toHaveText(["under 1", "1 to under 10", "10 to under 100", "100 to under 1,000", "1,000 or more"]);
  await expect(map(page).locator('.map-legend li[data-bin="zero"]')).toHaveText("0.0");
  await expect(map(page).locator('.map-legend li[data-bin="former"]')).toHaveCount(0);
  await page.locator("#world-map-year").fill("2000");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_million}, 2000`);
  expect(errors).toEqual([]);
});

for (const [value, bin] of [[0.05, "1"], [10, "3"], [5000, "5"]] as [number, string][]) {
  test(`?metric=per_million: CH patched ${value} -> bin ${bin} (oracle from config.map.ratio)`, async ({ page }) => {
    const year = ratioYear("per_million");
    await patchData(page, "map/per_million.json", (file) => { file.values.CH[year] = value; });
    await page.goto("/?metric=per_million");
    expect(expectedRatioBin(value)).toBe(bin);
    await expect(swiss(page)).toHaveAttribute("data-bin", bin);
    await expect(swiss(page).locator("title")).toContainText("Switzerland:");
  });
}

test("?metric=per_million: CH patched 0.0 -> zero pattern, never bin 1; labelled 0.0", async ({ page }) => {
  const year = ratioYear("per_million");
  await patchData(page, "map/per_million.json", (file) => { file.values.CH[year] = 0; });
  await page.goto("/?metric=per_million");
  await expect(swiss(page)).toHaveAttribute("data-bin", "zero");
  expect(await swiss(page).evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-zero");
  await expect(swiss(page).locator("title")).toContainText("Switzerland: 0.0 ");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(figureRows(page).filter({ hasText: "Switzerland" }).locator("td").nth(2)).toHaveText("0.0");
});

test("ratio bins: every country's bin equals the oracle from the file and config (per million and per GDP, two years)", async ({ page }) => {
  for (const [metric, year] of [["per_million", ratioYear("per_million")], ["per_gdp", "2010"]]) {
    await page.goto(`/?metric=${metric}&year=${year}`);
    await expect(map(page).locator("h2")).toContainText(year);
    const values = ratioFile(metric).values;
    const bins = await map(page).locator("path[data-code], circle[data-code]")
      .evaluateAll((els) => els.map((el) => [el.getAttribute("data-code"), el.getAttribute("data-bin")]));
    expect(bins.length).toBeGreaterThan(150);
    for (const [code, bin] of bins) expect(bin, `${metric} ${code}`).toBe(expectedRatioBin(values[code as string]?.[year]));
  }
});

test("a computed cell's tooltip and table row name the computed basis; a WIPO cell names WIPO", async ({ page }) => {
  const file = ratioFile("per_gdp");
  expect(file.computed.BT).toContain(2024); // data guard: BT 2024 is one of two computed per-GDP values
  await page.goto("/?metric=per_gdp&year=2024");
  await expect(map(page).locator('[data-code="BT"] title')).toContainText(`Basis: ${COMPUTED_BASIS}`);
  await expect(swiss(page).locator("title")).toContainText("Basis: WIPO");
  await expect(swiss(page).locator("title")).not.toContainText("computed");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(map(page).locator(".chart-figures table").first().locator("thead th")).toContainText(["Country", "Code", "Basis"]);
  const basisColumn = (await map(page).locator(".chart-figures table").first().locator("thead th").allTextContents()).indexOf("Basis");
  await expect(figureRows(page).filter({ hasText: "Bhutan" }).locator("td").nth(basisColumn)).toHaveText(COMPUTED_BASIS);
  await expect(figureRows(page).filter({ hasText: "Switzerland" }).locator("td").nth(basisColumn)).toHaveText("WIPO");
});

test("M2: a count rounding to 0.0 is a null with its reason, never the zero pattern (ET per million 2013)", async ({ page }) => {
  const file = ratioFile("per_million");
  expect([file.values.ET["2013"], file.null_reason.ET["2013"], file.computed.ET.includes(2013)])
    .toEqual([null, "below_precision", false]); // data guard
  await page.goto("/?metric=per_million&year=2013");
  const ethiopia = map(page).locator('[data-code="ET"]');
  await expect(ethiopia).toHaveAttribute("data-bin", "null");
  await expect(ethiopia).toHaveAttribute("data-reason", "below_precision");
  await expect(ethiopia.locator("title")).toContainText("Ethiopia: no data reported: under 0.05 at one decimal; WIPO publishes no figure");
});

test("a below-threshold null is hatched, never coloured low; its table row names the reason", async ({ page }) => {
  const file = ratioFile("per_million");
  const year = ratioYear("per_million");
  expect([file.values.AD[year], file.null_reason.AD[year]]).toEqual([null, "below_wipo_threshold"]); // data guard
  const threshold = overview.method.ratios.wipo_threshold.population / 1e6;
  await page.goto("/?metric=per_million");
  const andorra = map(page).locator('[data-code="AD"]');
  await expect(andorra).toHaveAttribute("data-bin", "null");
  await expect(andorra).toHaveAttribute("data-reason", "below_wipo_threshold");
  expect(await andorra.evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-hatch");
  await expect(andorra.locator("title")).toContainText(`Andorra: no data reported: below WIPO's threshold (population ${threshold} million or less)`);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const row = figureRows(page).filter({ hasText: "Andorra" });
  await expect(row).toContainText(`below WIPO's threshold (population ${threshold} million or less)`);
  await expect(row.locator("td").nth(2)).toHaveText("–");
});

test("per GDP: no-GDP and no-applications nulls say why in the table (never 0)", async ({ page }) => {
  const file = ratioFile("per_gdp");
  const year = ratioYear("per_gdp");
  const reasons = Object.entries(file.null_reason).filter(([, years]) => years[year] === "no_gdp" || years[year] === "no_applications");
  expect(reasons.length).toBeGreaterThan(0);
  await page.goto("/?metric=per_gdp");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const [code, years] = reasons[0];
  const row = figureRows(page).filter({ has: page.locator("td", { hasText: new RegExp(`^${code}$`) }) });
  await expect(row.locator("td").nth(2)).toHaveText("–");
  await expect(row).toContainText(years[year] === "no_gdp" ? "no GDP data (World Bank WDI)" : "no applications reported by WIPO for this year");
});

test("?metric=per_gdp&map=continent: coloured by the group's ratio, 'n of m' reporting, computed basis", async ({ page }) => {
  const year = ratioYear("per_gdp");
  const europe = JSON.parse(readFileSync("site/data/group/europe.json", "utf8")).ratios.per_gdp;
  await page.goto("/?metric=per_gdp&map=continent");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_gdp}, by continent, ${year}`);
  const germany = map(page).locator('path[data-code="DE"]');
  await expect(germany).toHaveAttribute("data-bin", expectedRatioBin(europe.value[year]));
  const title = await germany.locator("title").textContent();
  expect(title).toContain(`Europe (Germany): ${europe.value[year].toFixed(1)}`);
  expect(title).toContain(`${europe.reporting[year]} of ${europe.members} countries reporting`);
  expect(title).toContain(`Basis: ${COMPUTED_BASIS}`);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const row = figureRows(page).filter({ hasText: "Europe" });
  await expect(row.locator("td").nth(1)).toHaveText(europe.value[year].toFixed(1));
  await expect(row.locator("td").nth(2)).toHaveText(`${europe.reporting[year]} of ${europe.members}`);
});

test("group ratio 0.0: zero pattern, never bin 1 (patched)", async ({ page }) => {
  const year = ratioYear("per_million");
  await patchData(page, "group/europe.json", (file) => { file.ratios.per_million.value[year] = 0; });
  await page.goto("/?metric=per_million&map=continent");
  await expect(map(page).locator('path[data-code="DE"]')).toHaveAttribute("data-bin", "zero");
});

test("?metric=per_million&map=continent: Africa coloured by its group ratio (oracle from file and config)", async ({ page }) => {
  const year = ratioYear("per_million");
  const africa = JSON.parse(readFileSync("site/data/group/africa.json", "utf8")).ratios.per_million;
  expect(groupsFile.items.find((group) => group.id === "africa")?.members).toContain("EG");
  await page.goto("/?metric=per_million&map=continent");
  const shape = map(page).locator('path[data-code="EG"]');
  await expect(shape).toHaveAttribute("data-bin", africa.value[year] === null ? "null" : expectedRatioBin(africa.value[year]));
});

test("group ratio null year: hatched, reason in group wording (patched floor failure)", async ({ page }) => {
  const year = ratioYear("per_million");
  await patchData(page, "group/europe.json", (file) => {
    file.ratios.per_million.value[year] = null;
    file.ratios.per_million.null_reason[year] = "below_wipo_threshold";
  });
  await page.goto("/?metric=per_million&map=continent");
  const germany = map(page).locator('path[data-code="DE"]');
  await expect(germany).toHaveAttribute("data-bin", "null");
  await expect(germany).toHaveAttribute("data-reason", "below_wipo_threshold");
  await expect(germany.locator("title")).toContainText("no data reported: reporting members' total is at or below WIPO's threshold");
});

test("ratio card: WDI credit, WIPO source and numerator source; GDP label on per GDP", async ({ page }) => {
  const manifest = JSON.parse(readFileSync("site/data/manifest.json", "utf8"));
  await page.goto("/?metric=per_gdp");
  await expect(map(page)).toContainText("Population and GDP: World Bank WDI (CC BY 4.0)");
  await expect(map(page)).toContainText(`GDP PPP, constant ${manifest.wdi_denominators.gdp_ppp.gdp_base} international $`);
  await expect(map(page)).toContainText("Source: WIPO Statistics Database");
  await expect(map(page).locator(".map-credit, .chart-credits, figcaption")).toContainText("Natural Earth");
});

test("count metrics keep their legend, labels and 'reported 0' wording", async ({ page }) => {
  await page.goto("/");
  await expect(map(page).locator('.map-legend li[data-bin="zero"]')).toHaveText("0 reported");
  await expect(map(page).locator('.map-legend li[data-bin="2"]')).toHaveText("10–99");
  await expect(map(page).locator(".map-legend-title")).toHaveText("Log scale: bins of powers of 10");
});

test("?metric=bogus: Unknown metric notice, default map", async ({ page }) => {
  await page.goto("/?metric=bogus");
  await expect(page.locator("#notices")).toContainText("Unknown metric: bogus");
  await expect(map(page).locator("h2")).toHaveText(`Patent applications by applicant's origin, ${overview.top_year}`);
});

for (const [label, ratio, message] of [
  ["bins above the themed count", { logBase: 10, bins: MAX_MAP_BINS + 1, lowest: 0.1 }, "Invalid map.ratio.bins in config.json"],
  ["logBase 1", { logBase: 1, bins: 5, lowest: 0.1 }, "Invalid map.ratio.logBase in config.json"],
  ["lowest zero", { logBase: 10, bins: 5, lowest: 0 }, "Invalid map.ratio.lowest in config.json"],
  ["lowest text", { logBase: 10, bins: 5, lowest: "low" }, "Invalid map.ratio.lowest in config.json"],
  ["ratio null", null, "Invalid map.ratio.bins in config.json"],
] as [string, unknown, string][]) {
  test(`invalid map.ratio (${label}): notice, default ratio scale; the count scale is untouched`, async ({ page }) => {
    await page.route("**/config.json", async (route) => {
      await route.fulfill({ json: { ...config, map: { ...config.map, ratio } } });
    });
    await page.goto("/?metric=per_million");
    await expect(page.locator("#notices")).toContainText(message);
    await expect(map(page).locator(".map-legend li:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])"))
      .toHaveText(["under 1", "1 to under 10", "10 to under 100", "100 to under 1,000", "1,000 or more"]);
    await page.goto("/");
    await expect(map(page).locator('.map-legend li[data-bin="7"]')).toHaveCount(1);
  });
}

test("a valid smaller map.ratio: that many bins, no notice, labels from config", async ({ page }) => {
  const ratio = { logBase: 4, bins: 3, lowest: 0.5 };
  await page.route("**/config.json", async (route) => { await route.fulfill({ json: { ...config, map: { ...config.map, ratio } } }); });
  await page.goto("/?metric=per_million");
  await expect(page.locator("#notices")).toBeHidden();
  await expect(map(page).locator(".map-legend li:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])"))
    .toHaveText(["under 2", "2 to under 8", "8 or more"]);
  await expect(map(page).locator(".map-legend-title")).toHaveText("Log scale: bins of powers of 4");
});

test("region mode and the year slider work on a ratio metric; embed shows the ratio map", async ({ page }) => {
  await page.goto("/?metric=per_million&map=region&year=2000");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_million}, by region, 2000`);
  await expect(page.locator("#notices")).toBeHidden();
  await page.goto("/embed.html?chart=world-map&metric=per_gdp");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_gdp}, ${ratioYear("per_gdp")}`);
});

// --- final review M6: ratio map files load only when a ratio metric is shown ----------------------------------------------

function mapRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const match = /\/data\/map\/([a-z_]+)\.json/.exec(request.url());
    if (match) asked.push(match[1]);
  });
  return asked;
}

test("M6: the overview loads no ratio map file until a ratio metric is chosen, then only that one", async ({ page }) => {
  const errors = trackErrors(page);
  const asked = mapRequests(page);
  await page.goto("/");
  await expect(map(page).locator(".map-legend")).toBeVisible();
  expect(asked.filter((id) => id.startsWith("per_"))).toEqual([]);
  await page.locator("#world-map-metric").selectOption("per_gdp");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_gdp}, ${ratioYear("per_gdp")}`);
  expect(asked.filter((id) => id.startsWith("per_"))).toEqual(["per_gdp"]);
  expect(errors).toEqual([]);
});

test("M6: ?metric=per_million loads that ratio file with the atlas, not the other", async ({ page }) => {
  const asked = mapRequests(page);
  await page.goto("/?metric=per_million");
  await expect(map(page).locator("h2")).toHaveText(`${RATIO_TITLE.per_million}, ${ratioYear("per_million")}`);
  expect(asked.filter((id) => id.startsWith("per_"))).toEqual(["per_million"]);
});

test("M6: a ratio file that fails when chosen: notice, the map keeps its metric", async ({ page }) => {
  await page.route("**/data/map/per_million.json", (route) => route.abort());
  await page.goto("/");
  const title = await map(page).locator("h2").textContent();
  await page.locator("#world-map-metric").selectOption("per_million");
  await expect(page.locator("#notices")).toContainText(`The figures for ${RATIO_TITLE.per_million} could not be loaded.`);
  await expect(map(page).locator("h2")).toHaveText(title ?? "");
  await expect(page.locator("#world-map-metric")).toHaveValue("origin_apps");
});

// ---- women-inventor shares: PCT applications with a woman inventor (women_any), women's share of PCT inventors (women_share) ----

type Measure = "women_any" | "women_share";
const SHARE_TITLE: Record<Measure, string> = {
  women_any: "PCT applications with at least one woman inventor",
  women_share: "Women's share of PCT inventors",
};
/** "0 of 6", "null of 6": a member count that a not-computable year must never print. */
const NO_MEMBER_COUNT = /\b(0|null|undefined) of \d/;
const SHARE_METRICS: Measure[] = ["women_any", "women_share"];
const shareConfig: Record<Measure, { step: number; bins: number }> = config.map.share;
const shareYear = (metric: Measure): string => String(overview.gender.last_year[metric]);
type ShareMapFile = MapFile & { null_reason: Record<string, Record<string, string>> };
const shareFile = (metric: Measure): ShareMapFile => mapFile(metric) as ShareMapFile;
type GenderBlock = { unlisted: string[]; value: YearMap; null_reason: Record<string, string>; reporting: Record<string, number | null>; members: number;
  coverage: Record<string, number | null>; wipo_years: number[] };
const groupGender = (id: string, metric: Measure): GenderBlock => JSON.parse(readFileSync(`site/data/group/${id}.json`, "utf8")).gender[metric];
const NOT_COMPUTABLE = "not computable (WIPO publishes no inventor counts)";
const COMPUTED_SHARE_BASIS = "computed from WIPO shares weighted by PCT publications";
const legendBins = (page: Page) => map(page).locator(".map-legend li:not([data-bin=zero]):not([data-bin=null]):not([data-bin=neutral]):not([data-bin=former])");

/** Expected share bin from config.map.share, written as thresholds (k x step) apart from mapScale.ts `shareBinOf`. */
function expectedShareBin(value: number | null | undefined, metric: Measure): string {
  if (value === null || value === undefined) return "null";
  const { step, bins } = shareConfig[metric];
  return String(1 + Array.from({ length: bins - 1 }, (_, index) => (index + 1) * step).filter((threshold) => value >= threshold).length);
}

test("shareBinOf / shareBinLabel: bin edges from config, 0.0 is bin 1, null is null; labels are half-open", () => {
  expect(DEFAULT_SHARE_SCALE).toEqual(shareConfig);
  for (const metric of SHARE_METRICS) {
    const { step, bins } = shareConfig[metric];
    const scale = shareConfig[metric];
    const of = (value: number | null) => shareBinOf(value, scale);
    expect(of(step - 0.01)).toBe("1");
    expect(of(step)).toBe("2");
    expect(of(0)).toBe("1"); // a real share: no zero state
    expect(of(step * (bins - 1))).toBe(String(bins));
    expect(of(step * bins)).toBe(String(bins));
    // edges just under and on a bound, as float values (the brief's 29.999 / 30.0 for step 10)
    expect(of(3 * step - 0.001)).toBe("3");
    expect(of(3 * step)).toBe("4");
    expect(of(100)).toBe(String(bins));
    expect(of(null)).toBe("null");
    const labels = Array.from({ length: bins }, (_, index) => shareBinLabel(index + 1, scale));
    expect(labels[0]).toBe(`under ${step}%`);
    expect(labels[1]).toBe(`${step}% to under ${2 * step}%`);
    expect(labels[bins - 1]).toBe(`${(bins - 1) * step}% or more`);
  }
  // a fractional step keeps clean bounds (3 x 0.1 is 0.30000000000000004 in binary)
  expect(shareBinOf(0.3, { step: 0.1, bins: 5 })).toBe("4");
  expect(shareBinLabel(4, { step: 0.1, bins: 5 })).toBe("0.3% to under 0.4%");
});

test("metric select lists both shares; a share metric: title says publication year, linear legend, no zero or former swatch", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator("#world-map-metric option")).toContainText(
    ["PCT applications by applicant's origin", RATIO_TITLE.per_million, RATIO_TITLE.per_gdp, SHARE_TITLE.women_any, SHARE_TITLE.women_share]);
  await page.locator("#world-map-metric").selectOption("women_any");
  const { step, bins } = shareConfig.women_any;
  // the year stays (clamped to the metric's years) when the metric changes, as for the ratios
  const kept = (metric: Measure): number => Math.min(overview.top_year, overview.gender.last_year[metric]);
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_any}, ${kept("women_any")} (publication year)`);
  await expect(page).toHaveURL(/metric=women_any/);
  await expect(legendBins(page)).toHaveText([`under ${step}%`,
    ...Array.from({ length: bins - 2 }, (_, index) => `${(index + 1) * step}% to under ${(index + 2) * step}%`), `${(bins - 1) * step}% or more`]);
  await expect(map(page).locator(".map-legend-title")).toContainText(`${step} percentage points`);
  await expect(map(page).locator(".map-legend-title")).toContainText("publication year");
  await expect(map(page).locator('.map-legend li[data-bin="zero"]')).toHaveCount(0);
  await expect(map(page).locator('.map-legend li[data-bin="former"]')).toHaveCount(0);
  await expect(map(page).locator('.map-legend li[data-bin="null"]')).toContainText("No data reported");
  await page.locator("#world-map-metric").selectOption("women_share");
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_share}, ${kept("women_share")} (publication year)`);
  await expect(legendBins(page).first()).toHaveText(`under ${shareConfig.women_share.step}%`);
  expect(errors).toEqual([]);
});

for (const metric of SHARE_METRICS) {
  test(`?metric=${metric}: CH patched 0.0 is bin 1 (a real share), never a zero state`, async ({ page }) => {
    const year = shareYear(metric);
    await patchData(page, `map/${metric}.json`, (file) => { file.values.CH[year] = 0; file.null_reason.CH = {}; });
    await page.goto(`/?metric=${metric}`);
    await expect(swiss(page)).toHaveAttribute("data-bin", "1");
    expect(await swiss(page).evaluate((el) => getComputedStyle(el).fill)).not.toContain("world-map-");
    await expect(swiss(page).locator("title")).toContainText("Switzerland: 0.0%");
  });

  test(`${metric}: CH from the file -> its bin; all countries equal the oracle (two years)`, async ({ page }) => {
    const values = shareFile(metric).values;
    const ch = values.CH[shareYear(metric)] as number;
    expect(ch).not.toBeNull();
    for (const year of [shareYear(metric), "2010"]) {
      await page.goto(`/?metric=${metric}&year=${year}`);
      await expect(map(page).locator("h2")).toContainText(year);
      const bins = await map(page).locator("path[data-code], circle[data-code]")
        .evaluateAll((els) => els.map((el) => [el.getAttribute("data-code"), el.getAttribute("data-bin")]));
      expect(bins.length).toBeGreaterThan(150);
      for (const [code, bin] of bins) expect(bin, `${metric} ${year} ${code}`).toBe(expectedShareBin(values[code as string]?.[year], metric));
      expect(await swiss(page).getAttribute("data-bin")).toBe(expectedShareBin(values.CH[year], metric));
      await expect(swiss(page).locator("title")).toContainText(`Switzerland: ${(values.CH[year] as number).toFixed(1)}% (${year}); Basis: WIPO`);
    }
  });
}

test("a country year WIPO does not publish: hatched, reason in the tooltip and the table, never a colour bin or 0", async ({ page }) => {
  const year = shareYear("women_any");
  await patchData(page, "map/women_any.json", (file) => { file.values.CH[year] = null; file.null_reason.CH = { [year]: "not_published" }; });
  await page.goto("/?metric=women_any");
  await expect(swiss(page)).toHaveAttribute("data-bin", "null");
  await expect(swiss(page)).toHaveAttribute("data-reason", "not_published");
  expect(await swiss(page).evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-hatch");
  await expect(swiss(page).locator("title")).toHaveText(`Switzerland: no data reported: not published by WIPO for this year (${year})`);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const row = figureRows(page).filter({ hasText: "Switzerland" });
  await expect(row.locator("td").nth(2)).toHaveText("–");
  await expect(row).toContainText("not published by WIPO for this year");
});

test("country table of a share metric: share with %, Basis WIPO, source line, caveat", async ({ page }) => {
  await page.goto("/?metric=women_share");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const head = map(page).locator(".chart-figures table").first().locator("thead th");
  await expect(head).toContainText(["Country", "Code", `Share, ${shareYear("women_share")} (publication year)`, "Basis"]);
  const value = shareFile("women_share").values.CH[shareYear("women_share")] as number;
  await expect(figureRows(page).filter({ hasText: "Switzerland" }).locator("td").nth(2)).toHaveText(`${value.toFixed(1)}%`);
  await expect(figureRows(page).filter({ hasText: "Switzerland" }).locator("td").nth(3)).toHaveText("WIPO");
  await expect(map(page)).toContainText("Gender is attributed by WIPO (method:");
  await expect(map(page).locator(".chart-footnote", { hasText: "Gender is attributed by WIPO" })).toHaveCount(1);
  await expect(map(page)).toContainText("Source: WIPO Statistics Database");
});

test("women_share region mode: Northern America (021) 2025 shows WIPO's printed value; every other region is not computable", async ({ page }) => {
  const errors = trackErrors(page);
  const year = shareYear("women_share");
  await page.goto("/?metric=women_share&map=region");
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_share}, by region, ${year} (publication year)`);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const regions = groupsFile.items.filter((group) => group.kind === "region");
  expect(await figureRows(page).count()).toBe(regions.length);
  const head = await map(page).locator(".chart-figures table").first().locator("thead th").allTextContents();
  const column = (name: string): number => head.indexOf(name);
  for (const region of regions) {
    const block = groupGender(region.id, "women_share");
    const row = figureRows(page).filter({ has: page.locator("td", { hasText: new RegExp(`^${region.label}$`) }) });
    const value = block.value[year];
    if (block.wipo_years.includes(Number(year))) {
      expect(region.id).toBe("021");
      expect(value).not.toBeNull();
      await expect(row.locator("td").nth(1)).toHaveText(`${(value as number).toFixed(1)}%`);
      await expect(row.locator("td").nth(column("Basis"))).toHaveText("WIPO");
    } else {
      expect(value, region.id).toBeNull();
      expect(block.null_reason[year], region.id).toBe("not_computable");
      await expect(row.locator("td").nth(1)).toHaveText("–");
      await expect(row).toContainText(NOT_COMPUTABLE);
      await expect(row.locator("td").nth(column("Basis"))).toHaveText("–");
      // not computable = no member count: never "0 of m", never "null of m"
      expect(block.reporting[year], region.id).toBeNull();
      await expect(row.locator("td").nth(column("Members reporting"))).toHaveText("–");
      await expect(row.locator("td").nth(column("Coverage"))).toHaveText("–");
    }
  }
  await expect(map(page).locator(".chart-figures table").first()).not.toContainText(NO_MEMBER_COUNT);
  // map: 021's members coloured by the printed value, the rest hatched with the reason in the tooltip
  const value021 = groupGender("021", "women_share").value[year] as number;
  for (const code of groupsFile.items.find((group) => group.id === "021")!.members) {
    await expect(map(page).locator(`[data-code="${code}"]`)).toHaveAttribute("data-bin", expectedShareBin(value021, "women_share"));
    await expect(map(page).locator(`[data-code="${code}"] title`)).toContainText("Basis: WIPO");
  }
  await expect(swiss(page)).toHaveAttribute("data-bin", "null");
  await expect(swiss(page)).toHaveAttribute("data-reason", "not_computable");
  await expect(swiss(page).locator("title")).toContainText(NOT_COMPUTABLE);
  await expect(swiss(page).locator("title")).not.toContainText(NO_MEMBER_COUNT);
  expect(errors).toEqual([]);
});

test("women_share continent mode: WIPO's printed continent values in 2025 (labelled WIPO, cited), not computable in other years", async ({ page }) => {
  const year = shareYear("women_share");
  await page.goto("/?metric=women_share&map=continent");
  const continents = groupsFile.items.filter((group) => group.kind === "continent");
  for (const continent of continents) {
    const block = groupGender(continent.id, "women_share");
    expect(block.wipo_years).toContain(Number(year));
    const member = continent.members[0];
    await expect(map(page).locator(`[data-code="${member}"]`)).toHaveAttribute("data-bin", expectedShareBin(block.value[year], "women_share"));
    await expect(map(page).locator(`[data-code="${member}"] title`)).toContainText(`${(block.value[year] as number).toFixed(1)}%`);
    await expect(map(page).locator(`[data-code="${member}"] title`)).toContainText("Basis: WIPO");
  }
  await expect(map(page)).toContainText("PCT Yearly Review 2026"); // the printed figure's citation
  await page.goto("/?metric=women_share&map=continent&year=2020");
  await expect(swiss(page)).toHaveAttribute("data-bin", "null");
  await expect(swiss(page).locator("title")).toContainText(NOT_COMPUTABLE);
  await expect(swiss(page).locator("title")).not.toContainText(NO_MEMBER_COUNT);
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const headCells = await map(page).locator(".chart-figures table").first().locator("thead th").allTextContents();
  const europeRow = figureRows(page).filter({ has: page.locator("td", { hasText: /^Europe$/ }) });
  await expect(europeRow.locator("td").nth(headCells.indexOf("Members reporting"))).toHaveText("–");
  await expect(europeRow.locator("td").nth(headCells.indexOf("Coverage"))).toHaveText("–");
  await expect(map(page).locator(".chart-figures table").first()).not.toContainText(NO_MEMBER_COUNT);
});

test("women_any continent mode: coloured by the computed group value; tooltip and table carry Basis, n of m and coverage; left-out members named", async ({ page }) => {
  const errors = trackErrors(page);
  const year = "2020";
  await page.goto(`/?metric=women_any&map=continent&year=${year}`);
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_any}, by continent, ${year} (publication year)`);
  const africa = groupGender("africa", "women_any");
  expect(africa.value[year]).not.toBeNull();
  expect(africa.wipo_years).not.toContain(Number(year));
  const coverage = `${(100 * (africa.coverage[year] as number)).toFixed(1)}%`;
  const tooltip = map(page).locator('path[data-code="NG"] title');
  await expect(tooltip).toContainText(`Africa (Nigeria): ${(africa.value[year] as number).toFixed(1)}% (${year})`);
  await expect(tooltip).toContainText(`Basis: ${COMPUTED_SHARE_BASIS}`);
  await expect(tooltip).toContainText(`${africa.reporting[year]} of ${africa.members} members`);
  await expect(tooltip).toContainText(`coverage ${coverage}`);
  await expect(map(page).locator('path[data-code="NG"]')).toHaveAttribute("data-bin", expectedShareBin(africa.value[year], "women_any"));
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const head = await map(page).locator(".chart-figures table").first().locator("thead th").allTextContents();
  expect(head).toEqual(expect.arrayContaining(["Members reporting", "Coverage", "Basis", "Note"]));
  const row = figureRows(page).filter({ has: page.locator("td", { hasText: /^Africa$/ }) });
  await expect(row.locator("td").nth(head.indexOf("Members reporting"))).toHaveText(`${africa.reporting[year]} of ${africa.members}`);
  await expect(row.locator("td").nth(head.indexOf("Coverage"))).toHaveText(coverage);
  await expect(row.locator("td").nth(head.indexOf("Basis"))).toHaveText(COMPUTED_SHARE_BASIS);
  // "m" counts the members with a PCT publications row; those the group file lists as `unlisted` are named, as on the group page
  const withUnlisted = groupsFile.items.filter((group) => group.kind === "continent" && groupGender(group.id, "women_any").unlisted.length > 0);
  expect(withUnlisted.length, "a continent with an unlisted member").toBeGreaterThan(0);
  for (const group of withUnlisted) {
    const block = groupGender(group.id, "women_any");
    expect(block.members + block.unlisted.length).toBe(group.members.length);
    const note = map(page).locator(".chart-footnote", { hasText: `${group.label}: “n of m”` });
    await expect(note).toContainText(`of the ${block.members} members with PCT publications data`);
    for (const code of block.unlisted) await expect(note).toContainText(`${LABELS.get(code)} (${code})`);
  }
  expect(errors).toEqual([]);
});

test("the map's left-out members follow the group file's unlisted field, not the PCT origin file", async ({ page }) => {
  await patchData(page, "group/africa.json", (file) => { file.gender.women_any.unlisted = ["NG"]; });
  await patchData(page, "map/pct_origin.json", (file) => { delete file.values.KE; });
  await page.goto(`/?metric=women_any&map=continent&year=2020`);
  const note = map(page).locator(".chart-footnote", { hasText: "Africa: “n of m”" });
  await expect(note).toContainText(`${LABELS.get("NG")} (NG)`);
  await expect(note).not.toContainText(`${LABELS.get("KE")} (KE)`);
});

test("a group year with too little coverage: hatched with the low-coverage reason, coverage shown", async ({ page }) => {
  const year = "2020";
  await patchData(page, "group/africa.json", (file) => {
    file.gender.women_any.value[year] = null;
    file.gender.women_any.null_reason[year] = "low_coverage";
  });
  await page.goto(`/?metric=women_any&map=continent&year=${year}`);
  await expect(map(page).locator('path[data-code="NG"]')).toHaveAttribute("data-bin", "null");
  await expect(map(page).locator('path[data-code="NG"] title')).toContainText("members with a published share hold under");
  await expect(map(page).locator('path[data-code="NG"] title')).toContainText("no data reported");
});

test("a successor of a former entity is never 'reported under' on a share metric", async ({ page }) => {
  const [former, successors] = Object.entries(groupsFile.successors).find(([, list]) => list.some((item) => item.to_year >= 2001))!;
  const successor = successors.find((item) => item.to_year >= 2001)!;
  const year = "2001";
  expect(successor.from_year).toBeLessThanOrEqual(2001);
  await patchData(page, "map/women_any.json", (file) => {
    file.values[former] = { [year]: 40 };
    file.values[successor.code] = { ...(file.values[successor.code] ?? {}), [year]: null, "2010": 30 };
    file.null_reason[successor.code] = { [year]: "not_published" };
  });
  await page.goto(`/?metric=women_any&year=${year}`);
  const shape = map(page).locator(`[data-code="${successor.code}"]`);
  await expect(shape.first()).toHaveAttribute("data-bin", "null");
  await expect(shape.first().locator("title")).not.toContainText("reported under");
  await expect(map(page).locator('.map-legend li[data-bin="former"]')).toHaveCount(0);
  await expect(map(page).locator('[data-bin="former"]')).toHaveCount(0);
});

test("invalid map.share: notice per bad value, default scale drawn; the count and ratio scales are untouched", async ({ page }) => {
  await patchMapConfig(page, { ...config.map, share: { women_any: { step: -1, bins: MAX_MAP_BINS + 1 }, women_share: null } });
  await page.goto("/?metric=women_any");
  await expect(page.locator("#notices")).toContainText("Invalid map.share.women_any.step in config.json");
  await expect(page.locator("#notices")).toContainText("Invalid map.share.women_any.bins in config.json");
  await expect(page.locator("#notices")).toContainText("Invalid map.share.women_share.step in config.json");
  const { step, bins } = shareConfig.women_any;
  await expect(legendBins(page)).toHaveCount(bins);
  await expect(legendBins(page).first()).toHaveText(`under ${step}%`);
  await page.goto("/");
  await expect(map(page).locator('.map-legend li[data-bin="7"]')).toHaveCount(1);
  await page.goto("/?metric=per_million");
  await expect(legendBins(page).first()).toHaveText("under 1");
});

test("a valid other map.share: that many bins, labels from config, no notice; an absent map.share is the default, silently", async ({ page }) => {
  await patchMapConfig(page, { ...config.map, share: { women_any: { step: 25, bins: 3 }, women_share: { step: 5, bins: 6 } } });
  await page.goto("/?metric=women_any");
  await expect(page.locator("#notices")).toBeHidden();
  await expect(legendBins(page)).toHaveText(["under 25%", "25% to under 50%", "50% or more"]);
  const values = shareFile("women_any").values;
  const year = shareYear("women_any");
  const bins = await map(page).locator("path[data-code]").evaluateAll((els) => els.map((el) => [el.getAttribute("data-code"), el.getAttribute("data-bin")]));
  for (const [code, bin] of bins) {
    const value = values[code as string]?.[year];
    expect(bin, code as string).toBe(value === null || value === undefined ? "null" : String(1 + [25, 50].filter((t) => value >= t).length));
  }
  const { share: _share, ...withoutShare } = config.map;
  await patchMapConfig(page, withoutShare);
  await page.goto("/?metric=women_any");
  await expect(page.locator("#notices")).toBeHidden();
  await expect(legendBins(page)).toHaveCount(shareConfig.women_any.bins);
});

test("share maps are fetched only when a share metric is shown, then only that one", async ({ page }) => {
  const errors = trackErrors(page);
  const asked = mapRequests(page);
  await page.goto("/");
  await expect(map(page).locator(".map-legend")).toBeVisible();
  expect(asked.filter((id) => id.startsWith("women_"))).toEqual([]);
  await page.locator("#world-map-metric").selectOption("women_share");
  await expect(map(page).locator("h2")).toContainText(SHARE_TITLE.women_share);
  expect(asked.filter((id) => id.startsWith("women_"))).toEqual(["women_share"]);
  await page.locator("#world-map-metric").selectOption("per_gdp");
  await expect(map(page).locator("h2")).toContainText(RATIO_TITLE.per_gdp);
  await page.locator("#world-map-metric").selectOption("women_share");
  expect(asked.filter((id) => id.startsWith("women_"))).toEqual(["women_share"]);
  expect(errors).toEqual([]);
});

test("?metric=women_any loads that share file with the atlas, not the other", async ({ page }) => {
  const asked = mapRequests(page);
  await page.goto("/?metric=women_any");
  await expect(map(page).locator("h2")).toContainText(SHARE_TITLE.women_any);
  expect(asked.filter((id) => id.startsWith("women_"))).toEqual(["women_any"]);
});

test("a share file that fails when chosen: notice, the map keeps its metric", async ({ page }) => {
  await page.route("**/data/map/women_share.json", (route) => route.abort());
  await page.goto("/");
  const title = await map(page).locator("h2").textContent();
  await page.locator("#world-map-metric").selectOption("women_share");
  await expect(page.locator("#notices")).toContainText(`The figures for ${SHARE_TITLE.women_share} could not be loaded.`);
  await expect(map(page).locator("h2")).toHaveText(title ?? "");
  await expect(page.locator("#world-map-metric")).toHaveValue("origin_apps");
});

test("year slider and mode control on a share metric; embed shows the share map; wallboard-style address works", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?metric=women_any");
  await page.locator("#world-map-year").fill("2005");
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_any}, 2005 (publication year)`);
  await expect(page).toHaveURL(/year=2005/);
  await page.locator("#world-map-mode").selectOption("continent");
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_any}, by continent, 2005 (publication year)`);
  await expect(page).toHaveURL(/map=continent/);
  await page.goto("/embed.html?chart=world-map&metric=women_share");
  await expect(map(page).locator("h2")).toHaveText(`${SHARE_TITLE.women_share}, ${shareYear("women_share")} (publication year)`);
  expect(errors).toEqual([]);
});

test("a year outside a share metric's data is clamped with a notice", async ({ page }) => {
  await page.goto("/?metric=women_share&year=1999");
  await expect(page.locator("#notices")).toContainText(`No map data for 1999 (${SHARE_TITLE.women_share})`);
});

for (const [metric, kind, year] of [["women_any", "continent", "2020"], ["women_any", "region", "2015"], ["women_share", "region", "2025"]] as [Measure, string, string][]) {
  test(`${metric} ${kind} mode ${year}: every group's colour, Basis, n of m and coverage equal its group file`, async ({ page }) => {
    await page.goto(`/?metric=${metric}&map=${kind}&year=${year}`);
    await expect(map(page).locator("h2")).toContainText(year);
    const drawn = new Set(await map(page).locator("[data-code]").evaluateAll((els) => els.map((el) => el.getAttribute("data-code") as string)));
    for (const group of groupsFile.items.filter((item) => item.kind === kind)) {
      const block = groupGender(group.id, metric);
      const value = block.value[year];
      const member = group.members.find((code) => drawn.has(code));
      expect(member, `${group.id} has a drawn member`).toBeTruthy();
      const shape = map(page).locator(`[data-code="${member}"]`);
      await expect(shape, group.id).toHaveAttribute("data-bin", expectedShareBin(value, metric));
      const tip = shape.locator("title");
      if (value === null) {
        await expect(tip, group.id).toContainText("no data reported");
        await expect(tip, group.id).not.toContainText("Basis:");
      } else {
        await expect(tip, group.id).toContainText(`(${LABELS.get(member!)}): ${value.toFixed(1)}% (${year})`);
        await expect(tip, group.id).toContainText(block.wipo_years.includes(Number(year)) ? "Basis: WIPO" : `Basis: ${COMPUTED_SHARE_BASIS}`);
      }
      const reporting = block.reporting[year];
      if (reporting !== null && reporting !== undefined) {
        await expect(tip, group.id).toContainText(`${reporting} of ${block.members} members`);
        if (reporting > 0) await expect(tip, group.id).toContainText(`coverage ${(100 * (block.coverage[year] as number)).toFixed(1)}%`);
      } else {
        await expect(tip, group.id).not.toContainText(/\d+ of \d+ members|null of/);
      }
    }
  });
}

test("a group file with no gender block: its countries read no data reported, never 'in no continent'", async ({ page }) => {
  await patchData(page, "group/africa.json", (file) => { delete file.gender; });
  await page.goto("/?metric=women_any&map=continent&year=2020");
  const tip = map(page).locator('path[data-code="NG"] title');
  await expect(tip).toContainText("Africa (Nigeria): no data reported");
  await expect(tip).not.toContainText("in no continent");
  await expect(map(page).locator('path[data-code="NG"]')).toHaveAttribute("data-bin", "null");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(figureRows(page).filter({ has: page.locator("td", { hasText: /^Africa$/ }) })).toContainText("no figures of this measure");
});

// ---- PCT membership (map/pct_member.json, overview pct_membership): country mode only; member fill, non-member pattern ----

type MemberFile = {
  values: Record<string, Record<string, boolean | null>>; null_reason: Record<string, string>; in_force: Record<string, string>;
  unmatched: string[]; sources: { pct_member: { source_url: string; status_on: string; retrieved: string } };
};
const memberFile = (): MemberFile => mapFile("pct_member") as unknown as MemberFile;
const pct = overview.pct_membership;
const PCT_TITLE = "PCT membership";
/** Treaty in force (pipeline constant), read from the pipeline source: the slider's first year. */
const PCT_FIRST_YEAR = Number(/^PCT_FIRST_YEAR = (\d+)/m.exec(readFileSync("pipeline/pct_states.py", "utf8"))![1]);
const lastPct = String(pct.last_year);
const SPECIAL_PATTERNS = ["world-map-hatch", "world-map-neutral", "world-map-zero", "world-map-former"];

/** Expected data-bin from the file, written apart from map.ts: true member, false non-member, null or absent no data. */
function expectedMemberBin(file: MemberFile, code: string, year: string): string {
  const value = file.values[code]?.[year];
  return value === true ? "member" : value === false ? "nonmember" : "null";
}

/** Count note of a year: the latest year is "as of" the status date. */
function pctCountText(year: string): string {
  return year === lastPct ? `${pct.count[year]} PCT Contracting States as of ${pct.status_on}`
    : `${pct.count[year]} PCT Contracting States in ${year}`;
}

const drawnBins = (page: Page) => map(page).locator("path[data-code], circle[data-code]")
  .evaluateAll((els) => els.map((el) => ({ code: el.getAttribute("data-code") ?? "", bin: el.getAttribute("data-bin") ?? "",
    tip: el.querySelector("title")?.textContent ?? "" })));

test("PCT membership: metric select lists it; title and year slider first_year..last_year from the data", async ({ page }) => {
  const errors = trackErrors(page);
  expect(pct.first_year).toBe(PCT_FIRST_YEAR);
  await page.goto("/");
  await expect(page.locator('#world-map-metric option[value="pct_member"]')).toHaveText(PCT_TITLE);
  await expect(page.locator("#world-map-metric option").last()).toHaveText(PCT_TITLE);
  await page.locator("#world-map-metric").selectOption("pct_member");
  // the year stays (clamped to the metric's years) when the metric changes
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${Math.min(overview.top_year, pct.last_year)}`);
  await expect(page).toHaveURL(/metric=pct_member/);
  await page.goto("/?metric=pct_member");
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${pct.last_year}`);
  await expect(page.locator("#world-map-year")).toHaveAttribute("min", String(PCT_FIRST_YEAR));
  await expect(page.locator("#world-map-year")).toHaveAttribute("max", lastPct);
  await page.goto(`/?metric=pct_member&year=${PCT_FIRST_YEAR - 1}`);
  await expect(page.locator("#notices")).toContainText(`No map data for ${PCT_FIRST_YEAR - 1} (${PCT_TITLE}): showing ${PCT_FIRST_YEAR}.`);
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${PCT_FIRST_YEAR}`);
  expect(errors).toEqual([]);
});

test("PCT membership: every country is member fill, non-member pattern or no-data hatch; bins equal the map file (latest year, 1990)", async ({ page }) => {
  const errors = trackErrors(page);
  const file = memberFile();
  for (const year of [lastPct, "1990"]) {
    await page.goto(`/?metric=pct_member&year=${year}`);
    await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${year}`);
    const drawn = await drawnBins(page);
    expect(drawn.length).toBeGreaterThan(150);
    for (const { code, bin } of drawn) expect(bin, `${year} ${code}`).toBe(expectedMemberBin(file, code, year));
    expect(new Set(drawn.map(({ bin }) => bin))).toEqual(new Set(["member", "nonmember"]));
    const fillOf = (bin: string) => map(page).locator(`path[data-bin="${bin}"]`).first().evaluate((el) => getComputedStyle(el).fill);
    const swatchFill = (bin: string) => map(page).locator(`.map-legend li[data-bin="${bin}"] rect`).evaluate((el) => getComputedStyle(el).fill);
    expect(await fillOf("member")).not.toContain("url(");
    expect(await fillOf("member")).toBe(await swatchFill("member"));
    expect(await fillOf("nonmember")).toContain("world-map-nonmember");
  }
  // legend: member, non-member, no data, and the neutral areas drawn on every map; no count bins, zero or former swatch
  await expect(map(page).locator(".map-legend li")).toHaveText(
    ["PCT member", "Not a PCT member", "No data (reason in the tooltip and figures)", "Area without a WIPO country code"]);
  expect(errors).toEqual([]);
});

test("PCT membership: Bahamas a member in its in-force year, not the year before", async ({ page }) => {
  const inForce = memberFile().in_force.BS;
  const year = Number(inForce.slice(0, 4));
  const bahamas = map(page).locator('[data-code="BS"]');
  await page.goto(`/?metric=pct_member&year=${year}`);
  await expect(bahamas).toHaveAttribute("data-bin", "member");
  await expect(bahamas.locator("title")).toHaveText(`${LABELS.get("BS")}: Member since ${inForce}`);
  await page.goto(`/?metric=pct_member&year=${year - 1}`);
  await expect(bahamas).toHaveAttribute("data-bin", "nonmember");
  await expect(bahamas.locator("title")).toHaveText(`${LABELS.get("BS")}: Not a PCT member in ${year - 1} (entry into force ${inForce})`);
});

test("PCT non-member pattern: defined on every map, its marks differ by geometry from the other special-state patterns", async ({ page }) => {
  await page.goto("/");
  await expect(map(page).locator("pattern#world-map-nonmember")).toHaveCount(1);
  // geometry = the mark elements (ground rect left out) and the pattern's rotation
  const geometry = (id: string) => map(page).locator(`pattern#${id}`).evaluate((pattern) =>
    `${[...pattern.children].filter((el) => !/-bg$/.test(el.getAttribute("class") ?? "")).map((el) => el.tagName).join(",")}` +
    `|${pattern.getAttribute("patternTransform") ?? ""}`);
  const own = await geometry("world-map-nonmember");
  for (const id of SPECIAL_PATTERNS) expect(own, id).not.toBe(await geometry(id));
  // no line and no dot: not a hatch at another angle, not the zero dots
  expect(own).not.toMatch(/line|circle/);
  const fill = (selector: string) => map(page).locator(selector).first().evaluate((el) => getComputedStyle(el).fill);
  expect(await fill("pattern#world-map-nonmember .map-nonmember-mark")).not.toBe(await fill("pattern#world-map-nonmember .map-nonmember-bg"));
});

test("PCT membership: tooltip and figures table name the entry-into-force date", async ({ page }) => {
  const file = memberFile();
  await page.goto("/?metric=pct_member");
  await expect(swiss(page).locator("title")).toHaveText(`Switzerland: Member since ${file.in_force.CH}`);
  for (const { code, bin, tip } of await drawnBins(page)) {
    const label = LABELS.get(code);
    expect(tip, code).toBe(bin === "member" ? `${label}: Member since ${file.in_force[code]}`
      : `${label}: Not a PCT member in ${lastPct}${file.in_force[code] ? ` (entry into force ${file.in_force[code]})` : ""}`);
  }
  await map(page).getByRole("button", { name: "Show figures" }).click();
  await expect(map(page).locator(".chart-figures table").first().locator("thead th")).toHaveText(
    ["Country", `PCT member ${lastPct}`, "Entry into force"]);
  await expect(figureRows(page).filter({ hasText: "Switzerland" }).locator("td")).toHaveText(["Switzerland", "Yes", file.in_force.CH]);
  const countries = Object.keys(file.values).filter((code) => COUNTRIES.has(code) && COUNTRIES.get(code)!.iso_numeric);
  await expect(figureRows(page)).toHaveCount(countries.length);
  const members = countries.filter((code) => file.values[code][lastPct] === true);
  await expect(figureRows(page).filter({ has: page.locator("td:nth-child(2)", { hasText: /^Yes$/ }) })).toHaveCount(members.length);
  const outsider = countries.find((code) => file.values[code][lastPct] === false && !file.in_force[code])!;
  const outsiderRow = figureRows(page).filter({ has: page.getByRole("cell", { name: LABELS.get(outsider), exact: true }) });
  await expect(outsiderRow.locator("td")).toHaveText([LABELS.get(outsider)!, "No", "–"]);
});

test("PCT membership: the note's count equals overview pct_membership.count of the year; continuing States in the notes", async ({ page }) => {
  for (const year of [lastPct, "1990", String(PCT_FIRST_YEAR)]) {
    await page.goto(`/?metric=pct_member&year=${year}`);
    await expect(map(page).locator(".chart-note")).toContainText(pctCountText(year));
    await expect(map(page).locator(".chart-note")).toContainText("31 December");
  }
  for (const state of pct.continuing) await expect(map(page).locator(".card-details")).toContainText(`${state.name} (continuing ${state.continues})`);
  await expect(map(page).locator(".card-details")).toContainText("date as printed by WIPO");
});

test("PCT membership: source line names WIPO's list and its count and status date, linked, never fetched; cite text names the list", async ({ page }) => {
  const wipo: string[] = [];
  page.on("request", (request) => { if (/wipo\.int/.test(request.url())) wipo.push(request.url()); });
  await page.goto("/?metric=pct_member");
  const line = map(page).locator("figcaption .source-line");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(new RegExp(`^Source: WIPO, PCT Contracting States\\. ${pct.count[lastPct]} States on ${pct.status_on} ` +
    `\\(retrieved ${pct.retrieved}, data version \\S+\\); analysis: Patent Atlas$`));
  await expect(line.locator("a")).toHaveAttribute("href", pct.source_url);
  await expect(line.locator("a")).toHaveText("WIPO, PCT Contracting States");
  await expect(line).not.toContainText("WIPO Statistics Database");
  // no WIPO Data Center query: the list has none
  await expect(map(page).locator(".chart-query")).toHaveCount(0);
  const cite = map(page).locator(".cite-text");
  await expect(cite).toContainText(`Data: WIPO, PCT Contracting States, ${pct.count[lastPct]} States on ${pct.status_on} (${pct.source_url}), retrieved ${pct.retrieved}`);
  await expect(cite).not.toContainText("WIPO Statistics Database");
  // the page keeps WIPO's disclaimer and the other cards their Statistics Database source
  await expect(page.locator("body")).toContainText("WIPO Statistics Database");
  await expect(page.locator(".disclaimer").first()).toContainText("The Secretariat of WIPO assumes no liability");
  expect(wipo).toEqual([]);
});

test("PCT membership: a former entity is never a non-member: no-data hatch with its reason (patched onto CH); the former-entities table names the reason", async ({ page }) => {
  const file = memberFile();
  const formers = Object.keys(file.null_reason);
  expect(formers.length).toBeGreaterThan(0);
  await page.goto("/?metric=pct_member&year=1990");
  for (const { code, bin } of await drawnBins(page)) if (formers.includes(code)) expect(bin, code).toBe("null");
  await map(page).getByRole("button", { name: "Show figures" }).click();
  const formerRows = map(page).locator(".chart-figures table").nth(1).locator("tbody tr");
  await expect(formerRows).toHaveCount(formers.length);
  for (const code of formers) {
    const row = formerRows.filter({ hasText: `(${code})` });
    await expect(row.locator("td").nth(1)).toHaveText("–");
    await expect(row.locator("td").nth(2)).toHaveText("not on WIPO's current list of PCT Contracting States (former State)");
  }
  await patchData(page, "map/pct_member.json", (data) => {
    for (const year of Object.keys(data.values.CH)) data.values.CH[year] = null;
    data.null_reason.CH = "not_on_current_list";
  });
  await page.goto("/?metric=pct_member&year=1990");
  await expect(swiss(page)).toHaveAttribute("data-bin", "null");
  await expect(swiss(page)).toHaveAttribute("data-reason", "not_on_current_list");
  expect(await swiss(page).evaluate((el) => getComputedStyle(el).fill)).toContain("world-map-hatch");
  await expect(swiss(page).locator("title")).toHaveText("Switzerland: no data: not on WIPO's current list of PCT Contracting States (former State) (1990)");
});

test("PCT membership: codes with no WIPO entity are named under the map (patched)", async ({ page }) => {
  await page.goto("/?metric=pct_member");
  await expect(map(page).locator(".map-unmatched")).toHaveCount(memberFile().unmatched.length ? 1 : 0);
  await patchData(page, "map/pct_member.json", (data) => { data.unmatched = ["QZ", "XQ"]; });
  await page.goto("/?metric=pct_member");
  await expect(map(page).locator(".map-unmatched")).toHaveText("PCT States not on the map (no WIPO statistics entity): QZ, XQ.");
});

test("PCT membership in region mode: notice, countries; region and continent disabled", async ({ page }) => {
  await page.goto("/?metric=pct_member&map=region");
  await expect(page.locator("#notices")).toContainText(`Map mode “region” is not available for ${PCT_TITLE}: showing countries.`);
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${lastPct}`);
  await expect(page.locator('#world-map-mode option[value="region"]')).toHaveAttribute("disabled", "");
  await expect(page.locator('#world-map-mode option[value="continent"]')).toHaveAttribute("disabled", "");
  await page.goto("/?map=continent");
  await page.locator("#world-map-metric").selectOption("pct_member");
  await expect(page.locator("#notices")).toContainText(`Map mode “continent” is not available for ${PCT_TITLE}: showing countries.`);
  await expect(map(page).locator('path[data-code="CH"]')).toHaveAttribute("data-bin", "member");
  await expect(page).not.toHaveURL(/map=continent/);
});

test("PCT membership file loads only when the metric is shown; embed: no controls, list link opens a new tab, disclaimer", async ({ page }) => {
  const errors = trackErrors(page);
  const asked = mapRequests(page);
  await page.goto("/");
  await expect(map(page).locator(".map-legend")).toBeVisible();
  expect(asked).not.toContain("pct_member");
  await page.locator("#world-map-metric").selectOption("pct_member");
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${Math.min(overview.top_year, pct.last_year)}`);
  expect(asked.filter((id) => id === "pct_member")).toEqual(["pct_member"]);
  await page.goto("/embed.html?chart=world-map&metric=pct_member");
  await expect(map(page).locator("h2")).toHaveText(`${PCT_TITLE}, ${lastPct}`);
  await expect(page.locator("#world-map-year")).toHaveCount(0);
  await expect(map(page).locator('path[data-code="CH"]')).toHaveAttribute("data-bin", "member");
  await expect(map(page).locator(".source-line a")).toHaveAttribute("target", "_blank");
  await expect(map(page).locator(".source-line a")).toHaveAttribute("rel", "noopener");
  await expect(page.locator("body")).toContainText("The Secretariat of WIPO assumes no liability");
  expect(errors).toEqual([]);
});

test("PCT membership map fits a phone screen without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?metric=pct_member");
  await expect(map(page).locator(".map-svg")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const theme of config.themes as string[]) {
  test(`${theme}: PCT member fill >= 3:1 on the card (WCAG 1.4.11)`, async ({ page }) => {
    await page.goto(`/?theme=${theme}&metric=pct_member`);
    const member = map(page).locator('path[data-bin="member"]').first();
    await expect(member).toBeVisible();
    const card = await map(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(contrast(await member.evaluate((el) => getComputedStyle(el).fill), card), `${theme} member fill vs card`).toBeGreaterThanOrEqual(3);
  });
}
