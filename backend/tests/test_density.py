"""Tests for the density module (unit tests, no raster files needed)."""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from density import RasterIndex


def test_raster_index_init():
    """RasterIndex starts empty."""
    idx = RasterIndex()
    assert idx.rasters == []
    assert idx._open_datasets == {}


def test_density_at_point_no_rasters():
    """Returns None when no rasters are loaded."""
    idx = RasterIndex()
    result = idx.density_at_point(38.9, -77.0)
    assert result is None


def test_density_at_points_no_rasters():
    """Returns 0.0 density for all points when no rasters loaded."""
    idx = RasterIndex()
    points = [{"lat": 38.9, "lng": -77.0}, {"lat": 39.0, "lng": -77.1}]
    results = idx.density_at_points(points)
    assert len(results) == 2
    assert all(r["density"] == 0.0 for r in results)
    # Preserves input coordinates
    assert results[0]["lat"] == 38.9
    assert results[1]["lng"] == -77.1


def test_sample_circle_edge_no_rasters():
    """Returns samples with 0.0 density when no rasters loaded."""
    idx = RasterIndex()
    samples = idx.sample_circle_edge(38.9, -77.0, 1000, num_samples=8)
    assert len(samples) == 8
    assert all(s["density"] == 0.0 for s in samples)
    # Check angles are evenly distributed
    angles = [s["angle"] for s in samples]
    assert angles[0] == 0.0
    assert abs(angles[1] - 45.0) < 0.01


def test_sample_circle_edge_geometry():
    """Verify sampled points are roughly the right distance from center."""
    idx = RasterIndex()
    center_lat, center_lng = 38.9, -77.0
    radius_m = 5000  # 5 km
    samples = idx.sample_circle_edge(center_lat, center_lng, radius_m, num_samples=4)

    R = 6371000  # Earth radius in meters
    for s in samples:
        # Haversine distance from center
        dlat = math.radians(s["lat"] - center_lat)
        dlng = math.radians(s["lng"] - center_lng)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(center_lat)) *
             math.cos(math.radians(s["lat"])) *
             math.sin(dlng / 2) ** 2)
        dist = 2 * R * math.asin(math.sqrt(a))
        # Should be within 1% of requested radius
        assert abs(dist - radius_m) / radius_m < 0.01, f"Distance {dist:.0f}m, expected {radius_m}m"
