import { describe, it, expect } from "vitest";
import type { PrintItem, SheetPlacement } from "../types";
import {
  contentArea,
  defaultPackOptions,
  pack,
  toPackUnits,
} from "./packer";
import type { PackOptions, PackUnit } from "./packer";

const unit = (id: string, w: number, h: number, copy = 1): PackUnit => ({
  itemId: id,
  copy,
  w_mm: w,
  h_mm: h,
});

const opts = (over: Partial<PackOptions> = {}): PackOptions => ({
  ...defaultPackOptions(0, true),
  ...over,
});

/** Resolve a placement back to its on-sheet footprint. */
const boxOf = (p: SheetPlacement, units: PackUnit[]) => {
  const u = units.find((x) => x.itemId === p.itemId && x.copy === p.copy)!;
  const w = p.rotated ? u.h_mm : u.w_mm;
  const h = p.rotated ? u.w_mm : u.h_mm;
  return { x: p.x_mm, y: p.y_mm, w, h };
};

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => {
  const eps = 1e-6;
  return (
    a.x < b.x + b.w - eps &&
    b.x < a.x + a.w - eps &&
    a.y < b.y + b.h - eps &&
    b.y < a.y + a.h - eps
  );
};

const assertSane = (units: PackUnit[], o: PackOptions) => {
  const res = pack(units, o);
  const area = contentArea(o);
  const eps = 1e-6;

  // Everything placeable got placed exactly once.
  expect(res.placements.length + res.unplaceable.length).toBe(units.length);
  const seen = new Set(res.placements.map((p) => `${p.itemId}#${p.copy}`));
  expect(seen.size).toBe(res.placements.length);

  const bySheet = new Map<number, SheetPlacement[]>();
  for (const p of res.placements) {
    // No overflow.
    const b = boxOf(p, units);
    expect(b.x).toBeGreaterThanOrEqual(area.x - eps);
    expect(b.y).toBeGreaterThanOrEqual(area.y - eps);
    expect(b.x + b.w).toBeLessThanOrEqual(area.x + area.w + eps);
    expect(b.y + b.h).toBeLessThanOrEqual(area.y + area.h + eps);
    bySheet.set(p.sheet, [...(bySheet.get(p.sheet) ?? []), p]);
  }

  // No overlap, within each sheet.
  for (const list of bySheet.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        expect(
          overlaps(boxOf(list[i], units), boxOf(list[j], units)),
          `${list[i].itemId}#${list[i].copy} vs ${list[j].itemId}#${list[j].copy}`,
        ).toBe(false);
      }
    }
  }

  return res;
};

