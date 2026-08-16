import type { Mask } from "./types";
import { newMask } from "./types";

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012).
 *
 * Everything morphological in this pipeline is a circle of some radius —
 * smoothing, the blade radius, the border. A box or diamond structuring element
 * would give square or diamond corners, which is precisely the artefact a
 * die-cut border must not have. An exact EDT gives a true circle at any radius
 * for the same linear cost, so it is worth the forty lines.
 */

const INF = 1e20;

/** 1D squared-distance transform of a sampled function, in place. */
const edt1d = (f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void => {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
};

/**
 * Squared distance from every pixel to the nearest pixel where `inside` is
 * true. Pixels that are themselves inside get 0.
 */
export const squaredDistance = (m: Mask, inside: (v: number) => boolean): Float64Array => {
  const { w, h } = m;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = inside(m.data[i]) ? 0 : INF;

  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }

  return grid;
};

/** Distance in pixels from each pixel to the nearest set pixel. */
export const distanceToSet = (m: Mask): Float64Array => {
  const sq = squaredDistance(m, (v) => v === 1);
  const out = new Float64Array(sq.length);
  for (let i = 0; i < sq.length; i++) out[i] = Math.sqrt(sq[i]);
  return out;
};

/** Grow the set by an exact circle of radius r pixels. */
export const dilate = (m: Mask, r: number): Mask => {
  if (r <= 0) return { data: new Uint8Array(m.data), w: m.w, h: m.h };
  const sq = squaredDistance(m, (v) => v === 1);
  const out = newMask(m.w, m.h);
  const rr = r * r;
  for (let i = 0; i < sq.length; i++) out.data[i] = sq[i] <= rr ? 1 : 0;
  return out;
};

/** Shrink the set by an exact circle of radius r pixels. */
export const erode = (m: Mask, r: number): Mask => {
  if (r <= 0) return { data: new Uint8Array(m.data), w: m.w, h: m.h };
  // Erosion is dilation of the complement, but the border must count as
  // outside or a shape touching the edge would never erode there.
  const sq = squaredDistance(m, (v) => v === 0);
  const out = newMask(m.w, m.h);
  const rr = r * r;
  const { w, h } = m;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const edge = Math.min(x + 1, y + 1, w - x, h - y);
      out.data[i] = sq[i] > rr && edge > r ? 1 : 0;
    }
  }
  return out;
};

/** Remove speckles: erode then dilate. */
export const open = (m: Mask, r: number): Mask => dilate(erode(m, r), r);

/** Fill pinholes: dilate then erode. */
export const close = (m: Mask, r: number): Mask => erode(dilate(m, r), r);
