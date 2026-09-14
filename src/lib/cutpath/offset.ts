import ClipperLib from "clipper-lib";
import type { Poly, Pt, Ring } from "./types";
import { ringArea, signedArea2 } from "./trace";

/**
 * P5 and P6 — the die-cut border, and making it something a blade can follow.
 *
 * P5 is the offset: a real mathematical border, uniform all the way round,
 * which is the thing the painted-on one never was.
 *
 * P6 is the part that separates a path that looks right on screen from one that
 * cuts right. A blade has a physical radius; it cannot turn inside that radius,
 * so anywhere the path asks it to, it tears the vinyl instead. Removing those
 * features before they reach the plotter is not a refinement, it is the
 * difference between a clean cut and a ruined sheet.
 */

/** Clipper works in integers. Micrometres give plenty of headroom in mm space. */
const SCALE = 1000;
/**
 * How far a round join may deviate from a true arc, in clipper units — so
 * 10 units is 0.01 mm.
 *
 * This is a node-count dial as much as an accuracy one: every halving of the
 * tolerance roughly doubles the points clipper emits per corner. At 0.01 mm the
 * arc is finer than any plotter can position to, and a 2 mm border on a sticker
 * costs tens of nodes rather than hundreds.
 */
const ARC_TOLERANCE = 0.01 * SCALE;
const MITER_LIMIT = 2;

type ClipperPoint = { X: number; Y: number };

const toClipper = (ring: Ring): ClipperPoint[] =>
  ring.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));

const fromClipper = (path: ClipperPoint[]): Ring =>
  path.map((p): Pt => ({ x: p.X / SCALE, y: p.Y / SCALE }));

/**
 * Group flat clipper paths back into outers with their holes.
 *
 * Clipper's own PolyTree would do this, but the offsetter returns flat paths;
 * winding tells us which is which, and containment tells us whose.
 */
const regroup = (paths: ClipperPoint[][]): Poly[] => {
  const rings = paths.map(fromClipper).filter((r) => r.length >= 3);
  const outers: Poly[] = [];
  const holes: Ring[] = [];

  for (const r of rings) {
    // Judged by our own signed area rather than Clipper's Orientation, so the
    // grouping does not depend on which way round Clipper thinks y points.
    // Clockwise in screen space is an outer boundary; counter-clockwise is a hole.
    if (signedArea2(r) > 0) outers.push({ outer: r, holes: [] });
    else holes.push(r);
  }

  outers.sort((a, b) => ringArea(b.outer) - ringArea(a.outer));

  for (const h of holes) {
    // Smallest containing outer wins, so a hole inside a hole-in-a-shape lands
    // on the right parent.
    const parent = [...outers]
      .reverse()
      .find((p) => pointInRing(h[0], p.outer));
    if (parent) parent.holes.push(h);
  }

  return outers;
};

/** Even-odd crossing test. */
export const pointInRing = (p: Pt, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * Offset every polygon by `delta` millimetres with round joins.
 *
 * Round joins are not a style choice: a mitred corner on a die-cut border is a
 * spike the blade has to reverse into, and it is the first thing to tear.
 */
export const offsetPolys = (polys: Poly[], delta_mm: number): Poly[] => {
  if (polys.length === 0) return [];

  const co = new ClipperLib.ClipperOffset(MITER_LIMIT, ARC_TOLERANCE);
  for (const p of polys) {
    co.AddPath(toClipper(p.outer), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    for (const h of p.holes) {
      co.AddPath(toClipper(h), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    }
  }

  const out: ClipperPoint[][] = [];
  co.Execute(out, delta_mm * SCALE);
  return regroup(out);
};

/**
 * Vector closing: grow by r, shrink by r.
 *
 * Removes every concavity the blade cannot turn into, and leaves everything
 * else where it was.
 */
export const vectorClose = (polys: Poly[], r_mm: number): Poly[] =>
  r_mm <= 0 ? polys : offsetPolys(offsetPolys(polys, r_mm), -r_mm);

/**
 * Vector opening: shrink by r, grow by r.
 *
 * The other half of the pair — it rounds off convex corners to the same minimum
 * radius, and removes any spike too thin for the blade to reach into.
 */
export const vectorOpen = (polys: Poly[], r_mm: number): Poly[] =>
  r_mm <= 0 ? polys : offsetPolys(offsetPolys(polys, -r_mm), r_mm);

/**
 * P6 — make it cuttable.
 *
 * Closing then opening leaves a path with no feature, inward or outward,
 * tighter than the blade radius. After this, every corner on the path is either
 * straight or curved at r or gentler.
 */
export const makeCuttable = (polys: Poly[], bladeRadius_mm: number): Poly[] => {
  if (bladeRadius_mm <= 0) return polys;
  return vectorOpen(vectorClose(polys, bladeRadius_mm), bladeRadius_mm);
};

/** Drop holes, for when the donut is cut on its outline. */
export const dropHoles = (polys: Poly[]): Poly[] =>
  polys.map((p) => ({ outer: p.outer, holes: [] }));

/** Distance from a point to the nearest edge of a ring. */
export const distanceToRing = (p: Pt, ring: Ring): number => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
};

/** Distance from a point to the nearest edge of any polygon in the set. */
export const distanceToPolys = (p: Pt, polys: Poly[]): number => {
  let best = Infinity;
  for (const poly of polys) {
    best = Math.min(best, distanceToRing(p, poly.outer));
    for (const h of poly.holes) best = Math.min(best, distanceToRing(p, h));
  }
  return best;
};

export type OffsetReport = {
  polys: Poly[];
  warnings: string[];
};

/**
 * The whole border stage: offset, then make it cuttable.
 *
 * A negative border can eat a small sticker entirely, which is worth saying
 * rather than quietly returning nothing.
 */
export const buildBorder = (
  polys: Poly[],
  o: { border_mm: number; bladeRadius_mm: number; keepHoles: boolean },
): OffsetReport => {
  const source = o.keepHoles ? polys : dropHoles(polys);
  const offset = o.border_mm === 0 ? source : offsetPolys(source, o.border_mm);
  const cuttable = makeCuttable(offset, o.bladeRadius_mm);

  const warnings: string[] = [];
  if (polys.length > 0 && cuttable.length === 0) {
    warnings.push(
      "Nothing survived the border. A negative border larger than the artwork leaves no path to cut.",
    );
  }
  // A count that drops without reaching zero is not reported here. It has two
  // opposite causes — shapes too small to survive, and shapes so close they
  // welded together — and telling them apart needs the gap between the shapes,
  // which the pipeline measures. Guessing here is what made this stage claim
  // a sheet of thirty pens had "disappeared" when it had merged into two.

  return { polys: cuttable, warnings };
};
