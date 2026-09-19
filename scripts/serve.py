"""Serve the viewer with byte ranges for PMTiles and an optional /tiles mount.

Usage: pixi run --locked serve [--tiles-dir DIR]

Open http://localhost:8000/ for the configured remote store, or add
?tiles=tiles to select the local mount. Use localhost rather than 127.0.0.1
for the configured basemap's development access. Build inventory tiles first
with pixi run --locked build-tiles.
"""

from __future__ import annotations

import argparse
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
import sys
from typing import IO
from urllib.parse import unquote

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
# Reload page code and JSON; allow normal caching for tiles and archives.
NO_STORE_SUFFIXES = frozenset({"", ".html", ".js", ".css", ".json"})


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Static handler that honors single-range ``Range`` requests."""

    # Reuse connections across tile requests.
    protocol_version = "HTTP/1.1"

    # mimetypes lacks the web app manifest type.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
    }

    tiles_dir: Path

    @staticmethod
    def _request_path(path: str) -> str:
        """The path component of a request line, without the query or fragment."""
        return path.split("?", 1)[0].split("#", 1)[0]

    def _tiles_target(self, clean: str) -> Path | None:
        """Resolve a /tiles path, rejecting traversal and symlinks outside the mount."""
        target = (self.tiles_dir / unquote(clean.removeprefix("/tiles/")).lstrip("/")).resolve()
        return target if target.is_relative_to(self.tiles_dir) else None

    def translate_path(self, path: str) -> str:
        """Map ``/tiles/...`` onto the tile directory, everything else onto the web root."""
        clean = self._request_path(path)
        if clean.startswith("/tiles/"):
            target = self._tiles_target(clean)
            # Keep direct callers contained too; send_head rejects escaping paths.
            return str(target if target is not None else self.tiles_dir)
        return super().translate_path(path)

    def send_head(self) -> _Slice | IO[bytes] | None:
        """Answer a byte-range request, falling back to the full-body handler."""
        clean = self._request_path(self.path)
        if clean.startswith("/tiles/") and self._tiles_target(clean) is None:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        header = self.headers.get("Range")
        match = RANGE_RE.match(header) if header else None
        # Ignore malformed ranges, including bytes=- with neither endpoint.
        if match is None or not (match.group(1) or match.group(2)):
            return super().send_head()

        path = self.translate_path(self.path)
        try:
            handle = Path(path).open("rb")  # noqa: SIM115
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = os.fstat(handle.fileno()).st_size
        first, last = match.group(1), match.group(2)
        if first:
            start = int(first)
            end = int(last) if last else size - 1
        else:
            # A suffix range ("bytes=-500") asks for the final N bytes.
            start, end = max(0, size - int(last)), size - 1
        if start >= size or start > end:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            handle.close()
            return None

        end = min(end, size - 1)
        handle.seek(start)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        # SimpleHTTPRequestHandler copies to the end of the file, so hand it
        # only the requested slice.
        return _Slice(handle, end - start + 1)

    def end_headers(self) -> None:
        """Advertise byte ranges and prevent stale page code and JSON on reload."""
        self.send_header("Accept-Ranges", "bytes")
        suffix = Path(self.path.split("?", 1)[0]).suffix
        if suffix in NO_STORE_SUFFIXES:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


class _Slice:
    """Read-only view of the first ``length`` bytes from the current file offset."""

    def __init__(self, handle: IO[bytes], length: int) -> None:
        self._handle = handle
        self._remaining = length

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        want = self._remaining if size < 0 else min(size, self._remaining)
        chunk = self._handle.read(want)
        self._remaining -= len(chunk)
        return chunk

    def close(self) -> None:
        self._handle.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-dir", default=".", help="directory holding index.html")
    parser.add_argument(
        "--tiles-dir",
        default="tiles",
        help="local GLACE archives to mount under /tiles; optional",
    )
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    web_dir, tiles_dir = Path(args.web_dir).resolve(), Path(args.tiles_dir).resolve()
    if not (web_dir / "index.html").is_file():
        sys.exit(f"No index.html in {web_dir}")
    # A local tile directory is optional: ?tiles= can point at object storage.
    if not tiles_dir.is_dir():
        print(f"No {tiles_dir}; pass ?tiles=<base-url> to read the archives remotely.")

    handler = partial(RangeRequestHandler, directory=str(web_dir))
    RangeRequestHandler.tiles_dir = tiles_dir
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        # Protomaps development access requires localhost in the browser origin.
        host = "localhost" if args.bind == "127.0.0.1" else args.bind
        print(f"Serving {web_dir} (tiles: {tiles_dir}) on http://{host}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
