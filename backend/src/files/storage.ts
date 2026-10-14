/**
 * Private object storage for proofs, documents and the logo (FILES_AND_PDF §5).
 *
 * One port, two drivers, chosen by `STORAGE_DRIVER`:
 *
 *  - `local` (default) — a private directory under `FILES_DIR`. This is the v1 behaviour and
 *    stays the default because nothing may depend on a bucket that does not exist yet.
 *  - `s3` — an S3-compatible bucket (R2/S3/Supabase Storage/MinIO), in `storage-s3.ts`. It is
 *    the production driver (DEPLOYMENT §4): proofs are the one artefact that cannot be
 *    re-created, so a real deployment needs off-host storage with versioning.
 *
 * `s3` is chosen only when its five variables are present; a half-configured bucket is a
 * **startup failure** (`assertStorageUsable`), never a silent fall back to a local directory
 * that nothing backs up — the failure mode that would lose proofs without anyone noticing.
 *
 * The one rule that matters in the local driver is **path safety**. A storage key is a database
 * value, and it is treated as hostile: an absolute path, a `..` segment, a backslash, a NUL, or
 * anything that resolves outside the configured root is refused. Refusal is `null`, never an
 * exception — the caller's honest answer is "this object cannot be read", which is exactly what
 * `FILES_AND_PDF §8` ("object missing but row exists") expects it to report.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "../config.js";
import { s3Configured, s3ReadObject, s3StatusDetail, s3WriteObject } from "./storage-s3.js";

/** Keys longer than this cannot be ours; refusing early keeps the checks cheap. */
const MAX_KEY_LENGTH = 512;

/**
 * The configured driver.
 *
 * Read from the environment **at call time**, falling back to the value captured at import.
 * The integration tests point `FILES_DIR` at a scratch directory after the module graph is
 * loaded, and a frozen-at-boot read would silently store objects somewhere the test's own
 * assertions are not looking (which is exactly how the PRF-04 regression was found).
 */
function driverName(): "local" | "s3" {
  const raw = process.env["STORAGE_DRIVER"]?.trim() || config.storage.driver;
  return raw === "s3" ? "s3" : "local";
}

/** True when the deployment is configured for the bucket driver. */
export function usingBucket(): boolean {
  return driverName() === "s3";
}

/** The directory objects live in. Unset ⇒ `var/files` under the process working directory. */
function storageRoot(): string {
  const configured = process.env["FILES_DIR"]?.trim() || config.storage.filesDir;
  return resolve(configured && configured.length > 0 ? configured : "var/files");
}

/**
 * True when this deployment can read objects at all.
 *
 * This is "is the configured backend usable", not "is a variable set": a caller uses it to tell
 * *"storage is not set up here"* from *"the object is missing"*, which are different problems
 * with different answers for the owner.
 */
export function storageIsConfigured(): boolean {
  if (usingBucket()) return s3Configured();
  const root = storageRoot();
  try {
    return existsSync(root) && statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refuses to start on a storage configuration that cannot work.
 *
 * Called by the API and the worker at boot (BACKEND_BUILD_GUIDE §8: fail fast). The case it
 * exists for is `STORAGE_DRIVER=s3` with a missing bucket or credential: that must stop the
 * process, because the alternative — running happily and writing proofs where nobody will find
 * them — is the one failure this project cannot recover from.
 */
export function assertStorageUsable(): void {
  if (driverName() === "s3" && !s3Configured()) {
    throw new Error(
      "STORAGE_DRIVER=s3 but the bucket is not configured: set STORAGE_ENDPOINT, " +
        "STORAGE_REGION, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY",
    );
  }
}

/** What SYS-03 reports for storage, in the operator's terms rather than the driver's. */
export interface StorageStatus {
  backend: "local" | "s3";
  configured: boolean;
  detail: string;
}

export function storageStatus(): StorageStatus {
  if (usingBucket()) {
    return {
      backend: "s3",
      configured: s3Configured(),
      detail: s3StatusDetail(),
    };
  }
  const root = storageRoot();
  const configured = storageIsConfigured();
  return {
    backend: "local",
    configured,
    detail: configured
      ? `Private local directory ${root}. Fine for development and staging; a deployment ` +
        "needs an off-host bucket (OPEN-016) because proofs cannot be re-created."
      : `The local storage directory ${root} does not exist yet. It is created on the first write.`,
  };
}

/**
 * Resolves a storage key against the root, or `null` when the key is not one we would ever
 * have written. Every rejection is deliberate:
 *
 *  - absolute paths and drive letters are not keys we mint;
 *  - a backslash is a Windows separator hiding inside a POSIX-looking key;
 *  - `..`, `.` and empty segments mean the key is trying to leave the root;
 *  - a NUL byte truncates paths in lower layers.
 */
function resolveKey(storageKey: string): string | null {
  if (storageKey.length === 0 || storageKey.length > MAX_KEY_LENGTH) return null;
  if (storageKey.includes("\0") || storageKey.includes("\\")) return null;
  if (isAbsolute(storageKey)) return null;

  const segments = storageKey.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  const root = storageRoot();
  const full = resolve(root, storageKey);
  // Belt and braces: even if a segment slipped through the checks above, the resolved path
  // must still be inside the root.
  const rel = relative(root, full);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return full;
}

/**
 * Reads one stored object.
 *
 * Returns `null` for a missing object, an unreadable path, a suspicious key, or any I/O
 * failure. It never throws and never returns partial content: an empty `Uint8Array` would be
 * indistinguishable from a real empty file to the caller, which is worse than an honest
 * "cannot read this".
 */
export async function readStoredFile(storageKey: string): Promise<Uint8Array | null> {
  if (usingBucket()) return s3ReadObject(storageKey);
  const full = resolveKey(storageKey);
  if (full === null) return null;
  try {
    const contents = await readFile(full);
    return contents.byteLength === 0 ? null : contents;
  } catch {
    return null;
  }
}

/**
 * Writes one stored object.
 *
 * The local driver writes to a sibling temp key and then **renames** it into place, because a
 * rename within a directory is atomic: a reader (or a crash) can never observe a half-written
 * PDF, and `readStoredFile` never has to reason about a partial file
 * (FILES_AND_PDF §8, "upload interrupted").
 *
 * The key is validated by the same rules as a read — a key we would refuse to read is a key we
 * refuse to write, so nothing can be stored somewhere the read path cannot reach. Returns
 * `false` rather than throwing for an unwritable key or an I/O failure, matching
 * `readStoredFile`: the caller's honest answer is "this could not be stored".
 */
export async function writeStoredFile(storageKey: string, contents: Uint8Array): Promise<boolean> {
  if (usingBucket()) return s3WriteObject(storageKey, contents);
  const full = resolveKey(storageKey);
  if (full === null) return false;
  // A temp name that cannot collide with a real key: `resolveKey` refuses a `..` segment, so
  // no legitimate key ever ends this way.
  const temporary = join(dirname(full), `.tmp-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dirname(full), { recursive: true });
    await writeFile(temporary, contents);
    await rename(temporary, full);
    return true;
  } catch {
    return false;
  }
}
