import type { CutTarget, Mask, MaskRoute } from "./types";
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
/**
 * A cheap identity for an image: its size and a few thousand sampled bytes.
 * Enough to tell "the same picture again" from "a different one", which is all
 * the caches keyed on it need — every slider move re-sends identical pixels.
 */
export const fingerprint = (img: Rgba): string => {
  let hash = 2166136261;
  const step = Math.max(4, Math.floor(img.data.length / 4096) | 3) + 1;
  for (let i = 0; i < img.data.length; i += step) {
    hash = Math.imul(hash ^ img.data[i], 16777619);
  }
  return `${img.w}x${img.h}:${hash >>> 0}`;
};

let lastMedian: { key: string; out: Rgba } | null = null;

export const medianFilter3 = (img: Rgba): Rgba => {
  // The filter is the slowest single step and its input never changes while
  // someone drags a slider, so the last answer is kept.
  const key = fingerprint(img);
  if (lastMedian?.key === key) return lastMedian.out;
  const out = medianFilter3Raw(img);
  lastMedian = { key, out };
  return out;
};

const medianFilter3Raw = (img: Rgba): Rgba => {
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

/**
 * Is the alpha channel a clean cut-out — a real share of the image fully clear?
 *
 * Plenty of files carry alpha that is not a cut-out at all: a background
 * remover that left a 10 to 25% haze everywhere, a soft vignette. Thresholding
 * that finds one sticker the size of the page. Those are better flattened onto
 * white and read by colour, like any opaque image.
 */
export const hasCleanAlpha = (img: Rgba): boolean => {
  let clear = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 16) clear += 1;
  return clear / (img.data.length / 4) >= 0.03;
};

/** Composite onto white, so a hazy alpha channel reads as an opaque image. */
export const flattenOnWhite = (img: Rgba): Rgba => {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = img.data[i + 3] / 255;
    out[i] = img.data[i] * a + 255 * (1 - a);
    out[i + 1] = img.data[i + 1] * a + 255 * (1 - a);
    out[i + 2] = img.data[i + 2] * a + 255 * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, w: img.w, h: img.h };
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

/**
 * A tolerance for keeping a painted border: just above the paper's own noise.
 *
 * The outer edge of a painted sticker border is often the faintest line in the
 * image — a rim a few levels darker than paper that is itself nearly white. A
 * tolerance wide enough to be comfortable floods straight through it. So this
 * measures how much the paper varies along the image edge and sits just above
 * that, which is the widest setting that still stops at the rim.
 */
export const suggestStickerTolerance = (img: Rgba): number => {
  const { w, h, data } = img;
  const [r, g, b] = cornerColour(img);
  const d: number[] = [];
  const sample = (x: number, y: number) => d.push(rgbDistance(data, (y * w + x) * 4, r, g, b));
  for (let x = 0; x < w; x += 2) {
    sample(x, 0);
    sample(x, h - 1);
  }
  for (let y = 0; y < h; y += 2) {
    sample(0, y);
    sample(w - 1, y);
  }
  d.sort((p, q) => p - q);
  const noise = d[Math.floor((d.length - 1) * 0.95)] ?? 0;
  const t = (noise * 2 + 3) / MAX_RGB_DIST;
  return Math.round(Math.min(0.08, Math.max(0.015, t)) * 200) / 200;
};

const ARTWORK_LADDER = [0.03, 0.05, 0.07, 0.09, 0.12, 0.15, 0.19, 0.24];

/**
 * A tolerance for throwing a painted border away: just past its rim.
 *
 * Widening the flood, the area left behind falls in one step at the moment the
 * rim gives way and the white border floods out with the paper. Before that
 * step the border is still attached; long after it, pale artwork starts to go
 * too. So the answer is the first rung past the biggest step, plus a little.
 */
export const suggestArtworkTolerance = (img: Rgba): number => {
  const cover = ARTWORK_LADDER.map((t) => {
    const m = maskFromBackground(img, t);
    let n = 0;
    for (let i = 0; i < m.data.length; i++) n += m.data[i];
    return n / m.data.length;
  });
  let at = -1;
  let biggest = 0.08;
  for (let i = 1; i < cover.length; i++) {
    const drop = cover[i - 1] > 0 ? (cover[i - 1] - cover[i]) / cover[i - 1] : 0;
    if (drop > biggest) {
      biggest = drop;
      at = i;
    }
  }
  return at < 0 ? 0.1 : Math.min(0.3, ARTWORK_LADDER[at] + 0.02);
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
    target?: CutTarget;
    route?: MaskRoute;
    edgeThreshold: number;
    backgroundTolerance: number;
    inkThreshold?: number;
    edgeSensitivity?: number;
  },
): MaskReport => {
  const warnings: string[] = [];
  // Alpha is only believed when it is a clean cut-out. Anything else is
  // flattened and read by colour.
  const useAlpha = hasUsefulAlpha(img) && hasCleanAlpha(img);
  if (!useAlpha && hasUsefulAlpha(img)) img = flattenOnWhite(img);
  const filtered = medianFilter3(img);

  const route: MaskReport["source"] =
    useAlpha ? "alpha" : o.target !== "sticker" && o.route === "ink" ? "ink" : "background";

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
  // Not when the border is being kept: there the flood is meant to stop at the
  // sticker's edge, and the pale interior is recovered by filling the outline.
  if (route === "background" && o.target !== "sticker" && coverage > 0.01 && coverage < 0.985) {
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
