/**
 * Private object storage for payment proofs (FILES_AND_PDF §5).
 *
 * v1 stores objects in a **private local directory** rather than a bucket: the provider
 * decision is still open (OPEN-016) and nothing may depend on a bucket that does not exist
 * yet. A storage key is opaque (`files.storage_key`), so swapping this adapter for an
 * S3-compatible one later is a change to this file alone.
 *
 * The one rule that matters here is **path safety**. A storage key is a database value, and
 * it is treated as hostile: an absolute path, a `..` segment, a backslash, a NUL, or anything
 * that resolves outside the configured root is refused. Refusal is `null`, never an
 * exception — the caller's honest answer is "this object cannot be read", which is exactly
 * what `FILES_AND_PDF §8` ("object missing but row exists") expects it to report.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Keys longer than this cannot be ours; refusing early keeps the checks cheap. */
const MAX_KEY_LENGTH = 512;

/** The directory objects live in. Unset ⇒ `var/files` under the process working directory. */
function storageRoot(): string {
  const configured = process.env["FILES_DIR"]?.trim();
  return resolve(configured && configured.length > 0 ? configured : "var/files");
}

/**
 * True when the storage root exists and is a directory.
 *
 * This is "can this deployment read objects at all", not "is `FILES_DIR` set": a caller uses
 * it to tell *"storage is not set up here"* from *"the object is missing"*, which are
 * different problems with different answers for the owner.
 */
export function storageIsConfigured(): boolean {
  const root = storageRoot();
  try {
    return existsSync(root) && statSync(root).isDirectory();
  } catch {
    return false;
  }
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
 * Writes one stored object, creating its directory.
 *
 * The object is written to a sibling temp key and then **renamed** into place, because a
 * rename within a directory is atomic: a reader (or a crash) can never observe a half-written
 * PDF, and `readStoredFile` never has to reason about a partial file
 * (FILES_AND_PDF §8, "upload interrupted").
 *
 * The key is validated by the same rules as a read — a key we would refuse to read is a key
 * we refuse to write, so nothing can be stored somewhere the read path cannot reach.
 * Returns `false` rather than throwing for an unwritable key or an I/O failure, matching
 * `readStoredFile`: the caller's honest answer is "this could not be stored".
 */
export async function writeStoredFile(storageKey: string, contents: Uint8Array): Promise<boolean> {
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
