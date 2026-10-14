/**
 * The audit chain's **external** anchor (DEPLOYMENT §4 `AUDIT_ANCHOR_BUCKET`, §6 "invariant job",
 * §8 "audit-chain verify + anchor").
 *
 * The nightly job recomputes the audit hash chain and records the head hash it verified in
 * `audit_anchors` (0015). That row is what makes "the chain was intact up to row N on date D"
 * answerable — but it sits **in the same database as the rows it attests to**, so an attacker (or
 * a mistake) with write access to that database can rewrite the trail and the anchor together.
 * Uploading the anchor to a bucket the database's operator does not control is what turns the
 * record into evidence: after the fact, the copy in the bucket is a witness the database cannot
 * revise.
 *
 * Three deliberate properties:
 *
 *  - **One object per anchor, named by the anchor's own id, never overwritten.** The upload is
 *    append-only by construction: a second upload of the same anchor writes the same bytes to the
 *    same key, and a *different* hash can never replace an existing object because the key is
 *    minted for the verification, not for the date. There is no `latest.json` pointer for exactly
 *    that reason — a pointer is something a later writer can repoint.
 *  - **Bytes are canonical.** The JSON is serialised field by field in a fixed order, so the same
 *    verification produces the same bytes on any machine, and a hash of the object means
 *    something. `JSON.stringify` on a row object would inherit key order from SQL.
 *  - **Unconfigured is an honest `not_configured`, not a failure and not a pass.** A deployment
 *    without an anchor bucket is a deployment with a smaller audit story; the job says so in its
 *    `detail` rather than reporting a green upload that never happened. A *configured* bucket that
 *    does not accept the write **is** a failure — that is the same rule `assertStorageUsable`
 *    enforces for proofs, and the failure mode it prevents is a deployment that believes it has
 *    off-host tamper evidence and does not.
 */
import {
  STORAGE_ENV_NAMES,
  loadS3Config,
  s3StatusDetail,
  s3Put,
  type S3Config,
  type S3EnvNames,
} from "../files/storage-s3.js";
import { config } from "../config.js";
import type { AnyQueryable } from "../audit.js";

/**
 * The anchor bucket's variable names.
 *
 * The spec froze `AUDIT_ANCHOR_BUCKET` and `_PREFIX`; the endpoint, region and credentials are
 * this implementation's addition (flagged in the M8 handoff §4), because the whole point of the
 * anchor is living somewhere the files bucket's provider does not.
 */
export const anchorEnvNames: S3EnvNames = {
  endpoint: "AUDIT_ANCHOR_ENDPOINT",
  region: "AUDIT_ANCHOR_REGION",
  bucket: "AUDIT_ANCHOR_BUCKET",
  accessKeyId: "AUDIT_ANCHOR_ACCESS_KEY_ID",
  secretAccessKey: "AUDIT_ANCHOR_SECRET_ACCESS_KEY",
  forcePathStyle: "AUDIT_ANCHOR_FORCE_PATH_STYLE",
  prefix: "AUDIT_ANCHOR_PREFIX",
};

/**
 * The transport details the anchor may inherit when it does not name its own: the endpoint,
 * region, credentials and addressing style.
 *
 * **Deliberately not the bucket or the prefix.** Those two are what make this a different bucket,
 * and inheriting them would point the tamper-evidence copy at the very storage it exists to be
 * independent of — a silent failure that would look like a working anchor. So a deployment that
 * sets only `AUDIT_ANCHOR_BUCKET` still gets an off-host copy in a bucket of its own, and one
 * that keeps the anchor in another account sets the endpoint and keys too.
 */
export const anchorFallbackNames: Partial<S3EnvNames> = {
  endpoint: STORAGE_ENV_NAMES.endpoint,
  region: STORAGE_ENV_NAMES.region,
  accessKeyId: STORAGE_ENV_NAMES.accessKeyId,
  secretAccessKey: STORAGE_ENV_NAMES.secretAccessKey,
  forcePathStyle: STORAGE_ENV_NAMES.forcePathStyle,
};

/** The one row the chain verification hands over. Mirrors `audit_anchors` (0015). */
export interface AuditAnchorRecord {
  id: string;
  /** The lowest `audit_logs.id` in the window verified. */
  verifiedFrom: string;
  /** The head row id at verification time. */
  verifiedTo: string;
  /** The head row's `row_hash` — the value a later tamper has to reproduce. */
  headHash: string;
  rowsChecked: number;
  createdAt: Date;
}

export interface AnchorUploadResult {
  status: "uploaded" | "not_configured" | "failed";
  /** Where it landed, when it landed. Never contains a credential. */
  key?: string;
  /** One sentence for `job_runs.detail` and the operator. */
  detail: string;
}

