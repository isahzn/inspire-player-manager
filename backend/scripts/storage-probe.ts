/**
 * Storage interop probe — proves the S3 driver against a **real** S3-compatible server.
 *
 *   npm run storage:probe                    # the files bucket, from STORAGE_*
 *   npm run storage:probe -- --anchor        # the audit anchor bucket, from AUDIT_ANCHOR_*
 *
 * Why this is a script and not a test: a test that silently skips when no bucket is configured is
 * a test that reports green while proving nothing — the exact failure mode `job_runs` records
 * `skipped` for. This is a check a person runs deliberately, it says plainly which server it
 * spoke to, and it exits non-zero when anything fails, so it can be a release-gate step
 * (DEPLOYMENT §5) rather than a claim.
 *
 * What it proves, and why each check is here:
 *
 *  1. the configuration resolves, and reports which bucket and host (never a credential);
 *  2. a **1.5 MB** object round-trips byte-for-byte — the size of a scanned bank receipt, so the
 *     body handling is exercised at a realistic size rather than with a few bytes;
 *  3. a missing object reads as `null`, which is the driver's documented answer for "cannot read
 *     this" rather than an error;
 *  4. hostile keys are refused **before** a request is made;
 *  5. a request signed with the **wrong secret** is rejected by the server, and an unsigned
 *     request too. This is the check that gives the others their meaning: a server that accepted
 *     a forged signature would make check 2 prove nothing about the signing code;
 *  6. the objects this run created are deleted again, so an operator can point it at the real
 *     production bucket without leaving litter in it.
 *
 * The keys it writes all live under `probe/`, and it prints them. It never deletes anything it
 * did not create: the delete list is built from the keys this run wrote.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import {
  STORAGE_ENV_NAMES,
  isAcceptableKey,
  loadS3Config,
  objectUrl,
  s3Delete,
  s3Get,
  s3Put,
  signRequest,
  type S3Config,
  type S3EnvNames,
} from "../src/files/storage-s3.js";
import { anchorEnvNames, anchorFallbackNames } from "../src/ops/audit-anchor.js";

config();

const useAnchor = process.argv.includes("--anchor");
const names: S3EnvNames = useAnchor ? anchorEnvNames : STORAGE_ENV_NAMES;
const fallbacks: Partial<S3EnvNames> | null = useAnchor ? anchorFallbackNames : null;
const label = useAnchor ? "the audit anchor bucket" : "the files bucket";

interface Check {
  ok: boolean;
  label: string;
  extra?: string;
}

const checks: Check[] = [];
const check = (ok: boolean, label: string, extra?: string) => {
  checks.push({ ok, label, extra });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}\n`);
};

async function main(): Promise<void> {
  const cfg = loadS3Config(process.env, names, fallbacks);
  if (!cfg) {
    // Not a pass and not a silent skip: with nothing configured there is nothing to prove, and
    // exiting 2 keeps "the probe did not run" distinguishable from "the probe passed".
    process.stdout.write(
      `${names.endpoint}, ${names.bucket}, ${names.accessKeyId} and ${names.secretAccessKey} ` +
        `must all be set to probe ${label}.\n` +
        `Nothing was checked. This is exit 2, not a pass.\n`,
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `Probing ${label}: bucket ${cfg.bucket} at ${new URL(cfg.endpoint).host} ` +
      `(region ${cfg.region}${cfg.forcePathStyle ? ", path-style" : ", virtual-host style"}` +
      `${cfg.prefix ? `, prefix ${cfg.prefix}` : ""}).\n` +
      "Credentials are never printed.\n\n",
  );

  const runPrefix = `probe/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const written: string[] = [];

  // --- 1. a realistic object -----------------------------------------------------------------
  const key = `${runPrefix}/receipt-sized.bin`;
  const body = new Uint8Array(1_500_000);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 31) % 256;

  const wrote = await s3Put(cfg, key, body);
  if (wrote) written.push(key);
  check(wrote, `PUT ${key} (1.5 MB)`);

  if (wrote) {
    const read = await s3Get(cfg, key);
    const identical =
      read !== null &&
      read.byteLength === body.byteLength &&
      read.every((byte, index) => byte === body[index]);
    check(
      identical,
      "the object reads back byte-for-byte identical",
      read ? `${read.byteLength} bytes` : "no bytes returned",
    );
  } else {
    check(false, "the object reads back byte-for-byte identical", "skipped: the write failed");
  }

  // --- 2. a missing object is null, not an error ---------------------------------------------
  check(
    (await s3Get(cfg, `${runPrefix}/never-written.bin`)) === null,
    "a missing object reads as null",
  );

  // --- 3. hostile keys never reach the bucket -------------------------------------------------
  const refused =
    !isAcceptableKey("../escape.bin") &&
    !isAcceptableKey("a//b.bin") &&
    !isAcceptableKey("C:/windows.bin") &&
    !isAcceptableKey("a\\b.bin");
  check(refused, "a hostile key is refused before any request is made");
  check((await s3Put(cfg, "../escape.bin", new Uint8Array([1]))) === false, "…and on write too");

  // --- 4. the server really verifies the signature ---------------------------------------------
  const forgedBody = new Uint8Array([9, 9, 9]);
  const forgedKey = `${runPrefix}/forged.bin`;
  const forged = signRequest({
    method: "PUT",
    url: objectUrl(cfg, forgedKey),
    body: forgedBody,
    now: new Date(),
    config: { ...cfg, secretAccessKey: `${cfg.secretAccessKey}-wrong` },
  });
  const forgedResponse = await fetch(forged.url, {
    method: "PUT",
    headers: { ...forged.headers, "content-type": "application/octet-stream" },
    body: forgedBody,
  });
  check(
    !forgedResponse.ok,
    "a request signed with the wrong secret is rejected",
    `HTTP ${forgedResponse.status}`,
  );
  check(
    (await s3Get(cfg, forgedKey)) === null,
    "the forged object is not in the bucket",
  );

  const anon = await fetch(objectUrl(cfg, key), { method: "GET" });
  check(!anon.ok, "an unsigned GET is rejected", `HTTP ${anon.status}`);

  // --- 5. clean up after ourselves -------------------------------------------------------------
  let removed = 0;
  for (const created of written) {
    if (await s3Delete(cfg, created)) removed += 1;
  }
  check(
    removed === written.length,
    `the ${written.length} object(s) this run created were deleted again`,
  );

  const failed = checks.filter((entry) => !entry.ok).length;
  process.stdout.write(
    `\nSUMMARY ${checks.length - failed}/${checks.length} passed` +
      `${failed > 0 ? ` — ${failed} FAILED` : ""}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
