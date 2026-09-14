import type { Placement, Slot, Template } from "../types";
import { fillCrop } from "./geometry";
import { bandFor } from "./quality";
import { MM_PER_INCH } from "./units";

/**
 * Arrange a trip.
 *
 * A trip is a folder of two hundred photos, and placing them by hand is two
 * hundred drags before you have looked at a single page. This does the first
 * pass: put them back in the order they happened, break them where the days
 * break, and choose the layout that wastes the least of each photo.
 *
 * What it will not do is reorder your photos to make a layout fit. Chronology
 * is the spine of a trip journal — the first photo of a spread is the first
 * thing that happened on it — so photos go into slots in reading order, and it
 * is the *layout* that gets chosen to suit them. With a hundred-odd layouts per
 * format there is nearly always one that fits; where there is not, the report
 * says so rather than quietly shuffling the day around.
 *
 * Everything here is arithmetic on sizes. It is a starting point you then
 * edit, not an opinion about which photos are any good.
 */

export type TripPhoto = {
  id: string;
  name: string;
  w_px: number;
  h_px: number;
  /** Capture time where it is known. See `exif.ts`. */
  takenAt?: number;
  timeSource?: "exif" | "file";
};

export type ArrangeOptions = {
  /** Start a new spread when the calendar day changes. */
  newSpreadEachDay: boolean;
  /** Never put more than this many photos on one spread. */
  maxPerSpread: number;
};

export const DEFAULT_ARRANGE: ArrangeOptions = {
  newSpreadEachDay: true,
  maxPerSpread: 6,
};

export type ArrangedSpread = {
  templateId: string;
  placements: Placement[];
  /** In the order they were placed, so the caller can report and undo. */
  photoIds: string[];
  /** Why this spread ends where it does. */
  brokenBy: "day" | "size" | "end";
};

