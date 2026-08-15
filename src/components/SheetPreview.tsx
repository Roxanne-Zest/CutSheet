import type { PrintItem } from "../types";
import type { PackResult } from "../lib/packer";
import { A4 } from "../lib/units";
import { printedSize } from "../lib/printItems";

/** A quick look at how the packer filled the sheets, before you commit to paper. */
export function SheetPreview({
  result,
  items,
  bleed_mm,
  scale = 0.55,
}: {
  result: PackResult;
  items: PrintItem[];
  bleed_mm: number;
  scale?: number;
}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const sheets = Array.from({ length: result.sheets }, (_, i) => i + 1);

  return (
    <div className="row wrap" style={{ gap: 10 }}>
      {sheets.map((n) => (
        <div key={n} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <svg
            width={A4.w_mm * scale}
            height={A4.h_mm * scale}
            viewBox={`0 0 ${A4.w_mm} ${A4.h_mm}`}
            style={{ background: "var(--paper)", borderRadius: 2 }}
          >
            <rect
              x={result.area.x}
              y={result.area.y}
              width={result.area.w}
              height={result.area.h}
              fill="none"
              stroke="#d8d5cf"
              strokeWidth={0.4}
            />
            {result.placements
              .filter((p) => p.sheet === n)
              .map((p) => {
                const item = byId.get(p.itemId);
                if (!item) return null;
                const s = printedSize(item, bleed_mm);
                const w = p.rotated ? s.h : s.w;
                const h = p.rotated ? s.w : s.h;
                return (
                  <g key={`${p.itemId}-${p.copy}`}>
                    <rect
                      x={p.x_mm}
                      y={p.y_mm}
                      width={w}
                      height={h}
                      fill="#b9c4d1"
                      stroke="#5d6672"
                      strokeWidth={0.3}
                    />
                    {w > 16 && h > 10 && (
                      <text
                        x={p.x_mm + w / 2}
                        y={p.y_mm + h / 2 + 2.2}
                        textAnchor="middle"
                        fontSize={5}
                        fill="#2b3138"
                      >
                        {item.label}
                      </text>
                    )}
                  </g>
                );
              })}
            {/* the calibration ruler's home */}
            <rect
              x={5}
              y={A4.h_mm - 12}
              width={100}
              height={1.2}
              fill="#a9a49b"
            />
          </svg>
          <span className="caption" style={{ fontSize: 10, color: "var(--muted)" }}>
            Sheet {n}
          </span>
        </div>
      ))}
    </div>
  );
}
