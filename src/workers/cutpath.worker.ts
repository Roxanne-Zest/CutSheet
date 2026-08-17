import { runCutPath } from "../lib/cutpath/pipeline";
import { rasterisePolys } from "../lib/cutpath/composite";
import type { CutPathSettings, Mask, Poly } from "../lib/cutpath/types";

/**
 * P8 — the pipeline off the main thread.
 *
 * It is a few megapixels through several passes, and every slider move runs all
 * of it. On the main thread the controls feel like treacle, so they live here
 * instead and the UI only ever paints.
 */

export type CutPathRequest = {
  id: number;
  width: number;
  height: number;
  /** Transferred, not copied. */
  pixels: ArrayBuffer;
  settings: CutPathSettings;
};

export type CutPathResponse = {
  id: number;
  polys: Poly[];
  artwork: Poly[];
  /** Artwork mask, for the magenta overlay. */
  maskBits: ArrayBuffer;
  /** Everything inside the cut path, for the composite. */
  cutBits: ArrayBuffer;
  maskW: number;
  maskH: number;
  stats: {
    stickers: number;
    source: "alpha" | "background" | "ink";
    nodes: number;
    w_mm: number;
    h_mm: number;
    tolerance_mm: number;
    warnings: string[];
  };
  ms: number;
};

const toBits = (m: Mask): ArrayBuffer => {
  const copy = new Uint8Array(m.data);
  return copy.buffer;
};

self.onmessage = (e: MessageEvent<CutPathRequest>) => {
  const { id, width, height, pixels, settings } = e.data;
  const started = performance.now();

  const img = { data: new Uint8ClampedArray(pixels), w: width, h: height };
  const result = runCutPath(img, settings);

  // The cut mask is rasterised here too: the main thread would otherwise have
  // to redo the scan conversion just to composite the preview.
  const pxPerMm = settings.width_mm > 0 ? width / settings.width_mm : 1;
  const cut = rasterisePolys(result.polys, width, height, pxPerMm);

  const maskBits = toBits(result.mask);
  const cutBits = toBits(cut);

  const response: CutPathResponse = {
    id,
    polys: result.polys,
    artwork: result.artwork,
    maskBits,
    cutBits,
    maskW: width,
    maskH: height,
    stats: result.stats,
    ms: Math.round(performance.now() - started),
  };

  (self as unknown as Worker).postMessage(response, [maskBits, cutBits]);
};
