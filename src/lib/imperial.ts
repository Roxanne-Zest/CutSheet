import { MM_PER_INCH } from "./units";

/**
 * Imperial equivalents for the punch sizes people actually own.
 *
 * Craft punches are sold in both systems and the overlap is not obvious: 19 mm
 * and three-quarters of an inch are the same punch, 25 mm and one inch are not.
 * A label is only given where the two agree to within a tenth of a millimetre,
 * because that is the point past which a punch stops fitting.
 */

/** How close a millimetre size must be to an inch fraction to be called one. */
export const INCH_TOLERANCE_MM = 0.1;

/**
 * Only the three fractions the PDF standard fonts can actually encode. Eighths
 * and sixteenths fall back to `3/8` — the card has to print, and a glyph that
 * WinAnsi cannot represent takes the whole page down with it.
 */
const VULGAR: Record<string, string> = {
  "1/2": "½",
  "1/4": "¼",
  "3/4": "¾",
};

/** Inch mark. Straight, for the same encoding reason. */
export const INCH_MARK = '"';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Format sixteenths of an inch as e.g. `3/4`, `1 1/2`, `1`. */
export const formatSixteenths = (n: number): string => {
  const whole = Math.floor(n / 16);
  const rem = n % 16;
  if (rem === 0) return `${whole}`;
  const g = gcd(rem, 16);
  const frac = `${rem / g}/${16 / g}`;
  const pretty = VULGAR[frac] ?? frac;
  return whole === 0 ? pretty : `${whole}${VULGAR[frac] ? "" : " "}${pretty}`;
};

/**
 * The inch fraction a millimetre size really is, or undefined if it is not one.
 * Searched in sixteenths, which covers every punch size sold.
 */
export const inchLabel = (mm: number): string | undefined => {
  if (!(mm > 0)) return undefined;
  const sixteenths = Math.round((mm * 16) / MM_PER_INCH);
  if (sixteenths <= 0) return undefined;
  const exact = (sixteenths * MM_PER_INCH) / 16;
  if (Math.abs(exact - mm) > INCH_TOLERANCE_MM) return undefined;
  return `${formatSixteenths(sixteenths)}${INCH_MARK}`;
};
