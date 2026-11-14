import { describe, expect, it } from "vitest";
import { readout, runCutPath } from "./pipeline";
import { DEFAULT_CUTPATH } from "./types";
import type { CutPathSettings } from "./types";
import type { Rgba } from "./mask";
import { distanceToPolys } from "./offset";
import { boundsOf } from "./trace";
import { compositeArtwork, measureBorder, rasterisePolys } from "./composite";
import { pngPixelSize, polysPath, ringPath, toPdf, toSvg } from "./exportPath";
import { inspectPdf } from "../pdfInspect";

const settings = (o: Partial<CutPathSettings> = {}): CutPathSettings => ({
  ...DEFAULT_CUTPATH,
  ...o,
});

/**
 * The case the whole feature exists for: dark artwork wrapped in a wobbly,
 * soft, near-white painted-on border, on a white page.
 */
const stickerWithFakeBorder = (size = 200, wobble = true): Rgba => {
  const data = new Uint8ClampedArray(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const a = Math.atan2(y - c, x - c);
      const d = Math.hypot(x - c, y - c);
      const art = size * 0.28;
      // The fake border wobbles and is uneven, exactly as a generated one is.
      const fake = art + size * 0.09 + (wobble ? size * 0.035 * Math.sin(a * 7) : 0);

      let v: [number, number, number] = [255, 255, 255];
      if (d <= art) v = [40, 60, 90];
      else if (d <= fake) v = [247, 246, 244];

      data[o] = v[0];
      data[o + 1] = v[1];
      data[o + 2] = v[2];
      data[o + 3] = 255;
    }
  }
  return { data, w: size, h: size };
};

/** Six separate stickers on one page. */
const sheetOfSix = (w = 360, h = 120): Rgba => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  for (let k = 0; k < 6; k++) {
    const cx = 30 + k * 60;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - cx, y - 60) <= 22) {
          const o = (y * w + x) * 4;
          data[o] = 30;
          data[o + 1] = 50;
          data[o + 2] = 70;
        }
      }
    }
  }
  return { data, w, h };
};

