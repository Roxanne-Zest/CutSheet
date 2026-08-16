import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateSizerPdf, pageBox, tileWindow } from "./sizerPdf";
import { mmPerPx, physicalSize, planOutput } from "./sheetSizer";
import { effectiveDpi } from "./sheetSizer";
import { inspectPdf, tinyJpegBytes } from "./pdfInspect";
import { mmToPt } from "./units";

const jpeg = () => ({ kind: "image" as const, bytes: tinyJpegBytes(), mime: "image/jpeg" });

/** A one-page PDF of a known physical size, standing in for vector artwork. */
const stubPdf = async (w_mm: number, h_mm: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([mmToPt(w_mm), mmToPt(h_mm)]);
  // A page with no content stream cannot be embedded, so give it something.
  page.drawRectangle({ x: 10, y: 10, width: 40, height: 40, borderWidth: 1 });
  return doc.save();
};

describe("X5 — the sheet that comes out", () => {
  it("draws the artwork at exactly the measured size", async () => {
    const scale = mmPerPx({ measured_px: 384, target_mm: 12 });
    const size = physicalSize(6080, 8352, scale);
    const plan = planOutput(size.w_mm, size.h_mm, { mode: "single" });

    const bytes = await generateSizerPdf({
      source: jpeg(),
      plan,
      name: "stickers",
      ruler: true,
      measurement: { measured_px: 384, target_mm: 12 },
      dpi: effectiveDpi(scale),
    });

    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0].w_mm).toBeCloseTo(210, 6);
    expect(pages[0].h_mm).toBeCloseTo(297, 6);
    expect(pages[0].images).toHaveLength(1);
    // This is the whole feature: 190 x 261 mm of artwork, drawn 190 x 261 mm.
    expect(pages[0].images[0].w_mm).toBeCloseTo(plan.w_mm, 6);
    expect(pages[0].images[0].h_mm).toBeCloseTo(plan.h_mm, 6);
  });

  it("carries the 100.0 mm rule so the print checks itself", async () => {
    const plan = planOutput(120, 160, { mode: "single" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const rules = (await inspectPdf(bytes))[0].lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 100) < 1e-9,
    );
    expect(rules).toHaveLength(1);
  });

  it("leaves the rule off when you ask it to", async () => {
    const plan = planOutput(120, 160, { mode: "single" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: false });
    const rules = (await inspectPdf(bytes))[0].lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 100) < 1e-9,
    );
    expect(rules).toHaveLength(0);
  });

  it("never lets the artwork reach into the footer band", async () => {
    // A sheet that only just fits: its bottom edge must still clear the ruler.
    const plan = planOutput(194, 263, { mode: "single" });
    const win = tileWindow(plan.tiles[0], plan);
    expect(win.y_mm + win.h_mm).toBeLessThanOrEqual(297 - plan.footer_mm + 1e-6);
    expect(win.x_mm).toBeGreaterThanOrEqual(plan.margin_mm - 1e-6);
  });

  it("clamps oversized artwork to the printable box instead of over the ruler", async () => {
    // "One sheet" on artwork too big for one sheet gives you the middle of it at
    // true size. The window must still clear the footer, or the warning telling
    // you it did not fit would be printed underneath the artwork.
    const plan = planOutput(300, 400, { mode: "single" });
    const win = tileWindow(plan.tiles[0], plan);
    expect(win.w_mm).toBe(plan.printable.w_mm);
    expect(win.h_mm).toBe(plan.printable.h_mm);
    expect(win.y_mm + win.h_mm).toBeLessThanOrEqual(297 - plan.footer_mm + 1e-6);

    // The artwork itself is still drawn at 300 x 400 — only the view is cropped.
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const page = (await inspectPdf(bytes))[0];
    expect(page.images[0].w_mm).toBeCloseTo(300, 6);
    expect(page.texts.join(" ")).toMatch(/bigger than the/);
  });

  it("says on the page that it was scaled, when it was scaled", async () => {
    const plan = planOutput(300, 400, { mode: "fit" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).toMatch(/NOT TRUE SIZE/);
    expect(text).toMatch(/SCALED TO/);
  });

  it("says nothing of the kind when it was not", async () => {
    const plan = planOutput(120, 160, { mode: "single" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).not.toMatch(/NOT TRUE SIZE/);
    expect(text).toMatch(/Print at 100%/);
  });

  it("warns about resolution under 200 dpi", async () => {
    const plan = planOutput(120, 160, { mode: "single" });
    const bytes = await generateSizerPdf({
      source: jpeg(),
      plan,
      name: "s",
      ruler: true,
      dpi: 140,
    });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).toMatch(/140 dpi/);
    expect(text).toMatch(/look soft in print/);
  });
});

