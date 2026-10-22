"""Workflow guards that must not regress (text checks; no YAML dependency)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
USES = re.compile(r"^\s*(?:- )?uses: (\S+)(.*)$", re.MULTILINE)
PINNED = re.compile(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}")
VERSION_COMMENT = re.compile(r" # v\d+\.\d+\.\d+$")


def read(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def job(text, name):
    """The text of job `name` (two-space indent under `jobs:`), up to the next job."""
    start = text.index(f"\n  {name}:\n")
    following = re.search(r"\n  [\w-]+:\n", text[start + 1:])
    return text[start:start + 1 + following.start()] if following else text[start:]


def run_lines(text):
    """Every shell line of `run:` steps (single-line and block)."""
    lines, block = [], None
    for line in text.splitlines():
        stripped = line.strip()
        if block is not None:
            if line.startswith(block) and stripped:
                lines.append(stripped)
                continue
            block = None
        found = re.match(r"^(\s*)(?:- )?run: (.*)$", line)
        if found and found.group(2) == "|":
            block = found.group(1) + "  "
        elif found:
            lines.append(found.group(2))
    return lines


def test_ci_guards_full_history_on_every_push():
    ci = read("ci.yml")
    assert "fetch-depth: 0" in ci
    assert "repo_guard.py --range ${{ github.sha }}" in ci
    assert "github.event.before" not in ci  # a new branch's first push has before = 0000...
    assert "repo_guard.py --range ${{ github.event.pull_request.base.sha }}" in ci


def test_ci_read_only_token():
    assert "\npermissions:\n  contents: read\n" in read("ci.yml")


def test_ci_checkout_does_not_persist_the_token():
    """npm ci, pytest and e2e run third-party code: no token in .git/config (repo_guard needs only local history)."""
    ci = read("ci.yml")
    checkout = ci[ci.index("actions/checkout"):ci.index("actions/setup-python")]
    assert "persist-credentials: false" in checkout


def test_refresh_tests_new_data_before_commit():
    build = job(read("refresh-data.yml"), "build")
    between = build[build.index("python -m pipeline.run"):]
    assert "python -m pytest" in between
    assert "repo_guard.py --all" in between
    assert "repo_guard.py --staged" in job(read("refresh-data.yml"), "publish")


def test_refresh_minimal_token():
    """No token by default; read for the job that runs package code, write only for the job that runs none."""
    refresh = read("refresh-data.yml")
    assert "\npermissions: {}\n" in refresh
    assert "    permissions:\n      contents: read\n    steps:" in job(refresh, "build")
    assert "    permissions:\n      contents: write\n    steps:" in job(refresh, "publish")
    assert refresh.count("permissions:") == 3
    assert "needs: build" in job(refresh, "publish")


def test_ci_installs_node_packages_before_pytest():
    """test_build_geo's built-points test skips without node_modules/world-atlas: CI must run npm ci first."""
    ci = read("ci.yml")
    assert "- run: npm ci" in ci
    assert ci.index("- run: npm ci") < ci.index("- run: python -m pytest")
    assert ci.index("actions/setup-node") < ci.index("- run: npm ci")
    assert ci.count("- run: npm ci") == 1


def test_refresh_runs_site_gates_before_commit():
    """Bot pushes never trigger ci.yml: the refresh runs the site gates (e2e included) on the new data itself."""
    build = job(read("refresh-data.yml"), "build")
    between = build[build.index("python -m pipeline.run"):build.index("upload-artifact")]
    steps = ["npm run typecheck", "npm run check:built", "npx playwright install --with-deps chromium", "npm run test:e2e"]
    for step in steps:
        assert f"- run: {step}" in between, step
    assert between.index("npx playwright install") < between.index("npm run test:e2e")
    first_pytest = build.index("- run: python -m pytest")
    assert build.index("actions/setup-node") < build.index("- run: npm ci") < first_pytest
    assert build.count("- run: npm ci") == 1


def test_refresh_run_line_carries_no_override_flag():
    """README: the scheduled refresh has no override; --accept-regression is a local run only."""
    assert "- run: python -m pipeline.run\n" in read("refresh-data.yml")


def test_refresh_hands_only_json_data_from_build_to_publish():
    refresh = read("refresh-data.yml")
    upload = job(refresh, "build")[job(refresh, "build").index("actions/upload-artifact"):]
    assert "name: refreshed-data" in upload and "path: site/data\n" in upload
    publish = job(refresh, "publish")
    assert "name: refreshed-data" in publish[publish.index("actions/download-artifact"):]
    commit = publish[publish.index("Commit refreshed data"):]
    assert commit.index("! \\( -type f -name '*.json' \\)") < commit.index('cp -R "$DATA" site/data')
    assert commit.index('cp -R "$DATA" site/data') < commit.index("git add site/data")


