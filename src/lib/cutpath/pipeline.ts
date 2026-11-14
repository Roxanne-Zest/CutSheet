import type { CutPathResult, CutPathSettings, Poly } from "./types";
import { buildMask } from "./mask";
import type { Rgba } from "./mask";
import { cleanMask } from "./clean";
import { boundsOf, scalePolys, traceSmooth } from "./trace";
import { simplifyPolys } from "./simplify";
import { fitPolys, flattenPolys } from "./curves";
import { buildBorder } from "./offset";
import { classifyLoss, clearanceNeeded, minGap } from "./gaps";

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

/**
 * Nobody lays stickers out this close on purpose. Below it, the likeliest
 * explanation is not a crowded sheet but a width describing one sticker while
 * the image holds a page of them.
 */
const IMPLAUSIBLE_GAP_MM = 1;

/** Thinning tolerance for the raw trace: under a twentieth of a millimetre. */
const TRACE_TOLERANCE_MM = 0.03;

/** Spacing a real sheet is laid out with, used only to suggest a width. */
const PLAUSIBLE_GAP_MM = 3;

/**
 * Width is set, never inferred — which makes it the one number nothing else
 * can check, and the one whose symptoms all surface somewhere else.
 *
 * Leaving it at the one-sticker default while feeding in a whole sheet scales
 * every gap down with it until the blade radius closes them, and what you see
 * is a welded cut path with nothing wrong upstream: the mask is perfect, the
 * trace is perfect, and no amount of work on the image will help.
 *
 * The gap is the tell. Shape sizes are not — a sheet of pens has shapes that
 * stay plausibly long at any width, because it is their spacing that collapses.
 */
export const widthWarnings = (polys: Poly[], width_mm: number, gap_mm: number): string[] => {
  if (polys.length < 2 || !Number.isFinite(gap_mm) || gap_mm >= IMPLAUSIBLE_GAP_MM) return [];

  // The width that would put these shapes a normal distance apart. A hint at
  // the right order of magnitude, so it is rounded to something typeable.
  const suggestion = Math.round((width_mm * PLAUSIBLE_GAP_MM) / gap_mm / 10) * 10;
  return [
    `These ${polys.length} shapes are ${gap_mm.toFixed(2)} mm apart, which is closer than a sheet is ever laid out. Width says the whole image is ${width_mm} mm across — if that was meant to be one sticker rather than the page they sit on, the page is nearer ${suggestion} mm, and every millimetre below is being measured against the wrong scale.`,
  ];
};

/**
 * What the border did to the sticker count, and why.
 *
 * The border grows every shape and the blade radius closes around it, so two
 * shapes closer than twice their combined reach stop being two shapes. That is
 * a merge, not a disappearance, and the fixes are opposite: a merge wants a
 * smaller border or a truer width, a disappearance wants bigger artwork.
 */
