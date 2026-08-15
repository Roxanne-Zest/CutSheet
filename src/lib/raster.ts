import type { Crop, Quarter, SlotShape } from "../types";
import { mmToPx } from "./units";

/**
 * Canvas rendering for a single cropped photo.
 *
 * The editor preview and the PDF rasteriser both go through `drawCropped`, so
 * what you see on screen is what lands on paper.
 */

const DEG = Math.PI / 180;

export type Source = { bitmap: CanvasImageSource; w_px: number; h_px: number };

export const orientedDims = (
  src: { w_px: number; h_px: number },
  rotation: Quarter,
): { iw: number; ih: number } =>
  rotation === 90 || rotation === 270
    ? { iw: src.h_px, ih: src.w_px }
    : { iw: src.w_px, ih: src.h_px };

/** Put the canvas into oriented-image pixel space, top-left at (0, 0). */
const applyOrientation = (
  ctx: CanvasRenderingContext2D,
  rotation: Quarter,
  rw: number,
  rh: number,
): void => {
  if (rotation === 90) {
    ctx.translate(rh, 0);
    ctx.rotate(90 * DEG);
  } else if (rotation === 180) {
    ctx.translate(rw, rh);
    ctx.rotate(180 * DEG);
  } else if (rotation === 270) {
    ctx.translate(0, rw);
    ctx.rotate(-90 * DEG);
  }
};

export const shapePath = (
  ctx: CanvasRenderingContext2D,
  shape: SlotShape,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape === "rounded") {
    const r = Math.min(w, h) * 0.09;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  } else if (shape === "arch") {
    const r = Math.min(w / 2, h * 0.6);
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.ellipse(x + w / 2, y + r, w / 2, r, 0, Math.PI, Math.PI * 2);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  } else {
    ctx.rect(x, y, w, h);
  }
};

export type DrawOptions = {
  crop: Crop;
  rotation: Quarter;
  straighten_deg: number;
  shape: SlotShape;
  /** Output size in px of the *finished* photo. */
  outW: number;
  outH: number;
  /** Extra printed ring around the finished size, in px. */
  bleedPx?: number;
};

/**
 * Draw the cropped photo filling a canvas of (outW + 2*bleed) x (outH + 2*bleed).
 *
 * The crop rect maps onto the finished rect exactly; the bleed ring is filled
 * by continuing to sample the photo outside the crop, which is what makes an
 * overprint useful. Where the crop already sits on the image edge the ring
 * falls back to white.
 */
export const drawCropped = (
  ctx: CanvasRenderingContext2D,
  src: Source,
  o: DrawOptions,
): void => {
  const bleed = o.bleedPx ?? 0;
  const totalW = o.outW + 2 * bleed;
  const totalH = o.outH + 2 * bleed;

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, totalW, totalH);

  if (o.shape !== "rect") {
    shapePath(ctx, o.shape, bleed, bleed, o.outW, o.outH);
    ctx.clip();
  }

  const { iw, ih } = orientedDims(src, o.rotation);
  const cropWpx = o.crop.w * iw;
  const scale = cropWpx > 0 ? o.outW / cropWpx : 1;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.translate(totalW / 2, totalH / 2);
  ctx.rotate(-o.straighten_deg * DEG);
  ctx.scale(scale, scale);
  ctx.translate(-(o.crop.x + o.crop.w / 2) * iw, -(o.crop.y + o.crop.h / 2) * ih);

  applyOrientation(ctx, o.rotation, src.w_px, src.h_px);
  ctx.drawImage(src.bitmap, 0, 0);

  ctx.restore();
};

const makeCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

export type RasterResult = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  dpi: number;
};

/**
 * Rasterise one print item to JPEG bytes at up to 300 dpi.
 *
 * Resolution is capped at what the source crop actually contains — the app
 * never invents pixels. If that lands under 300 dpi the quality dot already
 * said so at drop time.
 */
export const rasterizeItem = async (
  src: Source,
  o: {
    crop: Crop;
    rotation: Quarter;
    straighten_deg: number;
    shape: SlotShape;
    w_mm: number;
    h_mm: number;
    bleed_mm: number;
    dpi?: number;
    quality?: number;
  },
): Promise<RasterResult> => {
  const dpi = o.dpi ?? 300;
  const { iw } = orientedDims(src, o.rotation);
  const availablePx = o.crop.w * iw;

  const wantPx = mmToPx(o.w_mm, dpi);
  const finishedW = Math.max(1, Math.round(Math.min(wantPx, availablePx)));
  const pxPerMm = finishedW / o.w_mm;
  const finishedH = Math.max(1, Math.round(pxPerMm * o.h_mm));
  const bleedPx = Math.round(pxPerMm * o.bleed_mm);

  const canvas = makeCanvas(finishedW + 2 * bleedPx, finishedH + 2 * bleedPx);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context");

  drawCropped(ctx, src, {
    crop: o.crop,
    rotation: o.rotation,
    straighten_deg: o.straighten_deg,
    shape: o.shape,
    outW: finishedW,
    outH: finishedH,
    bleedPx,
  });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", o.quality ?? 0.92),
  );
  if (!blob) throw new Error("Could not encode the photo for the PDF");

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    widthPx: canvas.width,
    heightPx: canvas.height,
    dpi: pxPerMm * 25.4,
  };
};

/** Decode an asset blob once and keep it around for redraws. */
export const loadSource = async (blob: Blob): Promise<Source> => {
  const bitmap = await createImageBitmap(blob);
  return { bitmap, w_px: bitmap.width, h_px: bitmap.height };
};

export const readImageSize = async (
  blob: Blob,
): Promise<{ w_px: number; h_px: number }> => {
  const bmp = await createImageBitmap(blob);
  const size = { w_px: bmp.width, h_px: bmp.height };
  bmp.close();
  return size;
};
