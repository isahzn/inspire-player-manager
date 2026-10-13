/**
 * PRF-01..04 — payment proofs: upload, download, delete, re-check (API_CONTRACTS §3.6).
 *
 * The line this file must never cross, in either handler: **a proof is evidence, not
 * payment**. Verification reads a document, states what it found and stops. It cannot mark a
 * payment confirmed, cannot allocate, cannot create a receipt and cannot move a balance —
 * `PAY-04` stays the owner's decision whatever the findings say (ADR-013/ADR-020/ADR-021,
 * PAYMENT_VERIFICATION §1). A receipt that checks out perfectly leaves a `pending` payment
 * exactly as it was.
 *
 * The second rule is about untrusted documents: the uploaded PDF is produced outside the
 * academy, so it is never rendered, never fetched and never trusted. Extraction is text-layer
 * only, a file that cannot be read reports `PARSE_FAILED` rather than a guess, and a photo is
 * never parsed at all — an image cannot produce a passing check, because a "pass" on a
 * screenshot would be a lie (PAYMENT_VERIFICATION §2/§6).
 *
 * Extracted values are proof-class PII (payer names, masked account numbers): they are stored
 * on the proof and are deliberately **absent from the audit row and from every message**.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { uuidv7 } from "../ids.js";
import * as audit from "../audit.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { PROOF_SELECT, loadPayment, referenceAlreadyClaimed, fileAlreadyStored } from "./money-helpers.js";
import {
  serializeProof,
  serializeProofVerification,
  type ProofRow,
  type RawFinding,
  type RawVerification,
} from "./money-serialize.js";
import {
  analyseReceiptPdf,
  RECEIPT_PARSER_VERSION,
  screenActiveContent,
  type ReceiptCheckContext,
} from "../files/receipt-parser.js";
import { readStoredFile, writeStoredFile } from "../files/storage.js";
import { extensionFor, readUpload, type SniffedFileType } from "../files/upload.js";
import { stripImageMetadata } from "../files/image-metadata.js";
import { signFileAccess, verifyFileAccess } from "../files/signed-url.js";
import { config } from "../config.js";

/** One proof of one payment, by the proof's own id (`fileId` in the contract's path). */
async function loadProof(
  client: PoolClient,
  paymentId: string,
  proofId: string,
): Promise<ProofRow | null> {
  const result = await client.query<ProofRow>(
    `${PROOF_SELECT} where pp.payment_id = $1 and pp.id = $2`,
    [paymentId, proofId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// PRF-01 — upload a proof
// ---------------------------------------------------------------------------
/** ≤ 5 MB, and the limit the client is told about (FILES_AND_PDF §6). */
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
/** ≤ 5 proofs per payment. */
const PROOF_MAX_PER_PAYMENT = 5;
/** The contract's own bound on `note`. */
const NOTE_MAX_LENGTH = 500;

const PROOF_UPLOAD_RULE = {
  maxBytes: PROOF_MAX_BYTES,
  tooLargeMessage: "A proof must be 5 MB or smaller.",
  allowed: ["pdf", "jpeg", "png", "webp"] as const,
};

/**
 * What the document is, for verification purposes (CR-004).
 *
 * Derived from the **sniffed type** and the payment's own method — never from anything the
 * client sent. Only a bank transfer has a bank receipt to read, so on any other method the file
 * is `other` and stays supporting evidence; and only a PDF has a text layer, so an image is
 * `bank_receipt_image` and can never produce a passing check (PAYMENT_VERIFICATION §1/§2).
 */
function docKindFor(methodCode: string, type: SniffedFileType): ProofRow["doc_kind"] {
  if (methodCode !== "bank_transfer") return "other";
  return type === "pdf" ? "bank_receipt_pdf" : "bank_receipt_image";
}

/**
 * True when this payment already holds these exact bytes.
 *
 * The rule is per **payment** (FILES_AND_PDF §6), not global: the same receipt attached to two
 * different payments is not a duplicate to refuse at upload time — it is the thing
 * `PRF-04`'s reuse check exists to catch, and refusing it here would hide the finding.
 */
async function duplicateOnPayment(
  client: PoolClient,
  args: { paymentId: string; sha256: string },
): Promise<boolean> {
  const result = await client.query<{ duplicate: boolean }>(
    `select exists (
       select 1
         from payment_proofs pp
         join files f on f.id = pp.file_id
        where pp.payment_id = $1 and pp.deleted_at is null and f.sha256 = $2
     ) as duplicate`,
    [args.paymentId, args.sha256],
  );
  return result.rows[0]?.duplicate ?? false;
}

export const prf01Upload: Handler = async ({ ctx, viewer, params, req }): Promise<HandlerResult> => {
  const { id } = params as { id: string };
  const { file, fields } = await readUpload(req, PROOF_UPLOAD_RULE);

  const note = fields["note"]?.trim();
  if (note !== undefined && note.length > NOTE_MAX_LENGTH) {
    throw errors.validation([
      { field: "note", issue: `Keep the note to ${NOTE_MAX_LENGTH} characters or fewer.` },
    ]);
  }

  // The bytes are prepared **before** the transaction: stripping metadata and hashing are pure
  // CPU work, and holding a database transaction (and a pool connection) open across them buys
  // nothing. Both steps are refusals here rather than later, because a file we cannot rewrite is
  // a file we should not be storing at all.
  let bytes: Buffer = file.bytes;
  if (file.type === "pdf") {
    const tokens = screenActiveContent(file.bytes);
    if (tokens.length > 0) {
      throw new ApiError(
        "UNSUPPORTED_FILE_TYPE",
        `That PDF carries active content (${tokens.join(", ")}). Export a plain copy from the bank app.`,
      );
    }
  } else if (file.type !== "svg") {
    // An image: rewrite its container so EXIF/GPS and any appended payload are gone before a
    // single byte is stored (FILES_AND_PDF §6). SVG is not in this endpoint's accepted set.
    const stripped = stripImageMetadata(file.bytes, file.type);
    if (!stripped) {
      throw new ApiError(
        "UNSUPPORTED_FILE_TYPE",
        "That image could not be read. Export it again as a JPEG or PNG.",
      );
    }
    bytes = Buffer.from(stripped);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fileId = uuidv7();
  // FILES_AND_PDF §5: the key is opaque and carries no name a person gave the file.
  const storageKey = `proofs/${new Date().getUTCFullYear()}/${id}/${fileId}.${extensionFor(file.type)}`;

  try {
    return await withTransaction(
      { userId: viewer.userId, role: viewer.role },
      async (client): Promise<HandlerResult> => {
        // RLS decides visibility, so a payment the caller may not see is simply not there.
        const payment = await loadPayment(client, id);
        if (!payment) throw errors.notFound();

        if (await duplicateOnPayment(client, { paymentId: id, sha256 })) {
          throw new ApiError(
            "DUPLICATE_SUSPECTED",
            "That exact file is already attached to this payment.",
          );
        }

        const live = await client.query<{ count: string }>(
          `select count(*)::text as count from payment_proofs
            where payment_id = $1 and deleted_at is null`,
          [id],
        );
        if (Number(live.rows[0]?.count ?? 0) >= PROOF_MAX_PER_PAYMENT) {
          throw errors.validation([
            {
              field: "file",
              issue: `A payment can hold at most ${PROOF_MAX_PER_PAYMENT} proofs.`,
            },
          ]);
        }

        // Written before the rows, so a committed proof always has its object; an object whose
        // transaction then fails is an orphan the sweeper removes (FILES_AND_PDF §8).
        if (!(await writeStoredFile(storageKey, bytes))) {
          throw new ApiError(
            "DEPENDENCY_UNAVAILABLE",
            "File storage is unavailable, so the proof could not be stored.",
          );
        }

        await client.query(
          `insert into files
             (id, kind, storage_key, mime_type, size_bytes, sha256, original_name, uploaded_by)
           values ($1, 'payment_proof', $2, $3, $4, $5, $6, $7)`,
          [
            fileId,
            storageKey,
            file.mimeType,
            bytes.byteLength,
            sha256,
            file.originalName,
            viewer.userId,
          ],
        );

        const proofId = uuidv7();
        await client.query(
          `insert into payment_proofs
             (id, payment_id, file_id, uploaded_by, note, doc_kind)
           values ($1, $2, $3, $4, $5, $6)`,
          [proofId, id, fileId, viewer.userId, note && note.length > 0 ? note : null, docKindFor(payment.method_code, file.type)],
        );

        // No automatic check runs here. The `proofCheck` switch that would start one is part of
        // `SET-08` (M7) and ships **off** while CR-003/ADR-019 are unapproved, so a new proof has
        // no verification until the owner asks for one (PRF-04, always allowed).
        //
        // Nothing about the payment changes either — not its status, not a balance, and not its
        // `version`: a proof is evidence attached to a payment, not a change to the payment
        // itself (ADR-020/ADR-021).
        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "payment.proof.upload",
          entityType: "payment_proof",
          entityId: proofId,
          after: {
            paymentId: id,
            fileId,
            docKind: docKindFor(payment.method_code, file.type),
            mimeType: file.mimeType,
            sizeBytes: bytes.byteLength,
            sha256,
          },
        });

        const created = await loadProof(client, id, proofId);
        if (!created) throw errors.notFound();
        return { status: 201, body: serializeProof(created) };
      },
    );
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PRF-02 — a short-lived signed download URL
// ---------------------------------------------------------------------------
/**
 * The path this handler serves in both of its modes.
 *
 * PRF-02's contract response is `{ url, expiresAt }`, and the URL it hands back is this same
 * path with `exp`/`sig` attached. One route, two modes:
 *
 *  - **no credentials** (the API call a client makes): mint the signed URL and answer with it;
 *  - **valid credentials** (the browser following that URL): stream the bytes.
 *
 * The alternative — a second, undeclared route to serve the bytes — would put a route in the
 * server that is not in the contract, which this codebase refuses to do. Pointing at an existing
 * bucket URL is not available either, because there is no bucket (OPEN-016).
 */
const PROOF_DOWNLOAD_PATH = (paymentId: string, fileId: string): string =>
  `${config.apiBaseUrl.replace(/\/+$/, "")}/api/v1/payments/${paymentId}/proofs/${fileId}/download`;

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * The original name is a value a person typed, so it is treated as hostile: quotes and control
 * characters are stripped so they cannot end the quoted string early and add a header of the
 * caller's choosing (header injection), and a name that survives nothing falls back to the id.
 */
function downloadFilename(originalName: string | null, fallback: string): string {
  const cleaned = (originalName ?? "").replace(/[\u0000-\u001f"\\]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export const prf02Download: Handler = async ({
  ctx,
  viewer,
  params,
  req,
}): Promise<HandlerResult> => {
  const { id, fileId } = params as { id: string; fileId: string };
  const query = (req.query ?? {}) as Record<string, unknown>;
  const exp = typeof query["exp"] === "string" ? query["exp"] : undefined;
  const sig = typeof query["sig"] === "string" ? query["sig"] : undefined;

  try {
    return await withTransaction(
      { userId: viewer.userId, role: viewer.role },
      async (client): Promise<HandlerResult> => {
        const payment = await loadPayment(client, id);
        if (!payment) throw errors.notFound();
        const proof = await loadProof(client, id, fileId);
        if (!proof || proof.deleted_at) throw errors.notFound();

        // A link that has been tampered with or has run out of time is refused before anything is
        // read. 403 rather than 404: the caller is an authenticated owner who already knows the
        // file exists, and "your link expired, open the proof again" is the useful answer.
        if (exp !== undefined || sig !== undefined) {
          const valid = verifyFileAccess({ kind: "proof", id, sub: fileId, exp, sig });
          if (!valid) {
            throw new ApiError(
              "FORBIDDEN",
              "This download link has expired. Open the proof again to get a new one.",
            );
          }

          const bytes = await readStoredFile(proof.storage_key);
          // The row says the object exists but it does not (FILES_AND_PDF §8): the honest answer
          // is 404, and the owner's repair is to upload the file again.
          if (!bytes) throw errors.notFound();

          await audit.record(client, viewerAudit(viewer, ctx), {
            action: "payment.proof.read",
            entityType: "payment_proof",
            entityId: proof.id,
            after: { paymentId: id, fileId, mode: "served" },
          });

          return {
            status: 200,
            body: Buffer.from(bytes),
            headers: {
              "content-type": proof.mime_type,
              "cache-control": "no-store",
              // Always an attachment: a bank receipt rendered inline would execute in the
              // browser's PDF viewer, and nothing here needs that.
              "content-disposition": `attachment; filename="${downloadFilename(proof.original_name, `${fileId}.pdf`)}"`,
              "x-content-type-options": "nosniff",
            },
          };
        }

        const signed = signFileAccess({ kind: "proof", id, sub: fileId });
        // FILES_AND_PDF §7: the **issuance** is audited, not the URL (which contains no data).
        // The read itself is audited too, when the bytes are actually served — so the trail says
        // both who asked for access and who then used it.
        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "payment.proof.read",
          entityType: "payment_proof",
          entityId: proof.id,
          after: { paymentId: id, fileId, mode: "issued" },
        });

        return {
          status: 200,
          body: {
            url: `${PROOF_DOWNLOAD_PATH(id, fileId)}?exp=${signed.exp}&sig=${signed.sig}`,
            expiresAt: signed.expiresAt.toISOString(),
          },
        };
      },
    );
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PRF-03 — delete a proof
// ---------------------------------------------------------------------------
export const prf03Delete: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id, fileId } = params as { id: string; fileId: string };

  try {
    return await withTransaction(
      { userId: viewer.userId, role: viewer.role },
      async (client): Promise<HandlerResult> => {
        const payment = await loadPayment(client, id);
        if (!payment) throw errors.notFound();
        const proof = await loadProof(client, id, fileId);
        if (!proof || proof.deleted_at) throw errors.notFound();

        // Only a payment that has not been confirmed yet may lose a proof: once money has
        // moved, the evidence behind it is part of the record.
        if (payment.status !== "pending") {
          throw new ApiError(
            "INVALID_STATE_TRANSITION",
            "A proof can only be deleted while the payment is pending.",
          );
        }

        // Soft delete: the metadata row survives so the audit trail of what was submitted
        // still exists (DATABASE §6). The file object follows its own retention rule.
        await client.query(
          `update payment_proofs set deleted_at = now() where id = $1 and deleted_at is null`,
          [proof.id],
        );

        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "payment.proof.delete",
          entityType: "payment_proof",
          entityId: proof.id,
          before: {
            paymentId: proof.payment_id,
            fileId: proof.file_id,
            docKind: proof.doc_kind,
          },
        });
        return { status: 204 };
      },
    );
  } catch (err) {
    mapPgError(err);
  }
};

// ---------------------------------------------------------------------------
// PRF-04 — re-run the deterministic receipt checks (advisory only)
// ---------------------------------------------------------------------------
export const prf04Verify: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id, fileId } = params as { id: string; fileId: string };

  try {
    return await withTransaction(
      { userId: viewer.userId, role: viewer.role },
      async (client): Promise<HandlerResult> => {
        const payment = await loadPayment(client, id);
        if (!payment) throw errors.notFound();
        const proof = await loadProof(client, id, fileId);
        if (!proof || proof.deleted_at) throw errors.notFound();

        // ------------------------------------------------------------------
        // From here on this handler **reads and reports only**. `payments.status`,
        // `allocated_minor`, every allocation, every invoice and `receipts` are untouched:
        // the findings are stored on the proof and nowhere else (T-VER-04).
        // ------------------------------------------------------------------
        let verification: RawVerification;

        if (proof.doc_kind !== "bank_receipt_pdf") {
          // A photo or screenshot has no text layer, so there is nothing to check and no
          // bytes are read. Kept as supporting evidence; the owner confirms by eye.
          verification = {
            status: "unverifiable",
            parserVersion: RECEIPT_PARSER_VERSION,
            findings: [
              {
                code: "SUPPORTING_ONLY",
                level: 1,
                result: "unknown",
                detail:
                  "A photo or screenshot has no text layer, so it cannot be checked. Ask " +
                  "for the PDF receipt from the bank app — this file stays as supporting " +
                  "evidence only.",
              },
            ],
          };
        } else {
          const bytes = await readStoredFile(proof.storage_key);
          if (!bytes) {
            // Never invent a result from a file we could not open.
            verification = {
              status: "failed",
              parserVersion: RECEIPT_PARSER_VERSION,
              findings: [
                {
                  code: "PARSE_FAILED",
                  level: 1,
                  result: "fail",
                  detail:
                    "The stored receipt file could not be read, so no checks could run. " +
                    "Re-upload the PDF from the bank app.",
                },
              ],
            };
          } else {
            const settings = await client.query<{
              beneficiary_accounts: { name: string; accountMasked: string }[] | null;
            }>(`select beneficiary_accounts from academy_settings where id = 1`);

            const allocated = await client.query<{ invoice_number: string }>(
              `select i.invoice_number
                 from payment_allocations a
                 join invoices i on i.id = a.invoice_id
                where a.payment_id = $1 and a.reversed_at is null
                order by i.invoice_number asc`,
              [id],
            );

            const checkContext: ReceiptCheckContext = {
              recordedAmountMinor: Number(payment.amount_minor),
              recordedReference: payment.reference,
              receivedAt: payment.received_at,
              payerName: payment.payer_name ?? payment.payer_guardian_name,
              academyTimezone: viewer.academy.timezone,
              beneficiaryAccounts: settings.rows[0]?.beneficiary_accounts ?? [],
              dateToleranceDays: 1,
              payerNameIsSuspiciouslyReused: false,
              isFileDuplicated: await fileAlreadyStored(client, {
                sha256: proof.sha256,
                proofId: proof.id,
              }),
              invoiceNumbers: allocated.rows.map((row) => row.invoice_number),
            };

            const result = analyseReceiptPdf(bytes, checkContext);
            const findings: RawFinding[] = [...result.findings];

            // The reuse check needs the reference, which only the parse can reveal — so it
            // runs here rather than being passed in.
            const extracted = result.extracted ?? {};
            const referenced = extracted["reference"];
            if (
              typeof referenced === "string" &&
              referenced.length > 0 &&
              (await referenceAlreadyClaimed(client, {
                reference: referenced,
                paymentId: id,
              }))
            ) {
              findings.push({
                code: "RECEIPT_NOT_REUSED",
                level: 2,
                result: "fail",
                detail: `Reference ${referenced} is already attached to another payment or proof.`,
              });
            }

            verification = {
              status: findings.some((finding) => finding.result === "fail")
                ? "failed"
                : result.status,
              findings,
              ...(result.extracted ? { extracted: result.extracted } : {}),
              parserVersion: result.parserVersion,
            };
          }
        }

        const checkedAt = new Date();
        await client.query(
          `update payment_proofs set verification = $2::jsonb, checked_at = $3 where id = $1`,
          [proof.id, JSON.stringify(verification), checkedAt],
        );

        // The audit row records *that* a check ran and what it concluded. It deliberately
        // carries no extracted value: a payer's name and masked account are proof-class PII
        // and audit rows are retained for seven years (PAYMENT_VERIFICATION §6).
        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "payment.proof.verify",
          entityType: "payment_proof",
          entityId: proof.id,
          after: {
            status: verification.status,
            parserVersion: verification.parserVersion ?? RECEIPT_PARSER_VERSION,
            findingCount: verification.findings?.length ?? 0,
          },
        });

        return {
          status: 200,
          body: serializeProofVerification(proof.doc_kind, verification, checkedAt),
        };
      },
    );
  } catch (err) {
    mapPgError(err);
  }
};
