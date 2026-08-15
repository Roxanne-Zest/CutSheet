import type { Placement, Slot, SlotShape } from "../types";
import { MAX_ZOOM, orientedSize, setZoom, zoomOf } from "../lib/geometry";
import type { CropContext } from "../lib/geometry";
import { assessCrop, BAND_COLOR, BAND_LABEL } from "../lib/quality";

const SHAPES: SlotShape[] = ["rect", "rounded", "circle", "arch"];
const SHAPE_LABEL: Record<SlotShape, string> = {
  rect: "Square",
  rounded: "Round",
  circle: "Circle",
  arch: "Arch",
};

/** Pan, zoom, straighten, rotate 90. That is the whole learning curve. */
export function Inspector({
  slot,
  placement,
  imageSize,
  shape,
  onChange,
  onRotate,
  onClear,
}: {
  slot: Slot;
  placement: Placement;
  /** Source pixel dimensions — no decoded bitmap needed to do the maths. */
  imageSize: { w_px: number; h_px: number };
  shape: SlotShape;
  onChange: (patch: Partial<Placement>) => void;
  onRotate: (turns: number) => void;
  onClear: () => void;
}) {
  const oriented = orientedSize(imageSize.w_px, imageSize.h_px, placement.rotation);
  const ctx: CropContext = {
    iw: oriented.w,
    ih: oriented.h,
    aspect: slot.w_mm / slot.h_mm,
    straighten_deg: placement.straighten_deg,
  };
  const zoom = zoomOf(placement.crop, ctx);
  const quality = assessCrop(placement.crop, ctx, slot.w_mm, slot.h_mm);

  return (
    <>
      <div className="field">
        <span>
          <span>Zoom</span>
          <span>{zoom.toFixed(2)}x</span>
        </span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) =>
            onChange({ crop: setZoom(placement.crop, ctx, Number(e.target.value)) })
          }
        />
      </div>

      <div className="field">
        <span>
          <span>Straighten</span>
          <span>{placement.straighten_deg.toFixed(1)}&deg;</span>
        </span>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.1}
          value={placement.straighten_deg}
          onChange={(e) => onChange({ straighten_deg: Number(e.target.value) })}
        />
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <button className="grow" onClick={() => onRotate(-1)} title="Rotate left">
          &#8630; 90&deg;
        </button>
        <button className="grow" onClick={() => onRotate(1)} title="Rotate right">
          90&deg; &#8631;
        </button>
        <button
          className="grow"
          onClick={() => onChange({ straighten_deg: 0 })}
          disabled={placement.straighten_deg === 0}
        >
          Level
        </button>
      </div>

      <div className="field">
        <span><span>Copies</span></span>
        <div className="seg">
          {([1, 2, 3, 4] as const).map((n) => (
            <button
              key={n}
              className={placement.copies === n ? "active" : ""}
              onClick={() => onChange({ copies: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span><span>Shape</span></span>
        <div className="seg">
          {SHAPES.map((s) => (
            <button
              key={s}
              className={shape === s ? "active" : ""}
              onClick={() => onChange({ shape: s })}
              title={
                s === "rect"
                  ? "Square corners — one guillotine cut per edge"
                  : "Cut the curve by hand after trimming the rectangle"
              }
            >
              {SHAPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="quality" style={{ marginBottom: 10 }}>
        <div className="band">
          <i style={{ background: BAND_COLOR[quality.band] }} />
          {Math.round(quality.dpi)} dpi
        </div>
        <div style={{ color: "var(--muted)" }}>
          {BAND_LABEL[quality.band]}
          <br />
          Slot needs {quality.requiredPx.w} x {quality.requiredPx.h} px, crop gives{" "}
          {quality.actualPx.w} x {quality.actualPx.h}.
          {quality.band === "red" && " Printing anyway is your call."}
        </div>
      </div>

      <button className="danger" onClick={onClear} style={{ width: "100%" }}>
        Clear slot
      </button>
    </>
  );
}
