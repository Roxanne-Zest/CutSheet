import { describe, expect, it } from "vitest";
import {
  SNAP_RADIUS_PX,
  axisOf,
  luminance,
  profileAlong,
  samplerFor,
  snapEndpoint,
  snapMeasurement,
  strongestEdge,
} from "./edgeSnap";

/** A white field with a black disc, which is what a sticker sheet looks like. */
const disc = (w: number, h: number, cx: number, cy: number, r: number) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
      const v = inside ? 20 : 245;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return samplerFor(data, w, h);
};

describe("luminance", () => {
  it("weights the channels the way an eye does", () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 6);
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(0, 255, 0)).toBeGreaterThan(luminance(255, 0, 0));
  });
});

describe("strongest edge", () => {
  it("finds the step in a step profile", () => {
    //           0  1  2  3  4  5  6
    const p = [250, 250, 250, 20, 20, 20, 20];
    // The central difference peaks either side of the step; both are edges.
    expect([2, 3]).toContain(strongestEdge(p));
  });

  it("prefers the candidate nearest where you actually aimed", () => {
    // Two identical steps, one on each side of centre.
    const p = [250, 20, 250, 250, 250, 20, 250];
    const centre = 3;
    expect(Math.abs(strongestEdge(p) - centre)).toBeLessThanOrEqual(2);
  });

  it("leaves a flat profile where it was dropped", () => {
    expect(strongestEdge([100, 100, 100, 100, 100])).toBe(2);
  });

  it("copes with a profile too short to have an interior", () => {
    expect(strongestEdge([10, 20])).toBe(1);
  });
});

describe("X4 — snap to edge", () => {
  const sample = disc(200, 200, 100, 100, 40);

  it("pulls a sloppy endpoint onto the edge of the disc", () => {
    // The disc spans x 60..140 on the centre line. Aim 4 px inside the left
    // edge, which is what a real drag looks like.
    const axis = { x: 1, y: 0 };
    const { point, moved_px } = snapEndpoint(sample, { x: 64, y: 100 }, axis);
    expect(Math.abs(point.x - 60)).toBeLessThanOrEqual(1);
    expect(moved_px).toBeGreaterThan(0);
    expect(moved_px).toBeLessThanOrEqual(SNAP_RADIUS_PX);
  });

  it("turns a roughly-right drag into a correct diameter", () => {
    // 80 px across, dropped 3 px in on one side and 5 px out on the other.
    const snapped = snapMeasurement(sample, { x: 63, y: 100 }, { x: 145, y: 100 });
    const length = Math.hypot(snapped.b.x - snapped.a.x, snapped.b.y - snapped.a.y);
    expect(length).toBeCloseTo(80, 0);
  });

  it("never moves an endpoint further than the search radius", () => {
    const axis = { x: 1, y: 0 };
    for (const x of [10, 50, 61, 100, 139, 190]) {
      const { point } = snapEndpoint(sample, { x, y: 100 }, axis);
      expect(Math.abs(point.x - x)).toBeLessThanOrEqual(SNAP_RADIUS_PX);
    }
  });

  it("leaves an endpoint alone in flat white, where there is nothing to snap to", () => {
    const flat = disc(200, 200, 100, 100, 0);
    const { point, moved_px } = snapEndpoint(flat, { x: 30, y: 30 }, { x: 1, y: 0 });
    expect(moved_px).toBe(0);
    expect(point).toEqual({ x: 30, y: 30 });
  });

  it("searches along the measurement axis, not along the screen", () => {
    // A vertical measurement must search vertically, or it snaps to nothing.
    const axis = axisOf({ x: 100, y: 64 }, { x: 100, y: 136 });
    expect(axis.y).toBeCloseTo(1, 9);
    const { point } = snapEndpoint(sample, { x: 100, y: 64 }, axis);
    expect(Math.abs(point.y - 60)).toBeLessThanOrEqual(1);
  });

  it("falls back to horizontal for a zero-length drag rather than dividing by zero", () => {
    const axis = axisOf({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(axis).toEqual({ x: 1, y: 0 });
  });

  it("samples one pixel per step across the whole window", () => {
    const { profile, offsets } = profileAlong(sample, { x: 100, y: 100 }, { x: 1, y: 0 }, 6);
    expect(profile).toHaveLength(13);
    expect(offsets[0]).toBe(-6);
    expect(offsets.at(-1)).toBe(6);
  });

  it("clamps at the image border instead of reading past it", () => {
    const { profile } = profileAlong(sample, { x: 0, y: 0 }, { x: 1, y: 0 }, 6);
    expect(profile.every((v) => Number.isFinite(v))).toBe(true);
  });
});
