import { A4, MM_PER_INCH, round } from "./units";
import { AMBER_DPI, TARGET_DPI } from "./quality";
import type { QualityBand } from "./quality";

/**
 * Feature B — Sheet Sizer.
 *
 * A sticker sheet someone sent you is 2400 x 3300 px. That is not a physical
 * size, and nothing in the file says the circles should be 12 mm — so there is
 * no "correct" percentage to print at. Measure one sticker, state what it
 * should be, and everything else follows by arithmetic.
 *
 * Every function here is pure. The measuring is the only part that needs a
 * canvas, and it lives in the component.
 */

/** Margin left around the artwork on each A4 sheet. */
export const SHEET_MARGIN_MM = 8;
/**
 * Bottom band reserved on every sheet for the calibration ruler, the print-at-
 * 100% instruction and the size report. Artwork never enters it — a ruler with
 * a sticker printed over it cannot be measured.
 *
 * 28 mm is the largest band that still leaves room for a 190 x 261 mm sheet on
 * one page, which is the size the worked example produces. Widening it is not a
 * free change: it takes common sticker sheets off a single sheet of A4.
 */
export const SHEET_FOOTER_MM = 28;
/** Overlap between tiles, so a slightly wandering cut still has material. */
export const TILE_OVERLAP_MM = 5;

export type Measurement = {
  /** Distance the user dragged, in source-image pixels. */
  measured_px: number;
  /** What that distance is supposed to be, in millimetres. */
  target_mm: number;
};

/**
 * The scale that makes the measured feature come out the stated size.
 * Every other dimension on the sheet is this number times its pixel count, so
 * an error here is multiplied across the whole sheet.
 */
export const mmPerPx = (m: Measurement): number =>
  m.measured_px > 0 ? m.target_mm / m.measured_px : 0;

export const physicalSize = (
  w_px: number,
  h_px: number,
  scale: number,
): { w_mm: number; h_mm: number } => ({
  w_mm: round(w_px * scale, 4),
  h_mm: round(h_px * scale, 4),
});

/** The dpi the sheet will actually print at. */
export const effectiveDpi = (scale: number): number => (scale > 0 ? MM_PER_INCH / scale : 0);

/**
 * Percentage to type into Preview or Photos, for people who would rather print
 * from there. Only meaningful when the file carries a dpi of its own.
 */
export const printPercent = (embedded_dpi: number, scale: number): number =>
  (100 * embedded_dpi * scale) / MM_PER_INCH;

export const dpiBand = (dpi: number): QualityBand =>
  dpi >= TARGET_DPI ? "green" : dpi >= AMBER_DPI ? "amber" : "red";

/**
 * How costly a one-pixel mis-measurement is, as a fraction. Measuring across a
 * 25 mm circle instead of a 12 mm one halves it, which is why the UI says so.
 */
export const errorPerPixel = (measured_px: number): number =>
  measured_px > 0 ? 1 / measured_px : Infinity;

export type OutputMode = "single" | "fit" | "tile";

export type Tile = {
  sheet: number;
  col: number;
  row: number;
  /** The region of the artwork on this sheet, in the artwork's own millimetres. */
  sx_mm: number;
  sy_mm: number;
  sw_mm: number;
  sh_mm: number;
};

export type SizerPlan = {
  mode: OutputMode;
  /** Multiplier applied to true size. 1 unless the user chose to scale to fit. */
  scale: number;
  /** Size the artwork is drawn at, after any fit scaling. */
  w_mm: number;
  h_mm: number;
  /** True size, before any fit scaling — what the artwork is supposed to be. */
  true_w_mm: number;
  true_h_mm: number;
  rotated: boolean;
  sheets: number;
  tiles: Tile[];
  printable: { w_mm: number; h_mm: number };
  margin_mm: number;
  footer_mm: number;
  overlap_mm: number;
  warnings: string[];
};

export type PlanOptions = {
  mode: OutputMode;
  margin_mm?: number;
  footer_mm?: number;
  overlap_mm?: number;
  /** Turn the artwork 90 degrees when that is the only way it fits one sheet. */
  allowRotate?: boolean;
};

export const printableArea = (
  margin_mm = SHEET_MARGIN_MM,
  footer_mm = SHEET_FOOTER_MM,
) => ({
  w_mm: round(A4.w_mm - 2 * margin_mm, 4),
  h_mm: round(A4.h_mm - margin_mm - footer_mm, 4),
});

/** Tiles along one axis, given a run length, a sheet length and an overlap. */
export const tileCount = (run_mm: number, sheet_mm: number, overlap_mm: number): number => {
  if (run_mm <= sheet_mm + 1e-9) return 1;
  const step = sheet_mm - overlap_mm;
  if (step <= 0) return Infinity;
  return Math.ceil((run_mm - overlap_mm) / step);
};

const axisTiles = (run_mm: number, sheet_mm: number, overlap_mm: number): Array<[number, number]> => {
  const n = tileCount(run_mm, sheet_mm, overlap_mm);
  if (!Number.isFinite(n)) return [[0, run_mm]];
  const step = sheet_mm - overlap_mm;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const start = i * step;
    out.push([round(start, 4), round(Math.min(sheet_mm, run_mm - start), 4)]);
  }
  return out;
};

