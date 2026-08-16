import { describe, expect, it } from "vitest";
import {
  SHEET_FOOTER_MM,
  SHEET_MARGIN_MM,
  TILE_OVERLAP_MM,
  dpiBand,
  effectiveDpi,
  errorPerPixel,
  mmPerPx,
  physicalSize,
  planOutput,
  printPercent,
  printableArea,
  readout,
  tileCount,
} from "./sheetSizer";

describe("X4 — the arithmetic the whole feature rests on", () => {
  it("works the spec's own example", () => {
    // 384 px across a circle that is supposed to be 12 mm.
    const scale = mmPerPx({ measured_px: 384, target_mm: 12 });
    expect(scale).toBeCloseTo(0.03125, 9);

    const size = physicalSize(2400, 3300, scale);
    expect(size.w_mm).toBeCloseTo(75, 6);
    expect(size.h_mm).toBeCloseTo(103.125, 6);

    expect(effectiveDpi(scale)).toBeCloseTo(812.8, 4);
  });

  it("turns a 6080 px sheet into the readout the UI shows", () => {
    // A sheet whose 12 mm circle spans 384 px prints at 190 x 261 mm when the
    // sheet is 6080 x 8352 px.
    const scale = mmPerPx({ measured_px: 384, target_mm: 12 });
    const size = physicalSize(6080, 8352, scale);
    expect(Math.round(size.w_mm)).toBe(190);
    expect(Math.round(size.h_mm)).toBe(261);
    expect(readout({ measured_px: 384, target_mm: 12 }, 6080, 8352)).toBe(
      "measured 384 px → 12 mm → sheet prints at 190 × 261 mm",
    );
  });

  it("converts to a print percentage only where the file has a dpi", () => {
    const scale = mmPerPx({ measured_px: 384, target_mm: 12 });
    // At 812.8 effective dpi from a 300 dpi file you print at ~36.9%.
    expect(printPercent(300, scale)).toBeCloseTo(36.9094488, 5);
    // A file that says it is already the right dpi prints at 100%.
    expect(printPercent(effectiveDpi(scale), scale)).toBeCloseTo(100, 9);
  });

  it("refuses to divide by a zero-length drag", () => {
    expect(mmPerPx({ measured_px: 0, target_mm: 12 })).toBe(0);
    expect(effectiveDpi(0)).toBe(0);
  });

  it("bands resolution the same way the photo editor does", () => {
    expect(dpiBand(400)).toBe("green");
    expect(dpiBand(300)).toBe("green");
    expect(dpiBand(250)).toBe("amber");
    expect(dpiBand(199)).toBe("red");
  });

  it("shows why you measure the biggest feature you can find", () => {
    // The same one-pixel slip costs half as much across a 25 mm circle.
    const small = errorPerPixel(384);
    const large = errorPerPixel(800);
    expect(large).toBeLessThan(small);
    expect(small / large).toBeCloseTo(800 / 384, 9);
  });
});

