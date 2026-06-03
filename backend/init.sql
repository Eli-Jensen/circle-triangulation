-- Initialize PostGIS, pgRouting, and hstore extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;

-- pgRouting may not be available in the base postgis image;
-- the import script installs it if missing.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgrouting;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgRouting extension not available yet — will be installed during import';
END
$$;

-- POI table (populated from OSM data)
CREATE TABLE IF NOT EXISTS pois (
  id BIGSERIAL PRIMARY KEY,
  osm_id BIGINT UNIQUE,
  name TEXT,
  amenity TEXT,
  cuisine TEXT,
  phone TEXT,
  website TEXT,
  opening_hours TEXT,
  addr_street TEXT,
  addr_housenumber TEXT,
  addr_city TEXT,
  geom GEOMETRY(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pois_geom ON pois USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_pois_amenity ON pois(amenity);
CREATE INDEX IF NOT EXISTS idx_pois_name ON pois USING GIN(to_tsvector('english', COALESCE(name, '')));
