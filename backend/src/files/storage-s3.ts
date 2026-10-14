/**
 * The S3-compatible storage driver (FILES_AND_PDF §5, DEPLOYMENT §3/§4).
 *
 * v1 stored objects in a private local directory. That is a legitimate development and staging
 * answer and an unacceptable production one: proofs are the single artefact this system cannot
 * re-create, and a directory on the API host has no versioning, no off-host copy and no life
 * after the VPS. This file is the driver that closes that gap, behind the same port
 * (`readStoredFile` / `writeStoredFile` in `storage.ts`), so switching is `STORAGE_DRIVER=s3`
 * and nothing else changes.
 *
 * **No AWS SDK.** The two operations needed are `GET` and `PUT`, so the only hard part is
 * AWS Signature Version 4, and that is a deterministic function of a handful of inputs:
 * canonical request → string to sign → derived signing key → signature. Writing it here keeps a
 * large dependency tree out of a project that otherwise has eight runtime dependencies, and it
 * keeps the signing inputs auditable.
 *
 * Three deliberate choices:
 *
 *  - **Credentials are read lazily, not snapshotted at import.** `config.storage` remains the
 *    startup-validation surface (`assertStorageUsable`), but the driver reads the environment on
 *    each call. That is what makes this file testable without module-reset gymnastics, and it
 *    means a rotated key is picked up on the next request instead of at the next deploy.
 *  - **Every failure is `null`/`false`, never a throw.** A caller's honest answer to a missing,
 *    unreadable or unstorable object is "this object cannot be read/stored" — the same contract
 *    the local driver keeps, because the two paths must be interchangeable.
 *  - **A storage key is hostile input.** The checks below are the local driver's, applied for a
 *    different reason: a key that escapes its prefix is the difference between "this object" and
 *    "somebody else's object" in a shared bucket.
 *
 * INTEROPERABILITY: proven once, on 2026-10-14, against a **real S3 server** (`rclone serve s3`,
 * which verifies SigV4 itself) with `scripts/storage-probe.ts` (`npm run storage:probe`): a
 * 1.5 MB object round-tripped byte-for-byte, a missing object read as `null`, a hostile key never
 * left the process, and — the check that gives the rest its meaning — a request signed with the
 * wrong secret was **rejected 403** and an unsigned one 400. A server that accepted a bad
 * signature would have made the successful writes prove nothing.
 *
 * Still not proven: **virtual-host addressing** (rclone serves one bucket by path, so only
 * path-style was exercised) and interop with a specific production provider (R2/AWS/Supabase) —
 * `npm run storage:probe` run against the real bucket is the check that settles those, and it is
 * the release-gate step before the first production write. The unit test remains the
 * spec-conformance check: crypto primitives against published NIST/RFC vectors, and the signature
 * against an independent second implementation written from the specification.
 *
 * A **second bucket** (the audit anchor, `AUDIT_ANCHOR_*`) reuses this file's signing by passing
 * its own `S3Config` to `s3Put` — see `src/ops/audit-anchor.ts`. One signer, two buckets, because
 * a second copy of SigV4 would be a second place to get it wrong.
 */
import { createHash, createHmac } from "node:crypto";
import { isAbsolute } from "node:path";

/** The same ceiling the local driver applies; a longer key cannot be one we minted. */
const MAX_KEY_LENGTH = 512;

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_PAYLOAD = new Uint8Array(0);

export interface S3Config {
  /** e.g. `https://s3.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and several S3-compatible services only speak path-style addressing. */
  forcePathStyle: boolean;
  /** Optional key prefix, so one bucket can be shared without two systems colliding. */
  prefix: string | null;
}

/**
 * Which environment variables a bucket's configuration is read from.
 *
 * A parameter rather than a constant because there are two buckets — the files bucket
 * (`STORAGE_*`) and the audit anchor bucket (`AUDIT_ANCHOR_*`, `src/ops/audit-anchor.ts`) — and
 * one reader for both means "what makes a bucket configuration valid" cannot drift between them.
 */
export interface S3EnvNames {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: string;
  prefix: string;
}

/** The files bucket, as DEPLOYMENT §4 freezes the names. */
export const STORAGE_ENV_NAMES: S3EnvNames = {
  endpoint: "STORAGE_ENDPOINT",
  region: "STORAGE_REGION",
  bucket: "STORAGE_BUCKET",
  accessKeyId: "STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "STORAGE_SECRET_ACCESS_KEY",
  forcePathStyle: "STORAGE_FORCE_PATH_STYLE",
  prefix: "STORAGE_PREFIX",
};

