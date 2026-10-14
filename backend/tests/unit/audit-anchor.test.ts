/**
 * Unit coverage for the audit anchor upload (`src/ops/audit-anchor.ts`).
 *
 * WHAT THIS FILE PROVES
 *
 *  - the **document is canonical**: the same verification produces the same bytes on every call,
 *    and the bytes contain the head hash, both row bounds and the row's own `created_at`. That is
 *    what makes the object comparable to `audit_anchors.head_hash` later instead of merely
 *    resembling it;
 *  - the **object key is minted for the verification**, so an anchor can never overwrite another
 *    one — the append-only property, asserted by two anchors written a millisecond apart landing
 *    on different keys;
 *  - **unconfigured is `not_configured`, not a failure and not a pass**, and the sentence says
 *    where the verification *is* recorded when there is no bucket;
 *  - **a configured bucket that refuses the write is `failed`**, which is what makes the nightly
 *    job record `failed` rather than a green run whose evidence never left the host;
 *  - the environment chain: `AUDIT_ANCHOR_BUCKET` alone inherits the files bucket's endpoint and
 *    credentials; the anchor's own `AUDIT_ANCHOR_ENDPOINT`/keys override them.
 *
 * `fetch` is stubbed, so no request leaves the process. The interop with a *real* server is
 * `npm run storage:probe` (see the M8 handoff §5), not this file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORAGE_ENV_NAMES } from "../../src/files/storage-s3.js";
import {
  anchorConfigured,
  anchorDocument,
  anchorEnvNames,
  anchorObjectKey,
  anchorStatusDetail,
  readLatestAnchor,
  uploadAuditAnchor,
  type AuditAnchorRecord,
} from "../../src/ops/audit-anchor.js";

const anchor: AuditAnchorRecord = {
  id: "0192f0c1-0000-7000-8000-000000000001",
  verifiedFrom: "1",
  verifiedTo: "4821",
  headHash: "9f2c1b7d0e5a4c3b2a1908070605040302010f0e0d0c0b0a0908070605040302",
  rowsChecked: 4821,
  createdAt: new Date("2026-10-14T04:00:03.412Z"),
};

const ANCHOR_KEYS = Object.values(anchorEnvNames);

/**
 * Every variable this file reads, including the `STORAGE_*` names the anchor may inherit from. They
 * are cleared before each test, so none of these assertions depends on what this machine's `.env`
 * happens to hold — which is how the first version of this file passed a fallback check that the
 * anchor must not have.
 */
const MANAGED_KEYS = [...ANCHOR_KEYS, ...Object.values(STORAGE_ENV_NAMES)];

/** The bucket keys this file sets, saved and restored around each test. */
const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string>): void {
  for (const name of MANAGED_KEYS) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  vi.restoreAllMocks();
});

describe("the anchor document", () => {
  it("is byte-for-byte the same for the same verification", () => {
    const first = anchorDocument(anchor, "Asia/Colombo");
    const second = anchorDocument(anchor, "Asia/Colombo");
    expect(Buffer.from(first).toString("utf8")).toBe(Buffer.from(second).toString("utf8"));
  });

  it("carries the head hash, the window and the row's own verification time", () => {
    const document = JSON.parse(Buffer.from(anchorDocument(anchor, "Asia/Colombo")).toString("utf8"));
    expect(document.headHash).toBe(anchor.headHash);
    expect(document.verifiedFrom).toBe("1");
    expect(document.verifiedTo).toBe("4821");
    expect(document.rowsChecked).toBe(4821);
    expect(document.verifiedAt).toBe("2026-10-14T04:00:03.412Z");
    expect(document.academyTimezone).toBe("Asia/Colombo");
    expect(document.kind).toBe("audit-chain-anchor");
  });

  it("records a different verification differently", () => {
    const changed = anchorDocument({ ...anchor, headHash: "a".repeat(64) }, "Asia/Colombo");
    expect(Buffer.from(changed).toString("utf8")).not.toBe(
      Buffer.from(anchorDocument(anchor, "Asia/Colombo")).toString("utf8"),
    );
  });
});

