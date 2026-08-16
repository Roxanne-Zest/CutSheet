import type { CutPathResult, CutPathSettings, Poly } from "./types";
import { buildMask } from "./mask";
import type { Rgba } from "./mask";
import { cleanMask } from "./clean";
import { boundsOf, countNodes, scalePolys, traceMask } from "./trace";
import { simplifyToBudget } from "./simplify";
import { buildBorder } from "./offset";

/**
 * The seven stages, in order, with nothing between them but data.
 *
 * Pure and synchronous: it takes pixels in and gives polygons out, so it runs
 * identically in a Worker, in a test and on the main thread.
 */

/** Move a polygon set so its own top-left sits at the origin. */
export const normalise = (polys: Poly[]): { polys: Poly[]; dx: number; dy: number } => {
  const b = boundsOf(polys);
  const dx = -b.x;
  const dy = -b.y;
  const shift = (r: Poly["outer"]) => r.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  return {
    polys: polys.map((p) => ({ outer: shift(p.outer), holes: p.holes.map(shift) })),
    dx,
    dy,
  };
};

export const runCutPath = (img: Rgba, s: CutPathSettings): CutPathResult => {
  const warnings: string[] = [];

  // 1 — mask
  const masked = buildMask(img, s);
  warnings.push(...masked.warnings);

  // 2 — clean
  const cleaned = cleanMask(masked.mask, s);
  warnings.push(...cleaned.warnings);

  // 3 — trace, in pixels
  const tracedPx = traceMask(cleaned.mask);
  if (tracedPx.length === 0) {
    return {
      polys: [],
      artwork: [],
      mask: cleaned.mask,
      stats: {
        stickers: 0,
        source: masked.source,
        nodes: 0,
        w_mm: 0,
        h_mm: 0,
        tolerance_mm: 0,
        warnings: [
          ...warnings,
          "No artwork found. Adjust Background tolerance until the magenta overlay covers the sticker and nothing else.",
        ],
      },
    };
  }

  // Pixels to millimetres. The width is what the user typed, so the whole
  // downstream pipeline works in real units and the border really is 2 mm.
  const mmPerPx = s.width_mm / img.w;

  // 4 — simplify, in millimetres so the tolerance means something physical
  const simplified = simplifyToBudget(scalePolys(tracedPx, mmPerPx));
  warnings.push(...simplified.warnings);

  // 5 and 6 — border, then make it cuttable
  const border = buildBorder(simplified.polys, s);
  warnings.push(...border.warnings);

  // The budget has to be enforced on the path that actually reaches the
  // plotter. Offsetting and the cuttability pass both add nodes — every round
  // join is an arc — so checking at stage 4 would let a 400-node trace leave
  // here as a 700-node cut. No Chaikin this time: the offset arcs are already
  // smooth, and rounding them again would pull the border in off its 2 mm.
  const budgeted = simplifyToBudget(border.polys, {
    tolerance: simplified.tolerance,
    rounds: 0,
  });
  warnings.push(...budgeted.warnings);

  const b = boundsOf(budgeted.polys.length ? budgeted.polys : simplified.polys);

  return {
    polys: budgeted.polys,
    artwork: simplified.polys,
    mask: cleaned.mask,
    stats: {
      stickers: budgeted.polys.length,
      source: masked.source,
      nodes: countNodes(budgeted.polys),
      w_mm: b.w,
      h_mm: b.h,
      tolerance_mm: budgeted.tolerance,
      warnings,
    },
  };
};

/** `3 stickers · 284 nodes · 48.0 x 52.4 mm` */
export const readout = (r: CutPathResult): string => {
  const { stickers, nodes, w_mm, h_mm } = r.stats;
  return `${stickers} sticker${stickers === 1 ? "" : "s"} found · ${nodes} nodes · ${w_mm.toFixed(1)} × ${h_mm.toFixed(1)} mm`;
};