describe("X6 — how the artwork lands on A4", () => {
  it("reserves the footer band so artwork never covers the ruler", () => {
    const p = printableArea();
    expect(p.w_mm).toBe(210 - 2 * SHEET_MARGIN_MM);
    expect(p.h_mm).toBe(297 - SHEET_MARGIN_MM - SHEET_FOOTER_MM);
  });

  it("prints a sheet that fits on one page at true size", () => {
    const plan = planOutput(190, 261, { mode: "single" });
    expect(plan.mode).toBe("single");
    expect(plan.scale).toBe(1);
    expect(plan.sheets).toBe(1);
    expect(plan.w_mm).toBe(190);
    expect(plan.h_mm).toBe(261);
    expect(plan.warnings).toEqual([]);
  });

  it("keeps the worked example on a single sheet, upright and unwarned", () => {
    // 190 x 261 mm is what the spec's own worked example produces. The footer
    // band is sized around it; widening the band would quietly push common
    // sticker sheets onto two pieces of paper.
    const plan = planOutput(190, 261, { mode: "single" });
    expect(plan.rotated).toBe(false);
    expect(plan.printable.h_mm).toBeGreaterThanOrEqual(261);
    expect(plan.printable.w_mm).toBeGreaterThanOrEqual(190);
  });

  it("turns a sheet 90 degrees rather than tiling it when that is enough", () => {
    // 250 x 150 does not fit upright (250 > 194) but does fit turned.
    const plan = planOutput(250, 150, { mode: "single" });
    expect(plan.rotated).toBe(true);
    expect(plan.sheets).toBe(1);
    expect(plan.scale).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it("says plainly when one sheet cannot hold it at true size", () => {
    const plan = planOutput(300, 400, { mode: "single" });
    expect(plan.sheets).toBe(1);
    expect(plan.scale).toBe(1);
    expect(plan.warnings.join(" ")).toMatch(/bigger than the .* printable area/);
  });

  it("scale-to-fit says what it costs, in millimetres", () => {
    const plan = planOutput(300, 400, { mode: "fit" });
    expect(plan.mode).toBe("fit");
    expect(plan.scale).toBeLessThan(1);
    expect(plan.w_mm).toBeLessThanOrEqual(plan.printable.w_mm + 1e-6);
    expect(plan.h_mm).toBeLessThanOrEqual(plan.printable.h_mm + 1e-6);
    const warning = plan.warnings.join(" ");
    expect(warning).toMatch(/NOT be the size you measured/);
    expect(warning).toMatch(/12 mm circle prints at \d/);
  });

  it("never scales a fit above 100% — it is a fit, not a stretch", () => {
    const plan = planOutput(50, 50, { mode: "fit" });
    expect(plan.scale).toBe(1);
  });

  it("tiles with the stated overlap and keeps every sticker true size", () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    expect(plan.mode).toBe("tile");
    expect(plan.scale).toBe(1);
    expect(plan.overlap_mm).toBe(TILE_OVERLAP_MM);
    expect(plan.sheets).toBe(plan.tiles.length);
    expect(plan.sheets).toBeGreaterThan(1);
  });

  it("covers the whole artwork with tiles, leaving no gap", () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    const cols = [...new Set(plan.tiles.map((t) => t.sx_mm))].sort((a, b) => a - b);
    const rows = [...new Set(plan.tiles.map((t) => t.sy_mm))].sort((a, b) => a - b);
    expect(cols[0]).toBe(0);
    expect(rows[0]).toBe(0);

    const right = Math.max(...plan.tiles.map((t) => t.sx_mm + t.sw_mm));
    const bottom = Math.max(...plan.tiles.map((t) => t.sy_mm + t.sh_mm));
    expect(right).toBeCloseTo(300, 6);
    expect(bottom).toBeCloseTo(400, 6);

    // Consecutive tiles must genuinely overlap, not merely abut.
    for (let i = 1; i < cols.length; i++) {
      const prevEnd = cols[i - 1] + plan.printable.w_mm;
      expect(prevEnd - cols[i]).toBeCloseTo(TILE_OVERLAP_MM, 6);
    }
  });

  it("never puts a tile wider than the printable area", () => {
    const plan = planOutput(700, 900, { mode: "tile" });
    for (const t of plan.tiles) {
      expect(t.sw_mm).toBeLessThanOrEqual(plan.printable.w_mm + 1e-6);
      expect(t.sh_mm).toBeLessThanOrEqual(plan.printable.h_mm + 1e-6);
    }
  });

  it("uses one sheet when the artwork fits, whatever mode was asked for", () => {
    for (const mode of ["single", "fit", "tile"] as const) {
      const plan = planOutput(100, 100, { mode });
      expect(plan.sheets, mode).toBe(1);
      expect(plan.scale, mode).toBe(1);
    }
  });

  it("counts tiles the way the overlap actually works", () => {
    expect(tileCount(100, 194, 5)).toBe(1);
    expect(tileCount(194, 194, 5)).toBe(1);
    expect(tileCount(195, 194, 5)).toBe(2);
    expect(tileCount(383, 194, 5)).toBe(2);
    expect(tileCount(384, 194, 5)).toBe(3);
  });
});
