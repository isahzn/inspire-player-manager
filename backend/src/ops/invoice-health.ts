/**
 * Invoice health: what is wrong with the money right now.
 *
 * Every check here exists because the state it detects is either **wrong** (an invoice whose
 * parts do not add up, money recorded against a void invoice, a link that should have been
 * revoked) or **invisible today** and worth seeing (an open invoice whose document was never
 * generated, because nothing yet sweeps `pdf_stale` in the background: FILES_AND_PDF §4's worker
 * is unbuilt, so the gap is reported here rather than hidden).
 *
 * The checks are pure functions over rows, and the loader is separate, so the arithmetic can be
 * tested without a database and the SQL can be tested without repeating the arithmetic. Amounts
 * arrive as `bigint` strings and stay in `BigInt`: an invoice that is out by one cent is exactly
 * the bug this file is for, and a float would round it away.
 */
import type { AnyQueryable } from "../audit.js";
import { formatMoney } from "../files/pdf/format.js";

export type Severity = "error" | "warn" | "info";

export interface InvoiceHealthRow {
  id: string;
  invoiceNumber: string;
  status: "issued" | "partially_paid" | "paid" | "void";
  currency: string;
  dueDate: string;
  totalMinor: string;
  paidMinor: string;
  balanceMinor: string;
  /** Σ `invoice_items.amount_minor`. */
  itemsTotalMinor: string;
  /** Σ live (not reversed) allocations. */
  allocatedMinor: string;
  pdfFileId: string | null;
  pdfStale: boolean;
  pdfGeneratedAt: Date | null;
  guardianName: string | null;
  /** Capability tokens that are neither revoked nor expired. */
  liveLinks: number;
}

export interface HealthFinding {
  code: string;
  severity: Severity;
  invoiceId: string;
  invoiceNumber: string;
  message: string;
}

export interface HealthReport {
  findings: HealthFinding[];
  summary: {
    checked: number;
    errors: number;
    warns: number;
    infos: number;
    overdueCount: number;
    /** Σ of the balances that are past their due date, as a `bigint` string. */
    overdueMinor: string;
  };
}

export interface HealthOptions {
  /** The academy's own "today" (`YYYY-MM-DD`) — overdue is a calendar fact, not a server one. */
  today: string;
  /** How long a document may remain stale before it is worth chasing (FILES_AND_PDF §8: 10). */
  staleMinutes?: number;
  now?: Date;
}

function isOpen(status: InvoiceHealthRow["status"]): boolean {
  return status === "issued" || status === "partially_paid";
}

/**
 * Checks every invoice and returns what should be looked at.
 *
 * Findings are ordered by severity, then by invoice number, so a terminal report reads
 * most-urgent-first without the caller having to sort.
 */
export function checkInvoiceHealth(
  rows: readonly InvoiceHealthRow[],
  options: HealthOptions,
): HealthReport {
  const findings: HealthFinding[] = [];
  const staleMs = (options.staleMinutes ?? 10) * 60 * 1000;
  const now = options.now ?? new Date();

  let overdueCount = 0;
  let overdueMinor = 0n;

  for (const row of rows) {
    const total = BigInt(row.totalMinor);
    const paid = BigInt(row.paidMinor);
    const balance = BigInt(row.balanceMinor);
    const items = BigInt(row.itemsTotalMinor);
    const allocated = BigInt(row.allocatedMinor);

    // Findings are read by a person, so every amount is printed the way the invoice prints it.
    const money = (minor: bigint) => formatMoney(minor.toString(), row.currency);

    const add = (code: string, severity: Severity, message: string) => {
      findings.push({
        code,
        severity,
        invoiceId: row.id,
        invoiceNumber: row.invoiceNumber,
        message,
      });
    };

    // --- the invoice's own arithmetic (FILES_AND_PDF §4's self-check, asked of the row) -----
    if (items !== total) {
      add(
        "INVOICE_TOTAL_MISMATCH",
        "error",
        `the items add up to ${money(items)} but the invoice totals ${money(total)} — its PDF will be refused, and the invoice needs correcting`,
      );
    }
    if (total - paid !== balance) {
      add(
        "INVOICE_BALANCE_MISMATCH",
        "error",
        `balance is ${money(balance)} but total − paid is ${money(total - paid)}`,
      );
    }

    // --- money recorded against the payments -------------------------------------------------
    if (row.status === "void" && allocated > 0n) {
      add(
        "VOID_WITH_ALLOCATIONS",
        "error",
        `${money(allocated)} is still allocated to a void invoice — release the allocations`,
      );
    }
    if (row.status === "paid" && allocated < paid) {
      add(
        "PAID_NOT_ALLOCATED",
        "error",
        `recorded as paid with ${money(paid)} but only ${money(allocated)} is allocated to it`,
      );
    }
    if (allocated > paid) {
      add(
        "ALLOCATION_EXCEEDS_PAID",
        "error",
        `${money(allocated)} is allocated but only ${money(paid)} was recorded as paid`,
      );
    }

    // --- the guardian's link ------------------------------------------------------------------
    if (row.status === "void" && row.liveLinks > 0) {
      add(
        "VOID_WITH_LIVE_LINK",
        "error",
        `${row.liveLinks} capability link(s) still work for a void invoice — they should have been revoked on void`,
      );
    }

    // --- the document --------------------------------------------------------------------------
    if (row.status !== "void" && !row.pdfFileId) {
      add(
        "PDF_MISSING",
        "warn",
        "no PDF has been generated — the guardian's link will answer 404 until it is (INV-07)",
      );
    } else if (row.pdfStale) {
      const staleFor = row.pdfGeneratedAt ? now.getTime() - row.pdfGeneratedAt.getTime() : null;
      if (staleFor !== null && staleFor > staleMs) {
        add(
          "PDF_REBUILD_OVERDUE",
          "warn",
          `the PDF has been stale for ${Math.round(staleFor / 60000)} minutes — regenerate it`,
        );
      } else {
        add("PDF_STALE", "info", "the PDF needs regenerating (INV-07)");
      }
    }

    // --- chasing --------------------------------------------------------------------------------
    if (isOpen(row.status) && balance > 0n && row.dueDate < options.today) {
      overdueCount += 1;
      overdueMinor += balance;
      add(
        "OVERDUE",
        "warn",
        `${money(balance)} was due on ${row.dueDate} and is still outstanding`,
      );
    }

    if (!row.guardianName && balance > 0n && row.status !== "void") {
      add("NO_GUARDIAN", "info", "no guardian is set, so nothing can be sent for it");
    }
  }

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      a.invoiceNumber.localeCompare(b.invoiceNumber) ||
      a.code.localeCompare(b.code),
  );

  return {
    findings,
    summary: {
      checked: rows.length,
      errors: findings.filter((f) => f.severity === "error").length,
      warns: findings.filter((f) => f.severity === "warn").length,
      infos: findings.filter((f) => f.severity === "info").length,
      overdueCount,
      overdueMinor: overdueMinor.toString(),
    },
  };
}

