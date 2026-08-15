import { describe, it, expect } from "vitest";
import type { PrintItem, Project } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { TEMPLATES, templateById } from "../data/layouts";
import { buildPrintItems } from "./printItems";
import { fillCrop } from "./geometry";
import { generatePdf } from "./pdf";
import type { RasterizeFn } from "./pdf";
import type { Source } from "./raster";
import { inspectPdf, tinyJpegBytes } from "./pdfInspect";
import { A4 } from "./units";

/**
 * S6 is the acceptance test for the product: print it, measure it. These read
 * the generated PDF back and measure the boxes it actually contains.
 */

/** Stands in for the canvas, so these tests measure the PDF and nothing else. */
const stubRasterize: RasterizeFn = async () => ({
  bytes: tinyJpegBytes(),
  widthPx: 1,
  heightPx: 1,
  dpi: 300,
});

const fakeSource = (): Source => ({
  bitmap: {} as CanvasImageSource,
  w_px: 4000,
  h_px: 3000,
});

const item = (
  id: string,
  w_mm: number,
  h_mm: number,
  over: Partial<PrintItem> = {},
): PrintItem => ({
  id,
  assetId: "asset-1",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  rotation: 0,
  straighten_deg: 0,
  w_mm,
  h_mm,
  shape: "rect",
  fromSpread: "sp1",
  fromSlot: "s1",
  copies: 1,
  label: id,
  ...over,
});

const emptyProject = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Test project",
  formatId: "a5",
  spreads: [],
  settings: { ...DEFAULT_SETTINGS },
  updatedAt: 0,
  ...over,
});

const run = async (project: Project, items: PrintItem[]) => {
  const sources = new Map<string, Source>();
  for (const i of items) sources.set(i.assetId, fakeSource());
  const res = await generatePdf({ project, items, sources, rasterize: stubRasterize });
  const pages = await inspectPdf(res.bytes);
  return { res, pages };
};

describe("S6 — dimensional accuracy", () => {
  it("a 54 mm photo measures 54 mm", async () => {
    const items = [item("P1", 54, 72)];
    const { pages } = await run(emptyProject(), items);
    const sheet = pages[pages.length - 1];
    expect(sheet.images).toHaveLength(1);
    expect(sheet.images[0].w_mm).toBeCloseTo(54, 9);
    expect(sheet.images[0].h_mm).toBeCloseTo(72, 9);
  });

  it("every photo box equals its chosen finished size, whatever the size", async () => {
    const sizes: Array<[number, number]> = [
      [54, 72], [90, 125], [38.1, 38.1], [148, 100], [25.4, 76.2],
      [110, 60], [62.5, 87.5], [30, 195],
    ];
    const items = sizes.map(([w, h], i) => item(`P${i + 1}`, w, h));
    const { pages } = await run(emptyProject(), items);

    const boxes = pages.flatMap((p) => p.images);
    expect(boxes).toHaveLength(sizes.length);

    for (const [w, h] of sizes) {
      const found = boxes.find(
        (b) =>
          (Math.abs(b.w_mm - w) < 1e-9 && Math.abs(b.h_mm - h) < 1e-9) ||
          (Math.abs(b.w_mm - h) < 1e-9 && Math.abs(b.h_mm - w) < 1e-9),
      );
      expect(found, `no box measuring ${w} x ${h} mm`).toBeDefined();
    }
  });

  it("keeps exact size when the packer rotates a photo", async () => {
    // Tall and narrow: only fits the 200 mm content width lying down.
    const items = [item("P1", 30, 195)];
    const { res, pages } = await run(emptyProject(), items);
    const placed = res.packResult.placements[0];
    expect(placed.rotated).toBe(true);

    const box = pages[pages.length - 1].images[0];
    expect(box.w_mm).toBeCloseTo(30, 9);
    expect(box.h_mm).toBeCloseTo(195, 9);
    expect(Math.abs(box.rotation_deg)).toBeCloseTo(90, 6);
  });

  it("every page is exactly A4", async () => {
    const { pages } = await run(emptyProject(), [item("P1", 54, 72)]);
    for (const p of pages) {
      expect(p.w_mm).toBeCloseTo(A4.w_mm, 9);
      expect(p.h_mm).toBeCloseTo(A4.h_mm, 9);
    }
  });

  it("adds the bleed ring to the printed box and leaves finished size alone", async () => {
    const project = emptyProject({
      settings: { ...DEFAULT_SETTINGS, bleed_mm: 0.3 },
    });
    const items = [item("P1", 54, 72)];
    const { pages } = await run(project, items);
    const box = pages[pages.length - 1].images[0];
    expect(box.w_mm).toBeCloseTo(54.6, 9);
    expect(box.h_mm).toBeCloseTo(72.6, 9);
    // The item's own finished size is untouched.
    expect(items[0].w_mm).toBe(54);
  });
});

describe("S6 — calibration ruler", () => {
  const rulerOn = (page: { lines: Array<{ length_mm: number; y1_mm: number; y2_mm: number }> }) =>
    page.lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 100) < 1e-9,
    );

  it("puts a 100.0 mm rule on every sheet", async () => {
    const items = Array.from({ length: 14 }, (_, i) => item(`P${i + 1}`, 90, 125));
    const { res, pages } = await run(emptyProject(), items);
    expect(res.sheets).toBeGreaterThan(1);

    const sheets = pages.slice(pages.length - res.sheets);
    expect(sheets).toHaveLength(res.sheets);
    for (const s of sheets) {
      expect(rulerOn(s), "sheet is missing its 100 mm rule").toHaveLength(1);
    }
  });

  it("the rule is exactly 100 mm, not 96 mm", async () => {
    // A fit-to-page scale of ~4% is the failure this guards against.
    const { pages } = await run(emptyProject(), [item("P1", 54, 72)]);
    const rule = rulerOn(pages[pages.length - 1])[0];
    expect(rule.length_mm).toBeCloseTo(100, 9);
    expect(rule.length_mm).not.toBeCloseTo(96, 1);
  });
});

