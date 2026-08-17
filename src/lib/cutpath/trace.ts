import { contours } from "d3-contour";
import type { Mask, Poly, Pt, Ring } from "./types";

/**
 * P3 — marching squares over the mask.
 *
 * d3-contour does marching squares properly and already groups rings into
 * polygons with their holes, which is the fiddly half of the job. Each
 * connected component comes back as its own polygon, so a sheet of six stickers
 * gives six paths in one pass.
 *
 * Coordinates come out in pixel space, where cell (i, j) is the unit square
 * from (i, j) to (i+1, j+1) — so the ring is the pixel boundary, not the pixel
 * centres, and no half-pixel correction is needed.
 */

/** Twice the signed area. Positive is clockwise in screen space (y down). */
export const signedArea2 = (ring: Ring): number => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return a;
};

export const ringArea = (ring: Ring): number => Math.abs(signedArea2(ring)) / 2;

/** Force a ring to a known winding, so downstream never has to guess. */
export const orient = (ring: Ring, clockwise: boolean): Ring =>
  signedArea2(ring) >= 0 === clockwise ? ring : [...ring].reverse();

const toRing = (coords: number[][]): Ring => {
  const out: Ring = [];
  // GeoJSON repeats the first point at the end; a ring does not need it.
  const n = coords.length > 1 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1]
    ? coords.length - 1
    : coords.length;
  for (let i = 0; i < n; i++) out.push({ x: coords[i][0], y: coords[i][1] });
  return out;
};

/**
 * Trace every component of the mask. Outer rings come back clockwise and holes
 * counter-clockwise, which is what the offsetter and the SVG even-odd fill both
 * expect.
 */
export const traceMask = (m: Mask): Poly[] => {
  const values = new Float64Array(m.data.length);
  for (let i = 0; i < values.length; i++) values[i] = m.data[i];

  const result = contours().size([m.w, m.h]).thresholds([0.5])(values as unknown as number[]);
  const multi = result[0];
  if (!multi) return [];

  const polys: Poly[] = [];
  for (const rings of multi.coordinates) {
    if (rings.length === 0) continue;
    const outer = orient(toRing(rings[0] as number[][]), true);
    if (outer.length < 3) continue;
    const holes = rings
      .slice(1)
      .map((r) => orient(toRing(r as number[][]), false))
      .filter((r) => r.length >= 3);
    polys.push({ outer, holes });
  }

  // Biggest first: the readout and the node budget both want a stable order.
  return polys.sort((a, b) => ringArea(b.outer) - ringArea(a.outer));
};

export const countNodes = (polys: Poly[]): number =>
  polys.reduce((n, p) => n + p.outer.length + p.holes.reduce((k, h) => k + h.length, 0), 0);

export type Bounds = { x: number; y: number; w: number; h: number };

export const boundsOf = (polys: Poly[]): Bounds => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polys) {
    for (const pt of p.outer) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

/** Scale every point, for the pixels-to-millimetres hop. */
export const scalePolys = (polys: Poly[], k: number): Poly[] => {
  const s = (r: Ring): Ring => r.map((p): Pt => ({ x: p.x * k, y: p.y * k }));
  return polys.map((p) => ({ outer: s(p.outer), holes: p.holes.map(s) }));
};