/** True when an anchor bucket is configured well enough to attempt an upload. */
export function anchorConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadS3Config(env, anchorEnvNames, anchorFallbackNames) !== null;
}

/**
 * What SYS-03 and the operator CLIs say about the anchor bucket — naming every missing variable
 * rather than the first, and never a credential.
 */
export function anchorStatusDetail(env: NodeJS.ProcessEnv = process.env): string {
  return s3StatusDetail(env, anchorEnvNames, anchorFallbackNames);
}

/**
 * The bucket key for one anchor: `<prefix>/<verifiedTo>-<id>.json`.
 *
 * The head row id is in the name as well as the anchor's own id, so a listing of the bucket reads
 * as a sequence of "the chain was intact up to here" statements rather than a heap of uuids.
 */
export function anchorObjectKey(anchor: AuditAnchorRecord, prefix: string | null): string {
  const parts = [prefix, "audit-anchor"].filter((part): part is string => Boolean(part));
  return `${parts.join("/")}/${anchor.verifiedTo}-${anchor.id}.json`;
}

/**
 * The canonical bytes of one anchor.
 *
 * Field by field in a fixed order, with the app version and the academy's timezone included: an
 * auditor asks "which build proved this, and in which local day" — and a canonical form is what
 * lets the object's own hash be compared against a `head_hash` later.
 *
 * Exported for the test that asserts the same record always produces the same bytes.
 */
export function anchorDocument(anchor: AuditAnchorRecord, timezone: string): Uint8Array {
  const document = {
    anchorId: anchor.id,
    headHash: anchor.headHash,
    rowsChecked: anchor.rowsChecked,
    verifiedFrom: anchor.verifiedFrom,
    verifiedTo: anchor.verifiedTo,
    verifiedAt: anchor.createdAt.toISOString(),
    academyTimezone: timezone,
    appVersion: config.version,
    service: "inspire-academy",
    kind: "audit-chain-anchor",
  };
  // Two spaces of indentation so a human reading the object in a bucket console can read it.
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/**
 * Uploads one anchor. Never throws: the caller decides what a failure means.
 *
 * `timezone` is passed in rather than read from `config` so the document records the academy's
 * own zone (the worker has it from `academyClock`), not whatever the process defaulted to.
 */
export async function uploadAuditAnchor(
  anchor: AuditAnchorRecord,
  options: { timezone: string; env?: NodeJS.ProcessEnv; now?: Date } = { timezone: "UTC" },
): Promise<AnchorUploadResult> {
  const cfg: S3Config | null = loadS3Config(
    options.env ?? process.env,
    anchorEnvNames,
    anchorFallbackNames,
  );

  if (!cfg) {
    return {
      status: "not_configured",
      detail:
        "No audit anchor bucket is configured, so this verification is recorded only in " +
        "`audit_anchors` — in the same database as the rows it attests to. Set " +
        "AUDIT_ANCHOR_BUCKET (and, if it lives at another provider, AUDIT_ANCHOR_ENDPOINT and " +
        "its credentials) for an off-host witness.",
    };
  }

  const key = anchorObjectKey(anchor, cfg.prefix);
  const uploaded = await s3Put(cfg, key, anchorDocument(anchor, options.timezone), {
    now: options.now,
  });

  if (!uploaded) {
    return {
      status: "failed",
      key,
      detail:
        `The anchor bucket ${cfg.bucket} at ${new URL(cfg.endpoint).host} refused the upload of ` +
        `${key}. The chain was verified locally, but there is no off-host record of it — treat ` +
        "this as a failed audit anchor until the bucket accepts writes again.",
    };
  }

  return {
    status: "uploaded",
    key,
    detail: `Anchored off-host at ${key} in ${cfg.bucket}.`,
  };
}

/**
 * The most recent anchor, for a reporting surface. Read-only, and deliberately not the RLS
 * runtime path: this is called by the worker and the CLIs.
 */
export async function readLatestAnchor(
  client: AnyQueryable,
): Promise<{ at: Date | null; headHash: string | null; verifiedTo: string | null }> {
  const result = await client.query<{
    created_at: Date;
    head_hash: string;
    verified_to: string;
  }>(
    `select created_at, head_hash, verified_to::text as verified_to
       from audit_anchors
      order by created_at desc
      limit 1`,
  );
  const row = result.rows[0];
  if (!row) return { at: null, headHash: null, verifiedTo: null };
  return { at: row.created_at, headHash: row.head_hash, verifiedTo: row.verified_to };
}
