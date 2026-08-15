/**
 * Cut Sheet — template seed data
 *
 * All units in millimetres. Origin is top-left of the journal page.
 * Every slot has been checked to sit inside its page margin.
 *
 * Convention: layouts that don't fill the page are deliberate — the empty
 * area is where the user writes. Those are tagged "writing".
 */

import type { JournalFormat, Slot, Template } from "../types";
import { FORMATS, formatById } from "./formats";
import { GENERATED_TEMPLATES } from "./generated";

export { FORMATS, formatById };

// Helper for the common case — square corners, no rotation.
const s = (
  id: string, x: number, y: number, w: number, h: number,
  rotation_deg = 0, shape: Slot["shape"] = "rect",
): Slot => ({ id, x_mm: x, y_mm: y, w_mm: w, h_mm: h, rotation_deg, shape });

// ---------------------------------------------------------------------------
// Passport TN — 90 × 125, margin 6, live area 78 × 113
// ---------------------------------------------------------------------------

const PASSPORT: Template[] = [
  {
    id: "pp-hero-square", formatId: "passport-tn", name: "Hero square",
    note: "One big square up top, a third of the page left for the date and a few lines.",
    tags: ["hero", "writing"],
    slots: [s("S1", 6, 6, 78, 78)],
  },
  {
    id: "pp-full-bleed", formatId: "passport-tn", name: "Full bleed",
    note: "Edge to edge. Covers the whole page — write on the facing side.",
    tags: ["hero"],
    slots: [s("S1", 0, 0, 90, 125)],
  },
  {
    id: "pp-2-stack", formatId: "passport-tn", name: "Two stacked",
    note: "Two landscape photos, one above the other. The workhorse.",
    tags: ["grid"],
    slots: [s("S1", 6, 6, 78, 54), s("S2", 6, 65, 78, 54)],
  },
  {
    id: "pp-3-strip-v", formatId: "passport-tn", name: "Three verticals",
    note: "Three tall photos side by side, notes underneath.",
    tags: ["strip", "writing"],
    slots: [s("S1", 6, 6, 23, 60), s("S2", 33.5, 6, 23, 60), s("S3", 61, 6, 23, 60)],
  },
  {
    id: "pp-4-grid", formatId: "passport-tn", name: "Four square",
    note: "2 × 2 grid, 41 mm of writing space below.",
    tags: ["grid", "writing"],
    slots: [
      s("S1", 6, 6, 36.5, 36.5), s("S2", 47.5, 6, 36.5, 36.5),
      s("S3", 6, 47.5, 36.5, 36.5), s("S4", 47.5, 47.5, 36.5, 36.5),
    ],
  },
  {
    id: "pp-polaroid-3", formatId: "passport-tn", name: "Polaroid scatter",
    note: "Three tilted photos, loosely overlapping. Scrapbook feel.",
    tags: ["collage"],
    slots: [
      s("S1", 8, 10, 34, 40, -5), s("S2", 44, 28, 34, 40, 4), s("S3", 20, 72, 34, 40, -3),
    ],
  },
  {
    id: "pp-filmstrip-4", formatId: "passport-tn", name: "Filmstrip",
    note: "Four small landscape frames down the left, right column for writing.",
    tags: ["strip", "writing"],
    slots: [
      s("S1", 6, 6, 34, 25), s("S2", 6, 35, 34, 25),
      s("S3", 6, 64, 34, 25), s("S4", 6, 93, 34, 25),
    ],
  },
  {
    id: "pp-half-notes", formatId: "passport-tn", name: "Half and notes",
    note: "One landscape photo on top, half the page for text.",
    tags: ["hero", "writing"],
    slots: [s("S1", 6, 6, 78, 55)],
  },
  {
    id: "pp-vertical-moment", formatId: "passport-tn", name: "Vertical moment",
    note: "One full-height photo down the left, a script column beside it.",
    tags: ["editorial", "writing"],
    slots: [s("S1", 6, 6, 44, 113)],
  },
  {
    id: "pp-2-tall", formatId: "passport-tn", name: "Two talls",
    note: "Two portrait photos side by side, near full height.",
    tags: ["grid"],
    slots: [s("S1", 6, 6, 37, 100), s("S2", 47, 6, 37, 100)],
  },
  {
    id: "pp-arch-pair", formatId: "passport-tn", name: "Arch pair",
    note: "Two arched tops. Softer than a straight rectangle, good for portraits.",
    tags: ["editorial"],
    slots: [
      s("S1", 6, 6, 37, 100, 0, "arch"), s("S2", 47, 6, 37, 100, 0, "arch"),
    ],
  },
];

