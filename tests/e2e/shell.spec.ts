import { test, expect, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { DEFAULT_MAP_SCALE } from "../../site/src/mapScale";

const DISCLAIMER =
  "The Secretariat of WIPO assumes no liability or responsibility with regard to the transformation or translation of the original content.";
const manifest = JSON.parse(readFileSync("site/data/manifest.json", "utf8"));
const config = JSON.parse(readFileSync("site/config.json", "utf8"));

// Console errors and uncaught exceptions on a page; asserted empty at the end of each test.
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("overview: footer carries disclaimer and author", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText(DISCLAIMER);
  await expect(footer).toContainText(config.author);
  await expect(page.locator("html")).toHaveAttribute("data-theme", config.defaultTheme);
  expect(errors).toEqual([]);
});

test("theme param applies a known theme", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?theme=paper");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator("link#theme")).toHaveAttribute("href", "themes/paper.css");
  // nav links keep the chosen theme
  await expect(page.locator(".site-nav a[href*='methods.html']")).toHaveAttribute("href", /theme=paper/);
  expect(errors).toEqual([]);
});

test("bad params: unknown theme and country fall back with notices", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?theme=neon&country=ZZ");
  await expect(page.locator("html")).toHaveAttribute("data-theme", config.defaultTheme);
  const notices = page.locator("#notices");
  await expect(notices).toContainText("Unknown country: ZZ");
  await expect(notices).toContainText("Unknown theme: neon");
  await expect(page.locator("main")).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test("bad params: unknown office falls back with notice", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?office=QQ");
  await expect(page.locator("#notices")).toContainText("Unknown office: QQ");
  expect(errors).toEqual([]);
});

test("methods page shows release strings and checks from manifest", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const main = page.locator("main");
  await expect(main).toContainText(manifest.releases.ips);
  await expect(main).toContainText(manifest.releases.pmh);
  await expect(main).toContainText(manifest.retrieved);
  await expect(main).toContainText(manifest.checks.wdi_scope);
  await expect(main.locator("#cross-checks dd", { hasText: manifest.checks.wdi_last_updated })).toHaveCount(1);
  for (const line of manifest.checks.golden) await expect(main).toContainText(line);
  // publication behind each golden figure: edition and DOI, page, link
  expect(manifest.checks.golden_sources.length).toBe(manifest.checks.golden.length);
  for (const src of manifest.checks.golden_sources) {
    const item = main.locator(".golden-sources li").filter({ has: page.locator("code", { hasText: new RegExp(`^${src.id}$`) }) });
    await expect(item).toContainText(src.citation);
    await expect(item).toContainText(src.page);
    await expect(item.locator("a")).toHaveAttribute("href", src.url);
  }
  for (const line of manifest.checks.world) await expect(main).toContainText(line);
  await expect(main).toContainText(DISCLAIMER);
  await expect(page.locator("footer")).toContainText(DISCLAIMER);
  expect(errors).toEqual([]);
});

test("methods page: WDI mismatches excused by revision timing show as warnings with their reason", async ({ page }) => {
  const errors = trackErrors(page);
  const reason = "World Bank WDI last updated 2026-03-27, before the WIPO patent release of May 2026: WIPO revisions not yet in WDI, mismatches are warnings";
  const warnings = ["WDI CH 2022 resident: WIPO 1231, World Bank 1230", "WDI DE 2021 nonresident: WIPO 18747, World Bank 18748"];
  const patched = structuredClone(manifest);
  Object.assign(patched.checks, { wdi: "warn", wdi_last_updated: "2026-03-27", wdi_warnings: warnings, wdi_warning_reason: reason });
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/methods.html");
  const checks = page.locator("#cross-checks");
  await expect(checks.locator("dd", { hasText: "2026-03-27" })).toHaveCount(1);
  await expect(checks.locator("dd", { hasText: /^warn$/ })).toHaveCount(1);
  await expect(checks.locator(".wdi-warning-reason")).toHaveText(reason);
  for (const line of warnings) await expect(checks).toContainText(line);
  expect(errors).toEqual([]);
});

