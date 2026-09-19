#!/usr/bin/env python3
"""Build inventory PMTiles from committed GeoJSON and inventories.json.

Run pixi run --locked build-tiles before local serving or deployment.
Requires tippecanoe on PATH or via --tippecanoe.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parent.parent


def build(
    geojson: Path,
    archive: Path,
    *,
    layer: str,
    min_zoom: int,
    max_zoom: int,
    tippecanoe: str,
) -> int:
    """Run tippecanoe over one overlay and return the archive size in bytes."""
    subprocess.run(
        [
            tippecanoe,
            "-o", str(archive),
            "-Z", str(min_zoom),
            "-z", str(max_zoom),
            "-l", layer,
            "--force",
            "--quiet",
            str(geojson),
        ],
        check=True,
    )
    return archive.stat().st_size


# Validate every entry before building to report malformed metadata early.
REQUIRED = {
    "id": str,
    "url": str,
    "source_layer": str,
    "min_zoom": int,
    "max_zoom": int,
}


def validate(index: object) -> list[dict]:
    """Return the inventory entries, or raise ``ValueError`` naming the problem."""
    if not isinstance(index, dict) or not isinstance(index.get("inventories"), list):
        raise ValueError("no 'inventories' array")
    entries = index["inventories"]
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"entry {position} is not an object")
        name = entry.get("id", f"entry {position}")
        for field, kind in REQUIRED.items():
            if field not in entry:
                raise ValueError(f"{name}: missing '{field}'")
            if not isinstance(entry[field], kind) or isinstance(entry[field], bool):
                raise ValueError(f"{name}: '{field}' must be a {kind.__name__}")
        if entry["min_zoom"] > entry["max_zoom"]:
            raise ValueError(f"{name}: min_zoom is above max_zoom")
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=REPO / "data")
    parser.add_argument("--tippecanoe", default="tippecanoe")
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="leave archives already newer than their GeoJSON and the index",
    )
    args = parser.parse_args()

    if shutil.which(args.tippecanoe) is None and not Path(args.tippecanoe).is_file():
        print(
            f"tippecanoe not found at {args.tippecanoe!r}. Run this through "
            "`pixi run build-tiles` or pass --tippecanoe.",
            file=sys.stderr,
        )
        return 1

    index_path = args.data_dir / "inventories.json"
    index = json.loads(index_path.read_text())
    try:
        entries = validate(index)
    except ValueError as error:
        print(f"{index_path}: {error}", file=sys.stderr)
        return 1

    # Index changes also invalidate archives. Tool upgrades require a full rebuild.
    index_mtime = index_path.stat().st_mtime

    for entry in entries:
        # `url` names what the viewer loads; the GeoJSON beside it is the source.
        archive = args.data_dir / entry["url"]
        geojson = archive.with_suffix(".geojson")
        if not geojson.is_file():
            print(f"missing source: {geojson}", file=sys.stderr)
            return 1
        if (
            args.skip_existing
            and archive.is_file()
            and archive.stat().st_mtime >= max(geojson.stat().st_mtime, index_mtime)
        ):
            print(f"  {archive.name}: up to date")
            continue
        size = build(
            geojson,
            archive,
            layer=entry["source_layer"],
            min_zoom=entry["min_zoom"],
            max_zoom=entry["max_zoom"],
            tippecanoe=args.tippecanoe,
        )
        print(f"  {archive.name}: {size / 1e6:.1f} MB (z{entry['min_zoom']}-{entry['max_zoom']})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
