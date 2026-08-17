import type { Mask } from "./types";
import { newMask } from "./types";
import { close } from "./edt";
import { fillHoles } from "./clean";
import type { Rgba } from "./mask";

/**
 * P1, second route — ink on paper.
 *
 * The flood fill asks "is this pixel the same colour as the paper?", which
 * cannot separate paper from artwork that happens to be the same colour and
 * touches it. On an illustrated sheet that is not an edge case: cream fur on
 * cream paper is 2.5% apart, and any tolerance wide enough to clear the paper
 * amputates the pale parts of every sticker.
 *
 * This route asks a different question — "is this pixel inside a drawn
 * outline?" — which a line illustration always answers correctly, whatever the
 * fill colour happens to be.
 */

/** Perceptual luminance, 0..1. */
export const lumaOf = (img: Rgba): Float32Array => {
  const out = new Float32Array(img.w * img.h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (0.2126 * img.data[p] + 0.7152 * img.data[p + 1] + 0.0722 * img.data[p + 2]) / 255;
  }
  return out;
};

/** Coarse block size for the paper estimate, in source pixels. */
const BLOCK = 32;
/** How many blocks a paper value may spread into fully-covered neighbours. */
const SPREAD = 2;
/** Percentile of each block taken as "the paper here". */
const PAPER_PERCENTILE = 0.9;

/**
 * Estimate the paper, then divide it out.
 *
 * Aged paper is not one tone — it darkens at the edges, and a scan adds its own
 * gradient. Comparing everything to a single corner sample is what makes a
 * vignette weld separate stickers into one blob. So the reference becomes local
 * instead: a high percentile per block (the paper, wherever any shows), spread
 * into blocks the artwork covers completely, then interpolated smoothly.
 *
 * Returns luminance normalised so paper sits at 1.0 everywhere.
 */
export const flatField = (luma: Float32Array, w: number, h: number): Float32Array => {
  const bw = Math.max(1, Math.ceil(w / BLOCK));
  const bh = Math.max(1, Math.ceil(h / BLOCK));
  const coarse = new Float32Array(bw * bh);

  const bucket: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      bucket.length = 0;
      const y1 = Math.min(h, (by + 1) * BLOCK);
      const x1 = Math.min(w, (bx + 1) * BLOCK);
      for (let y = by * BLOCK; y < y1; y++) {
        for (let x = bx * BLOCK; x < x1; x++) bucket.push(luma[y * w + x]);
      }
      bucket.sort((a, b) => a - b);
      coarse[by * bw + bx] = bucket[Math.floor((bucket.length - 1) * PAPER_PERCENTILE)] ?? 1;
    }
  }

  // Spread paper into blocks the artwork covers entirely.
  const spread = new Float32Array(coarse.length);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = 0;
      for (let dy = -SPREAD; dy <= SPREAD; dy++) {
        for (let dx = -SPREAD; dx <= SPREAD; dx++) {
          const yy = by + dy;
          const xx = bx + dx;
          if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue;
          const v = coarse[yy * bw + xx];
          if (v > best) best = v;
        }
      }
      spread[by * bw + bx] = best;
    }
  }

  // Bilinear back up to full resolution, so no block seams survive.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / BLOCK - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / BLOCK - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const top = spread[y0 * bw + x0] * (1 - tx) + spread[y0 * bw + x1] * tx;
      const bot = spread[y1 * bw + x0] * (1 - tx) + spread[y1 * bw + x1] * tx;
      const paper = top * (1 - ty) + bot * ty;
      out[y * w + x] = paper > 1e-6 ? Math.min(1, luma[y * w + x] / paper) : 1;
    }
  }
  return out;
};

/** Sobel gradient magnitude, roughly 0..1 for normalised input. */
export const gradientMagnitude = (v: Float32Array, w: number, h: number): Float32Array => {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) =>
    v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      out[y * w + x] = Math.hypot(gx, gy) / 4;
    }
  }
  return out;
};

export type InkOptions = {
  /** How much darker than the local paper still counts as ink. 0..1. */
  inkThreshold: number;
  /** How strong a tonal step counts as a drawn outline. 0..1. */
  edgeSensitivity: number;
  /** Radius used to bridge gaps in an outline, in pixels. */
  bridge?: number;
};

export const DEFAULT_INK: InkOptions = {
  inkThreshold: 0.12,
  edgeSensitivity: 0.06,
  bridge: 2,
};

/**
 * Mask everything that is either darker than the paper or enclosed by a drawn
 * outline.
 *
 * The second half is what saves the pale fur: its interior matches the paper
 * exactly, so no tonal test can claim it, but it is ringed by an ink line. Close
 * the outlines to bridge the gaps where the pen lifted, fill what they enclose,
 * and the tail comes back whole.
 */
export const inkMask = (img: Rgba, o: InkOptions = DEFAULT_INK): Mask => {
  const { w, h } = img;
  const corrected = flatField(lumaOf(img), w, h);
  const grad = gradientMagnitude(corrected, w, h);

  const raw = newMask(w, h);
  const darkCut = 1 - o.inkThreshold;
  for (let i = 0; i < raw.data.length; i++) {
    raw.data[i] = corrected[i] < darkCut || grad[i] > o.edgeSensitivity ? 1 : 0;
  }

  // Close before anything else touches it: an outline is one or two pixels wide
  // and the clean stage opens first, which would erase it.
  const bridged = close(raw, o.bridge ?? 2);
  return fillHoles(bridged);
};

/**
 * How much artwork the paper route is eating.
 *
 * Compares the mask at the chosen tolerance against one at a tolerance too
 * tight to reach anything but true paper. When a sheet has pale artwork sitting
 * on pale paper the two differ a lot, and that difference is the amputation —
 * which is otherwise invisible, because the sticker count does not change.
 */
export const amputationRatio = (atTolerance: Mask, atTightTolerance: Mask): number => {
  let loose = 0;
  let tight = 0;
  for (let i = 0; i < atTolerance.data.length; i++) {
    loose += atTolerance.data[i];
    tight += atTightTolerance.data[i];
  }
  return tight > 0 ? Math.max(0, (tight - loose) / tight) : 0;
};
