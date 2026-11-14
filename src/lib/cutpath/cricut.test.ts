import { describe, expect, it } from "vitest";
import { runCutPath } from "./pipeline";
import { DEFAULT_CUTPATH } from "./types";
import type { CutPathSettings, Poly } from "./types";
import type { Rgba } from "./mask";
import { distanceToPolys, pointInRing } from "./offset";
import { boundsOf } from "./trace";
import {
  CRICUT_INSET_MAX_MM,
  cricutInset,
  cricutPrintPolys,
  toCricutCutSvg,
} from "./exportPath";

const settings = (o: Partial<CutPathSettings> = {}): CutPathSettings => ({
  ...DEFAULT_CUTPATH,
  ...o,
});

/** White page, dark artwork wherever `inside` says so. */
const page = (w: number, h: number, inside: (x: number, y: number) => boolean): Rgba => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const v = inside(x, y) ? 40 : 255;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, w, h };
};

/**
 * A five-pointed star: deep concave notches, which is exactly where a tracer's
 * smoothing bulges out and where the inset has to hold.
 */
const star = (size = 240): Rgba => {
  const c = size / 2;
  return page(size, size, (x, y) => {
    const a = Math.atan2(y - c, x - c);
    const r = size * (0.24 + 0.14 * Math.cos(a * 5));
    return Math.hypot(x - c, y - c) <= r;
  });
};

const sixDiscs = (): Rgba =>
  page(360, 120, (x, y) => {
    for (let k = 0; k < 6; k++) if (Math.hypot(x - (30 + k * 60), y - 60) <= 18) return true;
    return false;
  });

const allPoints = (polys: Poly[]) => polys.flatMap((p) => [...p.outer, ...p.holes.flat()]);

describe("cricutInset", () => {
  it("is half the border, capped", () => {
    expect(cricutInset(2)).toBe(CRICUT_INSET_MAX_MM);
    expect(cricutInset(1)).toBe(0.5);
    expect(cricutInset(0.4)).toBe(0.2);
  });

  it("is zero without a positive border, so no sliver shows at the edge", () => {
    expect(cricutInset(0)).toBe(0);
    expect(cricutInset(-0.5)).toBe(0);
  });
});

describe("the Cricut print outline", () => {
  const r = runCutPath(star(), settings({ width_mm: 50, border_mm: 2 }));
  const inset = cricutInset(2);
  const print = cricutPrintPolys(r.polys, inset);

  it("sits inside the cut line everywhere, by the inset", () => {
    expect(print.length).toBe(r.polys.length);
    for (const p of allPoints(print)) {
      expect(r.polys.some((poly) => pointInRing(p, poly.outer))).toBe(true);
      expect(Math.abs(distanceToPolys(p, r.polys) - inset)).toBeLessThan(0.02);
    }
  });

  it("still contains the artwork, so nothing printed is lost", () => {
    for (const p of allPoints(r.artwork)) {
      expect(print.some((poly) => pointInRing(p, poly.outer) || distanceToPolys(p, print) < 0.05)).toBe(true);
    }
  });

  it("shares the cut line's centre, so Align → Centre lines the two up", () => {
    const cut = boundsOf(r.polys);
    const img = boundsOf(print);
    expect(Math.abs(cut.x + cut.w / 2 - (img.x + img.w / 2))).toBeLessThan(0.02);
    expect(Math.abs(cut.y + cut.h / 2 - (img.y + img.h / 2))).toBeLessThan(0.02);
    expect(Math.abs(cut.w - img.w - 2 * inset)).toBeLessThan(0.02);
    expect(Math.abs(cut.h - img.h - 2 * inset)).toBeLessThan(0.02);
  });

  it("keeps every sticker on a sheet", () => {
    const sheet = runCutPath(sixDiscs(), settings({ width_mm: 180, border_mm: 2 }));
    expect(sheet.polys.length).toBe(6);
    expect(cricutPrintPolys(sheet.polys, cricutInset(2)).length).toBe(6);
  });

  it("is the cut path itself when there is no inset", () => {
    expect(cricutPrintPolys(r.polys, 0)).toBe(r.polys);
  });
});

describe("toCricutCutSvg", () => {
  const r = runCutPath(star(), settings({ width_mm: 50, border_mm: 2 }));
  const b = boundsOf(r.polys);
  const svg = toCricutCutSvg({ polys: r.polys, w_mm: b.w, h_mm: b.h, name: "star", fill: "#ffffff" });

  it("is sized in millimetres", () => {
    expect(svg).toMatch(/width="[\d.]+mm" height="[\d.]+mm"/);
    expect(svg).toContain(`viewBox="0 0 ${Math.round(b.w * 1e4) / 1e4} ${Math.round(b.h * 1e4) / 1e4}"`);
  });

  it("is a filled shape — no stroke, no embedded image for Design Space to drop", () => {
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="none"');
    expect(svg).not.toContain("<image");
    expect(svg.match(/<path /g)?.length).toBe(1);
    expect(svg).toMatch(/<path d="M /);
  });
});
