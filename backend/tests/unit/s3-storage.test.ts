/**
 * Unit coverage for the S3-compatible storage driver (`src/files/storage-s3.ts`).
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 *
 * Proved here:
 *  - the crypto primitives the signing chain is built from, against **published** vectors —
 *    SHA-256 of the empty payload (the value S3 requires in `x-amz-content-sha256`), SHA-256 of
 *    "abc" (NIST), and HMAC-SHA256 of RFC 4231 test case 1. If the hash or the HMAC were wrong,
 *    every one of these fails;
 *  - the **shape** of the canonical request for a fixed input, written out literally below from
 *    the specification rather than derived from the implementation;
 *  - that `signRequest` agrees with a **second, independent** implementation of Signature
 *    Version 4 written in this file straight from the specification (method, canonical URI,
 *    query string, canonical headers, signed headers, payload hash, then the string to sign and
 *    the derived signing key);
 *  - that a single changed input — one byte of the body, one second of the clock, a different
 *    region, a different secret — changes the signature, and that the same input is always the
 *    same signature;
 *  - the key-refusal rules, the environment handling of `loadS3Config`/`s3Configured`/
 *    `s3StatusDetail`, and the addressing styles `objectUrl` produces;
 *  - the two operations' behaviour against a stubbed `fetch` (200 → bytes, 404 → null,
 *    200 → true, 500 → false, refused key → no request at all).
 *
 * **NOT proved here: interoperability with a real bucket.** The AWS documentation's end-to-end
 * `AKIDEXAMPLE` example signature and its published derived signing key could not be reproduced
 * from memory with the confidence an assertion requires, and a guessed constant would be a claim
 * of verification that this session did not earn. The second implementation below is a
 * spec-conformance cross-check, not a third-party witness. **The first production write must be
 * confirmed against MinIO or R2** (and `STORAGE_DRIVER=s3` must be exercised once) before this
 * driver is trusted with proofs.
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  amzTimestamp,
  deriveSigningKey,
  isAcceptableKey,
  loadS3Config,
  objectUrl,
  s3Configured,
  s3ReadObject,
  s3StatusDetail,
  s3WriteObject,
  signRequest,
  type S3Config,
} from "../../src/files/storage-s3.js";

// ---------------------------------------------------------------------------
// Published vectors
// ---------------------------------------------------------------------------

/** SHA-256 of the empty input — the exact value S3 expects in `x-amz-content-sha256` for a GET. */
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** SHA-256 of "abc" (NIST / RFC 6234). */
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
/** HMAC-SHA256, RFC 4231 test case 1: key = 0x0b × 20, data = "Hi There". */
const RFC4231_KEY = Buffer.alloc(20, 0x0b);
const RFC4231_MAC = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";

describe("the primitives the signing chain rests on (published vectors)", () => {
  it("hashes the empty payload the way S3 requires", () => {
    // Asserted through the driver, not through Node: this is the value the request will carry.
    const signed = signRequest({
      method: "GET",
      url: "https://example.com/bucket/key.pdf",
      body: new Uint8Array(0),
      now: new Date("2015-08-30T12:36:00Z"),
      config: config(),
    });
    expect(signed.headers["x-amz-content-sha256"]).toBe(SHA256_EMPTY);
    expect(signed.canonicalRequest.endsWith(SHA256_EMPTY)).toBe(true);
  });

  it("matches the NIST SHA-256 and RFC 4231 HMAC vectors", () => {
    // The two primitives `signRequest` is built from. A wrong digest or a wrong HMAC cannot
    // produce a correct signature, so these pin the foundations even though the end-to-end
    // example is not asserted.
    expect(createHash("sha256").update("abc").digest("hex")).toBe(SHA256_ABC);
    expect(createHmac("sha256", RFC4231_KEY).update("Hi There").digest("hex")).toBe(RFC4231_MAC);
  });
});

// ---------------------------------------------------------------------------
// A second implementation, written from the specification
// ---------------------------------------------------------------------------

