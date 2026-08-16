import { describe, expect, it } from "vitest";
import { formatSixteenths, inchLabel } from "./imperial";
import {
  CIRCLE_SIZES_MM,
  CUSTOM_ROW_COUNT,
  MAX_CUSTOM_MM,
  PUNCH_BLEED_MM,
  buildRefCardPlan,
  circleCaption,
  drawnDiameter,
  flowRows,
  generateReferenceCard,
} from "./refCard";
import { inspectPdf } from "./pdfInspect";

const plan = (o?: Partial<Parameters<typeof buildRefCardPlan>[0]>) =>
  buildRefCardPlan({ punchMode: false, ...o });

describe("imperial equivalents", () => {
  it("names the sizes that really are inch fractions", () => {
    expect(inchLabel(25.4)).toBe('1"');
    expect(inchLabel(19)).toBe('¾"');
    expect(inchLabel(38)).toBe('1½"');
    expect(inchLabel(12.7)).toBe('½"');
  });

  it("stays quiet about the ones that are merely close", () => {
    // 25 mm is 0.4 mm under an inch. Calling it 1" is how a punch stops fitting.
    expect(inchLabel(25)).toBeUndefined();
    expect(inchLabel(12)).toBeUndefined();
    expect(inchLabel(20)).toBeUndefined();
    expect(inchLabel(0)).toBeUndefined();
  });

  it("formats sixteenths the way a punch is sold", () => {
    expect(formatSixteenths(16)).toBe("1");
    expect(formatSixteenths(12)).toBe("¾");
    expect(formatSixteenths(24)).toBe("1½");
    expect(formatSixteenths(3)).toBe("3/16");
    expect(formatSixteenths(19)).toBe("1 3/16");
  });
});

describe("X2 — punch size toggle", () => {
  it("adds the bleed and labels by the punch, not by what is drawn", () => {
    expect(drawnDiameter(12, false)).toBe(12);
    expect(drawnDiameter(12, true)).toBe(12.5);
    expect(PUNCH_BLEED_MM).toBe(0.5);

    const off = circleCaption(12, false);
    expect(off.caption).toBe("12 mm");

    const on = circleCaption(12, true);
    expect(on.caption).toBe("12 mm punch");
    // The drawn size is stated too — a label that lies about the geometry is
    // worse than no label.
    expect(on.sub).toBe("prints ø12.5");
  });

  it("keeps the imperial note on sizes that have one", () => {
    expect(circleCaption(25.4, false).sub).toBe('1"');
    expect(circleCaption(25, false).sub).toBeUndefined();
  });

  it("draws every circle 0.5 mm over in punch mode", () => {
    const on = plan({ punchMode: true }).shapes.filter((s) => s.kind === "circle");
    const off = plan().shapes.filter((s) => s.kind === "circle");
    expect(on).toHaveLength(off.length);
    for (let i = 0; i < on.length; i++) {
      if (on[i].kind !== "circle" || off[i].kind !== "circle") throw new Error("shape");
      expect(on[i].d_mm - off[i].d_mm).toBeCloseTo(0.5, 9);
    }
  });
});

describe("row flow", () => {
  it("never lets a row exceed the width", () => {
    const items = [40, 40, 40, 40, 40, 40];
    const { placed } = flowRows(items, (w) => ({ w, h: w }), 100, 0, 5, 5);
    const byRow = new Map<number, number>();
    for (const p of placed) byRow.set(p.y, Math.max(byRow.get(p.y) ?? 0, p.x + p.item));
    for (const [, right] of byRow) expect(right).toBeLessThanOrEqual(100);
  });

  it("keeps the order it was given", () => {
    const items = ["a", "b", "c", "d"];
    const { placed } = flowRows(items, () => ({ w: 30, h: 10 }), 70, 0, 5, 5);
    expect(placed.map((p) => p.item)).toEqual(items);
  });

  it("puts a single oversized item on its own row rather than looping", () => {
    const { placed, bottom } = flowRows([200, 10], (w) => ({ w, h: w }), 100, 0, 5, 5);
    expect(placed).toHaveLength(2);
    expect(bottom).toBeGreaterThan(0);
  });
});