describe("S7 — layout plan", () => {
  const projectWith = (templateId: string): Project => {
    const t = templateById(templateId)!;
    return emptyProject({
      formatId: t.formatId,
      spreads: [
        {
          id: "sp1",
          templateId,
          placements: t.slots.map((s) => ({
            slotId: s.id,
            assetId: "asset-1",
            crop: fillCrop({ iw: 4000, ih: 3000, aspect: s.w_mm / s.h_mm, straighten_deg: 0 }),
            rotation: 0 as const,
            straighten_deg: 0,
            copies: 1 as const,
          })),
        },
      ],
    });
  };

  it("comes first and shows each spread at actual size", async () => {
    const project = projectWith("a5__4-grid");
    const items = buildPrintItems(project);
    const { pages } = await run(project, items);

    const plan = pages[0];
    const template = templateById("a5__4-grid")!;
    // Every slot appears at its true millimetre size on the plan.
    for (const slot of template.slots) {
      const found = plan.images.find(
        (b) =>
          Math.abs(b.w_mm - slot.w_mm) < 1e-6 && Math.abs(b.h_mm - slot.h_mm) < 1e-6,
      );
      expect(found, `slot ${slot.id} missing from plan`).toBeDefined();
    }
  });

  it("page count is plan pages plus sheets", async () => {
    const project = projectWith("a5__4-grid");
    const items = buildPrintItems(project);
    const { res, pages } = await run(project, items);
    expect(pages.length).toBe(1 + res.sheets);
  });

  it("plan IDs match the sheet IDs", async () => {
    const project = projectWith("passport-tn__6-grid");
    const items = buildPrintItems(project);
    const { pages } = await run(project, items);

    const planText = pages[0].texts;
    const sheetText = pages.slice(1).flatMap((p) => p.texts);

    for (const i of items) {
      expect(planText, `${i.label} missing from the layout plan`).toContain(i.label);
      expect(sheetText, `${i.label} missing from the sheets`).toContain(i.label);
    }
    expect(items.map((i) => i.label)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6"]);
  });

  it("spans multiple plan pages when the spreads do not fit on one", async () => {
    const t = templateById("hobonichi-cousin__hero")!;
    const project = emptyProject({
      formatId: t.formatId,
      spreads: Array.from({ length: 4 }, (_, i) => ({
        id: `sp${i + 1}`,
        templateId: t.id,
        placements: [],
      })),
    });
    const { pages } = await run(project, []);
    // 152 x 216 mm spreads: one per plan page.
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe("S4 — multi-spread project", () => {
  it("six spreads produce one correct PrintItem list", async () => {
    const templates = TEMPLATES.filter((t) => t.formatId === "a6").slice(0, 6);
    const project = emptyProject({
      formatId: "a6",
      spreads: templates.map((t, i) => ({
        id: `sp${i + 1}`,
        templateId: t.id,
        placements: t.slots.map((s) => ({
          slotId: s.id,
          assetId: "asset-1",
          crop: { x: 0, y: 0, w: 1, h: 1 },
          rotation: 0 as const,
          straighten_deg: 0,
          copies: 1 as const,
        })),
      })),
    });

    const items = buildPrintItems(project);
    const expected = templates.reduce((n, t) => n + t.slots.length, 0);
    expect(items).toHaveLength(expected);

    // Finished size is copied off the chosen slot, never inferred.
    for (const t of templates) {
      for (const s of t.slots) {
        const found = items.find(
          (i) => i.fromSlot === s.id && i.w_mm === s.w_mm && i.h_mm === s.h_mm,
        );
        expect(found).toBeDefined();
      }
    }

    // Labels are unique and sequential.
    expect(new Set(items.map((i) => i.label)).size).toBe(items.length);
    expect(items[0].label).toBe("P1");

    const { res } = await run(project, items);
    expect(res.photos).toBe(items.length);
    expect(res.unplaceable).toHaveLength(0);
  });

  it("copies are printed the requested number of times", async () => {
    const items = [item("P1", 50, 50, { copies: 3 }), item("P2", 50, 50, { copies: 1 })];
    const { res, pages } = await run(emptyProject(), items);
    expect(res.photos).toBe(4);
    expect(pages.flatMap((p) => p.images)).toHaveLength(4);
  });
});

describe("generate report", () => {
  it("reports photos, sheets and coverage", async () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`P${i + 1}`, 90, 125));
    const { res } = await run(emptyProject(), items);
    expect(res.photos).toBe(6);
    expect(res.sheets).toBeGreaterThanOrEqual(2);
    expect(res.coverage).toBeGreaterThan(0);
    expect(res.coverage).toBeLessThanOrEqual(1);
  });

  it("surfaces photos too large to place instead of dropping them", async () => {
    const items = [item("P1", 400, 400), item("P2", 50, 50)];
    const { res } = await run(emptyProject(), items);
    expect(res.unplaceable.map((i) => i.label)).toEqual(["P1"]);
  });

  it("produces a PDF even with nothing placed", async () => {
    const { res, pages } = await run(emptyProject(), []);
    expect(res.bytes.length).toBeGreaterThan(0);
    expect(pages).toHaveLength(1);
    expect(res.sheets).toBe(0);
  });
});
