import type { Crop } from "../types";
import type { CropContext } from "./geometry";
import { cropPixelSize } from "./geometry";
import { MM_PER_INCH } from "./units";

/**
 * Quality guard. Checked at drop and re-checked on every zoom change, because
 * zooming in eats resolution.
 *
 * Required px = w_mm * 11.81 for 300 dpi. A 54 x 72 mm slot needs 638 x 850 px.
 */

export const TARGET_DPI = 300;
export const AMBER_DPI = 200;

/** px per mm at 300 dpi — the 11.81 from the spec. */
export const PX_PER_MM_300 = TARGET_DPI / MM_PER_INCH;

export type QualityBand = "green" | "amber" | "red";

export type QualityReport = {
  dpi: number;
  band: QualityBand;
  requiredPx: { w: number; h: number };
  actualPx: { w: number; h: number };
};

export const requiredPx = (w_mm: number, h_mm: number): { w: number; h: number } => ({
  w: Math.round(w_mm * PX_PER_MM_300),
  h: Math.round(h_mm * PX_PER_MM_300),
});

export const bandFor = (dpi: number): QualityBand =>
  dpi >= TARGET_DPI ? "green" : dpi >= AMBER_DPI ? "amber" : "red";

/**
 * The dpi you will actually get. Both axes are checked and the worse one wins —
 * a crop can be generous horizontally and starved vertically.
 */
export const assessCrop = (
  crop: Crop,
  ctx: CropContext,
  w_mm: number,
  h_mm: number,
): QualityReport => {
  const px = cropPixelSize(crop, ctx);
  const dpiW = (px.w * MM_PER_INCH) / w_mm;
  const dpiH = (px.h * MM_PER_INCH) / h_mm;
  const dpi = Math.min(dpiW, dpiH);
  return {
    dpi,
    band: bandFor(dpi),
    requiredPx: requiredPx(w_mm, h_mm),
    actualPx: { w: Math.round(px.w), h: Math.round(px.h) },
  };
};

export const BAND_COLOR: Record<QualityBand, string> = {
  green: "#2f9e5f",
  amber: "#d99026",
  red: "#cf3b3b",
};

export const BAND_LABEL: Record<QualityBand, string> = {
  green: "300 dpi or better",
  amber: "200-300 dpi — usable, slightly soft",
  red: "under 200 dpi — will look soft in print",
};
