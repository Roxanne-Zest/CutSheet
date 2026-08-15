import type { SlotShape } from "../types";
import { mmToPt } from "./units";

/**
 * Shape outlines as SVG path strings for pdf-lib.
 *
 * Curves are emitted as cubic Beziers rather than SVG arcs so every control
 * point can be run through the rotation transform exactly.
 *
 * Coordinates are in points, y measured downward from the page top — which is
 * what `page.drawSvgPath(path, { x: 0, y: pageHeight })` expects.
 */

const KAPPA = 0.5522847498307936;
const DEG = Math.PI / 180;

type Pt = [number, number];

/** Rotate about (cx, cy), clockwise-positive in page space (y down). */
const makeTransform = (cx: number, cy: number, deg: number) => {
  const a = deg * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return ([x, y]: Pt): Pt => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
};

const fmt = (v: number): string => (Math.round(v * 1000) / 1000).toString();

/**
 * Outline of a slot shape, in millimetres, optionally rotated about its centre.
 * Returns a path in points ready for drawSvgPath.
 */
export const shapeSvgPath = (
  shape: SlotShape,
  x_mm: number,
  y_mm: number,
  w_mm: number,
  h_mm: number,
  rotation_deg = 0,
): string => {
  const x = mmToPt(x_mm);
  const y = mmToPt(y_mm);
  const w = mmToPt(w_mm);
  const h = mmToPt(h_mm);
  const t = makeTransform(x + w / 2, y + h / 2, rotation_deg);

  const M = (p: Pt) => `M ${fmt(t(p)[0])} ${fmt(t(p)[1])}`;
  const L = (p: Pt) => `L ${fmt(t(p)[0])} ${fmt(t(p)[1])}`;
  const C = (a: Pt, b: Pt, c: Pt) => {
    const [ax, ay] = t(a);
    const [bx, by] = t(b);
    const [cx, cy] = t(c);
    return `C ${fmt(ax)} ${fmt(ay)} ${fmt(bx)} ${fmt(by)} ${fmt(cx)} ${fmt(cy)}`;
  };

  if (shape === "circle") {
    const rx = w / 2;
    const ry = h / 2;
    const cx = x + rx;
    const cy = y + ry;
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    return [
      M([cx, y]),
      C([cx + kx, y], [x + w, cy - ky], [x + w, cy]),
      C([x + w, cy + ky], [cx + kx, y + h], [cx, y + h]),
      C([cx - kx, y + h], [x, cy + ky], [x, cy]),
      C([x, cy - ky], [cx - kx, y], [cx, y]),
      "Z",
    ].join(" ");
  }

  if (shape === "rounded") {
    const r = Math.min(w, h) * 0.09;
    const k = r * KAPPA;
    return [
      M([x + r, y]),
      L([x + w - r, y]),
      C([x + w - r + k, y], [x + w, y + r - k], [x + w, y + r]),
      L([x + w, y + h - r]),
      C([x + w, y + h - r + k], [x + w - r + k, y + h], [x + w - r, y + h]),
      L([x + r, y + h]),
      C([x + r - k, y + h], [x, y + h - r + k], [x, y + h - r]),
      L([x, y + r]),
      C([x, y + r - k], [x + r - k, y], [x + r, y]),
      "Z",
    ].join(" ");
  }

  if (shape === "arch") {
    const r = Math.min(w / 2, h * 0.6);
    const cx = x + w / 2;
    const kx = (w / 2) * KAPPA;
    const ky = r * KAPPA;
    return [
      M([x, y + h]),
      L([x, y + r]),
      C([x, y + r - ky], [cx - kx, y], [cx, y]),
      C([cx + kx, y], [x + w, y + r - ky], [x + w, y + r]),
      L([x + w, y + h]),
      "Z",
    ].join(" ");
  }

  return [M([x, y]), L([x + w, y]), L([x + w, y + h]), L([x, y + h]), "Z"].join(" ");
};

/** Plain rectangle outline, rotated about its centre. */
export const rectSvgPath = (
  x_mm: number,
  y_mm: number,
  w_mm: number,
  h_mm: number,
  rotation_deg = 0,
): string => shapeSvgPath("rect", x_mm, y_mm, w_mm, h_mm, rotation_deg);
