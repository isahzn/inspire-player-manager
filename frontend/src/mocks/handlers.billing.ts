"use client";

// MSW handlers for the money slice (Step 5): SET-01/02/04 reads, BIL-01..03,
// INV-01..08, PAY-01..08, PRF-01..04 and RCT-01/02. Every response is the
// contract shape; every failure is the exact envelope + code from
// API_CONTRACTS §1.1. All of these endpoints are owner-only in the contract, so
// a coach gets 403 from the guard before any handler runs.
import { delay, http, HttpResponse } from "msw";
import type { BillingAdjustment, ProofDocKind } from "@/api/types";
import * as billing from "./billing";
import { MockError } from "./db";
import { idempotent, json, jsonBody, ownerOnly } from "./http";
import { err } from "./session";

/** 409 PDF_NOT_READY carries a Retry-After (API_CONTRACTS INV-06). */
function pdfNotReady() {
  return HttpResponse.json(
    {
      error: {
        code: "PDF_NOT_READY",
        message: "The PDF is still being prepared.",
        requestId: "req_mock01",
      },
    },
    { status: 409, headers: { "Retry-After": "2" } }
  );
}

function fileResponse(blob: Blob, filename: string, mimeType: string) {
  return new HttpResponse(blob, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Cheap magic-byte sniff — the real server sniffs too (FILES_AND_PDF §6). */
function sniffDocKind(bytes: Uint8Array, mimeType: string): "pdf" | "image" | "other" {
  const ascii = (from: number, length: number) =>
    String.fromCharCode(...bytes.slice(from, from + length));
  if (ascii(0, 5) === "%PDF-") return "pdf";
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "other";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const billingHandlers = [
  // --- settings reads -------------------------------------------------------
  http.get(
    "*/settings/billing",
    ownerOnly(async () => {
      await delay(150);
      return json(billing.billingSettings());
    })
  ),

  http.get(
    "*/settings/academy",
    ownerOnly(async () => {
      await delay(150);
      return json(billing.academyPaymentSettings());
    })
  ),

  http.get(
    "*/settings/payment-methods",
    ownerOnly(async () => {
      await delay(150);
      return json(billing.listMethods());
    })
  ),

  // --- BIL-01/02/03 ---------------------------------------------------------
  http.post(
    "*/billing/previews",
    ownerOnly(async ({ request }) => {
      await delay(400);
      const body = await jsonBody<{
        targetDate?: string;
        ageGroupIds?: string[];
        playerIds?: string[];
      }>(request);
      return json(
        billing.buildPreview({
          targetDate: body.targetDate ?? "",
          ageGroupIds: body.ageGroupIds,
          playerIds: body.playerIds,
        })
      );
    })
  ),

  http.post(
    "*/billing/runs",
    ownerOnly(async ({ request }) => {
      await delay(600);
      const key = request.headers.get("Idempotency-Key") ?? "unknown";
      return idempotent(
        request,
        async () => {
          const body = await jsonBody<{
            targetDate: string;
            previewHash: string;
            ageGroupIds?: string[];
            playerIds?: string[];
            adjustments?: BillingAdjustment[];
            queueWhatsApp?: boolean;
          }>(request);
          return billing.createRun({ ...body, runKey: `manual:${key}` });
        },
        { status: 201 }
      );
    })
  ),

  http.get(
    "*/billing/runs",
    ownerOnly(async ({ request }) => {
      await delay(250);
      const sp = new URL(request.url).searchParams;
      return json(
        billing.listRuns({
          page: sp.get("page") ? Number(sp.get("page")) : undefined,
          pageSize: sp.get("pageSize") ? Number(sp.get("pageSize")) : undefined,
        })
      );
    })
  ),

  http.get(
    "*/billing/runs/:id",
    ownerOnly(async ({ params }) => {
      await delay(200);
      const run = billing.getRun(String(params.id));
      if (!run) return err("NOT_FOUND", "Billing run not found.", 404);
      return json(run);
    })
  ),

  // --- INV-01/02 ------------------------------------------------------------
  http.get(
    "*/invoices",
    ownerOnly(async ({ request }) => {
      await delay(350);
      const sp = new URL(request.url).searchParams;
      return json(
        billing.listInvoices({
          status: sp.get("status") ?? undefined,
          overdue: sp.get("overdue") === "true" ? true : undefined,
          playerId: sp.get("playerId") ?? undefined,
          guardianId: sp.get("guardianId") ?? undefined,
          ageGroupId: sp.get("ageGroupId") ?? undefined,
          issueFrom: sp.get("issueFrom") ?? undefined,
          issueTo: sp.get("issueTo") ?? undefined,
          dueFrom: sp.get("dueFrom") ?? undefined,
          dueTo: sp.get("dueTo") ?? undefined,
          q: sp.get("q") ?? undefined,
          page: sp.get("page") ? Number(sp.get("page")) : undefined,
          pageSize: sp.get("pageSize") ? Number(sp.get("pageSize")) : undefined,
          sort: sp.get("sort") ?? undefined,
        })
      );
    })
  ),

  http.get(
    "*/invoices/:id",
    ownerOnly(async ({ params }) => {
      await delay(250);
      const invoice = billing.getInvoiceFull(String(params.id));
      if (!invoice) return err("NOT_FOUND", "Invoice not found.", 404);
      return json(invoice);
    })
  ),

  // --- INV-03 --------------------------------------------------------------
  http.post(
    "*/invoices",
    ownerOnly(async ({ request }) => {
      await delay(500);
      return idempotent(
        request,
        async () =>
          billing.createManualInvoice(
            await jsonBody<{
              playerId: string;
              description: string;
              amountMinor: number;
              dueDate: string;
              guardianId?: string;
            }>(request)
          ),
        { status: 201 }
      );
    })
  ),

  // --- INV-04/05 -----------------------------------------------------------
  http.post(
    "*/invoices/:id/void",
    ownerOnly(async ({ request, params }) => {
      await delay(500);
      return idempotent(request, async () =>
        billing.voidInvoice(
          String(params.id),
          await jsonBody<{
            reason: string;
            releaseAllocations?: boolean;
            allowReissue?: boolean;
            version: number;
          }>(request)
        )
      );
    })
  ),

  http.post(
    "*/invoices/:id/adjustments",
    ownerOnly(async ({ request, params }) => {
      await delay(500);
      return idempotent(request, async () =>
        billing.addAdjustment(
          String(params.id),
          await jsonBody<{ amountMinor: number; reason: string; version: number }>(request)
        )
      );
    })
  ),

  // --- INV-06/07 (PDF stream) ---------------------------------------------
  http.get(
    "*/invoices/:id/pdf",
    ownerOnly(async ({ params }) => {
      await delay(300);
      const file = billing.invoicePdf(String(params.id));
      if (file === "not_ready") return pdfNotReady();
      return fileResponse(file.blob, file.filename, "application/pdf");
    })
  ),

  http.post(
    "*/invoices/:id/pdf/regenerate",
    ownerOnly(async ({ params }) => {
      await delay(400);
      billing.regenerateInvoicePdf(String(params.id));
      return new HttpResponse(null, { status: 202 });
    })
  ),

  // --- INV-08 --------------------------------------------------------------
  http.post(
    "*/invoices/:id/send",
    ownerOnly(async ({ request, params }) => {
      await delay(450);
      return idempotent(request, async () =>
        billing.sendInvoice(String(params.id), await jsonBody<{ guardianIds?: string[] }>(request))
      );
    })
  ),

  // --- PAY-01/02 -----------------------------------------------------------
  http.get(
    "*/payments",
    ownerOnly(async ({ request }) => {
      await delay(350);
      const sp = new URL(request.url).searchParams;
      return json(
        billing.listPayments({
          status: sp.get("status") ?? undefined,
          methodCode: sp.get("methodCode") ?? undefined,
          guardianId: sp.get("guardianId") ?? undefined,
          playerId: sp.get("playerId") ?? undefined,
          from: sp.get("from") ?? undefined,
          to: sp.get("to") ?? undefined,
          q: sp.get("q") ?? undefined,
          hasCredit: sp.get("hasCredit") === "true" ? true : undefined,
          page: sp.get("page") ? Number(sp.get("page")) : undefined,
          pageSize: sp.get("pageSize") ? Number(sp.get("pageSize")) : undefined,
          sort: sp.get("sort") ?? undefined,
        })
      );
    })
  ),

  http.post(
    "*/payments",
    ownerOnly(async ({ request }) => {
      await delay(600);
      return idempotent(
        request,
        async () =>
          billing.createPayment(
            await jsonBody<{
              amountMinor: number;
              methodCode: string;
              reference?: string;
              receivedAt: string;
              payerGuardianId?: string;
              payerName?: string;
              notes?: string;
              status: "confirmed" | "pending";
              allocations?: { invoiceId: string; amountMinor: number }[];
            }>(request)
          ),
        { status: 201 }
      );
    })
  ),

  // --- PAY-03..07 ----------------------------------------------------------
  http.get(
    "*/payments/:id",
    ownerOnly(async ({ params }) => {
      await delay(250);
      const payment = billing.getPaymentView(String(params.id));
      if (!payment) return err("NOT_FOUND", "Payment not found.", 404);
      return json(payment);
    })
  ),

  http.patch(
    "*/payments/:id",
    ownerOnly(async ({ request, params }) => {
      await delay(400);
      return json(
        billing.patchPayment(
          String(params.id),
          await jsonBody<{ reference?: string; notes?: string; receivedAt?: string; version: number }>(
            request
          )
        )
      );
    })
  ),

  http.post(
    "*/payments/:id/confirm",
    ownerOnly(async ({ request, params }) => {
      await delay(600);
      return idempotent(request, async () =>
        billing.confirmPayment(
          String(params.id),
          await jsonBody<{
            allocations?: { invoiceId: string; amountMinor: number }[];
            version: number;
          }>(request)
        )
      );
    })
  ),

  http.post(
    "*/payments/:id/reject",
    ownerOnly(async ({ request, params }) => {
      await delay(500);
      return idempotent(request, async () =>
        billing.rejectPayment(
          String(params.id),
          await jsonBody<{ reason: string; version: number }>(request)
        )
      );
    })
  ),

  http.post(
    "*/payments/:id/allocate",
    ownerOnly(async ({ request, params }) => {
      await delay(600);
      return idempotent(request, async () =>
        billing.allocatePayment(
          String(params.id),
          await jsonBody<{
            allocations: { invoiceId: string; amountMinor: number }[];
            version: number;
          }>(request)
        )
      );
    })
  ),

  http.post(
    "*/payments/:id/reverse",
    ownerOnly(async ({ request, params }) => {
      await delay(600);
      return idempotent(request, async () =>
        billing.reversePayment(
          String(params.id),
          await jsonBody<{ reason: string; version: number }>(request)
        )
      );
    })
  ),

  // PAY-08. The contract's path takes a payment id while the suggestion is keyed
  // by `guardianId`, and the record-payment form has no payment yet — it calls
  // with the literal id `new` (raised as contract drift in the Step 5 handoff).
  http.get(
    "*/payments/:id/allocation-suggestion",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const sp = new URL(request.url).searchParams;
      return json(
        billing.allocationSuggestion(String(params.id), sp.get("guardianId") ?? undefined)
      );
    })
  ),

  // --- PRF-01..04 ----------------------------------------------------------
  http.post(
    "*/payments/:id/proofs",
    ownerOnly(async ({ request, params }) => {
      await delay(700);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "file", issue: "Attach a file" },
        ]);
      }
      if (file.size > 5 * 1024 * 1024) {
        return err("FILE_TOO_LARGE", "Files must be 5 MB or smaller.", 413);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffDocKind(bytes, file.type);
      if (sniffed === "other") {
        return err(
          "UNSUPPORTED_FILE_TYPE",
          "Upload the bank's PDF e-receipt (or a JPEG, PNG or WebP photo).",
          415
        );
      }
      const payment = billing.getPaymentView(String(params.id));
      if (!payment) return err("NOT_FOUND", "Payment not found.", 404);
      const docKind: ProofDocKind =
        payment.method.code === "bank_transfer"
          ? sniffed === "pdf"
            ? "bank_receipt_pdf"
            : "bank_receipt_image"
          : "other";
      const note = form.get("note");
      return json(
        billing.addProof(String(params.id), {
          originalName: file.name,
          mimeType: file.type || (sniffed === "pdf" ? "application/pdf" : "image/png"),
          sizeBytes: file.size,
          sha256: await sha256Hex(bytes),
          docKind,
          stubKind: sniffed === "pdf" ? "pdf" : "image",
          note: typeof note === "string" ? note : undefined,
        }),
        201
      );
    })
  ),

  http.get(
    "*/payments/:id/proofs/:fileId/download",
    ownerOnly(async ({ params }) => {
      await delay(250);
      const file = billing.proofFile(String(params.id), String(params.fileId));
      if (!file) return err("NOT_FOUND", "Proof not found.", 404);
      // A signed URL, short-lived, never stored by the client (FILES_AND_PDF §8).
      const url = URL.createObjectURL(file.blob);
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
      return json({ url, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    })
  ),

  http.delete(
    "*/payments/:id/proofs/:fileId",
    ownerOnly(async ({ params }) => {
      await delay(350);
      billing.deleteProof(String(params.id), String(params.fileId));
      return new HttpResponse(null, { status: 204 });
    })
  ),

  http.post(
    "*/payments/:id/proofs/:fileId/verify",
    ownerOnly(async ({ params }) => {
      await delay(900);
      try {
        return json(billing.verifyProof(String(params.id), String(params.fileId)));
      } catch (error) {
        if (error instanceof MockError) {
          return err(error.code, error.message, error.status, error.details);
        }
        throw error;
      }
    })
  ),

  // --- RCT-01/02 -----------------------------------------------------------
  http.get(
    "*/receipts",
    ownerOnly(async ({ request }) => {
      await delay(250);
      const sp = new URL(request.url).searchParams;
      return json(
        billing.listReceipts({
          paymentId: sp.get("paymentId") ?? undefined,
          from: sp.get("from") ?? undefined,
          to: sp.get("to") ?? undefined,
          page: sp.get("page") ? Number(sp.get("page")) : undefined,
        })
      );
    })
  ),

  http.get(
    "*/receipts/:id/pdf",
    ownerOnly(async ({ params }) => {
      await delay(300);
      const file = billing.receiptFile(String(params.id));
      if (!file) return err("NOT_FOUND", "Receipt not found.", 404);
      return fileResponse(file.blob, file.filename, "application/pdf");
    })
  ),

  http.post(
    "*/receipts/:id/pdf/regenerate",
    ownerOnly(async ({ params }) => {
      await delay(400);
      billing.regenerateReceiptPdf(String(params.id));
      return new HttpResponse(null, { status: 202 });
    })
  ),
];
