/*
 * Copy what the import map in index.html loads from node_modules/ into a site
 * directory. Each target's whole directory goes, so files a library fetches
 * beside its module come along; source maps, development builds and type
 * declarations stay behind.
 *
 * Usage: node scripts/stage-libraries.mjs <site-dir>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /\.map$|-dev\.mjs$|\.d\.m?ts$/;

/** The import map's imports, read from index.html. */
export function importMap() {
  const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  return JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
}

/** Copy every import-map target's directory under siteDir, keeping its path. */
export function stageLibraries(siteDir) {
  const dirs = new Set();
  for (const [name, target] of Object.entries(importMap())) {
    if (!target.startsWith("./node_modules/")) throw new Error(`${name} maps outside node_modules: ${target}`);
    dirs.add(path.dirname(target));
  }
  for (const dir of dirs) {
    fs.cpSync(path.join(REPO, dir), path.join(siteDir, dir), {
      recursive: true,
      filter: (source) => !SKIP.test(source),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/stage-libraries.mjs <site-dir>");
    process.exit(2);
  }
  stageLibraries(path.resolve(process.argv[2]));
}
