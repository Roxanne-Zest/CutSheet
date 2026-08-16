/**
 * Snap-to-edge for the measure tool.
 *
 * Every millimetre of error is multiplied across the whole sheet: mis-measure a
 * 12 mm circle by 0.5 mm and you are 4% out everywhere. Getting a mouse within
 * a pixel of a sticker's edge is not realistic, so instead the endpoint is
 * dropped roughly and then pulled onto the strongest contrast change nearby.
 *
 * The search runs along the drag axis, because that is the direction the
 * measurement is sensitive to. Sliding along the edge does not change the
 * length; crossing it does.
 */

/** How far either side of the drop point to look, in source pixels. */
export const SNAP_RADIUS_PX = 6;

export type Pt = { x: number; y: number };

/** Perceptual luminance, 0..255. */
export const luminance = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Index of the strongest contrast change in a luminance profile.
 *
 * Ties go to whichever is closest to the middle — the user's own aim is the
 * tiebreak, which keeps the snap feeling like assistance rather than a fight.
 */
export const strongestEdge = (profile: number[]): number => {
  if (profile.length < 3) return Math.floor(profile.length / 2);
  const centre = (profile.length - 1) / 2;
  let bestIndex = Math.round(centre);
  let bestGradient = -1;
  let bestDistance = Infinity;

  for (let i = 1; i < profile.length - 1; i++) {
    const gradient = Math.abs(profile[i + 1] - profile[i - 1]);
    const distance = Math.abs(i - centre);
    if (gradient > bestGradient + 1e-9 || (Math.abs(gradient - bestGradient) <= 1e-9 && distance < bestDistance)) {
      bestGradient = gradient;
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestGradient <= 0 ? Math.round(centre) : bestIndex;
};

/** Unit vector from a to b. Zero-length drags fall back to horizontal. */
export const axisOf = (a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
};

export type SampleFn = (x: number, y: number) => number;

/**
 * Sample luminance along `axis` through `point`, one sample per pixel across
 * ±radius. Returns the profile and the offsets it was taken at.
 */
export const profileAlong = (
  sample: SampleFn,
  point: Pt,
  axis: Pt,
  radius = SNAP_RADIUS_PX,
): { profile: number[]; offsets: number[] } => {
  const profile: number[] = [];
  const offsets: number[] = [];
  for (let t = -radius; t <= radius; t++) {
    offsets.push(t);
    profile.push(sample(point.x + axis.x * t, point.y + axis.y * t));
  }
  return { profile, offsets };
};

/**
 * Pull an endpoint onto the nearest strong edge along the measurement axis.
 * Returns the snapped point and how far it moved.
 */
export const snapEndpoint = (
  sample: SampleFn,
  point: Pt,
  axis: Pt,
  radius = SNAP_RADIUS_PX,
): { point: Pt; moved_px: number } => {
  const { profile, offsets } = profileAlong(sample, point, axis, radius);
  const t = offsets[strongestEdge(profile)] ?? 0;
  return {
    point: { x: point.x + axis.x * t, y: point.y + axis.y * t },
    moved_px: Math.abs(t),
  };
};

/**
 * Snap both ends of a measurement. Each endpoint searches along the line's own
 * axis, so a drag across a circle lands on both sides of it.
 */
export const snapMeasurement = (
  sample: SampleFn,
  a: Pt,
  b: Pt,
  radius = SNAP_RADIUS_PX,
): { a: Pt; b: Pt; moved_px: number } => {
  const axis = axisOf(a, b);
  const sa = snapEndpoint(sample, a, axis, radius);
  const sb = snapEndpoint(sample, b, axis, radius);
  return { a: sa.point, b: sb.point, moved_px: sa.moved_px + sb.moved_px };
};

/** Build a sampler over raw RGBA pixel data, clamping at the edges. */
export const samplerFor = (
  data: Uint8ClampedArray,
  w: number,
  h: number,
): SampleFn => (x, y) => {
  const px = Math.min(w - 1, Math.max(0, Math.round(x)));
  const py = Math.min(h - 1, Math.max(0, Math.round(y)));
  const i = (py * w + px) * 4;
  return luminance(data[i], data[i + 1], data[i + 2]);
};