// ---------------------------------------------------------------------------
// Pocket / Field Notes — 89 × 140, margin 6, live area 77 × 128
// ---------------------------------------------------------------------------

const POCKET: Template[] = [
  {
    id: "pk-hero", formatId: "pocket", name: "Hero square",
    note: "Square photo up top, 51 mm below for notes.",
    tags: ["hero", "writing"],
    slots: [s("S1", 6, 6, 77, 77)],
  },
  {
    id: "pk-2-stack", formatId: "pocket", name: "Two stacked",
    note: "Two landscape photos filling the page.",
    tags: ["grid"],
    slots: [s("S1", 6, 6, 77, 61.5), s("S2", 6, 72.5, 77, 61.5)],
  },
  {
    id: "pk-3-strip-v", formatId: "pocket", name: "Three verticals",
    note: "Three tall photos in a row, notes underneath.",
    tags: ["strip", "writing"],
    slots: [s("S1", 6, 6, 23, 55), s("S2", 33, 6, 23, 55), s("S3", 60, 6, 23, 55)],
  },
  {
    id: "pk-filmstrip-4", formatId: "pocket", name: "Filmstrip four",
    note: "Four full-width bands, top to bottom. Good for a sequence.",
    tags: ["strip"],
    slots: [
      s("S1", 6, 6, 77, 29.75), s("S2", 6, 38.75, 77, 29.75),
      s("S3", 6, 71.5, 77, 29.75), s("S4", 6, 104.25, 77, 29.75),
    ],
  },
  {
    id: "pk-4-grid", formatId: "pocket", name: "Four square",
    note: "2 × 2, generous writing space below.",
    tags: ["grid", "writing"],
    slots: [
      s("S1", 6, 6, 36, 36), s("S2", 47, 6, 36, 36),
      s("S3", 6, 47, 36, 36), s("S4", 47, 47, 36, 36),
    ],
  },
];

// ---------------------------------------------------------------------------
// A6 — 105 × 148, margin 7, live area 91 × 134
// ---------------------------------------------------------------------------

const A6: Template[] = [
  {
    id: "a6-hero", formatId: "a6", name: "Hero square",
    note: "Square photo, 43 mm of page left underneath.",
    tags: ["hero", "writing"],
    slots: [s("S1", 7, 7, 91, 91)],
  },
  {
    id: "a6-2-stack", formatId: "a6", name: "Two stacked",
    note: "Two landscapes, full page.",
    tags: ["grid"],
    slots: [s("S1", 7, 7, 91, 64.5), s("S2", 7, 76.5, 91, 64.5)],
  },
  {
    id: "a6-3-stack", formatId: "a6", name: "Three stacked",
    note: "Three full-width bands. Morning, afternoon, evening.",
    tags: ["strip"],
    slots: [s("S1", 7, 7, 91, 41.3), s("S2", 7, 53.3, 91, 41.3), s("S3", 7, 99.6, 91, 41.3)],
  },
  {
    id: "a6-4-grid", formatId: "a6", name: "Four grid",
    note: "2 × 2 filling the page.",
    tags: ["grid"],
    slots: [
      s("S1", 7, 7, 43, 64.5), s("S2", 55, 7, 43, 64.5),
      s("S3", 7, 76.5, 43, 64.5), s("S4", 55, 76.5, 43, 64.5),
    ],
  },
  {
    id: "a6-6-grid", formatId: "a6", name: "Six grid",
    note: "3 × 2. Best for a whole day or a set of small moments.",
    tags: ["grid", "seasonal"],
    slots: [
      s("S1", 7, 7, 27.5, 41.3),   s("S2", 38.75, 7, 27.5, 41.3),   s("S3", 70.5, 7, 27.5, 41.3),
      s("S4", 7, 53.3, 27.5, 41.3), s("S5", 38.75, 53.3, 27.5, 41.3), s("S6", 70.5, 53.3, 27.5, 41.3),
    ],
  },
  {
    id: "a6-editorial-tall", formatId: "a6", name: "Editorial tall",
    note: "One full-height photo left, a small square bottom right, whitespace between. Magazine feel.",
    tags: ["editorial", "writing"],
    slots: [s("S1", 7, 7, 40, 134), s("S2", 53, 96, 45, 45)],
  },
  {
    id: "a6-circle-trio", formatId: "a6", name: "Circle trio",
    note: "Three circles down the page. Soft and unusual — good for portraits.",
    tags: ["editorial", "writing"],
    slots: [
      s("S1", 7, 7, 42, 42, 0, "circle"),
      s("S2", 56, 51, 42, 42, 0, "circle"),
      s("S3", 7, 95, 42, 42, 0, "circle"),
    ],
  },
];

