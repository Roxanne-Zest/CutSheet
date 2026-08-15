import { describe, it, expect } from "vitest";
import {
  MAX_ZOOM,
  addQuarter,
  coverCrop,
  cropCornersPx,
  fillCrop,
  normalizeCrop,
  orientedSize,
  panBy,
  remapCropQuarter,
  setZoom,
  zoomBy,
  zoomOf,
} from "./geometry";
import type { CropContext } from "./geometry";

const ctx = (
  iw: number,
  ih: number,
  aspect: number,
  straighten_deg = 0,
): CropContext => ({ iw, ih, aspect, straighten_deg });

/** The invariant that matters: crop maps onto the slot's physical aspect exactly. */
const aspectOf = (c: { w: number; h: number }, k: CropContext) =>
  (c.w * k.iw) / (c.h * k.ih);

const insideImage = (c: { x: number; y: number; w: number; h: number }, k: CropContext) => {
  const corners = cropCornersPx(c, k);
  const tol = 1e-6;
  return corners.every(
    (p) => p.x >= -tol && p.y >= -tol && p.x <= k.iw + tol && p.y <= k.ih + tol,
  );
};

const CASES: Array<[number, number, string]> = [
  [4000, 3000, "landscape 4:3"],
  [3000, 4000, "portrait 3:4"],
  [4000, 4000, "square"],
  [6000, 1500, "panorama"],
  [1200, 5000, "tall crop"],
];

const ASPECTS = [54 / 72, 72 / 54, 1, 90 / 125, 152 / 216, 200 / 30];

describe("crop-to-fill", () => {
  it("fills any aspect ratio onto any slot", () => {
    for (const [iw, ih, name] of CASES) {
      for (const a of ASPECTS) {
        const k = ctx(iw, ih, a);
        const c = fillCrop(k);
        expect(aspectOf(c, k), `${name} @ ${a}`).toBeCloseTo(a, 9);
        expect(insideImage(c, k), `${name} @ ${a}`).toBe(true);
      }
    }
  });

  it("cover crop touches at least one image edge", () => {
    for (const [iw, ih] of CASES) {
      for (const a of ASPECTS) {
        const k = ctx(iw, ih, a);
        const c = coverCrop(k);
        const touches = Math.abs(c.w - 1) < 1e-9 || Math.abs(c.h - 1) < 1e-9;
        expect(touches).toBe(true);
      }
    }
  });

  it("starts centred", () => {
    const k = ctx(4000, 3000, 1);
    const c = fillCrop(k);
    expect(c.x + c.w / 2).toBeCloseTo(0.5, 9);
    expect(c.y + c.h / 2).toBeCloseTo(0.5, 9);
  });
});

describe("zoom", () => {
  it("round-trips through zoomOf/setZoom", () => {
    const k = ctx(4000, 3000, 54 / 72);
    for (const z of [1, 1.5, 2, 3.75, 8]) {
      const c = setZoom(fillCrop(k), k, z);
      expect(zoomOf(c, k)).toBeCloseTo(z, 9);
      expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
      expect(insideImage(c, k)).toBe(true);
    }
  });

  it("cannot zoom out past cover", () => {
    const k = ctx(4000, 3000, 1);
    const c = zoomBy(fillCrop(k), k, 0.1);
    expect(zoomOf(c, k)).toBeCloseTo(1, 9);
    expect(insideImage(c, k)).toBe(true);
  });

  it("clamps at max zoom", () => {
    const k = ctx(4000, 3000, 1);
    const c = setZoom(fillCrop(k), k, 999);
    expect(zoomOf(c, k)).toBeCloseTo(MAX_ZOOM, 9);
  });

  it("holds aspect and bounds across a long random walk", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const [iw, ih] of CASES) {
      const k = ctx(iw, ih, 54 / 72, 0);
      let c = fillCrop(k);
      for (let i = 0; i < 400; i++) {
        const op = Math.floor(rnd() * 3);
        if (op === 0) c = zoomBy(c, k, 0.5 + rnd() * 2);
        else if (op === 1) c = panBy(c, k, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6);
        else c = normalizeCrop(c, k);
        expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
        expect(insideImage(c, k)).toBe(true);
      }
    }
  });
});

describe("pan", () => {
  it("clamps to the image edge rather than sampling off-photo", () => {
    const k = ctx(4000, 3000, 1);
    const c = panBy(setZoom(fillCrop(k), k, 2), k, 10, 10);
    expect(insideImage(c, k)).toBe(true);
    expect(c.x + c.w).toBeCloseTo(1, 9);
  });

  it("is a no-op at cover zoom on the constrained axis", () => {
    const k = ctx(4000, 3000, 1); // square slot, landscape photo: height is pinned
    const c = panBy(fillCrop(k), k, 0, 0.3);
    expect(c.y).toBeCloseTo(0, 9);
  });
});

