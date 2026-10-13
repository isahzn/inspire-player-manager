/**
 * TOTP for owner accounts (AUTH_AND_PERMISSIONS §1, OPEN-010: optional, recommended).
 *
 * Implemented directly against RFC 4226 (HOTP) and RFC 6238 (TOTP) instead of pulling a
 * wrapper library: the algorithm is a 40-line HMAC construction, `otplib` v13 requires
 * wiring in separate crypto/base32 plugins for the same result, and the unit tests
 * assert the RFC's published test vectors — evidence a wrapper would not add.
 *
 * Secrets are stored encrypted (AES-256-GCM under TOTP_ENCRYPTION_KEY), never in clear.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { config } from "../config.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output; // no padding: what authenticator apps accept in otpauth URIs
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP: HMAC-SHA1 with dynamic truncation. */
export function hotp(secretBase32: string, counter: number, digits: number = DIGITS): string {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * RFC 6238 TOTP at a given instant (seconds since epoch).
 *
 * `digits` is a parameter only so the RFC's own 8-digit test vectors can be asserted;
 * the API always uses 6, as the contract's `^[0-9]{6}$` codes require.
 */
export function totp(
  secretBase32: string,
  atSeconds: number = Date.now() / 1000,
  digits: number = DIGITS,
): string {
  return hotp(secretBase32, Math.floor(atSeconds / PERIOD_SECONDS), digits);
}

/**
 * Verifies a code within ±`window` steps (default 1 → one period either side, to
 * tolerate clock drift). Comparison is constant-time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { atSeconds?: number; window?: number } = {},
): boolean {
  const candidate = code.replace(/\s/g, "");
  if (!/^[0-9]{6}$/.test(candidate)) return false;
  const step = Math.floor((opts.atSeconds ?? Date.now() / 1000) / PERIOD_SECONDS);
  const window = opts.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secretBase32, step + offset);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth URI for the enrollment QR code (AUTH-07). */
export function otpauthUri(secretBase32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Secret encryption at rest (users.totp_secret_enc)
// ---------------------------------------------------------------------------
function encryptionKey(): Buffer {
  return createHash("sha256").update(config.totpEncryptionKey).digest();
}

export function encryptSecret(secretBase32: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(payload: Buffer): string {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
