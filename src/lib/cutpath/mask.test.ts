import { describe, expect, it } from "vitest";
import {
  buildMask,
  cornerColour,
  hasUsefulAlpha,
  maskFromAlpha,
  maskFromBackground,
  medianFilter3,
} from "./mask";
import type { Rgba } from "./mask";
import { cleanMask, detectMerged, dropSmallComponents, fillHoles, labelComponents } from "./clean";
import { close, dilate, distanceToSet, erode, open } from "./edt";
import { newMask } from "./types";
import type { Mask } from "./types";

const blank = (w: number, h: number, rgb: [number, number, number] = [255, 255, 255]): Rgba => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, w, h };
};

const paint = (img: Rgba, x: number, y: number, rgb: [number, number, number], a = 255) => {
  const o = (y * img.w + x) * 4;
  img.data[o] = rgb[0];
  img.data[o + 1] = rgb[1];
  img.data[o + 2] = rgb[2];
  img.data[o + 3] = a;
};

const disc = (img: Rgba, cx: number, cy: number, r: number, rgb: [number, number, number]) => {
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) paint(img, x, y, rgb);
    }
  }
};

const maskDisc = (w: number, h: number, cx: number, cy: number, r: number): Mask => {
  const m = newMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) m.data[y * w + x] = 1;
    }
  }
  return m;
};

const count = (m: Mask) => m.data.reduce((n, v) => n + v, 0);

describe("exact distance transform", () => {
  it("measures true Euclidean distance, not city blocks", () => {
    const m = newMask(9, 9);
    m.data[4 * 9 + 4] = 1;
    const d = distanceToSet(m);
    expect(d[4 * 9 + 4]).toBe(0);
    expect(d[4 * 9 + 7]).toBeCloseTo(3, 9);
    // A diamond metric would call this 6; it is 3*sqrt(2).
    expect(d[7 * 9 + 7]).toBeCloseTo(Math.sqrt(18), 9);
  });

  it("dilates into a circle, not a square", () => {
    const m = newMask(21, 21);
    m.data[10 * 21 + 10] = 1;
    const grown = dilate(m, 5);
    // Straight out is inside; the diagonal at the same radius is not.
    expect(grown.data[10 * 21 + 15]).toBe(1);
    expect(grown.data[15 * 21 + 15]).toBe(0);
  });

  it("erode then dilate returns a disc close to where it started", () => {
    const m = maskDisc(41, 41, 20, 20, 14);
    const back = dilate(erode(m, 3), 3);
    const before = count(m);
    const after = count(back);
    expect(Math.abs(after - before) / before).toBeLessThan(0.05);
  });

  it("opening removes a speckle and leaves the body alone", () => {
    const m = maskDisc(41, 41, 20, 20, 12);
    m.data[2 * 41 + 2] = 1;
    m.data[2 * 41 + 3] = 1;
    const opened = open(m, 2);
    expect(opened.data[2 * 41 + 2]).toBe(0);
    expect(opened.data[20 * 41 + 20]).toBe(1);
  });

  it("closing fills a pinhole", () => {
    const m = maskDisc(41, 41, 20, 20, 14);
    m.data[20 * 41 + 20] = 0;
    m.data[20 * 41 + 21] = 0;
    expect(close(m, 2).data[20 * 41 + 20]).toBe(1);
  });

  it("treats the image border as outside, so an edge-touching shape still erodes", () => {
    const m = newMask(10, 10);
    m.data.fill(1);
    const e = erode(m, 2);
    expect(e.data[0]).toBe(0);
    expect(e.data[5 * 10 + 5]).toBe(1);
  });
});

