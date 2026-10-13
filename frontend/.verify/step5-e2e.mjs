// Step 5 E2E (mock mode, system Chrome): proves the money slice through the UI
// an owner actually uses — the billing hub and its filters, the billing-run
// wizard (preview → issue → PREVIEW_STALE), the invoice actions (discount, void
// with released allocations, PDF-not-ready polling) and the payments side
// (list tabs, record + allocate, and the CR-004 proof verification panel).
//
// The money rules are asserted where they matter: a failed check must NOT change
// a payment, an invoice void must release its allocations into credit, an
// allocation above a balance must be refused, and no screen may render the word
// "Verified" or a green tick where money is concerned (ADR-013/ADR-020/ADR-021).
//
// Run with `npm run dev` already listening on :3100 (mock mode). Every browser
// context is fresh, so the mock store starts from its seed each run.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

// Fixture ids from src/mocks/db.ts (seeded, deterministic).
const INV_PART = "0192a000-0000-7000-8000-0000000000d1"; // INV-2026-000101, part paid, overdue, has allocations
const INV_ISSUED = "0192a000-0000-7000-8000-0000000000d4"; // INV-2026-000103, issued, guardian c2
const INV_NO_PDF = "0192a000-0000-7000-8000-0000000000d7"; // INV-2026-000106, issued, PDF not generated
const PAY_CLEANED = "0192a000-0000-7000-8000-0000000000p1"; // confirmed, holds credit
const PAY_PENDING_PDF = "0192a000-0000-7000-8000-0000000000p3"; // pending, PDF receipt to check (reused ref)
const PAY_PENDING_IMG = "0192a000-0000-7000-8000-0000000000p4"; // pending, photo only
const GUARDIAN_C2 = "0192a000-0000-7000-8000-0000000000c2";

const DIALOG = (title) => `div[role="dialog"][aria-label="${title}"]`;

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

/** Text of the rendered invoice rows only (not the filter controls). */
const INVOICE_ROWS = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Invoices"] li')).map((li) => li.textContent ?? "");
const PAYMENT_ROWS = () =>
  Array.from(document.querySelectorAll('ul[aria-label="Payments"] li')).map((li) => li.textContent ?? "");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  return ctx.newPage();
}

/**
 * GET JSON through the app's own fetch (so MSW answers), retrying while the
 * document is mid-navigation — a fetch fired in that window can reach Next.js
 * instead of the mock and come back as HTML.
 */
async function fetchJson(page, path, tries = 6) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    const out = await page.evaluate(async (p) => {
      try {
        const res = await fetch(p);
        return { status: res.status, text: await res.text() };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    }, path);
    try {
      return { status: out.status, json: JSON.parse(out.text) };
    } catch {
      last = out;
      await page.waitForTimeout(700);
    }
  }
  return { status: last?.status ?? 0, json: null };
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", username);
  await page.fill("#password", "anypassword1");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

/** Wait until the invoice rows are present. */
async function waitInvoices(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('ul[aria-label="Invoices"] li').length > 0,
    null,
    { timeout: 25000 }
  );
}