/**
 * Signature Version 4, re-derived from the specification rather than shared with the driver.
 *
 * This is a cross-check, not an oracle: both implementations come from the same reading. It
 * catches the mistakes that are easy to make and invisible in a self-consistent signature —
 * a missing blank line, headers in the wrong order, the wrong key chain — because those differ
 * between two honest attempts at the same text.
 */
function referenceSignature(args: {
  method: string;
  url: string;
  body: Uint8Array;
  now: Date;
  config: S3Config;
}): string {
  const url = new URL(args.url);
  const iso = args.now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const amzDate = `${date}T${iso.slice(11, 19).replace(/:/g, "")}Z`;

  const sha256 = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");

  const payloadHash = sha256(args.body);
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest =
    `${args.method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${date}/${args.config.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;

  const hmac = (key: string | Buffer, data: string) =>
    createHmac("sha256", key).update(data, "utf8").digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${args.config.secretAccessKey}`, date), args.config.region), "s3"),
    "aws4_request",
  );
  return hmac(signingKey, stringToSign).toString("hex");
}

function config(overrides: Partial<S3Config> = {}): S3Config {
  return {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "inspire",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    forcePathStyle: false,
    prefix: null,
    ...overrides,
  };
}

describe("signRequest — canonical request and signature", () => {
  it("builds the canonical request in the documented shape, spelled out here", () => {
    const at = new Date("2015-08-30T12:36:00Z");
    const signed = signRequest({
      method: "GET",
      url: "https://iam.example.com/bucket/key.pdf",
      body: new Uint8Array(0),
      now: at,
      config: config({ region: "us-east-1" }),
    });

    // Written literally, not composed: `HTTPMethod \n CanonicalURI \n CanonicalQueryString \n
    // CanonicalHeaders \n SignedHeaders \n HashedPayload`, where the canonical headers block
    // itself ends in a newline (which is why there is a blank line before the signed headers).
    expect(signed.canonicalRequest).toBe(
      "GET\n" +
        "/bucket/key.pdf\n" +
        "\n" +
        "host:iam.example.com\n" +
        `x-amz-content-sha256:${SHA256_EMPTY}\n` +
        "x-amz-date:20150830T123600Z\n" +
        "\n" +
        "host;x-amz-content-sha256;x-amz-date\n" +
        SHA256_EMPTY,
    );
    expect(signed.signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
    expect(signed.amzDate).toBe("20150830T123600Z");
    expect(signed.credentialScope).toBe("20150830/us-east-1/s3/aws4_request");
    expect(signed.stringToSign.startsWith("AWS4-HMAC-SHA256\n20150830T123600Z\n")).toBe(true);
  });

  it("agrees with the independent implementation for several inputs", () => {
    const cases: { method: "GET" | "PUT"; key: string; body: Uint8Array; now: Date; cfg: S3Config }[] = [
      {
        method: "GET",
        key: "invoices/2026/a.pdf",
        body: new Uint8Array(0),
        now: new Date("2026-10-14T09:31:07Z"),
        cfg: config(),
      },
      {
        method: "PUT",
        key: "proofs/0192a000/x.pdf",
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        now: new Date("2026-10-14T09:31:07Z"),
        cfg: config({ forcePathStyle: true, prefix: "academy" }),
      },
      {
        method: "PUT",
        key: "receipts/2026/receipt \u0d9a.pdf",
        body: new Uint8Array([1, 2, 3, 250, 251]),
        now: new Date("2025-12-31T23:59:59Z"),
        cfg: config({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com" }),
      },
    ];

    for (const testCase of cases) {
      const url = objectUrl(testCase.cfg, testCase.key);
      const signed = signRequest({
        method: testCase.method,
        url,
        body: testCase.body,
        now: testCase.now,
        config: testCase.cfg,
      });
      const expected = referenceSignature({
        method: testCase.method,
        url,
        body: testCase.body,
        now: testCase.now,
        config: testCase.cfg,
      });
      expect(signed.signature, testCase.key).toBe(expected);
    }
  });

  it("is deterministic, and changes when any single input changes", () => {
    const base = {
      method: "PUT" as const,
      url: "https://example.com/bucket/x.pdf",
      body: new Uint8Array([1, 2, 3]),
      now: new Date("2026-10-14T09:31:07Z"),
      config: config(),
    };
    const signature = (patch: Partial<typeof base> = {}) =>
      signRequest({ ...base, ...patch }).signature;

    const original = signature();
    expect(signature()).toBe(original);
    // One byte of the payload.
    expect(signature({ body: new Uint8Array([1, 2, 4]) })).not.toBe(original);
    // One second of the clock.
    expect(signature({ now: new Date("2026-10-14T09:31:08Z") })).not.toBe(original);
    // A different region, a different service secret.
    expect(signature({ config: config({ region: "eu-west-1" }) })).not.toBe(original);
    expect(signature({ config: config({ secretAccessKey: "another-secret" }) })).not.toBe(original);
    // A different bucket in the host.
    expect(signature({ url: "https://other.example.com/bucket/x.pdf" })).not.toBe(original);
  });

  it("derives a 32-byte signing key that depends on secret, date, region and service", () => {
    const cfg = config();
    const key = deriveSigningKey(cfg, "20261014");
    expect(key.byteLength).toBe(32);
    expect(deriveSigningKey(cfg, "20261014").equals(key)).toBe(true);
    expect(deriveSigningKey(cfg, "20261015").equals(key)).toBe(false);
    expect(deriveSigningKey(config({ region: "eu-west-1" }), "20261014").equals(key)).toBe(false);
    expect(
      deriveSigningKey(config({ secretAccessKey: "other" }), "20261014").equals(key),
    ).toBe(false);
  });

  it("puts the credential and the signed headers in the Authorization header", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.com/bucket/x.pdf",
      body: new Uint8Array(0),
      now: new Date("2026-10-14T09:31:07Z"),
      config: config({ accessKeyId: "AKIDEXAMPLE" }),
    });
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261014/us-east-1/s3/aws4_request, " +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signed.signature}`,
    );
    // The secret is never in a header, and `host` is never sent by us — the runtime derives it.
    expect(JSON.stringify(signed.headers)).not.toContain("wJalrXUtnFEMI");
    expect(signed.headers["host"]).toBeUndefined();
  });

  it("formats the basic-format timestamp", () => {
    expect(amzTimestamp(new Date("2026-01-02T03:04:05.678Z"))).toEqual({
      date: "20260102",
      amzDate: "20260102T030405Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

describe("objectUrl — addressing style, prefix and encoding", () => {
  it("virtual-host style by default, path style on request", () => {
    expect(objectUrl(config(), "invoices/2026/a.pdf")).toBe(
      "https://inspire.s3.example.com/invoices/2026/a.pdf",
    );
    expect(objectUrl(config({ forcePathStyle: true }), "invoices/2026/a.pdf")).toBe(
      "https://s3.example.com/inspire/invoices/2026/a.pdf",
    );
  });

  it("joins a prefix exactly once, with or without a trailing slash", () => {
    const expected = "https://inspire.s3.example.com/academy/invoices/a.pdf";
    expect(objectUrl(config({ prefix: "academy" }), "invoices/a.pdf")).toBe(expected);
    expect(objectUrl(config({ prefix: "academy/" }), "invoices/a.pdf")).toBe(expected);
  });

  it("percent-encodes per RFC 3986 — spaces, parentheses and non-Latin scripts", () => {
    expect(objectUrl(config(), "receipts/a b.pdf")).toBe(
      "https://inspire.s3.example.com/receipts/a%20b.pdf",
    );
    expect(objectUrl(config(), "receipts/a(1)'x.pdf")).toBe(
      "https://inspire.s3.example.com/receipts/a%281%29%27x.pdf",
    );
    // Sinhala: the byte sequence for U+0D9A, not the raw character and not a lossy substitute.
    expect(objectUrl(config(), "receipt \u0d9a.pdf")).toBe(
      "https://inspire.s3.example.com/receipt%20%E0%B6%9A.pdf",
    );
  });
});

// ---------------------------------------------------------------------------
// Key refusal
// ---------------------------------------------------------------------------

describe("isAcceptableKey — a storage key is hostile input", () => {
  it("accepts the keys this codebase mints", () => {
    expect(isAcceptableKey("invoices/2026/0192a000/x.pdf")).toBe(true);
    expect(isAcceptableKey("branding/logo/0192a000.png")).toBe(true);
    expect(isAcceptableKey("a b/c d.pdf")).toBe(true);
  });

  it("refuses an escape, a separator hidden in the key, or a path we never wrote", () => {
    expect(isAcceptableKey("../../etc/passwd")).toBe(false);
    expect(isAcceptableKey("invoices/../secrets/x.pdf")).toBe(false);
    expect(isAcceptableKey("invoices/./x.pdf")).toBe(false);
    expect(isAcceptableKey("invoices//x.pdf")).toBe(false);
    expect(isAcceptableKey("/etc/passwd")).toBe(false);
    expect(isAcceptableKey("C:/windows/x.pdf")).toBe(false);
    expect(isAcceptableKey("invoices\\x.pdf")).toBe(false);
    expect(isAcceptableKey("invoices/x\0.pdf")).toBe(false);
    expect(isAcceptableKey("")).toBe(false);
    expect(isAcceptableKey("a".repeat(513))).toBe(false);
    // Exactly at the ceiling is fine.
    expect(isAcceptableKey("a".repeat(512))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORAGE_KEYS = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_PREFIX",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of STORAGE_KEYS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of STORAGE_KEYS) {
    const previous = saved[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  vi.unstubAllGlobals();
});

function setStorageEnv(overrides: Partial<Record<(typeof STORAGE_KEYS)[number], string>> = {}): void {
  process.env["STORAGE_ENDPOINT"] = "https://s3.example.com";
  process.env["STORAGE_BUCKET"] = "inspire";
  process.env["STORAGE_ACCESS_KEY_ID"] = "AKIDEXAMPLE";
  process.env["STORAGE_SECRET_ACCESS_KEY"] = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
}

describe("configuration", () => {
  it("is unconfigured with nothing set, and names every variable that is missing", () => {
    expect(s3Configured()).toBe(false);
    expect(loadS3Config()).toBeNull();
    const detail = s3StatusDetail();
    expect(detail.startsWith("Bucket storage is not configured:")).toBe(true);
    expect(detail).toContain("STORAGE_ENDPOINT");
    expect(detail).toContain("STORAGE_BUCKET");
    expect(detail).toContain("STORAGE_ACCESS_KEY_ID");
    expect(detail).toContain("STORAGE_SECRET_ACCESS_KEY");
  });

  it("names each missing variable in turn rather than reporting a generic failure", () => {
    setStorageEnv();
    delete process.env["STORAGE_BUCKET"];
    expect(s3StatusDetail()).toContain("STORAGE_BUCKET");
    delete process.env["STORAGE_ACCESS_KEY_ID"];
    expect(s3StatusDetail()).toContain("STORAGE_ACCESS_KEY_ID");
    delete process.env["STORAGE_SECRET_ACCESS_KEY"];
    expect(s3StatusDetail()).toContain("STORAGE_SECRET_ACCESS_KEY");
    expect(s3Configured()).toBe(false);
  });

  it("refuses an endpoint that is not an http(s) URL", () => {
    setStorageEnv({ STORAGE_ENDPOINT: "s3.example.com" });
    expect(s3Configured()).toBe(false);
    expect(s3StatusDetail()).toContain("not an http(s) URL");
  });

  it("reads the configuration, defaults the region, and never exposes the secret", () => {
    setStorageEnv({ STORAGE_PREFIX: "academy", STORAGE_FORCE_PATH_STYLE: "true" });
    expect(s3Configured()).toBe(true);
    expect(loadS3Config()).toEqual({
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "inspire",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      forcePathStyle: true,
      prefix: "academy",
    });
    const detail = s3StatusDetail();
    expect(detail).toContain("inspire");
    expect(detail).toContain("s3.example.com");
    expect(detail).toContain("path-style");
    expect(detail).not.toContain("wJalrXUtnFEMI");
    expect(detail).not.toContain("AKIDEXAMPLE");
  });

  it("reads the environment lazily, so a rotated credential is picked up", () => {
    setStorageEnv();
    expect(loadS3Config()?.accessKeyId).toBe("AKIDEXAMPLE");
    process.env["STORAGE_ACCESS_KEY_ID"] = "ROTATED";
    expect(loadS3Config()?.accessKeyId).toBe("ROTATED");
  });
});

// ---------------------------------------------------------------------------
// The two operations, against a stubbed transport
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stubFetch(respond: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; headers?: unknown }) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return respond();
  });
  return calls;
}

describe("s3ReadObject / s3WriteObject", () => {
  it("returns the bytes for a 200, and signs with the loaded configuration", async () => {
    setStorageEnv();
    const calls = stubFetch(() => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));

    const bytes = await s3ReadObject("invoices/2026/a.pdf", {
      now: new Date("2026-10-14T09:31:07Z"),
    });
    expect(bytes && Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://inspire.s3.example.com/invoices/2026/a.pdf");
    expect(calls[0]!.headers["authorization"]).toContain("Credential=AKIDEXAMPLE/");
    expect(calls[0]!.headers["x-amz-content-sha256"]).toBe(SHA256_EMPTY);
  });

  it("returns null for a 404, a 403 and an empty object — never a throw", async () => {
    setStorageEnv();
    for (const status of [404, 403, 500]) {
      stubFetch(() => new Response("nope", { status }));
      expect(await s3ReadObject("invoices/2026/a.pdf")).toBeNull();
      vi.unstubAllGlobals();
    }
    stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    // An empty object is indistinguishable from a real empty file, so it is reported as missing.
    expect(await s3ReadObject("invoices/2026/a.pdf")).toBeNull();
  });

  it("returns null rather than throwing when the transport fails", async () => {
    setStorageEnv();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await s3ReadObject("invoices/2026/a.pdf")).toBeNull();
    expect(await s3WriteObject("invoices/2026/a.pdf", new Uint8Array([1]))).toBe(false);
  });

  it("writes with PUT and reports success only on a 2xx", async () => {
    setStorageEnv({ STORAGE_FORCE_PATH_STYLE: "true" });
    const ok = stubFetch(() => new Response(null, { status: 200 }));
    expect(await s3WriteObject("proofs/x.pdf", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(ok[0]!.method).toBe("PUT");
    expect(ok[0]!.url).toBe("https://s3.example.com/inspire/proofs/x.pdf");
    expect(ok[0]!.headers["content-type"]).toBe("application/octet-stream");

    vi.unstubAllGlobals();
    stubFetch(() => new Response("denied", { status: 403 }));
    expect(await s3WriteObject("proofs/x.pdf", new Uint8Array([1]))).toBe(false);
  });

  it("makes no request at all for a refused key or an unconfigured bucket", async () => {
    setStorageEnv();
    const calls = stubFetch(() => new Response(null, { status: 200 }));
    expect(await s3ReadObject("../../etc/passwd")).toBeNull();
    expect(await s3WriteObject("invoices\\x.pdf", new Uint8Array([1]))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await s3ReadObject("invoices/../x.pdf")).toBeNull();

    // Unconfigured: no credentials, so nothing is signed and nothing is sent.
    for (const name of STORAGE_KEYS) delete process.env[name];
    expect(await s3ReadObject("invoices/2026/a.pdf")).toBeNull();
    expect(await s3WriteObject("invoices/2026/a.pdf", new Uint8Array([1]))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