export const crowdingWarnings = (
  before: Poly[],
  after: Poly[],
  gap_mm: number,
  clearance_mm: number,
  s: CutPathSettings,
): string[] => {
  if (before.length === 0 || after.length === 0) return [];

  const out: string[] = [];
  const loss = classifyLoss(before, after);
  const reach = `a ${s.border_mm} mm border needs ${clearance_mm.toFixed(1)} mm between shapes`;

  if (loss.merged > 1) {
    // The largest border that still clears the measured gap, rounded down so
    // the number offered actually works rather than landing on the boundary.
    const safeBorder = Math.floor((gap_mm / 2) * 10) / 10;
    const fix =
      safeBorder > 0
        ? `Drop the border to ${safeBorder.toFixed(1)} mm.`
        : `They are already touching in the artwork — check Width is the width of the whole sheet.`;
    out.push(
      `${loss.merged} shapes merged into ${loss.mergedInto}: ${reach}, and the closest two on this sheet are ${gap_mm.toFixed(1)} mm apart. ${fix}`,
    );
  }

  if (loss.vanished > 0) {
    out.push(
      `${loss.vanished} shape${loss.vanished === 1 ? "" : "s"} disappeared: too small to survive a ${s.border_mm} mm border and a ${s.bladeRadius_mm} mm blade radius.`,
    );
  }

  // Nothing merged, but only just. Worth saying, because the next nudge of the
  // border slider is the one that welds the sheet.
  if (loss.merged === 0 && Number.isFinite(gap_mm) && gap_mm < clearance_mm * 1.25) {
    out.push(
      `Close: ${reach}, and the closest two are ${gap_mm.toFixed(1)} mm apart. A little more border and they will merge into one path.`,
    );
  }

  return out;
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
  // Sub-pixel, so no pixel staircase ever reaches the simplifier.
  const tracedPx = traceSmooth(cleaned.mask, Math.max(1, Math.round(s.smoothing)));
  if (tracedPx.length === 0) {
    return {
      polys: [],
      curves: [],
      artwork: [],
      mask: cleaned.mask,
      stats: {
        stickers: 0,
        source: masked.source,
        nodes: 0,
        w_mm: 0,
        h_mm: 0,
        tolerance_mm: 0,
        gap_mm: Infinity,
        clearance_mm: clearanceNeeded(s.border_mm, s.bladeRadius_mm),
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

  // 4 — thin the trace, in millimetres. Only far enough to drop redundant
  // points: nothing here is allowed to move the outline, because every corner
  // a coarse simplify invents is a corner the blade then has to cut.
  const simplified = { polys: simplifyPolys(scalePolys(tracedPx, mmPerPx), TRACE_TOLERANCE_MM, 0) };

  // How close the shapes are, and how much room the border wants. Measured on
  // the traced artwork, so it is known before the offset gets a chance to weld
  // anything, and reported either way.
  const gap = minGap(simplified.polys);
  const clearance = clearanceNeeded(s.border_mm, s.bladeRadius_mm);

  // Not when the painted border is kept: those borders are drawn nearly
  // touching on a real sheet, so a small gap says nothing about the width.
  if (s.target !== "sticker") {
    warnings.push(...widthWarnings(simplified.polys, s.width_mm, gap.min_mm));
  }

  // 5 and 6 — border, then make it cuttable
  const border = buildBorder(simplified.polys, s);
  warnings.push(...border.warnings);
  warnings.push(...crowdingWarnings(simplified.polys, border.polys, gap.min_mm, clearance, s));

  // 7 — curves. The budget is enforced here, on the path that actually
  // reaches the plotter, and it is spent on Bezier anchors rather than straight
  // segments: thinning a smooth outline to a few hundred straight lines is what
  // turned a round sticker into a jagged one.
  const fitted = fitPolys(border.polys, { tolerance: s.curveTolerance_mm });
  warnings.push(...fitted.warnings);
  const budgeted = { polys: flattenPolys(fitted.curves), tolerance: fitted.tolerance };

  const b = boundsOf(budgeted.polys.length ? budgeted.polys : simplified.polys);

  return {
    polys: budgeted.polys,
    curves: fitted.curves,
    artwork: simplified.polys,
    mask: cleaned.mask,
    stats: {
      stickers: budgeted.polys.length,
      source: masked.source,
      nodes: fitted.nodes,
      w_mm: b.w,
      h_mm: b.h,
      tolerance_mm: budgeted.tolerance,
      gap_mm: gap.min_mm,
      clearance_mm: clearance,
      warnings,
    },
  };
};

/** `3 stickers · 284 nodes · 48.0 x 52.4 mm` */
export const readout = (r: CutPathResult): string => {
  const { stickers, nodes, w_mm, h_mm } = r.stats;
  return `${stickers} sticker${stickers === 1 ? "" : "s"} found · ${nodes} nodes · ${w_mm.toFixed(1)} × ${h_mm.toFixed(1)} mm`;
};
