import { radians, rgb } from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { MM_PER_INCH, mmToPt } from "./units";

/**
 * Millimetre drawing helpers over pdf-lib, plus the calibration furniture that
 * has to be byte-identical everywhere it appears.
 *
 * Every sheet this app produces carries the same 100 mm ruler. It is the one
 * thing that tells you whether your printer scaled the page, so it is drawn by
 * one function rather than copied per feature.
 */

const DEG = Math.PI / 180;

export const INK = rgb(0.09, 0.1, 0.12);
export const MUTED = rgb(0.45, 0.47, 0.5);
export const HAIRLINE = rgb(0.62, 0.64, 0.67);
export const GUIDE = rgb(0.55, 0.35, 0.75);
export const WHITE = rgb(1, 1, 1);
export const ALARM = rgb(0.75, 0.2, 0.2);

/**
 * Greedy word wrap to a millimetre width. A word wider than the line gets its
 * own line rather than being dropped — a truncated warning is worse than an
 * ugly one.
 */
export const wrapText = (
  s: string,
  w_mm: number,
  font: PDFFont,
  size: number,
): string[] => {
  const limit = mmToPt(w_mm);
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > limit) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
};

/** Helpers that let a whole file think in millimetres, top-left origin. */
export const makeDraw = (page: PDFPage, pageH_mm: number) => {
  const yUp = (y_mm: number) => mmToPt(pageH_mm - y_mm);

  return {
    page,
    yUp,
    line(
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      thickness = 0.4,
      color = HAIRLINE,
      dash?: number[],
    ) {
      page.drawLine({
        start: { x: mmToPt(x1), y: yUp(y1) },
        end: { x: mmToPt(x2), y: yUp(y2) },
        thickness,
        color,
        dashArray: dash,
      });
    },
    text(
      s: string,
      x: number,
      yBaseline: number,
      font: PDFFont,
      size: number,
      color = INK,
    ) {
      page.drawText(s, {
        x: mmToPt(x),
        y: yUp(yBaseline),
        size,
        font,
        color,
      });
    },
    /** Width of a string in millimetres, for centring without guessing. */
    textW(s: string, font: PDFFont, size: number): number {
      return font.widthOfTextAtSize(s, size) / mmToPt(1);
    },
    /** Draw a string centred on x. */
    textCentered(
      s: string,
      cx: number,
      yBaseline: number,
      font: PDFFont,
      size: number,
      color = INK,
    ) {
      const w = font.widthOfTextAtSize(s, size) / mmToPt(1);
      this.text(s, cx - w / 2, yBaseline, font, size, color);
    },
    fillRect(
      x: number,
      y: number,
      w: number,
      h: number,
      color: ReturnType<typeof rgb>,
      opacity = 1,
    ) {
      page.drawRectangle({
        x: mmToPt(x),
        y: yUp(y + h),
        width: mmToPt(w),
        height: mmToPt(h),
        color,
        opacity,
      });
    },
    /** Draw an image at an exact physical size, rotated about its own centre. */
    image(img: PDFImage, x: number, y: number, w: number, h: number, rotation_deg = 0) {
      const a = -rotation_deg * DEG; // page-clockwise is PDF-counterclockwise
      const wp = mmToPt(w);
      const hp = mmToPt(h);
      const cx = mmToPt(x + w / 2);
      const cy = yUp(y + h / 2);
      const ox = (wp / 2) * Math.cos(a) - (hp / 2) * Math.sin(a);
      const oy = (wp / 2) * Math.sin(a) + (hp / 2) * Math.cos(a);
      page.drawImage(img, {
        x: cx - ox,
        y: cy - oy,
        width: wp,
        height: hp,
        rotate: radians(a),
      });
    },
    /**
     * Draw a paragraph wrapped to `w` millimetres. Returns the baseline the
     * next line would start on, so callers can stack blocks without guessing.
     */
    paragraph(
      s: string,
      x: number,
      yBaseline: number,
      w: number,
      font: PDFFont,
      size: number,
      color = INK,
      leading = size * 0.52,
    ): number {
      let y = yBaseline;
      for (const lineText of wrapText(s, w, font, size)) {
        this.text(lineText, x, y, font, size, color);
        y += leading;
      }
      return y;
    },
    path(d: string, color: ReturnType<typeof rgb>, thickness = 0.4, dash?: number[]) {
      page.drawSvgPath(d, {
        x: 0,
        y: mmToPt(pageH_mm),
        borderColor: color,
        borderWidth: thickness,
        borderDashArray: dash,
      });
    },
  };
};

export type Draw = ReturnType<typeof makeDraw>;

/** Height below the baseline that {@link drawRuler100} needs, in millimetres. */
export const RULER_HEIGHT_MM = 7;

/**
 * The 100 mm calibration ruler. Baseline at (x, y), ticks and labels below.
 *
 * `minorsTo` bounds how far the 1 mm ticks run. The cut sheets carry them the
 * whole way; the reference card stops at 20 mm, where they stop being readable
 * and start being a comb.
 */
export const drawRuler100 = (
  d: Draw,
  font: PDFFont,
  x: number,
  y: number,
  minorsTo = 100,
): void => {
  d.line(x, y, x + 100, y, 0.5, INK);
  for (let mm = 0; mm <= 100; mm += 1) {
    const major = mm % 50 === 0;
    const mid = mm % 10 === 0;
    if (!mid && mm > minorsTo) continue;
    const len = major ? 3 : mid ? 2.2 : 1.1;
    d.line(x + mm, y, x + mm, y + len, major ? 0.5 : 0.25, major ? INK : MUTED);
  }
  for (const mm of [0, 50, 100]) {
    d.textCentered(`${mm}`, x + mm, y + 6.5, font, 6, MUTED);
  }
  d.text("mm", x + 102, y + 3.5, font, 6, MUTED);
};

/** One-inch reference bar, drawn the same way so the two can be compared. */
export const drawInchBar = (d: Draw, font: PDFFont, x: number, y: number): void => {
  const inch = MM_PER_INCH;
  d.line(x, y, x + inch, y, 0.5, INK);
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const major = f === 0 || f === 1;
    d.line(x + f * inch, y, x + f * inch, y + (major ? 3 : f === 0.5 ? 2.2 : 1.4), major ? 0.5 : 0.25, major ? INK : MUTED);
  }
  d.text('1 inch (25.4 mm)', x + inch + 2, y + 2, font, 6, MUTED);
};

export const PRINT_AT_100 =
  'Print at 100% / Actual Size. Turn off "Fit to page" and "Shrink oversized pages".';

export const RULER_CHECK =
  "If this ruler does not measure exactly 100.0 mm, your printer scaled the page. Reprint at 100%.";
