import fitCurveLib from "fit-curve";
import type { Poly, Pt, Ring } from "./types";
import { NODE_BUDGET } from "./types";

/**
 * P6b — turn the cut polygon into curves.
 *
 * A plotter does not want four hundred straight lines, it wants forty curves.
 * Simplifying a smooth outline down to a node budget with straight segments is
 * what makes a cut line jagged: every node removed is a corner added. Fitting
 * cubic Beziers spends the same budget on anchors instead, and the line between
 * two anchors stays a curve.
 */

/**
 * The package's own types cover the default export only. The closed-loop fit
 * needs the two helpers beside it, which the module does export.
 */
type B = number[][];
const fitCurve = fitCurveLib as unknown as {
  (points: number[][], maxError: number): B[];
  fitCubic(points: number[][], left: number[], right: number[], error: number): B[];
  createTangent(a: number[], b: number[]): number[];
};

/** One cubic segment. `p0` of each segment is `p1` of the one before it. */
export type Curve = { p0: Pt; c1: Pt; c2: Pt; p1: Pt };
/** A closed loop of segments. */
export type CurveRing = Curve[];
export type CurvePoly = { outer: CurveRing; holes: CurveRing[] };

/** How far the fitted curve may sit from the polygon it was fitted to. */
export const CURVE_TOLERANCE_MM = 0.08;
/** Spacing of the samples the fit sees, so sparse straights still constrain it. */
const SAMPLE_MM = 0.2;
/** A turn sharper than this within one sample either side is kept as a corner. */
const CORNER_DEG = 50;

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Evenly spaced points round a closed ring. */
export const resample = (ring: Ring, step: number): Ring => {
  const n = ring.length;
  let length = 0;
  for (let i = 0; i < n; i++) length += dist(ring[i], ring[(i + 1) % n]);
  const count = Math.max(8, Math.round(length / step));
  const gap = length / count;

  const out: Ring = [];
  let walked = 0;
  let next = 0;
  for (let i = 0; i < n && out.length < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const seg = dist(a, b);
    while (next <= walked + seg && out.length < count) {
      const t = seg > 0 ? (next - walked) / seg : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += gap;
    }
    walked += seg;
  }
  return out;
};

/** Indices where the ring genuinely turns a corner rather than curving. */
const cornersOf = (ring: Ring): number[] => {
  const n = ring.length;
  const k = 2;
  const limit = Math.cos((CORNER_DEG * Math.PI) / 180);
  const sharp: Array<{ i: number; c: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - k + n) % n];
    const b = ring[i];
    const c = ring[(i + k) % n];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    if (cos < limit) sharp.push({ i, c: cos });
  }
  // One corner per run of neighbouring sharp samples: the sharpest.
  const out: number[] = [];
  for (let s = 0; s < sharp.length; ) {
    let e = s;
    let best = s;
    while (e + 1 < sharp.length && sharp[e + 1].i - sharp[e].i <= k) {
      e += 1;
      if (sharp[e].c < sharp[best].c) best = e;
    }
    out.push(sharp[best].i);
    s = e + 1;
  }
  return out;
};

const toCurve = (b: number[][]): Curve => ({
  p0: { x: b[0][0], y: b[0][1] },
  c1: { x: b[1][0], y: b[1][1] },
  c2: { x: b[2][0], y: b[2][1] },
  p1: { x: b[3][0], y: b[3][1] },
});

/** Fit one closed ring. Corners stay corners; everything else stays smooth. */
export const fitRing = (ring: Ring, tolerance_mm: number): CurveRing => {
  if (ring.length < 3) return [];
  const pts = resample(ring, SAMPLE_MM);
  const n = pts.length;
  const err = tolerance_mm * tolerance_mm;
  const xy = (i: number): number[] => [pts[((i % n) + n) % n].x, pts[((i % n) + n) % n].y];
  const corners = cornersOf(pts);

  if (corners.length === 0) {
    // No corners: one loop, with the same tangent on both sides of the seam so
    // the place the path happens to start is not a kink.
    const loop = Array.from({ length: n + 1 }, (_, i) => xy(i));
    const t = fitCurve.createTangent(xy(1), xy(-1));
    return fitCurve.fitCubic(loop, t, [-t[0], -t[1]], err).map(toCurve);
  }

  const out: CurveRing = [];
  for (let c = 0; c < corners.length; c++) {
    const from = corners[c];
    const to = corners[(c + 1) % corners.length];
    const span = ((to - from + n) % n) || n;
    const run = Array.from({ length: span + 1 }, (_, i) => xy(from + i));
    out.push(...fitCurve(run, err).map(toCurve));
  }
  return out;
};

