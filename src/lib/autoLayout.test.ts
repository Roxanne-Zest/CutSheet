import { describe, expect, it } from "vitest";
import {
  arrangeTrip,
  aspectMismatch,
  bestTemplateFor,
  dayCount,
  dpiIn,
  naturalCompare,
  orderForTrip,
  planRun,
  readingOrder,
  spreadCost,
  fitCost,
  PAGE_COST,
  THIN_PAGE_COST,
} from "./autoLayout";
import type { TripPhoto } from "./autoLayout";
import type { Slot, Template } from "../types";
import { templatesForFormat } from "../data/templates";

const slot = (id: string, x: number, y: number, w: number, h: number): Slot => ({
  id, x_mm: x, y_mm: y, w_mm: w, h_mm: h, rotation_deg: 0, shape: "rect",
});

const tpl = (id: string, slots: Slot[]): Template => ({
  id, formatId: "test", name: id, note: "", tags: ["grid"], slots,
});

const t = (d: number, h: number, mi = 0) => new Date(2024, 6, d, h, mi, 0).getTime();

/** A 12 MP phone photo, landscape unless asked otherwise. */
const photo = (
  id: string,
  opts: { portrait?: boolean; takenAt?: number; name?: string; px?: number } = {},
): TripPhoto => {
  const long = opts.px ?? 4032;
  const short = Math.round((long * 3) / 4);
  return {
    id,
    name: opts.name ?? `${id}.jpg`,
    w_px: opts.portrait ? short : long,
    h_px: opts.portrait ? long : short,
    takenAt: opts.takenAt,
    timeSource: opts.takenAt === undefined ? undefined : "exif",
  };
};

