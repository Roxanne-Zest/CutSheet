import { useMemo, useState } from "react";
import {
  CIRCLE_SIZES_MM,
  CUSTOM_ROW_COUNT,
  MAX_CUSTOM_MM,
  PUNCH_BLEED_MM,
  SQUARE_SIZES_MM,
  buildRefCardPlan,
  circleCaption,
  drawnDiameter,
  generateReferenceCard,
} from "../lib/refCard";
import { inchLabel } from "../lib/imperial";
import { round } from "../lib/units";

/**
 * Feature A — the printable scale reference card.
 *
 * Half a day of work that de-risks the printer for everything else in the app,
 * so it lives one click from the front door rather than behind the editor.
 */

/** Screen preview scale. Deliberately not 1:1 — a monitor cannot be trusted. */
const PREVIEW_PX_PER_MM = 1.5;

export function ReferenceCardPanel() {
  const [punchMode, setPunchMode] = useState(false);
  const [custom, setCustom] = useState("");
  const [row, setRow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diameter = Number(custom);
  const hasCustom = custom.trim() !== "" && Number.isFinite(diameter) && diameter > 0;

  const plan = useMemo(
    () =>
      buildRefCardPlan({
        punchMode,
        custom: hasCustom ? { diameter_mm: diameter, row } : undefined,
      }),
    [punchMode, hasCustom, diameter, row],
  );

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { bytes } = await generateReferenceCard({
        punchMode,
        custom: hasCustom ? { diameter_mm: diameter, row } : undefined,
      });
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = punchMode ? "scale-reference-card-punch.pdf" : "scale-reference-card.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the card.");
    } finally {
      setBusy(false);
    }
  };

  const customCaption = hasCustom
    ? circleCaption(Math.min(diameter, MAX_CUSTOM_MM), punchMode)
    : null;

  return (
    <>
      <main className="stage">
        <div className="card-preview" style={{ width: 210 * PREVIEW_PX_PER_MM, height: 297 * PREVIEW_PX_PER_MM }}>
          {plan.sections.map((s) => (
            <span
              key={s.title}
              className="card-section"
              style={{ left: 12 * PREVIEW_PX_PER_MM, top: (s.y_mm - 2.5) * PREVIEW_PX_PER_MM }}
            >
              {s.title}
            </span>
          ))}
          {plan.shapes.map((s, i) => {
            const w = s.kind === "circle" ? s.d_mm : s.s_mm;
            return (
              <i
                key={`${s.kind}-${s.caption}-${i}`}
                className={s.kind === "circle" ? "card-circle" : "card-square"}
                style={{
                  left: s.x_mm * PREVIEW_PX_PER_MM,
                  top: s.y_mm * PREVIEW_PX_PER_MM,
                  width: w * PREVIEW_PX_PER_MM,
                  height: w * PREVIEW_PX_PER_MM,
                }}
                title={s.caption}
              />
            );
          })}
          <span
            className="card-rule"
            style={{
              left: 12 * PREVIEW_PX_PER_MM,
              top: plan.rulerY_mm * PREVIEW_PX_PER_MM,
              width: 100 * PREVIEW_PX_PER_MM,
            }}
          />
        </div>
        <p className="hint" style={{ maxWidth: 380, textAlign: "center" }}>
          Preview only — your monitor has no idea how big a millimetre is. The printed
          card is the thing that is true to size.
        </p>
      </main>

      <aside className="rail right">
        <section>
          <h2>Scale reference card</h2>
          <p className="hint">
            One A4 page of shapes at known physical sizes. Print it once at 100%, keep it
            by the printer, and check any print against it. Circles at{" "}
            {CIRCLE_SIZES_MM.join(", ")} mm; squares at {SQUARE_SIZES_MM.join(", ")} mm; a
            100 mm rule and a 1 inch bar.
          </p>
        </section>

        <section>
          <h2>Punch size</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={punchMode}
              onChange={(e) => setPunchMode(e.target.checked)}
            />
            Label by punch size, add {PUNCH_BLEED_MM} mm bleed
          </label>
          <p className="hint">
            A {PUNCH_BLEED_MM} mm punch bleed is the difference between a clean sticker and
            a white rim. With this on, a circle labelled &ldquo;12 mm punch&rdquo; is
            physically {drawnDiameter(12, true)} mm — so the blade lands inside the ink
            even when you are slightly off centre.
          </p>
        </section>

        <section>
          <h2>Your own size</h2>
          <div className="field">
            <span>
              <span>Diameter</span>
              <span>{hasCustom ? `${round(Math.min(diameter, MAX_CUSTOM_MM), 2)} mm` : "—"}</span>
            </span>
            <div className="row">
              <input
                type="number"
                step="0.1"
                min="0.1"
                max={MAX_CUSTOM_MM}
                value={custom}
                placeholder="e.g. 13.5"
                onChange={(e) => setCustom(e.target.value)}
                aria-label="Custom circle diameter in millimetres"
              />
              <span className="unit">mm</span>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={row} onChange={(e) => setRow(e.target.checked)} />
            Repeat in a row of {CUSTOM_ROW_COUNT}
          </label>
          <p className="hint">
            A row lays across a sheet of stickers, so you can check a whole line at once
            rather than one circle at a time.
          </p>
          {customCaption && (
            <div className="report">
              <div>
                Will print as <b>{customCaption.caption}</b>
                {customCaption.sub ? ` (${customCaption.sub})` : ""}
              </div>
              {!punchMode && inchLabel(diameter) && (
                <div>
                  That is <b>{inchLabel(diameter)}</b> in imperial.
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <h2>Print it</h2>
          {plan.warnings.map((w) => (
            <p key={w} className="hint warn">
              {w}
            </p>
          ))}
          <button
            className="primary"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? "Building card…" : "Download reference card"}
          </button>
          {error && <p className="hint warn">{error}</p>}
          <p className="hint">
            Print at 100% / Actual Size with &ldquo;Fit to page&rdquo; off. Then measure the
            100 mm rule. If it is not 100 mm, your printer is scaling and nothing else in
            this app will come out the right size either.
          </p>
        </section>
      </aside>
    </>
  );
}
