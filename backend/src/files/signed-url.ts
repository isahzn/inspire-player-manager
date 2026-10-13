/**
 * Short-lived, signed access URLs for private files (PRF-02, FILES_AND_PDF §7).
 *
 * The contract asks for a "pre-signed GET URL ≤ 5 min (never a public bucket URL), or the
 * backend streams it". This deployment has no bucket to sign against — objects live in a private
 * local directory (`files/storage.ts`) — so the URL this issues points back at the **API itself**
 * and the bytes are streamed through the backend. Revocation is therefore instant and there is
 * nothing in a third-party service to keep in sync.
 *
 * What the signature is for, given that the endpoint is already owner-only: it makes the URL
 * *expire*. A session cookie lives for hours; a link e-mailed, pasted into a chat or left in a
 * browser history must stop working in minutes, and a leaked URL must not be replayable later
 * even by the person it was issued to. Both factors are required — the session for *who*, the
 * signature for *how long* — and neither alone is enough.
 *
 * The key is **derived** from the existing CSRF secret rather than being the secret itself
 * (`HMAC(csrfSecret, "ia.file-url.v1")`), so a signature produced here can never be replayed as
 * a CSRF token or vice versa: the two uses are cryptographically separated by that label.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** "At most 5 minutes" (FILES_AND_PDF §7). */
export const FILE_URL_TTL_SECONDS = 300;

function signingKey(): Buffer {
  return createHmac("sha256", config.csrfSecret).update("ia.file-url.v1").digest();
}

/**
 * The value signed over.
 *
 * `kind` and `sub` are part of the message so a signature for one file can never be presented
 * for another: a URL for payment A's proof cannot be edited into a URL for payment B's.
 */
function payload(args: { kind: string; id: string; sub: string; exp: string }): string {
  return `${args.kind}\n${args.id}\n${args.sub}\n${args.exp}`;
}

function sign(args: { kind: string; id: string; sub: string; exp: string }): string {
  return createHmac("sha256", signingKey()).update(payload(args)).digest("base64url");
}

export interface SignedFileUrl {
  /** `exp` as a base64url-free decimal string, so it survives a query string unchanged. */
  exp: string;
  sig: string;
  expiresAt: Date;
}

/** Issues one URL's worth of credentials for `id`/`sub` (`kind` = the asset class, e.g. `proof`). */
export function signFileAccess(args: {
  kind: string;
  id: string;
  sub: string;
  ttlSeconds?: number;
  now?: Date;
}): SignedFileUrl {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (args.ttlSeconds ?? FILE_URL_TTL_SECONDS) * 1000);
  const exp = String(Math.floor(expiresAt.getTime() / 1000));
  return { exp, sig: sign({ kind: args.kind, id: args.id, sub: args.sub, exp }), expiresAt };
}

/**
 * True when the credentials are ours, still in date, and were issued for exactly this file.
 *
 * The comparison is constant-time: a byte-by-byte `===` on a signature leaks how much of a
 * guess was right, which is enough to forge one given enough attempts. The `exp` bound is
 * checked here as well as in the signature so a clock-skewed client cannot extend a link by
 * editing it — the signature covers `exp`, so an edited one fails the comparison anyway.
 */
export function verifyFileAccess(args: {
  kind: string;
  id: string;
  sub: string;
  exp: string | undefined;
  sig: string | undefined;
  now?: Date;
}): boolean {
  const { exp, sig } = args;
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expiresAt = Number(exp) * 1000;
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt <= (args.now ?? new Date()).getTime()) return false;

  const expected = sign({ kind: args.kind, id: args.id, sub: args.sub, exp });
  const given = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (given.byteLength !== wanted.byteLength) return false;
  return timingSafeEqual(given, wanted);
}
