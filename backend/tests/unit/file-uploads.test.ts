/**
 * Unit coverage for the M6 file helpers: what a file *is* (magic bytes, not the name), what a
 * name may be stored as, what an image carries after stripping, and what a signed URL will and
 * will not authorise.
 *
 * These are pure functions with no database and no HTTP, so the assertions are about bytes: the
 * fixtures below are built by hand precisely so that "the EXIF segment is gone" is a claim about
 * the output rather than about the input having contained something.
 */
import { describe, expect, it } from "vitest";
import { sanitizeOriginalName, sniffFileType } from "../../src/files/upload.js";
import { stripImageMetadata } from "../../src/files/image-metadata.js";
import { signFileAccess, verifyFileAccess } from "../../src/files/signed-url.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal containers, built segment by segment
// ---------------------------------------------------------------------------

/** A JPEG segment: marker, two-byte length (which counts itself), payload. */
function jpegSegment(marker: number, data: Buffer): Buffer {
  const length = data.byteLength + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, (length >> 8) & 0xff, length & 0xff]),
    data,
  ]);
}

/**
 * A JPEG carrying everything a phone camera writes and everything an attacker appends: a JFIF
 * APP0, an EXIF APP1 with coordinates, a comment, the scan itself, and a ZIP header after the
 * end-of-image marker.
 *
 * The entropy data deliberately contains `FF 00` — the byte-stuffing JPEG uses for a literal
 * `FF` — because mistaking it for an end-of-image marker is the bug this fixture exists to catch.
 */
function jpegWithMetadata(): Buffer {
  const app0 = jpegSegment(0xe0, Buffer.from("JFIF\0\u0001\u0002", "latin1"));
  const app1 = jpegSegment(
    0xe1,
    Buffer.concat([
      Buffer.from("Exif\0\0", "latin1"),
      Buffer.from("GPSLAT=6.9271;GPSLON=79.8612", "latin1"),
    ]),
  );
  const comment = jpegSegment(0xfe, Buffer.from("captured on a phone", "latin1"));
  const scan = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
  const appended = Buffer.from("PK\u0003\u0004second payload", "latin1");
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, comment, scan, appended]);
}

/**
 * A PNG chunk. The CRC is a placeholder: nothing in this codebase decodes the image, so a real
 * CRC would only be asserting something the stripper never reads.
 */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([
    length,
    Buffer.from(type, "latin1"),
    data,
    Buffer.alloc(4),
  ]);
}

function pngWithMetadata(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13, 1)),
    pngChunk("tEXt", Buffer.from("Comment\0taken at home", "latin1")),
    pngChunk("eXIf", Buffer.from("GPSLAT=6.9271", "latin1")),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x01, 0x02])),
    pngChunk("IEND", Buffer.alloc(0)),
    Buffer.from("PK\u0003\u0004appended", "latin1"),
  ]);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.byteLength, 0);
  const pad = data.byteLength % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(fourcc, "latin1"), size, data, pad]);
}

function webpWithMetadata(): Buffer {
  // VP8X flags: `Rsv|I|L|E|X|A|R` → 0x0C is EXIF + XMP.
  const vp8x = webpChunk("VP8X", Buffer.from([0x0c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00]));
  const exif = webpChunk("EXIF", Buffer.from("GPSLAT=6.9271", "latin1"));
  const xmp = webpChunk("XMP ", Buffer.from("<x:xmpmeta/>", "latin1"));
  const vp8 = webpChunk("VP8 ", Buffer.from([0x9d, 0x01, 0x2a, 0x02, 0x00, 0x01, 0x00]));
  const body = Buffer.concat([vp8x, exif, xmp, vp8]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.byteLength + 4, 0); // "WEBP" + the chunks
  return Buffer.concat([Buffer.from("RIFF", "latin1"), riffSize, Buffer.from("WEBP", "latin1"), body]);
}

function containsText(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).toString("latin1").includes(needle);
}

