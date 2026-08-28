"""Tests for the inventory index validation in scripts/build-tiles.py.

The index supplies the layer name and the zoom range tippecanoe is given, so a
missing or mistyped field used to surface as a KeyError partway through a run,
after some archives had already been rebuilt.
"""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from test_serve import REPO, _load

build_tiles = _load("build_tiles", REPO / "scripts" / "build-tiles.py")


def entry(**overrides: object) -> dict:
    return {
        "id": "sgi2023",
        "url": "sgi2023.pmtiles",
        "source_layer": "sgi2023",
        "min_zoom": 4,
        "max_zoom": 14,
    } | overrides


class TestValidate(unittest.TestCase):
    def test_accepts_the_committed_index(self) -> None:
        index = json.loads((REPO / "data" / "inventories.json").read_text())
        self.assertEqual(build_tiles.validate(index), index["inventories"])

    def test_accepts_an_empty_list(self) -> None:
        self.assertEqual(build_tiles.validate({"inventories": []}), [])

    def test_rejects_a_missing_array(self) -> None:
        for index in ({}, {"inventories": {}}, {"inventories": None}, []):
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, "inventories"):
                build_tiles.validate(index)

    def test_rejects_a_non_object_entry(self) -> None:
        with self.assertRaisesRegex(ValueError, "entry 0"):
            build_tiles.validate({"inventories": ["sgi2023"]})

    def test_names_the_entry_and_the_missing_field(self) -> None:
        for field in ("id", "url", "source_layer", "min_zoom", "max_zoom"):
            broken = entry()
            del broken[field]
            with self.subTest(field=field), self.assertRaises(ValueError) as caught:
                build_tiles.validate({"inventories": [broken]})
            self.assertIn(field, str(caught.exception))
            if field != "id":
                self.assertIn("sgi2023", str(caught.exception))

    def test_rejects_a_mistyped_field(self) -> None:
        for field, value in (("min_zoom", "4"), ("max_zoom", 14.5), ("source_layer", 3)):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                build_tiles.validate({"inventories": [entry(**{field: value})]})

    def test_rejects_a_bool_where_a_zoom_belongs(self) -> None:
        # bool is a subclass of int, so isinstance alone would let this through.
        with self.assertRaisesRegex(ValueError, "min_zoom"):
            build_tiles.validate({"inventories": [entry(min_zoom=True)]})

    def test_rejects_an_inverted_zoom_range(self) -> None:
        with self.assertRaisesRegex(ValueError, "min_zoom is above max_zoom"):
            build_tiles.validate({"inventories": [entry(min_zoom=14, max_zoom=4)]})

    def test_checks_every_entry_before_returning(self) -> None:
        # Nothing is built until the whole index is known to be sound.
        with self.assertRaisesRegex(ValueError, "second"):
            build_tiles.validate({"inventories": [entry(), entry(id="second", url=None)]})


if __name__ == "__main__":
    unittest.main()
