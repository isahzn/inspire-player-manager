/**
 * The invoice-delivery message: an invoice plus the owner's template, turned into the exact text
 * a guardian receives.
 *
 * This is deliberately **not** part of the sending path (M7 owns `message_jobs` and the provider).
 * It is the half that decides *what* would be sent and *whether it should be*, so that:
 *
 *  - the owner can see and send the real message today, by hand, without waiting for the queue;
 *  - the queue, when it arrives, calls this and gets the same text — one definition, not two;
 *  - the money in the message is read **from the invoice at that moment**, which is what
 *    OPENWA_INTEGRATION §5 requires: a partly-paid invoice says what is still owed, not what was
 *    billed in the first place.
 *
 * Three refusals are the point of `buildInvoiceMessage`. A message that asks for money must not
 * be produced when there is nothing to ask for (a settled invoice, a void one), when there is
 * nobody to address (no guardian on the invoice), or when the owner's own template has a gap in
 * it. Each is returned as a reason, never as a half-written message.
 */
import { formatDate, formatMoney } from "../files/pdf/format.js";
import type { AnyQueryable } from "../audit.js";
import { fillTemplate, type TemplateValues } from "./template.js";

/** The template key invoice delivery uses (DATABASE §3.6, seeded in `db/seed.sql`). */
export const INVOICE_DELIVERY_TEMPLATE = "invoice_delivery";

export interface InvoiceForMessage {
  invoiceNumber: string;
  status: "issued" | "partially_paid" | "paid" | "void";
  currency: string;
  /** What is still owed, as a `bigint` string — never a float. */
  balanceMinor: string;
  dueDate: string;
  playerName: string;
  guardianName: string | null;
  guardianPhone: string | null;
  academyName: string;
}

export type InvoiceMessageRefusal =
  | "INVOICE_VOID"
  | "NOTHING_DUE"
  | "NO_GUARDIAN"
  | "TEMPLATE_MISSING"
  | "TEMPLATE_INCOMPLETE";

export type InvoiceMessagePlan =
  | {
      sendable: true;
      /** The finished message. */
      text: string;
      /** The guardian's number, or `null` when the invoice has no guardian phone on file. */
      to: string | null;
      /** What each placeholder was filled with — useful in a log, and testable. */
      variables: TemplateValues;
      /** The capability link, when one was supplied. */
      link: string | null;
    }
  | { sendable: false; reason: InvoiceMessageRefusal; detail: string };

/**
 * Builds the message, or says why it must not be sent.
 *
 * `invoiceLink` is the guardian's capability URL (`mintInvoiceLink`, or `PUB-01` later). It is
 * passed in rather than minted here so that a caller can preview the message without creating a
 * token — and so that a template which uses `{{invoiceLink}}` refuses to send when no link was
 * supplied, instead of going out with the placeholder still in it.
 */
