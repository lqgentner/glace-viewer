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
 * worldSize / (2π * cos(lat)); the orbit follows vertical_perspective_transform.ts.
 * Revisit if the viewer changes FOV, globe scaling, or roll.
 */
const FOV = 0.6435011087932844;
const TILE_SIZE = 512;
const LIMB_SAMPLES = 16;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * Return the projected horizon's center and radii in CSS pixels. The camera
 * orbits the center at the camera distance, tilted by pitch away from the
 * bearing, and sees the globe out to the circle around the point beneath it. In
 * Mercator the projected ring extends beyond the viewport.
 */
export function globeDisc(map, width, height) {
  const { lng, lat } = map.getCenter();
  const radius = (TILE_SIZE * 2 ** map.getZoom()) / (2 * Math.PI) / Math.cos(rad(lat));
  const distance = (0.5 * height) / Math.tan(FOV / 2);
  const pitch = rad(map.getPitch());
  const bearing = rad(map.getBearing());

  // Earth-centered unit vectors at the map center.
  const [sinLat, cosLat] = [Math.sin(rad(lat)), Math.cos(rad(lat))];
  const [sinLng, cosLng] = [Math.sin(rad(lng)), Math.cos(rad(lng))];
  const up = [cosLat * cosLng, cosLat * sinLng, sinLat];
  const north = [-sinLat * cosLng, -sinLat * sinLng, cosLat];
  const east = [-sinLng, cosLng, 0];
  // Toward the top of the screen, and to its right.
  const ahead = north.map((n, i) => n * Math.cos(bearing) + east[i] * Math.sin(bearing));
  const right = east.map((e, i) => e * Math.cos(bearing) - north[i] * Math.sin(bearing));
  const camera = up.map(
    (u, i) => u * (radius + distance * Math.cos(pitch)) - ahead[i] * distance * Math.sin(pitch),
  );
  const cameraDistance = Math.hypot(...camera);
  const below = camera.map((c) => c / cameraDistance);
  const horizon = Math.acos(radius / cameraDistance);
  // Tangent beneath the camera; with right, it starts the samples at the outline's extremes.
  const across = cross(below, right);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < LIMB_SAMPLES; i += 1) {
    const angle = (i / LIMB_SAMPLES) * 2 * Math.PI;
    const [x, y, z] = below.map(
      (b, k) =>
        b * Math.cos(horizon) +
        (right[k] * Math.cos(angle) + across[k] * Math.sin(angle)) * Math.sin(horizon),
    );
    const point = map.project([deg(Math.atan2(y, x)), deg(Math.asin(z))]);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  // Tilt only stretches the outline vertically on screen, so it stays axis-aligned.
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, rx, ry, r: Math.max(rx, ry) };
}

function cross([ax, ay, az], [bx, by, bz]) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
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
    element.style.setProperty("--globe-rx", `${disc.rx}px`);
    element.style.setProperty("--globe-ry", `${disc.ry}px`);
  };
  map.on("move", update);
  map.on("resize", update);
  // The style switches to the globe after the first measurement.
  map.on("projectiontransition", update);
  update();
}