describe("the object key", () => {
  it("is derived from the anchor, so one anchor can never overwrite another", () => {
    const second: AuditAnchorRecord = { ...anchor, id: "0192f0c1-0000-7000-8000-000000000002" };
    expect(anchorObjectKey(anchor, null)).not.toBe(anchorObjectKey(second, null));
    expect(anchorObjectKey(anchor, null)).toBe(
      "audit-anchor/4821-0192f0c1-0000-7000-8000-000000000001.json",
    );
  });

  it("namespaces under the configured prefix, keeping the anchor namespace", () => {
    expect(anchorObjectKey(anchor, "academy")).toBe(
      "academy/audit-anchor/4821-0192f0c1-0000-7000-8000-000000000001.json",
    );
  });
});

describe("an unconfigured anchor bucket", () => {
  it("is not_configured, and says where the verification is recorded instead", async () => {
    setEnv({});
    const result = await uploadAuditAnchor(anchor, { timezone: "Asia/Colombo" });
    expect(result.status).toBe("not_configured");
    expect(result.detail).toContain("audit_anchors");
    expect(result.detail).toContain("AUDIT_ANCHOR_BUCKET");
    expect(anchorConfigured()).toBe(false);
  });

  it("names the missing variables rather than reporting a generic failure", () => {
    const detail = anchorStatusDetail({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      STORAGE_ENDPOINT: "https://s3.example.com",
      STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
    } as NodeJS.ProcessEnv);
    // The bucket is set and the endpoint and key id are inherited, so the secret is the one thing
    // that is genuinely missing — and it is named.
    expect(detail).toContain("AUDIT_ANCHOR_SECRET_ACCESS_KEY");
    expect(detail).not.toContain("AUDIT_ANCHOR_BUCKET");
    expect(detail).not.toContain("AKIDEXAMPLE");
  });
});

describe("a configured anchor bucket", () => {
  it("uploads the canonical bytes and reports where they landed", async () => {
    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      AUDIT_ANCHOR_ENDPOINT: "https://anchor.example.com",
      AUDIT_ANCHOR_ACCESS_KEY_ID: "anchor-key",
      AUDIT_ANCHOR_SECRET_ACCESS_KEY: "anchor-secret",
      // Explicit, so the assertion below is about the driver's addressing and not about
      // whatever this machine's .env happens to set for the files bucket.
      AUDIT_ANCHOR_FORCE_PATH_STYLE: "true",
    });
    const calls: { url: string; body: Uint8Array | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as Uint8Array | undefined });
      return new Response(null, { status: 200 });
    });

    const result = await uploadAuditAnchor(anchor, { timezone: "Asia/Colombo" });
    expect(result.status).toBe("uploaded");
    expect(result.key).toBe("audit-anchor/4821-0192f0c1-0000-7000-8000-000000000001.json");
    expect(result.detail).toContain("ia-anchor");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://anchor.example.com/ia-anchor/audit-anchor/4821-0192f0c1-0000-7000-8000-000000000001.json",
    );
    const sent = Buffer.from(calls[0]!.body!).toString("utf8");
    expect(sent).toBe(Buffer.from(anchorDocument(anchor, "Asia/Colombo")).toString("utf8"));
  });

  it("is failed when the bucket refuses the upload, and never reports a pass", async () => {
    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      AUDIT_ANCHOR_ENDPOINT: "https://anchor.example.com",
      AUDIT_ANCHOR_ACCESS_KEY_ID: "anchor-key",
      AUDIT_ANCHOR_SECRET_ACCESS_KEY: "anchor-secret",
    });
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));

    const result = await uploadAuditAnchor(anchor, { timezone: "Asia/Colombo" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("refused the upload");
    expect(result.detail).toContain("no off-host record");
  });

  it("is failed when the bucket cannot be reached at all", async () => {
    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      AUDIT_ANCHOR_ENDPOINT: "https://anchor.example.com",
      AUDIT_ANCHOR_ACCESS_KEY_ID: "anchor-key",
      AUDIT_ANCHOR_SECRET_ACCESS_KEY: "anchor-secret",
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("getaddrinfo ENOTFOUND anchor.example.com");
    });

    const result = await uploadAuditAnchor(anchor, { timezone: "Asia/Colombo" });
    expect(result.status).toBe("failed");
  });
});