/**
 * Decide how the artwork lands on A4.
 *
 * `single` is the honest answer and the only one that keeps the stickers the
 * size you asked for. `fit` is offered because people ask for it, and carries a
 * warning that says plainly what it costs.
 */
export const planOutput = (
  true_w_mm: number,
  true_h_mm: number,
  o: PlanOptions,
): SizerPlan => {
  const margin = o.margin_mm ?? SHEET_MARGIN_MM;
  const footer = o.footer_mm ?? SHEET_FOOTER_MM;
  const overlap = o.overlap_mm ?? TILE_OVERLAP_MM;
  const allowRotate = o.allowRotate ?? true;
  const printable = printableArea(margin, footer);
  const warnings: string[] = [];

  const fitsUpright = true_w_mm <= printable.w_mm + 1e-9 && true_h_mm <= printable.h_mm + 1e-9;
  const fitsTurned = true_h_mm <= printable.w_mm + 1e-9 && true_w_mm <= printable.h_mm + 1e-9;
  const rotated = !fitsUpright && fitsTurned && allowRotate;
  const onOneSheet = fitsUpright || rotated;

  const base = {
    true_w_mm: round(true_w_mm, 4),
    true_h_mm: round(true_h_mm, 4),
    printable,
    margin_mm: margin,
    footer_mm: footer,
    overlap_mm: overlap,
  };

  const oneSheetTile = (w: number, h: number): Tile[] => [
    { sheet: 1, col: 0, row: 0, sx_mm: 0, sy_mm: 0, sw_mm: round(w, 4), sh_mm: round(h, 4) },
  ];

  if (o.mode === "single" || onOneSheet) {
    if (!onOneSheet) {
      // Asked for one sheet, will not fit on one sheet. Say so rather than
      // silently shrinking — silent shrinking is the bug this whole tool exists
      // to prevent.
      warnings.push(
        `At true size this sheet is ${round(true_w_mm, 1)} x ${round(true_h_mm, 1)} mm, which is bigger than the ${printable.w_mm} x ${printable.h_mm} mm printable area of A4. Tile it, or scale to fit and accept that the stickers will no longer be the size you asked for.`,
      );
    }
    return {
      ...base,
      mode: "single",
      scale: 1,
      w_mm: round(true_w_mm, 4),
      h_mm: round(true_h_mm, 4),
      rotated,
      sheets: 1,
      tiles: oneSheetTile(true_w_mm, true_h_mm),
      warnings,
    };
  }

  if (o.mode === "fit") {
    const upright = Math.min(printable.w_mm / true_w_mm, printable.h_mm / true_h_mm);
    const turned = allowRotate
      ? Math.min(printable.w_mm / true_h_mm, printable.h_mm / true_w_mm)
      : 0;
    const turnIt = turned > upright;
    const scale = Math.min(1, turnIt ? turned : upright);
    const w = true_w_mm * scale;
    const h = true_h_mm * scale;
    warnings.push(
      `Scaled to ${round(scale * 100, 1)}% to fit A4. The stickers will NOT be the size you measured — a 12 mm circle prints at ${round(12 * scale, 2)} mm. Use tiling if the size has to be right.`,
    );
    return {
      ...base,
      mode: "fit",
      scale: round(scale, 6),
      w_mm: round(w, 4),
      h_mm: round(h, 4),
      rotated: turnIt,
      sheets: 1,
      tiles: oneSheetTile(w, h),
      warnings,
    };
  }

  // ---- tile
  const cols = axisTiles(true_w_mm, printable.w_mm, overlap);
  const rows = axisTiles(true_h_mm, printable.h_mm, overlap);
  const tiles: Tile[] = [];
  let sheet = 0;
  for (const [r, [sy, sh]] of rows.entries()) {
    for (const [c, [sx, sw]] of cols.entries()) {
      sheet += 1;
      tiles.push({ sheet, col: c, row: r, sx_mm: sx, sy_mm: sy, sw_mm: sw, sh_mm: sh });
    }
  }
  warnings.push(
    `Tiled across ${tiles.length} sheets with ${overlap} mm overlap. Trim on the overlap line and butt the sheets together; every sticker stays exactly the size you measured.`,
  );

  return {
    ...base,
    mode: "tile",
    scale: 1,
    w_mm: round(true_w_mm, 4),
    h_mm: round(true_h_mm, 4),
    rotated: false,
    sheets: tiles.length,
    tiles,
    warnings,
  };
};

/** One line summarising the whole measurement, for the live readout. */
export const readout = (
  m: Measurement,
  w_px: number,
  h_px: number,
): string => {
  const scale = mmPerPx(m);
  const size = physicalSize(w_px, h_px, scale);
  return `measured ${round(m.measured_px, 0)} px → ${round(m.target_mm, 2)} mm → sheet prints at ${round(
    size.w_mm,
    0,
  )} × ${round(size.h_mm, 0)} mm`;
};
