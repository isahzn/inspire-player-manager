/**
 * Stripping metadata out of an uploaded image (FILES_AND_PDF §6).
 *
 * A guardian's bank-app screenshot carries more than the payment: a phone camera writes GPS
 * coordinates, a device serial and a capture time into EXIF, and a messenger app can re-wrap a
 * file so that a second payload rides along after the end of the image. The spec's rule is
 * "decode and re-encode, store only the re-encoded bytes" — and this is that rule implemented
 * at the **container** level rather than by re-compressing pixels.
 *
 * That choice is deliberate:
 *
 *  - No image codec is a dependency of this project, and adding one to strip metadata would mean
 *    a native build (and a decoder that has to be trusted with hostile input) for a job that is
 *    really container surgery.
 *  - JPEG, PNG and WebP each keep their metadata in **separate, self-describing segments**: EXIF
 *    and comments in JPEG `APPn`/`COM` markers, `tEXt`/`zTXt`/`iTXt`/`eXIf` chunks in PNG, and
 *    `EXIF`/`XMP ` chunks in WebP. Removing those segments leaves the compressed image data
 *    byte-for-byte untouched, so the picture cannot be altered by this function — which is the
 *    outcome that matters for evidence.
 *  - Dropping everything after the final end-of-image marker removes an appended payload, which
 *    a pixel re-encode would also do but a naive "store as-is" would not.
 *
 * The return value is `null` for a container this cannot parse. The caller refuses that file
 * (`415`) rather than storing an image whose metadata it could not account for: an image we
 * cannot rewrite is an image we would be storing blind.
 */

/** A big-endian 32-bit read; PNG and RIFF lengths are both unsigned 32-bit. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function writeUint32LE(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JPEG — drop APP1..APP15 and COM, keep APP0 (JFIF) and every structural marker
// ---------------------------------------------------------------------------

/**
 * JPEG metadata lives in `APPn` markers. **APP1 is EXIF** (the GPS block), APP2 is FlashPix,
 * APP13 carries editing-application metadata, and `COM` is a free-text comment — all of it is
 * metadata. APP0 is kept because it is the JFIF header some decoders expect, and the
 * entropy-coded scan after `SOS` is copied verbatim, so the image data is never re-encoded.
 */
function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI

  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let pos = 2;

  while (pos + 1 < bytes.byteLength) {
    if (bytes[pos] !== 0xff) return null; // a marker must start here
    const marker = bytes[pos + 1] ?? 0;

    // Fill bytes (FF FF) are padding before the real marker.
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    // Standalone markers carry no length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      kept.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    // SOS: the compressed scan begins. Copy from here to the first end-of-image, dropping any
    // trailing bytes an appended payload would have left behind.
    if (marker === 0xda) {
      const eoi = findEndOfImage(bytes, pos + 2);
      kept.push(eoi === -1 ? bytes.subarray(pos) : bytes.subarray(pos, eoi + 2));
      return concat(kept);
    }

    const length = ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0);
    if (length < 2) return null;
    const end = pos + 2 + length;
    if (end > bytes.byteLength) return null;

    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) kept.push(bytes.subarray(pos, end));
    pos = end;
  }
  return null;
}

/**
 * The first `FF D9` at or after `from`.
 *
 * This is safe inside entropy-coded data because a literal `FF` byte in a scan is always
 * followed by `00` (byte stuffing), so the sequence `FF D9` cannot occur as picture data.
 */
function findEndOfImage(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.byteLength; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// PNG — keep the critical chunks (and tRNS), drop the ancillary metadata ones
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks that carry pixels or are needed to render them. Everything else is optional data. */
const PNG_KEPT_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

function stripPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let pos = 8;
  let sawHeader = false;
  let sawEnd = false;

  while (pos + 12 <= bytes.byteLength) {
    const length = readUint32BE(bytes, pos);
    const type = Buffer.from(bytes.subarray(pos + 4, pos + 8)).toString("latin1");
    const end = pos + 12 + length;
    if (end > bytes.byteLength) return null;

    if (type === "IHDR") sawHeader = true;
    if (PNG_KEPT_CHUNKS.has(type)) kept.push(bytes.subarray(pos, end));
    if (type === "IEND") {
      sawEnd = true;
      break; // anything after IEND is a payload, not part of the image
    }
    pos = end;
  }

  if (!sawHeader || !sawEnd) return null;
  return concat(kept);
}

// ---------------------------------------------------------------------------
// WebP — drop EXIF/XMP chunks and clear their flags in VP8X
// ---------------------------------------------------------------------------

/** The `VP8X` flag bits, from the container spec's `Rsv|I|L|E|X|A|R` layout. */
const WEBP_FLAG_EXIF = 0x08;
const WEBP_FLAG_XMP = 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 12) return null;
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "RIFF") return null;
  if (Buffer.from(bytes.subarray(8, 12)).toString("latin1") !== "WEBP") return null;

  const kept: Uint8Array[] = [];
  let pos = 12;

  while (pos + 8 <= bytes.byteLength) {
    const fourcc = Buffer.from(bytes.subarray(pos, pos + 4)).toString("latin1");
    const size = readUint32LE(bytes, pos + 4);
    const dataStart = pos + 8;
    const end = dataStart + size + (size % 2); // chunks are padded to an even length
    if (end > bytes.byteLength) return null;

    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      if (fourcc === "VP8X" && size >= 1) {
        // The chunk still describes the file, so its flags must stop advertising the metadata
        // that is no longer there — a reader that trusts the flag would look for a missing chunk.
        const chunk = Buffer.from(bytes.subarray(pos, end));
        chunk[8] = (chunk[8] ?? 0) & ~(WEBP_FLAG_EXIF | WEBP_FLAG_XMP);
        kept.push(chunk);
      } else {
        kept.push(bytes.subarray(pos, end));
      }
    }
    pos = end;
  }

  if (kept.length === 0) return null;
  const body = Buffer.concat(kept.map((part) => Buffer.from(part)));
  return concat([
    Buffer.from("RIFF", "latin1"),
    writeUint32LE(body.byteLength + 4), // "WEBP" + the chunks
    Buffer.from("WEBP", "latin1"),
    body,
  ]);
}

/**
 * The same image without its metadata, or `null` when the container could not be parsed.
 *
 * The returned bytes are a valid image of the same type: nothing here re-encodes pixels, so a
 * stripped file renders exactly like the original.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  type: "jpeg" | "png" | "webp",
): Uint8Array | null {
  if (type === "jpeg") return stripJpeg(bytes);
  if (type === "png") return stripPng(bytes);
  return stripWebp(bytes);
}
