import { useRef, useState } from "react";
import type { Format, Placement, Slot, Spread, Template } from "../types";
import type { Source } from "../lib/raster";
import { orientedSize, panBy, zoomBy } from "../lib/geometry";
import type { CropContext } from "../lib/geometry";
import { assessCrop, BAND_COLOR } from "../lib/quality";
import { SlotCanvas } from "./SlotCanvas";

/**
 * One spread, rendered at `scale` px per mm. Slots are drop targets; a filled
 * slot pans on drag and zooms on wheel.
 */

export type SpreadViewProps = {
  spread: Spread;
  template: Template;
  format: Format;
  scale: number;
  sources: Map<string, Source>;
  selectedSlotId: string | null;
  labels: Map<string, string>;
  shapeOf: (slot: Slot, placement: Placement | undefined) => Slot["shape"];
  onSelectSlot: (slotId: string) => void;
  onDropAsset: (slotId: string, assetId: string) => void;
  onCropChange: (slotId: string, crop: Placement["crop"]) => void;
  interactive?: boolean;
};

const cropContext = (
  placement: Placement,
  source: Source,
  slot: Slot,
): CropContext => {
  const { w, h } = orientedSize(source.w_px, source.h_px, placement.rotation);
  return {
    iw: w,
    ih: h,
    aspect: slot.w_mm / slot.h_mm,
    straighten_deg: placement.straighten_deg,
  };
};

export function SpreadView(props: SpreadViewProps) {
  const { spread, template, format, scale, sources, interactive = true } = props;
  const [dragOver, setDragOver] = useState<string | null>(null);
  const drag = useRef<{ slotId: string; x: number; y: number } | null>(null);

  return (
    <div
      className="spread"
      style={{ width: format.w_mm * scale, height: format.h_mm * scale }}
    >
      {template.slots.map((slot) => {
        const placement = spread.placements.find((p) => p.slotId === slot.id);
        const source = placement ? sources.get(placement.assetId) : undefined;
        const shape = props.shapeOf(slot, placement);
        const w = slot.w_mm * scale;
        const h = slot.h_mm * scale;

        const quality =
          placement && source
            ? assessCrop(
                placement.crop,
                cropContext(placement, source, slot),
                slot.w_mm,
                slot.h_mm,
              )
            : null;

        return (
          <div
            key={slot.id}
            className={[
              "slot",
              shape,
              source ? "filled" : "",
              props.selectedSlotId === slot.id ? "selected" : "",
              dragOver === slot.id ? "over" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left: slot.x_mm * scale,
              top: slot.y_mm * scale,
              width: w,
              height: h,
              transform: slot.rotation_deg ? `rotate(${slot.rotation_deg}deg)` : undefined,
            }}
            onClick={() => interactive && props.onSelectSlot(slot.id)}
            onDragOver={(e) => {
              if (!interactive) return;
              e.preventDefault();
              setDragOver(slot.id);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              if (!interactive) return;
              e.preventDefault();
              setDragOver(null);
              const assetId = e.dataTransfer.getData("text/cutsheet-asset");
              if (assetId) props.onDropAsset(slot.id, assetId);
            }}
            onPointerDown={(e) => {
              if (!interactive || !placement || !source) return;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              drag.current = { slotId: slot.id, x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.slotId !== slot.id || !placement || !source) return;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              if (dx === 0 && dy === 0) return;
              drag.current = { ...d, x: e.clientX, y: e.clientY };

              const ctx = cropContext(placement, source, slot);
              // Display axes follow the crop, so undo the straighten to get
              // back into image space before panning.
              const th = (placement.straighten_deg * Math.PI) / 180;
              const srcPerPx = (placement.crop.w * ctx.iw) / w;
              const ix = (dx * Math.cos(th) - dy * Math.sin(th)) * srcPerPx;
              const iy = (dx * Math.sin(th) + dy * Math.cos(th)) * srcPerPx;
              props.onCropChange(
                slot.id,
                panBy(placement.crop, ctx, -ix / ctx.iw, -iy / ctx.ih),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onWheel={(e) => {
              if (!interactive || !placement || !source) return;
              const ctx = cropContext(placement, source, slot);
              const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
              props.onCropChange(slot.id, zoomBy(placement.crop, ctx, factor));
            }}
          >
            {placement && source ? (
              <SlotCanvas
                source={source}
                crop={placement.crop}
                rotation={placement.rotation}
                straighten_deg={placement.straighten_deg}
                shape={shape}
                w_px={Math.round(w)}
                h_px={Math.round(h)}
              />
            ) : (
              // At thumbnail scale the text is unreadable, so leave the slot blank.
              interactive &&
              w > 40 && (
                <div className="empty-label">
                  <span>
                    {Math.round(slot.w_mm)} x {Math.round(slot.h_mm)} mm
                  </span>
                  {w > 54 && <span>drop a photo</span>}
                </div>
              )
            )}

            {interactive && props.labels.get(slot.id) && (
              <span className="pid">{props.labels.get(slot.id)}</span>
            )}
            {interactive && quality && (
              <span
                className="qdot"
                title={`${Math.round(quality.dpi)} dpi — needs ${quality.requiredPx.w} x ${quality.requiredPx.h} px`}
                style={{ background: BAND_COLOR[quality.band] }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
