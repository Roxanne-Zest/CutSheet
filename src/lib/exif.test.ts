import { describe, expect, it } from "vitest";
import { exifTakenAt, parseExifDate } from "./exif";

/**
 * Real JPEGs are awkward to keep in a repo and awkward to trust, so the tests
 * build the bytes: an APP1 segment with a TIFF header, IFD0 pointing at the
 * Exif SubIFD, and the date sitting at an offset the way a 20-byte ASCII value
 * always must.
 */
type Entry = { tag: number; type: number; count: number; value: number };

const buildExifJpeg = (
  opts: { le?: boolean; dates?: Partial<Record<"original" | "digitized" | "modified", string>> } = {},
): ArrayBuffer => {
  const le = opts.le ?? true;
  const dates = opts.dates ?? { original: "2024:07:14 09:31:02" };

  // TIFF block laid out by hand: header, IFD0, SubIFD, then the strings.
  const strings: Array<{ key: string; text: string; at: number }> = [];
  const subEntries: Entry[] = [];
  const tagOf = { original: 0x9003, digitized: 0x9004, modified: 0x0132 };

  const ifd0Count = 1;
  const ifd0At = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const subAt = ifd0At + ifd0Size;
  const entries = (Object.keys(dates) as Array<keyof typeof tagOf>).filter((k) => dates[k]);
  const subSize = 2 + entries.length * 12 + 4;
  let cursor = subAt + subSize;

  for (const key of entries) {
    const text = dates[key]!;
    strings.push({ key, text, at: cursor });
    subEntries.push({ tag: tagOf[key], type: 2, count: text.length + 1, value: cursor });
    cursor += text.length + 1;
  }

  const tiffLen = cursor;
  const buf = new ArrayBuffer(2 + 4 + 6 + tiffLen);
  const v = new DataView(buf);
  v.setUint16(0, 0xffd8); // SOI
  v.setUint16(2, 0xffe1); // APP1
  v.setUint16(4, 2 + 6 + tiffLen); // segment length, including its own two bytes
  for (let i = 0; i < 6; i++) v.setUint8(6 + i, "Exif\0\0".charCodeAt(i));

  const tiff = 12;
  v.setUint16(tiff, le ? 0x4949 : 0x4d4d);
  v.setUint16(tiff + 2, 42, le);
  v.setUint32(tiff + 4, ifd0At, le);

  v.setUint16(tiff + ifd0At, ifd0Count, le);
  v.setUint16(tiff + ifd0At + 2, 0x8769, le); // Exif IFD pointer
  v.setUint16(tiff + ifd0At + 4, 4, le);
  v.setUint32(tiff + ifd0At + 6, 1, le);
  v.setUint32(tiff + ifd0At + 10, subAt, le);
  v.setUint32(tiff + ifd0At + 14, 0, le);

  v.setUint16(tiff + subAt, subEntries.length, le);
  subEntries.forEach((e, i) => {
    const at = tiff + subAt + 2 + i * 12;
    v.setUint16(at, e.tag, le);
    v.setUint16(at + 2, e.type, le);
    v.setUint32(at + 4, e.count, le);
    v.setUint32(at + 8, e.value, le);
  });
  v.setUint32(tiff + subAt + 2 + subEntries.length * 12, 0, le);

  for (const s of strings) {
    for (let i = 0; i < s.text.length; i++) v.setUint8(tiff + s.at + i, s.text.charCodeAt(i));
    v.setUint8(tiff + s.at + s.text.length, 0);
  }
  return buf;
};

const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

describe("EXIF dates", () => {
  it("parses the EXIF format as local time, not UTC", () => {
    // EXIF carries no zone. The camera's clock is the trip's clock, and
    // shifting it would invent information.
    expect(parseExifDate("2024:07:14 09:31:02")).toBe(at(2024, 7, 14, 9, 31, 2));
  });

  it("refuses anything that is not an EXIF date", () => {
    expect(parseExifDate("")).toBeUndefined();
    expect(parseExifDate("14/07/2024")).toBeUndefined();
    expect(parseExifDate("0000:00:00 00:00:00")).toBeUndefined();
  });

  it("reads DateTimeOriginal out of a little-endian JPEG", () => {
    expect(exifTakenAt(buildExifJpeg())).toBe(at(2024, 7, 14, 9, 31, 2));
  });

  it("reads a big-endian JPEG too — plenty of cameras write MM", () => {
    expect(exifTakenAt(buildExifJpeg({ le: false }))).toBe(at(2024, 7, 14, 9, 31, 2));
  });

  it("prefers when the shutter fired over when the file was last written", () => {
    const buf = buildExifJpeg({
      dates: {
        original: "2024:07:14 09:31:02",
        digitized: "2024:07:14 09:31:03",
        modified: "2025:01:02 18:00:00",
      },
    });
    expect(exifTakenAt(buf)).toBe(at(2024, 7, 14, 9, 31, 2));
  });

  it("falls back to the digitized date when there is no original", () => {
    const buf = buildExifJpeg({ dates: { digitized: "2024:07:14 09:31:03" } });
    expect(exifTakenAt(buf)).toBe(at(2024, 7, 14, 9, 31, 3));
  });

  it("gives up quietly on a file with no EXIF at all", () => {
    // A PNG, and a JPEG whose EXIF was stripped on the way through a chat app.
    expect(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer)).toBeUndefined();
    expect(exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer)).toBeUndefined();
  });

  it("does not read off the end of a truncated file", () => {
    const full = buildExifJpeg();
    for (const cut of [14, 20, 30, 40, full.byteLength - 1]) {
      expect(() => exifTakenAt(full.slice(0, cut))).not.toThrow();
    }
  });
});
