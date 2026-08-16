import type { Mask } from "./types";
import { newMask } from "./types";
import { close, open } from "./edt";

/**
 * P2 — clean the mask.
 *
 * Open then close: opening kills speckles and compression debris, closing fills
 * pinholes. In that order, because closing first would weld a speckle to the
 * artwork before there was a chance to drop it.
 */

/** Components smaller than this fraction of the largest are debris. */
export const MIN_COMPONENT_FRACTION = 0.02;
/** A component this much bigger than the median is probably two stickers. */
export const MERGED_COMPONENT_RATIO = 2.5;

export type Labelled = {
  /** 0 is background; components are numbered from 1. */
  labels: Int32Array;
  /** Pixel area by label; index 0 is unused. */
  areas: number[];
  count: number;
};

/** Four-connected labelling. Diagonal touching is not the same sticker. */
export const labelComponents = (m: Mask, value = 1): Labelled => {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const areas: number[] = [0];
  const stack: number[] = [];
  let next = 0;

  for (let start = 0; start < data.length; start++) {
    if (data[start] !== value || labels[start] !== 0) continue;
    next += 1;
    let area = 0;
    labels[start] = next;
    stack.push(start);

    while (stack.length) {
      const i = stack.pop() as number;
      area += 1;
      const x = i % w;
      const y = (i - x) / w;
      const visit = (xx: number, yy: number) => {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
        const j = yy * w + xx;
        if (data[j] !== value || labels[j] !== 0) return;
        labels[j] = next;
        stack.push(j);
      };
      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
    areas.push(area);
  }

  return { labels, areas, count: next };
};

/** Drop components under `fraction` of the largest one. */
export const dropSmallComponents = (
  m: Mask,
  fraction = MIN_COMPONENT_FRACTION,
): { mask: Mask; dropped: number } => {
  const { labels, areas, count } = labelComponents(m);
  if (count === 0) return { mask: m, dropped: 0 };
  const largest = Math.max(...areas.slice(1));
  const floor = largest * fraction;

  const keep = new Uint8Array(count + 1);
  let dropped = 0;
  for (let l = 1; l <= count; l++) {
    if (areas[l] >= floor) keep[l] = 1;
    else dropped += 1;
  }

  const out = newMask(m.w, m.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = keep[labels[i]] ? 1 : 0;
  return { mask: out, dropped };
};

/**
 * Fill everything not reachable from the image border.
 *
 * Stickers are cut on their outline; you almost never want the hole in a donut
 * cut out, so this is the default rather than an option you have to find.
 */
export const fillHoles = (m: Mask): Mask => {
  const { w, h } = m;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i] || m.data[i] === 1) return;
    outside[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  const out = newMask(w, h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = outside[i] ? 0 : 1;
  return out;
};

/**
 * Two stickers that touch merge into one component and get one path around
 * both. That is worth saying out loud rather than silently producing a blob.
 */
export const detectMerged = (m: Mask): string[] => {
  const { areas, count } = labelComponents(m);
  if (count < 3) return [];
  const sorted = [...areas.slice(1)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const merged = sorted.filter((a) => a > median * MERGED_COMPONENT_RATIO).length;
  return merged > 0
    ? [
        `${merged} shape${merged === 1 ? " is" : "s are"} much larger than the rest — stickers that touch each other trace as one path. Separate them in the source image if that is not what you wanted.`,
      ]
    : [];
};

export type CleanReport = {
  mask: Mask;
  dropped: number;
  warnings: string[];
};

export const cleanMask = (
  m: Mask,
  o: { smoothing: number; keepHoles: boolean },
): CleanReport => {
  const r = Math.max(0, o.smoothing);
  const smoothed = r > 0 ? close(open(m, r), r) : m;
  const { mask: filtered, dropped } = dropSmallComponents(smoothed);
  const filled = o.keepHoles ? filtered : fillHoles(filtered);
  return { mask: filled, dropped, warnings: detectMerged(filled) };
};