export const countAnchors = (polys: CurvePoly[]): number =>
  polys.reduce((k, p) => k + p.outer.length + p.holes.reduce((j, h) => j + h.length, 0), 0);

export type FitReport = {
  curves: CurvePoly[];
  tolerance: number;
  nodes: number;
  warnings: string[];
};

/**
 * Fit every polygon, loosening the tolerance only if the budget really bites.
 * With curves it almost never does: a detailed sticker lands at 40 to 120
 * anchors, where the same outline in straight lines wanted thousands.
 */
export const fitPolys = (
  polys: Poly[],
  o: { tolerance?: number; budgetPerSticker?: number } = {},
): FitReport => {
  const budget = Math.max(1, polys.length) * (o.budgetPerSticker ?? NODE_BUDGET);
  let tolerance = o.tolerance ?? CURVE_TOLERANCE_MM;
  const fit = (): CurvePoly[] =>
    polys.map((p) => ({
      outer: fitRing(p.outer, tolerance),
      holes: p.holes.map((h) => fitRing(h, tolerance)),
    }));

  let curves = fit();
  let nodes = countAnchors(curves);
  let raised = false;
  for (let i = 0; i < 8 && nodes > budget; i++) {
    tolerance *= 1.5;
    curves = fit();
    nodes = countAnchors(curves);
    raised = true;
  }
  return {
    curves,
    tolerance,
    nodes,
    warnings: raised
      ? [
          `This outline needed more than ${o.budgetPerSticker ?? NODE_BUDGET} curve nodes a sticker, so it was loosened to ${tolerance.toFixed(2)} mm. Raise Blade radius or Smoothing if the cut stutters.`,
        ]
      : [],
  };
};

/** Flatten curves back to a dense polyline, for the preview and the PNG edge. */
export const flattenRing = (ring: CurveRing, step_mm = 0.1): Ring => {
  const out: Ring = [];
  for (const c of ring) {
    const rough = dist(c.p0, c.c1) + dist(c.c1, c.c2) + dist(c.c2, c.p1);
    const steps = Math.max(2, Math.ceil(rough / step_mm));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const d = 3 * u * t * t;
      const e = t * t * t;
      out.push({
        x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p1.x,
        y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p1.y,
      });
    }
  }
  return out;
};

export const flattenPolys = (polys: CurvePoly[]): Poly[] =>
  polys
    .map((p) => ({ outer: flattenRing(p.outer), holes: p.holes.map((h) => flattenRing(h)) }))
    .filter((p) => p.outer.length >= 3);

const f = (v: number): string => String(Math.round(v * 1000) / 1000);

/** One closed loop as SVG path data, `scale` user units to the millimetre. */
export const curveRingPath = (ring: CurveRing, scale = 1, dx = 0, dy = 0): string => {
  if (ring.length === 0) return "";
  const X = (p: Pt) => f((p.x + dx) * scale);
  const Y = (p: Pt) => f((p.y + dy) * scale);
  const parts = [`M ${X(ring[0].p0)} ${Y(ring[0].p0)}`];
  for (const c of ring) {
    parts.push(`C ${X(c.c1)} ${Y(c.c1)} ${X(c.c2)} ${Y(c.c2)} ${X(c.p1)} ${Y(c.p1)}`);
  }
  parts.push("Z");
  return parts.join(" ");
};

export const curvesPath = (polys: CurvePoly[], scale = 1, dx = 0, dy = 0): string =>
  polys
    .flatMap((p) => [p.outer, ...p.holes].map((r) => curveRingPath(r, scale, dx, dy)))
    .filter(Boolean)
    .join(" ");