describe("straighten", () => {
  it("keeps the rotated crop inside the photo at every angle", () => {
    for (const [iw, ih] of CASES) {
      for (const deg of [-15, -7.5, -1, 0, 1, 3.3, 7.5, 15]) {
        const k = ctx(iw, ih, 54 / 72, deg);
        const c = fillCrop(k);
        expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
        expect(insideImage(c, k)).toBe(true);
      }
    }
  });

  it("is a rigid rotation — crop stays a rectangle in pixel space", () => {
    const k = ctx(6000, 1500, 54 / 72, 12);
    const c = fillCrop(k);
    const [a, b, cc, d] = cropCornersPx(c, k);
    const side = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(q.x - p.x, q.y - p.y);
    expect(side(a, b)).toBeCloseTo(side(d, cc), 6);
    expect(side(b, cc)).toBeCloseTo(side(a, d), 6);
    // Adjacent sides meet at a right angle.
    const dot =
      (b.x - a.x) * (d.x - a.x) + (b.y - a.y) * (d.y - a.y);
    expect(dot).toBeCloseTo(0, 4);
    // And the sides carry the physical aspect.
    expect(side(a, b) / side(a, d)).toBeCloseTo(k.aspect, 6);
  });

  it("zooms in as needed rather than leaving empty corners", () => {
    const flat = ctx(4000, 3000, 4 / 3, 0);
    const tilted = ctx(4000, 3000, 4 / 3, 10);
    const a = fillCrop(flat);
    const b = fillCrop(tilted);
    expect(b.w).toBeLessThan(a.w);
    expect(insideImage(b, tilted)).toBe(true);
  });

  it("survives zoom and pan while tilted", () => {
    const k = ctx(3000, 4000, 1, -8);
    let c = fillCrop(k);
    c = zoomBy(c, k, 3);
    c = panBy(c, k, 0.4, -0.4);
    expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
    expect(insideImage(c, k)).toBe(true);
  });
});

describe("quarter turns", () => {
  it("orientedSize swaps on 90 and 270", () => {
    expect(orientedSize(4000, 3000, 0)).toEqual({ w: 4000, h: 3000 });
    expect(orientedSize(4000, 3000, 90)).toEqual({ w: 3000, h: 4000 });
    expect(orientedSize(4000, 3000, 180)).toEqual({ w: 4000, h: 3000 });
    expect(orientedSize(4000, 3000, 270)).toEqual({ w: 3000, h: 4000 });
  });

  it("four turns is identity", () => {
    const c = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const r = remapCropQuarter(c, 4);
    expect(r.x).toBeCloseTo(c.x, 12);
    expect(r.y).toBeCloseTo(c.y, 12);
    expect(r.w).toBeCloseTo(c.w, 12);
    expect(r.h).toBeCloseTo(c.h, 12);
  });

  it("keeps you looking at the same corner of the photo", () => {
    // A crop hugging the top-left should hug the top-right after one turn CW.
    const c = { x: 0, y: 0, w: 0.3, h: 0.4 };
    const r = remapCropQuarter(c, 1);
    expect(r.x + r.w).toBeCloseTo(1, 12);
    expect(r.y).toBeCloseTo(0, 12);
  });

  it("stays valid through a full rotate cycle at high zoom", () => {
    let rot = 0 as 0 | 90 | 180 | 270;
    let iw = 4000;
    let ih = 3000;
    let k = ctx(iw, ih, 54 / 72);
    let c = setZoom(fillCrop(k), k, 4);
    for (let i = 0; i < 8; i++) {
      c = remapCropQuarter(c, 1);
      rot = addQuarter(rot, 1);
      const o = orientedSize(4000, 3000, rot);
      iw = o.w;
      ih = o.h;
      k = ctx(iw, ih, 54 / 72);
      c = normalizeCrop(c, k);
      expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
      expect(insideImage(c, k)).toBe(true);
    }
    expect(rot).toBe(0);
  });

  it("addQuarter wraps both directions", () => {
    expect(addQuarter(0, -1)).toBe(270);
    expect(addQuarter(270, 1)).toBe(0);
    expect(addQuarter(90, 2)).toBe(270);
  });
});

describe("normalizeCrop", () => {
  it("repairs a crop with a drifted aspect", () => {
    const k = ctx(4000, 3000, 54 / 72);
    const c = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, k);
    expect(aspectOf(c, k)).toBeCloseTo(k.aspect, 9);
    expect(insideImage(c, k)).toBe(true);
  });

  it("repairs degenerate input", () => {
    const k = ctx(4000, 3000, 1);
    for (const bad of [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: NaN, y: NaN, w: NaN, h: NaN },
      { x: -5, y: -5, w: 20, h: 20 },
    ]) {
      const c = normalizeCrop(bad, k);
      expect(Number.isFinite(c.x)).toBe(true);
      expect(aspectOf(c, k)).toBeCloseTo(1, 9);
      expect(insideImage(c, k)).toBe(true);
    }
  });

  it("is idempotent", () => {
    const k = ctx(4000, 3000, 54 / 72, 6);
    const a = normalizeCrop({ x: 0.2, y: 0.1, w: 0.5, h: 0.9 }, k);
    const b = normalizeCrop(a, k);
    expect(b.x).toBeCloseTo(a.x, 12);
    expect(b.y).toBeCloseTo(a.y, 12);
    expect(b.w).toBeCloseTo(a.w, 12);
    expect(b.h).toBeCloseTo(a.h, 12);
  });
});
