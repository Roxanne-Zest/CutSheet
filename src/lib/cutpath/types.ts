/**
 * Cut Path Builder — shared types.
 *
 * The premise: an AI-generated sticker arrives with a white border painted into
 * the pixels. It wobbles, it is soft, and there is no geometry behind it. So we
 * do not trace that edge — we find the artwork proper, throw the fake border
 * away, and build a fresh mathematically-offset one with a real vector path.
 */

/** A binary artwork/not-artwork raster. 1 is artwork. */
export type Mask = {
  data: Uint8Array;
  w: number;
  h: number;
};

export type Pt = { x: number; y: number };

/** A closed ring. The first point is not repeated at the end. */
export type Ring = Pt[];

/** One traced shape: an outer boundary and any holes inside it. */
export type Poly = { outer: Ring; holes: Ring[] };

export type CutPathSettings = {
  /** How far from the corner colour still counts as background. 0..1. */
  backgroundTolerance: number;
  /** Alpha cut-off, for artwork that has an alpha channel. 0..1. */
  edgeThreshold: number;
  /** Morphological open/close radius, in source pixels. */
  smoothing: number;
  /** Die-cut border. Negative cuts inside the artwork edge. */
  border_mm: number;
  /** The blade cannot turn tighter than this. */
  bladeRadius_mm: number;
  /** Cut the hole out of a donut. Almost never what you want. */
  keepHoles: boolean;
  /** Finished width. Set by the user, never inferred. */
  width_mm: number;
};

export const DEFAULT_CUTPATH: CutPathSettings = {
  backgroundTolerance: 0.12,
  edgeThreshold: 0.5,
  smoothing: 2,
  border_mm: 2,
  bladeRadius_mm: 1,
  keepHoles: false,
  width_mm: 48,
};

/**
 * Photos want a slight negative offset so no white fringe shows if registration
 * drifts; stickers want the classic positive border.
 */
export const PHOTO_BORDER_MM = -0.5;

/** Under 400 nodes per sticker, or the plotter stutters and the cut jitters. */
export const NODE_BUDGET = 400;

export type CutPathStats = {
  stickers: number;
  /** Which route the mask took, so the UI can grey out the control that is idle. */
  source: "alpha" | "background";
  nodes: number;
  /** Finished size of the whole cut path, in millimetres. */
  w_mm: number;
  h_mm: number;
  /** RDP tolerance actually used — raised automatically if the budget bit. */
  tolerance_mm: number;
  warnings: string[];
};

export type CutPathResult = {
  /** The final cut path, in millimetres, origin at the artwork's top-left. */
  polys: Poly[];
  /** The artwork boundary before offsetting, for the on-screen overlay. */
  artwork: Poly[];
  mask: Mask;
  stats: CutPathStats;
};

export const newMask = (w: number, h: number): Mask => ({
  data: new Uint8Array(w * h),
  w,
  h,
});

export const cloneMask = (m: Mask): Mask => ({
  data: new Uint8Array(m.data),
  w: m.w,
  h: m.h,
});
