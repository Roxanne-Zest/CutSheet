/**
 * End-to-end check of the Cut Path Builder, against a real browser.
 *
 * The fixture is the case the feature exists for: dark artwork wrapped in a
 * wobbly, uneven, near-white border painted into the pixels. The checks are
 * that the wobble is discarded rather than traced, that what replaces it is a
 * uniform mathematical border, and that the exported files say so.
 *
 * Run with a server up:  node e2e/cutpath.mjs [url]
 */
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
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
 * A sticker with its border painted into the pixels: a dark disc, wrapped in a
 * near-white ring whose outer edge wobbles by +/- 7% of the radius.
 */
const makeSticker = (page, size, wobble) =>
  page.evaluate(
    async ([size, wobble]) => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const x = c.getContext("2d");
      const img = x.createImageData(size, size);
      const mid = size / 2;
      for (let y = 0; y < size; y++) {
        for (let px = 0; px < size; px++) {
          const o = (y * size + px) * 4;
          const ang = Math.atan2(y - mid, px - mid);
          const d = Math.hypot(px - mid, y - mid);
          const art = size * 0.28;
          const fake = art + size * 0.09 + (wobble ? size * 0.035 * Math.sin(ang * 7) : 0);
          let v = [255, 255, 255];
          if (d <= art) v = [40, 60, 90];
          else if (d <= fake) v = [247, 246, 244];
          img.data[o] = v[0];
          img.data[o + 1] = v[1];
          img.data[o + 2] = v[2];
          img.data[o + 3] = 255;
        }
      }
      x.putImageData(img, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [size, wobble],
  );

const readout = async (page) => {
  const text = await page.locator(".readout").innerText();
  const m = /(\d+) sticker.*?· (\d+) nodes · ([\d.]+) × ([\d.]+) mm/.exec(text);
  if (!m) return null;
  return {
    stickers: Number(m[1]),
    nodes: Number(m[2]),
    w_mm: Number(m[3]),
    h_mm: Number(m[4]),
    raw: text,
  };
};

/** Wait for the readout to settle after a control change. */
const settled = async (page, previous) => {
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector(".readout");
      return el && !/working|Tracing/.test(el.textContent) && el.textContent !== prev;
    },
    previous,
    { timeout: 30000 },
  );
  return readout(page);
};

