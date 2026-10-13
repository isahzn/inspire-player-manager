/**
 * Unit layer: pure logic only, no database.
 *
 * The TOTP tests assert the **published RFC vectors**, which is the evidence that the
 * in-house implementation is correct rather than merely self-consistent.
 */
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, totp, verifyTotp, encryptSecret, decryptSecret, generateSecret } from "../../src/auth/totp.js";
import { checkPasswordPolicy } from "../../src/auth/password.js";
import { uuidv7 } from "../../src/ids.js";
import { normalizePhone } from "../../src/auth/tokens.js";
import { parseSort } from "../../src/http/validate.js";
import { maskPhone, sanitizeForAudit } from "../../src/audit.js";

describe("TOTP (RFC 4226 / RFC 6238)", () => {
  // The RFCs' shared secret: ASCII "12345678901234567890".
  const SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("base32 round-trips the RFC secret", () => {
    const raw = Buffer.from("12345678901234567890", "ascii");
    expect(base32Encode(raw)).toBe(SECRET_BASE32);
    expect(base32Decode(SECRET_BASE32).toString("ascii")).toBe("12345678901234567890");
  });

  it("reproduces the RFC 4226 HOTP vectors (6 digits)", () => {
    // RFC 4226 Appendix D, counters 0..9.
    const expected = [
      "755224", "287082", "359152", "969429", "338314",
      "254676", "287922", "162583", "399871", "520489",
    ];
    expected.forEach((code, counter) => {
      expect(hotp(SECRET_BASE32, counter)).toBe(code);
    });
  });

  it("reproduces the RFC 6238 TOTP vectors (8 digits)", () => {
    const vectors: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [atSeconds, expected] of vectors) {
      expect(totp(SECRET_BASE32, atSeconds, 8)).toBe(expected);
    }
  });

  it("accepts the current code and rejects a wrong one", () => {
    const secret = generateSecret();
    const now = 1_700_000_000;
    expect(verifyTotp(secret, totp(secret, now), { atSeconds: now })).toBe(true);
    expect(verifyTotp(secret, "000000", { atSeconds: now })).toBe(false);
  });

  it("tolerates one step of clock drift, not two", () => {
    const secret = generateSecret();
    const now = 1_700_000_000;
    const previous = totp(secret, now - 30);
    const twoStepsBack = totp(secret, now - 60);
    expect(verifyTotp(secret, previous, { atSeconds: now })).toBe(true);
    expect(verifyTotp(secret, twoStepsBack, { atSeconds: now })).toBe(false);
  });

  it("rejects malformed codes without throwing", () => {
    const secret = generateSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56"]) {
      expect(verifyTotp(secret, bad)).toBe(false);
    }
  });

  it("encrypts the secret at rest and round-trips it", () => {
    const secret = generateSecret();
    const payload = encryptSecret(secret);
    expect(payload.toString("utf8")).not.toContain(secret);
    expect(decryptSecret(payload)).toBe(secret);
  });

  it("fails to decrypt a tampered payload (GCM authentication)", () => {
    const payload = encryptSecret(generateSecret());
    const last = payload.length - 1;
    payload[last] = payload[last]! ^ 0xff;
    expect(() => decryptSecret(payload)).toThrow();
  });
});

describe("password policy (AUTH §1)", () => {
  it("requires 12+ characters", () => {
    expect(checkPasswordPolicy("short1234567".slice(0, 11), "owner").ok).toBe(false);
    expect(checkPasswordPolicy("twelve-chars", "owner").ok).toBe(true);
  });

  it("refuses the username and common passwords", () => {
    expect(checkPasswordPolicy("owner", "owner").ok).toBe(false);
    expect(checkPasswordPolicy("password123", "owner").ok).toBe(false);
    expect(checkPasswordPolicy("InspireAcademy", "owner").ok).toBe(false);
  });
});

describe("ids", () => {
  it("emits a well-formed UUIDv7 with the version and variant bits set", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // 13th hex digit is the version, and the variant is RFC 4122's 10xx.
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("sorts by time across milliseconds and encodes the timestamp", () => {
    // Within one millisecond the random tail decides order, so the guarantee is
    // across timestamps — which is what a time-ordered key is for.
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(earlier < later).toBe(true);
    // The first 48 bits are the timestamp; compare with the hyphens removed.
    const timestampHex = (1_700_000_000_000).toString(16).padStart(12, "0");
    expect(earlier.replace(/-/g, "").slice(0, 12)).toBe(timestampHex);
  });
});

describe("phone normalization", () => {
  it("normalizes Sri Lankan local numbers to E.164", () => {
    expect(normalizePhone("0771234567")).toBe("+94771234567");
    expect(normalizePhone("+94 77 123 4567")).toBe("+94771234567");
    expect(normalizePhone("94771234567")).toBe("+94771234567");
  });

  it("rejects junk", () => {
    expect(() => normalizePhone("not-a-phone")).toThrow();
    expect(() => normalizePhone("")).toThrow();
  });
});

describe("sort allow-list", () => {
  it("accepts allowed fields and a leading minus for descending", () => {
    expect(parseSort("-dueDate,fullName", ["dueDate", "fullName"])).toEqual([
      { column: "due_date", direction: "desc" },
      { column: "full_name", direction: "asc" },
    ]);
  });

  it("rejects an unknown field with a 422-shaped error (T-SEC-03)", () => {
    try {
      parseSort("balanceMinor; drop table users", ["dueDate"]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("VALIDATION_ERROR");
      expect((err as { status?: number }).status).toBe(422);
    }
  });
});

describe("audit sanitization (SECURITY_AND_PRIVACY §3.5)", () => {
  it("masks phone numbers", () => {
    expect(maskPhone("+94771234567")).toBe("+9477****567");
    expect(maskPhone("1234")).toBe("****");
  });

  it("redacts secrets and masks phones recursively", () => {
    const sanitized = sanitizeForAudit({
      password: "hunter2",
      nested: { token: "abc", phoneE164: "+94771234567", keep: "ok" },
      list: [{ apiKey: "k" }],
    }) as Record<string, unknown>;
    expect(sanitized["password"]).toBe("[redacted]");
    const nested = sanitized["nested"] as Record<string, unknown>;
    expect(nested["token"]).toBe("[redacted]");
    expect(nested["phoneE164"]).toBe("+9477****567");
    expect(nested["keep"]).toBe("ok");
    expect((sanitized["list"] as Record<string, unknown>[])[0]!["apiKey"]).toBe("[redacted]");
  });
});
