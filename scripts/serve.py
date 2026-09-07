"""Serve the viewer locally, with the HTTP range support PMTiles needs.

``http.server`` answers every request with the whole file, which a PMTiles
client cannot use: it fetches the header, the directory and each tile as byte
ranges. This server adds ``Range`` handling and, given ``--tiles-dir``, mounts a
local copy of the GLACE archives under ``/tiles``.

The GLACE archives live on object storage and ``site-config.js`` points the page
there, so the plain command already shows them and ``--tiles-dir`` is only for
reading a local build instead:

    uv run --locked python scripts/serve.py
    # -> http://localhost:8000/            the published store
    # -> http://localhost:8000/?tiles=tiles   whatever is mounted under /tiles

Use ``localhost``, not ``127.0.0.1``: the basemap reads Protomaps' hosted API,
and its CORS exemption for local development matches the ``localhost``
hostname exactly, not the loopback IP.

Run ``scripts/build-tiles.py`` first: the inventory archives are build outputs
and are not committed.

Usage:
    uv run --locked python scripts/serve.py [--tiles-dir DIR]
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
# Page-shell files and the small manifests are re-read on every reload; tiles
# and archives are not.
NO_STORE_SUFFIXES = frozenset({"", ".html", ".js", ".css", ".json"})
# The inventory overlays are megabytes each and change only when the exporter is
# re-run, so they revalidate instead of being re-sent.
REVALIDATE_SUFFIXES = frozenset({".geojson"})


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Static handler that honours single-range ``Range`` requests."""

    # A map view fetches hundreds of small tiles; without keep-alive each one
    # pays for a fresh connection.
    protocol_version = "HTTP/1.1"

    # ``mimetypes`` has no entry for ``.webmanifest``, and Chrome rejects one
    # served as ``application/octet-stream`` with a console warning and nothing else.
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
        """Resolve a ``/tiles/...`` request, or ``None`` if it escapes ``tiles_dir``.

        Normalising the relative part is not enough on its own: ``..`` survives
        ``normpath`` when it is already leading, so ``/tiles/../../etc/passwd``
        used to resolve outside the mount. Harmless behind the localhost
        default, but this server takes ``--bind``. Resolve the whole path and
        require the result to still be inside the directory.
        """
        target = (self.tiles_dir / unquote(clean.removeprefix("/tiles/")).lstrip("/")).resolve()
        return target if target.is_relative_to(self.tiles_dir) else None

    def translate_path(self, path: str) -> str:
        """Map ``/tiles/...`` onto the tile directory, everything else onto the web root."""
        clean = self._request_path(path)
        if clean.startswith("/tiles/"):
            target = self._tiles_target(clean)
            # send_head() rejects an escaping path before it gets this far; the
            # fallback keeps a caller that did not go through it inside the mount.
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
        # ``bytes=-`` matches the grammar but names neither end of a range.
        # RFC 9110 says to ignore a Range header that cannot be satisfied, which
        # is also what the full-body handler does.
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
        """Advertise range support, and set caching to match how each file changes.

        The archives are immutable once built and worth caching, but ``index.html``,
        ``js/app.js`` and ``style.css`` are edited between reloads. Without ``no-store``
        the browser reuses a stale script and the page silently keeps rendering the
        previous version.

        The ``.geojson`` overlays are the exception: several megabytes apiece, but
        rewritten only when the exporter runs. ``no-cache`` still forces a
        revalidation on every reload, so a re-export is picked up at once, while an
        unchanged file costs a ``304`` instead of the whole body.
        """
        self.send_header("Accept-Ranges", "bytes")
        suffix = Path(self.path.split("?", 1)[0]).suffix
        if suffix in NO_STORE_SUFFIXES:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        elif suffix in REVALIDATE_SUFFIXES:
            self.send_header("Cache-Control", "no-cache")
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
        # "localhost", not the 127.0.0.1 the socket is bound to: the browser's
        # Origin header has to read exactly "localhost" for the Protomaps API
        # key's CORS exemption for local development to match.
        host = "localhost" if args.bind == "127.0.0.1" else args.bind
        print(f"Serving {web_dir} (tiles: {tiles_dir}) on http://{host}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
