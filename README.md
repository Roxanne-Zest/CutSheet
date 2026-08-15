# Cut Sheet

**Pick a template, drop photos in, get an A4 PDF of every photo at exactly the right size. Print it, cut it, journal.**

```
Pick journal format + layout
        ↓
Drop photos into slots, pan/zoom
        ↓
Add more spreads
        ↓
Generate → A4 PDF
        ↓
Print at 100% → guillotine → journal
```

The app owns the geometry, so nothing is inferred. Crop, size, rotation and
required DPI are all values the app set.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit + PDF acceptance tests
npm run build
```

No backend. Everything runs in the browser; projects and photos live in
IndexedDB.

## The acceptance test

S6 is the acceptance test for the product: **print it, measure it.** If the
100 mm calibration ruler on the sheet does not measure 100.0 mm, your printer
scaled the page and nothing else counts.

That is checked in CI too, not just on paper. `src/lib/pdf.test.ts` generates a
PDF, inflates its content streams and measures the boxes that actually got
written — so "a 54 mm photo measures 54 mm" and "the ruler is 100.0 mm" are
assertions against real output rather than against the calls that produced it.

```bash
npm test                 # 69 unit + PDF tests
npm run dev &            # then, against a real browser:
npm run e2e              # drives the UI, generates a PDF, measures it
npm run e2e:render       # renders the PDF pages to e2e-out/*.png to look at
```

## How it fits together

| Module | Job |
|---|---|
| `data/formats.ts` | The six journal page sizes |
| `data/layouts.ts` | 12 parametric layout generators → 72 templates |
| `lib/geometry.ts` | Crop maths: fill, pan, zoom, quarter turns, straighten |
| `lib/quality.ts` | 300/200 dpi bands, rechecked on every zoom |
| `lib/printItems.ts` | Spreads → one flat `PrintItem` list |
| `lib/packer.ts` | Shelf packer: full-width rows for a guillotine |
| `lib/raster.ts` | Canvas rendering, shared by preview and PDF |
| `lib/pdf.ts` | A4 output: layout plan, sheets, ruler, crop marks |
| `lib/db.ts` | IndexedDB persistence |

`PrintItem` is the seam. It carries finished physical size as a chosen value,
never an inferred one, and everything downstream reads only from it.

## Notes on the decisions

**Shelf packing, not maxrects.** The tool is a guillotine. Every row boundary
is one clean horizontal cut across the sheet; within a row the cuts are
straight verticals. Tighter packers produce cuts you cannot physically make.

**Gap defaults to 0 mm.** One cut gives two finished edges. 1/2/3 mm is there
if you want white space or you are using scissors.

**Straighten rotates the crop in pixel space, not normalised space.** Crops are
stored normalised 0..1, but that space is anisotropic for non-square photos —
rotating there would shear the crop. `lib/geometry.ts` does the rotation in
pixels and converts back, and the tests pin both the aspect and the bounds
across a 400-step random walk of zoom/pan/rotate at every angle.

**Resolution is never invented.** The rasteriser targets 300 dpi but caps at
what the source crop actually contains. If that lands under 300 dpi the quality
dot already said so at drop time — it warns, it does not block. Your printer,
your call.

**Crop marks sit on the cut line.** Full-width lane ticks go in the sheet
margin, clear of every photo. The vertical ticks inside a row are drawn on the
cut itself, where the blade removes them — which is what lets the default gap
be 0.

## Spec extensions

The v3 spec's data model is followed as written, with these additions, each
flagged in `src/types.ts`:

- `Placement.straighten_deg` — the spec lists straighten as a feature but the
  model had nowhere to keep the angle. At 0 it degenerates exactly to the
  spec's axis-aligned crop.
- `Placement.shape` — per-slot shape override, so shape is editable without
  mutating shared template seed data.
- `PrintItem.rotation` / `straighten_deg` / `shape` / `copies` / `label` — the
  renderer cannot reconstruct these from `crop` alone, and `label` is the P-ID
  shared between the layout plan and the sheets.
- `OutputSettings.cornerStyle` — see below.

## Open questions from the spec

- **Rounded corners by default?** Not decided in the seed data. It is a project
  setting (`cornerStyle`, default square) plus a per-slot override, so it can
  be answered by using it rather than by guessing.
- **Bleed.** Implemented at 0.3 mm, default off. Worth knowing before you test
  it on paper: overprint only helps if *each* edge gets its own cut, so turning
  it on widens the gap to hold two bleeds plus a waste strip, and you cut twice
  per boundary. It is genuinely incompatible with the one-cut-two-edges
  default — that trade-off is the answer to the open question, not a detail.
- **Column alignment in Trimmer mode.** Not built. Rows only, as the spec said
  to ship.
