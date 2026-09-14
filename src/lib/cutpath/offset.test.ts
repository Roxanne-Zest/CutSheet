import { describe, expect, it } from "vitest";
import {
  buildBorder,
  distanceToPolys,
  distanceToRing,
  dropHoles,
  makeCuttable,
  offsetPolys,
  pointInRing,
  vectorClose,
  vectorOpen,
} from "./offset";
import { boundsOf, ringArea, signedArea2, traceMask, scalePolys } from "./trace";
import { simplifyPolys } from "./simplify";
import { newMask } from "./types";
import type { Mask, Poly, Ring } from "./types";

const square = (x: number, y: number, w: number, h: number): Poly => ({
  outer: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
  holes: [],
});

const discMask = (w: number, h: number, cx: number, cy: number, r: number): Mask => {
  const m = newMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (Math.hypot(x - cx, y - cy) <= r) m.data[y * w + x] = 1;
  }
  return m;
};

/** Sample points along a ring, for measuring a border all the way round. */
const samples = (ring: Ring, n = 240): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * ring.length;
    const a = ring[Math.floor(t) % ring.length];
    const b = ring[(Math.floor(t) + 1) % ring.length];
    const f = t - Math.floor(t);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
};

describe("P5 — the die-cut border", () => {
  it("grows a square by exactly the border, on every side", () => {
    const out = offsetPolys([square(10, 10, 20, 20)], 2);
    const b = boundsOf(out);
    expect(b.x).toBeCloseTo(8, 2);
    expect(b.y).toBeCloseTo(8, 2);
    expect(b.w).toBeCloseTo(24, 2);
    expect(b.h).toBeCloseTo(24, 2);
  });

  it("is uniform all the way round a real traced outline — the P5 acceptance test", () => {
    // A wobbly blob, traced and simplified the way the pipeline does it.
    const m = newMask(301, 301);
    for (let y = 0; y < 301; y++) {
      for (let x = 0; x < 301; x++) {
        const a = Math.atan2(y - 150, x - 150);
        const r = 100 + 14 * Math.sin(a * 5) + 7 * Math.cos(a * 9);
        if (Math.hypot(x - 150, y - 150) <= r) m.data[y * 301 + x] = 1;
      }
    }
    const artwork = simplifyPolys(scalePolys(traceMask(m), 0.2), 0.15);
    const border = offsetPolys(artwork, 2);

    // Every point on the artwork edge must be 2 mm from the border, everywhere.
    const distances = samples(artwork[0].outer).map((p) => distanceToPolys(p, border));
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    expect(min).toBeGreaterThan(1.9);
    expect(max).toBeLessThan(2.1);
  });

  it("cuts inside the artwork on a negative border", () => {
    const out = offsetPolys([square(10, 10, 20, 20)], -0.5);
    const b = boundsOf(out);
    expect(b.w).toBeCloseTo(19, 2);
    expect(ringArea(out[0].outer)).toBeLessThan(ringArea(square(10, 10, 20, 20).outer));
  });

  it("rounds the corners rather than mitring them into a spike", () => {
    const out = offsetPolys([square(10, 10, 20, 20)], 2);
    // A mitre would put a node at the corner itself; a round join gives an arc.
    expect(out[0].outer.length).toBeGreaterThan(20);
    const corner = out[0].outer.filter((p) => p.x < 8.01 && p.y < 8.01);
    expect(corner).toHaveLength(0);
  });

  it("keeps outers clockwise and holes counter-clockwise through the offset", () => {
    const donut: Poly = {
      outer: square(0, 0, 40, 40).outer,
      holes: [
        [
          { x: 15, y: 15 },
          { x: 15, y: 25 },
          { x: 25, y: 25 },
          { x: 25, y: 15 },
        ],
      ],
    };
    const out = offsetPolys([donut], 1);
    expect(out).toHaveLength(1);
    expect(signedArea2(out[0].outer)).toBeGreaterThan(0);
    expect(out[0].holes).toHaveLength(1);
    expect(signedArea2(out[0].holes[0])).toBeLessThan(0);
    // Offsetting outward shrinks the hole.
    expect(ringArea(out[0].holes[0])).toBeLessThan(100);
  });

  it("merges two stickers whose borders overlap, rather than crossing the paths", () => {
    const out = offsetPolys([square(0, 0, 10, 10), square(11, 0, 10, 10)], 2);
    expect(out).toHaveLength(1);
  });

  it("leaves two stickers separate when their borders clear each other", () => {
    const out = offsetPolys([square(0, 0, 10, 10), square(30, 0, 10, 10)], 2);
    expect(out).toHaveLength(2);
  });
});