/**
 * Reads a bucket configuration, or `null` when it is incomplete.
 *
 * Deliberately lazy (see the file header): the values come from the environment on each call, so
 * a test can set them and a deployment can rotate them without a restart.
 *
 * `fallbackNames` is how a second bucket inherits transport details it does not name itself —
 * an explicit chain with one hop, not a guess. It is **partial on purpose**, and the anchor uses
 * it exactly that way: it may inherit the endpoint, region and credentials from `STORAGE_*`, but
 * never the bucket name or the prefix. Those two are what make it a *different* bucket; inheriting
 * them would quietly point the tamper-evidence copy at the very storage it is meant to be
 * independent of.
 */
export function loadS3Config(
  env: NodeJS.ProcessEnv = process.env,
  names: S3EnvNames = STORAGE_ENV_NAMES,
  fallbackNames: Partial<S3EnvNames> | null = null,
): S3Config | null {
  const read = (name: string, fallback: string | undefined): string | undefined =>
    env[name]?.trim() || (fallback ? env[fallback]?.trim() : undefined);

  const endpoint = read(names.endpoint, fallbackNames?.endpoint);
  const bucket = read(names.bucket, fallbackNames?.bucket);
  const accessKeyId = read(names.accessKeyId, fallbackNames?.accessKeyId);
  const secretAccessKey = read(names.secretAccessKey, fallbackNames?.secretAccessKey);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const region = read(names.region, fallbackNames?.region) || "auto";
  const prefix = env[names.prefix]?.trim() || null;
  const forcePathStyle = ["true", "1"].includes(
    (read(names.forcePathStyle, fallbackNames?.forcePathStyle) ?? "").trim().toLowerCase(),
  );

  if (!isUsableEndpoint(endpoint)) return null;
  if (!isAcceptableKey(bucket)) return null;

  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, prefix };
}

function isUsableEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True only when the bucket driver can actually authenticate and address a bucket.
 *
 * The point of being strict here is the failure it prevents: `STORAGE_DRIVER=s3` with four of
 * five variables set must be a startup failure, not a driver that quietly reports "no object".
 */
export function s3Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadS3Config(env) !== null;
}

/**
 * What SYS-03 shows an operator. Names the bucket and where it lives, or exactly which variable
 * is missing. It never contains a credential — this string is rendered on a page and written to
 * logs (SECURITY_AND_PRIVACY §3).
 */
