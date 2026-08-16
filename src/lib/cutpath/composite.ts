import type { Mask, Poly, Ring } from "./types";
import { newMask } from "./types";

/**
 * P7 — regenerate the artwork with the new border.
 *
 * This is the "put the path back over the top" step, except it is not fitting a
 * path to a bad border: it fills the offset polygon with the border colour and
 * composites the artwork on top, masked. The border and the cut path match
 * exactly because they are the same polygon.
 */

/**
 * Scanline-fill a polygon set into a mask, non-zero winding.
 *
 * Written out rather than handed to a canvas so the result can be asserted in a
 * test — the border being the right width everywhere is the thing that matters,
 * and "it looked right in the browser" is not a check.
 */
export const rasterisePolys = (
  polys: Poly[],
  w: number,
  h: number,
  scale = 1,
  ox = 0,
  oy = 0,
): Mask => {
  const out = newMask(w, h);
  const edges: Array<{ x0: number; y0: number; x1: number; y1: number; dir: number }> = [];

  const addRing = (ring: Ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const ax = a.x * scale + ox;
      const ay = a.y * scale + oy;
      const bx = b.x * scale + ox;
      const by = b.y * scale + oy;
      if (ay === by) continue;
      edges.push(
        ay < by
          ? { x0: ax, y0: ay, x1: bx, y1: by, dir: 1 }
          : { x0: bx, y0: by, x1: ax, y1: ay, dir: -1 },
      );
    }
  };

  for (const p of polys) {
    addRing(p.outer);
    for (const hole of p.holes) addRing(hole);
  }
  if (edges.length === 0) return out;

  const crossings: Array<{ x: number; dir: number }> = [];
  for (let y = 0; y < h; y++) {
    const sy = y + 0.5;
    crossings.length = 0;
    for (const e of edges) {
      if (sy < e.y0 || sy >= e.y1) continue;
      const t = (sy - e.y0) / (e.y1 - e.y0);
      crossings.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
    }
    if (crossings.length === 0) continue;
    crossings.sort((a, b) => a.x - b.x);

    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].dir;
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(crossings[i].x - 0.5));
      const to = Math.min(w - 1, Math.floor(crossings[i + 1].x - 0.5));
      const row = y * w;
      for (let x = from; x <= to; x++) out.data[row + x] = 1;
    }
  }

  return out;
};

export type Rgb = { r: number; g: number; b: number };

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Border colour underneath, artwork on top, everything outside the cut path
 * transparent.
 *
 * The artwork is masked by the *cleaned* mask rather than the raw one — the
 * cleaned mask is what the path was derived from, so using the raw one would
 * reintroduce exactly the speckles the path no longer goes round.
 */
export const compositeArtwork = (
  source: Uint8ClampedArray,
  artworkMask: Mask,
  cutMask: Mask,
  borderColour: Rgb = WHITE,
): Uint8ClampedArray => {
  const n = artworkMask.w * artworkMask.h;
  const out = new Uint8ClampedArray(n * 4);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (!cutMask.data[i]) continue; // outside the cut path: transparent

    if (artworkMask.data[i]) {
      out[o] = source[o];
      out[o + 1] = source[o + 1];
      out[o + 2] = source[o + 2];
    } else {
      out[o] = borderColour.r;
      out[o + 1] = borderColour.g;
      out[o + 2] = borderColour.b;
    }
    out[o + 3] = 255;
  }

  return out;
};

/** How wide the regenerated border actually came out, in pixels, per row. */
export const measureBorder = (artworkMask: Mask, cutMask: Mask): { min: number; max: number } => {
  const { w, h } = artworkMask;
  let min = Infinity;
  let max = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let artFrom = -1;
    let artTo = -1;
    let cutFrom = -1;
    let cutTo = -1;
    for (let x = 0; x < w; x++) {
      if (artworkMask.data[row + x]) {
        if (artFrom < 0) artFrom = x;
        artTo = x;
      }
      if (cutMask.data[row + x]) {
        if (cutFrom < 0) cutFrom = x;
        cutTo = x;
      }
    }
    if (artFrom < 0 || cutFrom < 0) continue;
    for (const gap of [artFrom - cutFrom, cutTo - artTo]) {
      if (gap < min) min = gap;
      if (gap > max) max = gap;
    }
  }
  return { min: Number.isFinite(min) ? min : 0, max };
};