try {
  // ---------------------------------------------------------- owner: billing hub
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");
    await page.goto(`${BASE}/billing`, { waitUntil: "domcontentloaded" });
    await waitInvoices(page);

    const rows = await page.evaluate(INVOICE_ROWS);
    const body = await page.textContent("body");
    // Note: a part-paid invoice that is past its due date shows the DERIVED
    // "Overdue" chip, not "Partially paid" (BILLING_ENGINE §10/§12) — the label
    // logic in lib/billing.ts deliberately prioritises overdue.
    check(
      "the invoices tab lists every status, including the void one",
      rows.length === 7 &&
        rows.some((r) => r.includes("Issued")) &&
        rows.some((r) => r.includes("Paid")) &&
        rows.filter((r) => r.includes("Overdue")).length === 2 &&
        rows.some((r) => r.includes("Void")),
      `${rows.length} rows`
    );
    check(
      "each row carries invoice number, player, balance and a status word",
      rows.every((r) => /INV-\d{4}-\d{6}/.test(r)) && rows.every((r) => /Rs\.|LKR/.test(r))
    );
    // Seeded state: outstanding 16,500.00 over the four open invoices, overdue
    // 7,500.00 over INV-101 and INV-106. Both figures are on the page.
    check(
      "the KPI header shows Outstanding and Overdue separately",
      body.includes("Outstanding") && body.includes("Overdue") && body.includes("Rs. 16,500"),
      body.includes("Rs. 16,500") ? "" : "expected Rs. 16,500 outstanding"
    );
    check("Invoiced and Collected are never added together", !/Invoiced\s*\+\s*Collected/i.test(body));
    await page.screenshot({ path: `${OUT}billing-invoices-1280.png` });

    // Filters live in the URL and two quick changes must both survive (the same
    // stale-URL race fixed for /players and /sessions, checked on this copy).
    await page.selectOption("#invoice-status", "paid");
    await page.waitForFunction(() => location.search.includes("status=paid"), null, { timeout: 15000 });
    await page.selectOption("#invoice-group", { index: 1 });
    await page.waitForFunction(
      () => location.search.includes("status=paid") && location.search.includes("ageGroupId="),
      null,
      { timeout: 20000 }
    );
    check(
      "two quick filter changes both survive (no stale-URL write)",
      page.url().includes("status=paid") && page.url().includes("ageGroupId=")
    );
    await page.selectOption("#invoice-status", "");
    await page.waitForFunction(() => !location.search.includes("status="), null, { timeout: 15000 });
    // Clear the group filter first: it is still in the URL from the race check,
    // and only one seeded invoice is both Under-11 and overdue.
    await page.selectOption("#invoice-group", "");
    await page.waitForFunction(() => !location.search.includes("ageGroupId="), null, { timeout: 15000 });
    // The URL is the source of truth, so a controlled checkbox lags a click by
    // one render — click and wait for the query rather than using check().
    await page.click("#invoice-overdue");
    await page.waitForFunction(() => location.search.includes("overdue=true"), null, { timeout: 15000 });
    await page.waitForFunction(
      () => {
        const li = Array.from(document.querySelectorAll('ul[aria-label="Invoices"] li'));
        return li.length > 0 && li.every((row) => row.textContent?.includes("Overdue"));
      },
      null,
      { timeout: 20000 }
    );
    const overdueRows = await page.evaluate(INVOICE_ROWS);
    check(
      "the overdue filter keeps only overdue invoices",
      overdueRows.length === 2 && overdueRows.every((r) => r.includes("Overdue")),
      `${overdueRows.length} rows`
    );
    await page.click("#invoice-overdue");
    await page.waitForFunction(() => !location.search.includes("overdue="), null, { timeout: 15000 });

    // The runs tab is a separate view of BIL-03.
    await page.click('[role="tab"]:has-text("Runs")');
    await page.waitForFunction(
      () => document.body.innerText.includes("scheduler:") || document.body.innerText.includes("No billing runs"),
      null,
      { timeout: 20000 }
    );
    const runsText = await page.textContent("body");
    check(
      "the runs tab lists the seeded billing run with its counts",
      runsText.includes("3") && /INV-|created/i.test(runsText)
    );
    await page.screenshot({ path: `${OUT}billing-runs-1280.png` });

    // ------------------------------------------------- invoice: discount + void
    await page.goto(`${BASE}/billing/invoices/${INV_PART}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#invoice-adjust", { timeout: 25000 });
    const invoiceBody = await page.textContent("body");
    check(
      "the invoice detail shows its fee line, totals and the payment that paid it",
      invoiceBody.includes("Monthly fee") &&
        invoiceBody.includes("LKR 4,000.00") &&
        invoiceBody.includes("INV-2026-000101") &&
        invoiceBody.includes("LKR 2,500.00"),
      "expects subtotal 4,000.00 and balance 2,500.00"
    );
    const allocationLink = await page
      .locator(`ul[aria-label="Allocations"] a[href="/payments/${PAY_CLEANED}"]`)
      .count();
    check("the allocations list links to the payment that made them", allocationLink >= 1);
    await page.screenshot({ path: `${OUT}invoice-detail-1280.png` });

    // A discount larger than the balance is refused by the app, nothing written.
    await page.click("#invoice-adjust");
    await page.waitForSelector(DIALOG("Add discount"), { timeout: 15000 });
    await page.fill(`${DIALOG("Add discount")} #adjust-amount`, "9999");
    await page.fill(`${DIALOG("Add discount")} #adjust-reason`, "Trying too much on purpose.");
    await page.click(`${DIALOG("Add discount")} button:has-text("Record discount")`);
    await page.waitForTimeout(600);
    const tooBig = await page.textContent(DIALOG("Add discount"));
    check(
      "a discount above the remaining balance is refused before any request",
      /Cannot be more than the balance/.test(tooBig),
      tooBig.replace(/\s+/g, " ").slice(0, 120)
    );

    // A valid waiver reduces the balance.
    await page.fill(`${DIALOG("Add discount")} #adjust-amount`, "500");
    await page.fill(`${DIALOG("Add discount")} #adjust-reason`, "Goodwill waiver agreed with the guardian.");
    await page.click(`${DIALOG("Add discount")} button:has-text("Record discount")`);
    await page.waitForFunction(
      () => document.body.innerText.includes("LKR 2,000.00"),
      null,
      { timeout: 25000 }
    );
    check("a valid waiver reduces the invoice balance", true, "balance 2,500.00 → 2,000.00");

    // Voiding an invoice that has allocations must ask for the release first.
    await page.click("#invoice-void");
    await page.waitForSelector(DIALOG("Void invoice"), { timeout: 15000 });
    await page.fill(`${DIALOG("Void invoice")} #void-reason`, "Duplicated the October run by mistake.");
    await page.click(`${DIALOG("Void invoice")} button:has-text("Void invoice")`);
    await page.waitForTimeout(900);
    const voidText = await page.textContent(DIALOG("Void invoice"));
    check(
      "voiding an invoice with allocations is refused until they are released",
      /release|allocated/i.test(voidText),
      voidText.replace(/\s+/g, " ").slice(0, 140)
    );

    await page.click(`${DIALOG("Void invoice")} #void-release`);
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.checked === true,
      `${DIALOG("Void invoice")} #void-release`,
      { timeout: 10000 }
    );
    await page.click(`${DIALOG("Void invoice")} button:has-text("Void invoice")`);
    await page.waitForFunction(
      () => document.body.innerText.includes("Void") && document.body.innerText.includes("Duplicated the October run"),
      null,
      { timeout: 25000 }
    );
    const voidedBody = await page.textContent("body");
    const invoiceAfterVoid = await fetchJson(page, `/invoices/${INV_PART}`);
    const paymentAfterVoid = await fetchJson(page, `/payments/${PAY_CLEANED}`);
    check(
      "a voided invoice keeps its reason and drops out of outstanding",
      invoiceAfterVoid.json?.status === "void" &&
        invoiceAfterVoid.json?.balanceMinor === 0 &&
        voidedBody.includes("Duplicated the October run")
    );
    check(
      "releasing the allocations turns them into payment credit",
      paymentAfterVoid.json?.status === "confirmed" &&
        paymentAfterVoid.json?.allocatedMinor === 400000 &&
        paymentAfterVoid.json?.unallocatedMinor === 600000,
      `allocated ${paymentAfterVoid.json?.allocatedMinor} · credit ${paymentAfterVoid.json?.unallocatedMinor}`
    );
    check(
      "a void invoice offers no money actions",
      (await page.locator("#invoice-adjust").count()) === 0 &&
        (await page.locator("#invoice-void").count()) === 0
    );
    await page.screenshot({ path: `${OUT}invoice-void-1280.png` });

    // --------------------------------------------- invoice: PDF not ready yet
    await page.goto(`${BASE}/billing/invoices/${INV_NO_PDF}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#invoice-pdf", { timeout: 25000 });
    await page.click("#invoice-pdf");
    await page.waitForFunction(
      () => document.body.innerText.includes("Preparing PDF"),
      null,
      { timeout: 15000 }
    );
    check("a missing PDF shows “Preparing PDF…” while it is retried", true);
    const pdfBefore = await page.evaluate(
      async (id) => (await fetch(`/invoices/${id}/pdf`)).status,
      INV_NO_PDF
    );
    check("INV-06 answers 409 PDF_NOT_READY while it is not built", pdfBefore === 409, `status ${pdfBefore}`);
    await page.click("#invoice-pdf-regenerate");
    await page.waitForTimeout(800);
    const pdfAfter = await page.evaluate(async (id) => {
      const res = await fetch(`/invoices/${id}/pdf`);
      const type = res.headers.get("Content-Type") ?? "";
      const buffer = await res.arrayBuffer();
      const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5)));
      return { status: res.status, type, head };
    }, INV_NO_PDF);
    check(
      "regenerating rebuilds the PDF and INV-06 streams a real PDF",
      pdfAfter.status === 200 && pdfAfter.type.includes("application/pdf") && pdfAfter.head === "%PDF-",
      `${pdfAfter.type} ${pdfAfter.head}`
    );

    // ---------------------------------------------------------- payments list
    await page.goto(`${BASE}/payments`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelectorAll('ul[aria-label="Payments"] li').length > 0,
      null,
      { timeout: 25000 }
    );
    let payBody = await page.textContent("body");
    const payRows = await page.evaluate(PAYMENT_ROWS);
    check(
      "the payments list shows every seeded status",
      payRows.some((r) => r.includes("Pending")) &&
        payRows.some((r) => r.includes("Confirmed")) &&
        payRows.some((r) => r.includes("Rejected")) &&
        payRows.some((r) => r.includes("Reversed")),
      `${payRows.length} rows`
    );
    check(
      "a pending amount reads “Pending verification”, never a confirmation",
      payRows.some((r) => r.includes("Pending verification")) && !/\bVerified\b/.test(payBody)
    );
    check(
      "the list shows the credit a confirmed payment is holding",
      payRows.some((r) => /credited Rs\. [1-9]/.test(r))
    );
    check(
      "an already-confirmed payment is never labelled “ready to confirm”",
      !payRows.some((r) => r.includes("Confirmed") && r.includes("Ready to confirm"))
    );
    await page.screenshot({ path: `${OUT}payments-1280.png` });

    await page.click('[role="tab"]:has-text("Pending")');
    await page.waitForFunction(
      () => {
        const li = Array.from(document.querySelectorAll('ul[aria-label="Payments"] li'));
        return li.length > 0 && li.every((row) => row.textContent?.includes("Pending"));
      },
      null,
      { timeout: 20000 }
    );
    check("the Pending tab filters on the wire, not just the DOM", page.url().includes("tab=pending"));
    await page.click('[role="tab"]:has-text("With credit")');
    await page.waitForFunction(
      () => {
        const li = Array.from(document.querySelectorAll('ul[aria-label="Payments"] li'));
        return li.length > 0 && li.every((row) => /credited Rs\. [1-9]/.test(row.textContent ?? ""));
      },
      null,
      { timeout: 20000 }
    );
    check("the With credit tab shows only payments holding credit", true);

    // ------------------------------------ CR-004: the verification panel (PDF)
    await page.goto(`${BASE}/payments/${PAY_PENDING_PDF}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#payment-confirm", { timeout: 25000 });
    let detailBody = await page.textContent("body");
    check(
      "a pending bank transfer starts unverified with its evidence disclaimer",
      detailBody.includes("Pending verification") &&
        detailBody.includes("A proof is evidence only") &&
        detailBody.includes("Not checked yet")
    );
    const verifyButton = page.locator("[data-verify-proof]").first();
    check("the proof panel offers the manual re-check (PRF-04)", (await verifyButton.count()) >= 1);
    await verifyButton.click();
    await page.waitForSelector('ul[aria-label="Findings"] li', { timeout: 25000 });
    const findings = await page.textContent('ul[aria-label="Findings"]');
    const extract = await page.textContent("[data-proof-extract]");
    check(
      "the check reads the receipt's facts and shows them as labelled fields",
      extract.includes("Reference") && extract.includes("DEMO-REF-0001") && extract.includes("Beneficiary")
    );
    check(
      "a reused receipt is a failure with a plain-language explanation",
      findings.includes("RECEIPT_NOT_REUSED") &&
        findings.includes("Failed") &&
        findings.includes("already attached to another payment"),
      findings.replace(/\s+/g, " ").slice(0, 120)
    );
    // Read the body again: the advisory note only exists once a check has run.
    const afterCheckBody = await page.textContent("body");
    check(
      "the panel states that checks are advisory and level 3 is not available",
      afterCheckBody.includes("never confirm, reject, allocate or change a balance") &&
        afterCheckBody.includes("not available yet") &&
        afterCheckBody.includes("Pending verification")
    );
    const stillPending = await fetchJson(page, `/payments/${PAY_PENDING_PDF}`);
    check(
      "a failed check does not touch the payment — it is still pending with no receipt",
      stillPending.json?.status === "pending" &&
        stillPending.json?.receipt === undefined &&
        (stillPending.json?.allocations ?? []).length === 0
    );
    await page.screenshot({ path: `${OUT}payment-verification-1280.png` });

    // --------------------------------- CR-004: photo-only proof cannot verify
    await page.goto(`${BASE}/payments/${PAY_PENDING_IMG}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-payment-label]', { timeout: 25000 });
    const imgLabel = await page.getAttribute("[data-payment-label]", "data-payment-label");
    const imgBody = await page.textContent("body");
    check(
      "a photo-only proof reads “Not verifiable — ask for the PDF”",
      imgLabel === "unverifiable" && imgBody.includes("Not verifiable — ask for the PDF")
    );
    check("the PDF-first prompt offers the copy/wa.me fallback", (await page.locator("#ask-for-pdf").count()) === 1);
    await page.locator("[data-verify-proof]").first().click();
    await page.waitForSelector('ul[aria-label="Findings"] li', { timeout: 25000 });
    const imgFindings = await page.textContent('ul[aria-label="Findings"]');
    const imgAfter = await fetchJson(page, `/payments/${PAY_PENDING_IMG}`);
    check(
      "a photo can never produce a passing check, and the payment stays pending",
      imgFindings.includes("SUPPORTING_ONLY") &&
        imgAfter.json?.status === "pending" &&
        imgAfter.json?.proofVerification?.status === "unverifiable",
      `rollup ${imgAfter.json?.proofVerification?.status}`
    );

    // ------------------------------------------- confirm a pending payment
    await page.goto(`${BASE}/payments/${PAY_PENDING_PDF}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#payment-confirm", { timeout: 25000 });
    await page.click("#payment-confirm");
    await page.waitForSelector(DIALOG("Confirm payment"), { timeout: 15000 });
    const confirmDialog = await page.textContent(DIALOG("Confirm payment"));
    check(
      "confirming is described as the owner's decision, not the check's outcome",
      /only thing that changes a balance/i.test(confirmDialog)
    );
    await page.click(`${DIALOG("Confirm payment")} button:has-text("Confirm payment")`);
    await page.waitForFunction(
      () => document.body.innerText.includes("Receipt") && !document.body.innerText.includes("Pending verification"),
      null,
      { timeout: 25000 }
    );
    const confirmed = await fetchJson(page, `/payments/${PAY_PENDING_PDF}`);
    check(
      "confirming issues a receipt and drops the pending banner",
      confirmed.json?.status === "confirmed" &&
        Boolean(confirmed.json?.receipt?.receiptNumber) &&
        confirmed.json?.unallocatedMinor === confirmed.json?.amountMinor,
      `receipt ${confirmed.json?.receipt?.receiptNumber}`
    );
    const receiptPdf = await page.evaluate(async (id) => {
      const list = await (await fetch(`/receipts?paymentId=${id}`)).json();
      const res = await fetch(`/receipts/${list.data[0].id}/pdf`);
      const head = new TextDecoder().decode(new Uint8Array((await res.arrayBuffer()).slice(0, 5)));
      return { count: list.data.length, number: list.data[0].receiptNumber, status: res.status, head };
    }, PAY_PENDING_PDF);
    check(
      "RCT-01 lists the receipt and RCT-02 streams its PDF",
      receiptPdf.count === 1 && receiptPdf.status === 200 && receiptPdf.head === "%PDF-",
      `${receiptPdf.number}`
    );
    await page.screenshot({ path: `${OUT}payment-confirmed-1280.png` });

    // ------------------------------------------------------- record a payment
    await page.goto(`${BASE}/payments/new?guardianId=${GUARDIAN_C2}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#pay-amount", { timeout: 25000 });
    await page.fill("#pay-amount", "2000");
    const parsedEcho = await page.textContent("body");
    check(
      "the amount field echoes the parsed amount in minor-unit formatting",
      parsedEcho.includes("LKR 2,000.00")
    );
    await page.selectOption("#pay-method", "cash");
    await page.fill("#pay-received-at", new Date().toISOString().slice(0, 10));
    await page.click('input[name="pay-status"][value="confirmed"], #pay-status >> nth=0').catch(() => {});
    // Status radios: pick Confirmed explicitly by label if the control is a group.
    const confirmedRadio = page.getByLabel(/^Confirmed$/);
    if (await confirmedRadio.count()) await confirmedRadio.first().check();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-allocation-invoice]").length > 0,
      null,
      { timeout: 20000 }
    );
    const allocationField = page.locator(`[data-allocation-invoice="${INV_ISSUED}"]`).first();
    await allocationField.fill("1500");
    await page.waitForFunction(
      () => document.body.innerText.includes("Credit") && /LKR 500\.00|Rs\. 500/.test(document.body.innerText),
      null,
      { timeout: 15000 }
    );
    check("the allocation editor shows the remainder as credit", true);
    await page.click('button[type="submit"]:has-text("Record payment")');
    await page.waitForFunction(
      () => location.pathname.startsWith("/payments/") && location.pathname !== "/payments/new",
      null,
      { timeout: 30000 }
    );
    await page.waitForSelector("#payment-status", { timeout: 25000 });
    await page.waitForFunction(
      () => document.body.innerText.includes("Allocations"),
      null,
      { timeout: 25000 }
    );
    const newPaymentBody = await page.textContent("body");
    const newPaymentId = new URL(page.url()).pathname.split("/").pop();
    check(
      "recording a payment lands on its detail with an allocation and a receipt",
      newPaymentBody.includes("INV-2026-000103") && newPaymentBody.includes("RCT-"),
      `id ${newPaymentId}`
    );
    const invoiceAfterPayment = await fetchJson(page, `/invoices/${INV_ISSUED}`);
    check(
      "allocating the payment reduces the invoice balance",
      invoiceAfterPayment.json?.paidMinor === 150000 && invoiceAfterPayment.json?.balanceMinor === 350000,
      `paid ${invoiceAfterPayment.json?.paidMinor} · balance ${invoiceAfterPayment.json?.balanceMinor}`
    );

    // ------------------------------------------ money rules against the API
    const rules = await page.evaluate(
      async ({ paymentId, invoiceId, guardianId }) => {
        const post = async (url, body, key) => {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(key ? { "Idempotency-Key": key } : {}),
            },
            body: JSON.stringify(body),
          });
          return {
            status: res.status,
            replay: res.headers.get("Idempotent-Replay"),
            json: await res.json().catch(() => null),
          };
        };
        const payment = await (await fetch(`/payments/${paymentId}`)).json();
        const tooMuch = await post(
          `/payments/${paymentId}/allocate`,
          { allocations: [{ invoiceId, amountMinor: 999900 }], version: payment.version },
          "e2e-step5-over"
        );
        const noKey = await post(
          "/payments",
          {
            amountMinor: 100000,
            methodCode: "cash",
            receivedAt: new Date().toISOString(),
            status: "confirmed",
            payerGuardianId: guardianId,
          },
          null
        );
        const keyed = "e2e-step5-replay";
        const first = await post(
          "/payments",
          {
            amountMinor: 123400,
            methodCode: "cash",
            receivedAt: new Date().toISOString(),
            status: "confirmed",
            payerGuardianId: guardianId,
            notes: "Idempotency check.",
          },
          keyed
        );
        const second = await post(
          "/payments",
          {
            amountMinor: 123400,
            methodCode: "cash",
            receivedAt: new Date().toISOString(),
            status: "confirmed",
            payerGuardianId: guardianId,
            notes: "Idempotency check.",
          },
          keyed
        );
        const duplicateReference = await post(
          "/payments",
          {
            amountMinor: 200000,
            methodCode: "bank_transfer",
            reference: "TRX99",
            receivedAt: new Date().toISOString(),
            status: "pending",
            payerGuardianId: guardianId,
          },
          "e2e-step5-dup"
        );
        const pendingAllocation = await post(
          "/payments",
          {
            amountMinor: 100000,
            methodCode: "bank_transfer",
            reference: "E2E-PENDING-1",
            receivedAt: new Date().toISOString(),
            status: "pending",
            payerGuardianId: guardianId,
            allocations: [{ invoiceId, amountMinor: 100000 }],
          },
          "e2e-step5-pending-alloc"
        );
        return { tooMuch, noKey, first, second, duplicateReference, pendingAllocation };
      },
      { paymentId: newPaymentId, invoiceId: INV_ISSUED, guardianId: GUARDIAN_C2 }
    );
    check(
      "an allocation above the invoice balance is 409 ALLOCATION_EXCEEDS_BALANCE",
      rules.tooMuch.status === 409 && rules.tooMuch.json?.error?.code === "ALLOCATION_EXCEEDS_BALANCE",
      `status ${rules.tooMuch.status} ${rules.tooMuch.json?.error?.code ?? ""}`
    );
    check(
      "a money request without an Idempotency-Key is 400",
      rules.noKey.status === 400 && rules.noKey.json?.error?.code === "IDEMPOTENCY_KEY_REQUIRED",
      `status ${rules.noKey.status}`
    );
    check(
      "a repeated Idempotency-Key replays instead of recording twice",
      rules.first.status === 201 && rules.second.status === 201 && rules.second.replay === "true",
      `first ${rules.first.status} · replay ${rules.second.replay}`
    );
    check(
      "a duplicate bank reference is 409 PAYMENT_DUPLICATE_REFERENCE",
      rules.duplicateReference.status === 409 &&
        rules.duplicateReference.json?.error?.code === "PAYMENT_DUPLICATE_REFERENCE"
    );
    check(
      "a pending payment cannot be allocated in the same request — 409 PAYMENT_NOT_CONFIRMED",
      rules.pendingAllocation.status === 409 &&
        rules.pendingAllocation.json?.error?.code === "PAYMENT_NOT_CONFIRMED",
      `status ${rules.pendingAllocation.status} ${rules.pendingAllocation.json?.error?.code ?? ""}`
    );

    // ------------------------------------------------- reverse the payment
    await page.goto(`${BASE}/payments/${newPaymentId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#payment-reverse", { timeout: 25000 });
    await page.click("#payment-reverse");
    await page.waitForSelector(DIALOG("Reverse payment"), { timeout: 15000 });
    const reverseText = await page.textContent(DIALOG("Reverse payment"));
    check(
      "reversing warns which invoices will be open again",
      reverseText.includes("INV-2026-000103")
    );
    await page.fill(`${DIALOG("Reverse payment")} #reason-text`, "Recorded against the wrong payer.");
    await page.click(`${DIALOG("Reverse payment")} button:has-text("Reverse payment")`);
    await page.waitForFunction(
      () => document.body.innerText.includes("Reversed"),
      null,
      { timeout: 25000 }
    );
    const reopened = await fetchJson(page, `/invoices/${INV_ISSUED}`);
    check(
      "reversing reopens the invoice it paid",
      reopened.json?.paidMinor === 0 &&
        reopened.json?.balanceMinor === 500000 &&
        reopened.json?.status === "issued",
      `balance ${reopened.json?.balanceMinor}`
    );

    // ----------------------------------------------------------- the wizard
    await page.goto(`${BASE}/billing/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#run-target-date", { timeout: 25000 });
    const target = new Date();
    target.setUTCMonth(target.getUTCMonth() + 2);
    const targetDate = target.toISOString().slice(0, 10);
    await page.fill("#run-target-date", targetDate);
    await page.click("#run-preview");
    await page.waitForSelector('ul[aria-label="Billing preview lines"] li', { timeout: 25000 });
    const previewRows = await page.locator('ul[aria-label="Billing preview lines"] li').count();
    const previewBody = await page.textContent("body");
    check(
      "the wizard previews lines with a count and total before anything is issued",
      // `\s` rather than a literal space: the rendered copy separates the count,
      // the separator and the currency with non-breaking spaces.
      previewRows > 0 && /\d+ lines? ·\s*(?:LKR|Rs\.)\s?[\d,]+\.\d{2}/.test(previewBody),
      `${previewRows} lines`
    );
    if (previewBody.includes("Skipped")) {
      check(
        "skipped players are explained in plain language, not as raw codes",
        !previewBody.includes("NO_GROUP") || previewBody.includes("No age group"),
        "plain-language reason shown alongside"
      );
    }
    await page.click("#run-continue");
    await page.waitForSelector("#run-issue", { timeout: 15000 });
    await page.click("#run-issue");
    // The done step is the only place that renders the "View invoices" link to
    // the invoices tab. Matching on body copy is not enough: the step-3 helper
    // text already contains the word "created", so a text match resolves while
    // the request is still in flight.
    await page.waitForSelector('a[href="/billing?tab=invoices"]', { timeout: 30000 });
    const doneText = await page.textContent("body");
    check("issuing the run reports what was created", /\d[\d,]*\s+invoices?\s+created/.test(doneText), doneText.match(/\d[\d,]*\s+invoices?\s+created[^.]*/)?.[0] ?? "no summary");
    await page.screenshot({ path: `${OUT}billing-run-result-1280.png` });

    // The same preview hash now describes a state that has moved on: issuing
    // again must be refused as PREVIEW_STALE, and the wizard must re-preview.
    // A later period that still has billable lines: the first issue moves the
    // state on, so replaying the same (now stale) hash must be refused.
    const staleHash = await page.evaluate(async (suffix) => {
      const targetDate = "2027-01-15";
      const previewRes = await fetch("/billing/previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDate }),
      });
      const preview = await previewRes.json();
      const created = await fetch("/billing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `e2e-step5-stale-a-${suffix}` },
        body: JSON.stringify({ targetDate, previewHash: preview.previewHash }),
      });
      const second = await fetch("/billing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `e2e-step5-stale-b-${suffix}` },
        body: JSON.stringify({ targetDate, previewHash: preview.previewHash }),
      });
      return {
        lines: preview.lines?.length ?? 0,
        created: created.status,
        second: second.status,
        body: await second.json().catch(() => null),
      };
    }, Date.now());
    check(
      "a preview that still has billable lines issues successfully",
      staleHash.created === 201 && staleHash.lines > 0,
      `${staleHash.lines} lines · first ${staleHash.created}`
    );
    check(
      "issuing against a preview that has moved on is 409 PREVIEW_STALE",
      staleHash.second === 409 && staleHash.body?.error?.code === "PREVIEW_STALE",
      `first ${staleHash.created} · second ${staleHash.second}`
    );
    check(
      "the same period previews as already invoiced once the run has issued it",
      await page.evaluate(async () => {
        const res = await fetch("/billing/previews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetDate: "2027-01-15" }),
        });
        const preview = await res.json();
        return (
          (preview.lines?.length ?? 0) === 0 &&
          (preview.skipped?.some((s) => s.reason === "ALREADY_INVOICED") ?? false)
        );
      })
    );

    // The wizard has to survive the same race in the browser: preview a period,
    // let something issue it behind the owner's back, then press Issue. It must
    // refuse, say so in plain language, and show fresh numbers — never bill from
    // the stale preview.
    await page.click('button:has-text("Start another run")');
    await page.waitForSelector("#run-target-date", { timeout: 15000 });
    const uiTarget = new Date();
    uiTarget.setUTCMonth(uiTarget.getUTCMonth() + 4);
    const uiTargetDate = uiTarget.toISOString().slice(0, 10);
    await page.fill("#run-target-date", uiTargetDate);
    await page.click("#run-preview");
    await page.waitForSelector('ul[aria-label="Billing preview lines"] li', { timeout: 25000 });
    const uiLines = await page.locator('ul[aria-label="Billing preview lines"] li').count();
    const runsBefore = await page.evaluate(async () => {
      const res = await fetch("/billing/runs");
      const body = await res.json();
      return body.data?.length ?? 0;
    });
    const behind = await page.evaluate(async (targetDate) => {
      const previewRes = await fetch("/billing/previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDate }),
      });
      const preview = await previewRes.json();
      const runRes = await fetch("/billing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "e2e-step5-behind" },
        body: JSON.stringify({ targetDate, previewHash: preview.previewHash }),
      });
      return runRes.status;
    }, uiTargetDate);
    await page.click("#run-continue");
    await page.waitForSelector("#run-issue", { timeout: 15000 });
    await page.click("#run-issue");
    await page.waitForFunction(() => document.body.innerText.includes("Data changed"), null, {
      timeout: 25000,
    });
    const staleBody = await page.textContent("body");
    const runsAfter = await page.evaluate(async () => {
      const res = await fetch("/billing/runs");
      const body = await res.json();
      return body.data?.length ?? 0;
    });
    check(
      "the wizard refuses a stale preview, says nothing was created and re-previews",
      behind === 201 &&
        uiLines > 0 &&
        staleBody.includes("Data changed") &&
        staleBody.includes("Nothing was created") &&
        runsAfter === runsBefore + 1 &&
        (await page.locator('ul[aria-label="Billing preview lines"] li').count()) === 0,
      `${uiLines} lines previewed · behind-the-back issue ${behind} · runs ${runsBefore}→${runsAfter}`
    );
    await page.screenshot({ path: `${OUT}billing-run-stale-1280.png` });
    await page.close();
  }

  // ------------------------------------------------- money on a 360 px phone
  // CR-003 made mobile a shipping rule and DESIGN_SYSTEM requires tables to
  // become cards under 640 px, so this slice's own screens are checked here
  // rather than deferred to Step 8. Sizes are measured, never assumed.
  {
    const page = await newPage({ width: 360, height: 640 });
    await login(page, "owner");
    await page.goto(`${BASE}/billing?tab=invoices`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('ul[aria-label="Invoices"] li', { timeout: 25000 });
    const hub = await page.evaluate(() => ({
      cards: document.querySelector('ul[aria-label="Invoices"]')?.getBoundingClientRect().width ?? 0,
      visibleTables: [...document.querySelectorAll("table")].filter(
        (t) => t.getBoundingClientRect().width > 0
      ).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check(
      "at 360 px the invoice list is cards, not a table, and nothing scrolls sideways",
      hub.cards > 0 && hub.visibleTables === 0 && hub.overflow <= 1,
      `cards ${Math.round(hub.cards)}px · visible tables ${hub.visibleTables} · overflow ${hub.overflow}px`
    );
    await page.screenshot({ path: `${OUT}billing-invoices-360.png` });

    await page.goto(`${BASE}/payments`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('ul[aria-label="Payments"] li', { timeout: 25000 });
    const list = await page.evaluate(() => ({
      cards: document.querySelector('ul[aria-label="Payments"]')?.getBoundingClientRect().width ?? 0,
      visibleTables: [...document.querySelectorAll("table")].filter(
        (t) => t.getBoundingClientRect().width > 0
      ).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check(
      "at 360 px the payments list is cards and nothing scrolls sideways",
      list.cards > 0 && list.visibleTables === 0 && list.overflow <= 1,
      `cards ${Math.round(list.cards)}px · visible tables ${list.visibleTables} · overflow ${list.overflow}px`
    );
    await page.screenshot({ path: `${OUT}payments-360.png` });

    await page.goto(`${BASE}/payments/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#pay-amount", { timeout: 25000 });
    const sizes = await page.evaluate(() => {
      const height = (el) => (el ? el.getBoundingClientRect().height : 0);
      const form = document.querySelector("#pay-amount")?.closest("form");
      return {
        amount: height(document.querySelector("#pay-amount")),
        submit: height(form?.querySelector('button[type="submit"]')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(
      "recording a payment on a phone is one-handed — ≥ 44 px targets, no sideways scroll",
      sizes.amount >= 44 && sizes.submit >= 44 && sizes.overflow <= 1,
      `amount ${Math.round(sizes.amount)}px · submit ${Math.round(sizes.submit)}px · overflow ${sizes.overflow}px`
    );
    await page.screenshot({ path: `${OUT}payments-new-360.png` });
    await page.close();
  }

  // ------------------------------------------------------- coach is refused
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "coach");
    await page.goto(`${BASE}/billing`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.body.innerText.includes("No access") || document.body.innerText.includes("403"),
      null,
      { timeout: 25000 }
    );
    const billingBody = await page.textContent("body");
    check(
      "a coach gets no access to billing and no invoice data",
      billingBody.includes("No access") && !/INV-\d{4}/.test(billingBody)
    );
    await page.goto(`${BASE}/payments`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.body.innerText.includes("No access") || document.body.innerText.includes("403"),
      null,
      { timeout: 25000 }
    );
    const paymentsBody = await page.textContent("body");
    check(
      "a coach gets no access to payments and never sees a proof",
      paymentsBody.includes("No access") && !paymentsBody.includes("RCT-")
    );
    const forbidden = await page.evaluate(async () => {
      const res = await fetch("/payments");
      return { status: res.status, code: (await res.json().catch(() => null))?.error?.code };
    });
    check(
      "the API itself answers 403 for a coach, not just the router",
      forbidden.status === 403 && forbidden.code === "FORBIDDEN",
      `status ${forbidden.status}`
    );
    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