describe("P1 — mask", () => {
  it("kills salt-and-pepper noise without moving the edge", () => {
    const img = blank(21, 21);
    disc(img, 10, 10, 6, [20, 20, 20]);
    // Two stray light pixels inside, two stray dark ones outside.
    paint(img, 10, 10, [250, 250, 250]);
    paint(img, 2, 2, [10, 10, 10]);
    const out = medianFilter3(img);
    expect(out.data[(10 * 21 + 10) * 4]).toBeLessThan(60);
    expect(out.data[(2 * 21 + 2) * 4]).toBeGreaterThan(200);
    // The edge of the disc is still where it was. Sampled a pixel clear of the
    // boundary either side — on the boundary itself a median may legitimately
    // fall either way, which is not what this test is about.
    expect(out.data[(10 * 21 + 6) * 4]).toBeLessThan(60);
    expect(out.data[(10 * 21 + 17) * 4]).toBeGreaterThan(200);
  });

  it("uses alpha when there is alpha to use", () => {
    const opaque = blank(4, 4);
    expect(hasUsefulAlpha(opaque)).toBe(false);
    const transparent = blank(4, 4);
    transparent.data[3] = 0;
    expect(hasUsefulAlpha(transparent)).toBe(true);
  });

  it("thresholds alpha where told to", () => {
    const img = blank(3, 1);
    img.data[3] = 0;
    img.data[7] = 128;
    img.data[11] = 255;
    expect(Array.from(maskFromAlpha(img, 0.5).data)).toEqual([0, 1, 1]);
    expect(Array.from(maskFromAlpha(img, 0.8).data)).toEqual([0, 0, 1]);
    expect(Array.from(maskFromAlpha(img, 0.2).data)).toEqual([0, 1, 1]);
  });

  it("reads the background colour from the corners", () => {
    const img = blank(8, 8, [250, 248, 245]);
    disc(img, 4, 4, 2, [10, 20, 30]);
    expect(cornerColour(img)).toEqual([250, 248, 245]);
  });

  it("strips a painted-on near-white border — the whole point of the feature", () => {
    // Artwork: a dark disc of radius 6, wrapped in a wobbly near-white ring out
    // to radius 10, on a white page. The ring is the fake border.
    const img = blank(41, 41);
    disc(img, 20, 20, 10, [246, 245, 244]);
    disc(img, 20, 20, 6, [30, 40, 50]);

    const low = maskFromBackground(img, 0.01);
    const high = maskFromBackground(img, 0.12);

    // At a tight tolerance the fake border survives and gets traced.
    expect(low.data[20 * 41 + 28]).toBe(1);
    // At the default it is eaten, and only the artwork proper remains.
    expect(high.data[20 * 41 + 28]).toBe(0);
    expect(high.data[20 * 41 + 20]).toBe(1);
    expect(high.data[20 * 41 + 24]).toBe(1);
  });

  it("does not creep through a gradient into the artwork", () => {
    // A ramp from white at the left to black at the right. Comparing each pixel
    // to its neighbour would let the fill walk the whole way across.
    const img = blank(64, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 64; x++) {
        const v = 255 - Math.round((x / 63) * 255);
        paint(img, x, y, [v, v, v]);
      }
    }
    const m = maskFromBackground(img, 0.12);
    expect(m.data[4 * 64 + 60]).toBe(1);
  });

  it("only fills from the outside, so an enclosed light region survives", () => {
    const img = blank(41, 41);
    disc(img, 20, 20, 14, [30, 30, 30]);
    disc(img, 20, 20, 4, [252, 252, 252]);
    const m = maskFromBackground(img, 0.12);
    // The pale middle is not reachable from a corner, so it stays artwork.
    expect(m.data[20 * 41 + 20]).toBe(1);
  });

  it("says so when the tolerance has eaten everything", () => {
    const img = blank(32, 32);
    disc(img, 16, 16, 8, [240, 240, 240]);
    const r = buildMask(img, { edgeThreshold: 0.5, backgroundTolerance: 0.9 });
    expect(r.source).toBe("background");
    expect(r.warnings.join(" ")).toMatch(/eating the artwork/);
  });

  it("says so when the artwork bleeds off every edge", () => {
    // A sticker pasted right up to the frame: the only background left is the
    // four corner arcs. There is nothing to flood, so nothing can be traced.
    const img = blank(128, 128);
    const r = 12;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const cx = Math.min(Math.max(x, r), 127 - r);
        const cy = Math.min(Math.max(y, r), 127 - r);
        if (Math.hypot(x - cx, y - cy) <= r) paint(img, x, y, [30, 30, 30]);
      }
    }
    const report = buildMask(img, { edgeThreshold: 0.5, backgroundTolerance: 0.12 });
    expect(report.coverage).toBeGreaterThan(0.985);
    expect(report.warnings.join(" ")).toMatch(/no background/);
  });
});

describe("P2 — clean", () => {
  it("labels each sticker separately", () => {
    const m = newMask(40, 12);
    for (const cx of [6, 20, 34]) {
      for (let y = 4; y < 8; y++) for (let x = cx - 2; x <= cx + 2; x++) m.data[y * 40 + x] = 1;
    }
    expect(labelComponents(m).count).toBe(3);
  });

  it("drops debris but keeps every real sticker", () => {
    const m = newMask(60, 20);
    for (const cx of [10, 30, 50]) {
      for (let y = 5; y < 15; y++) for (let x = cx - 5; x <= cx + 5; x++) m.data[y * 60 + x] = 1;
    }
    m.data[1 * 60 + 1] = 1; // a speck
    const { mask, dropped } = dropSmallComponents(m);
    expect(dropped).toBe(1);
    expect(labelComponents(mask).count).toBe(3);
  });

  it("fills the hole in a donut, because that is not where you cut", () => {
    const m = maskDisc(41, 41, 20, 20, 14);
    for (let y = 0; y < 41; y++) {
      for (let x = 0; x < 41; x++) {
        if (Math.hypot(x - 20, y - 20) <= 5) m.data[y * 41 + x] = 0;
      }
    }
    expect(m.data[20 * 41 + 20]).toBe(0);
    expect(fillHoles(m).data[20 * 41 + 20]).toBe(1);
  });

  it("keeps the hole when you ask it to", () => {
    const m = maskDisc(41, 41, 20, 20, 14);
    for (let y = 0; y < 41; y++) {
      for (let x = 0; x < 41; x++) {
        if (Math.hypot(x - 20, y - 20) <= 5) m.data[y * 41 + x] = 0;
      }
    }
    const kept = cleanMask(m, { smoothing: 0, keepHoles: true });
    expect(kept.mask.data[20 * 41 + 20]).toBe(0);
  });

  it("warns when stickers have merged into one blob", () => {
    const m = newMask(80, 20);
    // Three small ones and one that is clearly two stuck together.
    for (const [x0, x1] of [
      [2, 8],
      [14, 20],
      [26, 32],
      [40, 78],
    ]) {
      for (let y = 5; y < 15; y++) for (let x = x0; x <= x1; x++) m.data[y * 80 + x] = 1;
    }
    expect(detectMerged(m).join(" ")).toMatch(/trace as one path/);
  });

  it("stays quiet when the stickers are all a sensible size", () => {
    const m = newMask(80, 20);
    for (const cx of [10, 30, 50, 70]) {
      for (let y = 5; y < 15; y++) for (let x = cx - 5; x <= cx + 5; x++) m.data[y * 80 + x] = 1;
    }
    expect(detectMerged(m)).toEqual([]);
  });
});