describe("X6 — tiling", () => {
  it("produces one page per tile, each still A4", async () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(plan.sheets);
    for (const p of pages) {
      expect(p.w_mm).toBeCloseTo(210, 6);
      expect(p.h_mm).toBeCloseTo(297, 6);
    }
  });

  it("draws the artwork at true size on every tile — that is the point of tiling", async () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    for (const p of await inspectPdf(bytes)) {
      expect(p.images).toHaveLength(1);
      expect(p.images[0].w_mm).toBeCloseTo(300, 6);
      expect(p.images[0].h_mm).toBeCloseTo(400, 6);
    }
  });

  it("numbers the sheets so you can reassemble them", async () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const pages = await inspectPdf(bytes);
    const texts = pages.map((p) => p.texts.join(" "));
    expect(texts[0]).toMatch(/sheet 1 of \d+ - column 1, row 1/);
    expect(texts.at(-1)).toMatch(new RegExp(`sheet ${plan.sheets} of ${plan.sheets}`));
  });

  it("slides the artwork so each tile shows its own region", () => {
    const plan = planOutput(300, 400, { mode: "tile" });
    const first = tileWindow(plan.tiles[0], plan);
    expect(first.x_mm).toBe(plan.margin_mm);
    expect(first.y_mm).toBe(plan.margin_mm);
    // The second column's window is the same box on the page; the artwork
    // beneath it is what moves.
    const second = plan.tiles.find((t) => t.col === 1);
    expect(second?.sx_mm).toBeCloseTo(plan.printable.w_mm - plan.overlap_mm, 6);
  });
});

describe("rotation", () => {
  it("turns the footprint but not the artwork's own dimensions", () => {
    const plan = planOutput(250, 150, { mode: "single" });
    expect(plan.rotated).toBe(true);
    expect(pageBox(plan)).toEqual({ w_mm: 150, h_mm: 250 });
    expect(plan.w_mm).toBe(250);
  });

  it("still draws 250 x 150 mm of artwork, just turned", async () => {
    const plan = planOutput(250, 150, { mode: "single" });
    const bytes = await generateSizerPdf({ source: jpeg(), plan, name: "s", ruler: true });
    const page = (await inspectPdf(bytes))[0];
    expect(page.images[0].w_mm).toBeCloseTo(250, 6);
    expect(page.images[0].h_mm).toBeCloseTo(150, 6);
    expect(Math.abs(page.images[0].rotation_deg)).toBeCloseTo(90, 6);
  });

  it("keeps the turned artwork inside the printable box", () => {
    const plan = planOutput(250, 150, { mode: "single" });
    const win = tileWindow(plan.tiles[0], plan);
    expect(win.x_mm).toBeGreaterThanOrEqual(plan.margin_mm - 1e-6);
    expect(win.x_mm + win.w_mm).toBeLessThanOrEqual(210 - plan.margin_mm + 1e-6);
    expect(win.y_mm + win.h_mm).toBeLessThanOrEqual(297 - plan.footer_mm + 1e-6);
  });
});

describe("PDF artwork", () => {
  it("embeds a PDF page as vector at the size it declares", async () => {
    const src = await stubPdf(190, 261);
    const plan = planOutput(190, 261, { mode: "single" });
    const bytes = await generateSizerPdf({
      source: { kind: "pdf", bytes: src },
      plan,
      name: "vector",
      ruler: true,
    });
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    // An embedded page is drawn as a Form XObject, not an image.
    expect(pages[0].images).toHaveLength(0);
    expect(pages[0].raw).toMatch(/\/EmbeddedPdfPage\S*\s+Do/);
  });
});
