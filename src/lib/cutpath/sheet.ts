import type { Mask, Poly } from "./types";
import { newMask } from "./types";
import { distanceToSet, squaredDistance } from "./edt";
import { rasterisePolys } from "./composite";
import { traceSmooth, scalePolys } from "./trace";
import { polyGap } from "./gaps";
import { intersectPolys, offsetPolys, pointInRing, unionPolys, makeCuttable, dropHoles } from "./offset";

/**
 * A sheet of stickers, as opposed to one sticker.
 *
 * Three things a sheet needs that a single sticker never did. The pieces of
 * artwork have to be gathered into stickers — a dragon and the heart beside it
 * are one sticker, two dragons are two. The border has to match the one that
 * was painted, without anyone measuring it. And however large the border or
 * wrong the width, two stickers must never come out as one cut.
 */

/** The least paper left between two neighbouring cut lines. */
export const KERF_MM = 0.6;

/**
 * Width of the border painted round the artwork, in pixels.
 *
 * A painted sticker border ends in a rim: a thin darker line, usually with a
 * soft shadow outside it. Walking outward from the artwork, the rim is where
 * the paper is darkest, so the distance at which the average tone dips lowest
 * is the border's width. `outline` — the sticker silhouette, shadow and all —
 * only bounds the search.
 *
 * With no rim to find, the outline's own edge is the next best answer.
 */
export const measureBorderPx = (
  outline: Mask,
  artwork: Mask,
  img: { data: Uint8ClampedArray; w: number; h: number },
): number => {
  const { w, h } = outline;
  const d = distanceToSet(artwork);
  const BINS = 80;
  const dark = new Float64Array(BINS);
  const count = new Float64Array(BINS);
  const edge: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!outline.data[i] || artwork.data[i] || !(d[i] < 1e9)) continue;
      const bin = Math.round(d[i]);
      if (bin < BINS) {
        const o = i * 4;
        dark[bin] += 255 - Math.min(img.data[o], img.data[o + 1], img.data[o + 2]);
        count[bin] += 1;
      }
      if (!(outline.data[i - 1] && outline.data[i + 1] && outline.data[i - w] && outline.data[i + w])) {
        edge.push(d[i]);
      }
    }
  }
  if (edge.length < 20) return 0;
  edge.sort((p, q) => p - q);
  const outer = edge[edge.length >> 1];

  // Skip the first few pixels: that is the artwork's own soft edge, not a rim.
  let best = -1;
  let bestDark = 0;
  const profile: number[] = [];
  for (let b = 4; b < Math.min(BINS, Math.ceil(outer) + 2); b++) {
    if (count[b] < 50) continue;
    const v = dark[b] / count[b];
    profile.push(v);
    if (v > bestDark) {
      bestDark = v;
      best = b;
    }
  }
  if (best < 0) return outer;
  const floor = [...profile].sort((p, q) => p - q)[profile.length >> 1];
  return bestDark - floor >= 4 ? best : outer;
};

/**
 * Gather pieces of artwork into stickers.
 *
 * Pieces that a border of `reach_mm` would join belong to one sticker: that is
 * what the painted border did to them. Pieces further apart are neighbours.
 */
export const groupPieces = (pieces: Poly[], reach_mm: number): Poly[][] => {
  if (pieces.length < 2 || reach_mm <= 0) return pieces.map((p) => [p]);
  const blobs = offsetPolys(dropHoles(pieces), reach_mm);
  const groups: Poly[][] = blobs.map(() => []);
  for (const p of pieces) {
    const at = blobs.findIndex((b) => pointInRing(p.outer[0], b.outer));
    if (at >= 0) groups[at].push(p);
    else groups.push([p]);
  }

  // Two full-sized pieces are two stickers, however close they were painted.
  // Sheets are often drawn with neighbouring borders touching, and reach alone
  // would then gather a whole row into one. So a group with more than one
  // major piece is split, and its small pieces — the heart, the star — go with
  // whichever major piece they sit nearest.
  const largest = Math.max(...pieces.map((p) => ringAreaOf(p.outer)));
  const isMajor = (p: Poly) => ringAreaOf(p.outer) >= largest * MAJOR_FRACTION;
  const out: Poly[][] = [];
  for (const g of groups) {
    if (g.length === 0) continue;
    const majors = g.filter(isMajor);
    if (majors.length < 2) {
      out.push(g);
      continue;
    }
    const split = majors.map((m) => [m]);
    for (const p of g) {
      if (isMajor(p)) continue;
      let best = 0;
      let bestGap = Infinity;
      majors.forEach((m, k) => {
        const d = polyGap(p, m);
        if (d < bestGap) {
          bestGap = d;
          best = k;
        }
      });
      split[best].push(p);
    }
    out.push(...split);
  }
  return out;
};

/** A whole group smaller than this fraction of the largest piece is a stray. */
const STRAY_FRACTION = 0.02;

