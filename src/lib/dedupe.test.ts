import { describe, expect, it } from "vitest";
import {
  clusterDuplicates,
  contrastOf,
  dedupe,
  MAX_DISTANCE,
  MIN_CONTRAST,
  pickKeeper,
  sharpness,
  SIG_SIZE,
  signatureOf,
  thumbDistance,
  thumbOf,
} from "./dedupe";
import type { DedupeCandidate } from "./dedupe";

const N = SIG_SIZE;

/**
 * A deterministic "photograph": sky gradient, horizon, a building, a sun.
 * Every option is a way of taking the same picture slightly differently.
 */
const scene = (
  o: {
    dx?: number; dy?: number; gain?: number; blur?: number; noise?: number;
    horizon?: number; towerX?: number; towerW?: number; towerH?: number; sunX?: number;
  } = {},
): Uint8Array => {
  const dx = o.dx ?? 0, dy = o.dy ?? 0, gain = o.gain ?? 1;
  const horizon = o.horizon ?? 40, towerX = o.towerX ?? 18, towerW = o.towerW ?? 10;
  const towerH = o.towerH ?? 18, sunX = o.sunX ?? 48;
  const g = new Uint8Array(N * N);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = x - dx, sy = y - dy;
      let v: number;
      if (sy < horizon) {
        v = 200 - sy * 1.6;
        if (Math.hypot(sx - sunX, sy - 12) < 6) v = 250;
        if (sx >= towerX && sx < towerX + towerW && sy > horizon - towerH) v = 60;
      } else {
        v = 110 + ((sx * 7 + sy * 3) % 23);
      }
      v *= gain;
      if (o.noise) v += rnd() * o.noise;
      g[y * N + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  for (let pass = 0; pass < (o.blur ?? 0); pass++) {
    const c = Uint8Array.from(g);
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        g[i] = Math.round((c[i - 1] + c[i + 1] + c[i - N] + c[i + N] + c[i] * 2) / 6);
      }
    }
  }
  return g;
};

const dist = (a: Uint8Array, b: Uint8Array) => thumbDistance(thumbOf(a, N, N), thumbOf(b, N, N));

describe("what a photo's signature is worth", () => {
  /**
   * The measurements the threshold was chosen from, asserted so they cannot
   * quietly stop being true. Same numbers as the table in dedupe.ts.
   */
  const base = scene();

  it.each([
    ["identical", scene(), 0.0],
    ["shifted 1 px", scene({ dx: 1 }), 0.03],
    ["shifted 2 px", scene({ dx: 2, dy: 1 }), 0.09],
    ["a fifth of a stop brighter", scene({ gain: 1.2 }), 0.07],
    ["a fifth of a stop darker", scene({ gain: 0.8 }), 0.0],
    ["noisy", scene({ noise: 12 }), 0.01],
    ["slightly soft", scene({ blur: 1 }), 0.0],
    ["badly out of focus", scene({ blur: 4 }), 0.01],
    ["shifted 4 px", scene({ dx: 4, dy: 2 }), 0.17],
  ])("counts %s as the same shot (%#)", (_name, variant, expected) => {
    const d = dist(base, variant);
    expect(d).toBeCloseTo(expected, 2);
    expect(d).toBeLessThan(MAX_DISTANCE);
  });

  it.each([
    ["a few steps to the left", scene({ dx: 8, dy: 3 }), 0.25],
    ["the same view with something moved", scene({ towerX: 40 }), 0.24],
  ])("still counts %s as the same shot, deliberately", (_name, variant, expected) => {
    // This is the case the feature exists for — the same doorway from half a
    // step left is a second attempt, not a second photograph.
    expect(dist(base, variant)).toBeCloseTo(expected, 2);
    expect(dist(base, variant)).toBeLessThan(MAX_DISTANCE);
  });

  it.each([
    ["a different framing", scene({ horizon: 28, towerX: 44, towerW: 6, towerH: 26, sunX: 10 }), 0.5],
    ["a different scene", scene({ horizon: 20, towerX: 5, towerW: 22, towerH: 14, sunX: 30, dy: 6 }), 0.51],
  ])("keeps %s", (_name, variant, expected) => {
    expect(dist(base, variant)).toBeCloseTo(expected, 2);
    expect(dist(base, variant)).toBeGreaterThan(MAX_DISTANCE);
  });

  it("leaves a clear gap between the two, which is where the threshold sits", () => {
    const sameShot = Math.max(dist(base, scene({ dx: 4, dy: 2 })), dist(base, scene({ dx: 8, dy: 3 })));
    const different = dist(base, scene({ horizon: 28, towerX: 44, towerW: 6, towerH: 26, sunX: 10 }));
    expect(sameShot).toBeLessThan(MAX_DISTANCE);
    expect(different).toBeGreaterThan(MAX_DISTANCE);
    // Not a threshold balanced on a knife edge: the gap is twice as wide as
    // the margin on either side of it.
    expect(different - sameShot).toBeGreaterThan(0.2);
  });

  it("barely notices exposure, because the same scene is the same scene", () => {
    // Underexposure normalises away to nothing. Overexposure does not quite,
    // because clipped highlights really are a different picture — at +40% the
    // sun has burnt into the sky. Even then it is nowhere near the threshold.
    expect(dist(scene(), scene({ gain: 0.6 }))).toBeLessThan(0.01);
    expect(dist(scene(), scene({ gain: 1.4 }))).toBeCloseTo(0.14, 2);
    expect(dist(scene(), scene({ gain: 1.4 }))).toBeLessThan(MAX_DISTANCE / 2);
  });

  it("gives an unrelated pair a distance of about one standard deviation", () => {
    // Which is what a z-score distance means, and why the threshold reads as a
    // fraction rather than an arbitrary count.
    expect(dist(base, scene({ horizon: 20, towerX: 5, towerW: 22, towerH: 14, sunX: 30, dy: 6 }))).toBeGreaterThan(0.45);
  });

  it("refuses to compare thumbnails of different lengths", () => {
    expect(thumbDistance("00ff", "00")).toBe(Infinity);
    expect(thumbDistance("", "")).toBe(Infinity);
  });
});

