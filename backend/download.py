#!/usr/bin/env python3
"""Download WorldPop 100m constrained population density rasters."""

import json
import os
import sys
import requests
from pathlib import Path
from tqdm import tqdm

DATA_DIR = Path(__file__).parent / "data" / "population"
COUNTRIES_FILE = Path(__file__).parent / "countries.json"

# WorldPop constrained 100m population estimates (2020, UN-adjusted)
# BSGM directory has global coverage; maxar_v1 only has Africa.
WORLDPOP_BASE = "https://data.worldpop.org/GIS/Population/Global_2000_2020_Constrained/2020/BSGM"


def get_download_url(iso3: str) -> str:
    """Build the WorldPop download URL for a country."""
    iso_lower = iso3.lower()
    return f"{WORLDPOP_BASE}/{iso3}/{iso_lower}_ppp_2020_UNadj_constrained.tif"


def download_file(url: str, dest: Path, max_retries: int = 3) -> bool:
    """Download a file with progress bar and retries. Returns True on success."""
    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.get(url, stream=True, timeout=(15, 120))
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  FAILED (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                print("  Retrying...")
                continue
            return False

        total = int(resp.headers.get("content-length", 0))
        try:
            with open(dest, "wb") as f, tqdm(
                total=total, unit="B", unit_scale=True, desc=dest.name, ncols=80
            ) as bar:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)
                    bar.update(len(chunk))
            return True
        except (requests.RequestException, IOError) as e:
            print(f"  FAILED during download (attempt {attempt}/{max_retries}): {e}")
            dest.unlink(missing_ok=True)
            if attempt < max_retries:
                print("  Retrying...")
                continue
            return False
    return False


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(COUNTRIES_FILE) as f:
        config = json.load(f)

    countries = config["countries"]

    # Allow filtering by ISO3 codes or region on the command line
    filters = [a.upper() for a in sys.argv[1:]] if len(sys.argv) > 1 else []

    if filters:
        countries = [
            c for c in countries
            if c["iso3"] in filters or c.get("region", "").upper() in filters
        ]

    if not countries:
        print("No countries matched. Usage:")
        print("  python download.py                  # download all")
        print("  python download.py USA CAN GBR      # specific countries")
        print('  python download.py "NORTH AMERICA"   # by region')
        return

    print(f"Will download {len(countries)} country raster(s):")
    for c in countries:
        print(f"  {c['iso3']} — {c['name']}")
    print()

    succeeded = 0
    failed = []

    for c in countries:
        iso3 = c["iso3"]
        dest = DATA_DIR / f"{iso3.lower()}_pop.tif"

        if dest.exists():
            size_mb = dest.stat().st_size / (1024 * 1024)
            print(f"[SKIP] {iso3} ({c['name']}) — already downloaded ({size_mb:.0f} MB)")
            succeeded += 1
            continue

        url = get_download_url(iso3)
        print(f"[DOWNLOAD] {iso3} ({c['name']})")
        print(f"  URL: {url}")

        if download_file(url, dest):
            size_mb = dest.stat().st_size / (1024 * 1024)
            print(f"  OK — {size_mb:.0f} MB")
            succeeded += 1
        else:
            # Clean up partial file
            dest.unlink(missing_ok=True)
            failed.append(c)

    print(f"\nDone: {succeeded} succeeded, {len(failed)} failed.")
    if failed:
        print("Failed countries:")
        for c in failed:
            print(f"  {c['iso3']} — {c['name']}")


if __name__ == "__main__":
    main()