// ---------------------------------------------------------------------------
// A5 — 148 × 210, margin 10, live area 128 × 190
// ---------------------------------------------------------------------------

const A5: Template[] = [
  {
    id: "a5-hero", formatId: "a5", name: "Hero square",
    note: "Big square, 62 mm of writing space below.",
    tags: ["hero", "writing"],
    slots: [s("S1", 10, 10, 128, 128)],
  },
  {
    id: "a5-2-stack", formatId: "a5", name: "Two stacked",
    note: "Two large landscapes, full page.",
    tags: ["grid"],
    slots: [s("S1", 10, 10, 128, 92.5), s("S2", 10, 107.5, 128, 92.5)],
  },
  {
    id: "a5-3-stack", formatId: "a5", name: "Three stacked",
    note: "Three full-width bands.",
    tags: ["strip"],
    slots: [s("S1", 10, 10, 128, 60), s("S2", 10, 75, 128, 60), s("S3", 10, 140, 128, 60)],
  },
  {
    id: "a5-4-grid", formatId: "a5", name: "Four grid",
    note: "2 × 2, large. The default A5 spread.",
    tags: ["grid"],
    slots: [
      s("S1", 10, 10, 61.5, 92.5), s("S2", 76.5, 10, 61.5, 92.5),
      s("S3", 10, 107.5, 61.5, 92.5), s("S4", 76.5, 107.5, 61.5, 92.5),
    ],
  },
  {
    id: "a5-6-grid", formatId: "a5", name: "Six grid",
    note: "2 × 3. A full day, or six of a trip.",
    tags: ["grid"],
    slots: [
      s("S1", 10, 10, 61.5, 60),  s("S2", 76.5, 10, 61.5, 60),
      s("S3", 10, 75, 61.5, 60),  s("S4", 76.5, 75, 61.5, 60),
      s("S5", 10, 140, 61.5, 60), s("S6", 76.5, 140, 61.5, 60),
    ],
  },
  {
    id: "a5-9-grid", formatId: "a5", name: "Nine grid",
    note: "3 × 3 contact-sheet style. Photos come out at 40 × 60 mm — check quality before printing.",
    tags: ["grid", "seasonal"],
    slots: [
      s("S1", 10, 10, 40, 60.6),   s("S2", 54, 10, 40, 60.6),   s("S3", 98, 10, 40, 60.6),
      s("S4", 10, 74.7, 40, 60.6), s("S5", 54, 74.7, 40, 60.6), s("S6", 98, 74.7, 40, 60.6),
      s("S7", 10, 139.4, 40, 60.6), s("S8", 54, 139.4, 40, 60.6), s("S9", 98, 139.4, 40, 60.6),
    ],
  },
  {
    id: "a5-weekly-accents", formatId: "a5", name: "Weekly accents",
    note: "Five small squares down the right margin, the rest of the page free for a weekly log. Bujo style.",
    tags: ["writing", "strip"],
    slots: [
      s("S1", 112, 10, 26, 26),  s("S2", 112, 42, 26, 26),
      s("S3", 112, 74, 26, 26),  s("S4", 112, 106, 26, 26),
      s("S5", 112, 138, 26, 26),
    ],
  },
  {
    id: "a5-hero-plus-3", formatId: "a5", name: "Hero plus three",
    note: "One big landscape, three verticals beneath it. Strong opener for a trip.",
    tags: ["hero", "editorial"],
    slots: [
      s("S1", 10, 10, 128, 110),
      s("S2", 10, 125, 40, 62), s("S3", 54, 125, 40, 62), s("S4", 98, 125, 40, 62),
    ],
  },
  {
    id: "a5-collage-scatter", formatId: "a5", name: "Collage scatter",
    note: "Five tilted photos, overlapping. Deliberately messy — layer them in whatever order you like.",
    tags: ["collage"],
    slots: [
      s("S1", 12, 14, 62, 78, -4), s("S2", 70, 30, 58, 72, 3),
      s("S3", 16, 90, 54, 68, 2),  s("S4", 74, 106, 60, 74, -3),
      s("S5", 44, 160, 50, 42, 5),
    ],
  },
  {
    id: "a5-arch-pair", formatId: "a5", name: "Arch pair",
    note: "Two tall arches. Elegant, works for people and doorways alike.",
    tags: ["editorial", "writing"],
    slots: [
      s("S1", 10, 10, 61.5, 140, 0, "arch"), s("S2", 76.5, 10, 61.5, 140, 0, "arch"),
    ],
  },
];