describe("telling a sharp frame from a soft one", () => {
  it("ranks the same shot by focus", () => {
    const sharp = sharpness(scene(), N, N);
    const soft = sharpness(scene({ blur: 1 }), N, N);
    const ruined = sharpness(scene({ blur: 4 }), N, N);
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(ruined);
  });

  it("does not mistake a dark photo for a blurred one", () => {
    // Divided through by brightness for exactly this reason: underexposed is
    // not out of focus, and the darker frame may be the better one.
    const bright = sharpness(scene({ gain: 1.3 }), N, N);
    const dark = sharpness(scene({ gain: 0.7 }), N, N);
    expect(dark).toBeGreaterThan(bright * 0.8);
  });
});

describe("photos with nothing in them", () => {
  it("scores a flat frame as no contrast at all", () => {
    expect(contrastOf(new Uint8Array(N * N).fill(128))).toBe(0);
    expect(contrastOf(new Uint8Array(0))).toBe(0);
    expect(contrastOf(scene())).toBeGreaterThan(MIN_CONTRAST);
  });

  it("builds a signature of all three parts in one pass", () => {
    const sig = signatureOf(scene(), N, N);
    expect(sig.thumb).toHaveLength(128);
    expect(sig.sharpness).toBeGreaterThan(0);
    expect(sig.contrast).toBeGreaterThan(MIN_CONTRAST);
  });
});

// ---------------------------------------------------------------------------

type Photo = DedupeCandidate & { id: string };

const at = (m: number, s = 0) => new Date(2024, 6, 1, 10, m, s).getTime();

const photo = (
  id: string,
  gray: Uint8Array,
  takenAt: number,
  px = 4032,
): Photo => {
  const sig = signatureOf(gray, N, N);
  return { id, takenAt, w_px: px, h_px: (px * 3) / 4, ...sig };
};