describe("putting a trip back in order", () => {
  it("sorts IMG_2 before IMG_10, which string order gets backwards", () => {
    expect(naturalCompare("IMG_2.jpg", "IMG_10.jpg")).toBeLessThan(0);
    expect(naturalCompare("IMG_10.jpg", "IMG_2.jpg")).toBeGreaterThan(0);
    expect(naturalCompare("a.jpg", "a.jpg")).toBe(0);
    expect(naturalCompare("DSC_0001.JPG", "img_0001.jpg")).toBeLessThan(0);
  });

  it("interleaves two cameras by time, which is the whole point of reading EXIF", () => {
    // Names say all the phone photos come first; the clock says otherwise.
    const ordered = orderForTrip([
      photo("p1", { name: "IMG_0001.jpg", takenAt: t(1, 9) }),
      photo("p2", { name: "IMG_0002.jpg", takenAt: t(1, 15) }),
      photo("c1", { name: "DSC_9000.jpg", takenAt: t(1, 12) }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["p1", "c1", "p2"]);
  });

  it("puts photos with no time last, in name order", () => {
    const ordered = orderForTrip([
      photo("x", { name: "screenshot-b.png" }),
      photo("timed", { takenAt: t(1, 9) }),
      photo("y", { name: "screenshot-a.png" }),
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["timed", "y", "x"]);
  });

  it("counts the days the trip covers", () => {
    expect(dayCount([photo("a", { takenAt: t(1, 9) }), photo("b", { takenAt: t(1, 22) })])).toBe(1);
    expect(dayCount([photo("a", { takenAt: t(1, 9) }), photo("b", { takenAt: t(2, 1) })])).toBe(2);
    expect(dayCount([photo("a")])).toBe(0);
  });
});

describe("reading order", () => {
  it("goes across, then down", () => {
    const slots = [
      slot("S4", 60, 60, 40, 30), slot("S1", 10, 10, 40, 30),
      slot("S3", 10, 60, 40, 30), slot("S2", 60, 10, 40, 30),
    ];
    expect(readingOrder(slots).map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("keeps a staggered row as one row", () => {
    // A collage where the right-hand photo sits 8 mm lower than the left one:
    // still the same row to a reader, and a new row would put them out of order.
    const slots = [slot("S1", 10, 10, 40, 40), slot("S2", 60, 18, 40, 40)];
    expect(readingOrder(slots).map((s) => s.id)).toEqual(["S1", "S2"]);
  });

  it("starts a new row when the next slot is genuinely below", () => {
    const slots = [slot("S1", 10, 10, 40, 40), slot("S2", 60, 55, 40, 40)];
    expect(readingOrder(slots).map((s) => s.id)).toEqual(["S1", "S2"]);
    // And the one below sorts after even when it is further left.
    const back = readingOrder([slot("S2", 5, 55, 40, 40), slot("S1", 60, 10, 40, 40)]);
    expect(back.map((s) => s.id)).toEqual(["S1", "S2"]);
  });
});

describe("how much a slot costs a photo", () => {
  it("is zero when the proportions already agree", () => {
    expect(aspectMismatch(slot("S1", 0, 0, 40, 30), photo("a"))).toBeCloseTo(0, 6);
  });

  it("is symmetric — a square slot and a square photo cost the same", () => {
    const square = slot("S1", 0, 0, 40, 40);
    const landscape = slot("S2", 0, 0, 40, 30);
    const squarePhoto: TripPhoto = { id: "s", name: "s.jpg", w_px: 3000, h_px: 3000 };
    expect(aspectMismatch(square, photo("a"))).toBeCloseTo(
      aspectMismatch(landscape, squarePhoto),
      6,
    );
  });

  it("charges twice as much for the wrong way up", () => {
    // A landscape photo in a portrait slot of the same proportions is two of
    // the same mistake, and looks it.
    const square = aspectMismatch(slot("S1", 0, 0, 40, 40), photo("a"));
    const portrait = aspectMismatch(slot("S1", 0, 0, 30, 40), photo("a"));
    expect(portrait).toBeCloseTo(2 * square, 6);
  });

  it("works out the resolution the photo actually prints at", () => {
    // 4032 px across a 40 mm slot of the same proportions: 4032 / (40/25.4).
    expect(dpiIn(slot("S1", 0, 0, 40, 30), photo("a"))).toBeCloseTo(2560.3, 1);
    // A 400 px photo in the same slot is well under 300 dpi.
    expect(dpiIn(slot("S1", 0, 0, 40, 30), photo("b", { px: 400 }))).toBeLessThan(300);
  });
});

describe("choosing a layout", () => {
  const two = tpl("two-land", [slot("S1", 0, 0, 40, 30), slot("S2", 0, 40, 40, 30)]);
  const twoPortrait = tpl("two-port", [slot("S1", 0, 0, 30, 40), slot("S2", 50, 0, 30, 40)]);
  const one = tpl("one", [slot("S1", 0, 0, 40, 30)]);

  it("will not consider a layout with the wrong number of slots", () => {
    expect(spreadCost(one, [photo("a"), photo("b")])).toBe(Infinity);
    expect(spreadCost(two, [photo("a")])).toBe(Infinity);
    expect(spreadCost(two, [])).toBe(Infinity);
  });

  it("costs a perfect fit nothing but the page", () => {
    expect(spreadCost(two, [photo("a"), photo("b")])).toBeCloseTo(
      PAGE_COST + THIN_PAGE_COST / 2,
      6,
    );
    expect(fitCost(two, [photo("a"), photo("b")])).toBeCloseTo(0, 6);
  });

  it("picks the layout that faces the same way as the photos", () => {
    const portraits = [photo("a", { portrait: true }), photo("b", { portrait: true })];
    expect(bestTemplateFor(portraits, [two, twoPortrait])?.template.id).toBe("two-port");
    expect(bestTemplateFor([photo("a"), photo("b")], [two, twoPortrait])?.template.id).toBe(
      "two-land",
    );
  });

  it("charges for a photo that will print soft at that size", () => {
    const sharp = spreadCost(one, [photo("a")]);
    const soft = spreadCost(one, [photo("a", { px: 300 })]);
    // Same proportions, same slot — the whole difference is resolution.
    expect(aspectMismatch(one.slots[0], photo("a", { px: 300 }))).toBeCloseTo(0, 6);
    expect(soft).toBeGreaterThan(sharp);
  });

  it("has nothing to offer when no layout holds that many", () => {
    expect(bestTemplateFor([photo("a"), photo("b"), photo("c")], [one, two])).toBeNull();
  });
});

describe("planning a day", () => {
  const one = tpl("one", [slot("S1", 0, 0, 40, 30)]);
  const two = tpl("two", [slot("S1", 0, 0, 40, 30), slot("S2", 0, 40, 40, 30)]);
  const three = tpl("three", [
    slot("S1", 0, 0, 40, 30), slot("S2", 0, 40, 40, 30), slot("S3", 0, 80, 40, 30),
  ]);

  it("splits four photos in half rather than leaving one on its own", () => {
    // Taking the best spread it can see and moving on gives 3 + 1. Working back
    // from the end of the day gives 2 + 2, which is one fewer page and no
    // orphan. This is the whole reason the plan is solved rather than greedy.
    const run = ["a", "b", "c", "d"].map((id) => photo(id));
    const plan = planRun(run, [one, two, three], 3);
    expect(plan.map((c) => c.photos.length)).toEqual([2, 2]);
  });

  it("keeps the photos in the order they happened", () => {
    const run = ["a", "b", "c", "d", "e"].map((id) => photo(id));
    const plan = planRun(run, [one, two, three], 3);
    expect(plan.flatMap((c) => c.photos.map((p) => p.id))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never puts more on a spread than asked", () => {
    const run = ["a", "b", "c", "d", "e", "f"].map((id) => photo(id));
    const plan = planRun(run, [one, two, three], 2);
    expect(Math.max(...plan.map((c) => c.photos.length))).toBeLessThanOrEqual(2);
    expect(plan.flatMap((c) => c.photos).length).toBe(6);
  });

  it("places nothing when no layout fits, rather than guessing", () => {
    const run = ["a", "b"].map((id) => photo(id));
    expect(planRun(run, [three], 6)).toEqual([]);
  });
});

describe("arranging a whole trip", () => {
  const one = tpl("one", [slot("S1", 0, 0, 40, 30)]);
  const two = tpl("two", [slot("S1", 0, 0, 40, 30), slot("S2", 0, 40, 40, 30)]);
  const templates = [one, two];

  it("starts a new spread when the day changes", () => {
    const r = arrangeTrip(
      [
        photo("a", { takenAt: t(1, 9) }),
        photo("b", { takenAt: t(1, 18) }),
        photo("c", { takenAt: t(2, 9) }),
        photo("d", { takenAt: t(2, 18) }),
      ],
      templates,
    );
    expect(r.spreads.map((s) => s.photoIds)).toEqual([["a", "b"], ["c", "d"]]);
    expect(r.spreads[0].brokenBy).toBe("day");
    expect(r.spreads[1].brokenBy).toBe("end");
    expect(r.days).toBe(2);
  });

  it("runs the days together when asked to", () => {
    const r = arrangeTrip(
      [photo("a", { takenAt: t(1, 18) }), photo("b", { takenAt: t(2, 9) })],
      templates,
      { newSpreadEachDay: false, maxPerSpread: 6 },
    );
    expect(r.spreads).toHaveLength(1);
    expect(r.spreads[0].photoIds).toEqual(["a", "b"]);
  });

  it("does not treat a missing timestamp as a new day", () => {
    // A photo through a chat app loses its EXIF. That is missing information,
    // not evidence that the day changed.
    const r = arrangeTrip(
      [photo("a", { takenAt: t(1, 9) }), photo("b"), photo("c", { takenAt: t(1, 18) })],
      templates,
    );
    expect(r.spreads).toHaveLength(2);
    expect(r.spreads.flatMap((s) => s.photoIds).sort()).toEqual(["a", "b", "c"]);
  });

  it("says how it decided the order", () => {
    expect(arrangeTrip([photo("a", { takenAt: t(1, 9) })], templates).ordering).toBe(
      "capture time",
    );
    expect(arrangeTrip([photo("a")], templates).ordering).toBe("file name");
    const fileTimed: TripPhoto = { ...photo("a"), takenAt: t(1, 9), timeSource: "file" };
    expect(arrangeTrip([fileTimed], templates).ordering).toBe("file date");
  });

  it("counts the photos that will print soft, rather than hiding them", () => {
    const r = arrangeTrip([photo("a", { px: 300 }), photo("b", { px: 300 })], templates);
    expect(r.soft.red).toBe(2);
    expect(r.soft.amber).toBe(0);
  });

  it("hands back photos it could not place instead of dropping them", () => {
    const threeUp = tpl("three", [
      slot("S1", 0, 0, 40, 30), slot("S2", 0, 40, 40, 30), slot("S3", 0, 80, 40, 30),
    ]);
    const r = arrangeTrip([photo("a"), photo("b")], [threeUp]);
    expect(r.spreads).toEqual([]);
    expect(r.leftOver.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("crops every photo to fill its slot, the same as dropping it by hand", () => {
    const r = arrangeTrip([photo("a", { portrait: true }), photo("b")], templates);
    const p = r.spreads[0].placements[0];
    expect(p.assetId).toBe("a");
    expect(p.rotation).toBe(0);
    expect(p.straighten_deg).toBe(0);
    expect(p.copies).toBe(1);
    // A 3:4 photo in a 4:3 slot keeps its full width and loses height.
    expect(p.crop.w).toBeCloseTo(1, 6);
    expect(p.crop.h).toBeCloseTo(9 / 16, 3);
    expect(p.crop.y).toBeCloseTo((1 - 9 / 16) / 2, 3);
  });

  it("never rotates a photo to make it fit", () => {
    // Turning a landscape photo on its side to fill a portrait slot puts the
    // horizon up the page. Better a crop.
    const portraitOnly = tpl("p", [slot("S1", 0, 0, 30, 40)]);
    const r = arrangeTrip([photo("a")], [portraitOnly]);
    expect(r.spreads[0].placements[0].rotation).toBe(0);
  });
});

describe("against the real template set", () => {
  /** Three days of a phone-and-camera trip, portraits mixed in. */
  const trip = (): TripPhoto[] => {
    const shape = "LLPLLPPLLL LPLLLPL PPLL".replace(/ /g, "");
    const days = [1,1,1,1,1,1,1,1,1,1, 2,2,2,2,2,2,2, 3,3,3,3];
    let nth = 0;
    return shape.split("").map((sh, i) => {
      nth = i > 0 && days[i] === days[i - 1] ? nth + 1 : 0;
      return photo(`a${i}`, {
        portrait: sh === "P",
        // An hour apart through the day, so the trip's order is unambiguous.
        takenAt: t(days[i], 8 + nth),
        name: `IMG_${1000 + i}.jpg`,
      });
    });
  };

  for (const formatId of ["passport-tn", "a6", "a5"]) {
    it(`uses every photo exactly once, in order, on ${formatId}`, () => {
      const photos = trip();
      const r = arrangeTrip(photos, templatesForFormat(formatId));
      const placed = r.spreads.flatMap((s) => s.photoIds);

      expect(r.leftOver).toEqual([]);
      expect(placed).toEqual(photos.map((p) => p.id));
      // Every slot of every chosen layout is filled — no half-empty spreads.
      for (const s of r.spreads) {
        expect(s.placements).toHaveLength(s.photoIds.length);
        expect(new Set(s.placements.map((p) => p.slotId)).size).toBe(s.photoIds.length);
      }
    });
  }

  it("fills the pages instead of giving each photo one of its own", () => {
    // 21 photos over 3 days. One per page would be 21 spreads; the measured
    // behaviour at the chosen page cost is 6.
    const r = arrangeTrip(trip(), templatesForFormat("a5"));
    expect(r.spreads.length).toBeLessThanOrEqual(8);
    expect(r.spreads.filter((s) => s.photoIds.length === 1).length).toBeLessThanOrEqual(2);
  });

  it("breaks the spreads where the days break", () => {
    const r = arrangeTrip(trip(), templatesForFormat("a5"));
    const dayEnds = r.spreads.filter((s) => s.brokenBy === "day").length;
    expect(dayEnds).toBe(2); // three days, so two internal breaks
    expect(r.spreads[r.spreads.length - 1].brokenBy).toBe("end");
  });
});