// ---------------------------------------------------------------------------
// sniffFileType
// ---------------------------------------------------------------------------
describe("sniffFileType — the bytes decide, never the name", () => {
  it("recognises the four stored binary types and an SVG", () => {
    expect(sniffFileType(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffFileType(pngWithMetadata())).toBe("png");
    expect(sniffFileType(webpWithMetadata())).toBe("webp");
    expect(
      sniffFileType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe("svg");
  });

  it("refuses a page, an archive and a text file", () => {
    // An HTML page is XML sometimes; it is still not a logo, and storing it would be storing a
    // script under an image's content type.
    expect(sniffFileType(new TextEncoder().encode("<!DOCTYPE html><html><body>hi</body></html>"))).toBeNull();
    expect(sniffFileType(Buffer.from("PK\u0003\u0004zip"))).toBeNull();
    expect(sniffFileType(new TextEncoder().encode("just some text"))).toBeNull();
  });

  it("does not mistake a RIFF file that is not WebP", () => {
    const avi = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("AVI ", "latin1"),
    ]);
    expect(sniffFileType(avi)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeOriginalName
// ---------------------------------------------------------------------------
describe("sanitizeOriginalName", () => {
  it("keeps only the basename, from either separator", () => {
    expect(sanitizeOriginalName("C:\\Users\\Dell\\bank receipt.pdf")).toBe("bank receipt.pdf");
    expect(sanitizeOriginalName("/var/tmp/logo.png")).toBe("logo.png");
  });

  it("removes control characters and bounds the length", () => {
    expect(sanitizeOriginalName("bank\u0000\u001breceipt.pdf")).toBe("bankreceipt.pdf");
    expect(sanitizeOriginalName("x".repeat(400))!.length).toBe(100);
  });

  it("drops a name that is nothing but a path or a dot segment", () => {
    expect(sanitizeOriginalName("")).toBeNull();
    expect(sanitizeOriginalName("..")).toBeNull();
    expect(sanitizeOriginalName(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripImageMetadata
// ---------------------------------------------------------------------------
describe("stripImageMetadata", () => {
  it("removes a JPEG's EXIF and comment but keeps the scan and the JFIF header", () => {
    const original = jpegWithMetadata();
    const stripped = stripImageMetadata(original, "jpeg");
    expect(stripped).not.toBeNull();

    expect(containsText(stripped!, "GPSLAT")).toBe(false);
    expect(containsText(stripped!, "captured on a phone")).toBe(false);
    expect(containsText(stripped!, "second payload")).toBe(false);
    // Kept: the file is still a JPEG, still has its JFIF header, its scan and its EOI.
    expect(containsText(stripped!, "JFIF")).toBe(true);
    expect(Buffer.from(stripped!).subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(Buffer.from(stripped!).subarray(-2).toString("hex")).toBe("ffd9");
    expect(stripped!.byteLength).toBeLessThan(original.byteLength);
  });

  it("removes a PNG's text and eXIf chunks, keeps the pixels, and drops what follows IEND", () => {
    const stripped = stripImageMetadata(pngWithMetadata(), "png");
    expect(stripped).not.toBeNull();

    expect(containsText(stripped!, "tEXt")).toBe(false);
    expect(containsText(stripped!, "eXIf")).toBe(false);
    expect(containsText(stripped!, "taken at home")).toBe(false);
    expect(containsText(stripped!, "appended")).toBe(false);
    expect(containsText(stripped!, "IHDR")).toBe(true);
    expect(containsText(stripped!, "IDAT")).toBe(true);
    expect(Buffer.from(stripped!).subarray(-8).toString("latin1")).toContain("IEND");
  });

  it("drops a WebP's EXIF and XMP, clears their flags, and fixes the RIFF size", () => {
    const stripped = stripImageMetadata(webpWithMetadata(), "webp");
    expect(stripped).not.toBeNull();

    expect(containsText(stripped!, "EXIF")).toBe(false);
    expect(containsText(stripped!, "XMP ")).toBe(false);
    expect(containsText(stripped!, "VP8 ")).toBe(true);
    // The VP8X flags must stop advertising metadata that is no longer in the file.
    expect(stripped![20]).toBe(0x00);
    expect(Buffer.from(stripped!).readUInt32LE(4)).toBe(stripped!.byteLength - 8);
  });

  it("returns null rather than storing an image whose container it cannot parse", () => {
    // A JPEG whose first marker is truncated, a PNG with a chunk longer than the file, and a
    // WebP whose declared chunk size runs past the end.
    expect(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff]), "jpeg")).toBeNull();
    expect(
      stripImageMetadata(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from([0x00, 0x00, 0xff, 0xff]),
          Buffer.from("IHDR", "latin1"),
        ]),
        "png",
      ),
    ).toBeNull();
    expect(
      stripImageMetadata(
        Buffer.concat([
          Buffer.from("RIFF", "latin1"),
          Buffer.from([0x10, 0x00, 0x00, 0x00]),
          Buffer.from("WEBP", "latin1"),
          Buffer.from("VP8 ", "latin1"),
          Buffer.from([0xff, 0xff, 0x00, 0x00]),
        ]),
        "webp",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// signFileAccess / verifyFileAccess
// ---------------------------------------------------------------------------
describe("signed file access", () => {
  const args = { kind: "proof", id: "payment-1", sub: "file-1" };

  it("accepts its own credentials for the same file, inside the window", () => {
    const signed = signFileAccess({ ...args, now: new Date("2026-10-14T10:00:00Z") });
    expect(
      verifyFileAccess({
        ...args,
        exp: signed.exp,
        sig: signed.sig,
        now: new Date("2026-10-14T10:04:59Z"),
      }),
    ).toBe(true);
    // "At most 5 minutes" (FILES_AND_PDF §7).
    expect(signed.expiresAt.toISOString()).toBe("2026-10-14T10:05:00.000Z");
  });

  it("refuses it for another file, after the window, or with a tampered signature", () => {
    const signed = signFileAccess({ ...args, now: new Date("2026-10-14T10:00:00Z") });
    const at = new Date("2026-10-14T10:01:00Z");

    expect(verifyFileAccess({ ...args, sub: "file-2", exp: signed.exp, sig: signed.sig, now: at })).toBe(false);
    expect(verifyFileAccess({ ...args, id: "payment-2", exp: signed.exp, sig: signed.sig, now: at })).toBe(false);
    expect(
      verifyFileAccess({ ...args, exp: signed.exp, sig: signed.sig, now: new Date("2026-10-14T10:05:01Z") }),
    ).toBe(false);
    expect(verifyFileAccess({ ...args, exp: signed.exp, sig: `${signed.sig}x`, now: at })).toBe(false);
    expect(verifyFileAccess({ ...args, exp: undefined, sig: signed.sig, now: at })).toBe(false);
    expect(verifyFileAccess({ ...args, exp: "not-a-number", sig: signed.sig, now: at })).toBe(false);
  });

  it("cannot be extended by editing the expiry — the window is inside the signature", () => {
    const signed = signFileAccess({ ...args, now: new Date("2026-10-14T10:00:00Z") });
    const later = String(Number(signed.exp) + 86_400);
    expect(
      verifyFileAccess({
        ...args,
        exp: later,
        sig: signed.sig,
        now: new Date("2026-10-14T10:01:00Z"),
      }),
    ).toBe(false);
  });
});
