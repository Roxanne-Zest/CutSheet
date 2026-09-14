/**
 * When the photo was taken, read from the file itself.
 *
 * A trip arrives as a folder of files whose names sort by camera counter, or
 * not at all once two phones are involved. The capture time is the one thing
 * that puts a trip back in the order it happened, and it is sitting in the
 * JPEG already — so it is worth the eighty lines to go and get it.
 *
 * Deliberately minimal: IFD0, the Exif SubIFD, and the three date tags. No
 * MakerNotes, no GPS, no orientation — the decoder already applies orientation
 * when it makes the ImageBitmap, and anything else here would be a second
 * source of truth for something we can already see.
 */

const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;

/** `2024:07:14 09:31:02` — EXIF's own format, in the camera's local time. */
export const parseExifDate = (s: string): number | undefined => {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec] = m;
  // Local, not UTC: EXIF carries no zone, and a trip's photos are timestamped
  // in whatever time the camera was set to. Shifting them would be inventing
  // information, and only the ordering and the day boundaries matter here.
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime();
  return Number.isFinite(t) && +y > 1900 ? t : undefined;
};

const ascii = (view: DataView, at: number, len: number): string => {
  let out = "";
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
};

type Found = { dateTimeOriginal?: string; dateTimeDigitized?: string; dateTime?: string };

/** Walk one IFD, collecting the date tags and following the Exif pointer once. */
const readIfd = (
  view: DataView,
  tiff: number,
  ifd: number,
  le: boolean,
  found: Found,
  depth: number,
): void => {
  if (depth > 2 || ifd + 2 > view.byteLength) return;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return;
    const tag = view.getUint16(entry, le);
    const len = view.getUint32(entry + 4, le);

    if (tag === TAG_EXIF_IFD) {
      readIfd(view, tiff, tiff + view.getUint32(entry + 8, le), le, found, depth + 1);
      continue;
    }
    if (
      tag !== TAG_DATE_TIME &&
      tag !== TAG_DATE_TIME_ORIGINAL &&
      tag !== TAG_DATE_TIME_DIGITIZED
    ) {
      continue;
    }

    // An EXIF date is 20 ASCII bytes, so it never fits the 4-byte inline value
    // slot and is always stored at an offset from the TIFF header.
    if (len < 19 || len > 64) continue;
    const at = tiff + view.getUint32(entry + 8, le);
    if (at + len > view.byteLength) continue;
    const text = ascii(view, at, len);
    if (tag === TAG_DATE_TIME_ORIGINAL) found.dateTimeOriginal = text;
    else if (tag === TAG_DATE_TIME_DIGITIZED) found.dateTimeDigitized = text;
    else found.dateTime = text;
  }
};

/**
 * Capture time from a JPEG's bytes, or undefined for anything without one —
 * a PNG, a screenshot, a file whose EXIF was stripped on the way through a
 * messaging app.
 */
export const exifTakenAt = (buf: ArrayBuffer): number | undefined => {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined;

  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) break;
    const marker = view.getUint8(at + 1);
    // Start of scan: pixel data from here on, so there is no EXIF left to find.
    if (marker === 0xda) break;
    const size = view.getUint16(at + 2);
    if (size < 2) break;

    if (marker === 0xe1 && at + 10 <= view.byteLength && ascii(view, at + 4, 4) === "Exif") {
      const tiff = at + 10;
      if (tiff + 8 > view.byteLength) return undefined;
      const order = view.getUint16(tiff);
      if (order !== 0x4949 && order !== 0x4d4d) return undefined;
      const le = order === 0x4949;
      if (view.getUint16(tiff + 2, le) !== 42) return undefined;

      const found: Found = {};
      readIfd(view, tiff, tiff + view.getUint32(tiff + 4, le), le, found, 0);
      // Original beats digitized beats modified: the first is when the shutter
      // fired, the last is when something last wrote the file.
      const text = found.dateTimeOriginal ?? found.dateTimeDigitized ?? found.dateTime;
      return text ? parseExifDate(text) : undefined;
    }

    at += 2 + size;
  }
  return undefined;
};

/**
 * The best capture time available for a file, and how confident we are in it.
 *
 * `file` time is the modification date, which survives a copy off the camera
 * but not always a copy between machines. It is still far better than nothing
 * for ordering, so it is used and labelled rather than discarded.
 */
export type TakenAt = { takenAt: number; timeSource: "exif" | "file" };

export const takenAtOf = async (file: File): Promise<TakenAt> => {
  // The EXIF block sits at the front of the file; reading the whole of a 12 MP
  // JPEG to find it would be a waste of a hundred photos' worth of memory.
  const head = file.slice(0, 256 * 1024);
  try {
    const exif = exifTakenAt(await head.arrayBuffer());
    if (exif !== undefined) return { takenAt: exif, timeSource: "exif" };
  } catch {
    // An unreadable header is not an error worth showing: fall back to the file.
  }
  return { takenAt: file.lastModified || Date.now(), timeSource: "file" };
};
