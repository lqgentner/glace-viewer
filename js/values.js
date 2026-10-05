/*
 * Decode value-encoded archive tiles for false-color composites
 * (js/composite.js). Tiles come through the shared readers of js/archive.js; a
 * pixel is decoded with the style's custom encoding.
 */

import { archive } from "./archive.js";

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
 * The decoded RGBA of one archive tile. Bytes come from the shared reader's
 * cache; a failed read rejects.
 *
 * @returns {Promise<{size: number, data: Uint8ClampedArray}|null>}  null where
 *   the archive has no tile
 */
export async function tilePixels(url, z, x, y) {
  const response = await archive(url).getZxy(z, x, y);
  return response?.data ? decodeTile(response.data) : null;
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

