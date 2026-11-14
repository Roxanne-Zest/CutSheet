import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Poly, Ring } from "./types";
import { A4, mmToPt, round } from "../units";
import { INK, MUTED, PRINT_AT_100, RULER_CHECK, drawRuler100, makeDraw } from "../pdfDraw";
import { boundsOf } from "./trace";
import { offsetPolys } from "./offset";
import type { CurvePoly } from "./curves";
import { curveRingPath, curvesPath } from "./curves";

/**
 * P7 — getting the path out.
 *
 * Size in millimetres is set by the user, never inferred. Same discipline as
 * everywhere else in this app: type "48 mm wide" and everything downstream is
 * exact.
 */

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/** One ring as an SVG path fragment, in whatever units it is already in. */
export const ringPath = (ring: Ring): string => {
  if (ring.length < 3) return "";
  const parts = [`M ${fmt(ring[0].x)} ${fmt(ring[0].y)}`];
  for (let i = 1; i < ring.length; i++) parts.push(`L ${fmt(ring[i].x)} ${fmt(ring[i].y)}`);
  parts.push("Z");
  return parts.join(" ");
};

/**
 * A whole polygon set as one path. Outers are clockwise and holes
 * counter-clockwise, so `fill-rule: evenodd` and non-zero agree.
 */
export const polysPath = (polys: Poly[]): string =>
  polys
    .flatMap((p) => [ringPath(p.outer), ...p.holes.map(ringPath)])
    .filter(Boolean)
    .join(" ");

export type ExportInput = {
  /** The cut path, in millimetres, top-left at the origin. */
  polys: Poly[];
  /** The same path as curves. Written in preference to `polys` when present. */
  curves?: CurvePoly[];
  /** The finished artwork as a data URI, already composited with its border. */
  artworkDataUri?: string;
  /** Size of the artwork in millimetres. */
  w_mm: number;
  h_mm: number;
  name: string;
};

/**
 * SVG — the universal target.
 *
 * Artwork embedded, cut path on its own layer, document sized in millimetres so
 * anything that opens it agrees about how big the sticker is.
 */
export const toSvg = (o: ExportInput): string => {
  const w = round(o.w_mm, 4);
  const h = round(o.h_mm, 4);
  const image = o.artworkDataUri
    ? `\n    <image x="0" y="0" width="${w}" height="${h}" href="${o.artworkDataUri}" />`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
  <title>${o.name} — Cut Sheet cut path</title>
  <g id="artwork">${image}
  </g>
  <g id="cut" data-cut-path="true"
     fill="none" stroke="#ff0000" stroke-width="0.1" fill-rule="evenodd">
    <path d="${o.curves?.length ? curvesPath(o.curves) : polysPath(o.polys)}" />
  </g>
</svg>
`;
};

/** Design Space reads SVG user units at 72 to the inch and ignores the rest. */
const CRICUT_UNITS_PER_MM = 72 / 25.4;

/**
 * SVG for Cricut Design Space — the cut line and nothing else.
 *
 * Design Space does not take an SVG with a picture in it, and it sizes an SVG
 * from its raw coordinates at 72 units to the inch whatever the width and
 * height attributes say. So this file is one filled path per sticker, in those
 * units, and it lands on the canvas at true size as a ready-made cut layer.
 */
export const toCricutSvg = (o: ExportInput & { fill?: string }): string => {
  const k = CRICUT_UNITS_PER_MM;
  const w = round(o.w_mm * k, 3);
  const h = round(o.h_mm * k, 3);
  const paths = (o.curves ?? [])
    .map((p, i) => {
      const d = [p.outer, ...p.holes].map((r) => curveRingPath(r, k)).join(" ");
      return `  <path id="cut-${i + 1}" d="${d}" fill="${o.fill ?? "#000000"}" fill-rule="evenodd" stroke="none" />`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <title>${o.name} — cut lines, ${round(o.w_mm, 1)} x ${round(o.h_mm, 1)} mm</title>
${paths}
</svg>
`;
};

/**
 * Silhouette registration marks.
 *
 * The geometry below follows the published Silhouette layout — a filled square
 * at top-left and an L-bracket at top-right and bottom-left — but the exact
 * dimensions vary between Studio versions and machines, and this has not been
 * verified against a real cut. Treat it as a starting point and run a test cut
 * before trusting it with a whole sheet.
 */
export const SILHOUETTE = {
  margin_mm: 15,
  squareSize_mm: 5,
  legLength_mm: 20,
  legWidth_mm: 5,
} as const;

const drawRegistrationMarks = (d: ReturnType<typeof makeDraw>): void => {
  const { margin_mm: m, squareSize_mm: sq, legLength_mm: leg, legWidth_mm: lw } = SILHOUETTE;
  const right = A4.w_mm - m;
  const bottom = A4.h_mm - m;

  // Top-left: a solid square.
  d.fillRect(m, m, sq, sq, INK);

  // Top-right: an L opening down-left.
  d.fillRect(right - leg, m, leg, lw, INK);
  d.fillRect(right - lw, m, lw, leg, INK);

  // Bottom-left: an L opening up-right.
  d.fillRect(m, bottom - lw, leg, lw, INK);
  d.fillRect(m, bottom - leg, lw, leg, INK);
};

export type PdfExportInput = ExportInput & {
  /** Registration marks for a Silhouette, rather than a plain trim guide. */
  registrationMarks: boolean;
  /** Embed the artwork, if it was supplied. */
  artworkPng?: Uint8Array;
};

/**
 * PDF — either a Silhouette print-and-cut sheet, or a plain print-and-trim page
 * with the path as a hairline guide.
 */
export const toPdf = async (o: PdfExportInput): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${o.name} — Cut Sheet cut path`);
  pdf.setProducer("Cut Sheet");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([mmToPt(A4.w_mm), mmToPt(A4.h_mm)]);
  const d = makeDraw(page, A4.h_mm);

  if (o.registrationMarks) drawRegistrationMarks(d);

  // Inside the registration marks if there are any, otherwise a plain margin.
  const inset = o.registrationMarks ? SILHOUETTE.margin_mm + SILHOUETTE.legLength_mm + 4 : 12;
  const x = (A4.w_mm - o.w_mm) / 2;
  const y = Math.max(inset, (A4.h_mm - 30 - o.h_mm) / 2);

  if (o.artworkPng) {
    const img = await pdf.embedPng(o.artworkPng);
    d.image(img, x, y, o.w_mm, o.h_mm);
  }

  // The cut path itself, as a hairline in the same place as the artwork.
  const shifted = o.polys.map((p) => ({
    outer: p.outer.map((q) => ({ x: q.x + x, y: q.y + y })),
    holes: p.holes.map((h) => h.map((q) => ({ x: q.x + x, y: q.y + y }))),
  }));
  for (const poly of shifted) {
    for (const ring of [poly.outer, ...poly.holes]) {
      page.drawSvgPath(
        ringPath(ring.map((q) => ({ x: mmToPt(q.x), y: mmToPt(q.y) }))),
        {
          x: 0,
          y: mmToPt(A4.h_mm),
          borderColor: rgb(0.85, 0.1, 0.1),
          borderWidth: 0.25,
        },
      );
    }
  }

  d.text(PRINT_AT_100, 12, A4.h_mm - 18, bold, 7);
  d.text(
    `${o.name} · ${round(o.w_mm, 1)} x ${round(o.h_mm, 1)} mm · cut path in red${
      o.registrationMarks ? " · Silhouette registration marks (test cut before trusting)" : ""
    }`,
    12,
    A4.h_mm - 14,
    font,
    6.5,
    MUTED,
  );
  drawRuler100(d, font, 12, A4.h_mm - 11, 20);
  d.text(RULER_CHECK, 12, A4.h_mm - 1.5, font, 5.5, MUTED);

  return pdf.save();
};

