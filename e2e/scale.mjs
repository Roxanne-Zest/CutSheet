/**
 * End-to-end check of the two scale tools, against a real browser.
 *
 * X1/X2: the reference card comes out with a true 100 mm rule and punch-size
 * labels that mean what they say.
 * X3-X6: a sticker sheet of known geometry is measured on screen, and the PDF
 * that falls out is the size the arithmetic says it should be.
 *
 * Run with a server up:  node e2e/scale.mjs [url]
 */
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:5177/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e-out");
const PT_PER_MM = 72 / 25.4;

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failures += 1;
  process.exitCode = 1;
};
const pass = (msg) => console.log(`ok    ${msg}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * A sticker sheet with black discs on white at exactly known pixel diameters,
 * so a measurement can be checked against ground truth rather than against
 * whatever the drag happened to produce.
 */
const makeSheet = (page, w, h, discPx) =>
  page.evaluate(
    async ([w, h, d]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      x.fillStyle = "#ffffff";
      x.fillRect(0, 0, w, h);
      x.fillStyle = "#101010";
      // A 3x3 grid of discs, each exactly d px across.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const cx = (w / 3) * (col + 0.5);
          const cy = (h / 3) * (row + 0.5);
          x.beginPath();
          x.arc(cx, cy, d / 2, 0, Math.PI * 2);
          x.fill();
        }
      }
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [w, h, discPx],
  );

const contentOf = (doc, page) => {
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

const rulersIn = (content) => {
  let n = 0;
  for (const m of content.matchAll(/^(\S+) (\S+) m\n(?:\S+ \S+ m\n)?(\S+) (\S+) l$/gm)) {
    const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number);
    const len = Math.hypot(x2 - x1, y2 - y1) / PT_PER_MM;
    if (Math.abs(y1 - y2) < 1e-9 && Math.abs(len - 100) < 1e-9) n += 1;
  }
  return n;
};

const imageBoxesIn = (content) => {
  const out = [];
  for (const block of content.split("q\n")) {
    if (!/\/Image[-\w]* Do/.test(block)) continue;
    const cms = [...block.matchAll(/^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/gm)];
    if (cms.length < 3) continue;
    out.push({
      w_mm: Number(cms[2][1]) / PT_PER_MM,
      h_mm: Number(cms[2][4]) / PT_PER_MM,
    });
  }
  return out;
};

const textsIn = (content) => {
  const out = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    let s = "";
    for (let i = 0; i + 1 < m[1].length; i += 2) {
      s += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
    }
    out.push(s);
  }
  return out;
};

const readPdf = async (path) => {
  const bytes = new Uint8Array(await readFile(path));
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const size = p.getSize();
    const content = contentOf(doc, p);
    return {
      w_mm: size.width / PT_PER_MM,
      h_mm: size.height / PT_PER_MM,
      rulers: rulersIn(content),
      images: imageBoxesIn(content),
      texts: textsIn(content),
    };
  });
};

const run = async () => {
  mkdirSync(OUT, { recursive: true });
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
  await page.waitForSelector(".seg.modes button");

  // ================= Feature A — reference card =================
  await page.click('.seg.modes button:has-text("Reference card")');
  await page.waitForSelector(".card-preview");

  const circles = await page.locator(".card-preview .card-circle").count();
  const squares = await page.locator(".card-preview .card-square").count();
  if (circles === 10 && squares === 3) {
    pass(`reference card previews ${circles} circles and ${squares} squares`);
  } else {
    fail(`preview showed ${circles} circles / ${squares} squares, expected 10 / 3`);
  }

  const [cardDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download reference card")'),
  ]);
  const cardPath = join(OUT, "reference-card.pdf");
  await cardDl.saveAs(cardPath);

  const card = await readPdf(cardPath);
  if (card.length === 1 && near(card[0].w_mm, 210, 1e-6) && near(card[0].h_mm, 297, 1e-6)) {
    pass("reference card is one A4 page");
  } else {
    fail(`reference card is ${card.length} page(s) at ${card[0]?.w_mm} x ${card[0]?.h_mm} mm`);
  }
  if (card[0].rulers === 1) pass("reference card carries a 100.0 mm rule");
  else fail(`reference card has ${card[0].rulers} rules, expected 1`);

  const cardText = card[0].texts.join(" ");
  for (const [what, re] of [
    ["the print-at-100% header", /PRINT AT 100% \/ ACTUAL SIZE/],
    ["the fit-to-page warning", /Fit to page/],
    ["the measure-the-ruler footer", /Measure the 100 mm ruler/],
    ["the punch bleed note", /0\.5 mm larger than your punch/],
    ["an imperial equivalent", /1"/],
  ]) {
    if (re.test(cardText)) pass(`reference card states ${what}`);
    else fail(`reference card is missing ${what}`);
  }

  // ---- X2: punch mode and a custom size
  await page.click('.rail.right label:has-text("Label by punch size") input');
  await page.fill('input[aria-label="Custom circle diameter in millimetres"]', "13.5");
  await page.waitForFunction(
    () => document.querySelectorAll(".card-preview .card-circle").length === 16,
  );
  pass("custom size adds a row of six to the card");

  const [punchDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download reference card")'),
  ]);
  const punchPath = join(OUT, "reference-card-punch.pdf");
  await punchDl.saveAs(punchPath);
  const punchText = (await readPdf(punchPath))[0].texts.join(" ");
  if (/12 mm punch/.test(punchText) && /14/.test(punchText)) {
    pass("punch mode labels by punch size and states the drawn size");
  } else {
    fail(`punch card text did not carry punch labels: ${punchText.slice(0, 200)}`);
  }

  // ================= Feature B — sheet sizer =================
  await page.click('.seg.modes button:has-text("Sheet sizer")');
  await page.waitForSelector(".dropzone.big");

  // 1200 x 1800 px sheet, discs exactly 240 px across.
  const SHEET_W = 1200;
  const SHEET_H = 1800;
  const DISC_PX = 240;
  const sheetBytes = Buffer.from(await makeSheet(page, SHEET_W, SHEET_H, DISC_PX));
  await page.setInputFiles('input[type="file"]', {
    name: "stickers.png",
    mimeType: "image/png",
    buffer: sheetBytes,
  });
  await page.waitForSelector(".measure-canvas");
  pass("sticker sheet loaded into the measure canvas");

  // ---- drag across the middle disc, deliberately sloppily, and let the snap fix it
  const box = await page.locator(".measure-canvas").boundingBox();
  const view = await page.evaluate(() => {
    const c = document.querySelector(".measure-canvas");
    return { w: c.clientWidth, h: c.clientHeight };
  });
  // Read the view scale off the app's own HUD rather than re-deriving it, so
  // this measures the tool instead of a copy of its arithmetic.
  const zoomPct = Number(
    (await page.locator(".measure-hud span").first().innerText()).replace("%", ""),
  );
  const scale = zoomPct / 100;
  const originX = (view.w - SHEET_W * scale) / 2;
  const originY = (view.h - SHEET_H * scale) / 2;
  const toScreen = (ix, iy) => ({
    x: box.x + originX + ix * scale,
    y: box.y + originY + iy * scale,
  });

  const discCx = SHEET_W / 2;
  const discCy = SHEET_H / 2;
  // Aim a few source pixels inside each edge — a realistic, imperfect drag.
  const a = toScreen(discCx - DISC_PX / 2 + 4, discCy);
  const b = toScreen(discCx + DISC_PX / 2 - 3, discCy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();

  await page.waitForSelector(".rail.right .report:has-text('measured')");
  const measuredText = await page.locator(".rail.right").innerText();
  const measuredPx = Number(measuredText.match(/measured\s+(\d+)\s*px/)?.[1] ?? "0");
  // Snap must recover the true 240 px diameter from a drag that was 7 px short.
  if (near(measuredPx, DISC_PX, 3)) {
    pass(`snap recovered the true diameter: measured ${measuredPx} px, disc is ${DISC_PX} px`);
  } else {
    fail(`measured ${measuredPx} px for a ${DISC_PX} px disc — snap did not recover it`);
  }

  // ---- state what that disc is meant to be, and check the arithmetic
  await page.fill('input[aria-label="Real size of the measured feature, in millimetres"]', "12");
  await page.waitForFunction(() =>
    /Sheet prints at/.test(document.querySelector(".rail.right")?.innerText ?? ""),
  );
  const resultText = await page.locator(".rail.right").innerText();
  const printedW = Number(resultText.match(/Sheet prints at\s+([\d.]+)/)?.[1] ?? "0");
  // 240 px = 12 mm, so 1200 px = 60 mm and 1800 px = 90 mm.
  if (near(printedW, 60, 1)) pass(`sheet computed at ${printedW} mm wide, expected 60`);
  else fail(`sheet computed at ${printedW} mm wide, expected 60`);

  const dpiShown = Number(resultText.match(/(\d+)\s*dpi effective/)?.[1] ?? "0");
  if (near(dpiShown, 508, 2)) pass(`effective resolution reported as ${dpiShown} dpi`);
  else fail(`effective resolution reported as ${dpiShown} dpi, expected about 508`);

  const [sizerDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download PDF at true size")'),
  ]);
  const sizerPath = join(OUT, "sizer-true-size.pdf");
  await sizerDl.saveAs(sizerPath);
  const sized = await readPdf(sizerPath);

  if (sized.length === 1 && near(sized[0].w_mm, 210, 1e-6) && near(sized[0].h_mm, 297, 1e-6)) {
    pass("sizer output is one A4 page");
  } else {
    fail(`sizer output is ${sized.length} page(s) at ${sized[0]?.w_mm} x ${sized[0]?.h_mm} mm`);
  }
  if (sized[0].rulers === 1) pass("sizer output carries a 100.0 mm rule");
  else fail(`sizer output has ${sized[0].rulers} rules, expected 1`);

  const drawn = sized[0].images[0];
  if (drawn && near(drawn.w_mm, 60, 0.5) && near(drawn.h_mm, 90, 0.5)) {
    pass(`artwork drawn at ${drawn.w_mm.toFixed(2)} x ${drawn.h_mm.toFixed(2)} mm — true size`);
  } else {
    fail(
      `artwork drawn at ${drawn?.w_mm?.toFixed(2)} x ${drawn?.h_mm?.toFixed(2)} mm, expected 60 x 90`,
    );
  }
  // The disc is 12 mm of the 60 mm width; that ratio is what makes the punch fit.
  if (drawn) {
    const discOnPaper = (DISC_PX / SHEET_W) * drawn.w_mm;
    if (near(discOnPaper, 12, 0.1)) {
      pass(`a ${DISC_PX} px disc lands at ${discOnPaper.toFixed(2)} mm on paper`);
    } else {
      fail(`disc lands at ${discOnPaper.toFixed(2)} mm on paper, expected 12`);
    }
  }
  if (!/NOT TRUE SIZE/.test(sized[0].texts.join(" "))) {
    pass("output does not claim to be scaled, because it is not");
  } else {
    fail("a true-size output was labelled as scaled");
  }

  await page.click('.seg button:has-text("Tile")');
  const tileFits = await page.locator(".rail.right").innerText();
  if (/1 sheet/.test(tileFits)) {
    pass("a sheet that already fits is not tiled, whatever mode is chosen");
  } else {
    fail(`tiling a sheet that fits produced: ${tileFits.match(/\d+ sheets?/)?.[0]}`);
  }

  // ================= X6 — oversized artwork =================
  // Same sheet, but each disc is meant to be 60 mm: 300 x 450 mm of artwork,
  // which no A4 sheet can hold at true size.
  await page.fill('input[aria-label="Real size of the measured feature, in millimetres"]', "60");
  await page.waitForFunction(() =>
    /Sheet prints at\s+3[0-9]{2}/.test(document.querySelector(".rail.right")?.innerText ?? ""),
  );

  const tiledText = await page.locator(".rail.right").innerText();
  const tiledSheets = Number(tiledText.match(/(\d+)\s+sheets/)?.[1] ?? "0");
  if (tiledSheets > 1) pass(`oversized artwork tiles across ${tiledSheets} sheets`);
  else fail(`oversized artwork reported ${tiledSheets} sheets`);
  if (/5 mm overlap/.test(tiledText)) pass("tiling states the 5 mm overlap");
  else fail("tiling did not mention the overlap");

  const [tileDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download PDF at true size")'),
  ]);
  const tilePath = join(OUT, "sizer-tiled.pdf");
  await tileDl.saveAs(tilePath);
  const tiled = await readPdf(tilePath);

  if (tiled.length === tiledSheets) pass(`tiled PDF has ${tiled.length} pages`);
  else fail(`tiled PDF has ${tiled.length} pages, the app said ${tiledSheets}`);

  // Check against the size the app itself computed, not a hardcoded number:
  // the snap lands on the disc's real edge, so the true size is whatever that
  // measurement implies, and the tiles must all agree with it.
  const [, shownW, shownH] = tiledText.match(/Sheet prints at\s+([\d.]+)\s*x\s*([\d.]+)/) ?? [];
  const trueSized = tiled.every(
    (p) =>
      p.images[0] &&
      near(p.images[0].w_mm, Number(shownW), 0.1) &&
      near(p.images[0].h_mm, Number(shownH), 0.1),
  );
  if (trueSized) {
    pass(`every tile draws the artwork at ${shownW} x ${shownH} mm — true size throughout`);
  } else {
    fail(
      `tiles drew ${tiled[0].images[0]?.w_mm} x ${tiled[0].images[0]?.h_mm} mm, app reported ${shownW} x ${shownH}`,
    );
  }

  if (tiled.every((p) => p.rulers === 1)) pass("every tile carries its own 100.0 mm rule");
  else fail("a tile is missing its calibration rule");

  // ---- scale-to-fit is the alternative, and must say what it costs
  await page.click('.seg button:has-text("Scale to fit")');
  const fitText = await page.locator(".rail.right").innerText();
  if (/NOT be the size you measured/.test(fitText)) {
    pass("scale-to-fit warns that the stickers will no longer be true size");
  } else {
    fail("scale-to-fit did not warn about losing true size");
  }

  const [fitDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download PDF at true size")'),
  ]);
  const fitPath = join(OUT, "sizer-fit.pdf");
  await fitDl.saveAs(fitPath);
  const fitted = await readPdf(fitPath);
  if (fitted.length === 1) pass("scale-to-fit produces a single sheet");
  else fail(`scale-to-fit produced ${fitted.length} sheets`);
  if (/NOT TRUE SIZE/.test(fitted[0].texts.join(" "))) {
    pass("the scaled sheet says so on the page itself");
  } else {
    fail("a scaled sheet did not say it was scaled");
  }
  const fitImg = fitted[0].images[0];
  if (fitImg && fitImg.w_mm < Number(shownW) && fitImg.w_mm <= 194 + 1e-6) {
    pass(`scaled artwork drawn at ${fitImg.w_mm.toFixed(1)} mm, inside the printable width`);
  } else {
    fail(`scaled artwork drawn at ${fitImg?.w_mm} mm`);
  }

  // ================= PDF input =================
  // A PDF carries real units, so it should need no measuring at all. This also
  // exercises the dynamically-imported renderer and its worker, which no unit
  // test can reach.
  const artwork = await PDFDocument.create();
  const artPage = artwork.addPage([148 * PT_PER_MM, 210 * PT_PER_MM]);
  artPage.drawCircle({ x: 74 * PT_PER_MM, y: 105 * PT_PER_MM, size: 20 * PT_PER_MM });
  const artworkBytes = Buffer.from(await artwork.save());

  await page.setInputFiles('input[type="file"]', {
    name: "artwork.pdf",
    mimeType: "application/pdf",
    buffer: artworkBytes,
  });
  await page.waitForSelector('.rail.right label:has-text("Trust the size this PDF declares")', {
    timeout: 30000,
  });
  const pdfText = await page.locator(".rail.right").innerText();
  if (/Declares\s+148\s*x\s*210\s*mm/.test(pdfText)) {
    pass("PDF input reports the size the file itself declares");
  } else {
    fail(`PDF declared size not shown: ${pdfText.slice(0, 220).replace(/\s+/g, " ")}`);
  }
  if (/Sheet prints at\s+148/.test(pdfText)) {
    pass("PDF needs no measuring — the declared size is used straight away");
  } else {
    fail("PDF did not resolve to a physical size without measuring");
  }
  if (/Vector/.test(pdfText)) pass("PDF output is reported as vector, not as a dpi figure");
  else fail("PDF output was described in dpi, which it does not have");

  const [pdfDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("Download PDF at true size")'),
  ]);
  const pdfOutPath = join(OUT, "sizer-vector.pdf");
  await pdfDl.saveAs(pdfOutPath);
  const vector = await readPdf(pdfOutPath);
  if (vector.length === 1 && vector[0].images.length === 0) {
    pass("PDF artwork is embedded as vector, with no raster image on the page");
  } else {
    fail(`vector output had ${vector[0]?.images.length} raster images across ${vector.length} pages`);
  }
  if (vector[0]?.rulers === 1) pass("vector output still carries its 100.0 mm rule");
  else fail("vector output is missing its calibration rule");

  await page.screenshot({ path: join(OUT, "sizer.png") });

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(" | ")}`);
  else pass("no console errors");

  await browser.close();
  console.log(failures === 0 ? "\nall scale-tool checks passed" : `\n${failures} check(s) failed`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
