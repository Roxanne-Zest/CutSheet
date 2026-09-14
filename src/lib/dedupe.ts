/**
 * Near-duplicates.
 *
 * A trip is not two hundred photographs, it is forty photographs and a hundred
 * and sixty second attempts: the burst, the one where somebody blinked, the
 * same doorway from half a step left. Laying all of them out gives you a
 * journal of the same doorway.
 *
 * So each photo gets a small signature at import — an 8 x 8 thumbnail with the
 * exposure normalised out, and a measure of how sharp it is — and photos that
 * look alike *and* were taken close together are treated as one, with the
 * sharpest kept.
 *
 * Both halves of that sentence matter. Hash alone would collapse two genuinely
 * different photographs that happen to share a horizon; the clock alone would
 * collapse a burst with the thing you turned round and photographed next.
 */

export type Signature = {
  /** 8 x 8 normalised thumbnail, 128 hex characters. */
  thumb: string;
  /** Mean edge energy. Higher is sharper; comparable only between similar shots. */
  sharpness: number;
  /** Spread of tone across the frame. Near zero means there is nothing to compare. */
  contrast: number;
};

/** The grayscale square every signature is computed from. */
export const SIG_SIZE = 64;

/** Thumbnail edge, so the signature is 64 cells. */
const CELLS = 8;

/**
 * Clamp for the normalised thumbnail, in standard deviations. Beyond four the
 * cell is the brightest or darkest thing in the frame and how far beyond
 * stops mattering.
 */
const Z_CLAMP = 4;

/**
 * The signature is an 8 x 8 thumbnail with the exposure normalised out, and
 * two photos are compared by how far apart their cells are.
 *
 * A difference hash was the obvious thing and it was measured first: it turns
 * each comparison into a single bit, and in the flat parts of a frame — sky,
 * a wall — that bit is a coin toss on a rounding error. A 2 px shift and a
 * completely different photograph both came out at 21 bits of 64, which is no
 * use to anyone. Keeping the cell values and measuring the distance between
 * them keeps the size of each difference instead of throwing it away, and the
 * two cases separate cleanly. See the table in dedupe.test.ts.
 */
export const thumbOf = (gray: Uint8Array, w: number, h: number): string => {
  const cells = new Float64Array(CELLS * CELLS);
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const x0 = Math.floor((cx * w) / CELLS);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / CELLS));
      const y0 = Math.floor((cy * h) / CELLS);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / CELLS));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * w + x];
          n += 1;
        }
      }
      cells[cy * CELLS + cx] = n > 0 ? sum / n : 0;
    }
  }

  // Normalise to z-scores, so the same scene a stop brighter is the same
  // signature. Only the shape of the light matters, never its level.
  let mean = 0;
  for (const v of cells) mean += v;
  mean /= cells.length;
  let sq = 0;
  for (const v of cells) sq += (v - mean) * (v - mean);
  const sd = Math.sqrt(sq / cells.length) || 1;

  let hex = "";
  for (const v of cells) {
    const z = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, (v - mean) / sd));
    const byte = Math.round(((z + Z_CLAMP) / (2 * Z_CLAMP)) * 255);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/**
 * Mean distance between two thumbnails, in standard deviations.
 *
 * 0 is identical. Around 1 is two unrelated photographs, because a z-score is
 * a standard deviation by construction.
 */
export const thumbDistance = (a: string, b: string): number => {
  if (a.length !== b.length || a.length === 0) return Infinity;
  const scale = (2 * Z_CLAMP) / 255;
  let sum = 0;
  const n = a.length / 2;
  for (let i = 0; i < a.length; i += 2) {
    sum += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
  }
  return (sum / n) * scale;
};

/**
 * Mean absolute Laplacian, relative to brightness.
 *
 * Only good enough to tell an obviously soft frame from a sharp one of the same
 * scene — which is all it is asked to do, since it only ever compares photos
 * already established to be near-identical. It is not a focus judgement and
 * must never be shown as one.
 */
export const sharpness = (gray: Uint8Array, w: number, h: number): number => {
  let edges = 0;
  let mean = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      edges += Math.abs(lap);
      mean += gray[i];
      n += 1;
    }
  }
  if (n === 0) return 0;
  // Divided by brightness so a dark photo is not mistaken for a blurred one.
  return edges / n / (mean / n + 8);
};

export const contrastOf = (gray: Uint8Array): number => {
  if (gray.length === 0) return 0;
  let sum = 0;
  for (const v of gray) sum += v;
  const mean = sum / gray.length;
  let sq = 0;
  for (const v of gray) sq += (v - mean) * (v - mean);
  return Math.sqrt(sq / gray.length);
};

export const signatureOf = (gray: Uint8Array, w: number, h: number): Signature => ({
  thumb: thumbOf(gray, w, h),
  sharpness: sharpness(gray, w, h),
  contrast: contrastOf(gray),
});

