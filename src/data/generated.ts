import type { JournalFormat, Slot, Template, TemplateTag } from "../types";
import { FORMATS } from "./formats";
import { clamp, round } from "../lib/units";

/**
 * The parametric layouts — one set of rules applied to every format.
 *
 * Layouts are parameterised, not free-form. The constraint is the point —
 * blank canvas is Canva and Canva already exists.
 *
 * These sit alongside the hand-authored seed in `templates.ts` rather than
 * replacing it: the generators give even coverage across all six formats, the
 * seed gives the considered ones. Both are pickable.
 *
 * Two things changed when the seed arrived and these had to agree with it:
 * margins now come from the format rather than a formula, and slot ids are
 * S1..Sn so a photo can be carried across a layout change either way.
 */

/** Gutter between slots, scaled to the page. */
const gutter = (w: number, h: number): number =>
  round(clamp(Math.min(w, h) * 0.035, 2.5, 5), 1);

const slot = (
  index: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation_deg = 0,
): Slot => ({
  id: `S${index}`,
  x_mm: round(x, 2),
  y_mm: round(y, 2),
  w_mm: round(w, 2),
  h_mm: round(h, 2),
  rotation_deg,
  shape: "rect",
});

type Inner = { x: number; y: number; w: number; h: number };

const innerBox = (f: JournalFormat): Inner => ({
  x: f.margin_mm,
  y: f.margin_mm,
  w: f.page_w_mm - 2 * f.margin_mm,
  h: f.page_h_mm - 2 * f.margin_mm,
});

const grid = (f: JournalFormat, cols: number, rows: number): Slot[] => {
  const b = innerBox(f);
  const g = gutter(f.page_w_mm, f.page_h_mm);
  const cw = (b.w - (cols - 1) * g) / cols;
  const ch = (b.h - (rows - 1) * g) / rows;
  const out: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(slot(out.length + 1, b.x + c * (cw + g), b.y + r * (ch + g), cw, ch));
    }
  }
  return out;
};

export type LayoutGenerator = {
  key: string;
  name: string;
  note: string;
  tags: TemplateTag[];
  make: (f: JournalFormat) => Slot[];
};

export const LAYOUT_GENERATORS: LayoutGenerator[] = [
  {
    key: "hero",
    name: "Single hero",
    note: "One photo filling the page inside the margin.",
    tags: ["hero"],
    make: (f) => {
      const b = innerBox(f);
      return [slot(1, b.x, b.y, b.w, b.h)];
    },
  },
  {
    key: "full-bleed",
    name: "Full bleed",
    note: "Edge to edge, no margin at all.",
    tags: ["hero"],
    make: (f) => [slot(1, 0, 0, f.page_w_mm, f.page_h_mm)],
  },
  {
    key: "2-up-stack",
    name: "2-up stacked",
    note: "Two landscape photos, one above the other.",
    tags: ["grid"],
    make: (f) => grid(f, 1, 2),
  },
  {
    key: "2-up-side",
    name: "2-up side by side",
    note: "Two portrait photos filling the page width.",
    tags: ["grid"],
    make: (f) => grid(f, 2, 1),
  },
  {
    key: "3-up-strip",
    name: "3-up strip",
    note: "Three full-width bands down the page.",
    tags: ["strip"],
    make: (f) => grid(f, 1, 3),
  },
  {
    key: "3-up-band",
    name: "3-up band",
    note: "Three tall photos side by side.",
    tags: ["strip"],
    make: (f) => grid(f, 3, 1),
  },
  {
    key: "4-grid",
    name: "4 grid",
    note: "2 x 2 filling the page.",
    tags: ["grid"],
    make: (f) => grid(f, 2, 2),
  },
  {
    key: "6-grid",
    name: "6 grid",
    note: "2 x 3 filling the page.",
    tags: ["grid"],
    make: (f) => grid(f, 2, 3),
  },
  {
    key: "half-notes",
    name: "Half + notes",
    note: "One band across the top, the rest of the page left for text.",
    tags: ["hero", "writing"],
    make: (f) => {
      const b = innerBox(f);
      return [slot(1, b.x, b.y, b.w, b.h * 0.45)];
    },
  },
  {
    key: "hero-plus-2",
    name: "Hero + 2",
    note: "A large photo above two smaller ones.",
    tags: ["hero", "grid"],
    make: (f) => {
      const b = innerBox(f);
      const g = gutter(f.page_w_mm, f.page_h_mm);
      const heroH = b.h * 0.62;
      const restH = b.h - heroH - g;
      const halfW = (b.w - g) / 2;
      return [
        slot(1, b.x, b.y, b.w, heroH),
        slot(2, b.x, b.y + heroH + g, halfW, restH),
        slot(3, b.x + halfW + g, b.y + heroH + g, halfW, restH),
      ];
    },
  },
  {
    key: "corner-stack",
    name: "Corner stack",
    note: "Three photos stepping diagonally down the page.",
    tags: ["editorial"],
    make: (f) => {
      const b = innerBox(f);
      const g = gutter(f.page_w_mm, f.page_h_mm);
      const sw = b.w * 0.62;
      const sh = (b.h - 2 * g) / 3;
      const step = (b.w - sw) / 2;
      return [0, 1, 2].map((i) =>
        slot(i + 1, b.x + i * step, b.y + i * (sh + g), sw, sh),
      );
    },
  },
  {
    key: "polaroid-cluster",
    name: "Polaroid cluster",
    note: "Three tilted photos, loosely scattered down the page.",
    tags: ["collage"],
    make: (f) => {
      const b = innerBox(f);
      const sw = b.w * 0.5;
      const sh = b.h * 0.3;
      return [
        slot(1, b.x, b.y, sw, sh, -6),
        slot(2, b.x + b.w - sw, b.y + b.h * 0.34, sw, sh, 5),
        slot(3, b.x + (b.w - sw) / 2, b.y + b.h - sh, sw, sh, -3),
      ];
    },
  },
];

const build = (): Template[] => {
  const out: Template[] = [];
  for (const f of FORMATS) {
    for (const g of LAYOUT_GENERATORS) {
      out.push({
        // Double underscore keeps these clear of the seed's hand-written ids.
        id: `${f.id}__${g.key}`,
        formatId: f.id,
        name: g.name,
        note: g.note,
        tags: g.tags,
        origin: "generated",
        slots: g.make(f),
      });
    }
  }
  return out;
};

export const GENERATED_TEMPLATES: Template[] = build();
