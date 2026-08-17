import { describe, expect, it } from "vitest";
import { runCutPath } from "./pipeline";
import { DEFAULT_CUTPATH } from "./types";
import type { CutPathSettings } from "./types";
import { buildMask } from "./mask";
import type { Rgba } from "./mask";
import { amputationRatio, flatField, gradientMagnitude, lumaOf } from "./ink";
import { boundsOf } from "./trace";

/**
 * An illustrated sticker sheet: sepia artwork on aged cream paper, every
 * element ringed by a drawn outline, and pale fur that is all but the same
 * tone as the paper it sits on.
 *
 * Colours sampled off a real sheet. The pale fur is 2.5% from the paper, which
 * is the number the whole problem turns on.
 */
const PAPER: [number, number, number] = [242, 230, 208];
const INK: [number, number, number] = [95, 62, 32];
const MID: [number, number, number] = [186, 140, 88];
const PALE: [number, number, number] = [237, 224, 200];

type Opts = { vignette?: number; outlines?: boolean };

const sheet = (w: number, h: number, o: Opts = {}): Rgba => {
  const vignette = o.vignette ?? 0;
  const outlines = o.outlines ?? true;
  const data = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Aged paper darkens towards the edges; a scan adds its own gradient.
      const d = Math.hypot(x / w - 0.5, y / h - 0.5) / 0.7;
      const k = 1 - vignette * d;
      const i = (y * w + x) * 4;
      data[i] = PAPER[0] * k;
      data[i + 1] = PAPER[1] * k;
      data[i + 2] = PAPER[2] * k;
      data[i + 3] = 255;
    }
  }

  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o2 = (Math.round(y) * w + Math.round(x)) * 4;
    data[o2] = c[0];
    data[o2 + 1] = c[1];
    data[o2 + 2] = c[2];
  };

  /** A filled ellipse, optionally ringed the way an ink illustration is. */
  const blob = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    c: [number, number, number],
  ) => {
    for (let y = cy - ry - 2; y <= cy + ry + 2; y++) {
      for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
        const t = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (t <= 1) put(x, y, c);
        else if (outlines && t <= 1.06) put(x, y, INK); // the drawn edge
      }
    }
  };

  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      const cx = 130 + c * 190;
      const cy = 150 + r * 220;
      blob(cx, cy, 62, 44, MID);
      blob(cx - 40, cy - 26, 24, 20, INK);
      // The pale tail: 17 mm long at 180 mm across, and the same tone as paper.
      blob(cx + 52, cy - 10, 34, 18, PALE);
    }
  }

  // The dotted rule the sheet is framed with.
  for (let x = 20; x < w - 20; x += 6) {
    put(x, 20, INK);
    put(x, h - 20, INK);
  }
  for (let y = 20; y < h - 20; y += 6) {
    put(20, y, INK);
    put(w - 20, y, INK);
  }

  return { data, w, h };
};

const settings = (o: Partial<CutPathSettings> = {}): CutPathSettings => ({
  ...DEFAULT_CUTPATH,
  width_mm: 180,
  ...o,
});

/** The widest single sticker — the tail is what makes this number move. */
const widest = (r: ReturnType<typeof runCutPath>) =>
  Math.max(0, ...r.polys.map((p) => boundsOf([p]).w));

/**
 * Body plus tail, outlines included, spans about 151 px of 700 at 180 mm
 * across, and the 2 mm border either side makes roughly 43.
 */
const WITH_TAIL_MM = 43;
/** Head to body only, same border. */
const WITHOUT_TAIL_MM = 36.5;

/**
 * Everything here is asserted to a millimetre, which is the spec's own bar for
 * a cut path. Tighter would be false precision: the mask is sampled on a pixel
 * grid, and the ink route's gradient reaches a pixel past the drawn line, so
 * the path legitimately encloses the outline and its anti-aliased edge.
 */
const expectMm = (actual: number, expected: number, what: string) => {
  expect(Math.abs(actual - expected), `${what}: ${actual.toFixed(2)} vs ${expected} mm`)
    .toBeLessThanOrEqual(1);
};

describe("flat field", () => {
  it("puts the paper at 1.0 whether or not it is evenly lit", () => {
    for (const vignette of [0, 0.15]) {
      const img = sheet(700, 1000, { vignette });
      const corrected = flatField(lumaOf(img), img.w, img.h);
      // A corner and the middle of the paper both read as paper afterwards.
      expect(corrected[30 * 700 + 60], `vignette ${vignette}`).toBeGreaterThan(0.9);
      expect(corrected[500 * 700 + 350], `vignette ${vignette}`).toBeGreaterThan(0.9);
    }
  });

  it("still puts ink well below the paper", () => {
    const img = sheet(700, 1000, { vignette: 0.15 });
    const corrected = flatField(lumaOf(img), img.w, img.h);
    // Centre of a head, which is solid ink.
    expect(corrected[124 * 700 + 90]).toBeLessThan(0.7);
  });
});

