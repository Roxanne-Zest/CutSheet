import { PDFDocument } from "pdf-lib";
import { ptToMm, round } from "./units";
import type { SizerSource } from "./sizerPdf";

/**
 * Loading a sticker sheet.
 *
 * Three input types, one shape out: pixels to measure on screen, bytes to embed
 * in the output, and — for PDFs only — the physical size the file already
 * claims, which is usually the answer without any measuring at all.
 */

/** Resolution the PDF preview is rasterised at, for the measure tool. */
export const PDF_PREVIEW_DPI = 200;

export type LoadedSheet = {
  name: string;
  /** What the measure tool draws and samples. */
  bitmap: CanvasImageSource;
  w_px: number;
  h_px: number;
  /** What goes into the output PDF. */
  source: SizerSource;
  /**
   * The size the file itself declares, if it declares one. A PDF always does;
   * a PNG or JPEG does not carry anything trustworthy, so this stays undefined.
   */
  declared?: { w_mm: number; h_mm: number; from: string };
  pages?: number;
};

export const isPdf = (file: File): boolean =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/**
 * The physical size a PDF page declares. Read with pdf-lib, which is already a
 * dependency, so this costs nothing even when the preview renderer is not.
 */
export const pdfPageSize = async (
  bytes: Uint8Array,
  pageIndex = 0,
): Promise<{ w_mm: number; h_mm: number; pages: number }> => {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(Math.min(pageIndex, doc.getPageCount() - 1));
  const { width, height } = page.getSize();
  return {
    w_mm: round(ptToMm(width), 4),
    h_mm: round(ptToMm(height), 4),
    pages: doc.getPageCount(),
  };
};

const loadImage = async (file: File): Promise<LoadedSheet> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file);
  return {
    name: file.name,
    bitmap,
    w_px: bitmap.width,
    h_px: bitmap.height,
    source: { kind: "image", bytes, mime: file.type || "image/png" },
  };
};

/**
 * Rasterise page one for the measure tool, but keep the original bytes so the
 * output stays vector. pdfjs is loaded on demand — most people drop a PNG and
 * should not pay for a PDF renderer they never open.
 */
const loadPdf = async (file: File, pageIndex: number): Promise<LoadedSheet> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const declared = await pdfPageSize(bytes, pageIndex);

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  // pdfjs takes ownership of the buffer it is handed, so give it a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const page = await doc.getPage(Math.min(pageIndex + 1, doc.numPages));
  const viewport = page.getViewport({ scale: PDF_PREVIEW_DPI / 72 });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    name: file.name,
    bitmap: canvas,
    w_px: canvas.width,
    h_px: canvas.height,
    source: { kind: "pdf", bytes, pageIndex },
    declared: { w_mm: declared.w_mm, h_mm: declared.h_mm, from: "the PDF's own page size" },
    pages: declared.pages,
  };
};

export const loadSheet = async (file: File, pageIndex = 0): Promise<LoadedSheet> =>
  isPdf(file) ? loadPdf(file, pageIndex) : loadImage(file);

/**
 * The measurement a declared size implies, so "use the size the file says" and
 * "measure it yourself" produce the same kind of answer downstream.
 */
export const measurementFromDeclared = (
  declared: { w_mm: number },
  w_px: number,
): { measured_px: number; target_mm: number } => ({
  measured_px: w_px,
  target_mm: declared.w_mm,
});
