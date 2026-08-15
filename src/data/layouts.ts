import type { Format, Slot, Template } from "../types";
import { FORMATS } from "./formats";
import { clamp, round } from "../lib/units";

/**
 * Layouts are parameterised, not free-form. The constraint is the point —
 * blank canvas is Canva and Canva already exists.
 */

/** Page margin scales with the page so a Passport TN doesn't get an A5 border. */
const pageMargin = (w: number, h: number): number =>
  round(clamp(Math.min(w, h) * 0.06, 4, 9), 1);

/** Gutter between slots. */
const gutter = (w: number, h: number): number =>
  round(clamp(Math.min(w, h) * 0.035, 2.5, 5), 1);

const slot = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation_deg = 0,
): Slot => ({
  id,
  x_mm: round(x, 2),
  y_mm: round(y, 2),
  w_mm: round(w, 2),
  h_mm: round(h, 2),
  rotation_deg,
  shape: "rect",
});

type Inner = { x: number; y: number; w: number; h: number };

const innerBox = (W: number, H: number): Inner => {
  const m = pageMargin(W, H);
  return { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
};

const grid = (W: number, H: number, cols: number, rows: number): Slot[] => {
  const b = innerBox(W, H);
  const g = gutter(W, H);
  const cw = (b.w - (cols - 1) * g) / cols;
  const ch = (b.h - (rows - 1) * g) / rows;
  const out: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(
        slot(`s${out.length + 1}`, b.x + c * (cw + g), b.y + r * (ch + g), cw, ch),
      );
    }
  }
  return out;
};

export type LayoutGenerator = {
  key: string;
  name: string;
  make: (W: number, H: number) => Slot[];
};

export const LAYOUT_GENERATORS: LayoutGenerator[] = [
  {
    key: "hero",
    name: "Single hero",
    make: (W, H) => {
      const b = innerBox(W, H);
      return [slot("s1", b.x, b.y, b.w, b.h)];
    },
  },
  {
    key: "full-bleed",
    name: "Full bleed",
    make: (W, H) => [slot("s1", 0, 0, W, H)],
  },
  {
    key: "2-up-stack",
    name: "2-up stacked",
    make: (W, H) => grid(W, H, 1, 2),
  },
  {
    key: "2-up-side",
    name: "2-up side by side",
    make: (W, H) => grid(W, H, 2, 1),
  },
  {
    key: "3-up-strip",
    name: "3-up strip",
    make: (W, H) => grid(W, H, 1, 3),
  },
  {
    key: "3-up-band",
    name: "3-up band",
    make: (W, H) => grid(W, H, 3, 1),
  },
  {
    key: "4-grid",
    name: "4 grid",
    make: (W, H) => grid(W, H, 2, 2),
  },
  {
    key: "6-grid",
    name: "6 grid",
    make: (W, H) => grid(W, H, 2, 3),
  },
  {
    key: "half-notes",
    name: "Half + notes",
    make: (W, H) => {
      const b = innerBox(W, H);
      return [slot("s1", b.x, b.y, b.w, b.h * 0.45)];
    },
  },
  {
    key: "hero-plus-2",
    name: "Hero + 2",
    make: (W, H) => {
      const b = innerBox(W, H);
      const g = gutter(W, H);
      const heroH = b.h * 0.62;
      const restH = b.h - heroH - g;
      const halfW = (b.w - g) / 2;
      return [
        slot("s1", b.x, b.y, b.w, heroH),
        slot("s2", b.x, b.y + heroH + g, halfW, restH),
        slot("s3", b.x + halfW + g, b.y + heroH + g, halfW, restH),
      ];
    },
  },
  {
    key: "corner-stack",
    name: "Corner stack",
    make: (W, H) => {
      const b = innerBox(W, H);
      const g = gutter(W, H);
      const sw = b.w * 0.62;
      const sh = (b.h - 2 * g) / 3;
      const step = (b.w - sw) / 2;
      return [0, 1, 2].map((i) =>
        slot(`s${i + 1}`, b.x + i * step, b.y + i * (sh + g), sw, sh),
      );
    },
  },
  {
    key: "polaroid-cluster",
    name: "Polaroid cluster",
    make: (W, H) => {
      const b = innerBox(W, H);
      const sw = b.w * 0.5;
      const sh = b.h * 0.3;
      return [
        slot("s1", b.x, b.y, sw, sh, -6),
        slot("s2", b.x + b.w - sw, b.y + b.h * 0.34, sw, sh, 5),
        slot("s3", b.x + (b.w - sw) / 2, b.y + b.h - sh, sw, sh, -3),
      ];
    },
  },
];

const buildTemplates = (): Template[] => {
  const out: Template[] = [];
  for (const f of FORMATS) {
    for (const g of LAYOUT_GENERATORS) {
      out.push({
        id: `${f.id}__${g.key}`,
        formatId: f.id,
        name: g.name,
        slots: g.make(f.w_mm, f.h_mm),
      });
    }
  }
  return out;
};

export const TEMPLATES: Template[] = buildTemplates();

export const templateById = (id: string): Template | undefined =>
  TEMPLATES.find((t) => t.id === id);

export const templatesForFormat = (formatId: string): Template[] =>
  TEMPLATES.filter((t) => t.formatId === formatId);

export const formatForTemplate = (t: Template): Format =>
  FORMATS.find((f) => f.id === t.formatId)!;
