#!/usr/bin/env python3
"""Convert the committed GeoJSON overlays into the vector PMTiles the page loads.

The repository stores the inventories as GeoJSON rather than as finished
archives: text deltas against the previous version, so an inventory update costs
~144 kB of history instead of ~7 MB, and `git diff` can show which outlines
moved. PMTiles tiles are individually gzipped, which defeats both.

Run locally before `scripts/serve.py`, or in CI before publishing. Needs
tippecanoe on PATH (or --tippecanoe); see .github/workflows/deploy.yml for the
pinned build.

Usage:
    python scripts/build-tiles.py
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=REPO / "data")
    parser.add_argument("--tippecanoe", default="tippecanoe")
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="leave archives that are already newer than their GeoJSON",
    )
    args = parser.parse_args()

    if shutil.which(args.tippecanoe) is None and not Path(args.tippecanoe).is_file():
        print(
            f"tippecanoe not found at {args.tippecanoe!r}. Build it from "
            "https://github.com/felt/tippecanoe or pass --tippecanoe.",
            file=sys.stderr,
        )
        return 1

    index_path = args.data_dir / "inventories.json"
    index = json.loads(index_path.read_text())

    for entry in index["inventories"]:
        # `url` names what the viewer loads; the GeoJSON beside it is the source.
        archive = args.data_dir / entry["url"]
        geojson = archive.with_suffix(".geojson")
        if not geojson.is_file():
            print(f"missing source: {geojson}", file=sys.stderr)
            return 1
        if (
            args.skip_existing
            and archive.is_file()
            and archive.stat().st_mtime >= geojson.stat().st_mtime
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
