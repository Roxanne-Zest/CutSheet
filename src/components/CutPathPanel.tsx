import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CUTPATH, PHOTO_BORDER_MM } from "../lib/cutpath/types";
import type { CutPathSettings, Mask, Poly } from "../lib/cutpath/types";
import { rasterisePolys, compositeArtwork } from "../lib/cutpath/composite";
import type { Rgb } from "../lib/cutpath/composite";
import { boundsOf } from "../lib/cutpath/trace";
import { toPdf, toSvg } from "../lib/cutpath/exportPath";
import { MM_PER_INCH } from "../lib/units";
import type { CutPathRequest, CutPathResponse } from "../workers/cutpath.worker";

/**
 * Cut Path Builder.
 *
 * Controls in pipeline order, and both canvases update on every one of them.
 * The mask overlay is the important one to watch: it is where the flood fill
 * eating a white cloud shows up, and seeing it is most of the fix.
 *
 * The first control is which question to ask of the image at all — is the
 * background a flat colour to flood, or is this ink on paper? They fail in
 * opposite directions, so it is a choice rather than a tuning knob.
 */

/**
 * The pipeline runs on a downscaled copy. At 1400 px across a 48 mm sticker
 * that is 0.034 mm a pixel, an order finer than the 0.15 mm simplify tolerance,
 * so the path is identical and the sliders stay live on a 12 MP input. The
 * export still composites at full resolution.
 */
const WORK_MAX_PX = 1400;
const DEBOUNCE_MS = 120;
/** Cricut regenerates its contours from the alpha boundary, at this resolution. */
const EXPORT_DPI = 300;

type Loaded = {
  name: string;
  full: { data: Uint8ClampedArray; w: number; h: number };
  work: { data: Uint8ClampedArray; w: number; h: number };
  bitmap: ImageBitmap;
};

const readImage = async (file: File): Promise<Loaded> => {
  const bitmap = await createImageBitmap(file);
  const draw = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get a 2D canvas context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  };

  const full = draw(bitmap.width, bitmap.height);
  const k = Math.min(1, WORK_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const work =
    k === 1
      ? full
      : draw(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));

  return {
    name: file.name,
    full: { data: full.data, w: full.width, h: full.height },
    work: { data: work.data, w: work.width, h: work.height },
    bitmap,
  };
};

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) => (
  <div className="field">
    <span>
      <span>{label}</span>
      <span>
        {value}
        {unit}
      </span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
    />
    {hint && <p className="hint">{hint}</p>}
  </div>
);