describe("grouping a burst", () => {
  it("keeps one of five attempts at the same shot", () => {
    const burst = [
      photo("a", scene(), at(0, 0)),
      photo("b", scene({ dx: 1 }), at(0, 2)),
      photo("c", scene({ dx: 2, dy: 1 }), at(0, 4)),
      photo("d", scene({ gain: 1.2 }), at(0, 6)),
      photo("e", scene({ dx: 4, dy: 2 }), at(0, 8)),
    ];
    const r = dedupe(burst);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(4);
    expect(r.bursts).toBe(1);
  });

  it("leaves genuinely different photographs alone", () => {
    const r = dedupe([
      photo("a", scene(), at(0)),
      photo("b", scene({ horizon: 28, towerX: 44, towerW: 6, towerH: 26, sunX: 10 }), at(1)),
      photo("c", scene({ horizon: 20, towerX: 5, towerW: 22, towerH: 14, sunX: 30, dy: 6 }), at(2)),
    ]);
    expect(r.kept).toHaveLength(3);
    expect(r.dropped).toEqual([]);
    expect(r.bursts).toBe(0);
  });

  it("will not join two shots of the same thing taken hours apart", () => {
    // The same view in the morning and again at sunset is two photographs of
    // a trip, not one photograph taken twice.
    const r = dedupe([
      photo("morning", scene(), at(0)),
      photo("evening", scene({ dx: 1 }), at(0) + 8 * 3600_000),
    ]);
    expect(r.kept.map((p) => p.id)).toEqual(["morning", "evening"]);
  });

  it("holds a long burst together across the window", () => {
    // Each is within the window of the one before, so a burst spanning more
    // than two minutes in total still reads as one burst.
    const r = dedupe([
      photo("a", scene(), at(0)),
      photo("b", scene({ dx: 1 }), at(1)),
      photo("c", scene({ dx: 2 }), at(2)),
      photo("d", scene({ dx: 1, dy: 1 }), at(3)),
    ]);
    expect(r.kept).toHaveLength(1);
  });

  it("does not let a slow tilt chain into one cluster", () => {
    // Four frames tilting up the same view. Every consecutive pair is well
    // inside the threshold, so chaining each to the one before would swallow
    // the lot; the first and last are not the same shot at all.
    const frames = [0, 4, 8, 12].map((dy) => scene({ dy }));
    for (let i = 1; i < frames.length; i++) {
      expect(dist(frames[i - 1], frames[i])).toBeLessThan(MAX_DISTANCE);
    }
    expect(dist(frames[0], frames[3])).toBeGreaterThan(MAX_DISTANCE);

    // Comparing against the anchor instead is what stops the drift.
    const groups = clusterDuplicates(
      frames.map((g, i) => photo(`f${i}`, g, at(0, i * 2))),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].keep.id).toBe("f0");
    expect(groups[1].keep.id).toBe("f3");
  });

  it("never calls two blank frames duplicates", () => {
    // Normalising a flat frame leaves noise, so every blank resembles every
    // other. Throwing one away on that basis would be a bug, not a feature.
    const blank = new Uint8Array(N * N).fill(128);
    const r = dedupe([photo("x", blank, at(0)), photo("y", blank, at(0, 1))]);
    expect(r.kept).toHaveLength(2);
    expect(r.unusable).toBe(true);
  });

  it("stands a photo with no signature on its own, and lets it break a burst", () => {
    const noSig: Photo = { id: "old", takenAt: at(0, 3), w_px: 3000, h_px: 2000 };
    const r = dedupe([
      photo("a", scene(), at(0, 0)),
      noSig,
      photo("b", scene({ dx: 1 }), at(0, 6)),
    ]);
    expect(r.kept.map((p) => p.id)).toEqual(["a", "old", "b"]);
    expect(r.unusable).toBe(false);
  });

  it("does nothing to an empty list", () => {
    const r = dedupe([]);
    expect(r).toEqual({ kept: [], dropped: [], bursts: 0, unusable: false });
  });
});

describe("which one of a burst to keep", () => {
  const cand = (id: string, sharp: number, px = 4032): Photo => ({
    id, takenAt: at(0), w_px: px, h_px: (px * 3) / 4, thumb: "ab".repeat(64),
    sharpness: sharp, contrast: 30,
  });

  it("keeps the sharpest", () => {
    expect(pickKeeper([cand("soft", 0.02), cand("sharp", 0.08), cand("mid", 0.05)]).id)
      .toBe("sharp");
  });

  it("keeps the bigger one when sharpness is a coin toss", () => {
    // Within 5% is measurement noise, not a judgement about the photograph.
    expect(pickKeeper([cand("small", 0.051, 2000), cand("big", 0.05, 4032)]).id).toBe("big");
  });

  it("keeps the first when there is nothing to choose between them", () => {
    expect(pickKeeper([cand("first", 0.05), cand("second", 0.05)]).id).toBe("first");
  });

  it("copes with photos that have no sharpness recorded", () => {
    const bare: Photo = { id: "bare", takenAt: at(0), w_px: 100, h_px: 100 };
    expect(pickKeeper([bare, cand("real", 0.05)]).id).toBe("real");
  });
});
