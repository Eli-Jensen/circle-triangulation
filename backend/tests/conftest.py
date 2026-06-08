"""Shared test fixtures for backend tests."""

import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# Add backend directory to path so imports work
sys.path.insert(0, str(Path(__file__).parent.parent))

# Mock asyncpg before anything imports db.py (it may not be installed in test env)
if "asyncpg" not in sys.modules:
    mock_asyncpg = ModuleType("asyncpg")
    mock_asyncpg.create_pool = AsyncMock()
    mock_asyncpg.Pool = MagicMock  # type stub for annotation `asyncpg.Pool`
    sys.modules["asyncpg"] = mock_asyncpg


@pytest.fixture
def mock_raster_index():
    """Mock the raster index with predictable density values."""
    with patch("density.raster_index") as mock_idx:
        mock_idx.rasters = [
            {
                "iso3": "TST",
                "min_lat": 38.0,
                "min_lng": -78.0,
                "max_lat": 40.0,
                "max_lng": -76.0,
            }
        ]
        mock_idx.density_at_point.return_value = 42.5
        mock_idx.density_at_points.side_effect = lambda pts: [
            {**p, "density": 42.5} for p in pts
        ]
        mock_idx.sample_circle_edge.return_value = [
            {"angle": i * 45.0, "lat": 38.9 + i * 0.001, "lng": -77.0 + i * 0.001, "density": 10.0 * i}
            for i in range(8)
        ]
        mock_idx.load.return_value = None
        mock_idx.close.return_value = None
        yield mock_idx


@pytest.fixture
def mock_db():
    """Mock the database pool so it doesn't try to connect."""
    import db
    original_pool = db.pool
    db.pool = None
    with patch.object(db, "init_pool", new_callable=AsyncMock), \
         patch.object(db, "close_pool", new_callable=AsyncMock):
        yield
    db.pool = original_pool


@pytest.fixture
async def client(mock_raster_index, mock_db):
    """Create a test client with mocked dependencies."""
    from app import app

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac
