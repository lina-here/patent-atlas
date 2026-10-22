"""Every package site/src and tests/ import is declared in package.json (a transitive copy can vanish on update)."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IMPORT = re.compile(r"""^\s*(?:import|export)\b[^'"]*?from\s+["']([^"'./][^"']*)["']""", re.MULTILINE)
NODE_BUILTIN = re.compile(r"^node:")


def package_of(specifier):
    parts = specifier.split("/")
    return "/".join(parts[:2]) if specifier.startswith("@") else parts[0]


def test_imported_packages_are_declared():
    package = json.loads((ROOT / "package.json").read_text("utf-8"))
    declared = set(package["dependencies"]) | set(package["devDependencies"])
    imported = set()
    for folder in ("site/src", "tests"):
        for path in (ROOT / folder).rglob("*.ts"):
            for specifier in IMPORT.findall(path.read_text("utf-8")):
                if not NODE_BUILTIN.match(specifier):
                    imported.add(package_of(specifier))
    assert imported, "scanner found no imports"
    # a type import of `x` is typed by `@types/x`
    missing = sorted(name for name in imported
                     if name not in declared and "@types/" + name.replace("@", "").replace("/", "__") not in declared)
    assert missing == []
    assert {"geojson", "topojson-specification"} <= imported
    assert {"@types/geojson", "@types/topojson-specification"} <= declared


VALUE_IMPORT = re.compile(r"""^\s*import\s+(?!type\b)[^'"]*?from\s+["']([^"'./][^"']*)["']""", re.MULTILINE)


def test_shipped_packages_are_dependencies_not_dev():
    """What ships to the browser (bundled into site/js/main.js, or world-atlas as site/geo) is in `dependencies`, so
    `npm audit --omit=dev` and Dependabot's severity cover it; type-only imports stay with their @types dev packages."""
    package = json.loads((ROOT / "package.json").read_text("utf-8"))
    bundled = {package_of(specifier) for path in (ROOT / "site/src").rglob("*.ts")
               for specifier in VALUE_IMPORT.findall(path.read_text("utf-8"))}
    assert {"@observablehq/plot", "d3-geo", "topojson-client"} <= bundled
    assert sorted(package["dependencies"]) == sorted(bundled | {"world-atlas"})
    assert not set(package["dependencies"]) & set(package["devDependencies"])
