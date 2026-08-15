import {
  PDFDocument,
  StandardFonts,
  radians,
  rgb,
} from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import type { PrintItem, Project, SheetPlacement, Slot } from "../types";
import { templateById } from "../data/layouts";
import { formatById } from "../data/formats";
import { A4, mmToPt } from "./units";
import { contentArea, defaultPackOptions, pack, toPackUnits } from "./packer";
import type { PackOptions, PackResult } from "./packer";
import { effectiveGap, printedSize } from "./printItems";
import { rasterizeItem } from "./raster";
import type { Source } from "./raster";
import { rectSvgPath, shapeSvgPath } from "./pdfPaths";

/**
 * PDF output.
 *
 * Every photo is drawn as an axis-aligned image box sized in exact millimetres,
 * so dimensional accuracy does not depend on anything the PDF viewer decides.
 * The 100 mm calibration ruler on every sheet is the check: print dialogs
 * default to fit-to-page and quietly scale by about 4%.
 */

const DEG = Math.PI / 180;

const INK = rgb(0.09, 0.1, 0.12);
const MUTED = rgb(0.45, 0.47, 0.5);
const HAIRLINE = rgb(0.62, 0.64, 0.67);
const GUIDE = rgb(0.55, 0.35, 0.75);

const PLAN_MARGIN_MM = 10;
/** Clear of the plan's title block, and of each spread's own caption above it. */
const PLAN_TOP_MM = 28;
const PLAN_FOOTER_MM = 22;
const PLAN_GAP_MM = 10;