def test_refresh_publish_parses_every_artifact_file_as_json_before_the_commit():
    """The type check lets any *.json name through: truncated or non-JSON content must fail before it is committed."""
    commit = job(read("refresh-data.yml"), "publish")
    commit = commit[commit.index("Commit refreshed data"):]
    check = commit.index('python3 -I scripts/check_json.py "$DATA"')
    assert commit.index("! \\( -type f -name '*.json' \\)") < check < commit.index('cp -R "$DATA" site/data')
    assert check < commit.index("git commit")


def test_refresh_publish_runs_no_package_code():
    """The write token's job: git, shell and the repo's stdlib scripts only (no npm, pip, Playwright, setup-*)."""
    publish = job(read("refresh-data.yml"), "publish")
    for banned in ("npm", "npx", "pip", "playwright", "setup-node", "setup-python", "python -m"):
        assert not re.search(rf"\b{banned}\b", publish), banned
    python = [line for line in run_lines(publish) if "python" in line]
    assert python == ["python3 -I scripts/check_json.py \"$DATA\"", "python3 scripts/repo_guard.py --staged",
                      "python3 scripts/tag_data.py --remote origin"]
    assert [uses for uses, _ in USES.findall(publish)] == [
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333"]


def test_refresh_token_never_on_a_command_line():
    """Build: no token persisted (package code runs). Publish: checkout persists it and git reads .git/config; the
    token is never expanded into a script, and the ref name reaches the shell via env only."""
    refresh = read("refresh-data.yml")
    build = job(refresh, "build")
    assert "persist-credentials: false" in build[build.index("actions/checkout"):build.index("actions/setup-python")]
    publish = job(refresh, "publish")
    assert "persist-credentials" not in publish  # checkout's default: true
    for leak in ("github.token", "secrets.", "x-access-token"):
        assert leak not in refresh, leak
    commit = publish[publish.index("Commit refreshed data"):publish.index("- name: Tag data versions")]
    assert "REF_NAME: ${{ github.ref_name }}" in commit
    push = [line for line in run_lines(commit) if line.startswith("git push")]
    assert push == ['git push origin "HEAD:$REF_NAME"']
    assert all("${{" not in line for line in run_lines(refresh))


def test_refresh_tags_data_versions_after_commit():
    """Every run on main (the commit step exits 0 when nothing changed): tags pushed through the same persisted
    credentials. Never from another branch: its commits may never reach main (squash), the tag would then be a problem."""
    publish = job(read("refresh-data.yml"), "publish")
    step = publish[publish.index("- name: Tag data versions"):]
    assert publish.index("Commit refreshed data") < publish.index("- name: Tag data versions")
    assert [line.strip() for line in step.splitlines() if line.strip().startswith("if:")] == [
        "if: github.ref == 'refs/heads/main'"]
    assert "run: python3 scripts/tag_data.py --remote origin" in step
    no_change = publish[publish.index("Commit refreshed data"):publish.index("git config user.name")]
    assert 'echo "No data change"\n            exit 0' in no_change


def test_every_action_is_pinned_to_a_full_commit_sha():
    """A tag can be moved; a commit SHA cannot. One SHA per action across the workflows; its version as a comment."""
    pins = {}
    for path in sorted(WORKFLOWS.glob("*.yml")):
        found = USES.findall(path.read_text("utf-8"))
        assert found, path.name
        for uses, rest in found:
            assert PINNED.fullmatch(uses), f"{path.name}: {uses}"
            assert VERSION_COMMENT.fullmatch(rest), f"{path.name}: {uses}{rest}"
            action, sha = uses.split("@")
            pins.setdefault(action, set()).add((sha, rest))
    assert {action: len(shas) for action, shas in pins.items() if len(shas) > 1} == {}


def test_dependabot_updates_actions_npm_and_pip_weekly():
    text = (ROOT / ".github" / "dependabot.yml").read_text("utf-8")
    assert "version: 2\n" in text
    for ecosystem in ("github-actions", "npm", "pip"):
        entry = text[text.index(f"- package-ecosystem: {ecosystem}"):]
        assert "directory: /\n" in entry[:120] and "interval: weekly" in entry[:120], ecosystem


def test_pytest_is_installed_from_hashed_pins():
    """No unpinned `pip install`: every workflow installs requirements-dev.txt with --require-hashes."""
    installs = [line for path in WORKFLOWS.glob("*.yml") for line in run_lines(path.read_text("utf-8")) if "pip install" in line]
    assert installs and set(installs) == {"pip install --require-hashes -r requirements-dev.txt"}
    text = (ROOT / "requirements-dev.txt").read_text("utf-8")
    entries = [entry for entry in re.split(r"(?<!\\)\n", text) if entry and not entry.startswith("#")]
    names = []
    for entry in entries:
        head, *hashes = [part.strip() for part in entry.split("\\\n")]
        assert re.fullmatch(r'[a-z0-9-]+==[\w.]+( ; python_version < "3\.\d+")?', head), head
        assert hashes and all(re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", value) for value in hashes), head
        names.append(head.split("==")[0])
    assert "pytest" in names


def if_condition(text):
    """The folded `if: >-` expression of a job, on one line."""
    found = re.search(r"\n    if: >-\n((?:      .*\n)+)", text)
    assert found, "no if: >- expression"
    return " ".join(line.strip() for line in found.group(1).splitlines())


def test_pages_deploy_shape():
    """The only job with pages/id-token deploys a site/ artifact packed by a job that runs no package code, after the
    gates (a separate job = separate VM: a compromised dev dependency cannot replace the artifact)."""
    pages = read("pages.yml")
    start = pages.index("\non:\n")
    triggers = pages[start:pages.index("\n\n", start) + 1]
    assert triggers.startswith("\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n")
    # refreshed data deploys: after a "Refresh data" run on main (its bot push starts no push workflow)
    assert '  workflow_run:\n    workflows: ["Refresh data"]\n    types: [completed]\n    branches: [main]\n' in triggers
    assert read("refresh-data.yml").startswith("name: Refresh data\n")
    assert "\npermissions: {}\n" in pages
    assert "\nconcurrency:\n  group: pages\n" in pages
    pack, gates, deploy = job(pages, "pack"), job(pages, "gates"), job(pages, "deploy")
    for name in (pack, gates):
        assert "    permissions:\n      contents: read\n    steps:" in name
        assert "persist-credentials: false" in name
    assert re.search(r"    permissions:\n      pages: write[^\n]*\n      id-token: write[^\n]*\n    environment:", deploy)
    assert pages.count("pages: write") == 1 and pages.count("id-token:") == 1 and pages.count("permissions:") == 4
    assert "    needs: [pack, gates]\n" in deploy  # deploys only when both succeed
    assert "      name: github-pages" in deploy
    assert [uses.split("@")[0] for uses, _ in USES.findall(deploy)] == ["actions/deploy-pages"]
    assert run_lines(deploy) == [] and "actions/checkout" not in deploy
    # pack: checkout + upload only, no package code
    assert [uses.split("@")[0] for uses, _ in USES.findall(pack)] == [
        "actions/checkout", "actions/upload-pages-artifact"]
    assert run_lines(pack) == []
    assert "with:\n          path: site\n" in pack[pack.index("actions/upload-pages-artifact"):]
    # gates: the existing gate steps, in order, after npm ci (the built-points test needs node_modules/world-atlas)
    assert "actions/upload-pages-artifact" not in gates
    assert "fetch-depth: 0" in gates  # repo_guard --all scans every commit
    assert gates.index("actions/setup-node") < gates.index("- run: npm ci") < gates.index("- run: python -m pytest")
    for gate in ("python -m pytest", "python scripts/repo_guard.py --all", "npm run typecheck", "npm run check:built",
                 "npm run test:e2e"):
        assert f"- run: {gate}" in gates, gate


def test_pages_jobs_run_only_for_a_public_default_branch_or_a_real_refresh():
    """One guard, on both jobs that run code or pack the artifact: deploy needs both, so it inherits it."""
    pages = read("pages.yml")
    pack, gates = if_condition(job(pages, "pack")), if_condition(job(pages, "gates"))
    assert pack == gates
    # the private archive never deploys
    assert "!github.event.repository.private" in pack
    # M3: a push or dispatch deploys only from the default branch (a branch dispatch cannot deploy or queue ahead)
    assert "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)" in pack
    assert "github.event_name == 'workflow_run' ||" in pack  # workflow_run has its own checks below
    # M2: only the real refresh workflow of this repo, never a fork PR workflow named "Refresh data"
    assert "github.event.workflow_run.path == '.github/workflows/refresh-data.yml'" in pack
    assert "github.event.workflow_run.head_repository.full_name == github.repository" in pack
    assert "github.event.workflow_run.event != 'pull_request'" in pack
    assert "github.event_name != 'workflow_run' ||" in pack  # those three bind workflow_run runs only
    # M4: no success condition: the gates re-run on main, so a refresh whose tag step failed after its data push deploys
    assert "conclusion" not in pack
    assert "if:" not in job(pages, "deploy")