test("methods page: a passing WDI check lists no warnings", async ({ page }) => {
  const patched = structuredClone(manifest);
  Object.assign(patched.checks, { wdi: "pass", wdi_last_updated: null, wdi_warnings: [], wdi_warning_reason: null });
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/methods.html");
  const checks = page.locator("#cross-checks");
  await expect(checks.locator("dd", { hasText: "not recorded" })).toHaveCount(1);
  await expect(checks.locator(".result-pass")).toHaveText("pass");
  await expect(checks.locator(".wdi-warning-reason")).toHaveCount(0);
});

test("methods page: pipeline version keeps the -dirty mark of uncommitted pipeline code", async ({ page }) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  for (const [recorded, shown] of [[sha, "0123456789ab"], [`${sha}-dirty`, "0123456789ab-dirty"]]) {
    const patched = structuredClone(manifest);
    patched.pipeline_sha = recorded;
    await page.unrouteAll();
    await page.route("**/data/manifest.json", (route) => route.fulfill({ json: patched }));
    await page.goto("/methods.html");
    await expect(page.locator("#sources dd code")).toHaveText(shown);
  }
});

test("methods page: an empty world sum-ratio summary shows dashes, no crash", async ({ page }) => {
  const errors = trackErrors(page);
  const patched = structuredClone(manifest);
  patched.checks.world_sum_ratio.pct_world = { min: null, max: null, years: null }; // crosscheck.sum_ratio_summary, no year with both values
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/methods.html");
  const row = page.locator("#world-totals tbody tr", { hasText: "PCT applications worldwide" });
  await expect(row.locator("td")).toHaveText(["PCT applications worldwide", "–", "–", "–"]);
  await expect(page.locator("#world-totals tbody tr", { hasText: "Patent applications worldwide" }).locator("td").nth(2))
    .toHaveText(/^\d+\.\d{2}%$/);
  expect(errors).toEqual([]);
});

test("methods page: Switzerland example read from entity data", async ({ page }) => {
  const swiss = JSON.parse(readFileSync("site/data/entity/CH.json", "utf8"));
  const year = String(manifest.last_year.origin_apps);
  const originResident: number = swiss.series.origin_apps.types.resident[year];
  await page.goto("/methods.html");
  await expect(page.locator("#origin-vs-office")).toContainText(originResident.toLocaleString("en-US"));
});

test("about page: byline, disclaimer, citation example", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/about.html?theme=wallboard");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "wallboard");
  const main = page.locator("main");
  await expect(main).toContainText(config.author);
  await expect(main).toContainText(DISCLAIMER);
  await expect(main.locator(".cite-example")).toContainText(`retrieved ${manifest.retrieved}`);
  expect(errors).toEqual([]);
});

