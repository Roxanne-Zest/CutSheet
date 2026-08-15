/** Unit conversions. The whole product is dimensional accuracy, so these live in one place. */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

/** Millimetres to PDF points. */
export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;

/** PDF points to millimetres. */
export const ptToMm = (pt: number): number => (pt * MM_PER_INCH) / PT_PER_INCH;

/** Pixels needed to hit a given dpi across a physical width. */
export const mmToPx = (mm: number, dpi: number): number => (mm / MM_PER_INCH) * dpi;

/** The dpi you actually get printing `px` pixels across `mm` millimetres. */
export const dpiFor = (px: number, mm: number): number => (px * MM_PER_INCH) / mm;

/** A4 in millimetres. */
export const A4 = { w_mm: 210, h_mm: 297 } as const;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const round = (v: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
