/**
 * `check:invoices` — the invoice checker.
 *
 *   npm run check:invoices
 *   npm run check:invoices -- --include-void --fail-on warn
 *   npm run check:invoices -- --json
 *
 * Answers one question: **is anything in the books wrong right now, and what should be done about
 * it?** It reads every invoice with the aggregates the checks need and reports what does not add
 * up — an invoice whose lines do not sum to its total, money allocated against a void one, a link
 * that outlived its invoice, a document that was never generated — plus what is merely overdue.
 *
 * It is read-only. Nothing here can change an invoice: a wrong invoice is fixed by voiding and
 * reissuing (`INV-04` / `INV-05`) or by an adjustment (`INV-09`), and those are decisions with a
 * reason attached, which a checker cannot supply.
 *
 * Exit code: 0 when nothing at or above `--fail-on` was found (default `error`), 1 otherwise — so
 * it can gate a release or a cron run without parsing the text.
 */
import { config as loadEnv } from "dotenv";
import { formatMoney } from "../src/files/pdf/format.js";
import { checkInvoiceHealth, loadInvoiceHealthRows } from "../src/ops/invoice-health.js";
import { todayInTimeZone } from "../src/routes/people-helpers.js";
import { parseArgs, withCliTransaction } from "./lib/cli-db.js";

loadEnv();

const SEVERITIES = ["error", "warn", "info"] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const includeVoid = args["include-void"] === true;
  const asJson = args["json"] === true;
  const failOnRaw = typeof args["fail-on"] === "string" ? args["fail-on"] : "error";
  if (!SEVERITIES.includes(failOnRaw as (typeof SEVERITIES)[number])) {
    throw new Error(`--fail-on must be one of ${SEVERITIES.join(" | ")}`);
  }
  const failOn = failOnRaw as (typeof SEVERITIES)[number];
  const staleMinutes =
    typeof args["stale-minutes"] === "string" ? Number(args["stale-minutes"]) : undefined;
  if (staleMinutes !== undefined && (!Number.isInteger(staleMinutes) || staleMinutes < 0)) {
    throw new Error("--stale-minutes must be a non-negative whole number");
  }

  const loaded = await withCliTransaction(async (client) => {
    const settings = await client.query<{ currency: string; timezone: string }>(
      "select currency, timezone from academy_settings where id = 1",
    );
    const row = settings.rows[0];
    if (!row) throw new Error("academy_settings has no row — run `npm run migrate:seed`");
    const rows = await loadInvoiceHealthRows(client, { includeVoid });
    return { currency: row.currency.trim(), timezone: row.timezone, rows };
  });

  // Overdue is a calendar fact in the academy's timezone, not the server's (ADR-010).
  const today =
    typeof args["today"] === "string" ? args["today"] : todayInTimeZone(loaded.timezone);

  const report = checkInvoiceHealth(loaded.rows, {
    today,
    ...(staleMinutes !== undefined ? { staleMinutes } : {}),
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          today,
          timezone: loaded.timezone,
          includeVoid,
          ...report,
        },
        null,
        2,
      ),
    );
  } else {
    const { summary } = report;
    console.log(
      `invoice health — ${summary.checked} invoice(s) checked` +
        `${includeVoid ? " including void" : " (void excluded)"} · today ${today} ${loaded.timezone}`,
    );

    if (report.findings.length === 0) {
      console.log("  nothing to report.");
    } else {
      for (const severity of SEVERITIES) {
        const group = report.findings.filter((f) => f.severity === severity);
        if (group.length === 0) continue;
        console.log("");
        console.log(severity.toUpperCase());
        for (const finding of group) {
          console.log(`  ${finding.invoiceNumber}  ${finding.code}`);
          console.log(`      ${finding.message}`);
        }
      }
    }

    console.log("");
    console.log(
      `summary: ${summary.errors} error(s) · ${summary.warns} warning(s) · ${summary.infos} note(s) · ` +
        `${summary.overdueCount} overdue (${formatMoney(summary.overdueMinor, loaded.currency)})`,
    );
  }

  // `SEVERITIES` is ordered worst-first, so "at or above" is a prefix of it.
  const threshold = SEVERITIES.indexOf(failOn);
  const failing = report.findings.filter(
    (finding) => SEVERITIES.indexOf(finding.severity) <= threshold,
  ).length;
  if (failing > 0) {
    process.exitCode = 1;
    if (!asJson) console.log(`failing: ${failing} finding(s) at or above "${failOn}"`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
