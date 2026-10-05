/*
 * Decode value-encoded archive tiles for false-color composites
 * (js/composite.js). Tiles are fetched through the PMTiles reader, decoded once
 * and kept; a pixel is decoded with the style's custom encoding.
 */

const MAX_TILES = 128;

const archives = new Map();
const tiles = new Map();

function archive(url) {
  if (!archives.has(url)) archives.set(url, new pmtiles.PMTiles(url));
  return archives.get(url);
}

/* Decode without premultiplication or color management, which would alter the codes. */
async function decodeTile(bytes) {
  const blob = new Blob([bytes], { type: "image/webp" });
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { size: canvas.width, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

/**
 * The decoded RGBA of one archive tile, shared between consumers.
 *
 * @returns {Promise<{size: number, data: Uint8ClampedArray}|null>}  null where
 *   the archive has no tile; rejects, uncached, when the read or decode fails
 */
export function tilePixels(url, z, x, y) {
  const key = `${url}|${z}/${x}/${y}`;
  const cached = tiles.get(key);
  if (cached) {
    // Move to the back of the insertion order: least recently used goes first.
    tiles.delete(key);
    tiles.set(key, cached);
    return cached;
  }
  const pending = archive(url)
    .getZxy(z, x, y)
    .then((response) => (response?.data ? decodeTile(response.data) : null))
    .catch((error) => {
      // Not cached: panning back over this tile should retry it.
      tiles.delete(key);
      throw error;
    });
  tiles.set(key, pending);
  if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  return pending;
}

/** Decode one RGB pixel; null where the code is the declared nodata. */
export function decodePixel(encoding, r, g, b, nodata = 0) {
  if (r === nodata && g === nodata && b === nodata) return null;
  return (
    r * encoding.redFactor +
    g * encoding.greenFactor +
    b * encoding.blueFactor -
    encoding.baseShift
  );
}

/** One code step: the value difference between neighboring codes. */
export const step = (encoding) =>
  encoding.redFactor + encoding.greenFactor + encoding.blueFactor;