/**
 * Pixel dimensions for the Cricut target: the path baked as the alpha boundary
 * at a stated resolution, because Design Space regenerates contours from alpha.
 */
export const pngPixelSize = (
  w_mm: number,
  h_mm: number,
  dpi = 300,
): { w: number; h: number } => ({
  w: Math.max(1, Math.round((w_mm / 25.4) * dpi)),
  h: Math.max(1, Math.round((h_mm / 25.4) * dpi)),
});

/** Bounds check used by the UI and by the tests, so both agree what "fits" is. */
export const pathBounds = boundsOf;

/**
 * The Cricut pair — so Design Space never has to trace anything.
 *
 * Handing Design Space a PNG means it rebuilds the cut line from the alpha edge
 * with its own tracer, which smooths and simplifies, and that re-trace is where
 * the accuracy goes. So the path goes over as what it already is: a vector
 * shape. The user puts the shape behind the print image and flattens the two,
 * and a flattened Print Then Cut layer cuts round its outer outline — which is
 * the shape, provided the image never pokes out past it.
 *
 * That proviso is what the inset is for. Design Space still traces the image's
 * own edge when it is uploaded, and its trace can bulge out a fraction past the
 * true edge, especially into concave notches. Pulling the image's transparent
 * edge in by a small margin keeps any such bulge inside the vector shape, so the
 * outer outline is the shape and nothing else. The band between the two is
 * printed by the shape itself, in the border colour, so nothing shows.
 *
 * The shape is `toCricutSvg` filled in the border colour rather than black, so
 * the band it prints is indistinguishable from the border around it.
 *
 * Half the border, capped, so the image keeps most of its border and the margin
 * stays well clear of the artwork. No border, no inset: there is no band of
 * border colour to hide it in, and a sliver would show at the edge.
 */
export const CRICUT_INSET_MAX_MM = 0.75;

export const cricutInset = (border_mm: number): number =>
  border_mm > 0 ? round(Math.min(CRICUT_INSET_MAX_MM, border_mm / 2), 3) : 0;

/** The print image's outline: the cut path pulled in by the inset. */
export const cricutPrintPolys = (polys: Poly[], inset_mm: number): Poly[] =>
  inset_mm > 0 ? offsetPolys(polys, -inset_mm) : polys;
