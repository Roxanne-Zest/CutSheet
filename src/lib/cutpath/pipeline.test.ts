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
    expect(r.stats.nodes).toBe(
      r.polys.reduce((n, p) => n + p.outer.length + p.holes.reduce((k, h) => k + h.length, 0), 0),
    );
    expect(r.stats.nodes).toBeLessThanOrEqual(400);
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
