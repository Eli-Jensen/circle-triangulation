"""Tests for the FastAPI endpoints."""

import pytest


@pytest.mark.anyio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "rasters_loaded" in data


@pytest.mark.anyio
async def test_density_at_point(client):
    resp = await client.post(
        "/density/at-point",
        json={"lat": 38.9072, "lng": -77.0369},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["lat"] == 38.9072
    assert data["lng"] == -77.0369
    assert data["density"] == 42.5


@pytest.mark.anyio
async def test_density_at_points(client):
    resp = await client.post(
        "/density/at-points",
        json={
            "points": [
                {"lat": 38.9, "lng": -77.0},
                {"lat": 39.0, "lng": -77.1},
            ]
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["points"]) == 2
    assert all(p["density"] == 42.5 for p in data["points"])


@pytest.mark.anyio
async def test_density_at_points_empty(client):
    resp = await client.post(
        "/density/at-points",
        json={"points": []},
    )
    assert resp.status_code == 200
    assert resp.json()["points"] == []


@pytest.mark.anyio
async def test_sample_circle(client):
    resp = await client.post(
        "/density/sample-circle",
        json={"lat": 38.9, "lng": -77.0, "radius_meters": 1000, "num_samples": 8},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["center_lat"] == 38.9
    assert data["center_lng"] == -77.0
    assert len(data["samples"]) == 8
    assert data["max_density"] >= 0
    assert 0 <= data["populated_ratio"] <= 1


@pytest.mark.anyio
async def test_list_rasters(client):
    resp = await client.get("/rasters")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["rasters"][0]["iso3"] == "TST"


@pytest.mark.anyio
async def test_db_health_no_db(client):
    resp = await client.get("/db/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "unavailable"


@pytest.mark.anyio
async def test_pois_nearby_no_db(client):
    resp = await client.post(
        "/pois/nearby",
        json={"lat": 38.9, "lng": -77.0, "radius_meters": 500},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["pois"] == []


@pytest.mark.anyio
async def test_invalid_sample_circle_params(client):
    # num_samples below minimum (8)
    resp = await client.post(
        "/density/sample-circle",
        json={"lat": 38.9, "lng": -77.0, "radius_meters": 1000, "num_samples": 2},
    )
    assert resp.status_code == 422  # validation error
