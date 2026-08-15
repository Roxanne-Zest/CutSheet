import type { Format, Template } from "../types";

/**
 * Layout picker. Thumbnails share one mm-to-px scale across every format, so a
 * Passport TN really does look smaller than a Hobonichi Cousin.
 */
export function LayoutGallery({
  templates,
  format,
  activeId,
  onPick,
  /** px per mm, shared across all formats. */
  scale = 0.32,
}: {
  templates: Template[];
  format: Format;
  activeId?: string;
  onPick: (templateId: string) => void;
  scale?: number;
}) {
  return (
    <div className="layouts">
      {templates.map((t) => (
        <button
          key={t.id}
          className={`layout-btn${activeId === t.id ? " active" : ""}`}
          onClick={() => onPick(t.id)}
          title={`${t.name} — ${t.slots.length} slot${t.slots.length === 1 ? "" : "s"}`}
        >
          <span
            className="layout-thumb"
            style={{ width: format.w_mm * scale, height: format.h_mm * scale }}
          >
            {t.slots.map((s) => (
              <i
                key={s.id}
                style={{
                  left: s.x_mm * scale,
                  top: s.y_mm * scale,
                  width: s.w_mm * scale,
                  height: s.h_mm * scale,
                  transform: s.rotation_deg ? `rotate(${s.rotation_deg}deg)` : undefined,
                }}
              />
            ))}
          </span>
          <span className="caption">{t.name}</span>
        </button>
      ))}
    </div>
  );
}