/**
 * Below this there is nothing to compare — a blank scan, a solid colour, a
 * photo of a wall in the dark. Normalising a flat frame leaves noise, so every
 * one of them resembles every other, and "two blank pages look alike" is not a
 * reason to throw one of them away. These are never duplicates of anything.
 */
export const MIN_CONTRAST = 4;

/**
 * How far apart two thumbnails may be and still count as the same shot, in
 * standard deviations.
 *
 * Measured on constructed cases — the table is in dedupe.test.ts and asserted
 * there, so it cannot quietly stop being true:
 *
 *     one scene re-shot (1-4 px shift, ±20% exposure, noise, blur)   0.00 - 0.17
 *     the same view from a few steps away, or a detail moved         0.24 - 0.25
 *     a different photograph                                         0.50 - 0.51
 *
 * The gap is wide and empty between 0.25 and 0.50. 0.35 sits in it. That puts
 * the same doorway from half a step left on the duplicate side, which is the
 * case this exists for, and the time window below is what keeps the rest
 * honest.
 */
export const MAX_DISTANCE = 0.35;

/** A burst is seconds apart. Two minutes is generous and still not "later". */
export const WINDOW_S = 120;

export type DedupeCandidate = {
  id: string;
  takenAt?: number;
  thumb?: string;
  sharpness?: number;
  contrast?: number;
  w_px: number;
  h_px: number;
};

export type Cluster<T extends DedupeCandidate> = {
  keep: T;
  /** The near-identical ones being set aside. Never deleted, only not placed. */
  drop: T[];
};

export type DedupeOptions = { maxDistance: number; window_s: number };

export const DEFAULT_DEDUPE: DedupeOptions = {
  maxDistance: MAX_DISTANCE,
  window_s: WINDOW_S,
};

/** Comparable at all: it has a signature, and there was something in it to sign. */
const comparable = (p: DedupeCandidate): boolean =>
  typeof p.thumb === "string" && (p.contrast ?? 0) >= MIN_CONTRAST;

/**
 * Which of a burst to keep: the sharpest, then the largest, then the first.
 *
 * Sharpness only decides between photos already known to be near-identical, so
 * the comparison is like for like. Within 5% it is noise rather than a
 * judgement, and the earlier, larger frame wins instead.
 */
export const pickKeeper = <T extends DedupeCandidate>(group: T[]): T =>
  group.reduce((best, p) => {
    const a = p.sharpness ?? 0;
    const b = best.sharpness ?? 0;
    if (a > b * 1.05) return p;
    if (b > a * 1.05) return best;
    const pa = p.w_px * p.h_px;
    const pb = best.w_px * best.h_px;
    if (pa !== pb) return pa > pb ? p : best;
    return best;
  });

/**
 * Group a chronologically ordered run into bursts.
 *
 * Each photo is compared against the *anchor* of the open cluster rather than
 * the one before it, so a slow pan across a view does not chain into one
 * cluster by drift: 1 matches 2, 2 matches 3, but if 3 has left 1 behind it
 * starts a cluster of its own. The clock is checked against the most recent
 * member, so a long burst still holds together.
 */
export const clusterDuplicates = <T extends DedupeCandidate>(
  ordered: T[],
  o: DedupeOptions = DEFAULT_DEDUPE,
): Array<Cluster<T>> => {
  const out: Array<Cluster<T>> = [];
  let anchor: T | null = null;
  let last: T | null = null;
  let group: T[] = [];

  const close = () => {
    if (group.length === 0) return;
    const keep = pickKeeper(group);
    out.push({ keep, drop: group.filter((p) => p !== keep) });
    group = [];
    anchor = null;
    last = null;
  };

  for (const p of ordered) {
    if (!comparable(p)) {
      // Nothing to compare: it stands alone and cannot absorb anything either.
      close();
      out.push({ keep: p, drop: [] });
      continue;
    }

    const inTime =
      last === null ||
      last.takenAt === undefined ||
      p.takenAt === undefined ||
      Math.abs(p.takenAt - last.takenAt) <= o.window_s * 1000;

    if (
      anchor !== null &&
      inTime &&
      thumbDistance(anchor.thumb as string, p.thumb as string) <= o.maxDistance
    ) {
      group.push(p);
      last = p;
      continue;
    }

    close();
    anchor = p;
    last = p;
    group = [p];
  }
  close();
  return out;
};

export type DedupeResult<T extends DedupeCandidate> = {
  kept: T[];
  dropped: T[];
  /** How many bursts had anything set aside, for the wording in the UI. */
  bursts: number;
  /** True when nothing could be compared, so the UI can say why it did nothing. */
  unusable: boolean;
};

export const dedupe = <T extends DedupeCandidate>(
  ordered: T[],
  o: DedupeOptions = DEFAULT_DEDUPE,
): DedupeResult<T> => {
  const clusters = clusterDuplicates(ordered, o);
  const dropped = clusters.flatMap((c) => c.drop);
  return {
    kept: clusters.map((c) => c.keep),
    dropped,
    bursts: clusters.filter((c) => c.drop.length > 0).length,
    unusable: ordered.length > 0 && !ordered.some(comparable),
  };
};
