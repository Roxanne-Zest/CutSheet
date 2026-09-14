/**
 * End-to-end check of Arrange a trip, against a real browser.
 *
 * The fixture is what the feature is for: a folder of holiday photos whose
 * file names are in the wrong order, spanning three days, off two cameras.
 * Each photo is a flat colour, so the colours coming back off the rendered
 * spreads prove the capture time in the file reached the page — not just that
 * something got arranged.
 *
 * Run with a server up:  node e2e/trip.mjs [url]
 */
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "http://localhost:5177/";

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failures += 1;
  process.exitCode = 1;
};
const pass = (msg) => console.log(`ok    ${msg}`);

/**
 * Splice an EXIF APP1 segment carrying DateTimeOriginal into a JPEG, the way
 * a camera would have written it. Little-endian TIFF, IFD0 pointing at the
 * Exif SubIFD, the date at an offset because 20 ASCII bytes never fit inline.
 */
const withExifDate = (jpeg, text) => {
  const ifd0At = 8;
  const ifd0Size = 2 + 12 + 4;
  const subAt = ifd0At + ifd0Size;
  const subSize = 2 + 12 + 4;
  const strAt = subAt + subSize;
  const tiffLen = strAt + text.length + 1;

  const app1 = Buffer.alloc(4 + 6 + tiffLen);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + 6 + tiffLen, 2);
  app1.write("Exif\0\0", 4, "latin1");

  const t = 10; // TIFF header starts here, and every offset is relative to it
  app1.write("II", t, "latin1");
  app1.writeUInt16LE(42, t + 2);
  app1.writeUInt32LE(ifd0At, t + 4);

  app1.writeUInt16LE(1, t + ifd0At);
  app1.writeUInt16LE(0x8769, t + ifd0At + 2); // Exif IFD pointer
  app1.writeUInt16LE(4, t + ifd0At + 4);
  app1.writeUInt32LE(1, t + ifd0At + 6);
  app1.writeUInt32LE(subAt, t + ifd0At + 10);
  app1.writeUInt32LE(0, t + ifd0At + 14);

  app1.writeUInt16LE(1, t + subAt);
  app1.writeUInt16LE(0x9003, t + subAt + 2); // DateTimeOriginal
  app1.writeUInt16LE(2, t + subAt + 4);
  app1.writeUInt32LE(text.length + 1, t + subAt + 6);
  app1.writeUInt32LE(strAt, t + subAt + 10);
  app1.writeUInt32LE(0, t + subAt + 14);
  app1.write(text + "\0", t + strAt, "latin1");

  // Straight after SOI, which is where a camera puts it.
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
};

/**
 * A photograph with structure in it, because the near-duplicate signature is a
 * normalised grayscale thumbnail and a flat colour has nothing to sign.
 *
 * Each one is a different arrangement of sky, horizon, tower and sun, tinted a
 * different hue, so no two are duplicates of each other and each is still
 * recognisable by its average colour when it comes back off the page. Passing
 * the same `shape` twice with a small `shift` makes a second attempt at one
 * shot — a burst.
 */
const makeJpeg = (page, w, h, hue, shape, shift = 0) =>
  page.evaluate(
    async ([w, h, hue, shape, shift]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      const u = Math.min(w, h) / 64;
      const dx = shift * u;

      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, hue);
      g.addColorStop(1, "#f2f2f2");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);

      const horizon = shape.horizon * u + dx;
      x.fillStyle = "#3a3a3a";
      x.fillRect(shape.towerX * u + dx, horizon - shape.towerH * u, shape.towerW * u, shape.towerH * u);

      x.fillStyle = "#fdfbe8";
      x.beginPath();
      x.arc(shape.sunX * u + dx, 12 * u, 6 * u, 0, Math.PI * 2);
      x.fill();

      x.fillStyle = hue;
      x.globalAlpha = 0.55;
      x.fillRect(0, horizon, w, h - horizon);
      x.globalAlpha = 1;

      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));

      // The average colour as rendered, so identifying it later needs no guess
      // about what the recipe averages out to.
      const d = x.getImageData(0, 0, w, h).data;
      let r = 0, gg = 0, b = 0;
      const step = 4 * Math.max(1, Math.floor(d.length / 4 / 2000));
      let n = 0;
      for (let i = 0; i < d.length; i += step) {
        r += d[i];
        gg += d[i + 1];
        b += d[i + 2];
        n += 1;
      }
      return { bytes, avg: [Math.round(r / n), Math.round(gg / n), Math.round(b / n)] };
    },
    [w, h, hue, shape, shift],
  );

