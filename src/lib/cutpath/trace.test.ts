import { describe, expect, it } from "vitest";
import { boundsOf, countNodes, orient, ringArea, scalePolys, signedArea2, traceMask } from "./trace";
import { chaikin, rdp, simplifyToBudget, smoothRing } from "./simplify";
import { newMask } from "./types";
import type { Mask, Ring } from "./types";

const rect = (w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask => {
  const m = newMask(w, h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.data[y * w + x] = 1;
  return m;
};

const discMask = (w: number, h: number, cx: number, cy: number, r: number): Mask => {
  const m = newMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (Math.hypot(x - cx, y - cy) <= r) m.data[y * w + x] = 1;
  }
  return m;
};

describe("P3 — trace", () => {
  it("traces a rectangle at the pixel boundary, not the pixel centres", () => {
    const polys = traceMask(rect(12, 12, 2, 3, 7, 8));
    expect(polys).toHaveLength(1);
    const b = boundsOf(polys);
    // Filled cells 2..7 span the boundary 2..8.
    expect(b.x).toBeCloseTo(2, 6);
    expect(b.y).toBeCloseTo(3, 6);
    expect(b.w).toBeCloseTo(6, 6);
    expect(b.h).toBeCloseTo(6, 6);
  });

  it("gives six stickers six separate paths in one pass", () => {
    const m = newMask(120, 40);
    for (let i = 0; i < 6; i++) {
      const cx = 10 + i * 20;
      for (let y = 12; y < 28; y++) {
        for (let x = cx - 6; x <= cx + 6; x++) m.data[y * 120 + x] = 1;
      }
    }
    expect(traceMask(m)).toHaveLength(6);
  });

  it("returns a hole as a hole, not as a second shape", () => {
    const m = discMask(61, 61, 30, 30, 22);
    for (let y = 0; y < 61; y++) {
      for (let x = 0; x < 61; x++) if (Math.hypot(x - 30, y - 30) <= 8) m.data[y * 61 + x] = 0;
    }
    const polys = traceMask(m);
    expect(polys).toHaveLength(1);
    expect(polys[0].holes).toHaveLength(1);
  });

  it("orients outers clockwise and holes counter-clockwise", () => {
    const m = discMask(61, 61, 30, 30, 22);
    for (let y = 0; y < 61; y++) {
      for (let x = 0; x < 61; x++) if (Math.hypot(x - 30, y - 30) <= 8) m.data[y * 61 + x] = 0;
    }
    const [p] = traceMask(m);
    expect(signedArea2(p.outer)).toBeGreaterThan(0);
    expect(signedArea2(p.holes[0])).toBeLessThan(0);
  });

  it("orients on demand without changing the shape", () => {
    const ring: Ring = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    expect(ringArea(orient(ring, true))).toBeCloseTo(12, 9);
    expect(ringArea(orient(ring, false))).toBeCloseTo(12, 9);
    expect(signedArea2(orient(ring, true))).toBeGreaterThan(0);
    expect(signedArea2(orient(ring, false))).toBeLessThan(0);
  });

  it("sorts biggest first, so the readout is stable", () => {
    const m = newMask(80, 30);
    for (let y = 4; y < 10; y++) for (let x = 4; x <= 9; x++) m.data[y * 80 + x] = 1;
    for (let y = 4; y < 26; y++) for (let x = 40; x <= 70; x++) m.data[y * 80 + x] = 1;
    const polys = traceMask(m);
    expect(ringArea(polys[0].outer)).toBeGreaterThan(ringArea(polys[1].outer));
  });

  it("returns nothing for an empty mask rather than throwing", () => {
    expect(traceMask(newMask(10, 10))).toEqual([]);
    expect(boundsOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("scales pixels to millimetres uniformly", () => {
    const polys = traceMask(rect(12, 12, 2, 2, 7, 7));
    const b = boundsOf(scalePolys(polys, 0.5));
    expect(b.w).toBeCloseTo(3, 6);
    expect(b.h).toBeCloseTo(3, 6);
  });
});

describe("P4 — simplify and smooth", () => {
  it("collapses a pixel staircase to its real corners", () => {
    const polys = traceMask(rect(40, 40, 5, 5, 34, 34));
    const before = countNodes(polys);
    const after = countNodes([
      { outer: rdp(polys[0].outer, 0.5), holes: [] },
    ]);
    expect(before).toBeGreaterThan(50);
    // A rectangle is four corners, give or take the bevelled marching-squares
    // ones at each corner.
    expect(after).toBeLessThanOrEqual(12);
  });

  it("keeps the shape while removing the nodes", () => {
    const polys = traceMask(discMask(101, 101, 50, 50, 40));
    const before = ringArea(polys[0].outer);
    const after = ringArea(smoothRing(polys[0].outer, 0.15));
    expect(Math.abs(after - before) / before).toBeLessThan(0.01);
  });

  it("Chaikin rounds corners and stays inside the original", () => {
    const square: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const cut = chaikin(square);
    expect(cut).toHaveLength(8);
    // The sharp corner is gone: no point sits on (0,0) any more.
    expect(cut.some((p) => p.x === 0 && p.y === 0)).toBe(false);
    for (const p of cut) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
    }
    expect(ringArea(cut)).toBeLessThan(ringArea(square));
  });

  it("leaves a ring alone when there is nothing to remove", () => {
    const tri: Ring = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 5 },
    ];
    expect(rdp(tri, 0.1)).toHaveLength(3);
  });

  it("gets a real trace comfortably under the node budget", () => {
    const polys = traceMask(discMask(401, 401, 200, 200, 180));
    expect(countNodes(polys)).toBeGreaterThan(1000);
    const r = simplifyToBudget(scalePolys(polys, 0.12));
    expect(r.nodes).toBeLessThanOrEqual(400);
    expect(r.warnings).toEqual([]);
    expect(r.tolerance).toBeCloseTo(0.15, 9);
  });

  it("raises the tolerance rather than shipping a path the plotter chews on", () => {
    // A deliberately spiky outline — the fur-and-foliage case.
    const m = newMask(301, 301);
    for (let y = 0; y < 301; y++) {
      for (let x = 0; x < 301; x++) {
        const a = Math.atan2(y - 150, x - 150);
        const r = 110 + 22 * Math.sin(a * 40);
        if (Math.hypot(x - 150, y - 150) <= r) m.data[y * 301 + x] = 1;
      }
    }
    const polys = scalePolys(traceMask(m), 0.16);
    const r = simplifyToBudget(polys);
    expect(r.nodes).toBeLessThanOrEqual(400);
    expect(r.tolerance).toBeGreaterThan(0.15);
    expect(r.warnings.join(" ")).toMatch(/coarsened to/);
  });

  it("scales the budget with the number of stickers", () => {
    const m = newMask(240, 60);
    for (let i = 0; i < 6; i++) {
      const cx = 20 + i * 40;
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 240; x++) {
          if (Math.hypot(x - cx, y - 30) <= 16) m.data[y * 240 + x] = 1;
        }
      }
    }
    const polys = scalePolys(traceMask(m), 0.2);
    expect(polys).toHaveLength(6);
    const r = simplifyToBudget(polys);
    // Six stickers get six budgets, not one shared between them.
    expect(r.nodes).toBeLessThanOrEqual(6 * 400);
    expect(r.warnings).toEqual([]);
  });
});
