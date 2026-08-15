import type { PrintItem, SheetPlacement } from "../types";
import { A4 } from "./units";

/**
 * Shelf packing, because the tool is a guillotine.
 *
 * Items are packed into full-width rows. Each row boundary is one clean
 * horizontal cut across the whole sheet; within a row the cuts are straight
 * verticals. Anything cleverer (skyline, maxrects) packs tighter but produces
 * cuts you cannot physically make.
 *
 * Gap defaults to 0: one cut gives two finished edges.
 */

/** Bottom band reserved on every sheet for the calibration ruler and footer. */
export const FOOTER_BAND_MM = 18;
export const SHEET_MARGIN_MM = 5;

export type PackOptions = {
  sheetW_mm: number;
  sheetH_mm: number;
  margin_mm: number;
  footer_mm: number;
  gap_mm: number;
  allowRotate: boolean;
};

export const defaultPackOptions = (
  gap_mm: number,
  allowRotate: boolean,
): PackOptions => ({
  sheetW_mm: A4.w_mm,
  sheetH_mm: A4.h_mm,
  margin_mm: SHEET_MARGIN_MM,
  footer_mm: FOOTER_BAND_MM,
  gap_mm,
  allowRotate,
});

export type PackUnit = {
  itemId: string;
  copy: number;
  w_mm: number;
  h_mm: number;
};

export type ContentArea = { x: number; y: number; w: number; h: number };

export type PackResult = {
  placements: SheetPlacement[];
  sheets: number;
  unplaceable: PackUnit[];
  /** Fraction 0..1 of usable sheet area covered by photos. */
  coverage: number;
  area: ContentArea;
};

export const contentArea = (o: PackOptions): ContentArea => ({
  x: o.margin_mm,
  y: o.margin_mm,
  w: o.sheetW_mm - 2 * o.margin_mm,
  h: o.sheetH_mm - o.margin_mm - o.footer_mm,
});

/** Expand every PrintItem into one pack unit per copy. */
export const toPackUnits = (items: PrintItem[]): PackUnit[] => {
  const out: PackUnit[] = [];
  for (const it of items) {
    for (let c = 1; c <= Math.max(1, it.copies); c++) {
      out.push({ itemId: it.id, copy: c, w_mm: it.w_mm, h_mm: it.h_mm });
    }
  }
  return out;
};

type Shelf = {
  sheet: number;
  y: number;
  height: number;
  usedW: number;
};

const EPS = 1e-6;

export const pack = (units: PackUnit[], o: PackOptions): PackResult => {
  const area = contentArea(o);
  const gap = o.gap_mm;

  const unplaceable: PackUnit[] = [];
  const placeable: PackUnit[] = [];

  for (const u of units) {
    const fitsNatural = u.w_mm <= area.w + EPS && u.h_mm <= area.h + EPS;
    const fitsRotated =
      o.allowRotate && u.h_mm <= area.w + EPS && u.w_mm <= area.h + EPS;
    if (fitsNatural || fitsRotated) placeable.push(u);
    else unplaceable.push(u);
  }

  /**
   * Shelf height is what costs vertical space, so lay each item down (short
   * side vertical) when rotation is allowed, then sort by that height
   * descending — first-fit decreasing height.
   */
  const shelfHeightOf = (u: PackUnit): number =>
    o.allowRotate ? Math.min(u.w_mm, u.h_mm) : u.h_mm;

  const sorted = [...placeable].sort((a, b) => {
    const d = shelfHeightOf(b) - shelfHeightOf(a);
    if (Math.abs(d) > EPS) return d;
    return Math.max(b.w_mm, b.h_mm) - Math.max(a.w_mm, a.h_mm);
  });

  const shelves: Shelf[] = [];
  const placements: SheetPlacement[] = [];
  let sheets = 0;
  let nextShelfY = 0;

  /** Orientations this unit may be placed in, natural first. */
  const orientations = (u: PackUnit): Array<{ w: number; h: number; rotated: boolean }> => {
    const list = [{ w: u.w_mm, h: u.h_mm, rotated: false }];
    if (o.allowRotate && Math.abs(u.w_mm - u.h_mm) > EPS) {
      list.push({ w: u.h_mm, h: u.w_mm, rotated: true });
    }
    return list;
  };

  const openShelf = (u: PackUnit): Shelf | null => {
    // Prefer the orientation that makes the shortest shelf but still fits width.
    const opts = orientations(u)
      .filter((op) => op.w <= area.w + EPS && op.h <= area.h + EPS)
      .sort((a, b) => a.h - b.h);
    if (opts.length === 0) return null;
    const height = opts[0].h;

    if (sheets === 0 || nextShelfY + height > area.h + EPS) {
      sheets += 1;
      nextShelfY = 0;
    }
    const shelf: Shelf = { sheet: sheets, y: nextShelfY, height, usedW: 0 };
    shelves.push(shelf);
    nextShelfY += height + gap;
    return shelf;
  };

  for (const u of sorted) {
    let placed = false;

    // First fit across every open shelf, on any sheet.
    for (const shelf of shelves) {
      const remaining = area.w - shelf.usedW - (shelf.usedW > 0 ? gap : 0);
      const opts = orientations(u)
        .filter((op) => op.h <= shelf.height + EPS && op.w <= remaining + EPS)
        // Tighter first: whichever orientation eats less width.
        .sort((a, b) => a.w - b.w);
      if (opts.length === 0) continue;

      const op = opts[0];
      const x = shelf.usedW > 0 ? shelf.usedW + gap : 0;
      placements.push({
        itemId: u.itemId,
        copy: u.copy,
        sheet: shelf.sheet,
        x_mm: area.x + x,
        y_mm: area.y + shelf.y,
        rotated: op.rotated,
      });
      shelf.usedW = x + op.w;
      placed = true;
      break;
    }

    if (placed) continue;

    const shelf = openShelf(u);
    if (!shelf) {
      unplaceable.push(u);
      continue;
    }
    const op = orientations(u)
      .filter((x) => x.h <= shelf.height + EPS && x.w <= area.w + EPS)
      .sort((a, b) => a.w - b.w)[0];
    placements.push({
      itemId: u.itemId,
      copy: u.copy,
      sheet: shelf.sheet,
      x_mm: area.x,
      y_mm: area.y + shelf.y,
      rotated: op.rotated,
    });
    shelf.usedW = op.w;
  }

  const photoArea = placeable
    .filter((u) => !unplaceable.includes(u))
    .reduce((sum, u) => sum + u.w_mm * u.h_mm, 0);
  const sheetArea = sheets * area.w * area.h;
  const coverage = sheetArea > 0 ? photoArea / sheetArea : 0;

  placements.sort((a, b) => a.sheet - b.sheet || a.y_mm - b.y_mm || a.x_mm - b.x_mm);

  return { placements, sheets, unplaceable, coverage, area };
};
