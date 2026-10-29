"""WCAG 2.x contrast of theme tokens, all themes (final review M9-M13): graphics >= 3:1 (1.4.11), text >= 4.5:1 (1.4.3).
Reads site/themes/*.css custom properties; `var(--x)` resolved; rgba composited over the pair's background."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
THEMES = sorted(path.stem for path in (ROOT / "site" / "themes").glob("*.css"))

# (foreground, background, minimum ratio, where it is drawn)
PAIRS = [
    ("map-edge", "surface", 3, "map shape and heat-cell edge vs card (light bins keep their fill)"),
    ("map-dot-border", "surface", 3, "map dot edge vs card"),
    ("map-hatch", "map-hatch-bg", 3, "no-data hatch line on its ground (map, share band, heat strip)"),
    ("map-neutral-line", "map-neutral", 3, "neutral cross-hatch line on its ground"),
    ("map-zero-mark", "map-zero", 3, "reported-zero dots on their ground"),
    ("map-former-line", "map-former", 3, "former-entity hatch line on its ground"),
    ("map-member", "surface", 3, "PCT member fill vs card"),
    ("map-nonmember-mark", "map-nonmember", 3, "PCT non-member pattern marks on their ground"),
    ("control-border", "surface", 3, "select/input border in a card"),
    ("control-border", "bg", 3, "select/input border on the page"),
    ("pulse-ink", "bg", 4.5, ".pulse newest-year text on the page"),
    ("pulse-ink", "surface", 4.5, ".pulse text on a card"),
]


def tokens(theme: str) -> dict[str, str]:
    text = (ROOT / "site" / "themes" / f"{theme}.css").read_text()
    return {match.group(1): match.group(2).strip() for match in re.finditer(r"--([a-z0-9-]+)\s*:\s*([^;]+);", text)}


def colour(value: str, table: dict[str, str]) -> tuple[tuple[float, float, float], float]:
    seen = set()
    while value.startswith("var("):
        name = value[len("var(--"):-1].strip()
        assert name not in seen, f"var loop at {name}"
        seen.add(name)
        value = table[name]
    if value.startswith("#"):
        digits = value[1:]
        if len(digits) == 3:
            digits = "".join(c * 2 for c in digits)
        return tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4)), 1.0
    match = re.fullmatch(r"rgba?\(([^)]+)\)", value)
    assert match, f"not a colour: {value}"
    parts = [float(part) for part in match.group(1).split(",")]
    return tuple(parts[:3]), parts[3] if len(parts) > 3 else 1.0


def over(fg, bg):
    (rgb, alpha), (base, _) = fg, bg
    return tuple(alpha * x + (1 - alpha) * y for x, y in zip(rgb, base)), 1.0


def luminance(rgb) -> float:
    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(value) for value in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b) -> float:
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def test_four_themes():
    assert THEMES == ["atlas", "embed", "paper", "wallboard"]


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("fg,bg,need,where", PAIRS)
def test_contrast(theme, fg, bg, need, where):
    table = tokens(theme)
    assert fg in table and bg in table, f"{theme}: --{fg} / --{bg} missing ({where})"
    background = colour(table[bg], table)
    backgrounds = [background]
    if bg == "bg" and "grid-line" in table:  # page graticule over --bg: also the worst-case line pixel
        backgrounds.append(over(colour(table["grid-line"], table), background))
    foreground = colour(table[fg], table)
    worst = min(ratio(over(foreground, back)[0], back[0]) for back in backgrounds)
    assert worst >= need, f"{theme}: --{fg} on --{bg} = {worst:.2f} < {need} ({where})"


@pytest.mark.parametrize("theme", THEMES)
def test_map_and_heat_strokes_use_the_edge_token(theme):
    """The 3:1 edge must be what base.css draws: shapes, heat cells and their swatches stroke --map-edge."""
    base = (ROOT / "site" / "css" / "base.css").read_text()
    assert re.search(r"\.map-shape \{ stroke: var\(--map-edge\)[^}]*vector-effect: non-scaling-stroke", base)
    assert re.search(r"\.heat-cell,\s*\.heat-legend-swatch,\s*\.hatch-pct-monthly \{ stroke: var\(--map-edge\)", base)
    assert re.search(r"\.heat-cell rect,\s*\.heat-legend-swatch,\s*\.hatch-pct-monthly \{ vector-effect: non-scaling-stroke", base)
    assert re.search(r"select,\s*input \{[^}]*border: var\(--rule-width\) solid var\(--control-border\)", base)
    assert re.search(r"\.pulse \{[^}]*color: var\(--pulse-ink\)", base)
    assert "--map-border:" not in (ROOT / "site" / "themes" / f"{theme}.css").read_text()


@pytest.mark.parametrize("theme", THEMES)
def test_map_edge_width_is_at_least_one_pixel(theme):
    """N4: a thinner anti-aliased edge blends below 3:1 on 1x screens; the width is a px token of at least 1."""
    width = tokens(theme)["map-edge-width"]
    match = re.fullmatch(r"([0-9.]+)px", width)
    assert match, f"{theme}: --map-edge-width {width!r} is not px"
    assert float(match.group(1)) >= 1, f"{theme}: --map-edge-width {width} < 1px"


def test_membership_bins_use_their_tokens():
    """PCT membership layer: member = --map-member fill, non-member = its own pattern (map.ts NONMEMBER_ID)."""
    base = (ROOT / "site" / "css" / "base.css").read_text()
    assert re.search(r'\.map-shape\[data-bin="member"\] \{ fill: var\(--map-member\); \}', base)
    assert re.search(r'\.map-shape\[data-bin="nonmember"\] \{ fill: url\(#world-map-nonmember\); \}', base)
    assert re.search(r"\.map-nonmember-bg \{ fill: var\(--map-nonmember\); \}", base)
    assert re.search(r"\.map-nonmember-mark \{ fill: var\(--map-nonmember-mark\); \}", base)


CONTINENT_TOKENS = ["continent-africa", "continent-asia", "continent-europe", "continent-latin-america-caribbean",
                    "continent-northern-america", "continent-oceania", "treemap-residual"]
TREEMAP_TEXT_MIN = 4.5
TREEMAP_TEXT_MIN_WALLBOARD = 7  # conference wallboard readability


@pytest.mark.parametrize("theme", THEMES)
@pytest.mark.parametrize("fill", CONTINENT_TOKENS)
def test_treemap_label_contrast(theme, fill):
    """Treemap labels are --ink or --surface, whichever contrasts more with the rectangle (treemap.ts); that best
    contrast must reach 4.5:1 (wallboard 7:1) for every continent fill and for the solid plate behind the label on
    the hatched rest."""
    table = tokens(theme)
    need = TREEMAP_TEXT_MIN_WALLBOARD if theme == "wallboard" else TREEMAP_TEXT_MIN
    ground = colour(table[fill], table)[0]
    best = max(ratio(colour(table[label], table)[0], ground) for label in ("ink", "surface"))
    assert best >= need, f"{theme}: label on --{fill} = {best:.2f} < {need}"


@pytest.mark.parametrize("theme", THEMES)
def test_treemap_residual_label_on_a_solid_plate(theme):
    """The rest's label sits on a solid --treemap-residual plate, so the hatch tokens never lie under text."""
    base = (ROOT / "site" / "css" / "base.css").read_text()
    assert re.search(r"\.treemap-plate \{[^}]*fill: var\(--treemap-residual\)", base)
    assert re.search(r"\.treemap-residual \{[^}]*fill: url\(#treemap-hatch\)", base)
    assert "treemap-residual" in tokens(theme)


@pytest.mark.parametrize("theme", THEMES)
def test_treemap_band_outline_is_thin_enough_not_to_hide_small_rectangles(theme):
    """The continent outline is a px token between the rectangle stroke's width and the chart line width: any wider hides
    the fill of a small rectangle that touches it (treemap.spec.ts measures the fill that stays visible)."""
    table = tokens(theme)
    band = float(re.fullmatch(r"([0-9.]+)px", table["treemap-band-width"]).group(1))
    assert float(re.fullmatch(r"([0-9.]+)px", table["map-edge-width"]).group(1)) <= band, theme
    assert band <= float(re.fullmatch(r"([0-9.]+)px", table["chart-line-width"]).group(1)), theme


@pytest.mark.parametrize("theme", THEMES)
def test_treemap_key_number_size_is_a_theme_token(theme):
    """The digit in each key swatch is sized by a theme token (an em ratio of the key text), not by the script."""
    assert re.fullmatch(r"[0-9.]+em", tokens(theme)["treemap-key-number-size"]), theme
    base = (ROOT / "site" / "css" / "base.css").read_text()
    assert re.search(r"\.treemap-key-number \{[^}]*font-size: var\(--treemap-key-number-size\)", base)