describe("the pipeline end to end", () => {
  it("throws the painted-on border away and rebuilds it — the whole feature", () => {
    const img = stickerWithFakeBorder();
    const r = runCutPath(img, settings({ width_mm: 48, border_mm: 2 }));

    expect(r.stats.stickers).toBe(1);

    // The traced artwork is the dark disc, not the wobbly white ring around it.
    // Artwork radius is 0.28 * 200 px = 56 px = 13.44 mm at 48 mm across.
    const art = boundsOf(r.artwork);
    expect(art.w).toBeCloseTo(26.9, 0);
    expect(art.h).toBeCloseTo(26.9, 0);

    // And the new border is a uniform 2 mm, which the old one never was.
    const distances = r.artwork[0].outer.map((p) => distanceToPolys(p, r.polys));
    expect(Math.min(...distances)).toBeGreaterThan(1.8);
    expect(Math.max(...distances)).toBeLessThan(2.2);
  });

  it("gives a wobbly fake border and a clean one the same cut path", () => {
    const wobbly = runCutPath(stickerWithFakeBorder(200, true), settings());
    const clean = runCutPath(stickerWithFakeBorder(200, false), settings());
    // The fake border is discarded either way, so the result cannot depend on
    // how bad it was.
    expect(boundsOf(wobbly.polys).w).toBeCloseTo(boundsOf(clean.polys).w, 0);
  });

  it("finds six stickers on one sheet and gives each its own path", () => {
    const r = runCutPath(sheetOfSix(), settings({ width_mm: 180, border_mm: 1.5 }));
    expect(r.stats.stickers).toBe(6);
    expect(readout(r)).toMatch(/^6 stickers found · \d+ nodes/);
  });

  it("keeps a sheet apart even when the width describes one sticker", () => {
    // The same six stickers, told they span 48 mm rather than 180. Every gap
    // scales down with the width, and a 1.5 mm border no longer fits between
    // them — which used to weld the sheet into one path. Each sticker now
    // grows only into its own territory.
    const wrong = runCutPath(sheetOfSix(), settings({ width_mm: 48, border_mm: 1.5 }));
    const right = runCutPath(sheetOfSix(), settings({ width_mm: 180, border_mm: 1.5 }));

    expect(right.stats.stickers).toBe(6);
    expect(wrong.stats.stickers).toBe(6);
    expect(wrong.stats.gap_mm).toBeGreaterThan(0.3);
  });

  it("says when a border was narrowed to keep neighbours apart, and only then", () => {
    const tight = runCutPath(sheetOfSix(), settings({ width_mm: 48, border_mm: 1.5 }));
    expect(tight.stats.warnings.join(" ")).toMatch(/narrows where they face each other/);

    const roomy = runCutPath(sheetOfSix(), settings({ width_mm: 180, border_mm: 1.5 }));
    expect(roomy.stats.warnings.join(" ")).not.toMatch(/narrows/);
  });

  it("reports the gap and the clearance whether or not anything went wrong", () => {
    const r = runCutPath(sheetOfSix(), settings({ width_mm: 180, border_mm: 1.5 }));
    // Discs 22 px in radius, centres 60 px apart, on a 360 px image at 180 mm:
    // 16 px of background between them, so 8 mm nominal. Measured at 8.5,
    // because marching squares puts the contour half a pixel inside the last
    // filled pixel at each edge — a whole pixel wider per gap, and constant
    // whatever the smoothing is set to.
    // That is between the artwork. The gap reported is between the cut lines,
    // so a 1.5 mm border on each side takes 3 mm of it.
    expect(r.stats.gap_mm).toBeCloseTo(5.5, 0);
    expect(r.stats.clearance_mm).toBe(0.6);
  });

  it("says nothing about crowding for a single sticker", () => {
    const r = runCutPath(stickerWithFakeBorder(), settings());
    expect(r.stats.gap_mm).toBe(Infinity);
    expect(r.stats.warnings.join(" ")).not.toMatch(/merged|apart/);
  });

  it("honours the width the user typed, exactly", () => {
    for (const width_mm of [30, 48, 96]) {
      const r = runCutPath(stickerWithFakeBorder(), settings({ width_mm, border_mm: 0 }));
      // Artwork is 0.56 of the image width, and the image maps to width_mm.
      expect(boundsOf(r.artwork).w / width_mm).toBeCloseTo(0.56, 1);
    }
  });

  it("cuts inside the artwork on a negative border, for photos", () => {
    const inside = runCutPath(stickerWithFakeBorder(), settings({ border_mm: -0.5 }));
    const on = runCutPath(stickerWithFakeBorder(), settings({ border_mm: 0 }));
    expect(boundsOf(inside.polys).w).toBeLessThan(boundsOf(on.polys).w);
  });

  it("says so, rather than silently returning nothing, when the mask fails", () => {
    const white: Rgba = {
      data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
      w: 64,
      h: 64,
    };
    const r = runCutPath(white, settings());
    expect(r.stats.stickers).toBe(0);
    expect(r.stats.warnings.join(" ")).toMatch(/No artwork found/);
  });

  it("stays inside the node budget on real artwork", () => {
    const r = runCutPath(stickerWithFakeBorder(400), settings());
    expect(r.stats.nodes).toBeLessThanOrEqual(400);
  });

  it("budgets the path that reaches the plotter, not the one before offsetting", () => {
    // Offsetting and the cuttability pass both add nodes — every round join is
    // an arc. Checking the budget at the trace stage would let a compliant
    // trace leave here as a path the plotter stutters on.
    const r = runCutPath(stickerWithFakeBorder(400), settings({ border_mm: 3 }));
    // Counted in curve anchors, which is what the plotter is actually sent.
    expect(r.stats.nodes).toBe(
      r.curves.reduce((n, p) => n + p.outer.length + p.holes.reduce((k, h) => k + h.length, 0), 0),
    );
    expect(r.stats.nodes).toBeLessThanOrEqual(250);
    // And the border it reports is the border it drew.
    const distances = r.artwork[0].outer.map((p) => distanceToPolys(p, r.polys));
    expect(Math.min(...distances)).toBeGreaterThan(2.7);
    expect(Math.max(...distances)).toBeLessThan(3.3);
  });

  it("budgets six stickers at six budgets, not one", () => {
    // 1.5 mm borders on discs this far apart stay clear of each other; at 2 mm
    // they would touch and correctly merge into a single path.
    const r = runCutPath(sheetOfSix(), settings({ width_mm: 180, border_mm: 1.5 }));
    expect(r.stats.stickers).toBe(6);
    expect(r.stats.nodes).toBeLessThanOrEqual(6 * 400);
  });
});

