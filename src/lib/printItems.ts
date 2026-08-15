import type {
  OutputSettings,
  Placement,
  PrintItem,
  Project,
  Slot,
  SlotShape,
  Spread,
  Template,
} from "../types";
import { templateById } from "../data/layouts";

/**
 * The shape actually cut: a per-slot override wins, then the project's corner
 * style, then whatever the template seeded.
 */
export const resolveShape = (
  slot: Slot,
  placement: Placement | undefined,
  settings: OutputSettings,
): SlotShape => {
  if (placement?.shape) return placement.shape;
  if (settings.cornerStyle === "rounded" && slot.shape === "rect") return "rounded";
  return slot.shape;
};

/**
 * Spreads in, one flat PrintItem list out.
 *
 * This is the seam in the product. `w_mm`/`h_mm` are copied straight off the
 * slot the user chose, so finished size is always a chosen value and never an
 * inferred one. Everything downstream — packer, PDF, quality report — reads
 * only from here.
 */

export const buildPrintItems = (project: Project): PrintItem[] => {
  const items: PrintItem[] = [];
  let n = 0;

  for (const spread of project.spreads) {
    const template = templateById(spread.templateId);
    if (!template) continue;

    // Slot order, not placement order, so P-IDs read down the page.
    for (const slot of template.slots) {
      const p = spread.placements.find((pl) => pl.slotId === slot.id);
      if (!p || !p.assetId) continue;
      n += 1;
      items.push({
        id: `${spread.id}:${slot.id}`,
        assetId: p.assetId,
        crop: p.crop,
        rotation: p.rotation,
        straighten_deg: p.straighten_deg,
        w_mm: slot.w_mm,
        h_mm: slot.h_mm,
        shape: resolveShape(slot, p, project.settings),
        fromSpread: spread.id,
        fromSlot: slot.id,
        copies: p.copies ?? 1,
        label: `P${n}`,
      });
    }
  }

  return items;
};

/**
 * Bleed is overprint: the photo is printed larger than its finished size so a
 * slightly-off cut still lands on image. That only works if each edge gets its
 * own cut, which means the gap has to be wide enough to hold two bleeds plus a
 * waste strip. With bleed 0 (the default) this returns the gap untouched, and
 * one cut still gives two finished edges.
 */
export const effectiveGap = (gap_mm: number, bleed_mm: number): number =>
  bleed_mm > 0 ? Math.max(gap_mm, 2 * bleed_mm + 1) : gap_mm;

/** Printed size including bleed. Finished size stays w_mm/h_mm. */
export const printedSize = (
  item: PrintItem,
  bleed_mm: number,
): { w: number; h: number } => ({
  w: item.w_mm + 2 * bleed_mm,
  h: item.h_mm + 2 * bleed_mm,
});

export const spreadTemplate = (spread: Spread): Template | undefined =>
  templateById(spread.templateId);

export const countPhotos = (items: PrintItem[]): number =>
  items.reduce((n, i) => n + Math.max(1, i.copies), 0);
