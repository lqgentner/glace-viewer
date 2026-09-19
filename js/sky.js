/*
 * Measure the globe limb for the CSS halo behind MapLibre's transparent canvas.
 * Update custom properties on move; no animation loop.
 *
 * Limb projection is adapted from Leonel Dias, "Globe atmosphere, halo, and comets
 * with pure Canvas 2D and MapLibre" (leoneljdias.github.io). Sample the visible
 * horizon: projecting points 90° from the center puts the ring inside the
 * silhouette.
 */

/*
 * MapLibre camera defaults from src/geo/transform_helper.ts and
 * projection/globe_utils.ts: distance = 0.5 * height / tan(fov / 2), radius =
 * worldSize / (2π * cos(lat)). Revisit if the viewer changes FOV or globe scaling.
 */
const FOV = 0.6435011087932844;
const TILE_SIZE = 512;
const LIMB_SAMPLES = 16;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Return the projected horizon's center and radius in CSS pixels. Exact at zero
 * pitch, approximate when tilted. In Mercator the projected ring extends beyond the
 * viewport.
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

/* Write CSS properties only while the globe leaves part of the viewport uncovered. */
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