for (const theme of config.themes as string[]) {
  test(`theme ${theme}: every page renders without console errors`, async ({ page }) => {
    const errors = trackErrors(page);
    for (const path of ["/", "/methods.html", "/about.html"]) {
      await page.goto(`${path}?theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveClass(/theme-ready/);
      await expect(page.locator("footer")).toContainText(DISCLAIMER);
    }
    expect(errors).toEqual([]);
  });
}

const overview = JSON.parse(readFileSync("site/data/overview.json", "utf8"));
const entities: { label: string; kind: string }[] = JSON.parse(readFileSync("site/data/entities.json", "utf8"));

test("methods page: constants and entity names come from data files", async ({ page }) => {
  const { cagr_years: years, golden_tolerance_pct: tolerance, golden_growth_tolerance_pp: growthTolerance, rounding } = overview.method;
  await page.goto("/methods.html");
  const main = page.locator("main");
  await expect(main).toContainText(`counts and shares within ${tolerance}% (relative), growth figures within ${growthTolerance} percentage points (absolute)`);
  await expect(main).toContainText(`${years}-year compound annual growth`);
  await expect(main).toContainText(`(1 ÷ ${years})`);
  await expect(main).toContainText(`rounded ${rounding.mode}`);
  const definitions = page.locator("#definitions");
  for (const entity of entities.filter((e) => e.kind === "regional_office" || e.kind === "historical")) {
    await expect(definitions).toContainText(entity.label);
  }
  // WIPO's own aggregates are not the M49 groups: the term says which is left out of sums
  await expect(definitions.locator("dt", { hasText: /^WIPO aggregates$/ })).toHaveCount(1);
  await expect(definitions.locator("dt", { hasText: /^Groups$/ })).toHaveCount(0);
  await expect(page.locator("#origin-vs-office")).toContainText("Most of the difference");
});

test("methods and about pages survive an overview without an origin source block", async ({ page }) => {
  const errors = trackErrors(page);
  const trimmed = structuredClone(overview);
  delete trimmed.sources.origin_apps;
  await page.route("**/data/overview.json", (route) => route.fulfill({ json: trimmed }));
  await page.goto("/methods.html");
  await expect(page.locator("#sources")).toContainText(trimmed.sources.office_apps.query);
  await page.goto("/about.html");
  await expect(page.locator(".cite-example")).toContainText(`retrieved ${manifest.retrieved}`);
  expect(errors).toEqual([]);
});

test("config.json failing still shows the WIPO disclaimer and an error", async ({ page }) => {
  await page.route("**/config.json", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/");
  await expect(page.locator("footer")).toContainText(DISCLAIMER);
  await expect(page.locator("main")).toContainText("could not be loaded");
});

test("themes define every token base.css uses; base.css has no visual literals", () => {
  const base = readFileSync("site/css/base.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const used = new Set([...base.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  for (const theme of config.themes as string[]) {
    const css = readFileSync(`site/themes/${theme}.css`, "utf8");
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]));
    expect([...used].filter((token) => !defined.has(token)), theme).toEqual([]);
  }
  // Colours and lengths only via tokens; 720px media query allowed (custom properties cannot be used there).
  const literals = base.replace(/@media \(max-width: 720px\)/g, "").match(/#[0-9a-f]{3,8}\b|rgba?\(|\b\d*\.?\d+(px|em|rem|pt)\b/gi);
  expect(literals).toBeNull();
});

// v0.2a methods sections: every figure below is read from data or config, none typed.
const groupsFile = JSON.parse(readFileSync("site/data/groups.json", "utf8"));
const entityLabel = (code: string): string => entities.find((e: any) => e.code === code)?.label ?? code;

test("methods page: groupings, basis, floor, null reasons, cross-check and NO_GROUP read from data", async ({ page }) => {
  const errors = trackErrors(page);
  const { method } = overview;
  await page.goto("/methods.html");
  const groupings = page.locator("#groupings");
  const continents = groupsFile.items.filter((item: any) => item.kind === "continent");
  const sameAsContinent = (item: any): boolean => continents.some((continent: any) =>
    continent.members.length === item.members.length && continent.members.every((code: string) => item.members.includes(code)));
  const allRegions = groupsFile.items.filter((item: any) => item.kind === "region");
  const regions = allRegions.filter((item: any) => !sameAsContinent(item));
  expect(regions.length, "a region equal to a continent exists in the data").toBeLessThan(allRegions.length);
  await expect(groupings).toContainText(`${continents.length} continents`);
  await expect(groupings).toContainText(`${regions.length} regions`);
  await expect(groupings).not.toContainText(`${allRegions.length} regions`);
  for (const item of continents) await expect(groupings).toContainText(item.label);
  await expect(groupings).toContainText(groupsFile.sources.groupings[0].retrieved);
  await expect(groupings.locator(`a[href="${groupsFile.sources.groupings[0].url}"]`)).toHaveCount(1);
  for (const [code, reason] of Object.entries(groupsFile.no_group)) {
    await expect(groupings.locator("li", { hasText: reason as string }).locator("code")).toHaveText(code);
  }
  // attribution floor and no count threshold
  await expect(groupings).toContainText(`${Math.round(method.group_attribution_min * 100)}% of the series' world total`);
  await expect(groupings).toContainText("no minimum count");
  // a WIPO regional total is shown "for every complete year WIPO publishes it" (provisional years are cut), not always (office R rows start 1997)
  await expect(groupings).toContainText("shown for every complete year WIPO publishes it");
  await expect(groupings).not.toContainText("shown whenever WIPO publishes it");
  // the band section names the one chart drawn (origin), not a chart per series
  await expect(groupings).toContainText("The region-share chart is drawn for origin only");
  await expect(groupings).not.toContainText("always shown");
  await expect(groupings).toContainText("empties every member-sum group of that series");
  // member-sum kinds per series, from group_basis
  const SERIES_NAMES: Record<string, string> = {
    origin_apps: "Patent applications by applicant's origin", office_apps: "Patent applications by filing office",
    pct_origin: "PCT applications by applicant's origin",
  };
  const memberSum = Object.entries<any>(method.group_basis).flatMap(([series, basis]) => {
    const kinds = ["continent", "region"].filter((kind) => basis[kind] === "member_sum");
    return kinds.length ? [`${SERIES_NAMES[series]}: ${kinds.map((kind) => `${kind}s`).join(" and ")}`] : [];
  });
  await expect(groupings).toContainText(`(${memberSum.join("; ")})`);
  // basis per series and kind
  const rows = groupings.locator("table tbody tr");
  await expect(rows).toHaveCount(Object.keys(method.group_basis).length);
  await expect(rows.filter({ hasText: "filing office" }).locator("td").nth(2)).toHaveText("not offered");
  // WIPO totals differ per series: office totals add regional offices and estimates; PCT origin totals add only the cross-check codes
  const label = (code: string): string => entityLabel(code);
  for (const [series, basis] of Object.entries<any>(method.group_basis)) {
    if (basis.continent !== "wipo_total") continue;
    const cell = rows.filter({ hasText: series === "office_apps" ? "filing office" : "PCT applications by applicant" }).locator("td").nth(1);
    if (series === "office_apps") {
      await expect(cell).toContainText("regional offices");
      await expect(cell).toContainText("estimates for offices that did not report");
    } else {
      const added = [...new Set<string>(Object.values<any>(method.group_crosscheck_assignment[series] ?? {}).flat())];
      await expect(cell).toContainText("the member countries");
      await expect(cell).not.toContainText("regional offices");
      await expect(cell).not.toContainText("estimates");
      await expect(cell).toContainText(`${groupsFile.items.find((item: any) => item.id === "europe").label} also counts a few origins WIPO does not list`);
      for (const code of added) await expect(cell).toContainText(`${label(code)} (${code})`);
    }
  }
  // all four null reasons, with their keys
  for (const key of ["no_wipo_regional_total", "no_wipo_world_total", "none_reported", "attribution_floor"]) {
    await expect(groupings.locator("dt code", { hasText: new RegExp(`^${key}$`) })).toHaveCount(1);
  }
  await expect(groupings).toContainText("no complete WIPO world total for this year");
  // band label per series
  for (const [series, share] of Object.entries<any>(overview.continent_share)) {
    expect(series).toBeTruthy();
    await expect(groupings.locator("dt", { hasText: `“${share.unallocated_label}”` })).toHaveCount(1);
  }
  await expect(groupings).toContainText(`last ${method.panel_years} years`);
  // band text per series (pct_origin: Unknown row or "unallocated"; origin_apps: former states only for the years before origin_abroad_from)
  const pctBand = groupings.locator("dd", { hasText: "Unknown" });
  await expect(pctBand).toContainText(overview.continent_share.pct_origin.unallocated_label === "unallocated"
    ? "it differs in at least one year" : "it equals the Unknown row in every year");
  await expect(pctBand).toContainText("“unallocated”");
  const originBand = groupings.locator("dd", { hasText: "not attributable to a listed country" });
  await expect(originBand).toHaveCount(1);
  await expect(originBand).not.toContainText("former states");
  await expect(originBand).not.toContainText("origin WIPO does not allocate");
  // cross-check: assignment labels and range
  const [low, high] = method.group_crosscheck_range;
  await expect(groupings).toContainText(`between ${Math.round(low * 100)}% and +${Math.round(high * 100)}%`);
  const assignments = groupings.locator(".crosscheck-assignment li");
  let expected = 0;
  for (const [series, byGroup] of Object.entries<any>(method.group_crosscheck_assignment)) {
    for (const [group, codes] of Object.entries<any>(byGroup)) {
      expected += 1;
      const groupLabel = groupsFile.items.find((item: any) => item.id === group).label;
      const item = assignments.filter({ hasText: `, ${groupLabel}: ` }).filter({ hasText: (codes as string[]).map((c) => `${entityLabel(c)} (${c})`).join(", ") });
      await expect(item, `${series} ${group}`).toHaveCount(1);
    }
  }
  await expect(assignments).toHaveCount(expected);
  expect(errors).toEqual([]);
});

test("methods page: the attribution floor and the origin start year follow overview.json", async ({ page }) => {
  const patched = structuredClone(overview);
  patched.method.group_attribution_min = 0.55;
  patched.method.origin_abroad_from = 1987;
  await page.route("**/data/overview.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/methods.html");
  await expect(page.locator("#groupings")).toContainText("less than 55% of the series' world total");
  await expect(page.locator("#formulas")).toContainText("Before 1987, ");
});

test("methods page: map scale from config, state labels, successor rule and disclaimer", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/methods.html");
  const map = page.locator("#map");
  await expect(map).toContainText(`${config.map.bins} bins that are powers of ${config.map.logBase} wide`);
  await expect(map).toContainText("or more");
  for (const label of ["0 reported", "No data reported", "Reported under a former entity", "Area without a WIPO country code"]) {
    await expect(map.locator("dt", { hasText: label })).not.toHaveCount(0);
  }
  await expect(map).toContainText("only if the country reports in that series in some year");
  const rows = map.locator("table tbody tr");
  await expect(rows).toHaveCount(Object.keys(groupsFile.successors).length);
  for (const [former, successors] of Object.entries<any>(groupsFile.successors)) {
    const row = rows.filter({ hasText: `(${former})` });
    await expect(row).toHaveCount(1);
    // one row per former entity; successors grouped by their window: "1980–1991 → A, B"
    const byWindow = new Map<string, string[]>();
    for (const successor of successors) {
      const window = `${successor.from_year}–${successor.to_year}`;
      byWindow.set(window, [...(byWindow.get(window) ?? []), entityLabel(successor.code)]);
    }
    for (const [window, names] of byWindow) await expect(row).toContainText(`${window} → ${names.join(", ")}`);
    if (successors.length === 0) await expect(row).toContainText("reports itself");
  }
  await expect(map.locator(".disclaimer")).toContainText("do not imply official endorsement");
  await expect(map).toContainText("Natural Earth");
  expect(errors).toEqual([]);
});

test("methods page: a changed config.map changes the scale text", async ({ page }) => {
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), map: { logBase: 4, bins: 3 } } });
  });
  await page.goto("/methods.html");
  await expect(page.locator("#map")).toContainText("3 bins that are powers of 4 wide");
  await expect(page.locator("#map")).toContainText("1–3; 4–15; 16 or more");
});

