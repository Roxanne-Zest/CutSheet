import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Asset,
  OutputSettings,
  Placement,
  Project,
  Slot,
  SlotShape,
  Spread,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import {
  FORMATS,
  formatById,
  templateById,
  templatesForFormat,
} from "./data/templates";
import {
  addQuarter,
  fillCrop,
  normalizeCrop,
  orientedSize,
  remapCropQuarter,
} from "./lib/geometry";
import type { CropContext } from "./lib/geometry";
import { buildPrintItems, resolveShape } from "./lib/printItems";
import { dropCount, formatChangeDrops, remapTemplate } from "./lib/layoutChange";
import { generatePdf, packProject } from "./lib/pdf";
import { loadSource, readImageSize } from "./lib/raster";
import type { Source } from "./lib/raster";
import * as db from "./lib/db";
import { uid } from "./lib/id";
import { PhotoTray } from "./components/PhotoTray";
import { LayoutGallery } from "./components/LayoutGallery";
import { SpreadView } from "./components/SpreadView";
import { Inspector } from "./components/Inspector";
import { SheetPreview } from "./components/SheetPreview";

type ImageSize = { w_px: number; h_px: number };

const newProject = (): Project => ({
  id: uid("prj"),
  name: "My journal",
  formatId: "a5",
  spreads: [],
  settings: { ...DEFAULT_SETTINGS },
  updatedAt: Date.now(),
});

/**
 * Crop maths only needs the photo's pixel dimensions, which the Asset already
 * carries. Keeping it off the decoded bitmap means a photo can be placed and
 * cropped the instant it is added, before its ImageBitmap is ready.
 */
const cropContextFor = (
  placement: Placement,
  size: ImageSize,
  slot: Slot,
): CropContext => {
  const o = orientedSize(size.w_px, size.h_px, placement.rotation);
  return {
    iw: o.w,
    ih: o.h,
    aspect: slot.w_mm / slot.h_mm,
    straighten_deg: placement.straighten_deg,
  };
};

