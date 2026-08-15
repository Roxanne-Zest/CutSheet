import type { JournalFormat, Template } from "../types";

/**
 * Layout picker. Thumbnails share one mm-to-px scale across every format, so a
 * Passport TN really does look smaller than a Hobonichi Cousin.
 *
 * Picking a layout adds a spread by default. Re-flowing the spread you are on
 * is the deliberate action, because it can throw photos away.
 */
export function LayoutGallery({
  templates,
  format,
  activeId,
  mode,
  onPick,
  /** px per mm, shared across all formats. */
  scale = 0.32,
}: {
  templates: Template[];
  format: JournalFormat;
  activeId?: string;
  mode: "add" | "change";
  onPick: (templateId: string) => void;
  scale?: number;
}) {
  return (
    <div className={`layouts${mode === "change" ? " changing" : ""}`}>
      {templates.map((t) => {
        const filled = t.slots.length;
        return (
          <button
            key={t.id}
            className={`layout-btn${activeId === t.id ? " active" : ""}`}
            onClick={() => onPick(t.id)}
            title={`${t.name} — ${filled} slot${filled === 1 ? "" : "s"}\n${t.note}\n\n${
              mode === "change" ? "Re-flows this spread" : "Adds a new spread"
            }`}
          >
            <span
              className="layout-thumb"
              style={{
                width: format.page_w_mm * scale,
                height: format.page_h_mm * scale,
              }}
            >
              {t.slots.map((s) => (
                <i
                  key={s.id}
                  style={{
                    left: s.x_mm * scale,
                    top: s.y_mm * scale,
                    width: s.w_mm * scale,
                    height: s.h_mm * scale,
                    borderRadius:
                      s.shape === "circle"
                        ? "50%"
                        : s.shape === "rounded"
                          ? `${Math.min(s.w_mm, s.h_mm) * 0.09 * scale}px`
                          : s.shape === "arch"
                            ? `${(s.w_mm / 2) * scale}px ${(s.w_mm / 2) * scale}px 0 0`
                            : undefined,
                    transform: s.rotation_deg
                      ? `rotate(${s.rotation_deg}deg)`
                      : undefined,
                  }}
                />
              ))}
              <b className="slot-count">{filled}</b>
            </span>
            <span className="caption">{t.name}</span>
          </button>
        );
      })}
    </div>
  );
}