export function buildInvoiceMessage(args: {
  templateBody: string | null;
  invoice: InvoiceForMessage;
  invoiceLink?: string | null;
}): InvoiceMessagePlan {
  const { invoice } = args;

  if (invoice.status === "void") {
    return {
      sendable: false,
      reason: "INVOICE_VOID",
      detail: `${invoice.invoiceNumber} is void — nothing can be asked for it.`,
    };
  }

  // The money rule that makes this module worth having: a paid invoice produces no demand.
  if (BigInt(invoice.balanceMinor) <= 0n) {
    return {
      sendable: false,
      reason: "NOTHING_DUE",
      detail: `${invoice.invoiceNumber} has nothing outstanding — do not ask the guardian for payment.`,
    };
  }

  if (!invoice.guardianName) {
    return {
      sendable: false,
      reason: "NO_GUARDIAN",
      detail: `${invoice.invoiceNumber} has no guardian to address. Set the invoice's guardian first.`,
    };
  }

  if (!args.templateBody) {
    return {
      sendable: false,
      reason: "TEMPLATE_MISSING",
      detail: `the "${INVOICE_DELIVERY_TEMPLATE}" template is missing or inactive.`,
    };
  }

  const variables: TemplateValues = {
    guardianName: invoice.guardianName,
    playerName: invoice.playerName,
    invoiceNumber: invoice.invoiceNumber,
    amountDue: formatMoney(invoice.balanceMinor, invoice.currency),
    dueDate: formatDate(invoice.dueDate),
    academyName: invoice.academyName,
    ...(args.invoiceLink ? { invoiceLink: args.invoiceLink } : {}),
  };

  const filled = fillTemplate(args.templateBody, variables);
  if (filled.missing.length > 0 || filled.unknown.length > 0) {
    const parts = [
      filled.missing.length > 0
        ? `no value for ${filled.missing.map((name) => `{{${name}}}`).join(", ")}`
        : null,
      filled.unknown.length > 0
        ? `${filled.unknown.map((name) => `{{${name}}}`).join(", ")} is not a known variable`
        : null,
    ].filter(Boolean);
    return {
      sendable: false,
      reason: "TEMPLATE_INCOMPLETE",
      detail: `the "${INVOICE_DELIVERY_TEMPLATE}" template cannot be filled: ${parts.join("; ")}.`,
    };
  }

  return {
    sendable: true,
    text: filled.text,
    to: invoice.guardianPhone,
    variables,
    link: args.invoiceLink ?? null,
  };
}

export interface LoadedInvoiceMessage {
  invoiceId: string;
  guardianId: string | null;
  invoice: InvoiceForMessage;
  /** The owner's own words, or `null` when the template is missing or switched off. */
  templateBody: string | null;
  /** `invoice_link_ttl_days` (default 30) — how long a minted link lives. */
  linkTtlDays: number;
  /** The academy's timezone, for "today" and for any instant printed back to the operator. */
  timezone: string;
}

interface InvoiceMessageRow {
  id: string;
  invoice_number: string;
  status: InvoiceForMessage["status"];
  currency: string;
  balance_minor: string;
  due_date: string;
  player_name: string;
  guardian_id: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  academy_name: string;
  template_body: string | null;
  invoice_link_ttl_days: number;
  timezone: string;
}

/**
 * Reads everything the message needs, by the invoice's own number.
 *
 * Through the API this runs inside `withTransaction` with the owner's identity set, because
 * money tables and `academy_settings` carry FORCE ROW LEVEL SECURITY — a transaction with no
 * identity reads nothing at all, which would look like "no such invoice". The server-side CLIs
 * pass their migrator client instead, which is the documented exception (`cli-db.ts`).
 */
export async function loadInvoiceMessageInput(
  client: AnyQueryable,
  invoiceNumber: string,
): Promise<LoadedInvoiceMessage | null> {
  const result = await client.query<InvoiceMessageRow>(
    `select i.id, i.invoice_number, i.status, i.currency,
            i.balance_minor::text as balance_minor, i.due_date::text as due_date,
            p.full_name as player_name,
            i.guardian_id, g.full_name as guardian_name, g.phone_e164 as guardian_phone,
            a.name as academy_name, a.invoice_link_ttl_days, a.timezone,
            t.body as template_body
       from invoices i
       join players p on p.id = i.player_id
       left join guardians g on g.id = i.guardian_id
       cross join academy_settings a
       left join message_templates t
              on t.key = $2 and t.is_active
      where i.invoice_number = $1`,
    [invoiceNumber, INVOICE_DELIVERY_TEMPLATE],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    invoiceId: row.id,
    guardianId: row.guardian_id,
    templateBody: row.template_body,
    linkTtlDays: row.invoice_link_ttl_days,
    timezone: row.timezone,
    invoice: {
      invoiceNumber: row.invoice_number,
      status: row.status,
      currency: row.currency.trim(),
      balanceMinor: row.balance_minor,
      dueDate: row.due_date,
      playerName: row.player_name,
      guardianName: row.guardian_name,
      guardianPhone: row.guardian_phone,
      academyName: row.academy_name,
    },
  };
}