describe("gradient", () => {
  it("finds a drawn outline and ignores flat fill", () => {
    const img = sheet(700, 1000);
    const g = gradientMagnitude(flatField(lumaOf(img), img.w, img.h), img.w, img.h);
    const at = (x: number, y: number) => g[y * 700 + x];
    // Open paper, well clear of anything.
    expect(at(660, 500)).toBeLessThan(0.02);
    // The pale tail's outline: strong, even though the fill either side of it
    // is nearly the same tone.
    const alongTail = Array.from({ length: 40 }, (_, i) => at(180 + 36 + i, 140));
    expect(Math.max(...alongTail)).toBeGreaterThan(0.05);
  });
});

describe("the sheet the paper route cannot do", () => {
  it("amputates the pale tail, and the sticker count does not show it", () => {
    const img = sheet(700, 1000);

    const tight = runCutPath(img, settings({ backgroundTolerance: 0.02 }));
    const loose = runCutPath(img, settings({ backgroundTolerance: 0.12 }));

    // Both find every sticker. Only one of them finds all of each sticker.
    expect(tight.stats.stickers).toBe(12);
    expect(loose.stats.stickers).toBe(12);
    expect(tight.stats.nodes).toBeGreaterThan(0);

    expectMm(widest(tight), WITH_TAIL_MM, "tight tolerance keeps the tail");
    expectMm(widest(loose), WITHOUT_TAIL_MM, "loose tolerance loses it");
    // Roughly 7 mm off a 42 mm sticker, with nothing in the readout to say so.
    expect(widest(tight) - widest(loose)).toBeGreaterThan(6);
  });

  it("says so out loud, since nothing else would", () => {
    const img = sheet(700, 1000);
    const r = runCutPath(img, settings({ backgroundTolerance: 0.12 }));
    const said = r.stats.warnings.join(" ");
    expect(said).toMatch(/being eaten by the flood fill/);
    expect(said).toMatch(/sticker count will not show this/);
    expect(said).toMatch(/Ink route/);
  });

  it("stays quiet on artwork that does not share a tone with its paper", () => {
    // A plain dark sticker on white: nothing to amputate, nothing to say.
    const w = 200;
    const h = 200;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 100, y - 100) <= 60) {
          const o = (y * w + x) * 4;
          data[o] = 40;
          data[o + 1] = 60;
          data[o + 2] = 90;
        }
      }
    }
    const r = buildMask({ data, w, h }, { edgeThreshold: 0.5, backgroundTolerance: 0.12 });
    expect(r.warnings).toEqual([]);
  });
});

describe("the ink route", () => {
  it("keeps the pale tail, because it is inside an outline", () => {
    const img = sheet(700, 1000);
    const r = runCutPath(img, settings({ route: "ink" }));

    expect(r.stats.source).toBe("ink");
    expect(r.stats.stickers).toBe(12);
    // Whole sticker, tail and all — which no tolerance on the paper route got
    // without also being too tight to clear the paper reliably.
    expectMm(widest(r), WITH_TAIL_MM, "ink route keeps the tail");
    expect(r.stats.warnings).toEqual([]);
  });

  it("survives paper that darkens at the edges, where the flood fill welds", () => {
    const img = sheet(700, 1000, { vignette: 0.15 });

    const paper = runCutPath(img, settings({ route: "paper", backgroundTolerance: 0.12 }));
    const ink = runCutPath(img, settings({ route: "ink" }));

    // The flood fill cannot reach the lighter middle from a darker corner, so
    // unreached paper becomes artwork and shapes weld together.
    expect(paper.stats.stickers).toBeLessThan(12);
    // The ink route divides the paper out first, so the vignette is not there.
    expect(ink.stats.stickers).toBe(12);
    expectMm(widest(ink), WITH_TAIL_MM, "ink route through a vignette");
  });

  it("does not need the artwork to be darker than the paper anywhere", () => {
    // Every fill the same tone as the paper; only the outlines separate them.
    const w = 400;
    const h = 400;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = PALE[0];
      data[i * 4 + 1] = PALE[1];
      data[i * 4 + 2] = PALE[2];
      data[i * 4 + 3] = 255;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = ((x - 200) / 120) ** 2 + ((y - 200) / 90) ** 2;
        if (t > 0.94 && t <= 1) {
          const o = (y * w + x) * 4;
          data[o] = INK[0];
          data[o + 1] = INK[1];
          data[o + 2] = INK[2];
        }
      }
    }
    const r = runCutPath({ data, w, h }, settings({ route: "ink", width_mm: 100 }));
    expect(r.stats.stickers).toBe(1);
    // 240 px of 400 at 100 mm, plus a 2 mm border either side.
    expectMm(boundsOf(r.polys).w, 64, "outline-only shape");
  });

  it("reports the amputation as a fraction, not a vibe", () => {
    const img = sheet(700, 1000);
    const loose = buildMask(img, { edgeThreshold: 0.5, backgroundTolerance: 0.12 });
    const tight = buildMask(img, { edgeThreshold: 0.5, backgroundTolerance: 0.015 });
    expect(amputationRatio(loose.mask, tight.mask)).toBeGreaterThan(0.04);
    expect(amputationRatio(tight.mask, tight.mask)).toBe(0);
  });
});
