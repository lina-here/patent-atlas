#!/usr/bin/env python3
"""Map geometry for the site (npm script `geo:build`), from npm `world-atlas` (node_modules, Natural Earth admin-0).
- site/geo/countries-110m.json: the 110m topology, `countries` object only (`land` and arcs only it used dropped),
  plus `sources`. 50m is over the 500 KB file limit (data check note §4).
- site/geo/points.json: {points: {code: [lon, lat]}, sources}: one dot per entities.json country with no 110m
  feature; centroid of the largest polygon of its 50m feature (10m when 50m has none). Ring longitudes are unwrapped
  before area and centroid (KI, TV, WS, TO cross 180), result wrapped to +-180. Which dots show (data in the chosen
  year) is decided by the site. A country with no feature at any resolution gets no point: the site lists it
  "not drawn on map".
- site/geo/LICENSE-world-atlas.txt: world-atlas ISC notice (must stay with copies).
ISO2 -> M49 numeric from pipeline/m49.json (= world-atlas ids). Python stdlib only.
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORLD_ATLAS = ROOT / "node_modules" / "world-atlas"
ENTITIES = ROOT / "site" / "data" / "entities.json"
M49 = ROOT / "pipeline" / "m49.json"
OUT = ROOT / "site" / "geo"
COUNTRIES_FILE = "countries-110m.json"
POINTS_FILE = "points.json"
LICENSE_FILE = "LICENSE-world-atlas.txt"
# resolutions searched for a dot, in order
POINT_RESOLUTIONS = ("50m", "10m")
# dot coordinates rounded to this many decimals (~1 m: far below any drawn size)
POINT_DECIMALS = 5

Point = tuple[float, float]
Ring = list[Point]


def decode_arcs(topology: dict) -> list[Ring]:
    """Absolute [lon, lat] arcs; quantized topologies (`transform`) are delta-encoded."""
    transform = topology.get("transform")
    if not transform:
        return [[(float(x), float(y)) for x, y, *_ in arc] for arc in topology["arcs"]]
    (scale_x, scale_y), (translate_x, translate_y) = transform["scale"], transform["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy, *_ in arc:
            x += dx
            y += dy
            points.append((x * scale_x + translate_x, y * scale_y + translate_y))
        arcs.append(points)
    return arcs


def ring_points(arc_ids: list[int], arcs: list[Ring]) -> Ring:
    """A ring from its arc indices (~i = arc i reversed); shared end points kept once."""
    ring: Ring = []
    for index in arc_ids:
        points = arcs[index] if index >= 0 else list(reversed(arcs[~index]))
        ring.extend(points if not ring else points[1:])
    return ring


def polygons(geometry: dict, arcs: list[Ring]) -> list[list[Ring]]:
    """Polygons (outer ring first, then holes) of a Polygon or MultiPolygon geometry; [] otherwise."""
    if geometry.get("type") == "Polygon":
        parts = [geometry["arcs"]]
    elif geometry.get("type") == "MultiPolygon":
        parts = geometry["arcs"]
    else:
        return []
    return [[ring_points(ring, arcs) for ring in polygon] for polygon in parts]


def unwrap(ring: Ring) -> Ring:
    """Longitudes made continuous: a step over 180 degrees is a crossing of the antimeridian, not a jump."""
    if not ring:
        return []
    out = [ring[0]]
    for lon, lat in ring[1:]:
        previous = out[-1][0]
        while lon - previous > 180:
            lon -= 360
        while lon - previous < -180:
            lon += 360
        out.append((lon, lat))
    return out


def wrap_lon(lon: float) -> float:
    """Longitude in [-180, 180)."""
    return (lon + 180) % 360 - 180


def ring_area(ring: Ring) -> float:
    """Planar shoelace area in degrees^2, unsigned (orientation differs between sources)."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2


def ring_centroid(ring: Ring) -> Point:
    """Planar area centroid; the vertex mean for a degenerate (zero-area) ring."""
    twice_area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        twice_area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if twice_area == 0:
        return sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring)
    return cx / (3 * twice_area), cy / (3 * twice_area)


def largest_outer_ring(parts: list[list[Ring]]) -> Ring:
    """Unwrapped outer ring of the largest polygon: a centroid of the whole would average islands across 180."""
    return max((unwrap(polygon[0]) for polygon in parts if polygon and polygon[0]), key=ring_area)


def dot_for(parts: list[list[Ring]]) -> Point:
    lon, lat = ring_centroid(largest_outer_ring(parts))
    return round(wrap_lon(lon), POINT_DECIMALS), round(lat, POINT_DECIMALS)


def in_bbox(point: Point, ring: Ring) -> bool:
    """`point` (wrapped) inside the bounding box of the unwrapped `ring`, at any 360-degree shift."""
    lons, lats = [x for x, _ in ring], [y for _, y in ring]
    lon, lat = point
    return (min(lats) <= lat <= max(lats)
            and any(min(lons) <= lon + shift <= max(lons) for shift in (-360, 0, 360)))