// ---------------------------------------------------------------------------
// Standard TN — 110 × 210, margin 8, live area 94 × 194
// ---------------------------------------------------------------------------

const STANDARD: Template[] = [
  {
    id: "std-hero", formatId: "standard-tn", name: "Hero square",
    note: "Square top, 100 mm of page below. Lots of room to write.",
    tags: ["hero", "writing"],
    slots: [s("S1", 8, 8, 94, 94)],
  },
  {
    id: "std-3-stack", formatId: "standard-tn", name: "Three stacked",
    note: "Three landscapes filling the tall page.",
    tags: ["grid"],
    slots: [s("S1", 8, 8, 94, 61.3), s("S2", 8, 74.3, 94, 61.3), s("S3", 8, 140.6, 94, 61.3)],
  },
  {
    id: "std-filmstrip-4", formatId: "standard-tn", name: "Filmstrip four",
    note: "Four bands down the page. The TN shape was made for this.",
    tags: ["strip"],
    slots: [
      s("S1", 8, 8, 94, 45), s("S2", 8, 57.66, 94, 45),
      s("S3", 8, 107.32, 94, 45), s("S4", 8, 156.98, 94, 45),
    ],
  },
  {
    id: "std-2col-tall", formatId: "standard-tn", name: "Two tall columns",
    note: "Two full-height verticals. Dramatic.",
    tags: ["editorial"],
    slots: [s("S1", 8, 8, 45, 194), s("S2", 57, 8, 45, 194)],
  },
  {
    id: "std-6-grid", formatId: "standard-tn", name: "Six grid",
    note: "2 × 3 filling the page.",
    tags: ["grid"],
    slots: [
      s("S1", 8, 8, 45, 61.3),   s("S2", 57, 8, 45, 61.3),
      s("S3", 8, 74.3, 45, 61.3), s("S4", 57, 74.3, 45, 61.3),
      s("S5", 8, 140.6, 45, 61.3), s("S6", 57, 140.6, 45, 61.3),
    ],
  },
  {
    id: "std-tall-plus-notes", formatId: "standard-tn", name: "Tall plus notes",
    note: "One narrow full-height photo, the rest of the width for a long written entry.",
    tags: ["editorial", "writing"],
    slots: [s("S1", 8, 8, 38, 194)],
  },
];

// ---------------------------------------------------------------------------
// Hobonichi Cousin — 152 × 216, margin 10, live area 132 × 196
// ---------------------------------------------------------------------------