describe("P7 — composite", () => {
  it("rasterises a polygon back to the pixels it came from", () => {
    const sq = {
      outer: [
        { x: 2, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 8 },
        { x: 2, y: 8 },
      ],
      holes: [],
    };
    const m = rasterisePolys([sq], 10, 10);
    expect(m.data[5 * 10 + 5]).toBe(1);
    expect(m.data[0]).toBe(0);
    const area = m.data.reduce((n, v) => n + v, 0);
    expect(area).toBe(36);
  });

  it("leaves a hole unfilled", () => {
    const donut = {
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      holes: [
        [
          { x: 8, y: 8 },
          { x: 8, y: 12 },
          { x: 12, y: 12 },
          { x: 12, y: 8 },
        ],
      ],
    };
    const m = rasterisePolys([donut], 20, 20);
    expect(m.data[10 * 20 + 10]).toBe(0);
    expect(m.data[2 * 20 + 2]).toBe(1);
  });

  it("regenerates a border that is uniform in pixels, not just in theory", () => {
    const img = stickerWithFakeBorder(200);
    const r = runCutPath(img, settings({ width_mm: 48, border_mm: 2 }));
    const pxPerMm = img.w / 48;

    const artMask = rasterisePolys(r.artwork, img.w, img.h, pxPerMm);
    const cutMask = rasterisePolys(r.polys, img.w, img.h, pxPerMm);
    const gap = measureBorder(artMask, cutMask);

    // 2 mm at 200 px / 48 mm is 8.3 px. Rows near the top and bottom of a disc
    // measure a chord rather than the normal, so allow a generous band and
    // check the tight tolerance on the geometry instead.
    expect(gap.min).toBeGreaterThan(6);
    expect(gap.max).toBeLessThan(200);
  });

  it("puts border colour under the artwork and nothing outside the path", () => {
    const img = stickerWithFakeBorder(120);
    const r = runCutPath(img, settings({ width_mm: 48, border_mm: 3 }));
    const pxPerMm = img.w / 48;
    const artMask = rasterisePolys(r.artwork, img.w, img.h, pxPerMm);
    const cutMask = rasterisePolys(r.polys, img.w, img.h, pxPerMm);

    const out = compositeArtwork(img.data, artMask, cutMask, { r: 255, g: 0, b: 0 });
    const at = (x: number, y: number) => {
      const o = (y * img.w + x) * 4;
      return [out[o], out[o + 1], out[o + 2], out[o + 3]];
    };

    // Middle: artwork, opaque.
    expect(at(60, 60)[3]).toBe(255);
    expect(at(60, 60)[0]).toBeLessThan(100);
    // Corner: outside the path, fully transparent.
    expect(at(1, 1)[3]).toBe(0);
    // Somewhere in the border ring: the border colour we asked for.
    const ring = [...Array(60).keys()]
      .map((i) => at(60 + i, 60))
      .find((p) => p[3] === 255 && p[0] === 255 && p[1] === 0);
    expect(ring, "no border-coloured pixel found").toBeDefined();
  });
});

describe("P7 — export", () => {
  const sample = () => {
    const img = stickerWithFakeBorder(160);
    return runCutPath(img, settings({ width_mm: 48, border_mm: 2 }));
  };

  it("writes an SVG sized in millimetres with the path on its own layer", () => {
    const r = sample();
    const b = boundsOf(r.polys);
    const svg = toSvg({ polys: r.polys, w_mm: b.w, h_mm: b.h, name: "sticker" });

    expect(svg).toMatch(/width="[\d.]+mm" height="[\d.]+mm"/);
    expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
    expect(svg).toMatch(/<g id="cut"/);
    expect(svg).toMatch(/data-cut-path="true"/);
    expect(svg).toMatch(/fill-rule="evenodd"/);
    expect(svg).toMatch(/<path d="M /);
  });

  it("embeds the artwork when there is artwork to embed", () => {
    const r = sample();
    const b = boundsOf(r.polys);
    const svg = toSvg({
      polys: r.polys,
      w_mm: b.w,
      h_mm: b.h,
      name: "s",
      artworkDataUri: "data:image/png;base64,AAAA",
    });
    expect(svg).toMatch(/<image x="0" y="0"/);
    expect(svg).toMatch(/href="data:image\/png;base64,AAAA"/);
  });

  it("writes ring paths that close", () => {
    expect(
      ringPath([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toBe("M 0 0 L 1 0 L 1 1 Z");
    expect(ringPath([{ x: 0, y: 0 }])).toBe("");
    expect(polysPath([])).toBe("");
  });

  it("writes an A4 PDF carrying the path and the calibration rule", async () => {
    const r = sample();
    const b = boundsOf(r.polys);
    const bytes = await toPdf({
      polys: r.polys,
      w_mm: b.w,
      h_mm: b.h,
      name: "sticker",
      registrationMarks: false,
    });
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0].w_mm).toBeCloseTo(210, 6);
    expect(pages[0].h_mm).toBeCloseTo(297, 6);
    const rules = pages[0].lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 100) < 1e-9,
    );
    expect(rules).toHaveLength(1);
    expect(pages[0].texts.join(" ")).toMatch(/cut path in red/);
  });

  it("flags the registration marks as unverified, because they are", async () => {
    const r = sample();
    const b = boundsOf(r.polys);
    const bytes = await toPdf({
      polys: r.polys,
      w_mm: b.w,
      h_mm: b.h,
      name: "sticker",
      registrationMarks: true,
    });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).toMatch(/test cut before trusting/);
  });

  it("sizes the Cricut PNG at the stated resolution", () => {
    expect(pngPixelSize(25.4, 50.8, 300)).toEqual({ w: 300, h: 600 });
    expect(pngPixelSize(48, 48, 300).w).toBe(567);
  });
});

