/**
 * RCT-01 — list receipts, and RCT-02 — the receipt PDF (API_CONTRACTS §3.6).
 *
 * A receipt is not an independent document: it is the record that a *confirmed* payment was
 * money received, created in the same transaction that confirmed it (T2, `receipts` in 0012).
 * So this endpoint only ever lists — there is nothing to create, edit or delete here, and a
 * reversed payment's receipt is reported as `voided` rather than hidden, because the paper
 * copy in the owner's file may still exist.
 */
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { asViewer } from "../http/context.js";
import * as audit from "../audit.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { serializeReceiptSummary, type ReceiptRow } from "./money-serialize.js";
import { generateReceiptPdf, readInvoicePdfBytes } from "./pdf-service.js";

/** How long the client should wait before asking again (RCT-02's `Retry-After`). */
const RETRY_AFTER_SECONDS = "2";

interface ReceiptListQuery {
  page: number;
  pageSize: number;
  paymentId?: string;
  from?: string;
  to?: string;
}

const RECEIPT_SELECT = `select r.id, r.receipt_number, r.payment_id, r.issued_at,
                               r.file_id, r.voided_at
                          from receipts r`;

export const rct01List: Handler = async ({ viewer, query }): Promise<HandlerResult> => {
  const { page, pageSize, paymentId, from, to } = query as ReceiptListQuery;

  const values: unknown[] = [];
  const filters: string[] = [];
  if (paymentId) {
    values.push(paymentId);
    filters.push(`r.payment_id = $${values.length}`);
  }
  if (from) {
    values.push(from);
    filters.push(`r.issued_at >= $${values.length}::timestamptz`);
  }
  if (to) {
    values.push(to);
    filters.push(`r.issued_at <= $${values.length}::timestamptz`);
  }
  const where = filters.length ? `where ${filters.join(" and ")}` : "";

  const result = await asViewer(viewer, async (client) => {
    const countResult = await client.query<{ total: string }>(
      `select count(*)::text as total from receipts r ${where}`,
      values,
    );
    const pageResult = await client.query<ReceiptRow>(
      `${RECEIPT_SELECT} ${where} order by r.issued_at desc, r.id desc
         limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { total: Number(countResult.rows[0]?.total ?? 0), rows: pageResult.rows };
  });

  return {
    status: 200,
    body: {
      data: result.rows.map(serializeReceiptSummary),
      meta: {
        page,
        pageSize,
        total: result.total,
        totalPages: pageSize > 0 ? Math.ceil(result.total / pageSize) : 0,
      },
    },
  };
};

/**
 * RCT-02.download — stream a receipt PDF.
 *
 * Same split as the invoice side, for the same reason: reading never renders. A receipt whose
 * PDF has not been built (or was flagged stale by a payment reversal) answers
 * `409 PDF_NOT_READY` with a `Retry-After` instead of blocking the request on a render.
 */
export const rct02Download: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await asViewer(viewer, async (client) => {
      const { bytes, receiptNumber } = await (async () => {
        const state = await client.query<{
          receipt_number: string;
          file_id: string | null;
          pdf_stale: boolean;
        }>(`select receipt_number, file_id, pdf_stale from receipts where id = $1`, [id]);
        const row = state.rows[0];
        if (!row) throw errors.notFound();

        if (!row.file_id || row.pdf_stale) {
          throw new ApiError(
            "PDF_NOT_READY",
            "This document is still being prepared. Try again in a moment.",
            undefined,
            { "Retry-After": RETRY_AFTER_SECONDS },
          );
        }

        const stored = await readInvoicePdfBytes(client, row.file_id);
        if (!stored) {
          throw new ApiError(
            "PDF_NOT_READY",
            "This document's file could not be read. Regenerate it.",
            undefined,
            { "Retry-After": RETRY_AFTER_SECONDS },
          );
        }
        return { bytes: stored, receiptNumber: row.receipt_number };
      })();

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "receipt.pdf.read",
        entityType: "receipt",
        entityId: id,
        after: { receiptNumber },
      });

      return {
        status: 200,
        body: Buffer.from(bytes),
        headers: {
          "content-type": "application/pdf",
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${receiptNumber}.pdf"`,
        },
      };
    });
  } catch (err) {
    mapPgError(err);
  }
};

/**
 * RCT-02.regenerate — rebuild a receipt PDF from the payment's own facts.
 *
 * A reversed payment's receipt is watermarked on this path (FILES_AND_PDF §3), because the
 * reversal sets `pdf_stale` — so the document a guardian may still be holding stops being the
 * document the academy hands out.
 */
export const rct02Regenerate: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await asViewer(viewer, async (client) => {
      const result = await generateReceiptPdf(client, {
        receiptId: id,
        userId: viewer.userId,
        timezoneFallback: viewer.academy.timezone,
      });

      if (result.outcome === "not_found") throw errors.notFound();

      if (result.outcome === "storage_failed") {
        throw new ApiError(
          "DEPENDENCY_UNAVAILABLE",
          "File storage is unavailable, so the document could not be stored.",
        );
      }

      if (result.outcome === "mismatch") {
        throw new Error(`receipt PDF refused: ${result.message}`);
      }

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "receipt.pdf.regenerate",
        entityType: "receipt",
        entityId: id,
        after: { fileId: result.fileId, pages: result.pages, reused: result.reused },
      });

      return { status: 202 };
    });
  } catch (err) {
    mapPgError(err);
  }
};