/**
 * Reads every invoice with the four aggregates the checks need, in one query.
 *
 * Through the API this runs with the owner's identity set (`withTransaction`); the CLIs pass
 * their migrator client, which is why the parameter is `AnyQueryable`. A migrator read is the
 * *point* of an integrity check: it must see every row, including one a policy would hide.
 * Void invoices are excluded by default because they are closed business, not work;
 * `--include-void` passes `true`, which is what makes an integrity check over the whole
 * history possible.
 */
export async function loadInvoiceHealthRows(
  client: AnyQueryable,
  options: { includeVoid?: boolean } = {},
): Promise<InvoiceHealthRow[]> {
  const result = await client.query<{
    id: string;
    invoice_number: string;
    status: InvoiceHealthRow["status"];
    currency: string;
    due_date: string;
    total_minor: string;
    paid_minor: string;
    balance_minor: string;
    items_total_minor: string;
    allocated_minor: string;
    pdf_file_id: string | null;
    pdf_stale: boolean;
    pdf_generated_at: Date | null;
    guardian_name: string | null;
    live_links: number;
  }>(
    `select i.id, i.invoice_number, i.status, i.currency, i.due_date::text as due_date,
            i.total_minor::text as total_minor, i.paid_minor::text as paid_minor,
            i.balance_minor::text as balance_minor,
            coalesce(items.total, 0)::text as items_total_minor,
            coalesce(allocs.total, 0)::text as allocated_minor,
            i.pdf_file_id, i.pdf_stale, i.pdf_generated_at,
            g.full_name as guardian_name,
            coalesce(links.live, 0)::int as live_links
       from invoices i
       left join guardians g on g.id = i.guardian_id
       left join (
         select invoice_id, sum(amount_minor) as total
           from invoice_items group by invoice_id
       ) items on items.invoice_id = i.id
       left join (
         select invoice_id, sum(amount_minor) as total
           from payment_allocations
          where reversed_at is null
          group by invoice_id
       ) allocs on allocs.invoice_id = i.id
       left join (
         select invoice_id, count(*) as live
           from invoice_access_tokens
          where revoked_at is null and expires_at > now()
          group by invoice_id
       ) links on links.invoice_id = i.id
      where ($1::boolean or i.status <> 'void')
      order by i.issue_date asc, i.invoice_number asc`,
    [options.includeVoid ?? false],
  );

  return result.rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency.trim(),
    dueDate: row.due_date,
    totalMinor: row.total_minor,
    paidMinor: row.paid_minor,
    balanceMinor: row.balance_minor,
    itemsTotalMinor: row.items_total_minor,
    allocatedMinor: row.allocated_minor,
    pdfFileId: row.pdf_file_id,
    pdfStale: row.pdf_stale,
    pdfGeneratedAt: row.pdf_generated_at,
    guardianName: row.guardian_name,
    liveLinks: row.live_links,
  }));
}
