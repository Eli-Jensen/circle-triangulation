#!/usr/bin/env python3
"""FastAPI backend for population density sampling and geo queries."""

import logging
from contextlib import asynccontextmanager
from typing import Optional, List

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db
from density import raster_index

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load raster data and database pool on startup, close on shutdown."""
    raster_index.load()
    try:
        await db.init_pool()
        logger.info("Database pool initialized")
    except Exception as e:
        logger.warning(f"Database not available (routing/POI features disabled): {e}")
    yield
    await db.close_pool()
    raster_index.close()


app = FastAPI(title="Circle Triangulation API", lifespan=lifespan)

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


# --- Database-backed endpoints ---


@app.get("/db/health")
async def db_health():
    """Check database connectivity and data counts."""
    if not db.pool:
        return {"status": "unavailable", "message": "Database not connected"}
    try:
        row = await db.fetch_one(
            "SELECT "
            "(SELECT count(*) FROM pois) AS poi_count, "
            "(SELECT count(*) FROM information_schema.tables "
            "  WHERE table_name = 'ways') AS has_ways"
        )
        result = {"status": "ok", "poi_count": row["poi_count"]}
        if row["has_ways"]:
            way_row = await db.fetch_one("SELECT count(*) AS cnt FROM ways")
            result["way_count"] = way_row["cnt"]
        return result
    except Exception as e:
        return {"status": "error", "message": str(e)}


class NearbyPOIRequest(BaseModel):
    lat: float
    lng: float
    radius_meters: float = Field(default=500, ge=50, le=5000)
    categories: Optional[List[str]] = None
    limit: int = Field(default=50, ge=1, le=200)


@app.post("/pois/nearby")
async def pois_nearby(req: NearbyPOIRequest):
    """Find POIs near a point. Categories filter by amenity type."""
    if not db.pool:
        return {"error": "Database not connected", "pois": []}

    category_filter = ""
    params = [req.lng, req.lat, req.radius_meters, req.limit]
    if req.categories:
        placeholders = ", ".join(f"${i+5}" for i in range(len(req.categories)))
        category_filter = f"AND amenity IN ({placeholders})"
        params.extend(req.categories)

    query = f"""
        SELECT osm_id, name, amenity, cuisine, phone, website, opening_hours,
               addr_street, addr_housenumber, addr_city,
               ST_Y(geom) AS lat, ST_X(geom) AS lng,
               ST_Distance(geom::geography,
                           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
        FROM pois
        WHERE ST_DWithin(geom::geography,
                         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                         $3)
          {category_filter}
        ORDER BY distance_m
        LIMIT $4
    """

    rows = await db.fetch_all(query, *params)
    return {
        "count": len(rows),
        "pois": [
            {
                "osm_id": r["osm_id"],
                "name": r["name"],
                "amenity": r["amenity"],
                "cuisine": r["cuisine"],
                "phone": r["phone"],
                "website": r["website"],
                "opening_hours": r["opening_hours"],
                "address": " ".join(filter(None, [r["addr_housenumber"], r["addr_street"], r["addr_city"]])),
                "lat": float(r["lat"]),
                "lng": float(r["lng"]),
                "distance_m": round(float(r["distance_m"]), 1),
            }
            for r in rows
        ],
    }
