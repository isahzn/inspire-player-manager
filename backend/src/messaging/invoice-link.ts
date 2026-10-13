/**
 * Minting a guardian's invoice link (FILES_AND_PDF §7, `PUB-01`).
 *
 * The link is a **capability**: whoever holds it can read that one invoice. So the raw token is
 * generated here, hashed immediately, and never stored — `invoice_access_tokens.token_hash` is
 * the SHA-256, and the plaintext exists only in the message being built. A leaked database
 * therefore contains no working link, which is the whole reason the value is not kept.
 *
 * Every field of the row is the narrowest that works: the invoice it is for, **the guardian it
 * was addressed to** (so a misdirected message is traceable), an expiry from the owner's own
 * `invoice_link_ttl_days`, and who created it. Revocation is not here: it happens on void, in the
 * database trigger (`0013`), so it holds for every path that can void an invoice.
 *
 * Callers mint inside the same transaction as the message they are building, so a token can never
 * exist with no message that refers to it.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AnyQueryable } from "../audit.js";
import { config } from "../config.js";
import { uuidv7 } from "../ids.js";

/** 32 random bytes, base64url — unguessable, and safe in a URL without escaping. */
const TOKEN_BYTES = 32;

export interface MintedInvoiceLink {
  id: string;
  /** The plaintext token. Returned once, for the message, and never written down. */
  token: string;
  /** The URL a guardian taps: `PUB-01`. */
  url: string;
  expiresAt: Date;
}

/** The public URL of an invoice's PDF, from the API's own configured origin. */
export function invoicePublicUrl(token: string): string {
  return `${config.apiBaseUrl.replace(/\/+$/, "")}/api/v1/public/invoices/${token}/pdf`;
}

export async function mintInvoiceLink(
  client: AnyQueryable,
  args: {
    invoiceId: string;
    guardianId: string | null;
    /** `academy_settings.invoice_link_ttl_days`; defaults to the documented 30. */
    ttlDays?: number;
    /**
     * Who minted it. `null` only for the server-side CLIs, which have no session to name
     * (`scripts/lib/cli-db.ts`'s rule: no actor claimed). The column allows it for that reason.
     */
    createdBy: string | null;
    now?: Date;
  },
): Promise<MintedInvoiceLink> {
  const now = args.now ?? new Date();
  const ttlDays = args.ttlDays ?? 30;
  if (!Number.isInteger(ttlDays) || ttlDays <= 0) {
    throw new Error(`invoice link TTL must be a positive number of days, got ${ttlDays}`);
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const id = uuidv7();

  await client.query(
    `insert into invoice_access_tokens
       (id, invoice_id, guardian_id, token_hash, expires_at, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, args.invoiceId, args.guardianId, tokenHash, expiresAt, args.createdBy],
  );

  return { id, token, url: invoicePublicUrl(token), expiresAt };
}
