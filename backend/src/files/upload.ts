/**
 * Reading one uploaded file, and deciding what it **actually is** (SET-03, PRF-01).
 *
 * Two rules from FILES_AND_PDF §6 shape this file:
 *
 *  1. **The type comes from the bytes, never from the client.** The extension and the
 *     `Content-Type` part header are both attacker-controlled, so they are ignored for the
 *     decision and recorded only as the original name. A mislabelled file is refused
 *     `415 UNSUPPORTED_FILE_TYPE` rather than stored under a lie.
 *  2. **Every part is consumed.** A multipart body has to be read to its end or the parser
 *     stalls waiting for bytes that never arrive, so this reads the whole body in one ordered
 *     pass and never leaves a part dangling — which also means a `note` field sent *after* the
 *     file is picked up rather than lost.
 *
 * The size limit is enforced twice on purpose: the streaming limit (registered in
 * `http/plugins.ts`) bounds what this process will buffer at all, and `rule.maxBytes` is the
 * endpoint's own rule, checked before the bytes are handed on. Only the second one can produce
 * a message that names the right limit for that endpoint.
 */
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { ApiError, errors } from "../errors.js";

/** The types the product accepts, named after what the magic bytes say (never after a MIME part). */
export type SniffedFileType = "pdf" | "jpeg" | "png" | "webp" | "svg";

const MIME_BY_TYPE: Record<SniffedFileType, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The label a human sees when a type is refused. */
const LABEL_BY_TYPE: Record<SniffedFileType, string> = {
  pdf: "PDF",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
  svg: "SVG",
};

export function mimeTypeFor(type: SniffedFileType): string {
  return MIME_BY_TYPE[type];
}

/** `jpeg` is the type name; `jpg` is what every human and every filename uses. */
export function extensionFor(type: SniffedFileType): string {
  return type === "jpeg" ? "jpg" : type;
}

function matchesAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** How much of a candidate SVG is decoded to decide whether it is one. */
const SVG_SNIFF_BYTES = 1024;

/**
 * What the bytes are, or `null` when they are not a type the product stores.
 *
 * SVG has no magic number — it is text — so it is detected by its root element instead, which
 * is also the only way to tell it from an HTML page: an `<html>` document that happens to be
 * XML is *not* accepted, because an uploaded page would be a stored script rather than a logo.
 */
export function sniffFileType(bytes: Uint8Array): SniffedFileType | null {
  if (matchesAt(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (matchesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";

  const head = Buffer.from(bytes.subarray(0, SVG_SNIFF_BYTES)).toString("utf8");
  // A BOM, then whitespace, then either an XML declaration or the root element itself.
  const text = head.replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if ((text.startsWith("<?xml") || text.startsWith("<svg")) && /<(svg|!doctype svg)[\s>]/.test(text)) {
    return "svg";
  }
  return null;
}

/**
 * The name a human gave the file, made safe to store and to echo back.
 *
 * FILES_AND_PDF §6: basename only, control characters stripped, ≤ 100 characters. A path is
 * never taken from the client, and this value is **never** used in a storage key or a header
 * unescaped.
 */
export function sanitizeOriginalName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Both separators: a Windows path arriving from a Windows client is still a path.
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // A name that is empty (or a bare dot segment) is not worth keeping: the file's own facts
  // are what the record is for.
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 100);
}

export interface UploadRule {
  /** The endpoint's own limit; the message names it, because the client needs the real number. */
  maxBytes: number;
  tooLargeMessage: string;
  allowed: readonly SniffedFileType[];
}

export interface UploadedFile {
  bytes: Buffer;
  /** Decided by the bytes. */
  type: SniffedFileType;
  mimeType: string;
  originalName: string | null;
}

export interface UploadResult {
  file: UploadedFile;
  /** Text parts, in the order they arrived (`note` on PRF-01). Values are bounded. */
  fields: Record<string, string>;
}

/** Fastify's multipart stream throws this shape when the streaming limit is hit. */
function isFileTooLarge(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: string; statusCode?: number };
  return candidate.code === "FST_REQ_FILE_TOO_LARGE" || candidate.statusCode === 413;
}

/**
 * The parser's own limits (`FST_FILES_LIMIT`, `FST_FIELDS_LIMIT`).
 *
 * They are the plugin's backstops, so hitting one is a shape mistake by the caller rather than a
 * storage failure — reported as the validation problem it is, not as a 500 from an error nobody
 * was ever told how to fix.
 */
function isPartsLimit(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code ?? "";
  return code === "FST_FILES_LIMIT" || code === "FST_FIELDS_LIMIT";
}

/** A text part longer than this is not a note; it is a body we will not buffer. */
const MAX_FIELD_VALUE_LENGTH = 2048;

function unsupported(rule: UploadRule): ApiError {
  const accepted = rule.allowed.map((type) => LABEL_BY_TYPE[type]).join(", ");
  return new ApiError("UNSUPPORTED_FILE_TYPE", `Upload a ${accepted} file.`);
}

/**
 * Reads the request's one file part (and any text parts) and applies the rule.
 *
 * Refusals are the contract's: `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_FILE_TYPE`, and
 * `422 VALIDATION_ERROR` when the body is not multipart or carries no file at all — a shape
 * mistake is a validation problem, not a type problem.
 */
export async function readUpload(req: FastifyRequest, rule: UploadRule): Promise<UploadResult> {
  const parts = (req as unknown as { parts?: () => AsyncIterable<unknown> }).parts;
  if (typeof parts !== "function") {
    throw errors.validation([
      { field: "file", issue: "Upload the file as multipart/form-data with a `file` part." },
    ]);
  }

  let file: UploadedFile | null = null;
  const fields: Record<string, string> = {};

  try {
    for await (const raw of parts.call(req) as AsyncIterable<
      | (MultipartFile & { type: "file" })
      | { type: "field"; fieldname: string; value: unknown }
    >) {
      if (raw.type === "field") {
        const value = typeof raw.value === "string" ? raw.value : String(raw.value ?? "");
        fields[raw.fieldname] = value.slice(0, MAX_FIELD_VALUE_LENGTH);
        continue;
      }
      if (raw.fieldname !== "file") {
        // Drain it so the body is fully read, then refuse: the contract declares one `file` part.
        await raw.toBuffer().catch(() => undefined);
        throw errors.validation([
          { field: raw.fieldname, issue: "Upload the file as the `file` part." },
        ]);
      }
      if (file) {
        await raw.toBuffer().catch(() => undefined);
        throw errors.validation([{ field: "file", issue: "Attach one file per request." }]);
      }

      const bytes = await raw.toBuffer();
      if (bytes.byteLength === 0) {
        throw errors.validation([{ field: "file", issue: "That file is empty." }]);
      }
      if (bytes.byteLength > rule.maxBytes) {
        throw new ApiError("FILE_TOO_LARGE", rule.tooLargeMessage);
      }

      const type = sniffFileType(bytes);
      if (!type || !rule.allowed.includes(type)) throw unsupported(rule);

      file = {
        bytes,
        type,
        mimeType: mimeTypeFor(type),
        originalName: sanitizeOriginalName(raw.filename),
      };
    }
  } catch (err) {
    // A stream that exceeded the streaming limit surfaces here rather than as a short buffer.
    if (isFileTooLarge(err)) throw new ApiError("FILE_TOO_LARGE", rule.tooLargeMessage);
    if (isPartsLimit(err)) {
      throw errors.validation([{ field: "file", issue: "Attach one file per request." }]);
    }
    throw err;
  }

  if (!file) {
    throw errors.validation([{ field: "file", issue: "Attach a file." }]);
  }
  return { file, fields };
}
