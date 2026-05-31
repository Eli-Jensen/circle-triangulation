#!/usr/bin/env python3
"""FastAPI backend for population density sampling."""

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from density import raster_index


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load raster data on startup, close on shutdown."""
    raster_index.load()
    yield
    raster_index.close()


app = FastAPI(title="Population Density API", lifespan=lifespan)

# Allow the frontend (served on a different port) to call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Request/Response models ---

class PointRequest(BaseModel):
    lat: float
    lng: float


class CircleRequest(BaseModel):
    lat: float
    lng: float
    radius_meters: float
    num_samples: int = Field(default=360, ge=8, le=3600)


class MultiPointRequest(BaseModel):
    points: list[PointRequest]


class DensitySample(BaseModel):
    angle: Optional[float] = None
    lat: float
    lng: float
    density: float


class CircleResponse(BaseModel):
    center_lat: float
    center_lng: float
    radius_meters: float
    samples: list[DensitySample]
    max_density: float
    populated_ratio: float


class PointDensityResponse(BaseModel):
    points: list[DensitySample]


# --- Endpoints ---

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "rasters_loaded": len(raster_index.rasters),
    }


@app.post("/density/at-point", response_model=DensitySample)
async def density_at_point(req: PointRequest):
    """Get population density at a single lat/lng."""
    density = raster_index.density_at_point(req.lat, req.lng)
    return DensitySample(
        lat=req.lat,
        lng=req.lng,
        density=round(density, 4) if density is not None else 0.0,
    )


@app.post("/density/at-points", response_model=PointDensityResponse)
async def density_at_points(req: MultiPointRequest):
    """Get population density at multiple points (e.g. intersection points)."""
    points = [{"lat": p.lat, "lng": p.lng} for p in req.points]
    results = raster_index.density_at_points(points)
    return PointDensityResponse(
        points=[DensitySample(**r) for r in results]
    )


@app.post("/density/sample-circle", response_model=CircleResponse)
async def sample_circle(req: CircleRequest):
    """Sample population density around a circle's circumference.

    Returns density at evenly-spaced points around the edge, plus summary stats.
    The frontend uses this to draw circle edges with varying opacity/thickness.
    """
    samples = raster_index.sample_circle_edge(
        req.lat, req.lng, req.radius_meters, req.num_samples
    )

    densities = [s["density"] for s in samples]
    max_density = max(densities) if densities else 0.0
    populated = sum(1 for d in densities if d > 0)
    populated_ratio = populated / len(densities) if densities else 0.0

    return CircleResponse(
        center_lat=req.lat,
        center_lng=req.lng,
        radius_meters=req.radius_meters,
        samples=[DensitySample(**s) for s in samples],
        max_density=round(max_density, 4),
        populated_ratio=round(populated_ratio, 4),
    )


@app.get("/rasters")
async def list_rasters():
    """List loaded raster files and their coverage."""
    return {
        "count": len(raster_index.rasters),
        "rasters": [
            {
                "iso3": r["iso3"],
                "bounds": {
                    "min_lat": r["min_lat"],
                    "min_lng": r["min_lng"],
                    "max_lat": r["max_lat"],
                    "max_lng": r["max_lng"],
                },
            }
            for r in raster_index.rasters
        ],
    }
