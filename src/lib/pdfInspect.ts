import { PDFDocument } from "pdf-lib";
import type { PDFArray, PDFRawStream, PDFRef } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { ptToMm } from "./units";

/**
 * Test-only PDF reader.
 *
 * S6 is the acceptance test for the whole product, so it is checked against the
 * bytes that actually get written rather than against the calls we made on the
 * way there. This pulls each page's content stream back out and reads the
 * operators.
 */

export type ImageBox = {
  /** Width and height of the drawn image box, in millimetres. */
  w_mm: number;
  h_mm: number;
  /** Rotation applied to the box, in degrees, page-clockwise. */
  rotation_deg: number;
};

export type StraightLine = {
  x1_mm: number;
  y1_mm: number;
  x2_mm: number;
  y2_mm: number;
  length_mm: number;
};

export type PageOps = {
  w_mm: number;
  h_mm: number;
  images: ImageBox[];
  lines: StraightLine[];
  /** Every string actually shown on the page. */
  texts: string[];
  /** Raw operators, for anything the helpers above do not cover. */
  raw: string;
};

const decodeStream = (st: PDFRawStream): string => {
  const raw = Buffer.from(st.getContents());
  try {
    return inflateSync(raw).toString("latin1");
  } catch {
    return raw.toString("latin1");
  }
};

const MATRIX = /^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/gm;

const parseImages = (content: string): ImageBox[] => {
  const out: ImageBox[] = [];
  for (const block of content.split("q\n")) {
    if (!/\/Image[-\w]* Do/.test(block)) continue;
    MATRIX.lastIndex = 0;
    const cms = [...block.matchAll(MATRIX)].map((m) => m.slice(1).map(Number));
    // pdf-lib emits translate, rotate, scale, skew — in that order.
    if (cms.length < 3) continue;
    const rot = cms[1];
    const scale = cms[2];
    out.push({
      w_mm: ptToMm(scale[0]),
      h_mm: ptToMm(scale[3]),
      // The matrix is counter-clockwise; the app thinks page-clockwise.
      rotation_deg: -(Math.atan2(rot[1], rot[0]) * 180) / Math.PI,
    });
  }
  return out;
};

const parseLines = (content: string, pageH_mm: number): StraightLine[] => {
  const out: StraightLine[] = [];
  const tokens = content.split("\n");
  let cur: [number, number] | null = null;
  for (const t of tokens) {
    const m = /^(\S+) (\S+) m$/.exec(t);
    if (m) {
      cur = [Number(m[1]), Number(m[2])];
      continue;
    }
    const l = /^(\S+) (\S+) l$/.exec(t);
    if (l && cur) {
      const x1 = ptToMm(cur[0]);
      const y1 = pageH_mm - ptToMm(cur[1]);
      const x2 = ptToMm(Number(l[1]));
      const y2 = pageH_mm - ptToMm(Number(l[2]));
      out.push({
        x1_mm: x1,
        y1_mm: y1,
        x2_mm: x2,
        y2_mm: y2,
        length_mm: Math.hypot(x2 - x1, y2 - y1),
      });
      cur = [Number(l[1]), Number(l[2])];
    }
  }
  return out;
};

/** pdf-lib writes standard-font text as hex strings: `<5031> Tj`. */
const parseTexts = (content: string): string[] => {
  const out: string[] = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    const hex = m[1];
    let s = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    out.push(s);
  }
  for (const m of content.matchAll(/\(((?:\\.|[^)\\])*)\)\s*Tj/g)) {
    out.push(m[1].replace(/\\([()\\])/g, "$1"));
  }
  return out;
};

/** Read back a generated PDF, page by page. */
export const inspectPdf = async (bytes: Uint8Array): Promise<PageOps[]> => {
  const doc = await PDFDocument.load(bytes);
  const pages: PageOps[] = [];

  for (const page of doc.getPages()) {
    const size = page.getSize();
    const w_mm = ptToMm(size.width);
    const h_mm = ptToMm(size.height);

    const contents = page.node.Contents();
    const refs: PDFRef[] =
      contents && contents.constructor.name === "PDFArray"
        ? ((contents as PDFArray).asArray() as PDFRef[])
        : ([contents] as unknown as PDFRef[]);

    let content = "";
    for (const r of refs) {
      if (!r) continue;
      const st = doc.context.lookup(r) as PDFRawStream;
      if (st && typeof st.getContents === "function") content += decodeStream(st);
    }

    pages.push({
      w_mm,
      h_mm,
      images: parseImages(content),
      lines: parseLines(content, h_mm),
      texts: parseTexts(content),
      raw: content,
    });
  }

  return pages;
};

/** A 1x1 JPEG, so the PDF tests need no canvas. */
export const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z";

export const tinyJpegBytes = (): Uint8Array =>
  Uint8Array.from(Buffer.from(TINY_JPEG_B64, "base64"));
