"""Test byte ranges and mount containment with raw socket requests.

HTTP clients normalize traversal paths before sending them, hiding the cases
these tests need to exercise.
"""

from __future__ import annotations

from functools import partial
import importlib.util
from http.server import ThreadingHTTPServer
from pathlib import Path
import socket
import sys
import tempfile
import threading
from typing import NamedTuple
import unittest

REPO = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    """Import a script that is not on the path and whose name may contain a dash."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


serve = _load("serve", REPO / "scripts" / "serve.py")

BODY = b"0123456789abcdef"


class Response(NamedTuple):
    status: int
    headers: dict[str, str]
    body: bytes


class ServerTestCase(unittest.TestCase):
    """A live server over a temporary web root and tile directory."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        root = Path(cls._tmp.name)

        cls.web_dir = root / "web"
        (cls.web_dir / "js").mkdir(parents=True)
        (cls.web_dir / "index.html").write_bytes(b"<!doctype html>")
        (cls.web_dir / "js" / "app.js").write_bytes(b"// app")

        cls.tiles_dir = root / "tiles"
        (cls.tiles_dir / "nested").mkdir(parents=True)
        (cls.tiles_dir / "sample.pmtiles").write_bytes(BODY)
        (cls.tiles_dir / "with space.json").write_bytes(b"{}")
        (cls.tiles_dir / "nested" / "deep.pmtiles").write_bytes(BODY)

        # Outside the mount, and named so a successful read is unmistakable.
        (root / "secret.txt").write_bytes(b"ESCAPED")

        class QuietHandler(serve.RangeRequestHandler):
            """The handler under test, minus the per-request line on stderr."""

            tiles_dir = cls.tiles_dir.resolve()

            def log_message(self, *args: object) -> None:
                pass

        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(cls.web_dir))
        )
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls._tmp.cleanup()

    def get(self, path: str, headers: str = "") -> Response:
        """Send a request line verbatim, without any client-side normalization."""
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(f"GET {path} HTTP/1.0\r\nHost: t\r\n{headers}\r\n".encode())
            chunks = []
            while chunk := sock.recv(8192):
                chunks.append(chunk)
        head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
        lines = head.decode("latin-1").splitlines()
        fields = dict(
            (name.strip().lower(), value.strip())
            for name, _, value in (line.partition(":") for line in lines[1:])
        )
        return Response(int(lines[0].split()[1]), fields, body)


class TestPathContainment(ServerTestCase):
    def test_serves_a_file_in_the_mount(self) -> None:
        response = self.get("/tiles/sample.pmtiles")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, BODY)

    def test_serves_a_nested_file(self) -> None:
        self.assertEqual(self.get("/tiles/nested/deep.pmtiles").status, 200)

    def test_percent_decodes_the_name(self) -> None:
        # The containment check must not cost ordinary escaped characters.
        self.assertEqual(self.get("/tiles/with%20space.json").status, 200)

    def assertBlocked(self, path: str, headers: str = "") -> None:
        """The request is refused, and none of the target file comes back."""
        response = self.get(path, headers)
        self.assertEqual(response.status, 404, f"{path} was served")
        self.assertNotIn(b"ESCAPED", response.body)

    def test_rejects_dot_dot_escape(self) -> None:
        # Exactly one level up from the mount, which is where secret.txt is: a
        # deeper climb would be stopped by the filesystem rather than by the
        # check under test, and would pass even with the check removed.
        self.assertBlocked("/tiles/../secret.txt")

    def test_rejects_dot_dot_escape_from_a_subdirectory(self) -> None:
        self.assertBlocked("/tiles/nested/../../secret.txt")

    def test_rejects_encoded_dot_dot_escape(self) -> None:
        # The path is unquoted before the check, so an encoded climb cannot walk
        # past it either.
        self.assertBlocked("/tiles/%2e%2e/secret.txt")
        self.assertBlocked("/tiles/..%2fsecret.txt")

    def test_rejects_an_absolute_looking_path(self) -> None:
        # A leading slash would otherwise make pathlib discard the mount and
        # resolve against the filesystem root.
        response = self.get("/tiles//etc/hostname")
        self.assertEqual(response.status, 404)

    def test_escape_is_rejected_for_a_range_request_too(self) -> None:
        # The range branch opens the file itself, so it needs its own guard.
        self.assertBlocked("/tiles/../secret.txt", "Range: bytes=0-3\r\n")

    def test_the_web_root_is_still_served(self) -> None:
        self.assertEqual(self.get("/index.html").status, 200)
        self.assertEqual(self.get("/js/app.js").status, 200)


class TestRangeRequests(ServerTestCase):
    def test_no_range_returns_the_whole_body(self) -> None:
        response = self.get("/tiles/sample.pmtiles")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, BODY)

    def test_closed_range(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=0-3\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, b"0123")
        self.assertEqual(response.headers["content-range"], f"bytes 0-3/{len(BODY)}")
        self.assertEqual(response.headers["content-length"], "4")

    def test_open_ended_range(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=10-\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, BODY[10:])

    def test_suffix_range(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=-4\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, b"cdef")

    def test_suffix_longer_than_the_file_is_clamped(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=-9999\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, BODY)

    def test_end_past_the_file_is_clamped(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=12-9999\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, BODY[12:])

    def test_last_byte(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=15-15\r\n")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.body, b"f")

    def test_start_past_the_end_is_unsatisfiable(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=9999-\r\n")
        self.assertEqual(response.status, 416)
        self.assertEqual(response.headers["content-range"], f"bytes */{len(BODY)}")

    def test_inverted_range_is_unsatisfiable(self) -> None:
        self.assertEqual(self.get("/tiles/sample.pmtiles", "Range: bytes=5-2\r\n").status, 416)

    def test_zero_length_suffix_is_unsatisfiable(self) -> None:
        self.assertEqual(self.get("/tiles/sample.pmtiles", "Range: bytes=-0\r\n").status, 416)

    def test_range_naming_neither_end_is_ignored(self) -> None:
        # `bytes=-` matches the grammar with both groups empty. int("") used to
        # raise here, and the connection was dropped with no response at all.
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=-\r\n")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, BODY)

    def test_unparseable_range_is_ignored(self) -> None:
        response = self.get("/tiles/sample.pmtiles", "Range: bytes=abc\r\n")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, BODY)

    def test_range_on_a_missing_file(self) -> None:
        self.assertEqual(self.get("/tiles/nope.pmtiles", "Range: bytes=0-3\r\n").status, 404)


class TestCacheHeaders(ServerTestCase):
    def test_the_page_shell_is_never_stored(self) -> None:
        # A stale js/app.js leaves the page silently rendering the old version.
        for path in ("/index.html", "/js/app.js"):
            with self.subTest(path=path):
                self.assertIn("no-store", self.get(path).headers["cache-control"])

    def test_archives_are_cacheable(self) -> None:
        self.assertNotIn("cache-control", self.get("/tiles/sample.pmtiles").headers)


if __name__ == "__main__":
    unittest.main()
