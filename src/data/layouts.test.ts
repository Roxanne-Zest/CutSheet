import { describe, it, expect } from "vitest";
import { FORMATS, formatById } from "./formats";
import { LAYOUT_GENERATORS, TEMPLATES, templatesForFormat } from "./layouts";

describe("S1 — formats and templates", () => {
  it("has the six journal formats at the stated sizes", () => {
    expect(FORMATS.map((f) => [f.name, f.w_mm, f.h_mm])).toEqual([
      ["Passport TN", 90, 125],
      ["Standard TN", 110, 210],
      ["A6", 105, 148],
      ["A5", 148, 210],
      ["Hobonichi Cousin", 152, 216],
      ["Pocket", 89, 140],
    ]);
  });

  it("gives every format 8 to 12 layouts", () => {
    for (const f of FORMATS) {
      const n = templatesForFormat(f.id).length;
      expect(n, f.name).toBeGreaterThanOrEqual(8);
      expect(n, f.name).toBeLessThanOrEqual(12);
    }
    expect(TEMPLATES).toHaveLength(FORMATS.length * LAYOUT_GENERATORS.length);
  });

  it("template ids are unique", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it("every slot sits inside its page", () => {
    for (const t of TEMPLATES) {
      const f = formatById(t.formatId)!;
      for (const s of t.slots) {
        expect(s.w_mm, `${t.id}/${s.id}`).toBeGreaterThan(0);
        expect(s.h_mm, `${t.id}/${s.id}`).toBeGreaterThan(0);

        // Account for rotation: check the rotated bounding box.
        const a = Math.abs(s.rotation_deg) * (Math.PI / 180);
        const bw = s.w_mm * Math.cos(a) + s.h_mm * Math.sin(a);
        const bh = s.w_mm * Math.sin(a) + s.h_mm * Math.cos(a);
        const cx = s.x_mm + s.w_mm / 2;
        const cy = s.y_mm + s.h_mm / 2;

        expect(cx - bw / 2, `${t.id}/${s.id} left`).toBeGreaterThanOrEqual(-0.01);
        expect(cy - bh / 2, `${t.id}/${s.id} top`).toBeGreaterThanOrEqual(-0.01);
        expect(cx + bw / 2, `${t.id}/${s.id} right`).toBeLessThanOrEqual(f.w_mm + 0.01);
        expect(cy + bh / 2, `${t.id}/${s.id} bottom`).toBeLessThanOrEqual(f.h_mm + 0.01);
      }
    }
  });

  it("slot ids are unique within a template", () => {
    for (const t of TEMPLATES) {
      expect(new Set(t.slots.map((s) => s.id)).size, t.id).toBe(t.slots.length);
    }
  });

  it("grid layouts do not overlap", () => {
    const gridKeys = ["2-up-stack", "2-up-side", "3-up-strip", "3-up-band", "4-grid", "6-grid"];
    for (const t of TEMPLATES) {
      if (!gridKeys.some((k) => t.id.endsWith(k))) continue;
      for (let i = 0; i < t.slots.length; i++) {
        for (let j = i + 1; j < t.slots.length; j++) {
          const a = t.slots[i];
          const b = t.slots[j];
          const overlap =
            a.x_mm < b.x_mm + b.w_mm - 0.001 &&
            b.x_mm < a.x_mm + a.w_mm - 0.001 &&
            a.y_mm < b.y_mm + b.h_mm - 0.001 &&
            b.y_mm < a.y_mm + a.h_mm - 0.001;
          expect(overlap, `${t.id}: ${a.id} overlaps ${b.id}`).toBe(false);
        }
      }
    }
  });

  it("scales with the page — the same layout is bigger on a bigger format", () => {
    const passport = TEMPLATES.find((t) => t.id === "passport-tn__hero")!;
    const cousin = TEMPLATES.find((t) => t.id === "hobonichi-cousin__hero")!;
    expect(cousin.slots[0].w_mm).toBeGreaterThan(passport.slots[0].w_mm);
    expect(cousin.slots[0].h_mm).toBeGreaterThan(passport.slots[0].h_mm);
  });

  it("full bleed really is the whole page", () => {
    for (const f of FORMATS) {
      const t = TEMPLATES.find((x) => x.id === `${f.id}__full-bleed`)!;
      expect(t.slots).toHaveLength(1);
      expect(t.slots[0]).toMatchObject({ x_mm: 0, y_mm: 0, w_mm: f.w_mm, h_mm: f.h_mm });
    }
  });

  it("polaroid cluster is the only layout that tilts slots", () => {
    for (const t of TEMPLATES) {
      const tilted = t.slots.some((s) => s.rotation_deg !== 0);
      expect(tilted, t.id).toBe(t.id.endsWith("polaroid-cluster"));
    }
  });
});