export type ArrangeReport = {
  spreads: ArrangedSpread[];
  /** Photos that found no layout at all — only possible with no templates. */
  leftOver: TripPhoto[];
  /** How the order was decided, for the UI to say out loud. */
  ordering: "capture time" | "file date" | "file name";
  /** Placements whose resolution falls short at the size they landed on. */
  soft: { amber: number; red: number };
  days: number;
};

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** `IMG_2` before `IMG_10`, which plain string order gets backwards. */
export const naturalCompare = (a: string, b: string): number => {
  const re = /(\d+)|(\D+)/g;
  const as = a.toLowerCase().match(re) ?? [];
  const bs = b.toLowerCase().match(re) ?? [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return as.length - bs.length;
};

/**
 * Trip order: when it happened, falling back to the name.
 *
 * Two cameras on one trip interleave correctly by time and not at all by name,
 * which is the whole reason the capture time is worth digging out of the file.
 */
export const orderForTrip = (photos: TripPhoto[]): TripPhoto[] =>
  [...photos].sort((a, b) => {
    const at = a.takenAt;
    const bt = b.takenAt;
    if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
    if (at !== undefined && bt === undefined) return -1;
    if (at === undefined && bt !== undefined) return 1;
    return naturalCompare(a.name, b.name);
  });

const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** How many distinct days the trip covers, for the report. */
export const dayCount = (photos: TripPhoto[]): number => {
  const days = new Set<string>();
  for (const p of photos) if (p.takenAt !== undefined) days.add(dayKey(p.takenAt));
  return days.size;
};

/**
 * Split an ordered trip at every day boundary. Photos with no known time never
 * force a break — a stripped EXIF block is missing information, not a new day.
 */
export const splitByDay = (ordered: TripPhoto[]): TripPhoto[][] => {
  const runs: TripPhoto[][] = [];
  let current: TripPhoto[] = [];
  let day: string | null = null;

  for (const p of ordered) {
    const k = p.takenAt === undefined ? null : dayKey(p.takenAt);
    if (k !== null && day !== null && k !== day && current.length > 0) {
      runs.push(current);
      current = [];
    }
    if (k !== null) day = k;
    current.push(p);
  }
  if (current.length) runs.push(current);
  return runs;
};

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/**
 * Reading order — across, then down.
 *
 * A row is everything that starts within half the row's height of its top, so
 * slots that are staggered by a few millimetres still read as one row and a
 * genuinely lower slot starts a new one.
 */
export const readingOrder = (slots: Slot[]): Slot[] => {
  const byY = [...slots].sort((a, b) => a.y_mm - b.y_mm || a.x_mm - b.x_mm);
  const rows: Slot[][] = [];
  for (const s of byY) {
    const row = rows[rows.length - 1];
    if (row) {
      const top = Math.min(...row.map((r) => r.y_mm));
      const tallest = Math.max(...row.map((r) => r.h_mm));
      if (s.y_mm - top <= tallest * 0.5) {
        row.push(s);
        continue;
      }
    }
    rows.push([s]);
  }
  return rows.flatMap((r) => [...r].sort((a, b) => a.x_mm - b.x_mm));
};

/**
 * How much of a photo a slot throws away, as a pure number.
 *
 * Log of the aspect ratio between them, so it is symmetric: a 3:2 photo in a
 * square slot and a square photo in a 3:2 slot score the same 0.41, and a
 * landscape photo in a portrait slot of the same proportions scores 0.81 —
 * twice as bad, which is exactly how it looks on the page.
 */
export const aspectMismatch = (slot: Slot, photo: TripPhoto): number => {
  const a = slot.w_mm / slot.h_mm;
  const b = photo.w_px / photo.h_px;
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.abs(Math.log(a / b));
};

/** Resolution the photo ends up at once it is cropped to fill the slot. */
export const dpiIn = (slot: Slot, photo: TripPhoto): number => {
  const a = slot.w_mm / slot.h_mm;
  const b = photo.w_px / photo.h_px;
  // Crop-to-fill keeps the whole of the starved axis, so the shorter side of
  // the crop is what sets the resolution.
  const px = b > a ? photo.h_px * a : photo.w_px;
  return (px * MM_PER_INCH) / slot.w_mm;
};

/**
 * Penalties in the same units as the aspect mismatch, so one cost decides it.
 *
 * Softness is worth about as much as a noticeable crop: a phone snapshot blown
 * up to a full-bleed A5 hero is a worse page than the same photo cropped
 * squarer and printed sharp.
 */
const AMBER_PENALTY = 0.12;
const RED_PENALTY = 0.45;

/**
 * What a spread costs before a single photo goes on it.
 *
 * Without it, one photo per page always wins: a layout can be found to match
 * one photo exactly and never five, so the cheapest trip is one photo a page
 * and eighty pages.
 *
 * Measured against the real template set on a 21-photo, 3-day trip, counting
 * spreads, pages holding a single photo, and the mean aspect mismatch — how
 * much of the average photo the crop throws away:
 *
 *     cost   A5                    Passport TN           A6
 *     0.4    10 sp · 5 lone · .13   7 sp · 1 lone · .16   13 sp · 8 lone · .07
 *     0.8     6 sp · 1 lone · .21   6 sp · 0 lone · .18    7 sp · 3 lone · .20
 *     1.2     5 sp · 1 lone · .27   5 sp · 0 lone · .23    6 sp · 2 lone · .24
 *     1.8     5 sp · 1 lone · .27   5 sp · 0 lone · .23    6 sp · 2 lone · .24
 *
 * 0.4 leaves a third of the trip on pages of their own; past 1.2 nothing moves
 * but the crop gets worse, because the six-photo cap is doing the deciding by
 * then. 0.8 is the knee — pages fill up, and a photo still gets a page to
 * itself when the alternative would butcher it.
 */
export const PAGE_COST = 0.8;

/**
 * A tie-breaker, and only a tie-breaker.
 *
 * Four photos that fit anything can go 2 + 2 or 3 + 1 for identical cost, and
 * something has to choose. Charged per spread and divided by what is on it,
 * this prefers the even split and the fuller page without ever being worth
 * enough — a hundredth of a noticeable crop — to squash a photo into the
 * wrong slot.
 */
export const THIN_PAGE_COST = 0.01;

/**
 * What this template costs for these photos, in full.
 *
 * A flat charge per spread plus what each photo loses to its slot. Infinity
 * when the slot count does not match — this template is not a candidate for
 * this many photos at all.
 */
export const spreadCost = (template: Template, photos: TripPhoto[]): number => {
  if (template.slots.length !== photos.length || photos.length === 0) return Infinity;
  const slots = readingOrder(template.slots);
  let total = PAGE_COST + THIN_PAGE_COST / photos.length;
  for (let i = 0; i < slots.length; i++) {
    const band = bandFor(dpiIn(slots[i], photos[i]));
    total +=
      aspectMismatch(slots[i], photos[i]) +
      (band === "red" ? RED_PENALTY : band === "amber" ? AMBER_PENALTY : 0);
  }
  return total;
};

/** Per photo, for comparing one layout against another at the same count. */
export const fitCost = (template: Template, photos: TripPhoto[]): number => {
  const k = Math.max(1, photos.length);
  return (spreadCost(template, photos) - PAGE_COST - THIN_PAGE_COST / k) / k;
};

export type Choice = { template: Template; photos: TripPhoto[]; cost: number };

/** The cheapest layout holding exactly this many photos, in this order. */
export const bestTemplateFor = (
  photos: TripPhoto[],
  templates: Template[],
): Choice | null => {
  let best: Choice | null = null;
  for (const t of templates) {
    if (t.slots.length !== photos.length) continue;
    const cost = spreadCost(t, photos);
    if (!best || cost < best.cost) best = { template: t, photos, cost };
  }
  return best;
};

/**
 * Where to break a day into spreads, solved rather than guessed.
 *
 * Taking the best spread you can see and moving on is how you end a day with
 * two lonely single-photo pages: the run of seven splits 3-2-1-1 because
 * nothing looked back. This works from the end of the run forwards, so every
 * break is chosen knowing what it leaves behind, and the whole day comes out at
 * the lowest total cost there is.
 */
export const planRun = (
  run: TripPhoto[],
  templates: Template[],
  maxPerSpread: number,
): Choice[] => {
  const n = run.length;
  const limit = Math.max(1, maxPerSpread);
  // best[i] is the cost of laying out run[i..], and take[i] how many photos the
  // spread starting at i uses.
  const best = new Array<number>(n + 1).fill(Infinity);
  const take = new Array<Choice | null>(n + 1).fill(null);
  best[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    for (let k = 1; k <= Math.min(limit, n - i); k++) {
      const choice = bestTemplateFor(run.slice(i, i + k), templates);
      if (!choice || !Number.isFinite(best[i + k])) continue;
      const total = choice.cost + best[i + k];
      if (total < best[i]) {
        best[i] = total;
        take[i] = choice;
      }
    }
  }

  const out: Choice[] = [];
  let i = 0;
  while (i < n) {
    const choice = take[i];
    // No layout in this format holds any of what is left; the caller reports it.
    if (!choice) break;
    out.push(choice);
    i += choice.photos.length;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Arrange
// ---------------------------------------------------------------------------

const placementFor = (slot: Slot, photo: TripPhoto): Placement => {
  const base: Placement = {
    slotId: slot.id,
    assetId: photo.id,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    rotation: 0,
    straighten_deg: 0,
    copies: 1,
  };
  return {
    ...base,
    // The same crop-to-fill a hand drop gets, so an arranged spread and a
    // hand-built one are the same thing and edit identically.
    crop: fillCrop({
      iw: photo.w_px,
      ih: photo.h_px,
      aspect: slot.w_mm / slot.h_mm,
      straighten_deg: 0,
    }),
  };
};

export const arrangeTrip = (
  photos: TripPhoto[],
  templates: Template[],
  options: ArrangeOptions = DEFAULT_ARRANGE,
): ArrangeReport => {
  const ordered = orderForTrip(photos);
  const timed = ordered.filter((p) => p.takenAt !== undefined);
  const ordering: ArrangeReport["ordering"] =
    timed.length === 0
      ? "file name"
      : timed.some((p) => p.timeSource === "exif")
        ? "capture time"
        : "file date";

  const runs = options.newSpreadEachDay ? splitByDay(ordered) : [ordered];
  const spreads: ArrangedSpread[] = [];
  const leftOver: TripPhoto[] = [];
  const soft = { amber: 0, red: 0 };

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const plan = planRun(run, templates, options.maxPerSpread);
    const placed = plan.reduce((n, c) => n + c.photos.length, 0);
    // Only happens when the format has no layout small enough to hold them.
    if (placed < run.length) leftOver.push(...run.slice(placed));

    for (let i = 0; i < plan.length; i++) {
      const choice = plan[i];
      const slots = readingOrder(choice.template.slots);
      const placements = slots.map((slot, j) => placementFor(slot, choice.photos[j]));
      for (let j = 0; j < slots.length; j++) {
        const band = bandFor(dpiIn(slots[j], choice.photos[j]));
        if (band === "amber") soft.amber += 1;
        if (band === "red") soft.red += 1;
      }
      const last = i === plan.length - 1;
      spreads.push({
        templateId: choice.template.id,
        placements,
        photoIds: choice.photos.map((p) => p.id),
        brokenBy: !last ? "size" : r === runs.length - 1 ? "end" : "day",
      });
    }
  }

  return { spreads, leftOver, ordering, soft, days: dayCount(ordered) };
};
