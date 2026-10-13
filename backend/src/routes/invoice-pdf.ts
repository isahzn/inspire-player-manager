/**
 * INV-06/INV-07 — the invoice PDF (API_CONTRACTS §3.6, FILES_AND_PDF §2/§4).
 *
 * The split between the two endpoints is the contract's, and it is deliberate: **reading a
 * document never renders one.** INV-06 answers `409 PDF_NOT_READY` with a `Retry-After`
 * instead of blocking a request on a render, and INV-07 is the explicit "build it now" action
 * the owner's Regenerate button calls. That also keeps a `GET` free of side effects, which a
 * GET that quietly generated a file would not be.
 *
 * Both are `files:read_sensitive` and both are audited: an invoice PDF carries a guardian's
 * name and phone number, so reading one is a sensitive read (SECURITY §3 item 9).
 *
 * One honest gap, recorded rather than papered over: FILES_AND_PDF §4 also describes a
 * background worker sweeping `pdf_stale` every 30 s. No scheduler exists yet (M7/M8 own the
 * queue), so today a PDF becomes available when INV-07 is called — an invoice issued by
 * BIL-02 arrives with `pdf_stale = true` and INV-06 immediately answering 409, which is
 * exactly the "Preparing PDF…" state the frontend already renders.
 */
import { ApiError, errors } from "../errors.js";
import { mapPgError } from "../db/pg-errors.js";
import { asViewer } from "../http/context.js";
import * as audit from "../audit.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import { generateInvoicePdf, readInvoicePdfBytes } from "./pdf-service.js";

/** How long the client should wait before asking again (INV-06's `Retry-After`). */
const RETRY_AFTER_SECONDS = "2";

export const inv06Download: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await asViewer(viewer, async (client) => {
      const { bytes, invoiceNumber } = await (async () => {
        // RLS decides visibility: an invoice the caller may not see simply is not there, so
        // 404 is the honest answer and it does not confirm that the id exists.
        const state = await client.query<{
          invoice_number: string;
          pdf_file_id: string | null;
          pdf_stale: boolean;
        }>(`select invoice_number, pdf_file_id, pdf_stale from invoices where id = $1`, [id]);
        const row = state.rows[0];
        if (!row) throw errors.notFound();

        if (!row.pdf_file_id || row.pdf_stale) {
          // Not a failure: the document is still being prepared, and saying so with a retry
          // hint is more useful than a 404 the caller would read as "this invoice is gone".
          throw new ApiError(
            "PDF_NOT_READY",
            "This document is still being prepared. Try again in a moment.",
            undefined,
            { "Retry-After": RETRY_AFTER_SECONDS },
          );
        }

        const stored = await readInvoicePdfBytes(client, row.pdf_file_id);
        // The row says a file exists but the object is gone (FILES_AND_PDF §8). Regenerating is
        // the repair, so pointing the owner at INV-07 with the same 409 is correct — a 500
        // would suggest the request was at fault.
        if (!stored) {
          throw new ApiError(
            "PDF_NOT_READY",
            "This document's file could not be read. Regenerate it.",
            undefined,
            { "Retry-After": RETRY_AFTER_SECONDS },
          );
        }
        return { bytes: stored, invoiceNumber: row.invoice_number };
      })();

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "invoice.pdf.read",
        entityType: "invoice",
        entityId: id,
        after: { invoiceNumber },
      });

      return {
        status: 200,
        body: Buffer.from(bytes),
        headers: {
          "content-type": "application/pdf",
          // A capability document for one guardian: never cached by a shared proxy.
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${invoiceNumber}.pdf"`,
        },
      };
    });
  } catch (err) {
    mapPgError(err);
  }
};

export const inv07Regenerate: Handler = async ({ ctx, viewer, params }): Promise<HandlerResult> => {
  const { id } = params as { id: string };

  try {
    return await asViewer(viewer, async (client) => {
      const result = await generateInvoicePdf(client, {
        invoiceId: id,
        userId: viewer.userId,
        // **Not** forced. INV-07's own contract says "identical input ⇒ the same
        // `pdf_input_hash` and no new file", so a rebuild that changes nothing must not leave
        // a second copy of the same PDF behind. The button still works when there is work to
        // do: a missing file, or a row flagged `pdf_stale` by a payment, adjustment or void
        // (FILES_AND_PDF §2 regeneration triggers).
        force: false,
        timezoneFallback: viewer.academy.timezone,
      });

      if (result.outcome === "not_found") throw errors.notFound();

      if (result.outcome === "storage_failed") {
        // FILES_AND_PDF §4: a storage outage is a 503 on the document, and the invoice's money
        // is untouched. `pdf_stale` stays true, so the document still reads as pending.
        throw new ApiError(
          "DEPENDENCY_UNAVAILABLE",
          "File storage is unavailable, so the document could not be stored.",
        );
      }

      if (result.outcome === "mismatch") {
        // The document's arithmetic did not add up, so nothing was written (§4). This is a
        // data fault an operator has to look at, so it is thrown for the app's error handler
        // to log in full; the caller sees a generic INTERNAL_ERROR rather than internals.
        throw new Error(`invoice PDF refused: ${result.message}`);
      }

      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "invoice.pdf.regenerate",
        entityType: "invoice",
        entityId: id,
        after: { fileId: result.fileId, pages: result.pages, reused: result.reused },
      });

      return { status: 202 };
    });
  } catch (err) {
    mapPgError(err);
  }
};