export function CutPathPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [s, setS] = useState<CutPathSettings>({ ...DEFAULT_CUTPATH });
  const [result, setResult] = useState<CutPathResponse | null>(null);
  const [borderColour, setBorderColour] = useState("#ffffff");
  const [showMask, setShowMask] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const timer = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const resultRef = useRef<HTMLCanvasElement | null>(null);

  // ---- worker
  useEffect(() => {
    const w = new Worker(new URL("../workers/cutpath.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<CutPathResponse>) => {
      // Ignore anything but the newest request, or a slow early run can land
      // after a fast later one and put the preview back.
      if (e.data.id !== requestId.current) return;
      setResult(e.data);
      setBusy(false);
    };
    w.onerror = (e) => {
      setError(e.message || "The trace failed.");
      setBusy(false);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const run = useCallback(
    (img: Loaded, settings: CutPathSettings) => {
      const w = workerRef.current;
      if (!w) return;
      requestId.current += 1;
      setBusy(true);
      const pixels = new Uint8ClampedArray(img.work.data).buffer;
      const req: CutPathRequest = {
        id: requestId.current,
        width: img.work.w,
        height: img.work.h,
        pixels,
        settings,
      };
      w.postMessage(req, [pixels]);
    },
    [],
  );

  // ---- debounced re-run on any change
  useEffect(() => {
    if (!loaded) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => run(loaded, s), DEBOUNCE_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [loaded, s, run]);

  const open = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    try {
      const img = await readImage(file);
      setLoaded(img);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? `Could not open ${file.name}: ${e.message}` : "Could not open that file.");
    }
  };

  const maskOf = useCallback(
    (bits: ArrayBuffer, w: number, h: number): Mask => ({
      data: new Uint8Array(bits),
      w,
      h,
    }),
    [],
  );

  // ---- left canvas: artwork with the magenta mask overlay
  useEffect(() => {
    const canvas = sourceRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loaded) return;
    canvas.width = loaded.work.w;
    canvas.height = loaded.work.h;
    const base = new ImageData(loaded.work.w, loaded.work.h);
    base.data.set(loaded.work.data);
    ctx.putImageData(base, 0, 0);

    if (!result || !showMask) return;
    const mask = maskOf(result.maskBits.slice(0), result.maskW, result.maskH);
    const overlay = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < mask.data.length; i++) {
      if (!mask.data[i]) continue;
      const o = i * 4;
      overlay.data[o] = overlay.data[o] * 0.6 + 255 * 0.4;
      overlay.data[o + 1] = overlay.data[o + 1] * 0.6;
      overlay.data[o + 2] = overlay.data[o + 2] * 0.6 + 255 * 0.4;
    }
    ctx.putImageData(overlay, 0, 0);
  }, [loaded, result, showMask, maskOf]);

  const rgb = useMemo((): Rgb => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(borderColour);
    return m
      ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
      : { r: 255, g: 255, b: 255 };
  }, [borderColour]);

  /** Composite at any resolution, from the polygons rather than from a bitmap. */
  const composite = useCallback(
    (
      src: { data: Uint8ClampedArray; w: number; h: number },
      polys: Poly[],
      artwork: Poly[],
    ): ImageData => {
      const pxPerMm = s.width_mm > 0 ? src.w / s.width_mm : 1;
      const artMask = rasterisePolys(artwork, src.w, src.h, pxPerMm);
      const cutMask = rasterisePolys(polys, src.w, src.h, pxPerMm);
      const pixels = compositeArtwork(src.data, artMask, cutMask, rgb);
      const out = new ImageData(src.w, src.h);
      out.data.set(pixels);
      return out;
    },
    [s.width_mm, rgb],
  );

  // ---- right canvas: the regenerated artwork plus the proposed path
  useEffect(() => {
    const canvas = resultRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loaded || !result) return;
    canvas.width = loaded.work.w;
    canvas.height = loaded.work.h;

    // A checkerboard, so transparent reads as transparent and not as white.
    ctx.fillStyle = "#20242b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#262b33";
    for (let y = 0; y < canvas.height; y += 12) {
      for (let x = 0; x < canvas.width; x += 12) {
        if (((x / 12) & 1) === ((y / 12) & 1)) ctx.fillRect(x, y, 12, 12);
      }
    }

    const composed = composite(loaded.work, result.polys, result.artwork);
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext("2d")?.putImageData(composed, 0, 0);
    ctx.drawImage(tmp, 0, 0);

    // The cut path itself, 1 px cyan.
    const pxPerMm = s.width_mm > 0 ? loaded.work.w / s.width_mm : 1;
    ctx.strokeStyle = "#39d7e8";
    ctx.lineWidth = 1;
    for (const poly of result.polys) {
      for (const ring of [poly.outer, ...poly.holes]) {
        if (ring.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(ring[0].x * pxPerMm, ring[0].y * pxPerMm);
        for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x * pxPerMm, ring[i].y * pxPerMm);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }, [loaded, result, composite, s.width_mm]);

  /** Full-resolution artwork as a PNG, cut to the path. */
  const renderPng = useCallback(async (): Promise<{ blob: Blob; w_mm: number; h_mm: number } | null> => {
    if (!loaded || !result) return null;
    const b = boundsOf(result.polys);

    // Resolution is fixed in pixels-per-millimetre, once, and everything else
    // is derived from it. Deriving a scale from the path bounds and then a
    // second one from the image width lands a "300 dpi" export at 293 dpi.
    // Never below the source's own resolution, so a big file is not thrown away.
    const pxPerMm = Math.max(EXPORT_DPI / MM_PER_INCH, loaded.full.w / s.width_mm);
    const w = Math.max(1, Math.round(s.width_mm * pxPerMm));
    const h = Math.max(1, Math.round((loaded.full.h / loaded.full.w) * w));

    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(loaded.bitmap, 0, 0, w, h);
    const src = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    ctx.putImageData(composite(src, result.polys, result.artwork), 0, 0);

    // Trim to the path's own bounds, so the file is the sticker and nothing else.
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(b.w * pxPerMm));
    out.height = Math.max(1, Math.round(b.h * pxPerMm));
    out
      .getContext("2d")
      ?.drawImage(c, -b.x * pxPerMm, -b.y * pxPerMm);

    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    return blob ? { blob, w_mm: b.w, h_mm: b.h } : null;
  }, [loaded, result, composite, s.width_mm]);

  const shifted = useCallback((): Poly[] => {
    if (!result) return [];
    const b = boundsOf(result.polys);
    const move = (r: Poly["outer"]) => r.map((p) => ({ x: p.x - b.x, y: p.y - b.y }));
    return result.polys.map((p) => ({ outer: move(p.outer), holes: p.holes.map(move) }));
  }, [result]);

  const stem = (loaded?.name ?? "cut-path").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-");

  const exportSvg = async () => {
    const png = await renderPng();
    if (!png) return;
    const dataUri = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.readAsDataURL(png.blob);
    });
    const svg = toSvg({
      polys: shifted(),
      w_mm: png.w_mm,
      h_mm: png.h_mm,
      name: stem,
      artworkDataUri: dataUri,
    });
    download(new Blob([svg], { type: "image/svg+xml" }), `${stem}-cut.svg`);
  };

  const exportPdf = async (registrationMarks: boolean) => {
    const png = await renderPng();
    if (!png) return;
    const bytes = await toPdf({
      polys: shifted(),
      w_mm: png.w_mm,
      h_mm: png.h_mm,
      name: stem,
      registrationMarks,
      artworkPng: new Uint8Array(await png.blob.arrayBuffer()),
    });
    download(new Blob([bytes as BlobPart], { type: "application/pdf" }), `${stem}-cut${registrationMarks ? "-silhouette" : ""}.pdf`);
  };

  const exportPng = async () => {
    const png = await renderPng();
    if (png) download(png.blob, `${stem}-cut.png`);
  };

  const patch = (p: Partial<CutPathSettings>) => setS((prev) => ({ ...prev, ...p }));
  // Only one of the two mask controls is ever doing anything: a file with real
  // transparency is thresholded on alpha, everything else is flood filled. The
  // idle one is greyed out rather than left to look broken.
  const usingAlpha = result?.stats.source === "alpha";

  return (
    <>
      <main className="stage cutpath-stage">
        {!loaded ? (
          <div
            className={`dropzone big${over ? " over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void open(e.dataTransfer.files);
            }}
          >
            <h3>Drop a sticker in</h3>
            <p>
              An AI-generated sticker arrives with its white border painted into the
              pixels — it wobbles, it is soft, and there is no geometry behind it for a
              plotter to follow.
            </p>
            <p>
              So this does not try to clean that edge. It finds the artwork proper,
              throws the fake border away, and builds a fresh one with a real vector cut
              path.
            </p>
          </div>
        ) : (
          <div className="cutpath-pair">
            <figure>
              <canvas ref={sourceRef} />
              <figcaption>
                Artwork{showMask ? " · magenta is what will be traced" : ""}
              </figcaption>
            </figure>
            <figure>
              <canvas ref={resultRef} />
              <figcaption>Result · cyan is the cut path</figcaption>
            </figure>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => void open(e.target.files)}
        />
        {loaded && (
          <p className="readout">
            {result
              ? `${result.stats.stickers} sticker${result.stats.stickers === 1 ? "" : "s"} found · ${result.stats.nodes} nodes · ${result.stats.w_mm.toFixed(1)} × ${result.stats.h_mm.toFixed(1)} mm${
                  // The gap against what the border needs. Shown as a pair
                  // because neither number means anything alone, and together
                  // they are the whole of why a sheet welds into one path.
                  Number.isFinite(result.stats.gap_mm)
                    ? ` · ${result.stats.gap_mm.toFixed(1)} mm apart, ${result.stats.clearance_mm.toFixed(1)} mm needed`
                    : ""
                }${busy ? " · working…" : ` · ${result.ms} ms`}`
              : "Tracing…"}
          </p>
        )}
      </main>

      <aside className="rail right">
        <section>
          <h2>Artwork</h2>
          {loaded ? (
            <>
              <div className="report">
                <div>{loaded.name}</div>
                <div>
                  <b>{loaded.full.w}</b> x <b>{loaded.full.h}</b> px
                  {loaded.work.w !== loaded.full.w && (
                    <> · previewing at {loaded.work.w} px</>
                  )}
                </div>
              </div>
              <button
                className="ghost"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => fileRef.current?.click()}
              >
                Open a different sticker
              </button>
            </>
          ) : (
            <p className="hint">Nothing loaded yet.</p>
          )}
        </section>

        {loaded && (
          <>
            <section>
              <h2>Finished size</h2>
              <div className="field">
                <span>
                  <span>Width</span>
                  <span>mm</span>
                </span>
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  value={s.width_mm}
                  onChange={(e) => patch({ width_mm: Number(e.target.value) || 1 })}
                  aria-label="Finished width in millimetres"
                />
              </div>
              <p className="hint">
                Set, not inferred. Everything downstream — the border, the blade radius,
                the exported document — is exact in millimetres because of this number.
              </p>
            </section>

            <section>
              <h2>Trace</h2>
              {!usingAlpha && (
                <div className="field">
                  <span>
                    <span>How to find the artwork</span>
                  </span>
                  <div className="seg">
                    {(["paper", "ink"] as const).map((r) => (
                      <button
                        key={r}
                        className={s.route === r ? "active" : ""}
                        onClick={() => patch({ route: r })}
                        title={
                          r === "paper"
                            ? "Flood fill inward from the corners. Right whenever the background is a flat colour the artwork does not share."
                            : "Mask what is darker than the local paper or enclosed by a drawn outline. The one that survives pale artwork on pale paper."
                        }
                      >
                        {r === "paper" ? "Paper" : "Ink"}
                      </button>
                    ))}
                  </div>
                  <p className="hint">
                    {s.route === "paper"
                      ? "Floods in from the corners. Fails when the artwork shares a tone with the paper — cream fur on cream paper — because no tolerance separates them."
                      : "Reads drawn outlines instead of colour, so pale artwork survives by being enclosed rather than by being dark. Also divides out uneven paper first."}
                  </p>
                </div>
              )}

              {!usingAlpha && s.route === "paper" && (
                <Slider
                  label="Background tolerance"
                  value={Math.round(s.backgroundTolerance * 100)}
                  min={0}
                  max={60}
                  step={1}
                  unit="%"
                  onChange={(v) => patch({ backgroundTolerance: v / 100 })}
                  hint="Raise it until the painted-on border stops being magenta. That is the control that strips it."
                />
              )}

              {!usingAlpha && s.route === "ink" && (
                <>
                  <Slider
                    label="Ink threshold"
                    value={Math.round(s.inkThreshold * 100)}
                    min={2}
                    max={50}
                    step={1}
                    unit="%"
                    onChange={(v) => patch({ inkThreshold: v / 100 })}
                    hint="How much darker than the surrounding paper still counts as artwork."
                  />
                  <Slider
                    label="Edge sensitivity"
                    value={Math.round(s.edgeSensitivity * 100)}
                    min={1}
                    max={30}
                    step={1}
                    unit="%"
                    onChange={(v) => patch({ edgeSensitivity: v / 100 })}
                    hint="How strong a tonal step counts as a drawn outline. Lower it if paper texture is registering as ink; raise it if faint lines are being missed."
                  />
                </>
              )}

              {usingAlpha && (
                <Slider
                  label="Edge threshold"
                  value={Math.round(s.edgeThreshold * 100)}
                  min={20}
                  max={80}
                  step={1}
                  unit="%"
                  onChange={(v) => patch({ edgeThreshold: v / 100 })}
                  hint="Feathered alpha moves the boundary, which is why this is a control and not a constant."
                />
              )}
              <Slider
                label="Smoothing"
                value={s.smoothing}
                min={0}
                max={5}
                step={1}
                unit=" px"
                onChange={(v) => patch({ smoothing: v })}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.keepHoles}
                  onChange={(e) => patch({ keepHoles: e.target.checked })}
                />
                Keep holes
              </label>
              <p className="hint">
                Off by default: stickers are cut on their outline, so you almost never
                want the hole in a donut cut out.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showMask}
                  onChange={(e) => setShowMask(e.target.checked)}
                />
                Show what will be traced
              </label>
            </section>

            <section>
              <h2>Cut</h2>
              <Slider
                label="Border"
                value={s.border_mm}
                min={-1}
                max={5}
                step={0.1}
                unit=" mm"
                onChange={(v) => patch({ border_mm: v })}
                hint="+2 mm is the classic white sticker border. 0 cuts on the artwork edge."
              />
              <button
                className="ghost"
                style={{ width: "100%" }}
                onClick={() => patch({ border_mm: PHOTO_BORDER_MM })}
              >
                Use {PHOTO_BORDER_MM} mm for a photo
              </button>
              <p className="hint">
                A slightly negative border cuts just inside the artwork, so no white
                fringe shows if the registration drifts.
              </p>
              <Slider
                label="Blade radius"
                value={s.bladeRadius_mm}
                min={0}
                max={2}
                step={0.1}
                unit=" mm"
                onChange={(v) => patch({ bladeRadius_mm: v })}
                hint="A blade cannot turn tighter than this, so anything tighter is removed before it tears. Raise to 1.5 mm for thick or laminated stock."
              />
              <div className="field">
                <span>
                  <span>Border colour</span>
                  <span>{borderColour}</span>
                </span>
                <input
                  type="color"
                  value={borderColour}
                  onChange={(e) => setBorderColour(e.target.value)}
                  aria-label="Border colour"
                />
              </div>
            </section>

            <section>
              <h2>Export</h2>
              <button className="primary" style={{ width: "100%" }} onClick={() => void exportSvg()}>
                SVG — artwork + cut layer
              </button>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="grow" onClick={() => void exportPng()}>
                  PNG for Cricut
                </button>
                <button className="grow" onClick={() => void exportPdf(false)}>
                  PDF trim guide
                </button>
              </div>
              <button
                style={{ width: "100%", marginTop: 6 }}
                onClick={() => void exportPdf(true)}
              >
                PDF with Silhouette marks
              </button>
              <p className="hint warn">
                The Silhouette registration marks follow the published layout but have not
                been verified against a real cut. Test one sheet before trusting them.
              </p>
              <p className="hint">
                The PNG bakes the path as the alpha boundary, which is what Design Space
                regenerates its contours from.
              </p>
            </section>

            {result && result.stats.warnings.length > 0 && (
              <section>
                <h2>Worth knowing</h2>
                {result.stats.warnings.map((w) => (
                  <p key={w} className="hint warn">
                    {w}
                  </p>
                ))}
              </section>
            )}
            {error && <p className="hint warn">{error}</p>}
          </>
        )}
      </aside>
    </>
  );
}
