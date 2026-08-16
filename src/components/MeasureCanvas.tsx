import { useCallback, useEffect, useRef, useState } from "react";
import { SNAP_RADIUS_PX, axisOf, samplerFor, snapEndpoint } from "../lib/edgeSnap";
import type { Pt } from "../lib/edgeSnap";

/**
 * X4 — the measure tool.
 *
 * Every error here is multiplied across the whole sheet, so the interaction is
 * built around getting the last pixel right rather than around getting the
 * first one fast: a 400% loupe while you drag, arrow keys for single pixels,
 * and a snap that pulls the endpoint onto the actual edge when you let go.
 */

export type Line = { a: Pt; b: Pt };

const LOUPE_PX = 108;
const LOUPE_ZOOM = 4;
const HANDLE_PX = 7;
/** How close, in screen pixels, you have to be to grab an endpoint. */
const GRAB_PX = 12;

type View = { scale: number; x: number; y: number };

type Drag =
  | { kind: "pan"; from: Pt; view: View }
  | { kind: "endpoint"; end: "a" | "b" }
  | { kind: "new"; from: Pt };

export function MeasureCanvas({
  bitmap,
  w_px,
  h_px,
  line,
  onChange,
  snap = true,
}: {
  bitmap: CanvasImageSource;
  w_px: number;
  h_px: number;
  line: Line | null;
  onChange: (line: Line) => void;
  snap?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  /** The source pixels, kept around so snapping does not re-read the canvas. */
  const sampleRef = useRef<((x: number, y: number) => number) | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  /** Zero until the box has actually been measured — fitting to a guess is how
   * the view ends up at the wrong zoom for the whole session. */
  const [size, setSize] = useState({ w: 0, h: 0 });
  const fittedRef = useRef<CanvasImageSource | null>(null);
  const [selected, setSelected] = useState<"a" | "b">("b");
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const [snapped, setSnapped] = useState<number | null>(null);

  // ---- keep the canvas the size of its box
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- fit the sheet once, as soon as the box has a real size
  useEffect(() => {
    if (fittedRef.current === bitmap) return;
    if (size.w < 2 || size.h < 2) return;
    fittedRef.current = bitmap;
    const scale = Math.min(size.w / w_px, size.h / h_px) * 0.92;
    setView({
      scale,
      x: (size.w - w_px * scale) / 2,
      y: (size.h - h_px * scale) / 2,
    });
    // Refitting on later resizes would move the sheet out from under a
    // measurement in progress, so this only ever runs for a new sheet.
  }, [bitmap, w_px, h_px, size]);

  // ---- read the source pixels once, so snapping never re-reads the canvas
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width = w_px;
    off.height = h_px;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0, w_px, h_px);
    try {
      const data = ctx.getImageData(0, 0, w_px, h_px).data;
      sampleRef.current = samplerFor(data, w_px, h_px);
    } catch {
      // A tainted canvas means no snapping. Manual measuring still works.
      sampleRef.current = null;
    }
  }, [bitmap, w_px, h_px]);

  const toImage = useCallback(
    (clientX: number, clientY: number): Pt => {
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return {
        x: (clientX - r.left - view.x) / view.scale,
        y: (clientY - r.top - view.y) / view.scale,
      };
    },
    [view],
  );

  const toScreen = useCallback(
    (p: Pt): Pt => ({ x: p.x * view.scale + view.x, y: p.y * view.scale + view.y }),
    [view],
  );

  // ---- draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, size.w, size.h);

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w_px, h_px);
    ctx.imageSmoothingEnabled = view.scale < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, w_px, h_px);
    ctx.restore();

    if (!line) return;
    const a = toScreen(line.a);
    const b = toScreen(line.b);

    ctx.lineCap = "round";
    // A dark underlay, so the measure line reads on white artwork too.
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = "#d8a657";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (const [key, p] of [["a", a], ["b", b]] as Array<["a" | "b", Pt]>) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_PX, 0, Math.PI * 2);
      ctx.fillStyle = selected === key ? "#d8a657" : "rgba(20,22,26,0.85)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#d8a657";
      ctx.stroke();
      // Crosshair, so the handle does not hide the pixel it is sitting on.
      ctx.beginPath();
      ctx.moveTo(p.x - HANDLE_PX - 5, p.y);
      ctx.lineTo(p.x + HANDLE_PX + 5, p.y);
      ctx.moveTo(p.x, p.y - HANDLE_PX - 5);
      ctx.lineTo(p.x, p.y + HANDLE_PX + 5);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(216,166,87,0.7)";
      ctx.stroke();
    }
  }, [bitmap, w_px, h_px, line, size, view, selected, toScreen]);

  // ---- loupe
  useEffect(() => {
    const canvas = loupeRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !loupe) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOUPE_PX * dpr;
    canvas.height = LOUPE_PX * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const span = LOUPE_PX / LOUPE_ZOOM;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0e1013";
    ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
    ctx.drawImage(
      bitmap,
      loupe.x - span / 2,
      loupe.y - span / 2,
      span,
      span,
      0,
      0,
      LOUPE_PX,
      LOUPE_PX,
    );
    ctx.strokeStyle = "#d8a657";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, LOUPE_PX / 2);
    ctx.lineTo(LOUPE_PX, LOUPE_PX / 2);
    ctx.moveTo(LOUPE_PX / 2, 0);
    ctx.lineTo(LOUPE_PX / 2, LOUPE_PX);
    ctx.stroke();
  }, [bitmap, loupe]);

  const near = (p: Pt, screen: Pt) => {
    const s = toScreen(p);
    return Math.hypot(s.x - screen.x, s.y - screen.y) <= GRAB_PX + HANDLE_PX;
  };

  const applySnap = (l: Line): Line => {
    const sample = sampleRef.current;
    if (!snap || !sample) {
      setSnapped(null);
      return l;
    }
    const axis = axisOf(l.a, l.b);
    const sa = snapEndpoint(sample, l.a, axis);
    const sb = snapEndpoint(sample, l.b, axis);
    setSnapped(sa.moved_px + sb.moved_px);
    return { a: sa.point, b: sb.point };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const img = toImage(e.clientX, e.clientY);

    if (line && near(line.a, screen)) {
      dragRef.current = { kind: "endpoint", end: "a" };
      setSelected("a");
      setLoupe(line.a);
      return;
    }
    if (line && near(line.b, screen)) {
      dragRef.current = { kind: "endpoint", end: "b" };
      setSelected("b");
      setLoupe(line.b);
      return;
    }
    // Shift-drag or the middle button pans; a plain drag always starts a new
    // measurement, because that is what you came here to do.
    if (e.button === 1 || e.shiftKey) {
      dragRef.current = { kind: "pan", from: screen, view };
      return;
    }
    dragRef.current = { kind: "new", from: img };
    setSelected("b");
    setSnapped(null);
    setLoupe(img);
    onChange({ a: img, b: img });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const img = toImage(e.clientX, e.clientY);

    if (drag.kind === "pan") {
      setView({
        scale: drag.view.scale,
        x: drag.view.x + (screen.x - drag.from.x),
        y: drag.view.y + (screen.y - drag.from.y),
      });
      return;
    }
    if (drag.kind === "new") {
      setLoupe(img);
      onChange({ a: drag.from, b: img });
      return;
    }
    if (!line) return;
    setLoupe(img);
    onChange(drag.end === "a" ? { a: img, b: line.b } : { a: line.a, b: img });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setLoupe(null);
    if (!line || !drag || drag.kind === "pan") return;
    // Snap on release: a drag that ends "roughly on the edge" becomes a
    // measurement that starts and ends on it.
    if (Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) < 2) return;
    onChange(applySnap(line));
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const scale = Math.min(40, Math.max(0.05, view.scale * factor));
    // Zoom about the cursor, so the pixel under it stays put.
    setView({
      scale,
      x: sx - ((sx - view.x) / view.scale) * scale,
      y: sy - ((sy - view.y) / view.scale) * scale,
    });
  };

  /** Arrow keys move the selected endpoint one source pixel at a time. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!line) return;
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, Pt> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    if (e.key === "Tab") {
      e.preventDefault();
      setSelected((s) => (s === "a" ? "b" : "a"));
      return;
    }
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    setSnapped(null);
    const end = selected === "a" ? line.a : line.b;
    const moved = { x: end.x + d.x, y: end.y + d.y };
    onChange(selected === "a" ? { a: moved, b: line.b } : { a: line.a, b: moved });
  };

  const zoomPct = Math.round(view.scale * 100);

  return (
    <div className="measure" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="measure-canvas"
        style={{ width: size.w, height: size.h }}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        aria-label="Sticker sheet — drag across one sticker to measure it"
      />

      {loupe && (
        <div className="loupe" style={{ width: LOUPE_PX, height: LOUPE_PX }}>
          <canvas ref={loupeRef} style={{ width: LOUPE_PX, height: LOUPE_PX }} />
          <span>{LOUPE_ZOOM * 100}%</span>
        </div>
      )}

      <div className="measure-hud">
        <span>{zoomPct}%</span>
        <span>scroll to zoom · shift-drag to pan</span>
        <span>
          {line
            ? `endpoint ${selected.toUpperCase()} selected — arrow keys nudge 1 px, shift+arrow 10 px, tab swaps ends`
            : "drag across the widest part of one sticker"}
        </span>
        {snapped !== null && (
          <span className={snapped > 0 ? "snap on" : "snap"}>
            {snapped > 0
              ? `snapped ${snapped} px to the edge`
              : `already on the edge (searched ±${SNAP_RADIUS_PX} px)`}
          </span>
        )}
      </div>
    </div>
  );
}