describe("P6 — cuttability", () => {
  it("removes a notch tighter than the blade radius", () => {
    // A square with a 0.4 mm slot cut into it — no blade of 1 mm radius can
    // follow that, so it must not survive to the plotter.
    const notched: Poly = {
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 9.8 },
        { x: 8, y: 10 },
        { x: 20, y: 10.2 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      holes: [],
    };
    const before = distanceToPolys({ x: 12, y: 10 }, [notched]);
    const after = makeCuttable(notched.holes.length ? [notched] : [notched], 1);
    // The slot is gone: the point in the middle of it is now well inside.
    expect(before).toBeLessThan(0.3);
    expect(distanceToPolys({ x: 12, y: 10 }, after)).toBeGreaterThan(0.5);
  });

  it("rounds a sharp convex corner to at least the blade radius", () => {
    const out = makeCuttable([square(0, 0, 20, 20)], 1);

    // A right-angled corner rounded at radius 1 puts the arc centre at (1, 1),
    // so the nearest point of the path to the old vertex is sqrt(2) - 1 away.
    expect(distanceToRing({ x: 0, y: 0 }, out[0].outer)).toBeCloseTo(Math.SQRT2 - 1, 1);

    // The real property is that opening is idempotent: once every feature is
    // at least the blade radius, opening again changes nothing. That is what
    // "the blade can follow this" means, and it does not depend on where the
    // arc happens to put its nodes.
    const again = vectorOpen(out, 1);
    expect(ringArea(again[0].outer) / ringArea(out[0].outer)).toBeCloseTo(1, 2);
  });

  it("leaves a shape the blade can already cut essentially alone", () => {
    const before = [square(0, 0, 40, 40)];
    const after = makeCuttable(offsetPolys(before, 3), 1);
    const b = boundsOf(after);
    // 40 + 2*3 = 46, minus the corner rounding.
    expect(b.w).toBeCloseTo(46, 1);
    expect(b.h).toBeCloseTo(46, 1);
  });

  it("closing fills a tight concavity, opening rounds a tight convexity", () => {
    const spike: Poly = {
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 10.2, y: 20 },
        { x: 10, y: 30 },
        { x: 9.8, y: 20 },
        { x: 0, y: 20 },
      ],
      holes: [],
    };
    // The spike is 0.4 mm wide and 10 mm long — a blade cannot reach up it.
    expect(boundsOf([spike]).h).toBeCloseTo(30, 6);
    expect(boundsOf(vectorOpen([spike], 1)).h).toBeLessThan(22);
    // Closing does not remove it; that is opening's job.
    expect(boundsOf(vectorClose([spike], 1)).h).toBeCloseTo(30, 0);
  });

  it("does nothing at all when the blade radius is zero", () => {
    const before = [square(0, 0, 20, 20)];
    expect(makeCuttable(before, 0)).toBe(before);
  });
});

describe("geometry helpers", () => {
  it("tests point-in-ring by crossings", () => {
    const r = square(0, 0, 10, 10).outer;
    expect(pointInRing({ x: 5, y: 5 }, r)).toBe(true);
    expect(pointInRing({ x: 15, y: 5 }, r)).toBe(false);
    expect(pointInRing({ x: 5, y: -1 }, r)).toBe(false);
  });

  it("measures distance to the nearest edge, not the nearest node", () => {
    const r = square(0, 0, 10, 10).outer;
    // Mid-edge: 3 from the top edge, though the nearest corner is further.
    expect(distanceToRing({ x: 5, y: 3 }, r)).toBeCloseTo(3, 9);
  });

  it("drops holes on request", () => {
    const donut: Poly = { outer: square(0, 0, 20, 20).outer, holes: [square(5, 5, 5, 5).outer] };
    expect(dropHoles([donut])[0].holes).toEqual([]);
  });
});

describe("the border stage as a whole", () => {
  it("produces a cuttable 2 mm border from a real trace", () => {
    const artwork = simplifyPolys(scalePolys(traceMask(discMask(201, 201, 100, 100, 80)), 0.25), 0.15);
    const r = buildBorder(artwork, { border_mm: 2, bladeRadius_mm: 1, keepHoles: false });
    expect(r.warnings).toEqual([]);
    expect(r.polys).toHaveLength(1);
    const distances = samples(artwork[0].outer).map((p) => distanceToPolys(p, r.polys));
    expect(Math.min(...distances)).toBeGreaterThan(1.85);
    expect(Math.max(...distances)).toBeLessThan(2.15);
  });

  it("says so when a negative border eats the sticker entirely", () => {
    const r = buildBorder([square(0, 0, 1, 1)], {
      border_mm: -1,
      bladeRadius_mm: 1,
      keepHoles: false,
    });
    expect(r.polys).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no path to cut/);
  });

  it("leaves a dropped shape for the pipeline to explain", () => {
    // This stage can see that the count fell but not why. A shape too small to
    // survive the border and two shapes welded together by it both land here
    // as one path out of two, and the fixes are opposite. Telling them apart
    // needs the gap between the shapes, so the pipeline says it — see
    // crowdingWarnings in pipeline.test.ts.
    const r = buildBorder([square(0, 0, 30, 30), square(60, 0, 1.2, 1.2)], {
      border_mm: -0.8,
      bladeRadius_mm: 0.5,
      keepHoles: false,
    });
    expect(r.polys).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });
});