/** A piece this fraction of the largest is a sticker in its own right. */
const MAJOR_FRACTION = 0.2;

const GRID_MAX_PX = 700;

/**
 * The territory each sticker may grow into: everywhere nearer to it than to
 * any neighbour, less half the kerf. Borders clipped to these can never meet.
 */
export const territories = (
  groups: Poly[][],
  w_mm: number,
  h_mm: number,
  reach_mm: number,
  kerf_mm = KERF_MM,
): Poly[][] => {
  const pad_mm = Math.max(0, reach_mm) + 1;
  const pxPerMm = Math.min(GRID_MAX_PX / Math.max(w_mm + 2 * pad_mm, h_mm + 2 * pad_mm), 20);
  const gw = Math.ceil((w_mm + 2 * pad_mm) * pxPerMm);
  const gh = Math.ceil((h_mm + 2 * pad_mm) * pxPerMm);
  const pad = pad_mm * pxPerMm;
  const n = gw * gh;

  const best = new Float32Array(n).fill(Infinity);
  const second = new Float32Array(n).fill(Infinity);
  const owner = new Int32Array(n).fill(-1);
  groups.forEach((g, k) => {
    const sq = squaredDistance(rasterisePolys(g, gw, gh, pxPerMm, pad, pad), (v) => v === 1);
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(sq[i]);
      if (d < best[i]) {
        second[i] = best[i];
        best[i] = d;
        owner[i] = k;
      } else if (d < second[i]) second[i] = d;
    }
  });

  const kerf = kerf_mm * pxPerMm;
  return groups.map((_, k) => {
    const m = newMask(gw, gh);
    for (let i = 0; i < n; i++) m.data[i] = owner[i] === k && best[i] + kerf <= second[i] ? 1 : 0;
    const shift = (r: Poly["outer"]) => r.map((p) => ({ x: p.x - pad, y: p.y - pad }));
    return scalePolys(
      traceSmooth(m, 1).map((p) => ({ outer: shift(p.outer), holes: p.holes.map(shift) })),
      1 / pxPerMm,
    );
  });
};

export type SheetBorder = {
  /** One entry per finished cut shape. */
  polys: Poly[];
  stickers: number;
  /** Stickers whose border was narrowed to stay clear of a neighbour. */
  narrowed: number;
};

/**
 * Build every sticker's border, each inside its own territory.
 *
 * `groupReach_mm` decides which pieces are one sticker; `border_mm` is how far
 * the cut sits from the artwork. They differ when the user asks for a thinner
 * border than the painted one: the grouping should not change with the slider.
 */
export const buildSheetBorder = (
  pieces: Poly[],
  o: {
    border_mm: number;
    groupReach_mm: number;
    bladeRadius_mm: number;
    keepHoles: boolean;
    w_mm: number;
    h_mm: number;
  },
): SheetBorder => {
  const source = o.keepHoles ? pieces : dropHoles(pieces);
  // A group with no full-sized piece and almost no area is a stray, not a
  // sticker: nobody wants a 2 mm cut round a speck.
  const largest = Math.max(0, ...source.map((p) => ringAreaOf(p.outer)));
  const groups = groupPieces(source, o.groupReach_mm).filter(
    (g) => g.reduce((a, p) => a + ringAreaOf(p.outer), 0) >= largest * STRAY_FRACTION,
  );
  const cells =
    groups.length > 1 && o.border_mm > 0
      ? territories(groups, o.w_mm, o.h_mm, o.border_mm)
      : null;

  const polys: Poly[] = [];
  let narrowed = 0;
  let stickers = 0;
  groups.forEach((g, k) => {
    const grown = o.border_mm === 0 ? g : offsetPolys(g, o.border_mm);
    let shape = grown;
    if (cells && grown.length) {
      const kept = intersectPolys(grown, cells[k]);
      const area = (ps: Poly[]) => ps.reduce((a, p) => a + ringAreaOf(p.outer), 0);
      if (area(kept) < area(grown) * 0.995) narrowed += 1;
      // Never smaller than the artwork itself, however tight the neighbours.
      shape = unionPolys(kept, o.border_mm > 0 ? g : []);
    }
    // Growing a shape can enclose a pocket — pale artwork the mask missed, the
    // space inside a curled tail. That is inside the sticker, not a hole in it.
    if (!o.keepHoles) shape = dropHoles(shape);
    // And again after the blade pass: closing the mouth of a slit turns the
    // rest of the slit into a pocket, which would otherwise be cut out.
    const rounded = makeCuttable(shape, o.bladeRadius_mm);
    const cut = o.keepHoles ? rounded : dropHoles(rounded);
    if (cut.length) stickers += 1;
    polys.push(...cut);
  });

  return { polys, stickers, narrowed };
};

const ringAreaOf = (ring: Poly["outer"]): number => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return Math.abs(a) / 2;
};
