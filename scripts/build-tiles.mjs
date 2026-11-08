/*
 * Build inventory PMTiles from committed GeoJSON and inventories.json.
 *
 * Usage: npm run build-tiles [-- --skip-existing] [--data-dir data] [--tippecanoe PATH]
 *
 * Run it before local serving or deployment. It needs tippecanoe on PATH or via
 * --tippecanoe; the deploy workflow builds the version in TIPPECANOE_VERSION.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Validate every entry before building to report malformed metadata early. */
const REQUIRED = {
  id: "string",
  url: "string",
  source_layer: "string",
  min_zoom: "integer",
  max_zoom: "integer",
};

const fits = (value, kind) => (kind === "integer" ? Number.isInteger(value) : typeof value === kind);

/** The inventory entries, or a thrown Error naming the problem. */
export function validate(index) {
  if (index === null || typeof index !== "object" || Array.isArray(index) || !Array.isArray(index.inventories)) {
    throw new Error("no 'inventories' array");
  }
  const entries = index.inventories;
  entries.forEach((entry, position) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`entry ${position} is not an object`);
    }
    const name = entry.id ?? `entry ${position}`;
    for (const [field, kind] of Object.entries(REQUIRED)) {
      if (!(field in entry)) throw new Error(`${name}: missing '${field}'`);
      if (!fits(entry[field], kind)) throw new Error(`${name}: '${field}' must be a ${kind}`);
    }
    if (!entry.url.endsWith(".pmtiles")) throw new Error(`${name}: 'url' must end in .pmtiles`);
    if (entry.min_zoom > entry.max_zoom) throw new Error(`${name}: min_zoom is above max_zoom`);
  });
  return entries;
}

/** Run tippecanoe over one overlay and return the archive size in bytes. */
function build(geojson, archive, { layer, minZoom, maxZoom, tippecanoe }) {
  execFileSync(
    tippecanoe,
    ["-o", archive, "-Z", String(minZoom), "-z", String(maxZoom), "-l", layer, "--force", "--quiet", geojson],
    { stdio: "inherit" },
  );
  return fs.statSync(archive).size;
}

function hasTippecanoe(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", default: path.join(REPO, "data") },
      tippecanoe: { type: "string", default: "tippecanoe" },
      /* Leave archives already newer than their GeoJSON and the index. */
      "skip-existing": { type: "boolean", default: false },
    },
  });
  const dataDir = path.resolve(values["data-dir"]);

  if (!hasTippecanoe(values.tippecanoe)) {
    console.error(`tippecanoe not found at '${values.tippecanoe}'. Install it (README.md) or pass --tippecanoe.`);
    return 1;
  }

  const indexPath = path.join(dataDir, "inventories.json");
  let entries;
  try {
    entries = validate(JSON.parse(fs.readFileSync(indexPath, "utf8")));
  } catch (error) {
    console.error(`${indexPath}: ${error.message}`);
    return 1;
  }

  /* Index changes also invalidate archives. Tool upgrades require a full rebuild. */
  const indexTime = fs.statSync(indexPath).mtimeMs;

  for (const entry of entries) {
    /* `url` names what the viewer loads; the GeoJSON beside it is the source. */
    const archive = path.join(dataDir, entry.url);
    const geojson = archive.replace(/\.pmtiles$/, ".geojson");
    const source = fs.statSync(geojson, { throwIfNoEntry: false });
    if (!source?.isFile()) {
      console.error(`missing source: ${geojson}`);
      return 1;
    }
    const built = fs.statSync(archive, { throwIfNoEntry: false });
    if (values["skip-existing"] && built?.isFile() && built.mtimeMs >= Math.max(source.mtimeMs, indexTime)) {
      console.log(`  ${path.basename(archive)}: up to date`);
      continue;
    }
    const size = build(geojson, archive, {
      layer: entry.source_layer,
      minZoom: entry.min_zoom,
      maxZoom: entry.max_zoom,
      tippecanoe: values.tippecanoe,
    });
    console.log(`  ${path.basename(archive)}: ${(size / 1e6).toFixed(1)} MB (z${entry.min_zoom}-${entry.max_zoom})`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
