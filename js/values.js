/*
 * Read the value under the cursor out of a value-encoded archive. The tile at
 * the archive's maximum zoom is fetched through the PMTiles reader, decoded once
 * and kept, and the pixel is decoded with the style's custom encoding.
 */

const TILE_PX = 256;
const MAX_TILES = 48;

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

function tilePixels(url, z, x, y) {
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
    .catch(() => null);
  tiles.set(key, pending);
  if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  return pending;
}

/** The WebMercatorQuad tile and pixel holding a point, at zoom z. */
export function tilePixel(lng, lat, z, size = TILE_PX) {
  const n = 2 ** z;
  const xf = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return {
    x,
    y,
    px: Math.min(size - 1, Math.floor((xf - x) * size)),
    py: Math.min(size - 1, Math.floor((yf - y) * size)),
  };
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

/** One code step, for choosing how many decimals a readout shows. */
export const step = (encoding) =>
  encoding.redFactor + encoding.greenFactor + encoding.blueFactor;

/**
 * @param {object} layer  a store record with url, maxZoom and encoding
 * @returns {Promise<number|null|undefined>}  undefined outside the archive
 */
export async function valueAt(layer, lng, lat) {
  const z = layer.maxZoom;
  const { x, y, px, py } = tilePixel(lng, lat, z);
  const tile = await tilePixels(layer.url, z, x, y);
  if (tile === null) return undefined;
  const scale = tile.size / TILE_PX;
  const at = (Math.floor(py * scale) * tile.size + Math.floor(px * scale)) * 4;
  // A lossy archive marks nodata with alpha 0; a lossless one with code 0.
  if (tile.data[at + 3] === 0) return null;
  return decodePixel(layer.encoding, tile.data[at], tile.data[at + 1], tile.data[at + 2]);
}
