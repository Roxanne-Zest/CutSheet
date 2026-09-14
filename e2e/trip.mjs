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

/** A photo of one flat colour, so it can be recognised again on the page. */
const makeJpeg = (page, w, h, colour) =>
  page.evaluate(
    async ([w, h, colour]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      x.fillStyle = colour;
      x.fillRect(0, 0, w, h);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [w, h, colour],
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

/** Which fixture colour this is, by nearest match — JPEG shifts them a little. */
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
  return bestD < 40 ? best.id : `unknown(${rgb})`;
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
   * Nine photos over three days. The names run backwards against the clock and
   * two "cameras" interleave, so anything that sorts by name or by upload order
   * gets a different answer from anything that reads the file.
   */
  const trip = [
    { id: "d1a", day: 1, hour: 9, colour: "#c1121f", portrait: false, name: "IMG_9001.jpg" },
    { id: "d1b", day: 1, hour: 11, colour: "#e85d04", portrait: true, name: "DSC_0500.jpg" },
    { id: "d1c", day: 1, hour: 16, colour: "#ffba08", portrait: false, name: "IMG_9000.jpg" },
    { id: "d2a", day: 2, hour: 8, colour: "#70e000", portrait: false, name: "DSC_0100.jpg" },
    { id: "d2b", day: 2, hour: 12, colour: "#008000", portrait: true, name: "IMG_8000.jpg" },
    { id: "d2c", day: 2, hour: 14, colour: "#00b4d8", portrait: false, name: "DSC_0099.jpg" },
    { id: "d2d", day: 2, hour: 19, colour: "#0077b6", portrait: false, name: "IMG_7999.jpg" },
    { id: "d3a", day: 3, hour: 10, colour: "#7209b7", portrait: false, name: "DSC_0001.jpg" },
    { id: "d3b", day: 3, hour: 15, colour: "#c77dff", portrait: true, name: "IMG_0001.jpg" },
  ];

  const files = [];
  for (const p of trip) {
    const bytes = Buffer.from(
      await makeJpeg(page, p.portrait ? 1800 : 2400, p.portrait ? 2400 : 1800, p.colour),
    );
    const stamp = `2024:07:0${p.day} ${String(p.hour).padStart(2, "0")}:30:00`;
    files.push({
      name: p.name,
      mimeType: "image/jpeg",
      buffer: withExifDate(bytes, stamp),
    });
  }

  // Uploaded in a deliberately wrong order, so upload order proves nothing.
  const shuffled = [...files].reverse();
  await page.setInputFiles('input[type="file"]', shuffled);
  await page.waitForFunction(() => document.querySelectorAll(".chip").length === 9);
  pass("nine JPEGs with EXIF capture times uploaded, newest first");

  // ---- the plan, before anything is applied to the project
  const arranger = page.locator("section:has(h2:text('Arrange a trip'))");
  const planText = (await arranger.locator(".report").innerText()).replace(/\s+/g, " ");
  if (/9 photos · 3 days/.test(planText)) pass(`plan reads the trip: ${planText}`);
  else fail(`plan should say 9 photos over 3 days, said: ${planText}`);

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

  // ---- the photos are in the order they were taken, across the spreads
  const palette = trip.map((p) => ({
    id: p.id,
    rgb: [
      parseInt(p.colour.slice(1, 3), 16),
      parseInt(p.colour.slice(3, 5), 16),
      parseInt(p.colour.slice(5, 7), 16),
    ],
  }));

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
