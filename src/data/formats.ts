import type { JournalFormat } from "../types";

/**
 * Journal page sizes. A template is one of these plus slots at fixed mm.
 *
 * These live apart from the templates so both the hand-authored seed and the
 * parametric generators can read them without importing each other.
 */
export const FORMATS: JournalFormat[] = [
  { id: "passport-tn", name: "Passport TN",      page_w_mm: 90,  page_h_mm: 125, margin_mm: 6 },
  { id: "pocket",      name: "Pocket / Field Notes", page_w_mm: 89, page_h_mm: 140, margin_mm: 6 },
  { id: "a6",          name: "A6",               page_w_mm: 105, page_h_mm: 148, margin_mm: 7 },
  { id: "a5",          name: "A5",               page_w_mm: 148, page_h_mm: 210, margin_mm: 10 },
  { id: "standard-tn", name: "Standard TN",      page_w_mm: 110, page_h_mm: 210, margin_mm: 8 },
  { id: "hobonichi-cousin", name: "Hobonichi Cousin", page_w_mm: 152, page_h_mm: 216, margin_mm: 10 },
];

export const formatById = (id: string): JournalFormat | undefined =>
  FORMATS.find((f) => f.id === id);
