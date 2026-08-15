import { describe, it, expect } from "vitest";
import {
  AMBER_DPI,
  PX_PER_MM_300,
  TARGET_DPI,
  assessCrop,
  bandFor,
  requiredPx,
} from "./quality";
import { fillCrop, setZoom } from "./geometry";
import type { CropContext } from "./geometry";

describe("required resolution", () => {
  it("uses 11.81 px per mm for 300 dpi", () => {
    expect(PX_PER_MM_300).toBeCloseTo(11.81, 2);
  });

  it("a 54 x 72 mm slot needs 638 x 850 px", () => {
    expect(requiredPx(54, 72)).toEqual({ w: 638, h: 850 });
  });
});

describe("thresholds", () => {
  it("green at 300 and above", () => {
    expect(bandFor(300)).toBe("green");
    expect(bandFor(TARGET_DPI)).toBe("green");
    expect(bandFor(1200)).toBe("green");
  });

  it("amber from 200 up to 300", () => {
    expect(bandFor(299.99)).toBe("amber");
    expect(bandFor(AMBER_DPI)).toBe("amber");
    expect(bandFor(250)).toBe("amber");
  });

  it("red below 200", () => {
    expect(bandFor(199.99)).toBe("red");
    expect(bandFor(72)).toBe("red");
  });
});

describe("assessing a crop", () => {
  const ctx = (iw: number, ih: number, aspect: number): CropContext => ({
    iw,
    ih,
    aspect,
    straighten_deg: 0,
  });

  it("a 4000 x 3000 photo comfortably fills a 54 x 72 mm slot", () => {
    const k = ctx(4000, 3000, 54 / 72);
    const r = assessCrop(fillCrop(k), k, 54, 72);
    expect(r.band).toBe("green");
    expect(r.dpi).toBeGreaterThan(300);
  });

  it("the worse axis wins", () => {
    // Wide and short: plenty of width, starved height.
    const k = ctx(4000, 300, 1);
    const r = assessCrop(fillCrop(k), k, 100, 100);
    expect(r.dpi).toBeLessThan(100);
    expect(r.band).toBe("red");
  });

  it("recheck on zoom — zooming in eats resolution", () => {
    // 1500 px onto 60 mm is 635 dpi at cover, and dpi falls off with zoom.
    const k = ctx(2000, 1500, 1);
    const base = fillCrop(k);
    const at1 = assessCrop(base, k, 60, 60);
    const at3 = assessCrop(setZoom(base, k, 3), k, 60, 60);
    const at5 = assessCrop(setZoom(base, k, 5), k, 60, 60);

    expect(at3.dpi).toBeCloseTo(at1.dpi / 3, 6);
    expect(at5.dpi).toBeCloseTo(at1.dpi / 5, 6);
    expect(at1.band).toBe("green");
    expect(at3.band).toBe("amber");
    expect(at5.band).toBe("red");
  });

  it("reports the pixels the slot actually needs alongside what it got", () => {
    // 540 x 720 px onto 54 x 72 mm is 254 dpi — short of the 638 x 850 needed.
    const k = ctx(540, 720, 54 / 72);
    const r = assessCrop(fillCrop(k), k, 54, 72);
    expect(r.requiredPx).toEqual({ w: 638, h: 850 });
    expect(r.actualPx).toEqual({ w: 540, h: 720 });
    expect(r.actualPx.w).toBeLessThan(r.requiredPx.w);
    expect(r.dpi).toBeCloseTo(254, 0);
    expect(r.band).toBe("amber");
  });

  it("a crop exactly meeting 300 dpi lands green", () => {
    // 638 x 850 px onto 54 x 72 mm is the spec's own worked example.
    const k = ctx(638, 850, 638 / 850);
    const r = assessCrop(fillCrop(k), k, (638 * 25.4) / 300, (850 * 25.4) / 300);
    expect(r.dpi).toBeCloseTo(300, 6);
    expect(r.band).toBe("green");
  });
});
