# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib", "cmcrameri"]
# ///
"""Write js/colormaps.js: the viewer's color maps, 32 stops each.

Run: uv run scripts/colormaps.py > js/colormaps.js
"""

import json

import cmcrameri.cm  # noqa: F401  (registers the cmc.* maps)
from matplotlib import colormaps
from matplotlib.colors import to_hex

NAMES = [
    "cmc.batlow", "cmc.lipari", "cmc.lajolla", "cmc.imola", "cmc.glasgow",
    "cmc.devon", "cmc.oslo", "cmc.grayC", "viridis", "magma", "cividis",
]
STOPS = 32

HEADER = """/*
 * Sequential, perceptually uniform color maps for value-encoded layers, in panel
 * order, 32 stops each. Written by scripts/colormaps.py; do not edit by hand.
 *
 * cmc.* maps: Scientific colour maps, Fabio Crameri, MIT License.
 * Crameri, F. (2018). Scientific colour maps. Zenodo.
 * https://doi.org/10.5281/zenodo.1243862
 * viridis, magma, cividis: matplotlib, CC0.
 */
"""

print(HEADER)
print("export const COLOR_MAPS = {")
for name in NAMES:
    stops = [to_hex(colormaps[name](i / (STOPS - 1))) for i in range(STOPS)]
    print(f"  {json.dumps(name)}: {json.dumps(stops)},")
print("};")
