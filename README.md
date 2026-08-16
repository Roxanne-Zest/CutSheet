# Cut Sheet

**What you specify in millimetres is what comes out of the printer in millimetres.**

Three tools that share one promise:

| Tool | For |
|---|---|
| **Reference card** | Finding out whether your printer scales at all. One page of shapes at known sizes. |
| **Sheet sizer** | Artwork somebody else made. Measure one sticker, print the sheet at true size. |
| **Journal** | Photos you laid out yourself. Pick a template, drop photos in, guillotine. |

```
Journal                       Sheet sizer
Pick format + layout          Drop a sticker sheet in
        ↓                             ↓
Drop photos into slots        Drag a line across one circle
        ↓                             ↓
Add more spreads              Type "12 mm"
        ↓                             ↓
Generate → A4 PDF             PDF at true physical size
        ↓                             ↓
Print at 100% → guillotine    Print at 100% → punch
```

The app owns the geometry, so nothing is inferred. Crop, size, rotation and
required DPI are all values the app set. Every sheet it produces carries the
same 100 mm calibration rule, drawn by one function — measure it before you
trust anything else on the page.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit + PDF acceptance tests
npm run build
```

No backend. Everything runs in the browser; projects and photos live in
IndexedDB.

## Deploying

Netlify, git-push deploys from `main`. Config is in `netlify.toml`, so the
Netlify UI needs nothing set by hand:

1. Netlify → Add new site → Import from Git → this repo
2. Leave build command and publish directory blank — `netlify.toml` sets them
   (`npm run build` → `dist`)
3. Deploy

Two things worth knowing:

- **Node is pinned to 22.** Vite 8 requires `^20.19.0 || >=22.12.0` and
  Netlify's default image is older, so the build fails without the pin. There
  is a matching `.nvmrc` for local work.
- **There are no environment variables and no Netlify Functions.** v1 is
  entirely client-side: photos never leave the browser, and the PDF is built
  locally with `pdf-lib`. Nothing to configure, nothing to leak.

Ongoing deploys are just `git push origin main`.

## The acceptance tests

All three are physical, and none has been run on paper yet — that part is
yours.

- **S6, the journal:** print it, measure it. If the 100 mm calibration ruler on
  the sheet does not measure 100.0 mm, your printer scaled the page and nothing
  else counts. A 54 mm photo must measure 54 mm.
- **X5, the sizer:** print a real sticker sheet, punch it, **the punch fits.**
- **X1, the card:** the printed card's 100 mm rule measures 100.0 mm and its
  12 mm circle measures 12.0 mm.

Everything short of the paper is checked automatically. `src/lib/pdf.test.ts`,
`refCard.test.ts` and `sizerPdf.test.ts` generate PDFs, inflate their content
streams and measure the boxes that actually got written — so "the artwork is
drawn 190 x 261 mm" and "the ruler is 100.0 mm" are assertions against real
output rather than against the calls that produced it. `e2e/scale.mjs` goes
further: it draws a sticker sheet with discs of an exactly known pixel
diameter, drags a deliberately sloppy line across one in a real browser, and
checks that snap-to-edge recovers the true diameter and that the resulting PDF
puts that disc on paper at the millimetre size it was told to.

```bash
npm test                 # unit + PDF tests
npm run dev &            # then, against a real browser:
npm run e2e              # journal: drives the UI, generates a PDF, measures it
npm run e2e:scale        # reference card + sheet sizer, same treatment
npm run e2e:render       # renders the PDF pages to e2e-out/*.png to look at
```

## How it fits together

| Module | Job |
|---|---|
| `data/formats.ts` | The six journal page sizes |
| `data/templates.ts` | 45 hand-drawn layouts + the registry both sets feed |
| `data/generated.ts` | 12 parametric generators → 72 templates |
| `lib/refCard.ts` | The scale reference card: shapes, punch bleed, layout |
| `lib/imperial.ts` | Which millimetre sizes really are inch fractions |
| `lib/sheetSizer.ts` | Sizer arithmetic: scale, dpi, fit vs tile |
| `lib/edgeSnap.ts` | Snap-to-edge for the measure tool |
| `lib/sheetSource.ts` | Loading PNG / JPEG / PDF artwork |
| `lib/sizerPdf.ts` | Sizer output: true size, tiling, ruler |
| `lib/pdfDraw.ts` | Millimetre drawing helpers and the one 100 mm ruler |
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

## The scale tools

Two problems that look like one and are not:

1. **Your printer scales.** Print dialogs default to fit-to-page and quietly
   shrink by about 4%. A one-off calibration fixes this forever — that is the
   **reference card**.
2. **A sticker sheet has no inherent size.** A PNG someone sent you is
   2400 x 3300 px. Nothing in the file says the circles should be 12 mm, so
   there is no "correct" percentage to print at. That is the **sheet sizer**.

### Reference card

Circles at 8, 10, 12, 15, 19, 20, 25, 25.4, 32 and 38 mm, squares at 10, 20 and
25 mm, a 100 mm rule and a 1 inch bar. Type any diameter to add your own, in a
row of six so it lays across a sheet of stickers.

**Punch mode** adds 0.5 mm and labels by the punch rather than by what is drawn,
so a circle labelled "12 mm punch" is physically 12.5 mm. A 12 mm punch on a
12 mm printed circle leaves a white rim if you are even slightly off centre; on
a 12.5 mm circle the blade lands inside the ink every time.

Imperial equivalents are only shown where the two systems genuinely agree —
19 mm really is 3/4", 25.4 mm really is 1", and 25 mm is neither. Calling a
25 mm circle an inch is exactly how a punch stops fitting.

### Sheet sizer

```
Drop the sheet in → drag across one circle → type "12 mm"
        ↓
scale = target_mm / measured_px, and every other dimension follows
        ↓
PDF at true physical size → print at 100% → punch
```

No iteration, no eyeballing. The measuring is built for the last pixel rather
than the first: a 400% loupe while you drag, arrow keys for single pixels, and
**snap-to-edge** on release, which searches ±6 px along the drag axis for the
strongest contrast change. That last one is what turns "roughly on the edge"
into "on the edge" — and it matters, because a 0.5 mm slip on a 12 mm circle is
4% out across the whole sheet. The UI says to measure the largest feature you
can find, for the same reason.

**PDFs need no measuring.** A PDF carries real units, so its declared page size
is used directly and the page is embedded as vector rather than resampled. You
can turn that off and measure it by hand if the export declares a nominal size.

**Oversize handling.** Tiling keeps every sticker true size, across sheets with
a 5 mm overlap. Scale-to-fit is offered because people ask for it, and says on
the page itself that it is `SCALED TO n% - NOT TRUE SIZE`. Choosing one sheet
for artwork that does not fit gives you the middle of it at true size, cropped
to the printable box so the warning telling you that is still readable.

### What was deliberately left out

- **Punch guides** — a hairline circle at punch size centred on each detected
  sticker. That needs circle detection, which is a bigger job than it sounds.
  Manual measuring with snap-to-edge is a five-second job; build the guides when
  real sheets prove they are wanted.
- **Per-printer calibration.** If someone's printer is reliably 96%, the app
  could pre-compensate. That hides a problem rather than fixing it. Turn
  fit-to-page off instead.
- **Circle detection via Hough transform.** Same answer: not before there is
  demand.

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