export function s3StatusDetail(
  env: NodeJS.ProcessEnv = process.env,
  names: S3EnvNames = STORAGE_ENV_NAMES,
  fallbackNames: Partial<S3EnvNames> | null = null,
): string {
  /** A variable counts as present when it, or the fallback it may inherit from, is set. */
  const settled = (name: string, fallback: string | undefined): string | undefined =>
    env[name]?.trim() || (fallback ? env[fallback]?.trim() : undefined);

  const problems: string[] = [];
  const endpoint = settled(names.endpoint, fallbackNames?.endpoint);
  const bucket = settled(names.bucket, fallbackNames?.bucket);
  const accessKeyId = settled(names.accessKeyId, fallbackNames?.accessKeyId);
  const secretAccessKey = settled(names.secretAccessKey, fallbackNames?.secretAccessKey);

  if (!endpoint) problems.push(names.endpoint);
  else if (!isUsableEndpoint(endpoint)) problems.push(`${names.endpoint} (not an http(s) URL)`);
  if (!bucket) problems.push(names.bucket);
  if (!accessKeyId) problems.push(names.accessKeyId);
  if (!secretAccessKey) problems.push(names.secretAccessKey);

  const cfg = problems.length === 0 ? loadS3Config(env, names, fallbackNames) : null;
  if (cfg) {
    return (
      `S3-compatible bucket ${cfg.bucket} at ${new URL(cfg.endpoint).host} ` +
      `(region ${cfg.region}${cfg.forcePathStyle ? ", path-style" : ""}` +
      `${cfg.prefix ? `, prefix ${cfg.prefix}` : ""}).`
    );
  }

  // Every missing variable is named, not just the first: an operator who fixes one variable and
  // restarts to be told about the next has been given a slower way to read the same sentence.
  if (problems.length === 0) problems.push(names.bucket);
  return `Bucket storage is not configured: ${problems.join(", ")} unset.`;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The local driver's refusal rules, applied to a bucket key.
 *
 *  - empty, or longer than anything we mint;
 *  - a NUL byte, which truncates a path in lower layers;
 *  - a backslash, which is a Windows separator hiding inside a POSIX-looking key;
 *  - an absolute path, which is not a key we wrote;
 *  - a Windows drive letter, checked explicitly because `path.isAbsolute` is platform-dependent
 *    and `C:/x` is not absolute on Linux — a key must be refused the same way everywhere;
 *  - an empty, `.` or `..` segment, which is an attempt to leave the prefix.
 */
export function isAcceptableKey(storageKey: string): boolean {
  if (storageKey.length === 0 || storageKey.length > MAX_KEY_LENGTH) return false;
  if (storageKey.includes("\0") || storageKey.includes("\\")) return false;
  if (isAbsolute(storageKey) || /^[A-Za-z]:/.test(storageKey)) return false;
  return storageKey.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `a/b c.pdf` → `a/b%20c.pdf`, one segment at a time, leaving the separators alone. */
function encodePath(segments: readonly string[]): string {
  return segments.map((segment) => awsUriEncode(segment, false)).join("/");
}

/**
 * RFC 3986 percent-encoding as SigV4 requires it.
 *
 * `encodeURIComponent` is *not* enough: it leaves `!`, `'`, `(`, `)`, `*` and `~` alone, and AWS
 * requires the first five to be encoded (only `A-Za-z0-9-_.~` are unreserved). Encoding byte by
 * byte is also what keeps a multi-byte Sinhala or Tamil filename correct.
 */
function awsUriEncode(value: string, encodeSlash: boolean): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      out += char;
    } else if (char === "/" && !encodeSlash) {
      out += "/";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `invoices/2026/x/abc.pdf`, prefixed, as the request path (no leading slash, encoded). */
function objectPath(cfg: S3Config, storageKey: string): string {
  const prefixSegments = cfg.prefix ? cfg.prefix.split("/").filter(Boolean) : [];
  return encodePath([...prefixSegments, ...storageKey.split("/")]);
}

/**
 * The object's URL.
 *
 * Path-style addressing puts the bucket in the path (`/<bucket>/<key>`) and is what MinIO and
 * most self-hosted gateways need; virtual-host style puts it in the host
 * (`https://<bucket>.<host>/<key>`) and is what AWS itself prefers. The choice is
 * `STORAGE_FORCE_PATH_STYLE`, never a guess from the endpoint's shape.
 */
export function objectUrl(cfg: S3Config, storageKey: string): string {
  const base = new URL(cfg.endpoint);
  const path = objectPath(cfg, storageKey);
  if (cfg.forcePathStyle) {
    base.pathname = `/${cfg.bucket}/${path}`;
  } else {
    base.host = `${cfg.bucket}.${base.host}`;
    base.pathname = `/${path}`;
  }
  return base.toString();
}

// ---------------------------------------------------------------------------
// Signature Version 4
// ---------------------------------------------------------------------------

export interface SignedRequest {
  /** The URL actually requested, with the same encoding that was signed. */
  url: string;
  /** Headers to send. `host` is NOT among them — the runtime sets it from the URL. */
  headers: Record<string, string>;
  canonicalRequest: string;
  canonicalRequestHash: string;
  stringToSign: string;
  credentialScope: string;
  signedHeaders: string;
  signature: string;
  amzDate: string;
}

function hex(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hmac(key: Buffer | Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `2026-10-14T09:31:07.123Z` → `{ date: "20261014", amzDate: "20261014T093107Z" }`. */
export function amzTimestamp(now: Date): { date: string; amzDate: string } {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const amzDate = `${date}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
  return { date, amzDate };
}

/**
 * The derived signing key: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`.
 *
 * Exported because it is the step most likely to be wrong in a way the signature alone hides.
 */
export function deriveSigningKey(cfg: Pick<S3Config, "region" | "secretAccessKey">, date: string): Buffer {
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, date);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

/**
 * Builds a signed request from method, URL, body and time.
 *
 * `config` is a parameter so a test can sign against a fabricated bucket without touching the
 * environment; the two public operations pass the one they loaded.
 */
export function signRequest(args: {
  /** `DELETE` exists for the interop probe's own cleanup, not for the driver's two operations. */
  method: "GET" | "PUT" | "DELETE";
  url: string;
  body: Uint8Array;
  now: Date;
  config: S3Config;
}): SignedRequest {
  const url = new URL(args.url);
  const { date, amzDate } = amzTimestamp(args.now);
  const payloadHash = hex(args.body);

  // Only headers that are actually sent, plus `host`, which the runtime derives from the URL.
  // Every `x-amz-*` header must be signed, which is why the payload hash is here rather than
  // left to S3 to compute.
  const headersToSign: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames
    .map((name) => `${name}:${headersToSign[name]!.trim()}\n`)
    .join("");
  const signedHeaders = sortedNames.join(";");

  // Our requests carry no query string. If that ever changes, the parameters must be encoded
  // and sorted here — the request URL is built from the same helper, so the two cannot diverge.
  const canonicalQuery = "";
  const canonicalRequest = [
    args.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${date}/${args.config.region}/${SERVICE}/aws4_request`;
  const canonicalRequestHash = hex(Buffer.from(canonicalRequest, "utf8"));
  const stringToSign = [ALGORITHM, amzDate, credentialScope, canonicalRequestHash].join("\n");
  const signature = createHmac("sha256", deriveSigningKey(args.config, date))
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: url.toString(),
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization:
        `${ALGORITHM} Credential=${args.config.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    canonicalRequestHash,
    stringToSign,
    credentialScope,
    signedHeaders,
    signature,
    amzDate,
  };
}

// ---------------------------------------------------------------------------
// The two operations the port needs
// ---------------------------------------------------------------------------

/**
 * Reads one object from a bucket whose configuration the caller already holds.
 *
 * Exported so a second bucket (the audit anchor) can use the same signing without re-reading
 * `STORAGE_*` and without a second implementation of SigV4.
 */
export async function s3Get(
  cfg: S3Config,
  storageKey: string,
  options: { now?: Date } = {},
): Promise<Uint8Array | null> {
  if (!isAcceptableKey(storageKey)) return null;

  try {
    const signed = signRequest({
      method: "GET",
      url: objectUrl(cfg, storageKey),
      body: EMPTY_PAYLOAD,
      now: options.now ?? new Date(),
      config: cfg,
    });
    const response = await fetch(signed.url, { method: "GET", headers: signed.headers });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength === 0 ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Writes one object to a bucket whose configuration the caller already holds.
 *
 * `false` for a refused key or any non-2xx, and for a transport failure. Nothing here retries: a
 * proof upload is a user action with an answer of its own, and the boot check is what stops a
 * misconfigured driver from accepting writes it cannot complete.
 */
export async function s3Put(
  cfg: S3Config,
  storageKey: string,
  contents: Uint8Array,
  options: { now?: Date } = {},
): Promise<boolean> {
  if (!isAcceptableKey(storageKey)) return false;

  try {
    const body = Buffer.from(contents);
    const signed = signRequest({
      method: "PUT",
      url: objectUrl(cfg, storageKey),
      body,
      now: options.now ?? new Date(),
      config: cfg,
    });
    const response = await fetch(signed.url, {
      method: "PUT",
      headers: { ...signed.headers, "content-type": "application/octet-stream" },
      body,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Deletes one object (or returns `true` for a key that was never there — S3 answers `204`).
 *
 * Not part of the storage port: a proof or an invoice PDF is evidence and nothing deletes one.
 * It exists for `scripts/storage-probe.ts`, so an interop check against a real bucket can take
 * its own test objects away again instead of leaving litter in the owner's storage.
 */
export async function s3Delete(
  cfg: S3Config,
  storageKey: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  if (!isAcceptableKey(storageKey)) return false;

  try {
    const signed = signRequest({
      method: "DELETE",
      url: objectUrl(cfg, storageKey),
      body: EMPTY_PAYLOAD,
      now: options.now ?? new Date(),
      config: cfg,
    });
    const response = await fetch(signed.url, { method: "DELETE", headers: signed.headers });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}

/** The files bucket, read from the environment at call time. See `storage.ts` for the port. */
export async function s3ReadObject(
  storageKey: string,
  options: { now?: Date } = {},
): Promise<Uint8Array | null> {
  const cfg = loadS3Config();
  if (!cfg) return null;
  return s3Get(cfg, storageKey, options);
}

/** The files bucket, read from the environment at call time. See `storage.ts` for the port. */
export async function s3WriteObject(
  storageKey: string,
  contents: Uint8Array,
  options: { now?: Date } = {},
): Promise<boolean> {
  const cfg = loadS3Config();
  if (!cfg) return false;
  return s3Put(cfg, storageKey, contents, options);
}