describe("the environment chain", () => {
  it("inherits the files bucket's endpoint and credentials from the anchor bucket alone", () => {
    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      STORAGE_ENDPOINT: "https://s3.example.com",
      STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
      STORAGE_SECRET_ACCESS_KEY: "files-secret",
      STORAGE_REGION: "eu-west-2",
    });
    expect(anchorConfigured()).toBe(true);
    expect(anchorStatusDetail()).toContain("ia-anchor");
    expect(anchorStatusDetail()).toContain("s3.example.com");
  });

  it("prefers the anchor's own endpoint and keys when both are set", () => {
    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      AUDIT_ANCHOR_ENDPOINT: "https://anchor.example.com",
      AUDIT_ANCHOR_ACCESS_KEY_ID: "anchor-key",
      AUDIT_ANCHOR_SECRET_ACCESS_KEY: "anchor-secret",
      STORAGE_ENDPOINT: "https://s3.example.com",
      STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
      STORAGE_SECRET_ACCESS_KEY: "files-secret",
    });
    const detail = anchorStatusDetail();
    expect(detail).toContain("anchor.example.com");
    expect(detail).not.toContain("s3.example.com");
  });

  it("never inherits the files bucket's own bucket name", () => {
    // The failure this prevents: with STORAGE_BUCKET as the fallback, a deployment that configured
    // only the files bucket would "anchor" into that same bucket, and the tamper-evidence copy
    // would sit inside the storage it is supposed to be independent of.
    setEnv({
      STORAGE_ENDPOINT: "https://s3.example.com",
      STORAGE_BUCKET: "ia-private",
      STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
      STORAGE_SECRET_ACCESS_KEY: "files-secret",
    });
    expect(anchorConfigured()).toBe(false);

    setEnv({
      AUDIT_ANCHOR_BUCKET: "ia-anchor",
      STORAGE_ENDPOINT: "https://s3.example.com",
      STORAGE_BUCKET: "ia-private",
      STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE",
      STORAGE_SECRET_ACCESS_KEY: "files-secret",
    });
    expect(anchorConfigured()).toBe(true);
    expect(anchorStatusDetail()).toContain("ia-anchor");
    expect(anchorStatusDetail()).not.toContain("ia-private");
  });

  it("is not configured when the bucket is named but no credentials exist anywhere", () => {
    setEnv({ AUDIT_ANCHOR_BUCKET: "ia-anchor" });
    expect(anchorConfigured()).toBe(false);
  });
});

describe("readLatestAnchor", () => {
  // `AnyQueryable` is the real client type (the CLIs pass a migrator connection), so a stub has to
  // be cast. Nothing here asserts on the SQL text; the query is exercised for real in the worker
  // integration evidence.
  type Queryable = Parameters<typeof readLatestAnchor>[0];
  const stub = (rows: unknown[]): Queryable => ({ query: async () => ({ rows }) }) as unknown as Queryable;

  it("returns nulls rather than throwing when nothing has ever been anchored", async () => {
    expect(await readLatestAnchor(stub([]))).toEqual({ at: null, headHash: null, verifiedTo: null });
  });

  it("reports the most recent anchor, as text for the bigint row id", async () => {
    const latest = await readLatestAnchor(
      stub([
        { created_at: new Date("2026-10-14T04:00:03.412Z"), head_hash: "abc", verified_to: "4821" },
      ]),
    );
    expect(latest.verifiedTo).toBe("4821");
    expect(latest.headHash).toBe("abc");
    expect(latest.at?.toISOString()).toBe("2026-10-14T04:00:03.412Z");
  });
});
