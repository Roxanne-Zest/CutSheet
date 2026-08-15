import { describe, it, expect } from "vitest";
import type { Placement } from "../types";
import { templateById, templatesForFormat } from "../data/templates";
import { dropCount, formatChangeDrops, remapTemplate } from "./layoutChange";

const placed = (...slotIds: string[]): Placement[] =>
  slotIds.map((slotId) => ({
    slotId,
    assetId: "a",
    crop: { x: 0, y: 0, w: 1, h: 1 },
    rotation: 0 as const,
    straighten_deg: 0,
    copies: 1 as const,
  }));

describe("dropCount — what a layout change would destroy", () => {
  it("is zero when the new layout has at least as many slots", () => {
    // a5-6-grid → a5-9-grid: every S1..S6 still has a home.
    expect(dropCount(placed("S1", "S2", "S3", "S4", "S5", "S6"), templateById("a5-9-grid"))).toBe(0);
  });

  it("counts the photos with nowhere to go when slots shrink", () => {
    // Six photos into a two-slot layout loses four.
    expect(dropCount(placed("S1", "S2", "S3", "S4", "S5", "S6"), templateById("a5-2-stack"))).toBe(4);
  });

  it("counts only filled slots, not empty ones", () => {
    // Two photos, both in the first two slots — a four-slot layout loses none.
    expect(dropCount(placed("S1", "S2"), templateById("a5-4-grid"))).toBe(0);
    // But the same two photos sitting in S5/S6 do not fit a four-slot layout.
    expect(dropCount(placed("S5", "S6"), templateById("a5-4-grid"))).toBe(2);
  });

  it("is zero for an empty spread, whatever the target", () => {
    expect(dropCount([], templateById("pp-hero-square"))).toBe(0);
  });

  it("is zero when the target does not resolve", () => {
    expect(dropCount(placed("S1"), undefined)).toBe(0);
  });
});

describe("remapTemplate — carrying a spread to another format", () => {
  it("prefers a layout with the same slot count", () => {
    const from = templateById("a5-4-grid")!;
    const to = remapTemplate(from, "a6")!;
    expect(to.formatId).toBe("a6");
    expect(to.slots).toHaveLength(4);
  });

  it("breaks ties on shared tags", () => {
    // a5-hero (hero + writing, 1 slot) should land on a one-slot hero layout.
    const to = remapTemplate(templateById("a5-hero")!, "standard-tn")!;
    expect(to.slots).toHaveLength(1);
    expect(to.tags).toContain("hero");
  });

  it("always returns something for every format pair", () => {
    const formats = ["passport-tn", "pocket", "a6", "a5", "standard-tn", "hobonichi-cousin"];
    for (const t of formats.flatMap((f) => templatesForFormat(f))) {
      for (const f of formats) {
        const to = remapTemplate(t, f);
        expect(to, `${t.id} → ${f}`).toBeDefined();
        expect(to!.formatId).toBe(f);
      }
    }
  });

  it("returns undefined for a format with no layouts", () => {
    expect(remapTemplate(templateById("a5-hero")!, "not-a-format")).toBeUndefined();
  });
});

describe("formatChangeDrops", () => {
  it("adds up losses across every spread", () => {
    // Pocket's largest layout has 4 slots, so a 6-up and a 9-up both shed.
    const spreads = [
      { templateId: "a5-6-grid", placements: placed("S1", "S2", "S3", "S4", "S5", "S6") },
      { templateId: "a5-9-grid", placements: placed("S1", "S2", "S3", "S7", "S8", "S9") },
    ];
    const drops = formatChangeDrops(spreads, "pocket", templateById);
    expect(drops).toBeGreaterThan(0);
  });

  it("is zero when every spread finds an equal-or-larger home", () => {
    const spreads = [{ templateId: "a5-hero", placements: placed("S1") }];
    expect(formatChangeDrops(spreads, "a6", templateById)).toBe(0);
  });

  it("is zero for a project with no spreads", () => {
    expect(formatChangeDrops([], "a6", templateById)).toBe(0);
  });
});
