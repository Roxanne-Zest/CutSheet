import { describe, it, expect } from "vitest";
import { rectSvgPath, shapeSvgPath } from "./pdfPaths";
import { ptToMm } from "./units";
import type { SlotShape } from "../types";

/** Bounding box of every coordinate pair in a path, converted back to mm. */
const bbox = (path: string) => {
  const nums = path
    .split(/[A-Z]/)
    .flatMap((chunk) => chunk.trim().split(/\s+/))
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    xs.push(ptToMm(nums[i]));
    ys.push(ptToMm(nums[i + 1]));
  }
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
};

const SHAPES: SlotShape[] = ["rect", "rounded", "circle", "arch"];

/**
 * Paths are serialised to 0.001 pt, so millimetres come back with about
 * 0.0004 mm of rounding — four orders of magnitude finer than a printer.
 */
const MM = 3;

describe("shape outlines", () => {
  it("sit exactly on the box they are given", () => {
    for (const shape of SHAPES) {
      const b = bbox(shapeSvgPath(shape, 20, 30, 54, 72));
      expect(b.x, shape).toBeCloseTo(20, MM);
      expect(b.y, shape).toBeCloseTo(30, MM);
      expect(b.w, shape).toBeCloseTo(54, MM);
      expect(b.h, shape).toBeCloseTo(72, MM);
    }
  });

  it("rotating 90 degrees swaps the footprint and keeps the centre", () => {
    // The guide for a rotated placement is built at the finished size and
    // rotated — swapping the dimensions too would rotate it twice.
    for (const shape of SHAPES) {
      const flat = bbox(shapeSvgPath(shape, 20, 30, 54, 72));
      const turned = bbox(shapeSvgPath(shape, 20, 30, 54, 72, 90));

      expect(turned.w, shape).toBeCloseTo(flat.h, MM);
      expect(turned.h, shape).toBeCloseTo(flat.w, MM);

      expect(turned.x + turned.w / 2, shape).toBeCloseTo(flat.x + flat.w / 2, MM);
      expect(turned.y + turned.h / 2, shape).toBeCloseTo(flat.y + flat.h / 2, MM);
    }
  });

  it("a full turn is a no-op", () => {
    const a = bbox(shapeSvgPath("arch", 10, 10, 40, 60));
    const b = bbox(shapeSvgPath("arch", 10, 10, 40, 60, 360));
    expect(b.x).toBeCloseTo(a.x, MM);
    expect(b.y).toBeCloseTo(a.y, MM);
    expect(b.w).toBeCloseTo(a.w, MM);
    expect(b.h).toBeCloseTo(a.h, MM);
  });

  it("a tilt grows the bounding box in both directions", () => {
    const flat = bbox(rectSvgPath(0, 0, 50, 50));
    const tilted = bbox(rectSvgPath(0, 0, 50, 50, 6));
    expect(tilted.w).toBeGreaterThan(flat.w);
    expect(tilted.h).toBeGreaterThan(flat.h);
  });

  it("every path is closed", () => {
    for (const shape of SHAPES) {
      expect(shapeSvgPath(shape, 0, 0, 30, 40).trim().endsWith("Z"), shape).toBe(true);
    }
  });

  it("emits only commands pdf-lib understands", () => {
    for (const shape of SHAPES) {
      const letters = new Set(
        shapeSvgPath(shape, 0, 0, 30, 40).match(/[A-Za-z]/g) ?? [],
      );
      for (const l of letters) expect(["M", "L", "C", "Z"], shape).toContain(l);
    }
  });
});
