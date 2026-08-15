import { useEffect, useRef } from "react";
import type { Crop, Quarter, SlotShape } from "../types";
import { drawCropped } from "../lib/raster";
import type { Source } from "../lib/raster";

/**
 * A slot's photo, drawn through the same code path as the PDF rasteriser so
 * the preview cannot drift from the print.
 */
export function SlotCanvas({
  source,
  crop,
  rotation,
  straighten_deg,
  shape,
  w_px,
  h_px,
}: {
  source: Source;
  crop: Crop;
  rotation: Quarter;
  straighten_deg: number;
  shape: SlotShape;
  w_px: number;
  h_px: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(w_px * dpr));
    const h = Math.max(1, Math.round(h_px * dpr));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The shape is drawn by CSS on the slot, so the canvas stays a plain rect.
    drawCropped(ctx, source, {
      crop,
      rotation,
      straighten_deg,
      shape: "rect",
      outW: w,
      outH: h,
    });
  }, [source, crop, rotation, straighten_deg, shape, w_px, h_px]);

  return <canvas ref={ref} />;
}
