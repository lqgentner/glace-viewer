/*
 * Serve the viewer with byte ranges for PMTiles and an optional /tiles mount.
 *
 * Usage: npm run serve [-- --tiles-dir DIR] [--port 8000] [--bind 127.0.0.1] [--web-dir .]
 *
 * Open http://localhost:8000/ for the configured remote store, or add
 * ?tiles=tiles to select the local mount. Use localhost rather than 127.0.0.1
 * for the configured basemap's development access. Build inventory tiles first
 * with npm run build-tiles.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const RANGE = /^bytes=(\d*)-(\d*)$/;
const MOUNT = "/tiles/";
/* Reload page code and JSON; allow normal caching for tiles and archives. */
const NO_STORE = new Set(["", ".html", ".js", ".mjs", ".css", ".json"]);
const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** Whether `target` is `dir` or lies under it. */
function inside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `target` with its symlinks resolved, or as it is when it does not exist. */
function real(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

const isFile = (target) => fs.statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;

/* A path's decoded text, or null when it is malformed or holds a NUL, which the file system refuses. */
function decode(text) {
  try {
    const decoded = decodeURIComponent(text);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * A /tiles path in the mounted directory, or null when it is missing or
 * escapes the directory, also through a symlink. The name is decoded before
 * the check, so an encoded climb is caught too.
 */
function tilesTarget(dir, clean) {
  const name = decode(clean.slice(MOUNT.length))?.replace(/^\/+/, "");
  if (name == null) return null;
  const target = real(path.resolve(dir, name));
  return inside(dir, target) && isFile(target) ? target : null;
}

/** A web-root path: normalized first, so a climb stops at the root. */
function webTarget(webDir, clean) {
  const name = decode(clean);
  if (name === null) return null;
  const target = path.resolve(webDir, `.${path.posix.normalize(`/${name}`)}`);
  return inside(webDir, target) ? target : null;
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain", "Accept-Ranges": "bytes" });
  res.end("File not found");
}

/** Send `file`, or the single byte range the request names. A malformed range is ignored. */
function send(req, res, file, clean) {
  /* Open before any header goes out, so an unreadable file is a 404 rather than a dropped connection. */
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    console.error(`${req.method} ${req.url}:`, error.message);
    notFound(res);
    return;
  }
  const { size, mtime } = fs.fstatSync(fd);
  const headers = {
    "Content-Type": typeOf(file),
    "Accept-Ranges": "bytes",
    "Last-Modified": mtime.toUTCString(),
  };
  if (NO_STORE.has(path.posix.extname(clean))) headers["Cache-Control"] = "no-store, must-revalidate";

  const match = RANGE.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  let status = 200;
  /* `bytes=-` matches the grammar with neither end and is ignored too. */
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
    } else {
      /* A suffix range ("bytes=-500") asks for the final N bytes. */
      start = Math.max(0, size - Number(match[2]));
    }
    if (start >= size || start > end) {
      fs.closeSync(fd);
      res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || size === 0) {
    fs.closeSync(fd);
    res.end();
    return;
  }
  /* pipeline closes the file too when the browser cancels the request, as a pan cancels tile reads. */
  pipeline(fs.createReadStream(null, { fd, start, end }), res, (error) => {
    if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error(`${req.method} ${req.url}:`, error.message);
  });
}

/**
 * A server for the page in `webDir` and the GLACE catalog root mounted under
 * /tiles/. Directories are resolved, symlinks included. `log` prints each request.
 */
export function createServer({ webDir, tilesDir, log = false }) {
  const root = real(path.resolve(webDir));
  const tiles = real(path.resolve(tilesDir));
  return http.createServer((req, res) => {
    if (log) res.on("finish", () => console.log(`${req.method} ${req.url} ${res.statusCode}`));
    try {
      handle(req, res, root, tiles);
    } catch (error) {
      /* One bad request must not stop the server. */
      console.error(`${req.method} ${req.url}:`, error.message);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server error");
      }
    }
  });
}

/* Answer one GET or HEAD request from the web root or the tiles mount. */
function handle(req, res, root, tiles) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(501, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  const clean = req.url.split("?", 1)[0].split("#", 1)[0];
  if (clean.startsWith(MOUNT)) {
    const target = tilesTarget(tiles, clean);
    if (target) send(req, res, target, clean);
    else notFound(res);
    return;
  }
  const target = webTarget(root, clean);
  const stat = target && fs.statSync(target, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    /* As a static host does: a directory's address ends with a slash, and its index.html answers. */
    if (!clean.endsWith("/")) {
      /* One leading slash: "//js" must not become a redirect to the host "js". */
      const local = clean.replace(/^[/\\]+/, "/");
      res.writeHead(301, { Location: `${local}/${req.url.slice(clean.length)}` });
      res.end();
      return;
    }
    const index = path.join(target, "index.html");
    if (isFile(index)) send(req, res, index, clean);
    else notFound(res);
    return;
  }
  if (stat?.isFile()) send(req, res, target, clean);
  else notFound(res);
}

function main() {
  const { values } = parseArgs({
    options: {
      "web-dir": { type: "string", default: "." },
      "tiles-dir": { type: "string", default: "tiles" },
      port: { type: "string", default: "8000" },
      bind: { type: "string", default: "127.0.0.1" },
    },
  });
  const webDir = path.resolve(values["web-dir"]);
  const tilesDir = path.resolve(values["tiles-dir"]);
  if (!isFile(path.join(webDir, "index.html"))) {
    console.error(`No index.html in ${webDir}`);
    process.exit(1);
  }
  /* A local catalog is optional: ?tiles= can point at object storage. */
  if (!fs.statSync(tilesDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.log(`No ${tilesDir}; pass ?tiles=<base-url> to read the archives remotely.`);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Not a port: ${values.port}`);
    process.exit(1);
  }
  const server = createServer({ webDir, tilesDir, log: true });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use; pass --port.` : error.message);
    process.exit(1);
  });
  server.listen(port, values.bind, () => {
    /* Protomaps development access requires localhost in the browser origin. */
    const host = values.bind === "127.0.0.1" ? "localhost" : values.bind;
    console.log(`Serving ${webDir} (tiles: ${tilesDir}) on http://${host}:${port}/`);
  });
  process.on("SIGINT", () => {
    console.log("\nStopped.");
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