describe("shelf packer", () => {
  it("packs a single item at the top-left of the content area", () => {
    const units = [unit("a", 54, 72)];
    const res = assertSane(units, opts());
    expect(res.sheets).toBe(1);
    expect(res.placements[0].x_mm).toBeCloseTo(5, 9);
    expect(res.placements[0].y_mm).toBeCloseTo(5, 9);
  });

  it("mixed sizes: no overlap, no overflow", () => {
    const sizes: Array<[number, number]> = [
      [54, 72], [90, 125], [40, 40], [110, 60], [148, 100],
      [35, 50], [62, 62], [100, 30], [76, 102], [25, 80],
    ];
    const units = sizes.flatMap(([w, h], i) => [
      unit(`i${i}`, w, h, 1),
      unit(`i${i}`, w, h, 2),
    ]);
    const res = assertSane(units, opts());
    expect(res.unplaceable).toHaveLength(0);
    expect(res.sheets).toBeGreaterThan(0);
  });

  it("holds up under a large randomised load", () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (const gap of [0, 1, 2, 3]) {
      for (const allowRotate of [true, false]) {
        const units: PackUnit[] = [];
        for (let i = 0; i < 120; i++) {
          units.push(
            unit(`r${i}`, 15 + Math.round(rnd() * 120), 15 + Math.round(rnd() * 180)),
          );
        }
        const res = assertSane(units, opts({ gap_mm: gap, allowRotate }));
        expect(res.coverage).toBeGreaterThan(0);
        expect(res.coverage).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("rows are clean horizontal lanes — items in a row share a top edge", () => {
    const units = [
      unit("a", 60, 80), unit("b", 60, 80), unit("c", 60, 80),
      unit("d", 40, 50), unit("e", 40, 50),
    ];
    const res = assertSane(units, opts());
    const tops = new Set(res.placements.map((p) => Math.round(p.y_mm * 100)));
    // Five items of two heights should share very few distinct top edges.
    expect(tops.size).toBeLessThanOrEqual(2);
  });

  it("respects the gap between items", () => {
    for (const gap of [1, 2, 3]) {
      const units = [unit("a", 50, 50), unit("b", 50, 50), unit("c", 50, 50)];
      const res = pack(units, opts({ gap_mm: gap }));
      const row = res.placements.filter((p) => Math.abs(p.y_mm - 5) < 1e-6);
      row.sort((a, b) => a.x_mm - b.x_mm);
      for (let i = 1; i < row.length; i++) {
        expect(row[i].x_mm - (row[i - 1].x_mm + 50)).toBeCloseTo(gap, 9);
      }
    }
  });

  it("rotates to fit when rotation is allowed", () => {
    // 190 x 40 does not fit the 200mm content width in one orientation only;
    // 40 x 190 is far taller. Use a shape that only fits rotated.
    const units = [unit("wide", 30, 195)];
    const rotated = pack(units, opts({ allowRotate: true }));
    expect(rotated.placements[0].rotated).toBe(true);
    expect(rotated.unplaceable).toHaveLength(0);
  });

  it("never rotates when rotation is off", () => {
    const units = Array.from({ length: 12 }, (_, i) => unit(`x${i}`, 30, 90));
    const res = assertSane(units, opts({ allowRotate: false }));
    expect(res.placements.every((p) => !p.rotated)).toBe(true);
  });

  it("reports items too big for a sheet instead of dropping them", () => {
    const units = [unit("huge", 400, 400), unit("ok", 50, 50)];
    const res = pack(units, opts());
    expect(res.unplaceable.map((u) => u.itemId)).toEqual(["huge"]);
    expect(res.placements).toHaveLength(1);
  });

  it("spills onto more sheets rather than overflowing one", () => {
    const units = Array.from({ length: 40 }, (_, i) => unit(`b${i}`, 95, 130));
    const res = assertSane(units, opts());
    expect(res.sheets).toBeGreaterThan(1);
    expect(res.unplaceable).toHaveLength(0);
  });

  it("coverage matches the photo area actually placed", () => {
    const units = [unit("a", 100, 100), unit("b", 100, 100)];
    const o = opts();
    const res = pack(units, o);
    const area = contentArea(o);
    const expected = (100 * 100 * 2) / (res.sheets * area.w * area.h);
    expect(res.coverage).toBeCloseTo(expected, 9);
  });

  it("is deterministic", () => {
    const units = Array.from({ length: 30 }, (_, i) => unit(`d${i}`, 20 + i * 3, 90 - i));
    const a = pack(units, opts());
    const b = pack(units, opts());
    expect(a.placements).toEqual(b.placements);
    expect(a.sheets).toBe(b.sheets);
  });
});

describe("toPackUnits", () => {
  const item = (id: string, copies: number): PrintItem => ({
    id,
    assetId: "a",
    crop: { x: 0, y: 0, w: 1, h: 1 },
    rotation: 0,
    straighten_deg: 0,
    w_mm: 50,
    h_mm: 70,
    shape: "rect",
    fromSpread: "s",
    fromSlot: "s1",
    copies,
    label: "P1",
  });

  it("expands one unit per copy", () => {
    const units = toPackUnits([item("a", 3), item("b", 1)]);
    expect(units).toHaveLength(4);
    expect(units.filter((u) => u.itemId === "a").map((u) => u.copy)).toEqual([1, 2, 3]);
  });

  it("carries the finished size through verbatim", () => {
    const units = toPackUnits([item("a", 1)]);
    expect(units[0].w_mm).toBe(50);
    expect(units[0].h_mm).toBe(70);
  });
});