def features_by_id(topology: dict) -> dict[str, list[dict]]:
    """Geometries of `countries` by id (50m has a duplicate id 036; features without id left out)."""
    found: dict[str, list[dict]] = {}
    for geometry in topology["objects"]["countries"]["geometries"]:
        if "id" in geometry:
            found.setdefault(geometry["id"], []).append(geometry)
    return found


def prune(topology: dict, sources: list[dict]) -> dict:
    """The topology with the `countries` object only, arcs it does not use dropped and indices renumbered."""
    countries = topology["objects"]["countries"]
    used: dict[int, int] = {}

    def renumber(item):
        if isinstance(item, list):
            return [renumber(child) for child in item]
        original = item if item >= 0 else ~item
        new = used.setdefault(original, len(used))
        return new if item >= 0 else ~new

    geometries = [{**geometry, "arcs": renumber(geometry["arcs"])} if "arcs" in geometry else geometry
                  for geometry in countries["geometries"]]
    arcs = [None] * len(used)
    for original, new in used.items():
        arcs[new] = topology["arcs"][original]
    pruned = {key: value for key, value in topology.items() if key not in ("objects", "arcs")}
    return {**pruned, "objects": {"countries": {**countries, "geometries": geometries}}, "arcs": arcs,
            "sources": sources}


def country_numerics(entities: list[dict], m49: dict) -> dict[str, str]:
    """ISO2 -> M49 numeric for every entities.json country (fails loudly when m49.json lacks one)."""
    codes = sorted(entity["code"] for entity in entities if entity["kind"] == "country")
    missing = [code for code in codes if code not in m49["countries"]]
    if missing:
        raise ValueError(f"countries missing from pipeline/m49.json: {missing}")
    return {code: m49["countries"][code]["numeric"] for code in codes}


def build_points(numerics: dict[str, str], base: dict, finer: dict[str, dict]) -> dict[str, list[float]]:
    """A dot for each country without a feature in `base` (110m), from the first of `finer` (resolution -> topology)
    that has one. Each dot is checked against its polygon's unwrapped bbox."""
    base_ids = set(features_by_id(base))
    decoded = {name: (features_by_id(topology), decode_arcs(topology)) for name, topology in finer.items()}
    points: dict[str, list[float]] = {}
    for code, numeric in sorted(numerics.items()):
        if numeric in base_ids:
            continue
        for features, arcs in decoded.values():
            if numeric not in features:
                continue
            parts = [part for geometry in features[numeric] for part in polygons(geometry, arcs)]
            if not parts:
                continue
            point = dot_for(parts)
            if not in_bbox(point, largest_outer_ring(parts)):
                raise ValueError(f"{code}: dot {point} outside its polygon's bounding box")
            points[code] = list(point)
            break
    return points


def world_atlas_sources(version: str, files: list[str]) -> list[dict]:
    return [{
        "name": f"world-atlas {version} (Natural Earth admin-0 countries, public domain)",
        "url": "https://github.com/topojson/world-atlas",
        "licence": f"ISC, copyright Michael Bostock: notice in {LICENSE_FILE}",
        "files": files,
    }]


def main() -> int:
    if not WORLD_ATLAS.is_dir():
        print(f"{WORLD_ATLAS} missing: run npm ci first", file=sys.stderr)
        return 1
    version = json.loads((WORLD_ATLAS / "package.json").read_text("utf-8"))["version"]
    load = lambda name: json.loads((WORLD_ATLAS / f"countries-{name}.json").read_text("utf-8"))  # noqa: E731
    base = load("110m")
    numerics = country_numerics(json.loads(ENTITIES.read_text("utf-8")), json.loads(M49.read_text("utf-8")))
    points = build_points(numerics, base, {name: load(name) for name in POINT_RESOLUTIONS})
    OUT.mkdir(parents=True, exist_ok=True)
    countries = prune(base, world_atlas_sources(version, ["countries-110m.json"]))
    (OUT / COUNTRIES_FILE).write_text(json.dumps(countries, separators=(",", ":")) + "\n", encoding="utf-8")
    point_sources = world_atlas_sources(version, [f"countries-{name}.json" for name in POINT_RESOLUTIONS])
    point_sources[0]["method"] = ("centroid of the largest polygon of the country's feature (first resolution that "
                                  "has one), longitudes unwrapped across 180")
    (OUT / POINTS_FILE).write_text(json.dumps({"points": points, "sources": point_sources}, indent=1,
                                              sort_keys=True) + "\n", encoding="utf-8")
    shutil.copyfile(WORLD_ATLAS / "LICENSE", OUT / LICENSE_FILE)
    unplaced = sorted(code for code, numeric in numerics.items()
                      if code not in points and numeric not in features_by_id(base))
    print(f"{COUNTRIES_FILE}: {len(countries['arcs'])} arcs; {POINTS_FILE}: {len(points)} dots; "
          f"no feature at any resolution: {', '.join(unplaced) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
