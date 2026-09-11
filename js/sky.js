/*
 * The sky behind the globe: deep space and a halo at the limb. Both are
 * painted by the stylesheet, as the #map element's background — MapLibre
 * clears its canvas to transparent and draws the basemap's background layer
 * on the globe alone, so the element's own background shows around the disc
 * for free. This module only measures where the disc is and hands the numbers
 * over as custom properties on `move`. No canvas, no animation loop: the sky
 * changes only when the camera does.
 *
 * Finding the disc by projecting points around the limb, so the halo stays on
 * it under pitch, is from Leonel Dias, "Globe atmosphere, halo, and comets
 * with pure Canvas 2D and MapLibre" (leoneljdias.github.io); the drawing is
 * not. This page samples at the visible horizon rather than 90° from the
 * centre: `project()` puts a
 * point behind the horizon through the same perspective matrix, and at z2 the
 * great circle lands 3 % inside the silhouette, at z3 8 %, pulling the halo's
 * brightest part behind the globe. The article's starfield and comets were
 * tried and dropped: decoration, and a flat sky does not turn the way a real
 * one does behind an orbiting camera.
 */

/* MapLibre's default vertical field of view, in radians, which the page never
 * changes. A constant rather than the map's getter so the test's fake needs no
 * camera. The camera sits `0.5 * height / tan(fov / 2)`
 * in front of the surface, and the globe's radius is scaled so a pixel at the
 * centre is one mercator pixel: `worldSize / 2π / cos(lat)`, with a 512 px
 * tile. Both from maplibre-gl-js src/geo — transform_helper.ts and
 * projection/globe_utils.ts. */
const FOV = 0.6435011087932844;
const TILE_SIZE = 512;
const LIMB_SAMPLES = 16;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * The globe's silhouette on screen: centre and radius in CSS pixels.
 *
 * Sixteen points at the horizon's angular distance from the centre, projected
 * and boxed. Exact at pitch 0; under pitch the ring is no longer the true
 * silhouette, but its box still follows the disc as it leaves the centre.
 * Under mercator (z12 and up, or the blend below it) the points project far
 * off screen, which reads as a disc covering the viewport — the right answer.
 */
export function globeDisc(map, width, height) {
  const { lng, lat } = map.getCenter();
  const radius = (TILE_SIZE * 2 ** map.getZoom()) / (2 * Math.PI) / Math.cos(rad(lat));
  const camera = (0.5 * height) / Math.tan(FOV / 2);
  const horizon = Math.acos(radius / (radius + camera));

  const clat = rad(lat);
  const clng = rad(lng);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < LIMB_SAMPLES; i += 1) {
    const bearing = (i / LIMB_SAMPLES) * 2 * Math.PI;
    const plat = Math.asin(
      Math.sin(clat) * Math.cos(horizon) + Math.cos(clat) * Math.sin(horizon) * Math.cos(bearing),
    );
    const plng =
      clng +
      Math.atan2(
        Math.sin(bearing) * Math.sin(horizon) * Math.cos(clat),
        Math.cos(horizon) - Math.sin(clat) * Math.sin(plat),
      );
    const point = map.project([deg(plng), deg(plat)]);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    r: Math.max(maxX - minX, maxY - minY) / 2,
  };
}

/**
 * Keep `element`'s custom properties in step with the camera. The `sky` class
 * is on only while some of the viewport lies outside the disc, so a reader on
 * a glacier pays nothing per pan: the properties are not even written.
 */
export function installSky(map, element) {
  const update = () => {
    const width = element.clientWidth;
    const height = element.clientHeight;
    const disc = globeDisc(map, width, height);
    const farthestCorner = Math.hypot(
      Math.max(disc.x, width - disc.x),
      Math.max(disc.y, height - disc.y),
    );
    const visible = farthestCorner > disc.r;
    element.classList.toggle("sky", visible);
    if (!visible) return;

    element.style.setProperty("--globe-x", `${disc.x}px`);
    element.style.setProperty("--globe-y", `${disc.y}px`);
    element.style.setProperty("--globe-r", `${disc.r}px`);
  };
  map.on("move", update);
  map.on("resize", update);
  update();
}