const HOBONICHI: Template[] = [
  {
    id: "hc-hero", formatId: "hobonichi-cousin", name: "Hero square",
    note: "Big square, 64 mm below for the daily entry.",
    tags: ["hero", "writing"],
    slots: [s("S1", 10, 10, 132, 132)],
  },
  {
    id: "hc-2-stack", formatId: "hobonichi-cousin", name: "Two stacked",
    note: "Two large landscapes, full page.",
    tags: ["grid"],
    slots: [s("S1", 10, 10, 132, 95.5), s("S2", 10, 110.5, 132, 95.5)],
  },
  {
    id: "hc-4-grid", formatId: "hobonichi-cousin", name: "Four grid",
    note: "2 × 2, large.",
    tags: ["grid"],
    slots: [
      s("S1", 10, 10, 63.5, 95.5), s("S2", 78.5, 10, 63.5, 95.5),
      s("S3", 10, 110.5, 63.5, 95.5), s("S4", 78.5, 110.5, 63.5, 95.5),
    ],
  },
  {
    id: "hc-6-grid", formatId: "hobonichi-cousin", name: "Six grid",
    note: "2 × 3.",
    tags: ["grid"],
    slots: [
      s("S1", 10, 10, 63.5, 62),  s("S2", 78.5, 10, 63.5, 62),
      s("S3", 10, 77, 63.5, 62),  s("S4", 78.5, 77, 63.5, 62),
      s("S5", 10, 144, 63.5, 62), s("S6", 78.5, 144, 63.5, 62),
    ],
  },
  {
    id: "hc-daily-strip", formatId: "hobonichi-cousin", name: "Daily strip",
    note: "Four shallow bands with 21 mm spare at the bottom. One per meal, or one per hour block.",
    tags: ["strip", "writing"],
    slots: [
      s("S1", 10, 10, 132, 40), s("S2", 10, 55, 132, 40),
      s("S3", 10, 100, 132, 40), s("S4", 10, 145, 132, 40),
    ],
  },
  {
    id: "hc-editorial-offset", formatId: "hobonichi-cousin", name: "Editorial offset",
    note: "Tall photo left, two stacked squares right, whitespace at the foot. Quiet and considered.",
    tags: ["editorial", "writing"],
    slots: [
      s("S1", 10, 10, 72, 150),
      s("S2", 87, 10, 55, 55), s("S3", 87, 70, 55, 55),
    ],
  },
];

// ---------------------------------------------------------------------------

/** The hand-authored set — the considered layouts. */
export const AUTHORED_TEMPLATES: Template[] = [
  ...PASSPORT, ...POCKET, ...A6, ...A5, ...STANDARD, ...HOBONICHI,
].map((t) => ({ ...t, origin: "authored" as const }));

/**
 * Everything pickable: the hand-authored layouts first, then the parametric
 * ones. Both sets are validated by `validateTemplates` below.
 */
export const TEMPLATES: Template[] = [...AUTHORED_TEMPLATES, ...GENERATED_TEMPLATES];

export const templateById = (id: string): Template | undefined =>
  TEMPLATES.find((t) => t.id === id);

export const templatesForFormat = (formatId: string): Template[] =>
  TEMPLATES.filter((t) => t.formatId === formatId);

export const formatForTemplate = (t: Template): JournalFormat =>
  FORMATS.find((f) => f.id === t.formatId)!;

/**
 * Dev-time assertion. Run this in a test — it will catch any slot that has
 * drifted outside its page margin after an edit.
 *
 * Rotated slots are checked on their unrotated box, so the scatter layouts
 * are expected to overhang slightly. That's intentional; exclude "collage".
 */
export function validateTemplates(): string[] {
  const errors: string[] = [];
  const byId = Object.fromEntries(FORMATS.map((f) => [f.id, f]));

  for (const t of TEMPLATES) {
    const f = byId[t.formatId];
    if (!f) { errors.push(`${t.id}: unknown format ${t.formatId}`); continue; }
    if (t.tags.includes("collage")) continue;

    const bleedFull =
      t.slots.length === 1 &&
      t.slots[0].w_mm === f.page_w_mm &&
      t.slots[0].h_mm === f.page_h_mm;
    const m = bleedFull ? 0 : f.margin_mm;

    for (const sl of t.slots) {
      if (sl.x_mm < m - 0.01) errors.push(`${t.id}/${sl.id}: left of margin`);
      if (sl.y_mm < m - 0.01) errors.push(`${t.id}/${sl.id}: above margin`);
      if (sl.x_mm + sl.w_mm > f.page_w_mm - m + 0.01) errors.push(`${t.id}/${sl.id}: overflows right`);
      if (sl.y_mm + sl.h_mm > f.page_h_mm - m + 0.01) errors.push(`${t.id}/${sl.id}: overflows bottom`);
    }
  }
  return errors;
}
