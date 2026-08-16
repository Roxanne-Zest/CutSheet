import { PDFDocument, StandardFonts } from "pdf-lib";
import { A4, MM_PER_INCH, mmToPt, round } from "./units";
import { inchLabel } from "./imperial";
import {
  ALARM,
  HAIRLINE,
  INK,
  MUTED,
  PRINT_AT_100,
  RULER_CHECK,
  drawInchBar,
  drawRuler100,
  makeDraw,
} from "./pdfDraw";
import { shapeSvgPath } from "./pdfPaths";

/**
 * Feature A — the scale reference card.
 *
 * One printed page of shapes at known physical sizes. You check any print
 * against it once and you never wonder about your printer again.
 *
 * Nothing here depends on a photo, a canvas or a project, so the card can be
 * produced from a cold start.
 */

/**
 * A punch cuts a slightly ragged circle and it is never perfectly centred, so
 * a circle printed at exactly the punch size leaves a white rim. Half a
 * millimetre of extra ink puts the blade inside the printed area every time.
 */
export const PUNCH_BLEED_MM = 0.5;

export const CIRCLE_SIZES_MM = [8, 10, 12, 15, 19, 20, 25, 25.4, 32, 38] as const;
export const SQUARE_SIZES_MM = [10, 20, 25] as const;

/** Widest circle the card can lay out, given its margins. */
export const MAX_CUSTOM_MM = 150;
export const CUSTOM_ROW_COUNT = 6;

const MARGIN_MM = 12;
const CONTENT_W_MM = A4.w_mm - 2 * MARGIN_MM;
const CONTENT_TOP_MM = 34;
/** Space under each shape for its caption. */
const CAPTION_MM = 6;
const GAP_X_MM = 7;
const GAP_Y_MM = 7;
const SECTION_GAP_MM = 9;

/**
 * The calibration furniture is pinned to the bottom — the ruler runs along the
 * foot of the card, as it should. The punch note floats up to sit under the
 * shapes instead, so a card with no custom row does not have 70 mm of nothing
 * in the middle of it.
 */
const NOTE_GAP_MM = 14;
const NOTE_HEIGHT_MM = 13;
const INCH_BAR_Y_MM = 258;
const RULER_Y_MM = 268;
/** Lowest the punch note can go before it would collide with the inch bar. */
const NOTE_MAX_Y_MM = INCH_BAR_Y_MM - NOTE_HEIGHT_MM;

export type RefCardOptions = {
  /**
   * Label circles by the punch they suit rather than by what is drawn, adding
   * {@link PUNCH_BLEED_MM} to the drawn size.
   */
  punchMode: boolean;
  /** An extra circle at a size the user typed. */
  custom?: { diameter_mm: number; row: boolean };
  title?: string;
};

export type RefShape =
  | {
      kind: "circle";
      /** Top-left of the bounding box, in millimetres. */
      x_mm: number;
      y_mm: number;
      /** What is actually drawn — already includes the punch bleed. */
      d_mm: number;
      caption: string;
      sub?: string;
    }
  | { kind: "square"; x_mm: number; y_mm: number; s_mm: number; caption: string };

export type RefCardPlan = {
  shapes: RefShape[];
  sections: Array<{ title: string; y_mm: number }>;
  /** Bottom of the last laid-out row, so overflow is measurable. */
  contentBottom_mm: number;
  /** Where the punch-bleed note sits — it follows the shapes. */
  noteY_mm: number;
  inchBarY_mm: number;
  rulerY_mm: number;
  warnings: string[];
};

/** What gets drawn for a circle labelled `label_mm`. */
export const drawnDiameter = (label_mm: number, punchMode: boolean): number =>
  round(punchMode ? label_mm + PUNCH_BLEED_MM : label_mm, 4);

/**
 * Caption for a circle. In punch mode the label is the punch it fits, which is
 * deliberately not the size on the page — so the drawn size goes underneath
 * rather than being left as a mystery.
 */
export const circleCaption = (
  label_mm: number,
  punchMode: boolean,
): { caption: string; sub?: string } => {
  const inch = inchLabel(label_mm);
  const size = `${round(label_mm, 2)} mm`;
  if (punchMode) {
    return {
      caption: `${size} punch`,
      sub: `prints ø${round(drawnDiameter(label_mm, true), 2)}`,
    };
  }
  return { caption: size, sub: inch };
};

export type FlowBox = { w: number; h: number };
export type Flowed<T> = { item: T; x: number; y: number };

/**
 * Wrap boxes into left-to-right rows inside `width`. Order is preserved — the
 * card reads small-to-large, and a packer that reordered would break that.
 */