const setSlider = async (page, label, value) => {
  const before = await page.locator(".readout").innerText();
  await page.locator(`input[aria-label="${label}"]`).fill(String(value));
  return settled(page, before);
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
  await page.click('.seg.modes button:has-text("Cut path")');
  await page.waitForSelector(".dropzone.big");

  // ---- P1-P4: load a sticker whose border wobbles
  const SIZE = 600;
  const wobbly = Buffer.from(await makeSticker(page, SIZE, true));
  await page.setInputFiles('input[type="file"]', {
    name: "sticker.png",
    mimeType: "image/png",
    buffer: wobbly,
  });
  await page.waitForSelector(".cutpath-pair canvas");
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".readout");
      return el && /sticker/.test(el.textContent) && !/working/.test(el.textContent);
    },
    { timeout: 30000 },
  );
  pass("sticker loaded and traced in the worker");

  const first = await readout(page);
  if (!first) {
    fail("no readout after loading");
    await browser.close();
    return;
  }
  if (first.stickers === 1) pass(`found ${first.stickers} sticker`);
  else fail(`found ${first.stickers} stickers, expected 1`);

  if (first.nodes > 0 && first.nodes <= 400) {
    pass(`${first.nodes} nodes — inside the 400-node plotter budget`);
  } else {
    fail(`${first.nodes} nodes, expected 1..400`);
  }

  // ---- The whole premise: the fake border is discarded, not traced.
  // Artwork is 0.56 of the image; the default 2 mm border adds 4 mm.
  // At 48 mm wide that is 0.56*48 + 4 = 30.9 mm.
  if (near(first.w_mm, 30.9, 1.2)) {
    pass(`path is ${first.w_mm} mm — the artwork plus 2 mm, not the painted border`);
  } else {
    fail(`path is ${first.w_mm} mm; expected about 30.9 (the wobbly border is being traced)`);
  }

  // ---- The same sticker with a clean border must give the same path.
  const clean = Buffer.from(await makeSticker(page, SIZE, false));
  const beforeSwap = await page.locator(".readout").innerText();
  await page.setInputFiles('input[type="file"]', {
    name: "sticker-clean.png",
    mimeType: "image/png",
    buffer: clean,
  });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector(".readout");
      return el && !/working|Tracing/.test(el.textContent) && el.textContent !== prev;
    },
    beforeSwap,
    { timeout: 30000 },
  );
  const cleanRead = await readout(page);
  if (near(cleanRead.w_mm, first.w_mm, 0.6)) {
    pass(`a clean border gives the same path (${cleanRead.w_mm} vs ${first.w_mm} mm)`);
  } else {
    fail(`clean ${cleanRead.w_mm} mm vs wobbly ${first.w_mm} mm — the border is leaking in`);
  }

  // ---- P5: the border control moves the path by exactly what it says
  const at4 = await setSlider(page, "Border", 4);
  if (near(at4.w_mm - cleanRead.w_mm, 4, 0.6)) {
    pass(`raising the border 2 mm to 4 mm grew the path by ${(at4.w_mm - cleanRead.w_mm).toFixed(2)} mm`);
  } else {
    fail(`border 2->4 mm changed the path by ${(at4.w_mm - cleanRead.w_mm).toFixed(2)} mm, expected 4`);
  }

  const at0 = await setSlider(page, "Border", 0);
  if (at0.w_mm < cleanRead.w_mm) pass("border 0 cuts on the artwork edge");
  else fail("border 0 did not shrink the path");

  const negative = await setSlider(page, "Border", -1);
  if (negative.w_mm < at0.w_mm) pass("a negative border cuts inside the artwork, for photos");
  else fail("a negative border did not cut inside");

  await setSlider(page, "Border", 2);

  // ---- The finished size is the number the user typed
  const beforeWidth = await page.locator(".readout").innerText();
  await page.fill('input[aria-label="Finished width in millimetres"]', "96");
  const doubled = await settled(page, beforeWidth);
  // Artwork doubles; the 2 mm border does not, so it is not simply 2x.
  const expected = (cleanRead.w_mm - 4) * 2 + 4;
  if (near(doubled.w_mm, expected, 1.2)) {
    pass(`doubling the width gives ${doubled.w_mm} mm — artwork scales, the border stays 2 mm`);
  } else {
    fail(`at 96 mm the path is ${doubled.w_mm} mm, expected about ${expected.toFixed(1)}`);
  }
  await page.fill('input[aria-label="Finished width in millimetres"]', "48");
  await settled(page, await page.locator(".readout").innerText());

  // ---- P1: the tolerance is what strips the painted border
  const greedy = await setSlider(page, "Background tolerance", 1);
  if (greedy.w_mm > first.w_mm + 2) {
    pass(`at 1% tolerance the fake border survives and is traced (${greedy.w_mm} mm)`);
  } else {
    fail(`at 1% tolerance the path is ${greedy.w_mm} mm — the border should not have been stripped`);
  }
  await setSlider(page, "Background tolerance", 12);

  // ---- P6: the blade radius removes what the blade cannot cut.
  // A disc has no feature too tight to cut, so this needs its own fixture: a
  // disc with a hair-thin spike. Note the border has to be 0 for this to bite —
  // a +2 mm offset fattens a thin spike into something cuttable on its own.
  const spiky = await page.evaluate(async () => {
    const size = 600;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, size, size);
    x.fillStyle = "#1e3246";
    x.beginPath();
    x.arc(size / 2, size / 2 + 40, 150, 0, Math.PI * 2);
    x.fill();
    // 9 px wide, 100 px long: 0.72 x 8 mm at 48 mm across. Wide enough to
    // survive the 2 px smoothing pass, far too thin for a 1.5 mm blade.
    x.fillRect(size / 2 - 4.5, size / 2 - 180, 9, 100);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const beforeSpike = await page.locator(".readout").innerText();
  await page.setInputFiles('input[type="file"]', {
    name: "spiky.png",
    mimeType: "image/png",
    buffer: Buffer.from(spiky),
  });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector(".readout");
      return el && !/working|Tracing/.test(el.textContent) && el.textContent !== prev;
    },
    beforeSpike,
    { timeout: 30000 },
  );
  await setSlider(page, "Border", 0);
  const sharp = await setSlider(page, "Blade radius", 0);
  const blunt = await setSlider(page, "Blade radius", 1.5);

  if (blunt.h_mm < sharp.h_mm - 2) {
    pass(
      `a 1.5 mm blade radius removed the hair-thin spike (${sharp.h_mm} -> ${blunt.h_mm} mm tall)`,
    );
  } else {
    fail(
      `blade radius left a feature the blade cannot cut: ${sharp.h_mm} -> ${blunt.h_mm} mm tall`,
    );
  }
  if (blunt.nodes <= 400) pass(`cuttable path is ${blunt.nodes} nodes`);
  else fail(`cuttable path is ${blunt.nodes} nodes`);

  await setSlider(page, "Blade radius", 1);
  await setSlider(page, "Border", 2);

  await page.screenshot({ path: join(OUT, "cutpath.png") });

  // ================= Ink route: illustration on decorative paper =================
  // The case the paper route cannot do — pale artwork on pale paper, every
  // element ringed by a drawn outline, and the paper unevenly aged.
  const illustrated = await page.evaluate(async () => {
    const w = 700, h = 600;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    const img = x.createImageData(w, h);
    const PAPER = [242, 230, 208], INK = [95, 62, 32], MID = [186, 140, 88], PALE = [237, 224, 200];
    for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) {
      const d = Math.hypot(px / w - 0.5, y / h - 0.5) / 0.7;
      const k = 1 - 0.15 * d;                       // aged paper, darker at the edges
      const o = (y * w + px) * 4;
      img.data[o] = PAPER[0] * k; img.data[o+1] = PAPER[1] * k; img.data[o+2] = PAPER[2] * k;
      img.data[o+3] = 255;
    }
    const put = (px, y, col) => {
      if (px < 0 || y < 0 || px >= w || y >= h) return;
      const o = (Math.round(y) * w + Math.round(px)) * 4;
      img.data[o] = col[0]; img.data[o+1] = col[1]; img.data[o+2] = col[2];
    };
    const blob = (cx, cy, rx, ry, col) => {
      for (let y = cy-ry-2; y <= cy+ry+2; y++) for (let px = cx-rx-2; px <= cx+rx+2; px++) {
        const t = ((px-cx)/rx)**2 + ((y-cy)/ry)**2;
        if (t <= 1) put(px, y, col); else if (t <= 1.06) put(px, y, INK);
      }
    };
    for (let r = 0; r < 2; r++) for (let col = 0; col < 3; col++) {
      const cx = 130 + col * 190, cy = 150 + r * 220;
      blob(cx, cy, 62, 44, MID);
      blob(cx - 40, cy - 26, 24, 20, INK);
      blob(cx + 52, cy - 10, 34, 18, PALE);   // pale tail, same tone as the paper
    }
    x.putImageData(img, 0, 0);
    const blob2 = await new Promise((r) => c.toBlob(r, "image/png"));
    return Array.from(new Uint8Array(await blob2.arrayBuffer()));
  });

  const beforeInk = await page.locator(".readout").innerText();
  await page.setInputFiles('input[type="file"]', {
    name: "illustrated.png",
    mimeType: "image/png",
    buffer: Buffer.from(illustrated),
  });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector(".readout");
      return el && !/working|Tracing/.test(el.textContent) && el.textContent !== prev;
    },
    beforeInk,
    { timeout: 30000 },
  );
  await page.fill('input[aria-label="Finished width in millimetres"]', "180");
  const onPaper = await settled(page, await page.locator(".readout").innerText());

  const warned = await page.locator(".rail.right").innerText();
  if (/being eaten by the flood fill/.test(warned) || onPaper.stickers < 6) {
    pass(`paper route on an illustrated sheet: ${onPaper.stickers} stickers, and the app says why`);
  } else {
    fail(`paper route reported ${onPaper.stickers} stickers with no warning — the amputation is silent`);
  }

  await page.click('.rail.right .seg button:has-text("Ink")');
  const onInk = await settled(page, await page.locator(".readout").innerText());

  if (onInk.stickers === 6) pass(`ink route finds all 6 stickers on the aged sheet`);
  else fail(`ink route found ${onInk.stickers} stickers, expected 6`);

  // Body + tail spans about 151 px of 700 at 180 mm, plus a 2 mm border: ~43 mm.
  // The paper route loses the tail and lands near 36.
  if (onInk.w_mm > onPaper.w_mm) {
    pass(`ink route keeps the pale tails (${onInk.w_mm} mm vs ${onPaper.w_mm} mm on paper)`);
  } else {
    fail(`ink route did not recover the tails: ${onInk.w_mm} vs ${onPaper.w_mm} mm`);
  }

  if (await page.locator('input[aria-label="Ink threshold"]').count()) {
    pass("ink route swaps in its own controls");
  } else {
    fail("ink route did not show Ink threshold");
  }
  if (!(await page.locator('input[aria-label="Background tolerance"]').count())) {
    pass("the paper route's tolerance is hidden while the ink route is on");
  } else {
    fail("Background tolerance still showing on the ink route");
  }

  await page.screenshot({ path: join(OUT, "cutpath-ink.png") });

  // Hand the rest of the run the state it expects to start from.
  await page.click('.rail.right .seg button:has-text("Paper")');
  await page.fill('input[aria-label="Finished width in millimetres"]', "48");
  await settled(page, await page.locator(".readout").innerText());



  // ---- P3: six stickers, six paths
  const sheet = await page.evaluate(async () => {
    const w = 900;
    const h = 300;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, w, h);
    x.fillStyle = "#1e3246";
    for (let k = 0; k < 6; k++) {
      x.beginPath();
      x.arc(75 + k * 150, 150, 55, 0, Math.PI * 2);
      x.fill();
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const beforeSheet = await page.locator(".readout").innerText();
  await page.setInputFiles('input[type="file"]', {
    name: "sheet.png",
    mimeType: "image/png",
    buffer: Buffer.from(sheet),
  });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector(".readout");
      return el && !/working|Tracing/.test(el.textContent) && el.textContent !== prev;
    },
    beforeSheet,
    { timeout: 30000 },
  );
  await page.fill('input[aria-label="Finished width in millimetres"]', "180");
  const six = await settled(page, await page.locator(".readout").innerText());
  if (six.stickers === 6) pass("six stickers on one sheet give six separate paths");
  else fail(`sheet of six traced as ${six.stickers} path(s)`);

  // ---- P7: the exports
  const [svgDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("SVG — artwork + cut layer")'),
  ]);
  const svgPath = join(OUT, "cutpath.svg");
  await svgDl.saveAs(svgPath);
  const svg = await readFile(svgPath, "utf8");

  if (/width="[\d.]+mm"\s+height="[\d.]+mm"/.test(svg)) pass("SVG is sized in millimetres");
  else fail("SVG is not sized in millimetres");
  if (/<g id="cut"/.test(svg)) pass("SVG keeps the cut path on its own layer");
  else fail("SVG has no cut layer");
  if (/<image[^>]+href="data:image\/png;base64,/.test(svg)) pass("SVG embeds the artwork");
  else fail("SVG does not embed the artwork");

  const svgW = Number(/width="([\d.]+)mm"/.exec(svg)?.[1] ?? "0");
  if (near(svgW, six.w_mm, 0.2)) pass(`SVG document is ${svgW} mm, matching the readout`);
  else fail(`SVG says ${svgW} mm but the app reported ${six.w_mm} mm`);

  const [pngDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("PNG for Cricut")'),
  ]);
  const pngPath = join(OUT, "cutpath.png-export.png");
  await pngDl.saveAs(pngPath);
  const png = await readFile(pngPath);
  // PNG signature, then IHDR width/height at a known offset.
  const pw = png.readUInt32BE(16);
  const ph = png.readUInt32BE(20);
  const expectPx = Math.round((six.w_mm / 25.4) * 300);
  if (near(pw, expectPx, Math.max(4, expectPx * 0.02))) {
    pass(`Cricut PNG is ${pw} x ${ph} px — ${six.w_mm} mm at 300 dpi`);
  } else {
    fail(`Cricut PNG is ${pw} px wide, expected about ${expectPx}`);
  }
  if (png.includes(Buffer.from("PNG"))) pass("Cricut PNG is a real PNG");

  const [pdfDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('button:has-text("PDF with Silhouette marks")'),
  ]);
  const pdfPath = join(OUT, "cutpath-silhouette.pdf");
  await pdfDl.saveAs(pdfPath);
  const doc = await PDFDocument.load(new Uint8Array(await readFile(pdfPath)));
  const size = doc.getPage(0).getSize();
  if (near(size.width / PT_PER_MM, 210, 0.01) && near(size.height / PT_PER_MM, 297, 0.01)) {
    pass("Silhouette PDF is A4");
  } else {
    fail(`Silhouette PDF is ${size.width / PT_PER_MM} x ${size.height / PT_PER_MM} mm`);
  }

  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(" | ")}`);
  else pass("no console errors");

  await browser.close();
  console.log(failures === 0 ? "\nall cut-path checks passed" : `\n${failures} check(s) failed`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