/** Helpers that let the whole file think in millimetres, top-left origin. */
const makeDraw = (page: PDFPage, pageH_mm: number) => {
  const yUp = (y_mm: number) => mmToPt(pageH_mm - y_mm);

  return {
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
    fillRect(x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>, opacity = 1) {
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
    image(
      img: PDFImage,
      x: number,
      y: number,
      w: number,
      h: number,
      rotation_deg = 0,
    ) {
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
    path(
      d: string,
      color: ReturnType<typeof rgb>,
      thickness = 0.4,
      dash?: number[],
    ) {
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

type Draw = ReturnType<typeof makeDraw>;

export type RasterizeFn = typeof rasterizeItem;

export type GenerateOptions = {
  project: Project;
  items: PrintItem[];
  sources: Map<string, Source>;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Injectable so the dimensional-accuracy test can run without a canvas. */
  rasterize?: RasterizeFn;
};

export type GenerateResult = {
  bytes: Uint8Array;
  packResult: PackResult;
  photos: number;
  sheets: number;
  coverage: number;
  unplaceable: PrintItem[];
};

/** Pack the project's print items onto A4, honouring gap and bleed. */
export const packProject = (
  items: PrintItem[],
  gap_mm: number,
  bleed_mm: number,
  allowRotate: boolean,
): { result: PackResult; options: PackOptions } => {
  const gap = effectiveGap(gap_mm, bleed_mm);
  const options = defaultPackOptions(gap, allowRotate);
  const printed = items.map((i) => {
    const s = printedSize(i, bleed_mm);
    return { ...i, w_mm: s.w, h_mm: s.h };
  });
  return { result: pack(toPackUnits(printed), options), options };
};

const drawFooterRule = (
  d: Draw,
  font: PDFFont,
  bold: PDFFont,
  right: string[],
): void => {
  // Instruction line.
  d.text(
    'Print at 100% / Actual Size. Turn off "Fit to page" and "Shrink oversized pages".',
    5,
    281.5,
    bold,
    7.5,
  );

  // 100 mm calibration ruler. Not optional — it is the whole product.
  const y0 = 285;
  d.line(5, y0, 105, y0, 0.5, INK);
  for (let mm = 0; mm <= 100; mm += 1) {
    const major = mm % 50 === 0;
    const mid = mm % 10 === 0;
    const len = major ? 3 : mid ? 2.2 : 1.1;
    d.line(5 + mm, y0, 5 + mm, y0 + len, major ? 0.5 : 0.25, major ? INK : MUTED);
  }
  for (const mm of [0, 50, 100]) {
    const label = `${mm}`;
    const w = font.widthOfTextAtSize(label, 6);
    d.text(label, 5 + mm - w / mmToPt(1) / 2, 291.5, font, 6, MUTED);
  }
  d.text("mm", 107, 288.5, font, 6, MUTED);

  d.text(
    "If this ruler does not measure exactly 100.0 mm, your printer scaled the page. Reprint at 100%.",
    5,
    294.5,
    font,
    6,
    MUTED,
  );

  let y = 284;
  for (const lineText of right) {
    d.text(lineText, 118, y, font, 6.5, MUTED);
    y += 3.6;
  }
};

const drawCropMarks = (
  d: Draw,
  rows: Array<{ top: number; bottom: number; xs: number[] }>,
): void => {
  const cuts = new Set<number>();
  for (const r of rows) {
    cuts.add(Math.round(r.top * 100) / 100);
    cuts.add(Math.round(r.bottom * 100) / 100);
  }

  // Full-width lanes: ticks in the sheet margin, clear of every photo.
  for (const y of cuts) {
    d.line(1, y, 4.2, y, 0.4, INK);
    d.line(A4.w_mm - 4.2, y, A4.w_mm - 1, y, 0.4, INK);
  }

  // Vertical cuts inside a row: short ticks sitting on the cut line itself,
  // where the blade removes them.
  for (const r of rows) {
    for (const x of r.xs) {
      d.line(x, r.top, x, r.top + 1.6, 0.3, INK);
      d.line(x, r.bottom - 1.6, x, r.bottom, 0.3, INK);
    }
  }
};

type PlacedBox = {
  placement: SheetPlacement;
  item: PrintItem;
  x: number;
  y: number;
  w: number;
  h: number;
};

const rowsFromBoxes = (boxes: PlacedBox[]): Array<{ top: number; bottom: number; xs: number[] }> => {
  const byTop = new Map<number, PlacedBox[]>();
  for (const b of boxes) {
    const key = Math.round(b.y * 100) / 100;
    byTop.set(key, [...(byTop.get(key) ?? []), b]);
  }
  return [...byTop.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([top, list]) => {
      const bottom = top + Math.max(...list.map((b) => b.h));
      const xs = new Set<number>();
      for (const b of list) {
        xs.add(Math.round(b.x * 100) / 100);
        xs.add(Math.round((b.x + b.w) * 100) / 100);
      }
      return { top, bottom, xs: [...xs].sort((a, b) => a - b) };
    });
};

const drawIdLabel = (
  d: Draw,
  font: PDFFont,
  label: string,
  box: PlacedBox,
  gap_mm: number,
): void => {
  if (gap_mm >= 2.5) {
    // There is a real gutter — put the label in it.
    d.text(label, box.x + 0.3, box.y - 0.7, font, 5, MUTED);
    return;
  }
  // No gutter: a small chip in the corner, where trim usually goes.
  const w = font.widthOfTextAtSize(label, 5) / mmToPt(1) + 1.4;
  d.fillRect(box.x + 0.3, box.y + 0.3, w, 2.6, rgb(1, 1, 1), 0.82);
  d.text(label, box.x + 1, box.y + 2.4, font, 5, INK);
};

/** Slot outline plus P-ID, drawn at actual size on the layout plan. */
const drawPlanSlot = (
  d: Draw,
  font: PDFFont,
  originX: number,
  originY: number,
  slot: Slot,
  item: PrintItem | undefined,
  thumb: PDFImage | undefined,
): void => {
  const x = originX + slot.x_mm;
  const y = originY + slot.y_mm;

  if (thumb) {
    d.image(thumb, x, y, slot.w_mm, slot.h_mm, slot.rotation_deg);
  }
  d.path(
    shapeSvgPath(item?.shape ?? slot.shape, x, y, slot.w_mm, slot.h_mm, slot.rotation_deg),
    thumb ? HAIRLINE : MUTED,
    0.4,
    thumb ? undefined : [2, 2],
  );

  if (item) {
    const label = item.copies > 1 ? `${item.label} x${item.copies}` : item.label;
    const w = font.widthOfTextAtSize(label, 6) / mmToPt(1) + 2;
    const cx = x + slot.w_mm / 2;
    const cy = y + slot.h_mm / 2;
    d.fillRect(cx - w / 2, cy - 1.9, w, 3.8, rgb(1, 1, 1), 0.85);
    d.text(label, cx - w / 2 + 1, cy + 1.2, font, 6, INK);
  } else {
    const label = "empty";
    const w = font.widthOfTextAtSize(label, 5.5) / mmToPt(1);
    d.text(label, x + slot.w_mm / 2 - w / 2, y + slot.h_mm / 2 + 1, font, 5.5, MUTED);
  }
};

export const generatePdf = async (o: GenerateOptions): Promise<GenerateResult> => {
  const { project, items, sources } = o;
  const rasterize = o.rasterize ?? rasterizeItem;
  const { gap_mm, bleed_mm, allowRotate, cropMarks, idLabels, shapeGuides } =
    project.settings;
  const gap = effectiveGap(gap_mm, bleed_mm);

  const { result, options } = packProject(items, gap_mm, bleed_mm, allowRotate);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const area = contentArea(options);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${project.name} — Cut Sheet`);
  pdf.setProducer("Cut Sheet");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const totalWork = items.length * 2 + result.sheets + 1;
  let done = 0;
  const tick = (label: string) => {
    done += 1;
    o.onProgress?.(done, totalWork, label);
  };

  // ---- Rasterise every photo once, at print resolution and again for the plan.
  const printImages = new Map<string, PDFImage>();
  const planImages = new Map<string, PDFImage>();

  for (const item of items) {
    const src = sources.get(item.assetId);
    if (!src) {
      tick(`Skipped ${item.label} — photo missing`);
      tick(`Skipped ${item.label}`);
      continue;
    }
    const full = await rasterize(src, {
      crop: item.crop,
      rotation: item.rotation,
      straighten_deg: item.straighten_deg,
      shape: item.shape,
      w_mm: item.w_mm,
      h_mm: item.h_mm,
      bleed_mm,
    });
    printImages.set(item.id, await pdf.embedJpg(full.bytes));
    tick(`Rendered ${item.label}`);

    const small = await rasterize(src, {
      crop: item.crop,
      rotation: item.rotation,
      straighten_deg: item.straighten_deg,
      shape: item.shape,
      w_mm: item.w_mm,
      h_mm: item.h_mm,
      bleed_mm: 0,
      dpi: 60,
      quality: 0.7,
    });
    planImages.set(item.id, await pdf.embedJpg(small.bytes));
    tick(`Plan thumbnail ${item.label}`);
  }

  const photos = items.reduce((n, i) => n + Math.max(1, i.copies), 0);
  const coveragePct = (result.coverage * 100).toFixed(1);

  // ---- Page 1 onwards: the layout plan, spreads at actual size.
  const planUnits = project.spreads
    .map((s) => {
      const t = templateById(s.templateId);
      const f = t ? formatById(t.formatId) : undefined;
      return t && f ? { itemId: s.id, copy: 1, w_mm: f.w_mm, h_mm: f.h_mm } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const planOptions: PackOptions = {
    sheetW_mm: A4.w_mm,
    sheetH_mm: A4.h_mm,
    margin_mm: PLAN_MARGIN_MM,
    top_mm: PLAN_TOP_MM,
    footer_mm: PLAN_FOOTER_MM,
    gap_mm: PLAN_GAP_MM,
    allowRotate: false,
  };
  const planPack = pack(planUnits, planOptions);
  const planSheets = Math.max(1, planPack.sheets);

  for (let s = 1; s <= planSheets; s++) {
    const page = pdf.addPage([mmToPt(A4.w_mm), mmToPt(A4.h_mm)]);
    const d = makeDraw(page, A4.h_mm);

    d.text(project.name || "Cut Sheet", PLAN_MARGIN_MM, 14, bold, 13);
    d.text(
      `Layout plan — where each photo goes. Shown at actual size.${
        planSheets > 1 ? `  Plan page ${s} of ${planSheets}` : ""
      }`,
      PLAN_MARGIN_MM,
      19,
      font,
      8,
      MUTED,
    );

    for (const p of planPack.placements.filter((x) => x.sheet === s)) {
      const spread = project.spreads.find((x) => x.id === p.itemId);
      const template = spread ? templateById(spread.templateId) : undefined;
      const fmt = template ? formatById(template.formatId) : undefined;
      if (!spread || !template || !fmt) continue;

      const idx = project.spreads.indexOf(spread) + 1;
      d.text(
        `Spread ${idx} · ${fmt.name} · ${template.name} · ${fmt.w_mm} x ${fmt.h_mm} mm`,
        p.x_mm,
        p.y_mm - 1.8,
        font,
        6.5,
        MUTED,
      );
      d.path(rectSvgPath(p.x_mm, p.y_mm, fmt.w_mm, fmt.h_mm), INK, 0.6);

      for (const slot of template.slots) {
        const item = items.find(
          (i) => i.fromSpread === spread.id && i.fromSlot === slot.id,
        );
        drawPlanSlot(
          d,
          font,
          p.x_mm,
          p.y_mm,
          slot,
          item,
          item ? planImages.get(item.id) : undefined,
        );
      }
    }

    if (s === planSheets) {
      const unplaceableCount = result.unplaceable.length;
      d.text("Report", PLAN_MARGIN_MM, 279, bold, 8);
      d.text(
        `${photos} photo${photos === 1 ? "" : "s"} across ${
          project.spreads.length
        } spread${project.spreads.length === 1 ? "" : "s"}  ·  ${
          result.sheets
        } A4 sheet${result.sheets === 1 ? "" : "s"}  ·  ${coveragePct}% coverage  ·  gap ${gap} mm  ·  bleed ${bleed_mm} mm  ·  rotation ${
          allowRotate ? "on" : "off"
        }`,
        PLAN_MARGIN_MM,
        284,
        font,
        7.5,
      );
      d.text(
        unplaceableCount > 0
          ? `${unplaceableCount} photo${
              unplaceableCount === 1 ? " is" : "s are"
            } larger than one A4 sheet and could not be placed.`
          : "Cut order: make the full-width horizontal cuts first, then the verticals within each strip.",
        PLAN_MARGIN_MM,
        289,
        font,
        7.5,
        unplaceableCount > 0 ? rgb(0.75, 0.2, 0.2) : MUTED,
      );
    }
    tick(`Layout plan page ${s}`);
  }

  // ---- The cut sheets.
  for (let sheet = 1; sheet <= result.sheets; sheet++) {
    const page = pdf.addPage([mmToPt(A4.w_mm), mmToPt(A4.h_mm)]);
    const d = makeDraw(page, A4.h_mm);

    const boxes: PlacedBox[] = [];
    for (const p of result.placements.filter((x) => x.sheet === sheet)) {
      const item = itemById.get(p.itemId);
      if (!item) continue;
      const printed = printedSize(item, bleed_mm);
      boxes.push({
        placement: p,
        item,
        x: p.x_mm,
        y: p.y_mm,
        w: p.rotated ? printed.h : printed.w,
        h: p.rotated ? printed.w : printed.h,
      });
    }

    for (const b of boxes) {
      const img = printImages.get(b.item.id);
      if (!img) continue;
      const printed = printedSize(b.item, bleed_mm);
      // The image box is always exactly the printed size in millimetres.
      d.image(
        img,
        b.placement.rotated ? b.x + (b.w - printed.w) / 2 : b.x,
        b.placement.rotated ? b.y + (b.h - printed.h) / 2 : b.y,
        printed.w,
        printed.h,
        b.placement.rotated ? 90 : 0,
      );
    }

    if (shapeGuides) {
      for (const b of boxes) {
        if (b.item.shape === "rect") continue;
        // Build the shape at its own finished size and let the rotation put it
        // on the sheet — swapping the dimensions as well would rotate it twice.
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        d.path(
          shapeSvgPath(
            b.item.shape,
            cx - b.item.w_mm / 2,
            cy - b.item.h_mm / 2,
            b.item.w_mm,
            b.item.h_mm,
            b.placement.rotated ? 90 : 0,
          ),
          GUIDE,
          0.4,
          [1.6, 1.6],
        );
      }
    }

    if (cropMarks) drawCropMarks(d, rowsFromBoxes(boxes));

    if (idLabels) {
      for (const b of boxes) {
        const label =
          b.item.copies > 1 ? `${b.item.label}.${b.placement.copy}` : b.item.label;
        drawIdLabel(d, font, label, b, gap);
      }
    }

    if (bleed_mm > 0) {
      // With overprint each edge needs its own cut: show the finished box.
      for (const b of boxes) {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        d.path(
          rectSvgPath(
            cx - b.item.w_mm / 2,
            cy - b.item.h_mm / 2,
            b.item.w_mm,
            b.item.h_mm,
            b.placement.rotated ? 90 : 0,
          ),
          GUIDE,
          0.3,
          [1, 1.5],
        );
      }
    }

    const sheetItems = boxes.length;
    const usedArea = boxes.reduce((n, b) => n + b.w * b.h, 0);
    const sheetCoverage = ((usedArea / (area.w * area.h)) * 100).toFixed(1);

    drawFooterRule(d, font, bold, [
      `${project.name || "Cut Sheet"} — sheet ${sheet} of ${result.sheets}`,
      `${sheetItems} photo${sheetItems === 1 ? "" : "s"} on this sheet · ${sheetCoverage}% coverage`,
      `Gap ${gap} mm · rotation ${allowRotate ? "on" : "off"} · ${photos} photos total`,
    ]);

    tick(`Sheet ${sheet}`);
  }

  const bytes = await pdf.save();

  return {
    bytes,
    packResult: result,
    photos,
    sheets: result.sheets,
    coverage: result.coverage,
    unplaceable: result.unplaceable
      .map((u) => itemById.get(u.itemId))
      .filter((i): i is PrintItem => Boolean(i)),
  };
};
