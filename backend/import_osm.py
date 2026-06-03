#!/usr/bin/env python3
"""Download and import OSM data into PostGIS for routing and POI queries.

Usage:
    python import_osm.py                  # Import DC, MD, VA (default)
    python import_osm.py --regions dc md  # Import specific regions
    python import_osm.py --force          # Re-download and re-import
    python import_osm.py --pois-only      # Only import POIs (skip road network)

Requires system tools:
    brew install osm2pgrouting osm2pgsql  # macOS
    apt install osm2pgrouting osm2pgsql   # Ubuntu/Debian
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import psycopg
import requests
from tqdm import tqdm

DATA_DIR = Path(__file__).parent / "data" / "osm"

# Geofabrik download URLs for US states/territories
REGIONS = {
    "dc": {
        "name": "District of Columbia",
        "url": "https://download.geofabrik.de/north-america/us/district-of-columbia-latest.osm.pbf",
        "size_mb": 20,
    },
    "md": {
        "name": "Maryland",
        "url": "https://download.geofabrik.de/north-america/us/maryland-latest.osm.pbf",
        "size_mb": 201,
    },
    "va": {
        "name": "Virginia",
        "url": "https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf",
        "size_mb": 386,
    },
}

DB_CONN = os.environ.get(
    "DATABASE_URL",
    "postgresql://ct:ct_dev@localhost:5432/circle_tri",
)

# POI amenity types to extract from OSM
POI_AMENITIES = {
    "restaurant", "cafe", "bar", "pub", "fast_food", "food_court",
    "ice_cream", "bakery", "biergarten",
    "library", "museum", "theatre", "cinema", "arts_centre",
    "park", "playground", "sports_centre", "swimming_pool",
    "pharmacy", "hospital", "clinic",
    "bank", "post_office",
    "marketplace", "supermarket",
}


def check_system_deps():
    """Verify required system tools are installed."""
    missing = []
    for tool in ["osm2pgrouting", "osm2pgsql"]:
        if not shutil.which(tool):
            missing.append(tool)

    if missing:
        print(f"ERROR: Missing system tools: {', '.join(missing)}")
        print()
        print("Install them with:")
        print("  macOS:  brew install osm2pgrouting osm2pgsql")
        print("  Ubuntu: apt install osm2pgrouting osm2pgsql")
        sys.exit(1)


def download_region(region_key: str, force: bool = False) -> Path:
    """Download a Geofabrik OSM extract. Returns path to the .pbf file."""
    region = REGIONS[region_key]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{region_key}.osm.pbf"
    filepath = DATA_DIR / filename

    if filepath.exists() and not force:
        print(f"  {region['name']}: already downloaded ({filepath.stat().st_size / 1e6:.0f} MB)")
        return filepath

    print(f"  {region['name']}: downloading (~{region['size_mb']} MB)...")
    resp = requests.get(region["url"], stream=True)
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))

    with open(filepath, "wb") as f:
        with tqdm(total=total, unit="B", unit_scale=True, desc=f"  {region_key}") as pbar:
            for chunk in resp.iter_content(chunk_size=1024 * 256):
                f.write(chunk)
                pbar.update(len(chunk))

    print(f"  {region['name']}: saved to {filepath}")
    return filepath


def merge_pbf_files(pbf_files: list[Path]) -> Path:
    """Merge multiple .pbf files into one using osmium if available."""
    if len(pbf_files) == 1:
        return pbf_files[0]

    merged = DATA_DIR / "merged.osm.pbf"
    if shutil.which("osmium"):
        print("Merging PBF files with osmium...")
        subprocess.run(
            ["osmium", "merge", *[str(f) for f in pbf_files], "-o", str(merged), "--overwrite"],
            check=True,
        )
        return merged

    # Without osmium, import files one by one (handled by caller)
    print("Note: osmium not found. Will import regions one at a time.")
    return None


def import_road_network(pbf_path: Path, is_first: bool = True):
    """Import road network using osm2pgrouting."""
    print(f"  Importing road network from {pbf_path.name}...")

    # Find the osm2pgrouting config file (mapconfig.xml)
    config_candidates = [
        "/opt/homebrew/share/osm2pgrouting/mapconfig.xml",
        "/usr/share/osm2pgrouting/mapconfig.xml",
        "/usr/local/share/osm2pgrouting/mapconfig.xml",
    ]
    config_path = None
    for c in config_candidates:
        if os.path.exists(c):
            config_path = c
            break

    if not config_path:
        # Try to find it via brew
        result = subprocess.run(
            ["brew", "--prefix", "osm2pgrouting"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            candidate = Path(result.stdout.strip()) / "share" / "osm2pgrouting" / "mapconfig.xml"
            if candidate.exists():
                config_path = str(candidate)

    if not config_path:
        print("  WARNING: Could not find mapconfig.xml for osm2pgrouting")
        print("  Trying without explicit config...")
        config_args = []
    else:
        config_args = ["--conf", config_path]

    clean_arg = ["--clean"] if is_first else []

    cmd = [
        "osm2pgrouting",
        "--file", str(pbf_path),
        "--dbname", "circle_tri",
        "--username", "ct",
        "--password", "ct_dev",
        "--host", "localhost",
        "--port", "5432",
        *config_args,
        *clean_arg,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  osm2pgrouting stderr: {result.stderr[:500]}")
        # Try without --clean on failure
        if "--clean" in cmd:
            print("  Retrying without --clean...")
            cmd.remove("--clean")
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                print(f"  ERROR: osm2pgrouting failed: {result.stderr[:500]}")
                return False
    print(f"  Road network imported from {pbf_path.name}")
    return True


def import_pois(pbf_path: Path):
    """Extract POIs from OSM data and insert into the pois table."""
    print(f"  Extracting POIs from {pbf_path.name}...")

    try:
        import osmium

        class POIHandler(osmium.SimpleHandler):
            def __init__(self):
                super().__init__()
                self.pois = []

            def node(self, n):
                tags = dict(n.tags)
                amenity = tags.get("amenity", "")
                # Also check shop, tourism, leisure tags
                if amenity not in POI_AMENITIES:
                    shop = tags.get("shop", "")
                    tourism = tags.get("tourism", "")
                    leisure = tags.get("leisure", "")
                    if shop in ("convenience", "supermarket", "bakery", "butcher", "greengrocer"):
                        amenity = f"shop_{shop}"
                    elif tourism in ("museum", "gallery", "attraction", "viewpoint"):
                        amenity = f"tourism_{tourism}"
                    elif leisure in ("park", "playground", "sports_centre", "swimming_pool"):
                        amenity = leisure
                    else:
                        return

                name = tags.get("name", "")
                if not name and amenity not in ("park", "playground"):
                    return  # Skip unnamed POIs (except parks)

                self.pois.append({
                    "osm_id": n.id,
                    "name": name or None,
                    "amenity": amenity,
                    "cuisine": tags.get("cuisine"),
                    "phone": tags.get("phone") or tags.get("contact:phone"),
                    "website": tags.get("website") or tags.get("contact:website"),
                    "opening_hours": tags.get("opening_hours"),
                    "addr_street": tags.get("addr:street"),
                    "addr_housenumber": tags.get("addr:housenumber"),
                    "addr_city": tags.get("addr:city"),
                    "lat": n.location.lat,
                    "lng": n.location.lon,
                })

        handler = POIHandler()
        handler.apply_file(str(pbf_path), locations=True)

        if not handler.pois:
            print(f"  No POIs found in {pbf_path.name}")
            return

        print(f"  Found {len(handler.pois)} POIs, inserting into database...")

        with psycopg.connect(DB_CONN) as conn:
            with conn.cursor() as cur:
                for poi in handler.pois:
                    cur.execute("""
                        INSERT INTO pois (osm_id, name, amenity, cuisine, phone, website,
                                          opening_hours, addr_street, addr_housenumber,
                                          addr_city, geom)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                        ON CONFLICT (osm_id) DO UPDATE SET
                            name = EXCLUDED.name,
                            amenity = EXCLUDED.amenity,
                            cuisine = EXCLUDED.cuisine,
                            phone = EXCLUDED.phone,
                            website = EXCLUDED.website,
                            opening_hours = EXCLUDED.opening_hours
                    """, (
                        poi["osm_id"], poi["name"], poi["amenity"],
                        poi["cuisine"], poi["phone"], poi["website"],
                        poi["opening_hours"], poi["addr_street"],
                        poi["addr_housenumber"], poi["addr_city"],
                        poi["lng"], poi["lat"],
                    ))
            conn.commit()

        print(f"  Inserted {len(handler.pois)} POIs from {pbf_path.name}")

    except ImportError:
        print("  WARNING: osmium Python package not installed.")
        print("  Falling back to osm2pgsql for POI import...")
        import_pois_via_osm2pgsql(pbf_path)


def import_pois_via_osm2pgsql(pbf_path: Path):
    """Fallback: import POIs using osm2pgsql + post-processing SQL."""
    print(f"  Importing via osm2pgsql from {pbf_path.name}...")
    cmd = [
        "osm2pgsql",
        "--create",
        "--slim",
        "--database", "circle_tri",
        "--username", "ct",
        "--host", "localhost",
        "--port", "5432",
        "--prefix", "osm",
        str(pbf_path),
    ]
    env = os.environ.copy()
    env["PGPASSWORD"] = "ct_dev"

    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        print(f"  ERROR: osm2pgsql failed: {result.stderr[:500]}")
        return

    # Extract POIs from osm2pgsql's planet_osm_point table into our pois table
    amenity_list = ", ".join(f"'{a}'" for a in POI_AMENITIES)
    with psycopg.connect(DB_CONN) as conn:
        with conn.cursor() as cur:
            cur.execute(f"""
                INSERT INTO pois (osm_id, name, amenity, cuisine, phone, website,
                                  opening_hours, geom)
                SELECT osm_id, name, amenity,
                       tags->'cuisine', tags->'phone', tags->'website',
                       tags->'opening_hours',
                       ST_Transform(way, 4326)
                FROM osm_point
                WHERE amenity IN ({amenity_list})
                  AND name IS NOT NULL
                ON CONFLICT (osm_id) DO NOTHING
            """)
        conn.commit()
        print(f"  POIs extracted via osm2pgsql")


def check_db_connection():
    """Verify we can connect to the database."""
    try:
        with psycopg.connect(DB_CONN) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT PostGIS_Version()")
                version = cur.fetchone()[0]
                print(f"  PostGIS version: {version}")

                # Check pgRouting
                try:
                    cur.execute("SELECT pgr_version()")
                    pgr_version = cur.fetchone()[0]
                    print(f"  pgRouting version: {pgr_version}")
                except Exception:
                    print("  pgRouting: not installed yet (will be available after road import)")

        return True
    except Exception as e:
        print(f"ERROR: Cannot connect to database: {e}")
        print()
        print("Make sure the database is running:")
        print("  docker compose up -d")
        print("  # Wait a few seconds for it to start")
        return False


def print_summary():
    """Print a summary of imported data."""
    try:
        with psycopg.connect(DB_CONN) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM pois")
                poi_count = cur.fetchone()[0]

                way_count = 0
                try:
                    cur.execute("SELECT count(*) FROM ways")
                    way_count = cur.fetchone()[0]
                except Exception:
                    pass

                vertex_count = 0
                try:
                    cur.execute("SELECT count(*) FROM ways_vertices_pgr")
                    vertex_count = cur.fetchone()[0]
                except Exception:
                    pass

        print()
        print("=" * 40)
        print("Import Summary")
        print("=" * 40)
        print(f"  POIs:          {poi_count:,}")
        print(f"  Road segments: {way_count:,}")
        print(f"  Vertices:      {vertex_count:,}")
        print("=" * 40)
    except Exception as e:
        print(f"Could not print summary: {e}")


def main():
    parser = argparse.ArgumentParser(description="Import OSM data into PostGIS")
    parser.add_argument(
        "--regions", nargs="+", default=["dc", "md", "va"],
        choices=list(REGIONS.keys()),
        help="Regions to import (default: dc md va)",
    )
    parser.add_argument("--force", action="store_true", help="Re-download and re-import")
    parser.add_argument("--pois-only", action="store_true", help="Only import POIs")
    parser.add_argument("--roads-only", action="store_true", help="Only import road network")
    args = parser.parse_args()

    print("Circle Triangulation — OSM Data Import")
    print("=" * 40)

    # Check system dependencies
    if not args.pois_only:
        check_system_deps()

    # Check database connection
    print("\nChecking database connection...")
    if not check_db_connection():
        sys.exit(1)

    # Download regions
    print(f"\nDownloading OSM data for: {', '.join(r.upper() for r in args.regions)}")
    pbf_files = []
    for region_key in args.regions:
        pbf_path = download_region(region_key, force=args.force)
        pbf_files.append(pbf_path)

    # Import road network
    if not args.pois_only:
        print("\nImporting road network...")
        for i, pbf_path in enumerate(pbf_files):
            success = import_road_network(pbf_path, is_first=(i == 0))
            if not success:
                print(f"  WARNING: Road import failed for {pbf_path.name}, continuing...")

    # Import POIs
    if not args.roads_only:
        print("\nImporting POIs...")
        for pbf_path in pbf_files:
            import_pois(pbf_path)

    # Summary
    print_summary()
    print("\nDone! Start the backend with: make backend")


if __name__ == "__main__":
    main()
