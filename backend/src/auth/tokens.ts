/**
 * Single-use tokens (invites, password resets). DATABASE §3.1: 256 bits of randomness,
 * stored only as a hash — a database read cannot be replayed as a valid link.
 */
import { createHash, randomBytes } from "node:crypto";

export interface OpaqueToken {
  /** Goes into the URL handed to the owner; never stored. */
  token: string;
  /** Stored in `user_invites.token_hash`. */
  hash: string;
}

export function generateOpaqueToken(): OpaqueToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Invite links live 72 h (AUTH §1). */
export const INVITE_TTL_HOURS = 72;

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_HOURS * 3_600_000);
}

/**
 * Normalises a phone number to E.164 with Sri Lanka as the default region.
 * `0771234567` → `+94771234567`; anything already E.164 passes through.
 */
export function normalizePhone(input: string, defaultCountryCode = "94"): string {
  const trimmed = input.trim().replace(/[\s()-]/g, "");
  if (/^\+[1-9][0-9]{7,14}$/.test(trimmed)) return trimmed;
  if (/^0[0-9]{9}$/.test(trimmed)) return `+${defaultCountryCode}${trimmed.slice(1)}`;
  if (/^[1-9][0-9]{8,14}$/.test(trimmed)) return `+${trimmed}`;
  throw new Error("invalid phone number");
}
