import {
  PDFDocument,
  StandardFonts,
  clip,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import type { PDFEmbeddedPage, PDFFont, PDFImage } from "pdf-lib";
import { A4, mmToPt, round } from "./units";
import {
  ALARM,
  GUIDE,
  MUTED,
  PRINT_AT_100,
  RULER_CHECK,
  drawRuler100,
  makeDraw,
} from "./pdfDraw";
import type { Draw } from "./pdfDraw";
import { dpiBand } from "./sheetSizer";
import type { SizerPlan, Tile } from "./sheetSizer";

/**
 * X5 — the scaled PDF.
 *
 * The artwork is drawn at exactly the size the measurement says it is. Nothing
 * downstream re-derives it, and nothing here rounds to a convenient number.
 */

export type SizerSource =
  | { kind: "image"; bytes: Uint8Array; mime: string }
  /** A PDF already carries real units, so its page is embedded as vector. */
  | { kind: "pdf"; bytes: Uint8Array; pageIndex?: number };

export type SizerPdfOptions = {
  source: SizerSource;
  plan: SizerPlan;
  name: string;
  /** Print the 100 mm rule, so the printed result checks itself. */
  ruler: boolean;
  /** Draw the trim line where the next tile starts overlapping. */
  overlapGuides?: boolean;
  measurement?: { measured_px: number; target_mm: number };
  /** Effective dpi, reported in the footer so a soft print is not a surprise. */
  dpi?: number;
};

/** Last baseline that still lands on the page. */
const BOTTOM_LIMIT_MM = 295;

/** Clip to a millimetre rectangle, run `body`, then restore. */
const clipped = (
  d: Draw,
  x: number,
  y: number,
  w: number,
  h: number,
  body: () => void,
): void => {
  const x0 = mmToPt(x);
  const x1 = mmToPt(x + w);
  const y0 = d.yUp(y + h);
  const y1 = d.yUp(y);
  d.page.pushOperators(
    pushGraphicsState(),
    moveTo(x0, y0),
    lineTo(x1, y0),
    lineTo(x1, y1),
    lineTo(x0, y1),
    clip(),
    endPath(),
  );
  body();
  d.page.pushOperators(popGraphicsState());
};

/** The artwork's footprint on the page, after any 90-degree turn. */
export const pageBox = (plan: SizerPlan): { w_mm: number; h_mm: number } =>
  plan.rotated ? { w_mm: plan.h_mm, h_mm: plan.w_mm } : { w_mm: plan.w_mm, h_mm: plan.h_mm };

/**
 * Where a tile's window sits on its sheet.
 *
 * One sheet centres the artwork in the printable box — you are going to trim it
 * out by hand, so even margins help. Tiles pin to the top-left corner instead,
 * because the sheets have to butt together.
 */
export const tileWindow = (
  tile: Tile,
  plan: SizerPlan,
): { x_mm: number; y_mm: number; w_mm: number; h_mm: number } => {
  const m = plan.margin_mm;
  if (plan.sheets === 1) {
    const box = pageBox(plan);
    // "One sheet" on artwork that does not fit one sheet is a real choice — it
    // gives you the middle of the sheet at true size. Clamping to the printable
    // box keeps the ruler and the warning readable instead of printing over
    // them, which is the only way you would find out it did not fit.
    const w = Math.min(box.w_mm, plan.printable.w_mm);
    const h = Math.min(box.h_mm, plan.printable.h_mm);
    return {
      x_mm: round(m + (plan.printable.w_mm - w) / 2, 4),
      y_mm: round(m + (plan.printable.h_mm - h) / 2, 4),
      w_mm: round(w, 4),
      h_mm: round(h, 4),
    };
  }
  return { x_mm: m, y_mm: m, w_mm: tile.sw_mm, h_mm: tile.sh_mm };
};

const drawFooter = (
  d: Draw,
  font: PDFFont,
  bold: PDFFont,
  o: SizerPdfOptions,
  tile: Tile,
): void => {
  const { plan } = o;
  const m = plan.margin_mm;
  const w = A4.w_mm - 2 * m;

  if (o.ruler) {
    drawRuler100(d, font, m, 270, 20);
    d.text(RULER_CHECK, m, 280, font, 5.5, MUTED);
  }

  d.text(PRINT_AT_100, m, 283.5, bold, 7);

  const parts = [
    o.name || "Sheet",
    plan.sheets > 1
      ? `sheet ${tile.sheet} of ${plan.sheets} - column ${tile.col + 1}, row ${tile.row + 1}`
      : "one sheet",
    `${round(plan.w_mm, 1)} x ${round(plan.h_mm, 1)} mm`,
  ];
  if (plan.rotated) parts.push("turned 90 degrees to fit");
  if (plan.mode === "fit") parts.push(`SCALED TO ${round(plan.scale * 100, 1)}% - NOT TRUE SIZE`);
  if (o.dpi) parts.push(`${Math.round(o.dpi)} dpi`);
  if (o.measurement) {
    parts.push(
      `measured ${round(o.measurement.measured_px, 0)} px = ${round(o.measurement.target_mm, 2)} mm`,
    );
  }
  const tone = plan.mode === "fit" ? ALARM : MUTED;
  let y = d.paragraph(parts.join("  ·  "), m, 287, w, font, 6.5, tone) + 0.6;

  if (o.dpi && dpiBand(o.dpi) === "red") {
    y = d.paragraph(
      `Effective resolution is ${Math.round(o.dpi)} dpi - under 200 dpi this will look soft in print.`,
      m,
      y,
      w,
      bold,
      6,
      ALARM,
      3,
    );
  }
  for (const warning of plan.warnings) {
    // The page ends at 297; stop rather than draw off the bottom, where a
    // warning would be worse than useless.
    if (y > BOTTOM_LIMIT_MM) break;
    y = d.paragraph(warning, m, y, w, font, 6, tone, 3);
  }
};

export const generateSizerPdf = async (o: SizerPdfOptions): Promise<Uint8Array> => {
  const { plan } = o;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${o.name || "Sheet"} — Cut Sheet sizer`);
  pdf.setProducer("Cut Sheet");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let image: PDFImage | undefined;
  let embedded: PDFEmbeddedPage | undefined;
  if (o.source.kind === "image") {
    image = /png/i.test(o.source.mime)
      ? await pdf.embedPng(o.source.bytes)
      : await pdf.embedJpg(o.source.bytes);
  } else {
    const pages = await pdf.embedPdf(o.source.bytes, [o.source.pageIndex ?? 0]);
    embedded = pages[0];
  }

  for (const tile of plan.tiles) {
    const page = pdf.addPage([mmToPt(A4.w_mm), mmToPt(A4.h_mm)]);
    const d = makeDraw(page, A4.h_mm);
    const win = tileWindow(tile, plan);

    // Centre of the artwork in page millimetres. One sheet centres it in the
    // printable box; a tile slides it so that this tile's region lands in the
    // window.
    const box = pageBox(plan);
    const cx =
      plan.sheets === 1
        ? plan.margin_mm + plan.printable.w_mm / 2
        : win.x_mm - tile.sx_mm + box.w_mm / 2;
    const cy =
      plan.sheets === 1
        ? plan.margin_mm + plan.printable.h_mm / 2
        : win.y_mm - tile.sy_mm + box.h_mm / 2;

    clipped(d, win.x_mm, win.y_mm, win.w_mm, win.h_mm, () => {
      // Rotation turns the footprint, so draw at the artwork's own w/h about
      // that centre and let d.image place it.
      const x = cx - plan.w_mm / 2;
      const y = cy - plan.h_mm / 2;
      if (image) {
        d.image(image, x, y, plan.w_mm, plan.h_mm, plan.rotated ? 90 : 0);
      } else if (embedded) {
        // drawPage has no centre-rotation helper, so an unrotated draw is the
        // only faithful one; planOutput never rotates a tiled plan.
        page.drawPage(embedded, {
          x: mmToPt(x),
          y: d.yUp(y + plan.h_mm),
          width: mmToPt(plan.w_mm),
          height: mmToPt(plan.h_mm),
        });
      }
    });

    // Trim box: where the artwork actually ends.
    const dash = [1.5, 1.5];
    d.line(win.x_mm, win.y_mm, win.x_mm + win.w_mm, win.y_mm, 0.25, MUTED, dash);
    d.line(win.x_mm, win.y_mm + win.h_mm, win.x_mm + win.w_mm, win.y_mm + win.h_mm, 0.25, MUTED, dash);
    d.line(win.x_mm, win.y_mm, win.x_mm, win.y_mm + win.h_mm, 0.25, MUTED, dash);
    d.line(win.x_mm + win.w_mm, win.y_mm, win.x_mm + win.w_mm, win.y_mm + win.h_mm, 0.25, MUTED, dash);

    if (o.overlapGuides !== false && plan.sheets > 1) {
      // Trim on this line and butt the next sheet against it.
      const lastCol = tile.sx_mm + tile.sw_mm >= plan.w_mm - 1e-6;
      const lastRow = tile.sy_mm + tile.sh_mm >= plan.h_mm - 1e-6;
      if (!lastCol) {
        const x = win.x_mm + win.w_mm - plan.overlap_mm;
        d.line(x, win.y_mm, x, win.y_mm + win.h_mm, 0.3, GUIDE, [2, 2]);
      }
      if (!lastRow) {
        const y = win.y_mm + win.h_mm - plan.overlap_mm;
        d.line(win.x_mm, y, win.x_mm + win.w_mm, y, 0.3, GUIDE, [2, 2]);
      }
    }

    drawFooter(d, font, bold, o, tile);
  }

  return pdf.save();
};
