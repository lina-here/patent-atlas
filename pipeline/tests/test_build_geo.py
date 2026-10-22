"""scripts/build_geo.py: antimeridian-safe dots, arc pruning, and the committed site/geo files."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import pytest  # noqa: E402
import build_geo  # noqa: E402

GEO = ROOT / "site" / "geo"
WORLD_ATLAS = ROOT / "node_modules" / "world-atlas"
needs_world_atlas = pytest.mark.skipif(not WORLD_ATLAS.is_dir(), reason="node_modules/world-atlas not installed")


def square(west, east, south=-1.0, north=1.0):
    """Hand-made ring; `west` > `east` means it crosses 180."""
    return [(west, south), (east, south), (east, north), (west, north), (west, south)]


def test_unwrap_ring_crossing_antimeridian():
    ring = build_geo.unwrap(square(179.0, -179.0))
    assert [lon for lon, _ in ring] == [179.0, 181.0, 181.0, 179.0, 179.0]


def test_dot_of_ring_crossing_180_sits_on_180_not_0():
    lon, lat = build_geo.dot_for([[square(179.0, -179.0)]])
    assert abs(abs(lon) - 180) < 1e-9 and abs(lat) < 1e-9


def test_dot_wrapped_to_range():
    lon, _ = build_geo.dot_for([[square(179.0, -177.0)]])  # centroid 180 + 1 -> -179
    assert lon == pytest.approx(-179.0)


def test_largest_polygon_wins_over_average():
    small, large = square(-179.5, -179.0), square(170.0, 178.0, -5, 5)
    lon, lat = build_geo.dot_for([[small], [large]])
    assert (lon, lat) == pytest.approx((174.0, 0.0))


def test_in_bbox_any_shift():
    ring = build_geo.unwrap(square(179.0, -179.0))
    assert build_geo.in_bbox((-179.5, 0.0), ring)
    assert not build_geo.in_bbox((0.0, 0.0), ring)


def test_decode_quantized_arcs_and_reversed_ring():
    topology = {"transform": {"scale": [1, 1], "translate": [10, 20]}, "arcs": [[[0, 0], [2, 0], [0, 2]]]}
    arcs = build_geo.decode_arcs(topology)
    assert arcs == [[(10, 20), (12, 20), (12, 22)]]
    assert build_geo.ring_points([~0], arcs) == [(12, 22), (12, 20), (10, 20)]


def test_prune_drops_unused_arcs_and_renumbers():
    topology = {"type": "Topology", "arcs": [["a"], ["b"], ["c"]], "objects": {
        "countries": {"type": "GeometryCollection", "geometries": [
            {"type": "Polygon", "arcs": [[2, ~2]], "id": "001"}, {"type": "Point", "coordinates": [0, 0]}]},
        "land": {"type": "GeometryCollection", "geometries": [{"type": "Polygon", "arcs": [[0, 1]]}]}}}
    pruned = build_geo.prune(topology, [{"name": "x"}])
    assert set(pruned["objects"]) == {"countries"}
    assert pruned["arcs"] == [["c"]]
    assert pruned["objects"]["countries"]["geometries"][0]["arcs"] == [[0, ~0]]
    assert pruned["sources"] == [{"name": "x"}]


def test_country_numerics_fail_loudly():
    with pytest.raises(ValueError, match="ZZ"):
        build_geo.country_numerics([{"code": "ZZ", "kind": "country"}], {"countries": {}})


def point_in_ring(point, ring):
    lon, lat = point
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > lat) != (y1 > lat) and lon < x0 + (lat - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


@needs_world_atlas
def test_built_points_inside_their_feature():
    """Every committed dot lies in its feature's unwrapped bbox; SG's dot inside SG's polygon."""
    points = json.loads((GEO / "points.json").read_text("utf-8"))["points"]
    m49 = json.loads((ROOT / "pipeline" / "m49.json").read_text("utf-8"))["countries"]
    decoded = {}
    for name in build_geo.POINT_RESOLUTIONS:
        topology = json.loads((WORLD_ATLAS / f"countries-{name}.json").read_text("utf-8"))
        decoded[name] = (build_geo.features_by_id(topology), build_geo.decode_arcs(topology))
    for code, point in points.items():
        features, arcs = next(found for found in decoded.values() if m49[code]["numeric"] in found[0])
        parts = [part for geometry in features[m49[code]["numeric"]] for part in build_geo.polygons(geometry, arcs)]
        ring = build_geo.largest_outer_ring(parts)
        assert build_geo.in_bbox(tuple(point), ring), code
        if code == "SG":
            assert point_in_ring(tuple(point), ring)


def test_committed_geo_files_contract():
    """Every entities.json country without a 110m feature has a dot, unless no resolution has it (BQ);
    both files carry sources and stay under the data size limit."""
    countries = json.loads((GEO / build_geo.COUNTRIES_FILE).read_text("utf-8"))
    points_file = json.loads((GEO / build_geo.POINTS_FILE).read_text("utf-8"))
    assert set(countries["objects"]) == {"countries"}
    assert countries["sources"] and points_file["sources"]
    ids = {geometry.get("id") for geometry in countries["objects"]["countries"]["geometries"]}
    entities = json.loads((ROOT / "site" / "data" / "entities.json").read_text("utf-8"))
    m49 = json.loads((ROOT / "pipeline" / "m49.json").read_text("utf-8"))
    featureless = {code for code, numeric in build_geo.country_numerics(entities, m49).items() if numeric not in ids}
    points = points_file["points"]
    assert set(points) == featureless - {"BQ"}  # BQ: no feature at 110m, 50m or 10m (data check note §4)
    assert {"SG", "HK", "MT", "LI", "MC", "TV", "KI"} <= set(points)
    for lon, lat in points.values():
        assert -180 <= lon < 180 and -90 <= lat <= 90
    assert (GEO / build_geo.LICENSE_FILE).read_text("utf-8").startswith("Copyright")
