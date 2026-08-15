/**
 * Render a generated PDF to PNGs so the sheets can be looked at, not just
 * measured. Uses pdf.js inside the same Chromium the smoke test drives.
 *
 *   node e2e/render-pdf.mjs e2e-out/cutsheet.pdf
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfPath = process.argv[2] ?? join(root, "e2e-out", "cutsheet.pdf");
const outDir = join(root, "e2e-out");
const dpi = Number(process.env.RENDER_DPI ?? 96);

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();

await page.goto("about:blank");
await page.addScriptTag({
  path: join(root, "node_modules/pdfjs-dist/build/pdf.min.mjs"),
  type: "module",
});
const workerSrc = readFileSync(
  join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
  "utf8",
);

const data = Array.from(readFileSync(pdfPath));

const pngs = await page.evaluate(
  async ({ data, workerSrc, dpi }) => {
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([workerSrc], { type: "text/javascript" }),
    );
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const viewport = p.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport, canvas }).promise;
      out.push(canvas.toDataURL("image/png"));
    }
    return out;
  },
  { data, workerSrc, dpi },
);

mkdirSync(outDir, { recursive: true });
const stem = basename(pdfPath, ".pdf");
pngs.forEach((d, i) => {
  const file = join(outDir, `${stem}-p${i + 1}.png`);
  writeFileSync(file, Buffer.from(d.split(",")[1], "base64"));
  console.log(`wrote ${file}`);
});

await browser.close();