describe("X1 — reference card layout", () => {
  it("has every stated circle and square", () => {
    const p = plan();
    const circles = p.shapes.filter((s) => s.kind === "circle");
    const squares = p.shapes.filter((s) => s.kind === "square");
    expect(circles).toHaveLength(CIRCLE_SIZES_MM.length);
    expect(squares.map((s) => (s.kind === "square" ? s.s_mm : 0))).toEqual([10, 20, 25]);
  });

  it("draws each circle at exactly its labelled size", () => {
    for (const s of plan().shapes) {
      if (s.kind !== "circle") continue;
      expect(Number(s.caption.replace(" mm", ""))).toBeCloseTo(s.d_mm, 9);
    }
  });

  it("keeps every shape inside the page margins", () => {
    for (const p of [plan(), plan({ punchMode: true })]) {
      for (const s of p.shapes) {
        const w = s.kind === "circle" ? s.d_mm : s.s_mm;
        expect(s.x_mm).toBeGreaterThanOrEqual(12);
        expect(s.x_mm + w).toBeLessThanOrEqual(210 - 12 + 1e-9);
      }
    }
  });

  it("leaves the ruler and footer clear", () => {
    const p = plan();
    expect(p.contentBottom_mm).toBeLessThan(p.rulerY_mm);
    expect(p.warnings).toEqual([]);
  });

  it("floats the punch note under the shapes rather than stranding it", () => {
    // With no custom row the card is short, and the note should follow it up
    // instead of leaving 70 mm of nothing in the middle of the page.
    const bare = plan();
    expect(bare.noteY_mm).toBeGreaterThan(bare.contentBottom_mm);
    expect(bare.noteY_mm - bare.contentBottom_mm).toBeLessThanOrEqual(20);

    // A card with a big custom row pushes the note down, but never onto the
    // calibration block.
    const full = plan({ custom: { diameter_mm: 38, row: true } });
    expect(full.noteY_mm).toBeGreaterThan(bare.noteY_mm);
    expect(full.noteY_mm).toBeLessThan(full.inchBarY_mm);
    expect(full.inchBarY_mm).toBeLessThan(full.rulerY_mm);
  });

  it("fits a row of six even at the widest custom size it accepts", () => {
    const p = plan({ custom: { diameter_mm: MAX_CUSTOM_MM, row: true }, punchMode: true });
    const row = p.shapes.filter((s) => s.kind === "circle").slice(CIRCLE_SIZES_MM.length);
    expect(row).toHaveLength(CUSTOM_ROW_COUNT);
    // Six 150 mm circles cannot share a page, so this must overflow loudly
    // rather than silently drawing off the edge.
    expect(p.warnings.join(" ")).toMatch(/overflow/i);
  });

  it("draws a realistic custom row of six without complaint", () => {
    const p = plan({ custom: { diameter_mm: 12, row: true } });
    expect(p.warnings).toEqual([]);
    expect(p.contentBottom_mm).toBeLessThan(p.rulerY_mm);
    const custom = p.shapes.filter((s) => s.kind === "circle").slice(CIRCLE_SIZES_MM.length);
    expect(custom).toHaveLength(6);
    for (const c of custom) if (c.kind === "circle") expect(c.d_mm).toBe(12);
  });

  it("clamps a custom size wider than the card and says so", () => {
    const p = plan({ custom: { diameter_mm: 400, row: false } });
    const custom = p.shapes.filter((s) => s.kind === "circle").at(-1);
    if (custom?.kind !== "circle") throw new Error("no custom circle");
    expect(custom.d_mm).toBe(MAX_CUSTOM_MM);
    expect(p.warnings.join(" ")).toMatch(/wider than the card/);
  });
});

describe("X1 — the card that actually comes out", () => {
  it("is one A4 page carrying a 100.0 mm rule", async () => {
    const { bytes } = await generateReferenceCard({ punchMode: false });
    const pages = await inspectPdf(bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0].w_mm).toBeCloseTo(210, 6);
    expect(pages[0].h_mm).toBeCloseTo(297, 6);

    const rules = pages[0].lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 100) < 1e-9,
    );
    expect(rules, "the card is missing its calibration rule").toHaveLength(1);
  });

  it("carries a 25.4 mm inch bar next to it", async () => {
    const { bytes } = await generateReferenceCard({ punchMode: false });
    const pages = await inspectPdf(bytes);
    const inchBars = pages[0].lines.filter(
      (l) => Math.abs(l.y1_mm - l.y2_mm) < 1e-9 && Math.abs(l.length_mm - 25.4) < 1e-6,
    );
    expect(inchBars.length).toBeGreaterThanOrEqual(1);
  });

  it("tells you to print at 100% and what to do if the ruler is wrong", async () => {
    const { bytes } = await generateReferenceCard({ punchMode: false });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).toMatch(/PRINT AT 100% \/ ACTUAL SIZE/);
    expect(text).toMatch(/Fit to page/);
    expect(text).toMatch(/Measure the 100 mm ruler/);
    expect(text).toMatch(/0.5 mm larger than your punch/);
  });

  it("labels by punch size when punch mode is on", async () => {
    const { bytes } = await generateReferenceCard({ punchMode: true });
    const text = (await inspectPdf(bytes))[0].texts.join(" ");
    expect(text).toMatch(/12 mm punch/);
    expect(text).toMatch(/prints \S*12.5/);
  });
});
