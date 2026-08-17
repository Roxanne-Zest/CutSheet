import type { Mask, MaskRoute } from "./types";
import { newMask } from "./types";
import { DEFAULT_INK, amputationRatio, inkMask } from "./ink";

/**
 * P1 — get a binary artwork/not-artwork mask.
 *
 * The background tolerance is doing double duty and that is deliberate: set it
 * high enough and the flood fill eats the painted-on white border too, because
 * that border is near-white and touching the background. That is the mechanism
 * that strips the old border, and the whole feature rests on it.
 */

/** Largest possible RGB distance, so tolerance can be stated as a fraction. */
const MAX_RGB_DIST = Math.sqrt(3 * 255 * 255);

export type Rgba = { data: Uint8ClampedArray; w: number; h: number };

/**
 * 3x3 median filter. Always on, never a control — JPEG artefacts around a
 * sticker edge are ringing, and ringing is exactly what a median kills without
 * moving the edge itself.
 */
export const medianFilter3 = (img: Rgba): Rgba => {
  const { w, h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const window = new Uint8Array(9);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            window[n++] = data[(yy * w + xx) * 4 + c];
          }
        }
        const slice = window.subarray(0, n);
        slice.sort();
        out[o + c] = slice[n >> 1];
      }
    }
  }
  return { data: out, w, h };
};

/** Does this image carry alpha worth thresholding, or is it fully opaque? */
export const hasUsefulAlpha = (img: Rgba): boolean => {
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] < 250) return true;
  }
  return false;
};

/**
 * Threshold the alpha channel. Feathered alpha means the threshold moves the
 * boundary, which is why it is a control rather than a constant.
 */
export const maskFromAlpha = (img: Rgba, threshold: number): Mask => {
  const cut = Math.max(0, Math.min(1, threshold)) * 255;
  const out = newMask(img.w, img.h);
  for (let i = 0, p = 3; p < img.data.length; i++, p += 4) {
    out.data[i] = img.data[p] >= cut ? 1 : 0;
  }
  return out;
};

const rgbDistance = (
  d: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
): number => {
  const dr = d[i] - r;
  const dg = d[i + 1] - g;
  const db = d[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

/** Median of the four corner pixels — robust to one corner being odd. */
export const cornerColour = (img: Rgba): [number, number, number] => {
  const { w, h, data } = img;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  const pick = (c: number): number => {
    const vals = corners.map((o) => data[o + c]).sort((a, b) => a - b);
    return (vals[1] + vals[2]) / 2;
  };
  return [pick(0), pick(1), pick(2)];
};

/**
 * Flood fill inward from the four corners.
 *
 * Candidates are compared against the seed colour rather than against their own
 * neighbour: neighbour-chaining would let the fill creep through a gradient and
 * out the other side into the artwork.
 */
export const maskFromBackground = (img: Rgba, tolerance: number): Mask => {
  const { w, h, data } = img;
  const [r, g, b] = cornerColour(img);
  const limit = Math.max(0, Math.min(1, tolerance)) * MAX_RGB_DIST;

  const background = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (background[i]) return;
    if (rgbDistance(data, i * 4, r, g, b) > limit) return;
    background[i] = 1;
    stack.push(i);
  };

  push(0, 0);
  push(w - 1, 0);
  push(0, h - 1);
  push(w - 1, h - 1);

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
  for (let i = 0; i < out.data.length; i++) out.data[i] = background[i] ? 0 : 1;
  return out;
};

export type MaskReport = {
  mask: Mask;
  /** Which route was taken, so the UI can show the control that matters. */
  source: "alpha" | "background" | "ink";
  /** Fraction of pixels that ended up as artwork. */
  coverage: number;
  warnings: string[];
};

/**
 * Tolerance tight enough to reach nothing but true paper. Used only as the
 * yardstick for how much artwork a wider tolerance is eating.
 */
const TIGHT_TOLERANCE = 0.015;
/** Losing this much of the artwork is worth interrupting someone over. */
const AMPUTATION_LIMIT = 0.04;

export const buildMask = (
  img: Rgba,
  o: {
    route?: MaskRoute;
    edgeThreshold: number;
    backgroundTolerance: number;
    inkThreshold?: number;
    edgeSensitivity?: number;
  },
): MaskReport => {
  const filtered = medianFilter3(img);
  const warnings: string[] = [];

  const useAlpha = hasUsefulAlpha(filtered);
  const route: MaskReport["source"] =
    useAlpha ? "alpha" : o.route === "ink" ? "ink" : "background";

  const mask =
    route === "alpha"
      ? maskFromAlpha(filtered, o.edgeThreshold)
      : route === "ink"
        ? // Deliberately the unfiltered image. The median pre-pass is a tonal
          // denoiser, and a 3x3 median erases a one-pixel line outright — which
          // is precisely the structure this route reads. Filtering first loses
          // the pale regions the route exists to keep, and fragments the rest.
          inkMask(img, {
            inkThreshold: o.inkThreshold ?? DEFAULT_INK.inkThreshold,
            edgeSensitivity: o.edgeSensitivity ?? DEFAULT_INK.edgeSensitivity,
          })
        : maskFromBackground(filtered, o.backgroundTolerance);

  let set = 0;
  for (let i = 0; i < mask.data.length; i++) set += mask.data[i];
  const coverage = set / mask.data.length;

  if (coverage < 0.01) {
    warnings.push(
      route === "alpha"
        ? "Almost nothing survived the alpha threshold. Try lowering Edge threshold."
        : route === "ink"
          ? "Almost nothing survived. Lower Ink threshold, or raise Edge sensitivity so the outlines register."
          : "Almost nothing survived the flood fill — the tolerance is eating the artwork. Lower Background tolerance.",
    );
  }
  if (coverage > 0.985 && route !== "alpha") {
    warnings.push(
      route === "ink"
        ? "Everything registered as ink. Raise Ink threshold, or lower Edge sensitivity — paper texture is being read as outlines."
        : "The flood fill found almost no background. Raise Background tolerance, or crop the artwork first.",
    );
  }

  // The failure that has no other symptom: on a sheet whose artwork shares a
  // tone with its paper, a workable-looking tolerance quietly amputates the pale
  // parts of every sticker and the count never changes. Measure it directly.
  if (route === "background" && coverage > 0.01 && coverage < 0.985) {
    const tight = maskFromBackground(filtered, Math.min(TIGHT_TOLERANCE, o.backgroundTolerance));
    const lost = amputationRatio(mask, tight);
    if (lost > AMPUTATION_LIMIT) {
      warnings.push(
        `About ${Math.round(lost * 100)}% of the artwork is being eaten by the flood fill — pale areas sitting on pale paper. The sticker count will not show this. Switch to the Ink route, or drop Background tolerance below ${Math.round(TIGHT_TOLERANCE * 100)}%.`,
      );
    }
  }

  return { mask, source: route, coverage, warnings };
};
