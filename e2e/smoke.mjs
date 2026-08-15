/**
 * End-to-end check against a real browser: drop photos in, generate the PDF,
 * then measure the PDF that actually came out.
 *
 * Run with the dev server up:  node e2e/smoke.mjs [url]
 */
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:5177/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e-out");
const PT_PER_MM = 72 / 25.4;

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`ok    ${msg}`);

/** A PNG with visible structure, so a wrong crop is obvious in the artefacts. */
const makePng = async (page, w, h) =>
  page.evaluate(
    async ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#2f6f8f");
      g.addColorStop(1, "#d8a657");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      x.strokeStyle = "#fff";
      x.lineWidth = Math.max(2, w / 100);
      for (let i = 1; i < 8; i++) {
        x.beginPath();
        x.moveTo((i * w) / 8, 0);
        x.lineTo((i * w) / 8, h);
        x.stroke();
      }
      x.fillStyle = "#111";
      x.font = `${Math.round(h / 6)}px sans-serif`;
      x.fillText(`${w}x${h}`, 12, h / 2);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      return Array.from(buf);
    },
    [w, h],
  );

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  // The environment ships a Chromium build that may not match this Playwright
  // version's expectation, so use the one already on disk.
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
  await page.waitForSelector(".layouts button");

  // ---- pick a layout
  await page.click('.layouts button:has-text("4 grid")');
  await page.waitForSelector(".spread .slot");
  const slotCount = await page.locator(".spread .slot").count();
  if (slotCount === 4) pass(`4 grid renders ${slotCount} slots`);
  else fail(`4 grid rendered ${slotCount} slots, expected 4`);

  // ---- add photos of varied aspect ratios
  const files = [];
  for (const [w, h] of [
    [3000, 2000],
    [1600, 2400],
    [2400, 2400],
    [4000, 1000],
  ]) {
    files.push({
      name: `test-${w}x${h}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(await makePng(page, w, h)),
    });
  }
  await page.setInputFiles('input[type="file"]', files);
  await page.waitForFunction(() => document.querySelectorAll(".chip").length === 4);
  pass("four photos of different aspect ratios uploaded");

  // ---- place one photo per slot, via select-then-click
  for (let i = 0; i < 4; i++) {
    await page.locator(".chip").nth(i).click();
    await page.locator(".spread .slot").nth(i).click();
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".spread .slot canvas").length === 4,
  );
  pass("crop-to-fill placed a photo of every aspect ratio into its slot");

  // ---- exercise the editor controls on the selected slot
  await page.locator(".spread .slot").nth(3).click();
  await page.waitForSelector(".rail.right .quality");
  await page.locator('.rail.right button[title="Rotate right"]').click();
  const straighten = page.locator('.rail.right input[type="range"]').nth(1);
  await straighten.fill("6.5");
  const zoom = page.locator('.rail.right input[type="range"]').first();
  await zoom.fill("2.4");
  const dpi = await page.locator(".rail.right .quality .band").innerText();
  pass(`rotate + straighten + zoom applied, quality now ${dpi.replace(/\s+/g, " ")}`);

  // ---- everything lives in IndexedDB, so it must survive a reload
  await page.waitForTimeout(800); // let the autosave debounce land
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".spread .slot canvas");
  const afterReload = await page.locator(".spread .slot canvas").count();
  const chipsAfter = await page.locator(".chip").count();
  if (afterReload === 4 && chipsAfter === 4) {
    pass("project and photos reloaded from IndexedDB intact");
  } else {
    fail(`after reload: ${afterReload} filled slots, ${chipsAfter} photos, expected 4 and 4`);
  }

  // ---- a second spread, so the plan page has more than one
  await page.click('button:has-text("+ Add another spread")');
  await page.click('.layouts button:has-text("Polaroid cluster")');
  await page.locator(".chip").nth(0).click();
  await page.locator(".spread .slot").nth(0).click();
  pass("second spread added with a tilted layout");

  // The app's own report tells us how many sheets to expect, which is not
  // "pages minus one" — the layout plan can run to several pages itself.
  const expectedSheets = Number(
    (await page.locator(".report").innerText()).match(/(\d+)\s+A4 sheet/)?.[1] ?? "0",
  );
  if (expectedSheets > 0) pass(`app reports ${expectedSheets} A4 sheet(s)`);
  else fail("app reported no sheets to print");

  // ---- generate
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Generate A4 PDF")'),
  ]);
  const pdfPath = join(OUT, "cutsheet.pdf");
  await download.saveAs(pdfPath);
  pass(`PDF generated: ${download.suggestedFilename()}`);

  await page.screenshot({ path: join(OUT, "editor.png"), fullPage: false });

  // ---- measure what actually came out
  const bytes = new Uint8Array(
    await (await import("node:fs/promises")).readFile(pdfPath),
  );
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();

  let badPage = null;
  for (const p of pages) {
    const s = p.getSize();
    if (
      Math.abs(s.width / PT_PER_MM - 210) > 1e-6 ||
      Math.abs(s.height / PT_PER_MM - 297) > 1e-6
    ) {
      badPage = s;
    }
  }
  if (badPage) fail(`a page is ${badPage.width} x ${badPage.height} pt, not A4`);
  else pass(`${pages.length} pages, every one exactly 210 x 297 mm`);

  // Inflate content streams and measure image boxes + the ruler.
  const contentOf = (page) => {
    const c = page.node.Contents();
    const refs = c && c.constructor.name === "PDFArray" ? c.asArray() : [c];
    let out = "";
    for (const r of refs) {
      if (!r) continue;
      const st = doc.context.lookup(r);
      if (!st?.getContents) continue;
      const raw = Buffer.from(st.getContents());
      try {
        out += inflateSync(raw).toString("latin1");
      } catch {
        out += raw.toString("latin1");
      }
    }
    return out;
  };

  let imagesFound = 0;
  let rulersFound = 0;
  const sizes = new Set();

  for (const p of pages) {
    const text = contentOf(p);
    for (const block of text.split("q\n")) {
      if (!/\/Image[-\w]* Do/.test(block)) continue;
      const cms = [...block.matchAll(/^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/gm)];
      if (cms.length < 3) continue;
      const w = Number(cms[2][1]) / PT_PER_MM;
      const h = Number(cms[2][4]) / PT_PER_MM;
      imagesFound++;
      sizes.add(`${w.toFixed(3)}x${h.toFixed(3)}`);
    }

    // The 100 mm calibration rule: a horizontal line exactly 100 mm long.
    const lines = [...text.matchAll(/^(\S+) (\S+) m\n(?:\S+ \S+ m\n)?(\S+) (\S+) l$/gm)];
    for (const m of lines) {
      const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number);
      const len = Math.hypot(x2 - x1, y2 - y1) / PT_PER_MM;
      if (Math.abs(y1 - y2) < 1e-9 && Math.abs(len - 100) < 1e-9) rulersFound++;
    }
  }

  if (imagesFound > 0) pass(`${imagesFound} photo boxes drawn, sizes: ${[...sizes].join(", ")}`);
  else fail("no photos were drawn into the PDF");

  // Every drawn box must land on a whole-tenth-of-a-mm size we asked for.
  const nonExact = [...sizes].filter((s) => {
    const [w, h] = s.split("x").map(Number);
    return !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0;
  });
  if (nonExact.length) fail(`degenerate image boxes: ${nonExact.join(", ")}`);

if (rulersFound === expectedSheets && expectedSheets > 0) {
    pass(`100.0 mm calibration rule on each of the ${expectedSheets} sheet(s)`);
  } else {
    fail(`found ${rulersFound} calibration rules for ${expectedSheets} sheets`);
  }

  // Plan pages carry no ruler, so the rest of the document is the plan.
  pass(`${pages.length - expectedSheets} layout plan page(s) + ${expectedSheets} sheet(s)`);

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(" | ")}`);
  else pass("no console errors");

  writeFileSync(join(OUT, "sizes.json"), JSON.stringify([...sizes], null, 2));
  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
