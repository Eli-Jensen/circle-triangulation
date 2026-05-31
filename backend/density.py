"""Population density raster reader.

Loads all downloaded GeoTIFF files and provides fast point/circle sampling.
Uses a spatial index (bounding boxes) to quickly find the right raster for any point.
"""

import math
import os
from pathlib import Path
from typing import Optional

import numpy as np
import rasterio
from rasterio.transform import rowcol

DATA_DIR = Path(__file__).parent / "data" / "population"


class RasterIndex:
    """Spatial index over multiple country rasters."""

    def __init__(self):
        self.rasters: list[dict] = []
        self._open_datasets: dict[str, rasterio.DatasetReader] = {}

    def load(self):
        """Scan data directory and index all .tif files by bounding box."""
        tif_files = sorted(DATA_DIR.glob("*.tif"))
        if not tif_files:
            print(f"WARNING: No .tif files found in {DATA_DIR}")
            return

        for path in tif_files:
            try:
                ds = rasterio.open(path)
                bounds = ds.bounds  # (left, bottom, right, top) = (minx, miny, maxx, maxy)
                self.rasters.append({
                    "path": str(path),
                    "iso3": path.stem.replace("_pop", "").upper(),
                    "bounds": bounds,
                    "min_lng": bounds.left,
                    "min_lat": bounds.bottom,
                    "max_lng": bounds.right,
                    "max_lat": bounds.top,
                })
                # Keep dataset open for fast reads
                self._open_datasets[str(path)] = ds
            except Exception as e:
                print(f"WARNING: Could not open {path}: {e}")

        print(f"Loaded {len(self.rasters)} population raster(s)")

    def close(self):
        """Close all open datasets."""
        for ds in self._open_datasets.values():
            ds.close()
        self._open_datasets.clear()

    def _find_raster(self, lat: float, lng: float) -> Optional[dict]:
        """Find the raster that contains a given point."""
        for r in self.rasters:
            if (r["min_lat"] <= lat <= r["max_lat"] and
                    r["min_lng"] <= lng <= r["max_lng"]):
                return r
        return None

    def density_at_point(self, lat: float, lng: float) -> Optional[float]:
        """Get population density at a single point. Returns None if no data."""
        raster = self._find_raster(lat, lng)
        if not raster:
            return None

        ds = self._open_datasets.get(raster["path"])
        if not ds:
            return None

        try:
            row, col = rowcol(ds.transform, lng, lat)
            if 0 <= row < ds.height and 0 <= col < ds.width:
                window = rasterio.windows.Window(col, row, 1, 1)
                data = ds.read(1, window=window)
                val = float(data[0, 0])
                # WorldPop uses nodata for ocean/uninhabited
                if val == ds.nodata or np.isnan(val) or val < 0:
                    return 0.0
                return val
            return None
        except Exception:
            return None

    def sample_circle_edge(
        self, lat: float, lng: float, radius_meters: float, num_samples: int = 360
    ) -> list[dict]:
        """Sample population density at evenly-spaced points around a circle's edge.

        Returns a list of {angle, lat, lng, density} dicts, one per sample point.
        """
        R = 6371000  # Earth radius in meters
        results = []

        for i in range(num_samples):
            angle = (2 * math.pi * i) / num_samples
            angle_deg = (360.0 * i) / num_samples

            # Destination point given distance and bearing from start
            lat1 = math.radians(lat)
            lng1 = math.radians(lng)
            d = radius_meters / R

            lat2 = math.asin(
                math.sin(lat1) * math.cos(d) +
                math.cos(lat1) * math.sin(d) * math.cos(angle)
            )
            lng2 = lng1 + math.atan2(
                math.sin(angle) * math.sin(d) * math.cos(lat1),
                math.cos(d) - math.sin(lat1) * math.sin(lat2)
            )

            pt_lat = math.degrees(lat2)
            pt_lng = math.degrees(lng2)
            density = self.density_at_point(pt_lat, pt_lng)

            results.append({
                "angle": round(angle_deg, 2),
                "lat": round(pt_lat, 6),
                "lng": round(pt_lng, 6),
                "density": round(density, 4) if density is not None else 0.0,
            })

        return results

    def density_at_points(self, points: list[dict]) -> list[dict]:
        """Get density at a list of {lat, lng} points.

        Returns the input list with a 'density' field added to each.
        """
        results = []
        for pt in points:
            density = self.density_at_point(pt["lat"], pt["lng"])
            results.append({
                **pt,
                "density": round(density, 4) if density is not None else 0.0,
            })
        return results


# Module-level singleton
raster_index = RasterIndex()