/** A layout or format change that would discard photos, held for confirmation. */
type PendingChange =
  | { kind: "template"; templateId: string; name: string; drops: number }
  | { kind: "format"; formatId: string; name: string; drops: number };

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const [spreadId, setSpreadId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * Picking a layout adds a spread unless you have deliberately switched to
   * change mode. Re-flowing a spread can throw photos away, so it is never
   * the thing a stray click does.
   */
  const [galleryMode, setGalleryMode] = useState<"add" | "change">("add");
  const [pending, setPending] = useState<PendingChange | null>(null);
  const saveTimer = useRef<number | null>(null);

  // ---- load
  useEffect(() => {
    void (async () => {
      const [projects, stored] = await Promise.all([db.loadProjects(), db.loadAssets()]);
      setAssets(stored);
      const loaded = projects[0] ?? newProject();
      // Older saves may predate a setting; fill the gaps.
      loaded.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
      setProject(loaded);
      setSpreadId(loaded.spreads[0]?.id ?? null);
    })();
  }, []);

  // ---- decode photos once each
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map(sources);
      let changed = false;
      for (const a of assets) {
        if (next.has(a.id)) continue;
        try {
          next.set(a.id, await loadSource(a.blob));
          changed = true;
        } catch {
          // A photo we cannot decode simply stays unavailable.
        }
      }
      if (changed && !cancelled) setSources(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  // ---- autosave
  useEffect(() => {
    if (!project) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void db.saveProject(project);
    }, 400);
  }, [project]);

  /** Pixel dimensions by asset id — available as soon as a photo is added. */
  const dims = useMemo(() => {
    const out = new Map<string, ImageSize>();
    for (const a of assets) out.set(a.id, { w_px: a.w_px, h_px: a.h_px });
    return out;
  }, [assets]);

  const format = project ? formatById(project.formatId) : undefined;
  const templates = useMemo(
    () => (project ? templatesForFormat(project.formatId) : []),
    [project],
  );
  const spread = project?.spreads.find((s) => s.id === spreadId) ?? null;
  const template = spread ? templateById(spread.templateId) : undefined;

  const shapeOf = useCallback(
    (slot: Slot, placement: Placement | undefined): SlotShape =>
      project ? resolveShape(slot, placement, project.settings) : slot.shape,
    [project],
  );

  // ---- crops are re-normalised whenever the slot they sit in changes shape
  useEffect(() => {
    if (!project || dims.size === 0) return;
    let dirty = false;
    const spreads = project.spreads.map((sp) => {
      const t = templateById(sp.templateId);
      if (!t) return sp;
      const placements = sp.placements.map((p) => {
        const slot = t.slots.find((s) => s.id === p.slotId);
        const size = dims.get(p.assetId);
        if (!slot || !size) return p;
        const ctx = cropContextFor(p, size, slot);
        const fixed = normalizeCrop(p.crop, ctx);
        const drifted =
          Math.abs(fixed.x - p.crop.x) > 1e-9 ||
          Math.abs(fixed.y - p.crop.y) > 1e-9 ||
          Math.abs(fixed.w - p.crop.w) > 1e-9 ||
          Math.abs(fixed.h - p.crop.h) > 1e-9;
        if (!drifted) return p;
        dirty = true;
        return { ...p, crop: fixed };
      });
      return dirty ? { ...sp, placements } : sp;
    });
    if (dirty) setProject({ ...project, spreads });
  }, [project, dims]);

  // Change mode is deliberate and transient — never carried to another spread.
  useEffect(() => {
    setGalleryMode("add");
    setPending(null);
  }, [spreadId]);

  const items = useMemo(() => (project ? buildPrintItems(project) : []), [project]);

  const packed = useMemo(
    () =>
      project
        ? packProject(
            items,
            project.settings.gap_mm,
            project.settings.bleed_mm,
            project.settings.allowRotate,
          ).result
        : null,
    [items, project],
  );

  /** P-IDs for the spread on screen, so the editor agrees with the plan page. */
  const labelsForSpread = useMemo(() => {
    const out = new Map<string, string>();
    if (!spread) return out;
    for (const i of items) {
      if (i.fromSpread === spread.id) out.set(i.fromSlot, i.label);
    }
    return out;
  }, [items, spread]);

  /** Biggest slot each photo has to fill anywhere, for the tray's dot. */
  const worstSlot = useMemo(() => {
    const out = new Map<string, { w: number; h: number }>();
    for (const i of items) {
      const cur = out.get(i.assetId);
      if (!cur || i.w_mm * i.h_mm > cur.w * cur.h) {
        out.set(i.assetId, { w: i.w_mm, h: i.h_mm });
      }
    }
    return out;
  }, [items]);

  // ---- mutations
  const patchProject = (patch: Partial<Project>) =>
    setProject((p) => (p ? { ...p, ...patch } : p));

  const patchSettings = (patch: Partial<OutputSettings>) =>
    setProject((p) => (p ? { ...p, settings: { ...p.settings, ...patch } } : p));

  const patchSpread = (id: string, fn: (s: Spread) => Spread) =>
    setProject((p) =>
      p ? { ...p, spreads: p.spreads.map((s) => (s.id === id ? fn(s) : s)) } : p,
    );

  const patchPlacement = (
    targetSlotId: string,
    fn: (p: Placement) => Placement,
  ) => {
    if (!spread) return;
    patchSpread(spread.id, (s) => ({
      ...s,
      placements: s.placements.map((p) => (p.slotId === targetSlotId ? fn(p) : p)),
    }));
  };

  const addSpread = (templateId: string) => {
    const s: Spread = { id: uid("spr"), templateId, placements: [] };
    setProject((p) => (p ? { ...p, spreads: [...p.spreads, s] } : p));
    setSpreadId(s.id);
    setSlotId(null);
  };

  /** Re-flow the current spread. Only reachable from change mode. */
  const applySpreadTemplate = (templateId: string) => {
    if (!spread) return;
    const next = templateById(templateId);
    if (!next) return;
    patchSpread(spread.id, (s) => ({
      ...s,
      templateId,
      // Keep whatever still has a home in the new layout.
      placements: s.placements.filter((p) => next.slots.some((x) => x.id === p.slotId)),
    }));
    setSlotId(null);
    setPending(null);
    setGalleryMode("add");
  };

  /** Change mode: ask first if photos would be discarded, otherwise just do it. */
  const requestSpreadTemplate = (templateId: string) => {
    if (!spread) return;
    const next = templateById(templateId);
    if (!next || next.id === spread.templateId) return;
    const drops = dropCount(spread.placements, next);
    if (drops > 0) {
      setPending({ kind: "template", templateId, name: next.name, drops });
      return;
    }
    applySpreadTemplate(templateId);
  };

  const removeSpread = (id: string) => {
    setProject((p) => (p ? { ...p, spreads: p.spreads.filter((s) => s.id !== id) } : p));
    if (spreadId === id) setSpreadId(null);
  };

  const applyFormat = (formatId: string) => {
    setProject((p) => {
      if (!p) return p;
      // Carry each spread to the closest layout the new format offers.
      const spreads = p.spreads.map((s) => {
        const current = templateById(s.templateId);
        const target = current ? remapTemplate(current, formatId) : undefined;
        if (!target) return s;
        return {
          ...s,
          templateId: target.id,
          placements: s.placements.filter((pl) =>
            target.slots.some((x) => x.id === pl.slotId),
          ),
        };
      });
      return { ...p, formatId, spreads };
    });
    setSlotId(null);
    setPending(null);
    setGalleryMode("add");
  };

  const requestFormat = (formatId: string) => {
    if (!project || formatId === project.formatId) return;
    const drops = formatChangeDrops(project.spreads, formatId, templateById);
    if (drops > 0) {
      setPending({
        kind: "format",
        formatId,
        name: formatById(formatId)?.name ?? formatId,
        drops,
      });
      return;
    }
    applyFormat(formatId);
  };

  const placeAsset = (targetSlotId: string, targetAssetId: string) => {
    if (!spread || !template) return;
    const slot = template.slots.find((s) => s.id === targetSlotId);
    const size = dims.get(targetAssetId);
    if (!slot || !size) return;

    const base: Placement = {
      slotId: targetSlotId,
      assetId: targetAssetId,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      rotation: 0,
      straighten_deg: 0,
      copies: 1,
    };
    // Crop-to-fill on drop: any aspect ratio fills its slot.
    base.crop = fillCrop(cropContextFor(base, size, slot));

    patchSpread(spread.id, (s) => ({
      ...s,
      placements: [
        ...s.placements.filter((p) => p.slotId !== targetSlotId),
        { ...base, shape: s.placements.find((p) => p.slotId === targetSlotId)?.shape },
      ],
    }));
    setSlotId(targetSlotId);
  };

  const rotatePlacement = (turns: number) => {
    if (!slotId || !template) return;
    const slot = template.slots.find((s) => s.id === slotId);
    if (!slot) return;
    patchPlacement(slotId, (p) => {
      const size = dims.get(p.assetId);
      if (!size) return p;
      const rotation = addQuarter(p.rotation, turns);
      const moved = { ...p, rotation, crop: remapCropQuarter(p.crop, turns) };
      return { ...moved, crop: normalizeCrop(moved.crop, cropContextFor(moved, size, slot)) };
    });
  };

  const changePlacement = (patch: Partial<Placement>) => {
    if (!slotId || !template) return;
    const slot = template.slots.find((s) => s.id === slotId);
    if (!slot) return;
    patchPlacement(slotId, (p) => {
      const merged = { ...p, ...patch };
      const size = dims.get(merged.assetId);
      if (!size) return merged;
      // Straighten changes the largest crop that fits, so re-check the bounds.
      return { ...merged, crop: normalizeCrop(merged.crop, cropContextFor(merged, size, slot)) };
    });
  };

  const clearSlot = () => {
    if (!spread || !slotId) return;
    patchSpread(spread.id, (s) => ({
      ...s,
      placements: s.placements.filter((p) => p.slotId !== slotId),
    }));
  };

  const addPhotos = async (files: FileList) => {
    const added: Asset[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const size = await readImageSize(file);
        const asset: Asset = {
          id: uid("ast"),
          name: file.name,
          type: file.type,
          blob: file,
          ...size,
        };
        await db.saveAsset(asset);
        added.push(asset);
      } catch {
        setError(`Could not read ${file.name}. Is it a JPEG or PNG?`);
      }
    }
    if (added.length) setAssets((a) => [...a, ...added]);
  };

  const removePhoto = async (id: string) => {
    await db.deleteAsset(id);
    setAssets((a) => a.filter((x) => x.id !== id));
    setSources((s) => {
      const next = new Map(s);
      next.delete(id);
      return next;
    });
    setProject((p) =>
      p
        ? {
            ...p,
            spreads: p.spreads.map((s) => ({
              ...s,
              placements: s.placements.filter((pl) => pl.assetId !== id),
            })),
          }
        : p,
    );
  };

  const generate = async () => {
    if (!project) return;
    setError(null);
    setBusy({ done: 0, total: 1, label: "Starting" });
    try {
      const res = await generatePdf({
        project,
        items,
        sources,
        onProgress: (done, total, label) => setBusy({ done, total, label }),
      });
      const blob = new Blob([res.bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(project.name || "cut-sheet").replace(/[^\w-]+/g, "-")}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      if (res.unplaceable.length) {
        setError(
          `${res.unplaceable.length} photo(s) are larger than one A4 sheet and were left out: ${res.unplaceable
            .map((i) => i.label)
            .join(", ")}.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the PDF.");
    } finally {
      setBusy(null);
    }
  };

  if (!project || !format) {
    return <div className="empty-state">Loading your projects&hellip;</div>;
  }

  const selectedSlot = template?.slots.find((s) => s.id === slotId);
  const selectedPlacement = spread?.placements.find((p) => p.slotId === slotId);
  const selectedSize = selectedPlacement ? dims.get(selectedPlacement.assetId) : undefined;

  // The stage scales the spread up to a comfortable size without going silly.
  const stageScale = Math.min(3.2, Math.max(1.4, 620 / format.page_h_mm));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Cut<span>Sheet</span></h1>
        <span className="tagline">
          Pick a template, drop photos in, print at 100%, guillotine, journal.
        </span>
        <span className="spacer" />
        <input
          type="text"
          value={project.name}
          onChange={(e) => patchProject({ name: e.target.value })}
          aria-label="Project name"
        />
        <button
          className="ghost"
          onClick={() => {
            const p = newProject();
            setProject(p);
            setSpreadId(null);
            setSlotId(null);
          }}
        >
          New project
        </button>
      </header>

      <aside className="rail">
        <section>
          <h2>Journal format</h2>
          <select value={project.formatId} onChange={(e) => requestFormat(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} — {f.page_w_mm} x {f.page_h_mm} mm
              </option>
            ))}
          </select>
        </section>

        <section>
          <h2>Layout</h2>

          {spread && (
            <div className="seg" style={{ marginBottom: 8 }}>
              <button
                className={galleryMode === "add" ? "active" : ""}
                onClick={() => {
                  setGalleryMode("add");
                  setPending(null);
                }}
                title="Picking a layout starts a new spread"
              >
                Add spread
              </button>
              <button
                className={galleryMode === "change" ? "active warn" : ""}
                onClick={() => setGalleryMode("change")}
                title="Picking a layout re-flows the spread you are on"
              >
                Change spread {project.spreads.indexOf(spread) + 1}
              </button>
            </div>
          )}

          <LayoutGallery
            templates={templates}
            format={format}
            activeId={galleryMode === "change" ? spread?.templateId : undefined}
            mode={spread ? galleryMode : "add"}
            onPick={(id) =>
              spread && galleryMode === "change"
                ? requestSpreadTemplate(id)
                : addSpread(id)
            }
          />

          {pending && (
            <div className="confirm">
              <b>
                {pending.kind === "template"
                  ? `Change to ${pending.name}?`
                  : `Switch to ${pending.name}?`}
              </b>
              <p>
                {pending.kind === "template"
                  ? `That layout has fewer slots, so ${pending.drops} photo${
                      pending.drops === 1 ? "" : "s"
                    } would be removed from this spread.`
                  : `The closest layouts in that format are smaller, so ${
                      pending.drops
                    } photo${pending.drops === 1 ? "" : "s"} would be removed.`}
                {" "}
                Adding a spread instead keeps everything.
              </p>
              <div className="row">
                <button
                  className="grow danger"
                  onClick={() =>
                    pending.kind === "template"
                      ? applySpreadTemplate(pending.templateId)
                      : applyFormat(pending.formatId)
                  }
                >
                  Remove {pending.drops} and change
                </button>
                <button className="grow" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <p className="hint">
            {!spread
              ? "Pick a layout to start your first spread."
              : galleryMode === "add"
                ? "Picking a layout adds a new spread. Your current spread is untouched."
                : "Picking a layout re-flows spread " +
                  (project.spreads.indexOf(spread) + 1) +
                  ". Photos with no slot to land in are removed."}
          </p>
        </section>

        <section>
          <h2>Photos</h2>
          <PhotoTray
            assets={assets}
            selectedId={assetId}
            worstSlotMm={worstSlot}
            onAdd={(f) => void addPhotos(f)}
            onSelect={setAssetId}
            onRemove={(id) => void removePhoto(id)}
          />
        </section>
      </aside>

      <main className="stage">
        {!spread || !template ? (
          <div className="empty-state">
            <h3>No spread yet</h3>
            Pick a layout on the left. You own the geometry — every slot is a fixed
            size in millimetres, so the PDF knows exactly how big each photo has to
            print.
          </div>
        ) : (
          <>
            <div className="spread-wrap">
              <SpreadView
                spread={spread}
                template={template}
                format={format}
                scale={stageScale}
                sources={sources}
                selectedSlotId={slotId}
                labels={labelsForSpread}
                shapeOf={shapeOf}
                onSelectSlot={(id) => {
                  setSlotId(id);
                  if (assetId) {
                    placeAsset(id, assetId);
                    setAssetId(null);
                  }
                }}
                onDropAsset={placeAsset}
                onCropChange={(id, crop) => patchPlacement(id, (p) => ({ ...p, crop }))}
              />
              <div className="row">
                <span className="spread-meta">
                  Spread {project.spreads.indexOf(spread) + 1} of {project.spreads.length}
                  {" · "}
                  {format.name} {format.page_w_mm} x {format.page_h_mm} mm · {template.name} ·{" "}
                  {template.slots.length} slot{template.slots.length === 1 ? "" : "s"}
                </span>
                <button
                  className="ghost danger"
                  onClick={() => removeSpread(spread.id)}
                  title="Delete this spread"
                >
                  Delete spread
                </button>
              </div>
            </div>

            {project.spreads.length > 1 && (
              <div className="strip">
                {project.spreads.map((s, i) => {
                  const t = templateById(s.templateId);
                  const f = t ? formatById(t.formatId) : undefined;
                  if (!t || !f) return null;
                  return (
                    <button
                      key={s.id}
                      className={`strip-item${s.id === spread.id ? " active" : ""}`}
                      onClick={() => {
                        setSpreadId(s.id);
                        setSlotId(null);
                      }}
                    >
                      <SpreadView
                        spread={s}
                        template={t}
                        format={f}
                        scale={0.28}
                        sources={sources}
                        selectedSlotId={null}
                        labels={new Map()}
                        shapeOf={shapeOf}
                        onSelectSlot={() => {}}
                        onDropAsset={() => {}}
                        onCropChange={() => {}}
                        interactive={false}
                      />
                      <span className="caption">{i + 1}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      <aside className="rail right">
        {selectedSlot && selectedPlacement && selectedSize ? (
          <section>
            <h2>
              Slot {labelsForSpread.get(selectedSlot.id) ?? selectedSlot.id} —{" "}
              {selectedSlot.w_mm} x {selectedSlot.h_mm} mm
            </h2>
            <Inspector
              slot={selectedSlot}
              placement={selectedPlacement}
              imageSize={selectedSize}
              shape={shapeOf(selectedSlot, selectedPlacement)}
              onChange={changePlacement}
              onRotate={rotatePlacement}
              onClear={clearSlot}
            />
          </section>
        ) : (
          <section>
            <h2>Slot</h2>
            <p className="hint">
              Select a filled slot to pan, zoom, straighten and rotate. Drag inside a
              slot to pan; scroll to zoom.
            </p>
          </section>
        )}

        <section>
          <h2>Cut settings</h2>
          <div className="field">
            <span>
              <span>Gap between photos</span>
              <span>{project.settings.gap_mm} mm</span>
            </span>
            <div className="seg">
              {([0, 1, 2, 3] as const).map((g) => (
                <button
                  key={g}
                  className={project.settings.gap_mm === g ? "active" : ""}
                  onClick={() => patchSettings({ gap_mm: g })}
                >
                  {g}
                </button>
              ))}
            </div>
            <p className="hint">
              0 mm is the default: one cut gives two finished edges. Add a gap if you
              want white space or you are using scissors.
            </p>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.allowRotate}
              onChange={(e) => patchSettings({ allowRotate: e.target.checked })}
            />
            Rotate photos 90&deg; to pack tighter
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.cropMarks}
              onChange={(e) => patchSettings({ cropMarks: e.target.checked })}
            />
            Crop marks
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.idLabels}
              onChange={(e) => patchSettings({ idLabels: e.target.checked })}
            />
            P-ID labels
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.shapeGuides}
              onChange={(e) => patchSettings({ shapeGuides: e.target.checked })}
            />
            Cut guides for curved shapes
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.cornerStyle === "rounded"}
              onChange={(e) =>
                patchSettings({ cornerStyle: e.target.checked ? "rounded" : "square" })
              }
            />
            Rounded corners by default
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={project.settings.bleed_mm > 0}
              onChange={(e) => patchSettings({ bleed_mm: e.target.checked ? 0.3 : 0 })}
            />
            0.3 mm bleed
          </label>
          {project.settings.bleed_mm > 0 && (
            <p className="hint">
              Overprint needs its own cut per edge, so the gap widens to{" "}
              {2 * project.settings.bleed_mm + 1} mm and you cut twice per boundary.
              Test it on paper before trusting it.
            </p>
          )}
          {project.settings.gap_mm === 0 && project.settings.idLabels && (
            <p className="hint">
              With no gap the P-IDs sit in the corner of each photo. Add a 2 mm gap to
              move them into the gutter.
            </p>
          )}
        </section>

        <section>
          <h2>Output</h2>
          <div className="report">
            <div>
              <b>{items.reduce((n, i) => n + i.copies, 0)}</b> photo
              {items.reduce((n, i) => n + i.copies, 0) === 1 ? "" : "s"} ·{" "}
              <b>{project.spreads.length}</b> spread
              {project.spreads.length === 1 ? "" : "s"}
            </div>
            <div>
              <b>{packed?.sheets ?? 0}</b> A4 sheet
              {(packed?.sheets ?? 0) === 1 ? "" : "s"} ·{" "}
              <b>{((packed?.coverage ?? 0) * 100).toFixed(1)}%</b> coverage
            </div>
            {packed && packed.unplaceable.length > 0 && (
              <div className="warn">
                {packed.unplaceable.length} photo(s) are bigger than an A4 sheet.
              </div>
            )}
          </div>

          <button
            className="primary"
            style={{ width: "100%", marginTop: 10 }}
            disabled={items.length === 0 || busy !== null}
            onClick={() => void generate()}
          >
            {busy ? "Building PDF…" : "Generate A4 PDF"}
          </button>

          {busy && (
            <>
              <div className="progress">
                <i style={{ width: `${(busy.done / Math.max(1, busy.total)) * 100}%` }} />
              </div>
              <p className="hint">{busy.label}</p>
            </>
          )}
          {error && <p className="hint warn">{error}</p>}

          <p className="hint">
            Page 1 is the layout plan at actual size. Every sheet carries a 100 mm
            calibration ruler — measure it before you cut. If it is not exactly
            100.0 mm your printer scaled the page.
          </p>
        </section>

        {packed && packed.sheets > 0 && (
          <section>
            <h2>Sheets</h2>
            <SheetPreview
              result={packed}
              items={items}
              bleed_mm={project.settings.bleed_mm}
            />
          </section>
        )}
      </aside>
    </div>
  );
}
