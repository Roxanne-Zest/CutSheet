import type { Format } from "../types";

/** Journal page sizes. A template is one of these plus slots at fixed mm. */
export const FORMATS: Format[] = [
  { id: "passport-tn", name: "Passport TN", w_mm: 90, h_mm: 125 },
  { id: "standard-tn", name: "Standard TN", w_mm: 110, h_mm: 210 },
  { id: "a6", name: "A6", w_mm: 105, h_mm: 148 },
  { id: "a5", name: "A5", w_mm: 148, h_mm: 210 },
  { id: "hobonichi-cousin", name: "Hobonichi Cousin", w_mm: 152, h_mm: 216 },
  { id: "pocket", name: "Pocket", w_mm: 89, h_mm: 140 },
];

export const formatById = (id: string): Format | undefined =>
  FORMATS.find((f) => f.id === id);
