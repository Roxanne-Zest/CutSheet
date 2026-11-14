import type { CutPathResult, CutPathSettings, CutTarget, Mask, Poly } from "./types";
import { buildMask, fingerprint, flattenOnWhite, hasCleanAlpha, hasUsefulAlpha, medianFilter3, suggestArtworkTolerance, suggestStickerTolerance } from "./mask";
import type { Rgba } from "./mask";
import { cleanMask, dropPaleDebris } from "./clean";
import { boundsOf, ringArea, scalePolys, traceSmooth } from "./trace";
import { simplifyPolys } from "./simplify";
import { fitPolys, flattenPolys } from "./curves";
import { KERF_MM, buildSheetBorder, groupPieces, measureBorderPx } from "./sheet";
import { classifyLoss, minGap } from "./gaps";

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

/** Pieces this fraction of the painted border apart are one sticker. */
const GROUP_REACH = 0.92;

const stageCache = new Map<
  string,
  { mask: Mask; px: Poly[]; source: "alpha" | "background" | "ink"; warnings: string[] }
>();

type Stage = { mask: Mask; pieces: Poly[]; source: "alpha" | "background" | "ink"; warnings: string[] };

const empty = (
  mask: Mask,
  source: Stage["source"],
  target: CutTarget,
  s: CutPathSettings,
  warnings: string[],
): CutPathResult => ({
  polys: [],
  curves: [],
  artwork: [],
  mask,
  stats: {
    stickers: 0,
    target,
    border_mm: s.border_mm,
    backgroundTolerance: s.backgroundTolerance,
    source,
    nodes: 0,
    w_mm: 0,
    h_mm: 0,
    tolerance_mm: 0,
    gap_mm: Infinity,
    clearance_mm: KERF_MM,
    warnings: [
      ...warnings,
      "No artwork found. Adjust Background tolerance until the magenta overlay covers the sticker and nothing else.",
    ],
  },
});

/**
 * Is the sticker outline trustworthy, or has it run neighbours together?
 *
 * Keeping a painted border depends on that border having an edge the flood can
 * stop at. On many sheets it does not: soft shadows bridge the gaps and several
 * stickers come back as one. Two tells, either of which is enough — one outline
 * far larger than the rest, or clearly fewer outlines than there are stickers'
 * worth of artwork.
 */
export const outlineIsSound = (outlines: Poly[], stickers: number): boolean => {
  if (outlines.length === 0) return false;
  if (outlines.length < stickers * 0.7) return false;
  if (outlines.length >= 3) {
    const areas = outlines.map((p) => ringArea(p.outer)).sort((x, y) => x - y);
    if (areas[areas.length - 1] > areas[areas.length >> 1] * 2.5) return false;
  }
  return true;
};

