import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "../types";
import { BAND_COLOR, BAND_LABEL, bandFor } from "../lib/quality";
import { MM_PER_INCH } from "../lib/units";

/**
 * The photo tray. Each thumbnail carries its quality dot, checked against the
 * largest slot the photo is currently sitting in — checked at drop, not at
 * generate.
 */
export function PhotoTray({
  assets,
  selectedId,
  worstSlotMm,
  onAdd,
  onSelect,
  onRemove,
}: {
  assets: Asset[];
  selectedId: string | null;
  /** Largest slot this asset fills anywhere in the project, in mm. */
  worstSlotMm: Map<string, { w: number; h: number }>;
  onAdd: (files: FileList) => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const next = new Map<string, string>();
    for (const a of assets) next.set(a.id, URL.createObjectURL(a.blob));
    setUrls(next);
    return () => {
      for (const u of next.values()) URL.revokeObjectURL(u);
    };
  }, [assets]);

  const bands = useMemo(() => {
    const out = new Map<string, ReturnType<typeof bandFor>>();
    for (const a of assets) {
      const slot = worstSlotMm.get(a.id);
      if (!slot) continue;
      const dpi = Math.min(
        (a.w_px * MM_PER_INCH) / slot.w,
        (a.h_px * MM_PER_INCH) / slot.h,
      );
      out.set(a.id, bandFor(dpi));
    }
    return out;
  }, [assets, worstSlotMm]);

  return (
    <>
      <div
        className={`dropzone${over ? " over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) onAdd(e.dataTransfer.files);
        }}
      >
        Drop photos here, or click to choose
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onAdd(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="tray">
        {assets.map((a) => {
          const band = bands.get(a.id);
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              className={`chip${selectedId === a.id ? " selected" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/cutsheet-asset", a.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onSelect(selectedId === a.id ? null : a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(selectedId === a.id ? null : a.id);
                }
              }}
              title={`${a.name} — ${a.w_px} x ${a.h_px} px${
                band ? `\n${BAND_LABEL[band]}` : ""
              }`}
            >
              {urls.get(a.id) && <img src={urls.get(a.id)} alt={a.name} />}
              {band && <span className="dot" style={{ background: BAND_COLOR[band] }} />}
              <span className="px">{a.w_px} x {a.h_px}</span>
              <button
                className="remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(a.id);
                }}
                title="Remove photo"
              >
                x
              </button>
            </div>
          );
        })}
      </div>

      {assets.length > 0 && (
        <p className="hint">
          Drag a photo onto a slot, or select one here and click a slot. The dot is
          resolution at that photo&rsquo;s largest slot: green is 300 dpi or better.
        </p>
      )}
    </>
  );
}
