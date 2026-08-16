import { useEffect, useState } from "react";
import { JournalApp } from "./JournalApp";
import { ReferenceCardPanel } from "./components/ReferenceCardPanel";
import { SheetSizerPanel } from "./components/SheetSizerPanel";
import { CutPathPanel } from "./components/CutPathPanel";

/**
 * Three tools, one promise: what you specify in millimetres is what comes out
 * of the printer in millimetres.
 *
 * Journal does it for photos you laid out yourself. Sheet sizer does it for
 * artwork somebody else made. The reference card is how you find out whether
 * your printer is playing along at all — which is why it comes first in the
 * list even though it is the smallest of the three.
 */

export type AppMode = "card" | "sizer" | "cutpath" | "journal";

const MODES: Array<{ id: AppMode; label: string; tagline: string }> = [
  {
    id: "card",
    label: "Reference card",
    tagline: "Print one page of known sizes and find out if your printer scales.",
  },
  {
    id: "sizer",
    label: "Sheet sizer",
    tagline: "Measure one sticker, print the whole sheet at the right physical size.",
  },
  {
    id: "cutpath",
    label: "Cut path",
    tagline:
      "Throw away a sticker's painted-on border and build a real vector cut path.",
  },
  {
    id: "journal",
    label: "Journal",
    tagline: "Pick a template, drop photos in, print at 100%, guillotine, journal.",
  },
];

const STORAGE_KEY = "cutsheet.mode";

const initialMode = (): AppMode => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "card" || saved === "sizer" || saved === "cutpath" || saved === "journal") {
      return saved;
    }
  } catch {
    // Private browsing. The default is fine.
  }
  return "journal";
};

export default function App() {
  const [mode, setMode] = useState<AppMode>(initialMode);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Nothing to do — the mode just will not persist.
    }
  }, [mode]);

  const current = MODES.find((m) => m.id === mode) ?? MODES[MODES.length - 1];

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Cut<span>Sheet</span>
        </h1>
        <nav className="seg modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={mode === m.id ? "active" : ""}
              onClick={() => setMode(m.id)}
              title={m.tagline}
              aria-current={mode === m.id}
            >
              {m.label}
            </button>
          ))}
        </nav>
        <span className="tagline">{current.tagline}</span>
        <span className="spacer" />
      </header>

      <div className={`app-body ${mode}`}>
        {mode === "journal" && <JournalApp />}
        {mode === "card" && <ReferenceCardPanel />}
        {mode === "sizer" && <SheetSizerPanel />}
        {mode === "cutpath" && <CutPathPanel />}
      </div>
    </div>
  );
}
