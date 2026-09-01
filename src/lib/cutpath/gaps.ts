import type { Poly, Pt, Ring } from "./types";
import { distanceToRing, pointInRing } from "./offset";
import { boundsOf } from "./trace";
import type { Bounds } from "./trace";

/**
 * How close the shapes are, and what happened to them.
 *
 * The border stage grows every shape and then closes it at the blade radius,
 * and both of those reach sideways. Where two shapes are closer than the total
 * reach they stop being two shapes — clipper unions them and the sticker count
 * silently collapses. A sheet of thirty pens leaves as two blobs.
 *
 * That failure used to be reported as `N shapes disappeared: too small to
 * survive the border`, which is the wrong cause and sends you to shrink
 * artwork that was never too small. This module exists to tell the truth
 * instead: how far apart the shapes actually are, and whether the ones that
 * left the count vanished or merged.
 */

/** Clearance a shape needs on each side before it touches its neighbour. */
export const reachOf = (border_mm: number, bladeRadius_mm: number): number =>
  Math.max(0, border_mm) + Math.max(0, bladeRadius_mm);

/**
 * The gap two shapes need between them to stay separate.
 *
 * Both sides grow, so the clearance needed is twice one shape's reach.
 */
export const clearanceNeeded = (border_mm: number, bladeRadius_mm: number): number =>
  2 * reachOf(border_mm, bladeRadius_mm);

/** Shortest distance between two axis-aligned boxes. 0 if they overlap. */
export const boundsGap = (a: Bounds, b: Bounds): number => {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
};

/**
 * Vertices, thinned so a dense ring costs the same as a sparse one.
 *
 * The gap only has to be accurate enough to explain a merge, and a simplified
 * ring's vertices are already close together relative to any gap worth
 * reporting.
 */
const sample = (ring: Ring, max: number): Pt[] => {
  if (ring.length <= max) return ring;
  const stride = Math.ceil(ring.length / max);
  const out: Pt[] = [];
  for (let i = 0; i < ring.length; i += stride) out.push(ring[i]);
  return out;
};

const SAMPLE_PER_RING = 240;

/** Shortest distance between two outer boundaries. */
export const polyGap = (a: Poly, b: Poly): number => {
  let best = Infinity;
  for (const p of sample(a.outer, SAMPLE_PER_RING)) {
    best = Math.min(best, distanceToRing(p, b.outer));
  }
  // Both directions: the closest approach may sit on a long edge of one shape
  // with no vertex of the other anywhere near it.
  for (const p of sample(b.outer, SAMPLE_PER_RING)) {
    best = Math.min(best, distanceToRing(p, a.outer));
  }
  return best;
};

export type GapReport = {
  /** Shortest distance between any two shapes, in mm. Infinity if under two. */
  min_mm: number;
  /** The pair that is closest, by index. */
  pair: [number, number] | null;
};

/**
 * The closest two shapes on the sheet.
 *
 * Bounding boxes prune the pairs first — on a sheet laid out in columns almost
 * every pair is far apart, and a box test is a handful of arithmetic against a
 * ring walk of hundreds of segments.
 */
export const minGap = (polys: Poly[]): GapReport => {
  if (polys.length < 2) return { min_mm: Infinity, pair: null };

  const boxes = polys.map((p) => boundsOf([p]));
  let min_mm = Infinity;
  let pair: [number, number] | null = null;

  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      // The box gap is a lower bound on the real gap, so a box further away
      // than the best pair so far cannot beat it.
      if (boundsGap(boxes[i], boxes[j]) >= min_mm) continue;
      const d = polyGap(polys[i], polys[j]);
      if (d < min_mm) {
        min_mm = d;
        pair = [i, j];
      }
    }
  }

  return { min_mm, pair };
};

/** Average of a ring's vertices. Inside the shape for anything convex. */
const centroid = (ring: Ring): Pt => {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
};

/**
 * A point that really is inside the ring.
 *
 * The centroid escapes a crescent, so when it does, cast a ray across the
 * shape and take the middle of its widest crossing — that lands inside however
 * concave the outline is.
 */
export const interiorPoint = (ring: Ring): Pt => {
  const c = centroid(ring);
  if (pointInRing(c, ring)) return c;

  const b = boundsOf([{ outer: ring, holes: [] }]);
  for (const f of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const y = b.y + b.h * f;
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const d = ring[i];
      if (a.y > y !== d.y > y) xs.push(a.x + ((y - a.y) / (d.y - a.y)) * (d.x - a.x));
    }
    xs.sort((p, q) => p - q);
    let best: Pt | null = null;
    let widest = 0;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const width = xs[k + 1] - xs[k];
      if (width > widest) {
        widest = width;
        best = { x: (xs[k] + xs[k + 1]) / 2, y };
      }
    }
    if (best) return best;
  }
  return c;
};

export type LossReport = {
  /** Shapes that ended up sharing an output path with at least one other. */
  merged: number;
  /** How many paths those merged shapes collapsed into. */
  mergedInto: number;
  /** Shapes that left no path at all. */
  vanished: number;
};

/**
 * What became of each shape between the trace and the finished path.
 *
 * Counting is not enough — thirty in and two out is either twenty-eight
 * vanishings or one big weld, and the fix is opposite in each case. So each
 * input is placed by an interior point: land inside an output and you merged
 * with whoever else landed there, land in none and you really did vanish.
 */
export const classifyLoss = (before: Poly[], after: Poly[]): LossReport => {
  if (before.length === 0) return { merged: 0, mergedInto: 0, vanished: 0 };

  // How many inputs landed in each output.
  const landed = new Array<number>(after.length).fill(0);
  let vanished = 0;

  for (const p of before) {
    const q = interiorPoint(p.outer);
    const hit = after.findIndex((a) => pointInRing(q, a.outer));
    if (hit === -1) vanished++;
    else landed[hit]++;
  }

  let merged = 0;
  let mergedInto = 0;
  for (const n of landed) {
    if (n > 1) {
      merged += n;
      mergedInto++;
    }
  }

  return { merged, mergedInto, vanished };
};
