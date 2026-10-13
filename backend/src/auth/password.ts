/**
 * Password hashing and policy (AUTH_AND_PERMISSIONS §1).
 *
 * Hashes are argon2id. Parameters are recorded in the M2 handoff so ADR/OPEN-010 can
 * note them: m=19456 KiB (19 MiB), t=2, p=1 — OWASP's minimum recommended set at the
 * time of writing (FREEBUFF_KICKOFF M1 task 2 asks for exactly this record).
 *
 * Hashes are never logged and never returned; the runtime role can read the column,
 * so nothing outside this module should ever select `password_hash`.
 */
import argon2 from "argon2";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;

/** A short list of passwords that must never be accepted (AUTH §1). */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "123456789012",
  "qwertyuiop12",
  "letmein12345",
  "administrator",
  "inspireacademy",
  "iloveyou1234",
  "welcome12345",
]);

export interface PasswordPolicyResult {
  ok: boolean;
  /** Safe, user-facing message; never echoes the password. */
  issue?: string;
}

export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, issue: `Use at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (password.length > 200) {
    return { ok: false, issue: "Use at most 200 characters." };
  }
  const lowered = password.toLowerCase();
  if (lowered === username.toLowerCase()) {
    return { ok: false, issue: "Password must not be the same as the username." };
  }
  if (COMMON_PASSWORDS.has(lowered)) {
    return { ok: false, issue: "That password is too common. Choose another." };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an error
    // that could distinguish an existing account from a missing one.
    return false;
  }
}
