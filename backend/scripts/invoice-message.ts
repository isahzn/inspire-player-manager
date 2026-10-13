/**
 * `invoice-message` — the invoice-delivery message, filled in and printed.
 *
 *   npm run invoice-message -- --invoice INV-2026-000123
 *   npm run invoice-message -- --invoice INV-2026-000123 --mint-link
 *
 * This is the "invoice template" made real: it reads the invoice, reads the owner's own
 * `invoice_delivery` template, and substitutes the amount still owed, the invoice number, the
 * due date, the player and the guardian — so what a person pastes into WhatsApp is the same text
 * the M7 queue will send later. One definition, two callers, no hand-typed amounts.
 *
 * It **refuses** rather than producing a half-message: a settled or void invoice, an invoice with
 * no guardian, or a template with a placeholder that has no value. A refusal prints the reason and
 * exits non-zero, because a silent empty `Amount due:` is the failure mode worth designing out.
 *
 * `--mint-link` creates the guardian's capability link (`PUB-01`) in the same transaction as the
 * read. Without it the message carries no `{{invoiceLink}}`, and the seeded template — which uses
 * that variable — will therefore refuse. Minting writes one row and one audit entry, so it is
 * opt-in rather than the default.
 *
 * Runs through the migrator role like the other operator CLIs (DEPLOYMENT_AND_OPERATIONS §9):
 * there is no session to authenticate, and the operator already holds server access.
 */
import { config as loadEnv } from "dotenv";
import * as audit from "../src/audit.js";
import { formatMoney } from "../src/files/pdf/format.js";
import {
  buildInvoiceMessage,
  INVOICE_DELIVERY_TEMPLATE,
  loadInvoiceMessageInput,
} from "../src/messaging/invoice-message.js";
import { mintInvoiceLink } from "../src/messaging/invoice-link.js";
import { inspectTemplate, whatsappDeepLink } from "../src/messaging/template.js";
import { parseArgs, requireString, withCliTransaction } from "./lib/cli-db.js";

loadEnv();

interface Result {
  to: string | null;
  invoiceNumber: string;
  status: string;
  amountDue: string;
  link: string | null;
  text: string;
  deepLink: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const invoiceNumber = requireString(args, "invoice");
  const mintLink = args["mint-link"] === true;
  const asJson = args["json"] === true;

  const outcome = await withCliTransaction(async (client) => {
    const loaded = await loadInvoiceMessageInput(client, invoiceNumber);
    if (!loaded) return { kind: "not-found" as const };

    // Mint only when the template actually uses the link: creating one for a message that will
    // never carry it would leave a live capability token pointing at nothing.
    const usesLink = loaded.templateBody
      ? inspectTemplate(loaded.templateBody).used.includes("invoiceLink")
      : false;

    let link: string | null = null;
    let expiresAt: Date | null = null;
    if (mintLink && usesLink) {
      const minted = await mintInvoiceLink(client, {
        invoiceId: loaded.invoiceId,
        guardianId: loaded.guardianId,
        ttlDays: loaded.linkTtlDays,
        createdBy: null,
      });
      link = minted.url;
      expiresAt = minted.expiresAt;
      await audit.record(
        client,
        { actorUserId: null, actorRole: null, requestId: "cli:invoice-message", ip: null },
        {
          action: "invoice.link_create",
          entityType: "invoice",
          entityId: loaded.invoiceId,
          after: { guardianId: loaded.guardianId, expiresAt: minted.expiresAt.toISOString() },
          reason: "invoice-message CLI",
        },
      );
    }

    const plan = buildInvoiceMessage({
      templateBody: loaded.templateBody,
      invoice: loaded.invoice,
      invoiceLink: link,
    });

    if (!plan.sendable) {
      return {
        kind: "refused" as const,
        reason: plan.reason,
        detail: plan.detail,
        templateBody: loaded.templateBody,
        linkMinted: link !== null,
      };
    }

    return {
      kind: "ok" as const,
      expiresAt,
      linkMinted: link !== null,
      result: {
        to: plan.to,
        invoiceNumber: loaded.invoice.invoiceNumber,
        status: loaded.invoice.status,
        amountDue: formatMoney(loaded.invoice.balanceMinor, loaded.invoice.currency),
        link: plan.link,
        text: plan.text,
        deepLink: whatsappDeepLink(plan.to, plan.text),
      } satisfies Result,
    };
  });

  if (outcome.kind === "not-found") {
    throw new Error(`no invoice with number "${invoiceNumber}"`);
  }

  if (outcome.kind === "refused") {
    const how =
      outcome.reason === "TEMPLATE_INCOMPLETE" && !mintLink
        ? "\n  (if it is {{invoiceLink}} that has no value, re-run with --mint-link)"
        : "";
    console.error(`refused (${outcome.reason}): ${outcome.detail}${how}`);
    if (!outcome.templateBody) {
      console.error(`  the "${INVOICE_DELIVERY_TEMPLATE}" template is not seeded or is inactive`);
    }
    process.exitCode = 1;
    return;
  }

  const { result } = outcome;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`invoice : ${result.invoiceNumber} (${result.status})`);
  console.log(`to      : ${result.to ?? "— no guardian phone on file"}`);
  console.log(`due     : ${result.amountDue}`);
  console.log(`link    : ${result.link ?? "— not minted (pass --mint-link to create one)"}`);
  if (outcome.expiresAt) {
    console.log(`expires : ${outcome.expiresAt.toISOString()}`);
  }
  console.log("");
  console.log("--- message ---");
  console.log(result.text);
  console.log("--- end ---");
  console.log("");
  console.log(result.deepLink ? `whatsapp: ${result.deepLink}` : "whatsapp: not available");
  console.log("nothing was sent: sending is M7 and needs the OpenWA number (NEEDS_FROM_OWNER §1.6)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
