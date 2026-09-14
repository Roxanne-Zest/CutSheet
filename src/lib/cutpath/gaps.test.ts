import { describe, expect, it } from "vitest";
import {
  boundsGap,
  classifyLoss,
  clearanceNeeded,
  interiorPoint,
  minGap,
  polyGap,
} from "./gaps";
import { buildBorder } from "./offset";
import type { Poly } from "./types";

const rect = (x: number, y: number, w: number, h: number): Poly => ({
  outer: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
  holes: [],
});

/**
 * A sheet of pens laid out in a column, sized as a fraction of the sheet's own
 * width — which is how the real one behaves when the Width field changes.
 */
const sheet = (width_mm: number, count = 3): Poly[] => {
  const penH = 0.064 * width_mm;
  const gap = 0.019 * width_mm;
  return Array.from({ length: count }, (_, i) =>
    rect(0, i * (penH + gap), width_mm * 0.45, penH),
  );
};

describe("measuring the gap", () => {
  it("finds the shortest distance between two shapes", () => {
    expect(polyGap(rect(0, 0, 10, 10), rect(0, 13, 10, 10))).toBeCloseTo(3, 5);
  });

  it("measures a diagonal separation, not just an axis one", () => {
    // Corner to corner: 3 across and 4 down.
    expect(polyGap(rect(0, 0, 10, 10), rect(13, 14, 10, 10))).toBeCloseTo(5, 5);
  });

  it("reports the closest pair out of many", () => {
    const polys = [rect(0, 0, 10, 10), rect(0, 20, 10, 10), rect(0, 32, 10, 10)];
    const g = minGap(polys);
    expect(g.min_mm).toBeCloseTo(2, 5);
    expect(g.pair).toEqual([1, 2]);
  });

  it("has no gap to report with fewer than two shapes", () => {
    expect(minGap([rect(0, 0, 10, 10)]).min_mm).toBe(Infinity);
    expect(minGap([]).pair).toBeNull();
  });

  it("prunes by bounding box without changing the answer", () => {
    // Twenty shapes in a row, one pair deliberately closer than the rest.
    const polys = Array.from({ length: 20 }, (_, i) => rect(i * 20, 0, 10, 10));
    polys.push(rect(19 * 20 + 10.5, 0, 10, 10));
    expect(minGap(polys).min_mm).toBeCloseTo(0.5, 5);
  });

  it("bounds that overlap have no gap", () => {
    expect(boundsGap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(0);
  });
});

describe("clearance", () => {
  it("is twice the reach, because both sides grow", () => {
    expect(clearanceNeeded(2, 1)).toBe(6);
    expect(clearanceNeeded(0, 1)).toBe(2);
    expect(clearanceNeeded(0, 0)).toBe(0);
  });

  it("ignores a negative border rather than counting it as room gained", () => {
    // A negative border shrinks the shape, but the blade close still reaches
    // outward, so it cannot be subtracted from what the blade needs.
    expect(clearanceNeeded(-1, 1)).toBe(2);
  });

  it("predicts the merge the border stage actually performs", () => {
    for (const width_mm of [48, 100, 150, 210]) {
      const polys = sheet(width_mm);
      const gap = minGap(polys).min_mm;
      const clearance = clearanceNeeded(0, 1);
      const out = buildBorder(polys, { border_mm: 0, bladeRadius_mm: 1, keepHoles: false });
      const merged = out.polys.length < polys.length;
      expect(merged).toBe(gap < clearance);
    }
  });
});

describe("an interior point", () => {
  it("is the centroid for a convex shape", () => {
    const p = interiorPoint(rect(0, 0, 10, 10).outer);
    expect(p.x).toBeCloseTo(5, 5);
    expect(p.y).toBeCloseTo(5, 5);
  });

  it("stays inside a crescent, where the centroid escapes", () => {
    // A C-shape: the centroid falls in the mouth, outside the polygon.
    const c: Poly = {
      outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 3 },
        { x: 3, y: 3 },
        { x: 3, y: 7 },
        { x: 10, y: 7 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [],
    };
    const p = interiorPoint(c.outer);
    // Inside the left spine, not out in the mouth.
    expect(p.x).toBeLessThan(3);
    expect(p.x).toBeGreaterThan(0);
  });
});

describe("telling a merge from a disappearance", () => {
  it("calls two shapes welded into one a merge", () => {
    const before = [rect(0, 0, 30, 10), rect(0, 11, 30, 10)];
    const after = [rect(-1, -1, 32, 24)];
    expect(classifyLoss(before, after)).toEqual({ merged: 2, mergedInto: 1, vanished: 0 });
  });

  it("calls a shape with no path at all a disappearance", () => {
    const before = [rect(0, 0, 30, 10), rect(0, 40, 1, 1)];
    const after = [rect(-1, -1, 32, 12)];
    expect(classifyLoss(before, after)).toEqual({ merged: 0, mergedInto: 0, vanished: 1 });
  });

  it("separates the two when they happen together", () => {
    const before = [rect(0, 0, 30, 10), rect(0, 11, 30, 10), rect(0, 60, 1, 1)];
    const after = [rect(-1, -1, 32, 24)];
    expect(classifyLoss(before, after)).toEqual({ merged: 2, mergedInto: 1, vanished: 1 });
  });

  it("is quiet when every shape kept its own path", () => {
    const before = [rect(0, 0, 30, 10), rect(0, 40, 30, 10)];
    const after = [rect(-1, -1, 32, 12), rect(-1, 39, 32, 12)];
    expect(classifyLoss(before, after)).toEqual({ merged: 0, mergedInto: 0, vanished: 0 });
  });

  it("counts two separate welds as two", () => {
    const before = [
      rect(0, 0, 30, 10),
      rect(0, 11, 30, 10),
      rect(0, 60, 30, 10),
      rect(0, 71, 30, 10),
    ];
    const after = [rect(-1, -1, 32, 24), rect(-1, 59, 32, 24)];
    expect(classifyLoss(before, after)).toEqual({ merged: 4, mergedInto: 2, vanished: 0 });
  });
});
