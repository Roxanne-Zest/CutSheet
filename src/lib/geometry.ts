import type { Crop, Quarter } from "../types";
import { clamp } from "./units";

/**
 * Crop maths.
 *
 * A crop is a rectangle sampled from the *oriented* source image (the image
 * after its 0/90/180/270 rotation has been applied). It is stored normalised
 * 0..1, but every operation here is computed in pixel space, because normalised
 * space is anisotropic for non-square images — rotating a rect there would
 * shear it. Straighten is a rigid rotation of the crop rect about its own
 * centre in pixel space.
 *
 * Two invariants hold after `normalizeCrop`, and are what the unit tests pin:
 *   1. aspect:  (crop.w * iw) / (crop.h * ih) === ctx.aspect
 *   2. bounds:  the rotated crop rect lies entirely inside the image
 */

export const MAX_ZOOM = 8;

export type CropContext = {
  /** Oriented image width in pixels. */
  iw: number;
  /** Oriented image height in pixels. */
  ih: number;
  /** Target aspect ratio, w/h, from the slot's physical mm. */
  aspect: number;
  /** Straighten angle, degrees, clockwise-positive in image space (y down). */
  straighten_deg: number;
};

const DEG = Math.PI / 180;

/** Size of the source image after applying a quarter-turn rotation. */
export const orientedSize = (
  w_px: number,
  h_px: number,
  rotation: Quarter,
): { w: number; h: number } =>
  rotation === 90 || rotation === 270 ? { w: h_px, h: w_px } : { w: w_px, h: h_px };

/** Axis-aligned bounding box, in pixels, of a wp x hp rect rotated by theta. */
const aabb = (wp: number, hp: number, theta: number): { w: number; h: number } => {
  const c = Math.abs(Math.cos(theta));
  const s = Math.abs(Math.sin(theta));
  return { w: wp * c + hp * s, h: wp * s + hp * c };
};

/**
 * The largest crop of the required aspect that still fits inside the image at
 * the given straighten angle. This is zoom = 1 — you cannot zoom out past it,
 * because doing so would sample outside the photo.
 */
export const coverCropPx = (ctx: CropContext): { w: number; h: number } => {
  const { iw, ih, aspect } = ctx;
  const theta = ctx.straighten_deg * DEG;

  // Largest axis-aligned rect of this aspect inside the image.
  let wp: number;
  let hp: number;
  if (iw / ih >= aspect) {
    hp = ih;
    wp = aspect * ih;
  } else {
    wp = iw;
    hp = iw / aspect;
  }

  // Shrink until the rotated rect's bounding box fits.
  const box = aabb(wp, hp, theta);
  const f = Math.min(iw / box.w, ih / box.h, 1);
  return { w: wp * f, h: hp * f };
};

export const coverCrop = (ctx: CropContext): Crop => {
  const { w, h } = coverCropPx(ctx);
  const cw = w / ctx.iw;
  const ch = h / ctx.ih;
  return { x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch };
};

/**
 * Force a crop back onto the invariants: exact aspect, inside the image.
 *
 * Size is collapsed to a single scale `k` against the cover crop, so the aspect
 * can never drift no matter how the crop was mutated. The centre is preserved
 * where possible and clamped otherwise.
 */
export const normalizeCrop = (crop: Crop, ctx: CropContext): Crop => {
  const cover = coverCropPx(ctx);
  const theta = ctx.straighten_deg * DEG;

  const wp = crop.w * ctx.iw;
  const hp = crop.h * ctx.ih;

  // Recover the intended scale from whichever dimension survived the mutation.
  const kRaw =
    wp > 0 && hp > 0
      ? Math.min(wp / cover.w, hp / cover.h)
      : 1;
  const k = clamp(Number.isFinite(kRaw) ? kRaw : 1, 1 / MAX_ZOOM, 1);

  const outWp = cover.w * k;
  const outHp = cover.h * k;

  const box = aabb(outWp, outHp, theta);
  const halfW = box.w / 2 / ctx.iw;
  const halfH = box.h / 2 / ctx.ih;

  let cx = crop.x + crop.w / 2;
  let cy = crop.y + crop.h / 2;
  if (!Number.isFinite(cx)) cx = 0.5;
  if (!Number.isFinite(cy)) cy = 0.5;

  // halfW/halfH can nudge past 0.5 through floating point; fall back to centred.
  cx = halfW * 2 >= 1 ? 0.5 : clamp(cx, halfW, 1 - halfW);
  cy = halfH * 2 >= 1 ? 0.5 : clamp(cy, halfH, 1 - halfH);

  const w = outWp / ctx.iw;
  const h = outHp / ctx.ih;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
};

/** Crop-to-fill: drop a photo of any aspect ratio on a slot and it fills it. */
export const fillCrop = (ctx: CropContext): Crop => normalizeCrop(coverCrop(ctx), ctx);

/** Current zoom, 1 = cover. */
export const zoomOf = (crop: Crop, ctx: CropContext): number => {
  const cover = coverCropPx(ctx);
  const k = (crop.w * ctx.iw) / cover.w;
  return k > 0 ? clamp(1 / k, 1, MAX_ZOOM) : 1;
};

export const setZoom = (crop: Crop, ctx: CropContext, zoom: number): Crop => {
  const z = clamp(zoom, 1, MAX_ZOOM);
  const cover = coverCropPx(ctx);
  const wp = cover.w / z;
  const hp = cover.h / z;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const w = wp / ctx.iw;
  const h = hp / ctx.ih;
  return normalizeCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, ctx);
};

export const zoomBy = (crop: Crop, ctx: CropContext, factor: number): Crop =>
  setZoom(crop, ctx, zoomOf(crop, ctx) * factor);

/** Pan by a delta expressed in normalised oriented-image units. */
export const panBy = (crop: Crop, ctx: CropContext, dx: number, dy: number): Crop =>
  normalizeCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, ctx);

/**
 * Remap a crop through quarter turns of the source image, so rotating 90 degrees
 * keeps you looking at the same part of the photo instead of jumping.
 *
 * One +90 (clockwise) turn sends normalised (u, v) to (1 - v, u).
 */
export const remapCropQuarter = (crop: Crop, turns: number): Crop => {
  let c = crop;
  const n = ((turns % 4) + 4) % 4;
  for (let i = 0; i < n; i++) {
    c = { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
  }
  return c;
};

export const addQuarter = (rotation: Quarter, turns: number): Quarter => {
  const n = ((rotation / 90 + turns) % 4 + 4) % 4;
  return (n * 90) as Quarter;
};

/** Source pixels feeding this crop, along the crop rect's own axes. */
export const cropPixelSize = (
  crop: Crop,
  ctx: CropContext,
): { w: number; h: number } => ({ w: crop.w * ctx.iw, h: crop.h * ctx.ih });

/** Corners of the crop rect in oriented-image pixel space, clockwise from top-left. */
export const cropCornersPx = (
  crop: Crop,
  ctx: CropContext,
): Array<{ x: number; y: number }> => {
  const theta = ctx.straighten_deg * DEG;
  const cx = (crop.x + crop.w / 2) * ctx.iw;
  const cy = (crop.y + crop.h / 2) * ctx.ih;
  const hw = (crop.w * ctx.iw) / 2;
  const hh = (crop.h * ctx.ih) / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([u, v]) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos }));
};
