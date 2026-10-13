/**
 * The two routes that answer with **no session at all**: PUB-01 (an invoice PDF behind a
 * capability token) and PUB-02 (the academy logo).
 *
 * They live together because they are the only places in this API where the caller has no
 * identity, and that makes them the only places where the usual defences — RLS policies, a
 * role check, an audit actor — simply do not apply. Everything about them is therefore shaped by
 * what replaces those:
 *
 *  - **A capability, not a login.** PUB-01's token is 32 random bytes; only its SHA-256 is
 *    stored, so a leaked database cannot reconstruct a working link. The check, the expiry, the
 *    revocation and the `use_count` increment are one statement inside a `SECURITY DEFINER`
 *    function (`0014`), because an anonymous caller has no identity for a policy to match.
 *  - **One answer for every failure.** Unknown token, expired, revoked, voided invoice, missing
 *    object, and a document that has not been generated yet are all the *same* 404. Anything
 *    else would let a caller enumerate which tokens are real.
 *  - **Nothing is written that the caller can influence.** `use_count` moves as part of the
 *    validation, and no audit actor is fabricated: `audit_logs` requires an actor
 *    (`audit_append` policy) and a public read has none, so the evidence for a public read is
 *    the token row itself. Widening the audit policy for an anonymous writer would put a row in
 *    the trail that names nobody — worse than no row, because it would look like one.
 *
 * Neither handler ever renders a document. PUB-01 serves what exists: a link whose PDF has not
 * been generated is the same 404 as a link that never existed, and generation stays the owner's
 * action (`INV-07`), which is also what keeps a public route free of side effects.
 */
import { createHash } from "node:crypto";
import { withRawTransaction } from "../db/pool.js";
import { errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { readStoredFile } from "../files/storage.js";

/**
 * An invoice PDF for the holder of a capability link (FILES_AND_PDF §7).
 *
 * The token arrives in the path and is hashed before it is used for anything: the database only
 * ever holds the hash, so this is the one moment the raw value exists. The response headers are
 * the spec's list, and each one is there for a reason — `no-store` so no shared proxy keeps a
 * child's invoice, `Referrer-Policy: no-referrer` so the token cannot leak onward in a `Referer`
 * header, `nosniff` so a mislabelled object cannot be reinterpreted by the browser, and `inline`
 * because a guardian is meant to read it rather than download it.
 */
export const pub01InvoicePdf: Handler = async ({ params }): Promise<HandlerResult> => {
  const { token } = params as { token: string };
  const tokenHash = createHash("sha256").update(token).digest("hex");

  try {
    const document = await withRawTransaction(async (client) => {
      const result = await client.query<{
        invoice_id: string;
        invoice_number: string;
        storage_key: string | null;
        mime_type: string | null;
      }>(
        `select invoice_id, invoice_number, storage_key, mime_type
           from app.public_invoice_document($1)`,
        [tokenHash],
      );
      return result.rows[0] ?? null;
    });

    // No row: not a valid token (or not one that is still valid), which is deliberately the same
    // answer as the two checks below it.
    if (!document?.storage_key) throw errors.notFound();

    const bytes = await readStoredFile(document.storage_key);
    if (!bytes) throw errors.notFound();

    return {
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "content-type": "application/pdf",
        "cache-control": "no-store",
        "content-disposition": `inline; filename="${document.invoice_number}.pdf"`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    };
  } catch (err) {
    mapPgError(err);
  }
};

/**
 * The academy's logo: the one public brand asset (SET-03's `logoUrl`, `Me.academy.logoUrl`).
 *
 * It takes no parameter, which is the security property that makes an anonymous read acceptable:
 * it can only ever answer with the logo the owner themselves uploaded, so there is no object id
 * to guess and nothing else in private storage is reachable through it. The file is the academy's
 * own logo — public by nature, and described as public in the contract — never a guardian's
 * document.
 *
 * An SVG is served with a restrictive `Content-Security-Policy`: it is rendered through an `<img>`
 * today, where scripts do not run, but a link that is opened directly would be a document, and
 * this is the header that makes it an inert one.
 */
export const pub02Logo: Handler = async (): Promise<HandlerResult> => {
  try {
    const row = await withRawTransaction(async (client) => {
      const result = await client.query<{ storage_key: string; mime_type: string }>(
        `select storage_key, mime_type from app.public_logo()`,
      );
      return result.rows[0] ?? null;
    });
    // No logo uploaded yet: 404 rather than an empty image, so a client can tell the difference
    // and fall back to the wordmark (FILES_AND_PDF §1).
    if (!row) throw errors.notFound();

    const bytes = await readStoredFile(row.storage_key);
    if (!bytes) throw errors.notFound();

    const isSvg = row.mime_type === "image/svg+xml";
    return {
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "content-type": row.mime_type,
        // The one response in this API that may be cached: it is the same for everyone, holds no
        // personal data, and a settings screen renders it on every visit.
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
        ...(isSvg ? { "content-security-policy": "default-src 'none'; sandbox" } : {}),
      },
    };
  } catch (err) {
    mapPgError(err);
  }
};