/** Average colour of every slot canvas on the current spread, in order. */
const slotColours = (page) =>
  page.$$eval(".spread-wrap .spread .slot canvas", (canvases) =>
    canvases.map((c) => {
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const step = 4 * Math.max(1, Math.floor(d.length / 4 / 400));
      let n = 0;
      for (let i = 0; i < d.length; i += step) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n += 1;
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }),
  );

/** Which fixture this is, by nearest average colour. */
const nameOf = (rgb, palette) => {
  let best = null;
  let bestD = Infinity;
  for (const p of palette) {
    const d = Math.hypot(rgb[0] - p.rgb[0], rgb[1] - p.rgb[1], rgb[2] - p.rgb[2]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return bestD < 55 ? best.id : `unknown(${rgb})`;
};

const run = async () => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(URL_, { waitUntil: "networkidle" });
  await page.evaluate(() => indexedDB.deleteDatabase("cutsheet"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".layouts button");

  /**
   * Nine photographs over three days, each a different arrangement of the same
   * elements so no two are duplicates. The names run backwards against the
   * clock and two "cameras" interleave, so anything that sorts by name or by
   * upload order gets a different answer from anything that reads the file.
   *
   * `d2b` is then taken three times — the burst this trip is meant to survive.
   */
  const trip = [
    { id: "d1a", day: 1, hour: 9, min: 30, colour: "#c1121f", portrait: false, name: "IMG_9001.jpg",
      shape: { horizon: 40, towerX: 8, towerW: 10, towerH: 18, sunX: 48 } },
    { id: "d1b", day: 1, hour: 11, min: 30, colour: "#e85d04", portrait: true, name: "DSC_0500.jpg",
      shape: { horizon: 24, towerX: 44, towerW: 8, towerH: 14, sunX: 14 } },
    { id: "d1c", day: 1, hour: 16, min: 30, colour: "#ffba08", portrait: false, name: "IMG_9000.jpg",
      shape: { horizon: 50, towerX: 26, towerW: 20, towerH: 34, sunX: 6 } },
    { id: "d2a", day: 2, hour: 8, min: 30, colour: "#70e000", portrait: false, name: "DSC_0100.jpg",
      shape: { horizon: 18, towerX: 2, towerW: 14, towerH: 10, sunX: 56 } },
    { id: "d2b", day: 2, hour: 12, min: 30, colour: "#008000", portrait: true, name: "IMG_8000.jpg",
      shape: { horizon: 44, towerX: 50, towerW: 12, towerH: 30, sunX: 26 } },
    { id: "d2c", day: 2, hour: 14, min: 30, colour: "#00b4d8", portrait: false, name: "DSC_0099.jpg",
      shape: { horizon: 32, towerX: 16, towerW: 6, towerH: 26, sunX: 40 } },
    { id: "d2d", day: 2, hour: 19, min: 30, colour: "#0077b6", portrait: false, name: "IMG_7999.jpg",
      shape: { horizon: 56, towerX: 36, towerW: 18, towerH: 12, sunX: 20 } },
    { id: "d3a", day: 3, hour: 10, min: 30, colour: "#7209b7", portrait: false, name: "DSC_0001.jpg",
      shape: { horizon: 28, towerX: 30, towerW: 10, towerH: 22, sunX: 52 } },
    { id: "d3b", day: 3, hour: 15, min: 30, colour: "#c77dff", portrait: true, name: "IMG_0001.jpg",
      shape: { horizon: 36, towerX: 20, towerW: 24, towerH: 16, sunX: 34 } },
  ];

  /** Two more attempts at d2b, seconds later and half a step to one side. */
  const burst = [
    { ...trip[4], id: "d2b-2", burstOf: "d2b", name: "IMG_8001.jpg", min: 30, sec: 3, shift: 1 },
    { ...trip[4], id: "d2b-3", burstOf: "d2b", name: "IMG_8002.jpg", min: 30, sec: 6, shift: 2 },
  ];

  const palette = [];
  const files = [];
  for (const p of [...trip, ...burst]) {
    const made = await makeJpeg(
      page,
      p.portrait ? 1800 : 2400,
      p.portrait ? 2400 : 1800,
      p.colour,
      p.shape,
      p.shift ?? 0,
    );
    // The burst frames are the same photograph, so they average to very nearly
    // the same colour and cannot be told apart this way — which is precisely
    // why they are duplicates. They share one identity here; which of the three
    // survives is the keeper rule's job and is pinned in dedupe.test.ts.
    palette.push({ id: p.burstOf ?? p.id, rgb: made.avg });
    const stamp = `2024:07:0${p.day} ${String(p.hour).padStart(2, "0")}:${String(
      p.min,
    ).padStart(2, "0")}:${String(p.sec ?? 0).padStart(2, "0")}`;
    files.push({
      name: p.name,
      mimeType: "image/jpeg",
      buffer: withExifDate(Buffer.from(made.bytes), stamp),
    });
  }

  // Uploaded in a deliberately wrong order, so upload order proves nothing.
  const shuffled = [...files].reverse();
  await page.setInputFiles('input[type="file"]', shuffled);
  await page.waitForFunction(
    (n) => document.querySelectorAll(".chip").length === n,
    files.length,
  );
  pass(`${files.length} JPEGs with EXIF capture times uploaded, newest first`);

  // ---- the plan, before anything is applied to the project
  const arranger = page.locator("section:has(h2:text('Arrange a trip'))");
  const planText = (await arranger.locator(".report").innerText()).replace(/\s+/g, " ");
  if (/11 photos · 3 days/.test(planText)) pass(`plan reads the trip: ${planText}`);
  else fail(`plan should say 11 photos over 3 days, said: ${planText}`);

  if (/2 near-duplicates skipped across 1 burst/.test(planText)) {
    pass("the burst is recognised: 2 of the 3 attempts set aside");
  } else {
    fail(`expected the burst to be reported, plan said: ${planText}`);
  }

  const orderNote = (await arranger.innerText()).replace(/\s+/g, " ");
  if (/order they were taken/.test(orderNote)) {
    pass("the order came from the capture time in the files");
  } else {
    fail(`expected capture-time ordering, panel said: ${orderNote}`);
  }
  if (/Starts with IMG_9001\.jpg/.test(orderNote)) {
    pass("the first photo is the earliest, not the first uploaded or first by name");
  } else {
    fail("the panel names the wrong first photo");
  }

  // ---- turning the burst skipping off puts every attempt back
  const burstToggle = arranger.locator('label:has-text("One photo per burst") input');
  await burstToggle.uncheck();
  const allIn = await arranger.locator("button.primary").innerText();
  const withDupes = Number(allIn.match(/(\d+)\s+spread/)?.[1] ?? 0);
  if (withDupes < 1) fail(`the button should still promise spreads, said: ${allIn}`);
  const plainText = (await arranger.locator(".report").innerText()).replace(/\s+/g, " ");
  if (!/near-duplicate/.test(plainText)) {
    pass("unticking it lays out all 11, duplicates and all");
  } else {
    fail(`with skipping off nothing should be skipped, plan said: ${plainText}`);
  }
  await burstToggle.check();
  const backOn = (await arranger.locator(".report").innerText()).replace(/\s+/g, " ");
  if (/2 near-duplicates skipped/.test(backOn)) pass("and ticking it back on skips them again");
  else fail(`re-ticking should skip them again, plan said: ${backOn}`);

  const button = arranger.locator("button.primary");
  const label = await button.innerText();
  const promised = Number(label.match(/(\d+)\s+spread/)?.[1] ?? 0);
  if (promised >= 2) pass(`the button promises ${promised} spreads before you press it`);
  else fail(`the button should promise a spread count, said: ${label}`);

  // ---- arrange
  await button.click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".strip-item").length === n,
    promised,
  );
  pass(`arranging made exactly the ${promised} spreads it promised`);

  // The photos decode in the background, so the thumbnails fill in a moment
  // after the spreads appear.
  await page
    .waitForFunction(
      () => document.querySelectorAll(".strip-item .slot canvas").length === 9,
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  const filled = await page.$$eval(".strip-item .slot", (slots) => ({
    total: slots.length,
    withPhoto: slots.filter((s) => s.querySelector("canvas")).length,
  }));
  if (filled.total === 9 && filled.withPhoto === 9) {
    pass("every slot on every spread holds a photo, and no photo was left over");
  } else {
    fail(`expected 9 filled slots across the spreads, got ${JSON.stringify(filled)}`);
  }

  const chipsAfter = await page.locator(".chip").count();
  if (chipsAfter === 11) {
    pass("the skipped duplicates are still in the tray — nothing was deleted");
  } else {
    fail(`expected 11 photos still in the tray, found ${chipsAfter}`);
  }

  // ---- the photos are in the order they were taken, across the spreads
  const seen = [];
  for (let i = 0; i < promised; i++) {
    await page.locator(".strip-item").nth(i).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".spread-wrap .spread .slot canvas").length > 0,
    );
    for (const rgb of await slotColours(page)) seen.push(nameOf(rgb, palette));
  }
  const expected = trip.map((p) => p.id);
  if (seen.join(",") === expected.join(",")) {
    pass(`photos read in capture order across the spreads: ${seen.join(" ")}`);
  } else {
    fail(`out of order.\n  expected ${expected.join(" ")}\n  got      ${seen.join(" ")}`);
  }
  if (seen.filter((id) => id === "d2b").length === 1) {
    pass("the burst of three put exactly one photo on the page, in its place in the day");
  } else {
    fail(`the burst should contribute one photo, contributed ${seen.filter((id) => id === "d2b").length}`);
  }

  // ---- the day breaks
  const sizes = await page.$$eval(".strip-item", (items) =>
    items.map((i) => i.querySelectorAll(".slot canvas").length),
  );
  const cuts = [];
  let at = 0;
  for (const n of sizes) {
    at += n;
    cuts.push(at);
  }
  // Three days of 3, 4 and 2 photos: no spread may straddle 3 or 7.
  if (cuts.includes(3) && cuts.includes(7)) {
    pass(`spreads break where the days break: ${sizes.join(" + ")}`);
  } else {
    fail(`a spread straddles a day boundary: ${sizes.join(" + ")} (cuts at ${cuts})`);
  }

  // ---- undo
  await arranger.locator('button:has-text("Undo arrange")').click();
  await page.waitForFunction(() => document.querySelectorAll(".strip-item").length === 0);
  const empty = await page.locator(".empty-state").count();
  if (empty > 0) pass("undo puts the project back to no spreads at all");
  else fail("undo left something behind");

  // ---- and it survives a reload, because the arrange is just spreads
  await arranger.locator("button.primary").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".strip-item").length === n,
    promised,
  );
  await page.waitForTimeout(700); // the autosave debounce
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".strip-item");
  const afterReload = await page.locator(".strip-item").count();
  if (afterReload === promised) pass("the arranged spreads survive a reload");
  else fail(`after reload ${afterReload} spreads, expected ${promised}`);

  // ---- clearing the photos empties the slots but keeps the spreads
  await page.locator('.rail button:has-text("Clear photos")').click();
  const warning = (await page.locator(".rail .confirm").innerText()).replace(/\s+/g, " ");
  if (/9 of them are in a spread/.test(warning)) {
    pass("clearing says how many placed photos it is about to take with it");
  } else {
    fail(`the clear warning should count the placed photos, said: ${warning}`);
  }

  await page.locator('.rail .confirm button:has-text("Remove all")').click();
  await page.waitForFunction(() => document.querySelectorAll(".chip").length === 0);
  const after = await page.evaluate(() => ({
    spreads: document.querySelectorAll(".strip-item").length,
    canvases: document.querySelectorAll(".strip-item .slot canvas").length,
  }));
  if (after.spreads === promised && after.canvases === 0) {
    pass(`photos cleared, all ${after.spreads} spreads still standing with empty slots`);
  } else {
    fail(`after clearing: ${JSON.stringify(after)}, expected ${promised} spreads and no photos`);
  }

  await page.waitForTimeout(700); // the autosave debounce
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".strip-item");
  const chipsBack = await page.locator(".chip").count();
  if (chipsBack === 0) pass("the photos stay gone after a reload — they left IndexedDB too");
  else fail(`${chipsBack} photos came back after reload`);

  if (errors.length) fail(`console errors: ${errors.join(" | ")}`);
  else pass("no console errors");

  await browser.close();
  console.log(failures === 0 ? "\nAll trip checks passed." : `\n${failures} check(s) failed.`);
};

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