export const flowRows = <T>(
  items: T[],
  size: (t: T) => FlowBox,
  width: number,
  y0: number,
  gapX = GAP_X_MM,
  gapY = GAP_Y_MM,
): { placed: Array<Flowed<T>>; bottom: number } => {
  const placed: Array<Flowed<T>> = [];
  let x = 0;
  let y = y0;
  let rowH = 0;

  for (const item of items) {
    const b = size(item);
    if (x > 0 && x + b.w > width + 1e-9) {
      y += rowH + gapY;
      x = 0;
      rowH = 0;
    }
    placed.push({ item, x, y });
    x += b.w + gapX;
    rowH = Math.max(rowH, b.h);
  }

  return { placed, bottom: placed.length ? y + rowH : y0 };
};

/** Bottom-align a row of mixed-height shapes so they sit on a common line. */
const alignBaseline = <T>(
  placed: Array<Flowed<T>>,
  height: (t: T) => number,
): Array<Flowed<T>> => {
  const rowBottom = new Map<number, number>();
  for (const p of placed) {
    rowBottom.set(p.y, Math.max(rowBottom.get(p.y) ?? 0, p.y + height(p.item)));
  }
  return placed.map((p) => ({
    ...p,
    y: (rowBottom.get(p.y) ?? p.y + height(p.item)) - height(p.item),
  }));
};

export const buildRefCardPlan = (o: RefCardOptions): RefCardPlan => {
  const shapes: RefShape[] = [];
  const sections: Array<{ title: string; y_mm: number }> = [];
  const warnings: string[] = [];

  // ---- circles
  const circles = CIRCLE_SIZES_MM.map((label) => {
    const d = drawnDiameter(label, o.punchMode);
    const { caption, sub } = circleCaption(label, o.punchMode);
    return { label, d, caption, sub };
  });

  sections.push({ title: "Circles", y_mm: CONTENT_TOP_MM - 3 });
  const circleFlow = flowRows(
    circles,
    (c) => ({ w: c.d, h: c.d + CAPTION_MM }),
    CONTENT_W_MM,
    CONTENT_TOP_MM,
  );
  for (const p of alignBaseline(circleFlow.placed, (c) => c.d + CAPTION_MM)) {
    shapes.push({
      kind: "circle",
      x_mm: MARGIN_MM + p.x,
      y_mm: p.y,
      d_mm: p.item.d,
      caption: p.item.caption,
      sub: p.item.sub,
    });
  }

  // ---- squares
  const squaresTop = circleFlow.bottom + SECTION_GAP_MM;
  sections.push({ title: "Squares", y_mm: squaresTop - 3 });
  const squareFlow = flowRows(
    [...SQUARE_SIZES_MM],
    (s) => ({ w: s, h: s + CAPTION_MM }),
    CONTENT_W_MM,
    squaresTop,
  );
  for (const p of alignBaseline(squareFlow.placed, (s) => s + CAPTION_MM)) {
    shapes.push({
      kind: "square",
      x_mm: MARGIN_MM + p.x,
      y_mm: p.y,
      s_mm: p.item,
      caption: `${p.item} mm`,
    });
  }

  let bottom = squareFlow.bottom;

  // ---- the size the user actually asked about
  if (o.custom && o.custom.diameter_mm > 0) {
    const wanted = o.custom.diameter_mm;
    const label = Math.min(wanted, MAX_CUSTOM_MM);
    if (label < wanted) {
      warnings.push(
        `${round(wanted, 2)} mm is wider than the card, so the custom circle was drawn at ${label} mm.`,
      );
    }
    const d = drawnDiameter(label, o.punchMode);
    const { caption, sub } = circleCaption(label, o.punchMode);
    const n = o.custom.row ? CUSTOM_ROW_COUNT : 1;

    const customTop = bottom + SECTION_GAP_MM;
    sections.push({
      title: o.custom.row ? `Your size — row of ${n}` : "Your size",
      y_mm: customTop - 3,
    });
    const customFlow = flowRows(
      Array.from({ length: n }, (_, i) => i),
      () => ({ w: d, h: d + CAPTION_MM }),
      CONTENT_W_MM,
      customTop,
    );
    for (const p of customFlow.placed) {
      shapes.push({
        kind: "circle",
        x_mm: MARGIN_MM + p.x,
        y_mm: p.y,
        d_mm: d,
        caption,
        sub,
      });
    }
    bottom = customFlow.bottom;
  }

  // The note floats under the shapes, but never past the calibration block.
  const noteY = Math.min(bottom + NOTE_GAP_MM, NOTE_MAX_Y_MM);
  if (bottom + NOTE_GAP_MM > NOTE_MAX_Y_MM) {
    warnings.push(
      "The shapes overflow the page. Turn off the row of six, or use a smaller custom size.",
    );
  }

  return {
    shapes,
    sections,
    contentBottom_mm: round(bottom, 3),
    noteY_mm: round(noteY, 3),
    inchBarY_mm: INCH_BAR_Y_MM,
    rulerY_mm: RULER_Y_MM,
    warnings,
  };
};

