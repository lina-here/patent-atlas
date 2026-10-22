"""Site hardening that must not regress (README "Security"): no HTML sinks in site/src, one meta CSP per page,
every e2e spec under the CSP-violation fixture (tests/e2e/fixtures.ts)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE_SRC = ROOT / "site" / "src"
PAGES = sorted((ROOT / "site").glob("*.html"))
SPECS = sorted((ROOT / "tests" / "e2e").glob("*.spec.ts"))

# Data labels come from the WIPO API html.unescape'd (pipeline/parse.py): only text nodes (dom.ts h()) or textContent.
SINK = re.compile(
    r"""innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bFunction\s*\(|\beval\s*\(|setHTMLUnsafe|parseHTMLUnsafe"""
    r"""|createContextualFragment|parseFromString|srcdoc"""
    r"""|["'`][^"'`\n]*(?:innerHTML|outerHTML|srcdoc)"""  # computed access: el["innerHTML"], el[`srcdoc`]
    r"""|\[\s*["'`]\s*(?:inner|outer)"""  # split names: el["inner" + "HTML"]
)
# (file, text of the line): the only allowed mentions, each with its reason
SINK_ALLOWED = {
    ("dom.ts", "// Small DOM builder. Text always goes in as text nodes (never innerHTML), so data and URL params"):
        "comment stating the rule, no call",
}
CSP_META = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">')


def directives(policy):
    return {part.split()[0]: part.split()[1:] for part in (item.strip() for item in policy.split(";")) if part}


def test_site_src_has_no_html_sinks():
    hits = []
    for path in sorted(SITE_SRC.rglob("*.ts")):
        for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
            if SINK.search(line) and (path.name, line.strip()) not in SINK_ALLOWED:
                hits.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
    assert hits == []


def test_sink_pattern_catches_known_bypasses():
    for line in ('el["innerHTML"] = s', "el['outerHTML'] = s", 'el[`srcdoc`] = s', 'el["inner" + "HTML"] = s',
                 'Function(s)()', 'new Function(s)', 'x.setHTMLUnsafe(s)',
                 'Document.parseHTMLUnsafe(s)', 'range.createContextualFragment(s)',
                 'new DOMParser().parseFromString(s, "text/html")', 'frame.srcdoc = s',
                 'el.insertAdjacentHTML("beforeend", s)', 'document.write(s)', 'eval(s)'):
        assert SINK.search(line), line
    for line in ('el.textContent = s', "const functionName = f(s)", 'node.append(document.createTextNode(s))'):
        assert not SINK.search(line), line


def test_sink_allowlist_entries_still_exist():
    for name, text in SINK_ALLOWED:
        assert text in [line.strip() for line in (SITE_SRC / name).read_text("utf-8").splitlines()], name


def test_every_page_has_one_meta_csp_before_any_style_or_script():
    assert {page.name for page in PAGES} == {"index.html", "methods.html", "about.html", "embed.html"}
    policies = set()
    for page in PAGES:
        html = page.read_text("utf-8")
        found = CSP_META.findall(html)
        assert len(found) == 1, page.name
        first_load = min(html.index(tag) for tag in ("<link", "<style", "<script") if tag in html)
        assert CSP_META.search(html).start() < first_load, page.name  # a meta CSP covers only what follows it
        policies.add(found[0])
    assert len(policies) == 1  # one policy for the whole site


def test_meta_csp_allows_only_own_scripts_and_no_plugins_base_or_forms():
    policy = directives(CSP_META.search(PAGES[0].read_text("utf-8")).group(1))
    assert policy["default-src"] == ["'self'"]
    assert policy["script-src"] == ["'self'"]  # no inline script, no eval
    assert policy["connect-src"] == ["'self'"]
    assert policy["object-src"] == ["'none'"]
    assert policy["base-uri"] == ["'none'"]
    assert policy["form-action"] == ["'none'"]
    assert policy["require-trusted-types-for"] == ["'script'"]
    assert policy["trusted-types"] == ["'none'"]  # no policy can be created: a later dependency cannot add a pass-through
    assert "'unsafe-eval'" not in sum(policy.values(), [])


def test_every_e2e_spec_runs_under_the_csp_fixture():
    assert SPECS
    for spec in SPECS:
        text = spec.read_text("utf-8")
        assert re.search(r'^import \{ test\b[^}]*\} from "\./fixtures";$', text, re.MULTILINE), spec.name
        assert "@playwright/test" not in text, spec.name


def test_readme_security_section_matches_the_config():
    readme = (ROOT / "README.md").read_text("utf-8")
    dependabot = next(line for line in readme.splitlines() if line.startswith("- Dependabot:"))
    ecosystems = re.findall(r"package-ecosystem: (\S+)", (ROOT / ".github" / "dependabot.yml").read_text("utf-8"))
    assert sorted(ecosystems) == ["github-actions", "npm", "pip"]
    assert "actions" in dependabot and "npm" in dependabot and "pip" in dependabot
    assert "HTML strings in script sinks" not in readme  # TT refuse plain strings in DOM injection sinks
    assert "creates no\n  Trusted Types policy" in readme and "ignore the directive" in readme
