/**
 * Cut Sheet data model.
 *
 * Everything physical is in millimetres. Crops are normalised 0..1 against the
 * *oriented* source image (i.e. after the placement's 90-degree rotation has
 * been applied), which is what keeps crop maths stable across rotate.
 */

export type SlotShape = "rect" | "rounded" | "circle" | "arch";

export type Slot = {
  id: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  rotation_deg: number;
  shape: SlotShape;
};

export type JournalFormat = {
  id: string;
  name: string;
  page_w_mm: number;
  page_h_mm: number;
  margin_mm: number;
};

export type TemplateTag =
  | "hero"        // one dominant image
  | "grid"        // regular rows and columns
  | "strip"       // filmstrip / repeated band
  | "editorial"   // tall, asymmetric, generous whitespace
  | "collage"     // overlapping or rotated, scrapbook feel
  | "writing"     // leaves deliberate space for text
  | "seasonal";   // works well for a dated/event spread

export type Template = {
  id: string;
  formatId: string;
  name: string;
  /** Why you'd reach for this one. Shown on hover in the picker. */
  note: string;
  tags: TemplateTag[];
  slots: Slot[];
};

/** Normalised crop rect in oriented-image space. Values are 0..1. */
export type Crop = { x: number; y: number; w: number; h: number };

export type Quarter = 0 | 90 | 180 | 270;

export type Placement = {
  slotId: string;
  assetId: string;
  crop: Crop;
  rotation: Quarter;
  /**
   * Spec extension: fine straighten angle in degrees, clockwise-positive in
   * image space (y down). The crop rect rotates rigidly about its own centre,
   * so at 0 this degenerates exactly to the spec's axis-aligned crop.
   */
  straighten_deg: number;
  copies: 1 | 2 | 3 | 4;
  /** Per-slot shape override. Falls back to the template slot's own shape. */
  shape?: SlotShape;
};

export type Spread = {
  id: string;
  templateId: string;
  placements: Placement[];
};

export type Asset = {
  id: string;
  name: string;
  type: string;
  w_px: number;
  h_px: number;
  blob: Blob;
};

/**
 * A single photo to be printed at a chosen physical size.
 *
 * `w_mm`/`h_mm` are the finished size and are never inferred downstream —
 * everything after this point reads them verbatim.
 *
 * Spec extensions: `rotation`, `straighten_deg` and `shape` ride along because
 * the renderer cannot reconstruct them from `crop` alone; `label` is the P-ID
 * shared by the layout plan and the sheets.
 */
export type PrintItem = {
  id: string;
  assetId: string;
  crop: Crop;
  rotation: Quarter;
  straighten_deg: number;
  w_mm: number;
  h_mm: number;
  shape: SlotShape;
  fromSpread: string;
  fromSlot: string;
  copies: number;
  label: string;
};

export type SheetPlacement = {
  itemId: string;
  copy: number;
  sheet: number;
  x_mm: number;
  y_mm: number;
  rotated: boolean;
};

export type OutputSettings = {
  gap_mm: 0 | 1 | 2 | 3;
  allowRotate: boolean;
  cropMarks: boolean;
  idLabels: boolean;
  shapeGuides: boolean;
  bleed_mm: number;
  /**
   * Open question in the spec: rounded corners look better in journals, but
   * square is what a guillotine gives you for free. Left square by default and
   * switchable per project rather than decided in the seed data.
   */
  cornerStyle: "square" | "rounded";
};

export type Project = {
  id: string;
  name: string;
  formatId: string;
  spreads: Spread[];
  settings: OutputSettings;
  updatedAt: number;
};

export const DEFAULT_SETTINGS: OutputSettings = {
  gap_mm: 0,
  allowRotate: true,
  cropMarks: true,
  idLabels: true,
  shapeGuides: true,
  bleed_mm: 0,
  cornerStyle: "square",
};
