import { describe, it, expect } from "vitest";
import {
  AUTHORED_TEMPLATES,
  FORMATS,
  TEMPLATES,
  formatById,
  templateById,
  templatesForFormat,
  validateTemplates,
} from "./templates";
import { GENERATED_TEMPLATES, LAYOUT_GENERATORS } from "./generated";

describe("both layout sets ship — neither replaces the other", () => {
  it("keeps the hand-authored layouts", () => {
    expect(AUTHORED_TEMPLATES.length).toBeGreaterThan(0);
    // A few by name, so a refactor that quietly drops the seed fails here.
    for (const id of ["pp-arch-pair", "a6-circle-trio", "a5-collage-scatter", "hc-daily-strip"]) {
      expect(templateById(id), `${id} missing from the seed`).toBeDefined();
    }
  });

  it("keeps the parametric layouts, one per generator per format", () => {
    expect(GENERATED_TEMPLATES).toHaveLength(FORMATS.length * LAYOUT_GENERATORS.length);
    for (const f of FORMATS) {
      for (const g of LAYOUT_GENERATORS) {
        expect(templateById(`${f.id}__${g.key}`), `${f.id}/${g.key} missing`).toBeDefined();
      }
    }
  });

  it("TEMPLATES is both sets, with no id collisions", () => {
    expect(TEMPLATES).toHaveLength(AUTHORED_TEMPLATES.length + GENERATED_TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it("every template declares where it came from", () => {
    for (const t of AUTHORED_TEMPLATES) expect(t.origin, t.id).toBe("authored");
    for (const t of GENERATED_TEMPLATES) expect(t.origin, t.id).toBe("generated");
  });

  it("every format now has at least the spec's 8 layouts", () => {
    for (const f of FORMATS) {
      expect(templatesForFormat(f.id).length, f.name).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("S1 — formats and templates", () => {
  it("every slot sits inside its page margin", () => {
    // The seed file's own assertion. Collage layouts are excluded by design.
    expect(validateTemplates()).toEqual([]);
  });

  it("has the six journal formats at the stated sizes", () => {
    expect(FORMATS.map((f) => [f.name, f.page_w_mm, f.page_h_mm])).toEqual([
      ["Passport TN", 90, 125],
      ["Pocket / Field Notes", 89, 140],
      ["A6", 105, 148],
      ["A5", 148, 210],
      ["Standard TN", 110, 210],
      ["Hobonichi Cousin", 152, 216],
    ]);
  });

  it("template ids are unique and resolvable", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) expect(templateById(t.id)).toBe(t);
  });

  it("every template points at a real format", () => {
    for (const t of TEMPLATES) {
      expect(formatById(t.formatId), t.id).toBeDefined();
    }
  });

  it("slot ids are unique within a template and numbered S1..Sn", () => {
    for (const t of TEMPLATES) {
      const ids = t.slots.map((s) => s.id);
      expect(new Set(ids).size, t.id).toBe(ids.length);
      // Uniform numbering is what lets a layout change carry photos across.
      expect(ids, t.id).toEqual(t.slots.map((_, i) => `S${i + 1}`));
    }
  });

  it("every slot has positive dimensions", () => {
    for (const t of TEMPLATES) {
      for (const s of t.slots) {
        expect(s.w_mm, `${t.id}/${s.id}`).toBeGreaterThan(0);
        expect(s.h_mm, `${t.id}/${s.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("every template carries a note and at least one tag", () => {
    for (const t of TEMPLATES) {
      expect(t.note.length, t.id).toBeGreaterThan(0);
      expect(t.tags.length, t.id).toBeGreaterThan(0);
    }
  });

  it("only collage layouts overlap or tilt", () => {
    const overlaps = (a: (typeof TEMPLATES)[0]["slots"][0], b: typeof a) =>
      a.x_mm < b.x_mm + b.w_mm - 0.001 &&
      b.x_mm < a.x_mm + a.w_mm - 0.001 &&
      a.y_mm < b.y_mm + b.h_mm - 0.001 &&
      b.y_mm < a.y_mm + a.h_mm - 0.001;

    for (const t of TEMPLATES) {
      const collage = t.tags.includes("collage");
      const tilted = t.slots.some((s) => s.rotation_deg !== 0);
      expect(tilted && !collage, `${t.id} tilts but is not tagged collage`).toBe(false);

      if (collage) continue;
      for (let i = 0; i < t.slots.length; i++) {
        for (let j = i + 1; j < t.slots.length; j++) {
          expect(
            overlaps(t.slots[i], t.slots[j]),
            `${t.id}: ${t.slots[i].id} overlaps ${t.slots[j].id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("scales with the page — the same layout is bigger on a bigger format", () => {
    const passport = templateById("pp-hero-square")!;
    const hobonichi = templateById("hc-hero")!;
    expect(hobonichi.slots[0].w_mm).toBeGreaterThan(passport.slots[0].w_mm);
  });

  it("full bleed really is the whole page", () => {
    const t = templateById("pp-full-bleed")!;
    const f = formatById(t.formatId)!;
    expect(t.slots).toHaveLength(1);
    expect(t.slots[0]).toMatchObject({
      x_mm: 0,
      y_mm: 0,
      w_mm: f.page_w_mm,
      h_mm: f.page_h_mm,
    });
  });

  it("notes that promise leftover space are tagged for writing", () => {
    for (const t of TEMPLATES) {
      if (!/writing space|for notes|for text|left for|page free/i.test(t.note)) continue;
      expect(t.tags, `${t.id} promises writing space`).toContain("writing");
    }
  });
});