export const runCutPath = (img: Rgba, s: CutPathSettings): CutPathResult => {
  const warnings: string[] = [];
  const mmPerPx = s.width_mm / img.w;
  const cleanAlpha = hasUsefulAlpha(img) && hasCleanAlpha(img);
  const opaque = cleanAlpha ? img : hasUsefulAlpha(img) ? flattenOnWhite(img) : img;

  // 1 to 4 — mask, clean, trace sub-pixel, thin. Run once per question asked
  // of the image: where is the whole sticker, and where is the artwork in it.
  const id = fingerprint(img);
  const stage = (target: CutTarget, backgroundTolerance: number): Stage => {
    // Kept in pixels and cached: border, blade, curve and width changes all
    // leave the mask alone, and it is most of the work.
    const key = [id, target, backgroundTolerance, s.route, s.inkThreshold, s.edgeSensitivity, s.edgeThreshold, s.smoothing, s.keepHoles].join("|");
    let hit = stageCache.get(key);
    if (!hit) {
      const masked = buildMask(img, { ...s, target, backgroundTolerance });
      // Artwork on a sheet keeps its small pieces — the heart, the star — and
      // loses only what is the colour of a shadow. Size alone cannot tell them
      // apart; strays that end up belonging to no sticker are dropped later.
      const sheetArt = target === "artwork" && masked.source === "background";
      const cleaned = cleanMask(masked.mask, {
        ...s,
        target,
        ...(sheetArt ? { minFraction: 0.0005 } : {}),
      });
      if (sheetArt) cleaned.mask = dropPaleDebris(cleaned.mask, opaque);
      hit = {
        mask: cleaned.mask,
        px: traceSmooth(cleaned.mask, Math.max(1, Math.round(s.smoothing))),
        source: masked.source,
        warnings: [...masked.warnings, ...cleaned.warnings],
      };
      if (stageCache.size >= 6) stageCache.delete(stageCache.keys().next().value as string);
      stageCache.set(key, hit);
    }
    return {
      mask: hit.mask,
      pieces: simplifyPolys(scalePolys(hit.px, mmPerPx), TRACE_TOLERANCE_MM, 0),
      source: hit.source,
      warnings: hit.warnings,
    };
  };

  const outlineTolerance =
    s.target === "sticker"
      ? s.backgroundTolerance
      : // Capped: on noisy paper a tolerance wide enough to clear the noise
        // also clears the rim, and the outline it returns is just the artwork.
        Math.min(0.03, suggestStickerTolerance(opaque));
  const artworkTolerance =
    s.target === "artwork"
      ? s.backgroundTolerance
      : s.target === "auto" && !cleanAlpha
        ? suggestArtworkTolerance(medianFilter3(opaque))
        : 0;

  let target: CutTarget;
  let used: Stage;
  let border_mm = s.border_mm;
  let groupReach_mm = 0;

  if (s.target === "sticker" || (s.target === "auto" && cleanAlpha)) {
    target = "sticker";
    used = stage("sticker", outlineTolerance);
    if (s.target === "auto") border_mm = 0;
  } else {
    const art = stage("artwork", artworkTolerance);
    const outline = cleanAlpha ? art : stage("sticker", outlineTolerance);
    // The painted border's own width, read off the image.
    const painted_mm = cleanAlpha ? 0 : measureBorderPx(outline.mask, art.mask, opaque) * mmPerPx;
    const reach = painted_mm > 0 ? painted_mm * GROUP_REACH : Math.max(0, s.border_mm);

    if (s.target === "auto" && outlineIsSound(outline.pieces, groupPieces(art.pieces, reach).length)) {
      target = "sticker";
      used = outline;
      border_mm = 0;
    } else {
      target = "artwork";
      used = art;
      groupReach_mm = reach;
      if ((s.target === "auto" || s.borderAuto) && painted_mm > 0) {
        border_mm = Math.round(painted_mm * 10) / 10;
      }
    }
  }
  // Warnings about the mask only make sense for a tolerance somebody chose.
  if (s.target !== "auto") warnings.push(...used.warnings);

  const backgroundTolerance = target === "sticker" ? outlineTolerance : artworkTolerance;
  if (used.pieces.length === 0) {
    return empty(used.mask, used.source, target, { ...s, border_mm, backgroundTolerance }, warnings);
  }

  // 5 and 6 — gather the pieces into stickers, give each its border inside its
  // own territory, and make it cuttable. Nothing here can weld two stickers.
  const sheet = buildSheetBorder(used.pieces, {
    border_mm,
    groupReach_mm,
    bladeRadius_mm: s.bladeRadius_mm,
    keepHoles: s.keepHoles,
    w_mm: s.width_mm,
    h_mm: img.h * mmPerPx,
  });
  if (sheet.polys.length === 0) {
    warnings.push(
      "Nothing survived the border. A negative border larger than the artwork leaves no path to cut.",
    );
  }
  if (sheet.narrowed > 0) {
    warnings.push(
      `${sheet.narrowed} sticker${sheet.narrowed === 1 ? " is" : "s are"} too close to a neighbour for a full ${border_mm} mm border, so the border narrows where they face each other and ${KERF_MM} mm is left between the cuts.`,
    );
  }

  // 7 — curves. The budget is spent on Bezier anchors rather than straight
  // segments: thinning a smooth outline to a few hundred straight lines is what
  // turned a round sticker into a jagged one.
  const fitted = fitPolys(sheet.polys, { tolerance: s.curveTolerance_mm });
  warnings.push(...fitted.warnings);
  const polys = flattenPolys(fitted.curves);

  const b = boundsOf(polys.length ? polys : used.pieces);
  return {
    polys,
    curves: fitted.curves,
    artwork: used.pieces,
    mask: used.mask,
    stats: {
      stickers: polys.length,
      target,
      border_mm,
      backgroundTolerance,
      source: used.source,
      nodes: fitted.nodes,
      w_mm: b.w,
      h_mm: b.h,
      tolerance_mm: fitted.tolerance,
      gap_mm: minGap(polys).min_mm,
      clearance_mm: KERF_MM,
      warnings,
    },
  };
};

/** `3 stickers · 284 nodes · 48.0 x 52.4 mm` */
export const readout = (r: CutPathResult): string => {
  const { stickers, nodes, w_mm, h_mm } = r.stats;
  return `${stickers} sticker${stickers === 1 ? "" : "s"} found · ${nodes} nodes · ${w_mm.toFixed(1)} × ${h_mm.toFixed(1)} mm`;
};
