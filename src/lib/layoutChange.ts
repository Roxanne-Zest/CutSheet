import type { Placement, Template } from "../types";
import { templatesForFormat } from "../data/templates";

/**
 * Switching layouts is the one action in the editor that can destroy work.
 *
 * Adding a spread is always safe, so that is what picking a layout does.
 * Re-flowing the spread you are on is deliberate, and if it would leave photos
 * with nowhere to go the editor asks first. These are the two things it needs
 * to know to make that call.
 */

/** How many placed photos have no slot to land in under `next`. */
export const dropCount = (
  placements: Placement[],
  next: Template | undefined,
): number =>
  next
    ? placements.filter((p) => !next.slots.some((x) => x.id === p.slotId)).length
    : 0;

/**
 * The closest template in another format: same slot count first, then the most
 * tags in common. Slot ids are S1..Sn in every template, so a target with at
 * least as many slots carries every photo across.
 */
export const remapTemplate = (
  t: Template,
  formatId: string,
): Template | undefined => {
  const candidates = templatesForFormat(formatId);
  if (candidates.length === 0) return undefined;
  const score = (c: Template) =>
    Math.abs(c.slots.length - t.slots.length) * 10 -
    c.tags.filter((tag) => t.tags.includes(tag)).length;
  return [...candidates].sort((a, b) => score(a) - score(b))[0];
};

/** Total photos lost if every spread were carried into `formatId`. */
export const formatChangeDrops = (
  spreads: Array<{ templateId: string; placements: Placement[] }>,
  formatId: string,
  lookup: (id: string) => Template | undefined,
): number =>
  spreads.reduce((n, s) => {
    const current = lookup(s.templateId);
    return n + dropCount(s.placements, current ? remapTemplate(current, formatId) : undefined);
  }, 0);