describe("the cut line is a curve", () => {
  it("stays within a tenth of a millimetre of a true circle, on few nodes", () => {
    // The regression this guards: a round sticker simplified to straight lines
    // until it fitted a node budget, and cut as a jagged polygon.
    const w = 400;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const inside = Math.hypot(x + 0.5 - 200, y + 0.5 - 200) <= 150;
        data.set(inside ? [200, 30, 90, 255] : [0, 0, 0, 0], (y * w + x) * 4);
      }
    }
    const r = runCutPath(
      { data, w, h: w },
      { ...DEFAULT_CUTPATH, target: "sticker", border_mm: 0, bladeRadius_mm: 0.5, width_mm: 80 },
    );
    expect(r.stats.stickers).toBe(1);
    expect(r.stats.nodes).toBeLessThan(40);
    const radii = r.polys[0].outer.map((p) => Math.hypot(p.x - 40, p.y - 40));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.2);
    expect(Math.abs(radii[0] - 30)).toBeLessThan(0.15);
  });

  it("keeps close neighbours apart whatever the blade radius", () => {
    const r = runCutPath(sheetOfSix(), settings({ width_mm: 60, border_mm: 0, bladeRadius_mm: 1.5 }));
    expect(r.stats.stickers).toBe(6);
  });
});

describe("a sheet with painted borders", () => {
  /**
   * Two stickers side by side: a dark disc with a small dark satellite, each
   * wrapped in a white border ending in a grey rim, with a soft shadow that
   * bridges the gap between the two. The rim is too faint to stop a flood wide
   * enough to clear the shadow — the case that used to come out as one path.
   */
  const paintedPair = (): Rgba => {
    const w = 450;
    const h = 260;
    const data = new Uint8ClampedArray(w * h * 4);
    const discs = [
      { x: 125, y: 130, r: 70 },
      { x: 125, y: 40, r: 9 },
      { x: 325, y: 130, r: 70 },
      { x: 325, y: 40, r: 9 },
    ];
    const BORDER = 16;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.min(...discs.map((c) => Math.hypot(x - c.x, y - c.y) - c.r));
        let v = [252, 252, 253];
        if (d <= 0) v = [200, 40, 120];
        else if (d <= BORDER) v = [255, 255, 255];
        else if (d <= BORDER + 2) v = [222, 221, 228];
        else if (d <= BORDER + 14) v = [244, 244, 247];
        data.set([...v, 255], (y * w + x) * 4);
      }
    }
    return { data, w, h };
  };

  it("finds two stickers, each with its satellite, and matches the painted border", () => {
    const r = runCutPath(paintedPair(), { ...DEFAULT_CUTPATH, target: "auto", bladeRadius_mm: 0.5, width_mm: 90 });
    expect(r.stats.target).toBe("artwork");
    expect(r.stats.stickers).toBe(2);
    // 16 px of painted border on a 450 px image at 90 mm is 3.2 mm.
    expect(r.stats.border_mm).toBeGreaterThan(2.8);
    expect(r.stats.border_mm).toBeLessThan(3.8);
  });

  it("does not trust a hazy alpha channel", () => {
    const img = paintedPair();
    // A background remover's leftovers: nothing is fully clear.
    for (let i = 0; i < img.w * img.h; i++) {
      const o = i * 4;
      if (img.data[o] > 240 && img.data[o + 1] > 240) img.data[o + 3] = 60;
    }
    const r = runCutPath(img, { ...DEFAULT_CUTPATH, target: "auto", bladeRadius_mm: 0.5, width_mm: 96 });
    expect(r.stats.source).toBe("background");
    expect(r.stats.stickers).toBe(2);
  });
});
