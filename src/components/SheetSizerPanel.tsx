import { useMemo, useRef, useState } from "react";
import { MeasureCanvas } from "./MeasureCanvas";
import type { Line } from "./MeasureCanvas";
import { loadSheet, measurementFromDeclared } from "../lib/sheetSource";
import type { LoadedSheet } from "../lib/sheetSource";
import {
  dpiBand,
  effectiveDpi,
  errorPerPixel,
  mmPerPx,
  physicalSize,
  planOutput,
  printPercent,
} from "../lib/sheetSizer";
import type { OutputMode } from "../lib/sheetSizer";
import { generateSizerPdf } from "../lib/sizerPdf";
import { BAND_COLOR, BAND_LABEL } from "../lib/quality";
import { round } from "../lib/units";

/**
 * Feature B, end to end: drop a sheet in, drag a line across one sticker, say
 * what that sticker is supposed to be, download a PDF at true physical size.
 *
 * The point is that there is no iteration. You measure once and the arithmetic
 * does the rest, rather than printing, comparing by eye and adjusting.
 */

const download = (bytes: Uint8Array, name: string) => {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export function SheetSizerPanel() {
  const [sheet, setSheet] = useState<LoadedSheet | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [target, setTarget] = useState("12");
  const [mode, setMode] = useState<OutputMode>("single");
  const [ruler, setRuler] = useState(true);
  const [snap, setSnap] = useState(true);
  /** For a PDF, trust the size the file states rather than measuring it. */
  const [useDeclared, setUseDeclared] = useState(true);
  const [embeddedDpi, setEmbeddedDpi] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const open = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const loaded = await loadSheet(file);
      setSheet(loaded);
      setLine(null);
      // A new sheet is a new question; carrying "scale to fit" over from the
      // last one would silently un-true the next output.
      setMode("single");
      // A PDF states its own size, so start by trusting it. `target` is left
      // alone — it means the feature you measured, not the sheet.
      setUseDeclared(Boolean(loaded.declared));
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not open ${file.name}: ${e.message}`
          : `Could not open ${file.name}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const measured_px = line ? Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) : 0;
  const target_mm = Number(target);
  const usingDeclared = Boolean(sheet?.declared) && useDeclared;

  const measurement = useMemo(() => {
    if (!sheet) return null;
    if (usingDeclared && sheet.declared) {
      return measurementFromDeclared(sheet.declared, sheet.w_px);
    }
    if (measured_px < 1 || !Number.isFinite(target_mm) || target_mm <= 0) return null;
    return { measured_px, target_mm };
  }, [sheet, usingDeclared, measured_px, target_mm]);

  const scale = measurement ? mmPerPx(measurement) : 0;
  const size = sheet && scale > 0 ? physicalSize(sheet.w_px, sheet.h_px, scale) : null;
  /**
   * Resolution only bites on raster artwork. A PDF page is embedded as vector,
   * so the preview's own pixel count says nothing about how it will print.
   */
  const raster = sheet?.source.kind === "image";
  const dpi = raster && scale > 0 ? effectiveDpi(scale) : 0;
  const band = dpiBand(dpi);

  const plan = useMemo(
    () => (size ? planOutput(size.w_mm, size.h_mm, { mode }) : null),
    [size, mode],
  );

  const embedded = Number(embeddedDpi);
  const percent =
    scale > 0 && Number.isFinite(embedded) && embedded > 0
      ? printPercent(embedded, scale)
      : null;

  const generate = async () => {
    if (!sheet || !plan || !measurement) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await generateSizerPdf({
        source: sheet.source,
        plan,
        name: sheet.name.replace(/\.[^.]+$/, ""),
        ruler,
        measurement: usingDeclared ? undefined : measurement,
        dpi: raster ? dpi : undefined,
      });
      download(bytes, `${sheet.name.replace(/[^\w-]+/g, "-")}-true-size.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the PDF.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <main className="stage sizer-stage">
        {!sheet ? (
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
            <h3>Drop a sticker sheet in</h3>
            <p>
              PNG, JPEG or PDF. A pixel sheet has no physical size of its own — measure
              one sticker, say what it should be, and every other sticker on the sheet
              follows.
            </p>
            <p className="hint">A PDF already carries real units, so it usually needs no measuring at all.</p>
          </div>
        ) : (
          <MeasureCanvas
            bitmap={sheet.bitmap}
            w_px={sheet.w_px}
            h_px={sheet.h_px}
            line={line}
            onChange={setLine}
            snap={snap}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          style={{ display: "none" }}
          onChange={(e) => void open(e.target.files)}
        />
      </main>

      <aside className="rail right">
        <section>
          <h2>Sheet</h2>
          {sheet ? (
            <>
              <div className="report">
                <div>{sheet.name}</div>
                <div>
                  <b>{sheet.w_px}</b> x <b>{sheet.h_px}</b> px
                  {sheet.pages && sheet.pages > 1 ? ` · page 1 of ${sheet.pages}` : ""}
                </div>
                {sheet.declared && (
                  <div>
                    Declares <b>{round(sheet.declared.w_mm, 1)}</b> x{" "}
                    <b>{round(sheet.declared.h_mm, 1)}</b> mm, from {sheet.declared.from}.
                  </div>
                )}
              </div>
              <button
                className="ghost"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => fileRef.current?.click()}
              >
                Open a different sheet
              </button>
            </>
          ) : (
            <p className="hint">Nothing loaded yet.</p>
          )}
        </section>

        {sheet && (
          <>
            <section>
              <h2>Measure</h2>

              {sheet.declared && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={useDeclared}
                      onChange={(e) => setUseDeclared(e.target.checked)}
                    />
                    Trust the size this PDF declares
                  </label>
                  <p className="hint">
                    A PDF carries real units, so usually there is nothing to measure. Turn
                    this off if the export declares a nominal size rather than a real one —
                    then measure it like any other sheet.
                  </p>
                </>
              )}

              <fieldset className="plain" disabled={usingDeclared}>
                <p className="hint">
                  Drag across the widest part of one sticker, then type what it is supposed
                  to be. Measure across the <b>largest</b> feature you can find — the same
                  one-pixel slip costs half as much across a 25 mm circle as across a 12 mm
                  one.
                </p>

                <div className="field">
                  <span>
                    <span>That distance is</span>
                    <span>
                      {measured_px >= 1 ? `${Math.round(measured_px)} px` : "not measured"}
                    </span>
                  </span>
                  <div className="row">
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      aria-label="Real size of the measured feature, in millimetres"
                    />
                    <span className="unit">mm</span>
                  </div>
                </div>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={snap}
                    onChange={(e) => setSnap(e.target.checked)}
                  />
                  Snap to the edge when I let go
                </label>
              </fieldset>

              {!usingDeclared && line && measured_px >= 1 && (
                <div className="report">
                  <div>
                    measured <b>{Math.round(measured_px)}</b> px →{" "}
                    <b>{round(target_mm, 2)}</b> mm
                  </div>
                  <div>
                    one pixel out ={" "}
                    <b>{round(errorPerPixel(measured_px) * 100, 2)}%</b> across the whole
                    sheet
                  </div>
                </div>
              )}
            </section>

            <section>
              <h2>Result</h2>
              {size && plan ? (
                <>
                  <div className="report">
                    <div>
                      Sheet prints at <b>{round(size.w_mm, 1)}</b> x{" "}
                      <b>{round(size.h_mm, 1)}</b> mm
                    </div>
                    {raster ? (
                      <div>
                        <b>{Math.round(dpi)}</b> dpi effective
                      </div>
                    ) : (
                      <div>Vector — the PDF page is embedded, not resampled</div>
                    )}
                    {percent !== null && raster && (
                      <div>
                        Or print from Preview at <b>{round(percent, 1)}%</b>
                      </div>
                    )}
                  </div>

                  {raster && (
                    <div className="quality" style={{ marginTop: 8 }}>
                      <div className="band">
                        <i style={{ background: BAND_COLOR[band] }} />
                        {BAND_LABEL[band]}
                      </div>
                    </div>
                  )}

                  <div className="field" style={{ marginTop: 10 }}>
                    <span>
                      <span>If it does not fit A4</span>
                      <span>
                        {plan.sheets} sheet{plan.sheets === 1 ? "" : "s"}
                      </span>
                    </span>
                    <div className="seg">
                      {(["single", "tile", "fit"] as const).map((m) => (
                        <button
                          key={m}
                          className={mode === m ? (m === "fit" ? "active warn" : "active") : ""}
                          onClick={() => setMode(m)}
                          title={
                            m === "single"
                              ? "One sheet at true size"
                              : m === "tile"
                                ? `Tile across sheets with ${plan.overlap_mm} mm overlap, everything still true size`
                                : "Shrink to fit one sheet — the stickers will no longer be the size you measured"
                          }
                        >
                          {m === "single" ? "One sheet" : m === "tile" ? "Tile" : "Scale to fit"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {plan.warnings.map((w) => (
                    <p key={w} className={`hint${plan.mode === "fit" ? " warn" : ""}`}>
                      {w}
                    </p>
                  ))}

                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ruler}
                      onChange={(e) => setRuler(e.target.checked)}
                    />
                    Print a 100 mm rule on each sheet
                  </label>

                  {raster && (
                    <div className="field">
                      <span>
                        <span>File says it is (optional)</span>
                        <span>dpi</span>
                      </span>
                      <input
                        type="number"
                        value={embeddedDpi}
                        placeholder="e.g. 300"
                        onChange={(e) => setEmbeddedDpi(e.target.value)}
                        aria-label="Embedded dpi, if you know it"
                      />
                      <p className="hint">
                        Only needed if you would rather print from Preview or Photos than
                        from the PDF.
                      </p>
                    </div>
                  )}

                  <button
                    className="primary"
                    style={{ width: "100%" }}
                    disabled={busy}
                    onClick={() => void generate()}
                  >
                    {busy ? "Building PDF…" : `Download PDF at true size`}
                  </button>
                </>
              ) : (
                <p className="hint">
                  Drag a line across one sticker and say how wide it should be. The rest is
                  arithmetic.
                </p>
              )}
              {error && <p className="hint warn">{error}</p>}
            </section>

            <section>
              <h2>Then</h2>
              <p className="hint">
                Print at 100% / Actual Size with fit-to-page off, measure the 100 mm rule
                to confirm your printer behaved, and punch. Print the circle 0.5 mm larger
                than your punch — the reference card explains why.
              </p>
            </section>
          </>
        )}
      </aside>
    </>
  );
}
