import { useMemo, useState } from "react";
import type { Asset, Template } from "../types";
import { arrangeTrip, dayCount, DEFAULT_ARRANGE, orderForTrip } from "../lib/autoLayout";
import type { ArrangeOptions, ArrangeReport, TripPhoto } from "../lib/autoLayout";

/**
 * Arrange a trip.
 *
 * The plan is worked out as you change the options, not when you press the
 * button — so the button can say how many spreads you are about to get, and
 * you can talk yourself out of it before it happens. Nothing here is
 * irreversible either: the spreads it made are ordinary spreads, and Undo puts
 * the project back exactly as it was.
 */

const MAX_CHOICES = [2, 4, 6, 8] as const;

export type TripArrangerProps = {
  assets: Asset[];
  /** Assets already sitting in a slot somewhere, which are left alone. */
  placedIds: Set<string>;
  templates: Template[];
  formatName: string;
  existingSpreads: number;
  onArrange: (report: ArrangeReport, scope: "unplaced" | "all") => void;
  onUndo: () => void;
  canUndo: boolean;
};

const photoOf = (a: Asset): TripPhoto => ({
  id: a.id,
  name: a.name,
  w_px: a.w_px,
  h_px: a.h_px,
  takenAt: a.takenAt,
  timeSource: a.timeSource,
  thumb: a.thumb,
  sharpness: a.sharpness,
  contrast: a.contrast,
});

const ORDER_NOTE: Record<ArrangeReport["ordering"], string> = {
  "capture time": "In the order they were taken, read from the photos themselves.",
  "file date":
    "In file-date order — these photos carry no capture time, so this is when the files were last written. Check the first spread reads right.",
  "file name":
    "In file-name order — none of these photos carry a date, so there is nothing better to go on.",
};

export function TripArranger(props: TripArrangerProps) {
  const [options, setOptions] = useState<ArrangeOptions>(DEFAULT_ARRANGE);
  const [scope, setScope] = useState<"unplaced" | "all">("unplaced");
  const [confirming, setConfirming] = useState(false);

  const photos = useMemo(() => {
    const all = props.assets.map(photoOf);
    return scope === "all" ? all : all.filter((p) => !props.placedIds.has(p.id));
  }, [props.assets, props.placedIds, scope]);

  // Cheap enough to re-plan on every keystroke, so the button can be honest
  // about what it is going to do.
  const report = useMemo(
    () => arrangeTrip(photos, props.templates, options),
    [photos, props.templates, options],
  );

  const days = useMemo(() => dayCount(photos), [photos]);
  const first = useMemo(() => orderForTrip(photos)[0], [photos]);

  const set = (patch: Partial<ArrangeOptions>) => {
    setOptions((o) => ({ ...o, ...patch }));
    setConfirming(false);
  };

  const replaces = scope === "all" && props.existingSpreads > 0;

  return (
    <>
      {props.assets.length === 0 ? (
        <p className="hint">
          Add a trip&rsquo;s photos above and this will put them in the order they were
          taken, break them where the days break, and choose a layout for each spread.
        </p>
      ) : (
        <>
          <div className="seg" style={{ marginBottom: 8 }}>
            <button
              className={scope === "unplaced" ? "active" : ""}
              onClick={() => {
                setScope("unplaced");
                setConfirming(false);
              }}
              title="Only photos not already in a spread"
            >
              New photos
            </button>
            <button
              className={scope === "all" ? "active" : ""}
              onClick={() => {
                setScope("all");
                setConfirming(false);
              }}
              title="Every photo, replacing the spreads you have"
            >
              Start over
            </button>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={options.newSpreadEachDay}
              onChange={(e) => set({ newSpreadEachDay: e.target.checked })}
            />
            New spread each day
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={options.skipDuplicates}
              onChange={(e) => set({ skipDuplicates: e.target.checked })}
            />
            One photo per burst
          </label>

          <div className="field">
            <span>
              <span>Most photos per spread</span>
              <span>{options.maxPerSpread}</span>
            </span>
            <div className="seg">
              {MAX_CHOICES.map((n) => (
                <button
                  key={n}
                  className={options.maxPerSpread === n ? "active" : ""}
                  onClick={() => set({ maxPerSpread: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="report">
            <div>
              <b>{photos.length}</b> photo{photos.length === 1 ? "" : "s"}
              {days > 0 && (
                <>
                  {" · "}
                  <b>{days}</b> day{days === 1 ? "" : "s"}
                </>
              )}
              {" → "}
              <b>{report.spreads.length}</b> spread
              {report.spreads.length === 1 ? "" : "s"}
            </div>
            {report.skipped.length > 0 && (
              <div>
                <b>{report.skipped.length}</b> near-duplicate
                {report.skipped.length === 1 ? "" : "s"} skipped across{" "}
                <b>{report.bursts}</b> burst{report.bursts === 1 ? "" : "s"}
              </div>
            )}
            {report.soft.red + report.soft.amber > 0 && (
              <div className="warn">
                {report.soft.red > 0 && `${report.soft.red} will print under 200 dpi`}
                {report.soft.red > 0 && report.soft.amber > 0 && ", "}
                {report.soft.amber > 0 && `${report.soft.amber} between 200 and 300 dpi`}
                . The dots on each spread show which.
              </div>
            )}
            {report.leftOver.length > 0 && (
              <div className="warn">
                {report.leftOver.length} photo{report.leftOver.length === 1 ? "" : "s"} had
                no layout to land in — {props.formatName} has none small enough.
              </div>
            )}
          </div>

          {photos.length > 0 && <p className="hint">{ORDER_NOTE[report.ordering]}</p>}

          {options.skipDuplicates && report.skipped.length > 0 && (
            <p className="hint">
              Where you took the same shot several times, the sharpest one goes on
              the page. The rest stay in your tray — nothing is deleted, and you can
              drop any of them into a slot yourself.
            </p>
          )}
          {report.cannotCompare && photos.length > 1 && (
            <p className="hint warn">
              These photos have nothing to compare — either they were added before
              this could read them, or there is no detail in them to tell apart.
              Re-adding them will give it something to work with.
            </p>
          )}

          {confirming ? (
            <div className="confirm">
              <b>Replace all {props.existingSpreads} spreads?</b>
              <p>
                Everything you have arranged and cropped by hand goes, and all{" "}
                {photos.length} photos are laid out again from scratch. Undo puts it back.
              </p>
              <div className="row">
                <button
                  className="grow danger"
                  onClick={() => {
                    setConfirming(false);
                    props.onArrange(report, scope);
                  }}
                >
                  Replace and arrange
                </button>
                <button className="grow" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="primary"
              style={{ width: "100%", marginTop: 8 }}
              disabled={report.spreads.length === 0}
              onClick={() =>
                replaces ? setConfirming(true) : props.onArrange(report, scope)
              }
            >
              {report.spreads.length === 0
                ? photos.length === 0
                  ? "Every photo is already placed"
                  : "No layout fits these photos"
                : `Arrange into ${report.spreads.length} spread${
                    report.spreads.length === 1 ? "" : "s"
                  }`}
            </button>
          )}

          {props.canUndo && (
            <button
              className="ghost"
              style={{ width: "100%", marginTop: 6 }}
              onClick={props.onUndo}
            >
              Undo arrange
            </button>
          )}

          {first && photos.length > 1 && (
            <p className="hint">
              Starts with <b>{first.name}</b>. Every spread is an ordinary spread
              afterwards — change the layout, swap photos, re-crop, delete one.
            </p>
          )}
        </>
      )}
    </>
  );
}
