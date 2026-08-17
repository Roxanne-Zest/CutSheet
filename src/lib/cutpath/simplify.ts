import simplifyJs from "simplify-js";
import type { Poly, Ring } from "./types";
import { NODE_BUDGET } from "./types";
import { countNodes } from "./trace";

/**
 * P4 — simplify and smooth.
 *
 * A raw traced polygon is a pixel staircase with tens of thousands of nodes.
 * Ramer-Douglas-Peucker knocks that down to the shape's actual corners, and two
 * rounds of Chaikin round off what RDP leaves behind.
 *
 * Chaikin rather than Bezier fitting: it is twenty lines, it cannot fail, and
 * after RDP the result is indistinguishable at cut resolution. Fitting cubics
 * is a thing to do when a real file proves it is needed, not before.
 */

export const RDP_TOLERANCE_MM = 0.15;
export const CHAIKIN_ROUNDS = 2;

/** Ramer-Douglas-Peucker on a closed ring. */
export const rdp = (ring: Ring, tolerance: number): Ring => {
  if (ring.length < 4) return ring;
  // simplify-js works on open polylines, so close the ring, simplify, and drop
  // the duplicate — otherwise the start point is never a candidate for removal
  // and every shape keeps one arbitrary staircase corner.
  const closed = [...ring, ring[0]];
  const out = simplifyJs(closed, tolerance, true);
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) {
    out.pop();
  }
  return out.length >= 3 ? out : ring;
};

/**
 * One round of Chaikin corner cutting on a closed ring. Each edge contributes
 * points at 1/4 and 3/4, so the ring shrinks slightly towards its centre —
 * which is why the border offset is applied after this, not before.
 */
export const chaikin = (ring: Ring): Ring => {
  if (ring.length < 3) return ring;
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  return out;
};

export const smoothRing = (ring: Ring, tolerance: number, rounds = CHAIKIN_ROUNDS): Ring => {
  let out = rdp(ring, tolerance);
  for (let i = 0; i < rounds; i++) out = chaikin(out);
  // Chaikin doubles the node count each round, so tidy up the collinear runs it
  // creates on straight edges. A tenth of the tolerance is invisible.
  return rdp(out, tolerance * 0.1);
};

export const simplifyPolys = (polys: Poly[], tolerance: number, rounds = CHAIKIN_ROUNDS): Poly[] =>
  polys.map((p) => ({
    outer: smoothRing(p.outer, tolerance, rounds),
    holes: p.holes.map((h) => smoothRing(h, tolerance, rounds)),
  }));

export type SimplifyReport = {
  polys: Poly[];
  tolerance: number;
  nodes: number;
  warnings: string[];
};

/**
 * Simplify to fit the node budget, raising the tolerance until it does.
 *
 * Fur, foliage and hand-lettering blow past 400 nodes at any sensible
 * tolerance. Shipping a path the plotter chews on is not an option, and neither
 * is doing it silently — so the tolerance that was actually used is reported.
 */
export const simplifyToBudget = (
  polys: Poly[],
  o: { tolerance?: number; budgetPerSticker?: number; rounds?: number } = {},
): SimplifyReport => {
  const budgetPerSticker = o.budgetPerSticker ?? NODE_BUDGET;
  const rounds = o.rounds ?? CHAIKIN_ROUNDS;
  const budget = Math.max(1, polys.length) * budgetPerSticker;

  let tolerance = o.tolerance ?? RDP_TOLERANCE_MM;
  let out = simplifyPolys(polys, tolerance, rounds);
  let nodes = countNodes(out);
  let raised = false;

  // Doubling converges in a handful of steps even on the worst artwork.
  for (let i = 0; i < 12 && nodes > budget; i++) {
    tolerance *= 1.6;
    out = simplifyPolys(polys, tolerance, rounds);
    nodes = countNodes(out);
    raised = true;
  }

  const warnings = raised
    ? [
        `Artwork this detailed does not fit ${budgetPerSticker} nodes a sticker, so the trace was coarsened to ${tolerance.toFixed(2)} mm. Fine detail in the outline will be lost — crop tighter or simplify the artwork if that matters.`,
      ]
    : [];

  return { polys: out, tolerance, nodes, warnings };
};
