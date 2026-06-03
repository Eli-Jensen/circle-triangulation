"""Database connection pool for PostGIS/pgRouting."""

import os

import asyncpg

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ct:ct_dev@localhost:5432/circle_tri",
)

pool: asyncpg.Pool | None = None


async def init_pool():
    """Create the connection pool. Call during app startup."""
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)


async def close_pool():
    """Close the connection pool. Call during app shutdown."""
    global pool
    if pool:
        await pool.close()
        pool = None


async def fetch_one(query: str, *args):
    """Execute a query and return the first row."""
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetch_all(query: str, *args):
    """Execute a query and return all rows."""
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def execute(query: str, *args):
    """Execute a query (INSERT, UPDATE, DELETE)."""
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)