test("methods page: an invalid config.map falls back to the default scale, as the map does", async ({ page }) => {
  const errors = trackErrors(page);
  await page.route("**/config.json", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), map: { logBase: 1, bins: 99 } } });
  });
  await page.goto("/methods.html");
  const fallback = DEFAULT_MAP_SCALE;
  await expect(page.locator("#map")).toContainText(`${fallback.bins} bins that are powers of ${fallback.logBase} wide`);
  await expect(page.locator("#map")).not.toContainText("99 bins");
  expect(errors).toEqual([]);
});

test("methods page: carried checks pct_monthly and groups are listed; a manifest without pct_monthly is tolerated", async ({ page }) => {
  const errors = trackErrors(page);
  const patched = structuredClone(manifest);
  patched.checks.pct_monthly = ["PCT monthly 2020: 2 of 12 months not reported (shown null)"];
  patched.checks.groups = ["group cross-check office_apps africa 2001: WIPO OA 1 vs member sum 2"];
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: patched }));
  await page.goto("/methods.html");
  await expect(page.locator("#check-pct-monthly + p + ul")).toContainText(patched.checks.pct_monthly[0]);
  await expect(page.locator("#check-groups + p + ul")).toContainText(patched.checks.groups[0]);
  await page.unrouteAll();
  const old = structuredClone(manifest);
  delete old.checks.pct_monthly;
  delete old.checks.groups;
  await page.route("**/data/manifest.json", (route) => route.fulfill({ json: old }));
  await page.goto("/methods.html");
  await expect(page.locator("#cross-checks")).toContainText("Not recorded in this release.");
  await expect(page.locator("#cross-checks")).toContainText("None in this release.");
  expect(errors).toEqual([]);
});