export const generateReferenceCard = async (
  o: RefCardOptions,
): Promise<{ bytes: Uint8Array; plan: RefCardPlan }> => {
  const plan = buildRefCardPlan(o);

  const pdf = await PDFDocument.create();
  pdf.setTitle("Cut Sheet — scale reference card");
  pdf.setProducer("Cut Sheet");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([mmToPt(A4.w_mm), mmToPt(A4.h_mm)]);
  const d = makeDraw(page, A4.h_mm);

  // ---- header
  d.text(o.title ?? "Scale reference card", MARGIN_MM, 16, bold, 14);
  d.text('PRINT AT 100% / ACTUAL SIZE - turn off "Fit to page"', MARGIN_MM, 22.5, bold, 9, ALARM);
  d.text(PRINT_AT_100, MARGIN_MM, 27.5, font, 7, MUTED);

  // ---- shapes
  for (const s of plan.sections) {
    d.text(s.title.toUpperCase(), MARGIN_MM, s.y_mm, bold, 7, MUTED);
  }

  for (const s of plan.shapes) {
    if (s.kind === "circle") {
      // Outline only, hairline — ink spread would defeat the whole exercise.
      d.path(shapeSvgPath("circle", s.x_mm, s.y_mm, s.d_mm, s.d_mm), INK, 0.25);
      d.textCentered(s.caption, s.x_mm + s.d_mm / 2, s.y_mm + s.d_mm + 3.2, font, 6.5);
      if (s.sub) {
        d.textCentered(s.sub, s.x_mm + s.d_mm / 2, s.y_mm + s.d_mm + 6, font, 5.5, MUTED);
      }
      // A centre cross gives you something to line the punch up against.
      const cx = s.x_mm + s.d_mm / 2;
      const cy = s.y_mm + s.d_mm / 2;
      d.line(cx - 1.2, cy, cx + 1.2, cy, 0.2, HAIRLINE);
      d.line(cx, cy - 1.2, cx, cy + 1.2, 0.2, HAIRLINE);
    } else {
      d.path(shapeSvgPath("rect", s.x_mm, s.y_mm, s.s_mm, s.s_mm), INK, 0.25);
      d.textCentered(s.caption, s.x_mm + s.s_mm / 2, s.y_mm + s.s_mm + 3.2, font, 6.5);
    }
  }

  // ---- the punch note, which is the bit people get wrong
  const noteY = plan.noteY_mm;
  d.text("PUNCH BLEED", MARGIN_MM, noteY, bold, 7, MUTED);
  d.text(
    `Print the circle ${PUNCH_BLEED_MM} mm larger than your punch. A 12 mm punch on a 12 mm printed circle`,
    MARGIN_MM,
    noteY + 4.5,
    font,
    7,
  );
  d.text(
    "leaves a white rim if you are even slightly off centre; on a 12.5 mm circle the punch lands inside the ink every time.",
    MARGIN_MM,
    noteY + 8.2,
    font,
    7,
  );
  if (o.punchMode) {
    d.text(
      `Punch mode is on: each circle is labelled by the punch it suits and drawn ${PUNCH_BLEED_MM} mm larger.`,
      MARGIN_MM,
      noteY + 11.9,
      bold,
      7,
      ALARM,
    );
  }

  // ---- calibration furniture
  drawInchBar(d, font, MARGIN_MM, plan.inchBarY_mm);
  drawRuler100(d, font, MARGIN_MM, RULER_Y_MM, 20);
  d.text(
    "Measure the 100 mm ruler. If it isn't 100 mm, your printer is scaling.",
    MARGIN_MM,
    RULER_Y_MM + 12,
    bold,
    7.5,
  );
  d.text(RULER_CHECK, MARGIN_MM, RULER_Y_MM + 16, font, 6, MUTED);
  d.text(
    `1 inch = ${MM_PER_INCH} mm exactly. Cut Sheet — scale reference card.`,
    MARGIN_MM,
    RULER_Y_MM + 20,
    font,
    6,
    MUTED,
  );

  for (const [i, w] of plan.warnings.entries()) {
    d.text(w, MARGIN_MM, noteY - 6 - i * 4, font, 7, ALARM);
  }

  return { bytes: await pdf.save(), plan };
};
