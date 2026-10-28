# Patent Atlas

Patent and PCT statistics from the WIPO Statistics Database, with our own analysis: growth, world shares, ranks and
comparisons between countries and offices. Every figure shows its source, WIPO release and retrieval date, and has
text to cite it. Made for patent office staff, researchers and students. By Lina
([lina-here](https://github.com/lina-here)). Sources, formulas and checks: the site's methods page and `docs/research/`.

## Preview the site

- Quickest: `./preview` rebuilds the site and restarts it at http://localhost:8124 (runs in the background; refresh
  the page afterwards).
- In VS Code: Terminal > Run Task... > **Preview Patent Atlas**. The site opens in your browser.
- Or in a terminal, from this folder: `python3 -m http.server 8123 -b 127.0.0.1 -d site`, then open http://localhost:8123.

Change the look with `?theme=` in the address: `atlas` (default), `paper` (print), `wallboard` (office screen),
`embed` (inside other sites). Example: http://localhost:8123/?theme=wallboard. Theme list and default:
`site/config.json`.

Pages: overview (`index.html`), `methods.html` (sources, formulas, checks), `about.html` (author, how to cite),
`embed.html` (one chart for other sites, see below). A country or office page is `index.html?country=CH` or
`?office=EP`; the picker on the overview finds any of them.

New in v0.2a (Atlas): a **world map** (`chart=world-map`; countries, regions or continents, three metrics, a year
slider, former entities marked "reported under"), **region and continent pages** (`?region=<M49 code>`,
`?continent=<slug>`: members, totals with "n of m" reporting and the reason for any empty year, a cross-check against
WIPO's own totals, map zoomed to the members), a **region comparison** on country pages, and four overview charts:
rank race, region share of world, size versus growth, PCT monthly. `?rotate=<seconds>` in the wallboard theme cycles
through them. Groupings follow the UN M49 standard (mapping only, source and date on the methods page); map shapes are
Natural Earth via `world-atlas`, built by `npm run geo:build`. The methods page states the map scale, the
groupings and every rule above, each value read from the data or `site/config.json`.

v1 adds a **conference wallboard** (`index.html?view=wallboard`, footer link "Conference wallboard"): a full-screen chart carousel for a TV, driven by keyboard, clicker or remote (S slide picker, H help); keys and slide choice in `methods.html#wallboard`.

New in v0.2 Stage W (women inventors, WIPO's shares by publication year): the page `index.html?view=women-inventors`; chart ids `women-world-trend`, `women-by-field`, `women-ranking`, `entity-women` (with `country=`), `group-women` (with `region=` or `continent=`) and the map metrics `metric=women_any`, `metric=women_share`; method in `methods.html#women-inventors`.

## Put a chart on another website

Every chart has an **Embed** button. Click it, pick a theme, click **Copy code**, and paste the text into the page
where the chart should appear (most website editors have an "HTML" or "embed" block for this). The chart shows its
source line and a link back to Patent Atlas; the source line cannot be removed. The pasted text looks like this:

```html
<iframe src="<baseUrl>embed.html?chart=origin-apps&country=CH&theme=<embedTheme>"
        title="<chart title> – Patent Atlas" width="100%" height="<embedHeight>" loading="lazy"></iframe>
```

- `<baseUrl>` is `baseUrl` in `site/config.json`: the site's address, folder included (for a GitHub Pages project
  site that is `https://<user>.github.io/<repository>/`; a missing closing `/` is added). Empty until the site is
  published, so the button then copies your local preview address, which only works on this computer.
- `<embedTheme>` is `embedTheme` in `site/config.json`, the theme the Embed button preselects.
- `<embedHeight>` is `embedHeight` in `site/config.json`. It fits the line charts in the `<embedTheme>` theme. Rankings, key
  figures and the larger themes (`atlas`, `paper`, `wallboard`) are taller: if the frame shows a scrollbar, give it
  more height.
- `chart=` names the chart: `world-trend`, `pct-world-trend`, `top-origins`, `fastest-growers`, `rank-race`,
  `continent-share`, `size-growth`, `pct-monthly`, `world-map` (whole world; the map also takes `metric=`, `map=`,
  `year=`), or `entity-tiles`, `origin-apps`, `office-apps`, `pct-origin` together with `country=<code>` or
  `office=<code>`, or `region-compare` with `country=<code>`, or `group-members`, `origin-apps`, `office-apps`,
  `pct-origin`, `world-map` with `region=<M49 code>` or `continent=<slug>`. Codes are WIPO's (CH, US, EP, ...). `theme=` is optional: `<embedTheme>` is the default here.
- A wrong chart name or a country without that chart shows a short message and a link to the site, never an empty
  frame. Try it locally: http://localhost:8123/embed.html?chart=origin-apps&country=CH

## Refresh the data

`python3 -m pipeline.run` fetches every series from WIPO again, runs the cross-checks and rewrites `site/data/` only if
something it writes changed (a figure, a source release or vintage, the pipeline code or method). `--dry-run` runs
everything and writes nothing. GitHub runs the same job monthly (`.github/workflows/refresh-data.yml`), runs the tests
and site gates on the new data and commits it itself.

A refresh that moves a series' last year back or no longer publishes a committed country, office or group fails (the
monthly job too; it has no override): to accept it, run `python3 -m pipeline.run --accept-regression` locally, run the
gates, and commit `site/data` by pathspec with the accepted lines in the commit message.

Each time the data, or the code or method that writes them, change, the refresh adds a citable data version to
`site/data/releases.json` (newest first: version = retrieval date, `.2` for a second change that day, WIPO releases,
WDI vintages, pipeline commit, what changed) and names it in the manifest (`version`). Each version is kept as the git
tag `data-<version>`; a version id with a tag is never issued again, even after a revert. The pipeline refuses to
write data from uncommitted `pipeline/` code or outside a git checkout. A version and its git tag never change.
The monthly job tags and pushes every run on `main`; before a local refresh, `git fetch --tags` (a tagged version id is never reissued, and only tags the clone has count); after it, commit the data, merge it to `main`, then
run `python3 scripts/tag_data.py --remote origin` on `main` (it tags the commit that introduced each version and
pushes tags the remote lacks; it never moves one, and reports a version re-added with other content). Never tag from a branch
that will be squash- or rebase-merged: the tag would sit on a commit `main` never gets, and the monthly job would
report a problem every run until a person fixes it. The monthly job's tag step runs only on `main`; a
`workflow_dispatch` run on a branch commits its data there untagged.

First version in a new repo or fresh history (e.g. the public repo): delete `site/data/releases.json`, run
`python3 -m pipeline.run` on committed code (first version `changed: ["all"]`, this repo's pipeline commit), run the
gates, commit, then `python3 scripts/tag_data.py --remote origin`. `--bootstrap-version` refuses data whose manifest
names a dirty sha or a commit this repo lacks.

## Updating the PCT states list

The map's PCT membership layer reads `pipeline/pct_states.json`, transcribed by hand from two WIPO documents; nothing
parses them automatically (pipeline or CI).

1. Rows: open WIPO's page [PCT Contracting States](https://www.wipo.int/pct/en/pct_contracting_states.html) and
   re-transcribe each State's code, name (as printed, without footnote marks) and the date in the column "Date on
   Which State Became Bound by the PCT" into `states`, sorted by code.
2. Status date and count: download WIPO's list
   [PCT Contracting States and Two-letter Codes](https://www.wipo.int/documents/d/pct-system/docs-en-list_states.pdf)
   and take `status_on` and `count` from its heading; set `retrieved` to the day you read both.
3. In `pipeline/tests/test_pct_states.py`: add the new list's pinned pair (status date: count) to `PINNED_COUNTS`
   (read by `test_count_matches_list`), and the codes the PDF prints to the hand-written list that
   `test_page_codes_equal_pdf_codes` compares with the page.
4. Run `python3 -m pytest pipeline/tests/test_pct_states.py`, then the normal data refresh above.

## Checks (gates)

- `python3 -m pytest`: pipeline tests.
- `python3 scripts/repo_guard.py --all`: no raw WIPO data in the repo.
- `npm run typecheck`, `npm run check:built` (committed `site/js` matches the build), `npm run test:e2e` (browser
  tests; they start their own local server). First time: `npm ci` and `npx playwright install chromium`.

The site code is TypeScript in `site/src/`, bundled by `npm run build` into `site/js/main.js`, which is committed so
the site runs without any build step.

## Security

- Content Security Policy: GitHub Pages sends no custom headers, so each page carries it as a `<meta>` tag (the
  policy itself is in `site/*.html`; `pipeline/tests/test_site_security.py` checks it). Scripts, data and styles load
  from the site itself only; inline styles are allowed (Observable Plot writes one per chart); the site creates no
  Trusted Types policy (`trusted-types 'none'`), so browsers with Trusted Types refuse plain strings in DOM injection
  sinks (innerHTML, script text, script URLs); browsers without it ignore the directive. Every e2e test fails on any
  CSP violation (`tests/e2e/fixtures.ts`).
- Framing accepted: a meta tag cannot set `frame-ancestors` and Pages cannot send `X-Frame-Options`, so any site may
  frame the full pages, not only `embed.html`. Low impact: no login, forms or stored state.
- Address values: a notice repeats a value from the address only in a short plain form (`ECHO_SAFE` in
  `site/src/params.ts`), else "(not shown)". Data and address text always render as text, never as HTML.
- Workflows: actions pinned to commit SHAs; only the publish job of the data refresh can push, and it runs no npm
  or pip code; only the deploy job of `pages.yml` can publish the site. Test-only Python packages are pinned with
  hashes (`requirements-dev.txt`).
- Dependabot: weekly update PRs for the actions, npm packages and hashed pip pins (`.github/dependabot.yml`).
- Reporting a vulnerability: use GitHub's private vulnerability reporting (the repository's Security tab, "Report a
  vulnerability"). Please do not open a public issue.

## Data rules

- Raw WIPO API responses are never committed; only derived figures in `site/data/` are.
- Complete years only; the newest year with too few reporting offices is provisional and left out of world figures
  (rule and current values on the methods page).
- Missing data shows as "–" or "no data reported", never as 0.
- World totals and shares use WIPO's own totals; our sums are check figures only.
- Every figure carries the source line and WIPO's disclaimer is on every page. No WIPO logo; not affiliated with
  WIPO.
- Looks: every colour, font and size lives in `site/themes/<name>.css`. A new theme = one CSS file + its name in
  `site/config.json`.

## Licence and data

- Code: MIT licence (`LICENSE`), copyright Lina.
- Figures: not covered by the code licence. Patent and PCT figures come from the WIPO Statistics Database under
  WIPO's terms of use (WIPO's disclaimer is on every page); population and GDP figures come from the World Bank's
  World Development Indicators (CC BY 4.0). Cite the sources as the site's "Cite this" text shows.
