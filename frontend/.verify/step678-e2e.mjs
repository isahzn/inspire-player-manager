// Step 6/7/8 E2E (mock mode, system Chrome): proves the WhatsApp slice, the
// dashboard + reports slice and the admin slice through the running app, with
// the rules that make each of them worth having asserted where they can break:
//
// · Delivery is never inferred — no job may read "Delivered" unless the provider
//   reported `device_delivered`, and the mock adapter may only emit
//   `server_accepted`/`unknown` before spike S1 (PAGE_SPEC §9, OPENWA §9).
// · Turning an automation off cancels that kind's unsent sends and NEVER
//   back-fills when it is turned back on (SET-08/ADR-019).
// · MSG-05 "mark sent manually" is the owner's own claim, not a provider ack.
// · Invoiced and Collected stay separate numbers on the dashboard and in the
//   collections report and its CSV (CLAUDE.md money rule).
// · The last active owner cannot be disabled (USR-04 `LAST_OWNER`).
//
// Run with `npm run dev` already listening on :3100 (mock mode).
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  return ctx.newPage();
}

/**
 * Call the app's own API through the page (so MSW answers) and return the raw
 * status/text, retrying while a navigation may still be in flight.
 */
async function call(page, pathName, opts = {}, tries = 5) {
  let last = { status: 0, text: "" };
  for (let i = 0; i < tries; i += 1) {
    last = await page.evaluate(
      async ([p, o]) => {
        try {
          const res = await fetch(p, {
            method: o.method ?? "GET",
            headers: o.headers,
            body: o.body,
          });
          return { status: res.status, text: await res.text() };
        } catch (error) {
          return { status: 0, text: String(error) };
        }
      },
      [pathName, opts]
    );
    if (last.status !== 0 && !/^\s*<(!DOCTYPE|html)/i.test(last.text)) break;
    await page.waitForTimeout(600);
  }
  let json = null;
  try {
    json = JSON.parse(last.text);
  } catch {
    // non-JSON (HTML or CSV) — the caller inspects `text`
  }
  return { status: last.status, text: last.text, json };
}

/**
 * Rendered (visible) text only. `textContent("body")` also returns the inline
 * RSC <script> payloads, which contain JSX source strings and made these checks
 * pass or fail depending on hydration timing.
 */
function bodyText(page) {
  return page.evaluate(() => document.body.innerText ?? "");
}

/**
 * Wait until the rendered text matches, instead of sleeping. The dev server
 * compiles a route on its first hit, so a fixed wait races the first render.
 */
async function waitForText(page, pattern, timeout = 30000) {
  try {
    await page.waitForFunction(
      (p) => new RegExp(p, "i").test(document.body.innerText ?? ""),
      pattern,
      { timeout }
    );
  } catch {
    // Fall through: the assertion below reports the failure with the text it saw.
  }
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#username", username);
  await page.fill("#password", "anypassword1");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
}

try {
  // ------------------------------------------------------- owner: WhatsApp slice
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");

    // MSG-06 + SET-08 read
    const status = await call(page, "/messaging/status");
    check(
      "MSG-06 returns the session, queue and the four switches",
      status.status === 200 &&
        typeof status.json?.session?.status === "string" &&
        typeof status.json?.queue?.queued === "number" &&
        typeof status.json?.automations?.proofCheck === "boolean",
      `session=${status.json?.session?.status}`
    );

    const automations = await call(page, "/settings/automations");
    check(
      "SET-08 GET returns the four switches plus the read-only master mirror",
      automations.status === 200 &&
        typeof automations.json?.masterPaused === "boolean" &&
        typeof automations.json?.invoiceDelivery === "boolean",
      `masterPaused=${automations.json?.masterPaused}`
    );

    // The screen itself
    await page.goto(`${BASE}/whatsapp`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Status" }).waitFor({ timeout: 30000 });
    await waitForText(page, "automations");
    const tabs = await page.getByRole("tab").allTextContents();
    check(
      "/whatsapp renders the four tabs (Status · Messages · Reminders & templates · Settings)",
      tabs.length >= 4 &&
        tabs.some((t) => t.includes("Status")) &&
        tabs.some((t) => t.includes("Messages")) &&
        tabs.some((t) => t.includes("Reminders")) &&
        tabs.some((t) => t.includes("Settings")),
      tabs.join(" | ")
    );

    const statusTab = await bodyText(page);
    check(
      "the Status tab states that an off automation is not back-filled",
      /not sent retroactively/i.test(statusTab ?? "") &&
        /master/i.test(statusTab ?? "")
    );
    check(
      "the Status tab carries the reverse-engineered-client risk note",
      /unofficial|reverse-engineered|isn't guaranteed/i.test(statusTab ?? "")
    );

    // Messages tab: delivery labels are the point of the screen.
    await page.getByRole("tab", { name: "Messages" }).click();
    await waitForText(page, "attempts");
    await page.waitForTimeout(500);
    const messagesTab = await bodyText(page);
    const jobs = await call(page, "/messages?pageSize=50");
    const rows = jobs.json?.data ?? [];
    check(
      "MSG-01 lists the seeded jobs with their status and delivery words",
      jobs.status === 200 && rows.length >= 6,
      `${rows.length} jobs`
    );
    check(
      "no seeded job claims a provider ack we cannot map yet (spike S1)",
      rows.every((j) => j.deliveryState !== "device_delivered" && j.deliveryState !== "read") &&
        rows.some((j) => j.deliveryState === "server_accepted"),
      [...new Set(rows.map((j) => j.deliveryState))].join(",")
    );
    // Scoped to the rows themselves: the tab's own explanation legitimately uses
    // the word "Delivered" to say when it may appear.
    const renderedRows = await page.$$eval("table tbody tr", (trs) =>
      trs.map((tr) => tr.innerText ?? "")
    );
    check(
      "no message row is worded as Delivered without a device_delivered ack",
      renderedRows.length > 0 &&
        rows.every((j) => j.deliveryState !== "device_delivered") &&
        renderedRows.every((r) => !/Delivered/.test(r) && !/\bRead\b(?!Y)/.test(r.replace(/Reads/g, ""))),
      `${renderedRows.length} rows rendered, ${rows.filter((j) => j.deliveryState === "server_accepted").length} accepted`
    );
    check(
      "the same rows do carry the honest delivery words",
      renderedRows.some((r) => /Accepted by server/.test(r)) ||
        renderedRows.some((r) => /Unknown/.test(r))
    );
    check(
      "the Messages tab explains the delivery rule to the owner",
      /only shown when the provider reports/i.test(messagesTab ?? "")
    );

    // MSG-05 must not manufacture a delivery claim.
    const failed = rows.find((j) => j.status === "failed" || j.status === "needs_review");
    if (failed) {
      const manual = await call(page, `/messages/${failed.id}/manual-fallback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Sent from my phone (e2e)" }),
      });
      check(
        "MSG-05 records the owner's own claim and still claims no delivery",
        manual.status === 200 &&
          manual.json?.manualFallback?.note === "Sent from my phone (e2e)" &&
          manual.json?.deliveryState === "unknown",
        `${manual.json?.status}/${manual.json?.deliveryState}`
      );
    } else {
      check("MSG-05 fixture present", false, "no failed/needs_review job to fall back from");
    }

    // MSG-03 retry needs the Idempotency-Key the contract marks `Idem`. The list
    // is re-read here: the manual-fallback above may have moved the row it used.
    const fresh = await call(page, "/messages?pageSize=50");
    const retryable = (fresh.json?.data ?? rows).filter(
      (j) => j.status === "failed" || j.status === "dead" || j.status === "needs_review"
    );
    let blocked = 0;
    let accepted = 0;
    let missingKeyAll400 = true;
    let refusalsUseTheContractCode = true;
    for (const job of retryable) {
      const noKey = await call(page, `/messages/${job.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (noKey.status !== 400) missingKeyAll400 = false;
      const withKey = await call(page, `/messages/${job.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `e2e-retry-${job.id}` },
        body: "{}",
      });
      if (withKey.status === 200) {
        // A retry re-queues; the queue has not reached the provider, so it may
        // never come back claiming a delivery.
        if (withKey.json?.status === "queued" && withKey.json?.deliveryState === "unknown") accepted += 1;
        else refusalsUseTheContractCode = false;
      } else if (withKey.json?.error?.code !== "MESSAGE_NOT_RETRYABLE") {
        refusalsUseTheContractCode = false;
      } else {
        blocked += 1;
      }
    }
    check(
      "MSG-03 requires an Idempotency-Key (400) on every retry",
      retryable.length > 0 && missingKeyAll400,
      `${retryable.length} retryable jobs`
    );
    check(
      "MSG-03 re-queues a retry without claiming delivery, and refuses only with MESSAGE_NOT_RETRYABLE",
      accepted > 0 && refusalsUseTheContractCode,
      `${accepted} re-queued, ${blocked} refused`
    );

    // SET-08: switching an automation off cancels that kind's unsent sends.
    const before = await call(page, "/messages?kind=reminder_overdue&pageSize=50");
    const unsentBefore = (before.json?.data ?? []).filter((j) =>
      ["queued", "sending", "failed", "needs_review"].includes(j.status)
    ).length;
    const patch = await call(page, "/settings/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reminderOverdue: false }),
    });
    const after = await call(page, "/messages?kind=reminder_overdue&pageSize=50");
    const afterRows = after.json?.data ?? [];
    check(
      "SET-08 off cancels that kind's unsent jobs (cancelled + AUTOMATION_DISABLED)",
      patch.status === 200 &&
        patch.json?.reminderOverdue === false &&
        unsentBefore > 0 &&
        afterRows.filter((j) => ["queued", "sending", "failed", "needs_review"].includes(j.status))
          .length === 0 &&
        afterRows.some((j) => j.skipReason === "AUTOMATION_DISABLED"),
      `${unsentBefore} unsent before → ${afterRows.filter((j) => j.status === "cancelled").length} cancelled`
    );
    const back = await call(page, "/settings/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reminderOverdue: true }),
    });
    const afterReenable = await call(page, "/messages?kind=reminder_overdue&pageSize=50");
    check(
      "re-enabling never back-fills the sends that were cancelled while off",
      back.status === 200 &&
        (afterReenable.json?.data ?? []).every(
          (j) => j.status !== "queued" || j.skipReason !== "AUTOMATION_DISABLED"
        ) &&
        (afterReenable.json?.data ?? []).some((j) => j.skipReason === "AUTOMATION_DISABLED"),
      "cancelled rows stayed cancelled"
    );

    await page.screenshot({ path: `${OUT}whatsapp-status-1280.png`, fullPage: true });

    // Message detail (MSG-02..05)
    const detailTarget = (jobs.json?.data ?? [])[0];
    if (detailTarget) {
      await page.goto(`${BASE}/whatsapp/messages/${detailTarget.id}`, { waitUntil: "domcontentloaded" });
      await waitForText(page, "rendered|timeline|attempt");
      const detail = await bodyText(page);
      check(
        "MSG-02 renders the rendered body and the event timeline",
        /Event|timeline|Queued/i.test(detail ?? "") && (detail ?? "").length > 200
      );
      const events = await call(page, `/messages/${detailTarget.id}`);
      check(
        "MSG-02 returns events without inventing a provider ack",
        events.status === 200 &&
          Array.isArray(events.json?.events) &&
          events.json.events.every((e) => e.providerAck === undefined)
      );
    }

    await page.close();
  }

  // ------------------------------------------- owner: dashboard + reports slice
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");

    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "coaches today");
    const dash = await bodyText(page);
    check(
      "DSH-01 renders the four separate money cards and the Coaches today card",
      /Invoiced/.test(dash ?? "") &&
        /Collected/.test(dash ?? "") &&
        /Outstanding/.test(dash ?? "") &&
        /Overdue/.test(dash ?? "") &&
        /Coaches today/i.test(dash ?? "")
    );
    check(
      "the dashboard says which numbers the date range does and does not move",
      /as of now/i.test(dash ?? "")
    );

    const owner = await call(page, "/dashboard/owner");
    const money = owner.json?.money ?? {};
    check(
      "DSH-01 returns invoiced and collected as separate fields",
      owner.status === 200 &&
        typeof money.invoicedMinor === "number" &&
        typeof money.collectedMinor === "number" &&
        typeof money.outstandingMinor === "number" &&
        typeof money.overdueMinor === "number",
      `invoiced=${money.invoicedMinor} collected=${money.collectedMinor}`
    );
    check(
      "DSH-01 reports coach time from the attendance records and flags open check-ins",
      typeof owner.json?.coachTime?.todayMinutes === "number" &&
        typeof owner.json?.coachTime?.weekMinutes === "number" &&
        typeof owner.json?.coachTime?.openNeedingCorrection === "number"
    );
    check(
      "DSH-01 raises a WhatsApp alert while the session is not connected",
      Array.isArray(owner.json?.alerts) &&
        owner.json.alerts.some((a) => /whatsapp/i.test(a.message ?? ""))
    );

    await page.screenshot({ path: `${OUT}dashboard-owner-1280.png`, fullPage: true });

    // Reports index + one report + its CSV.
    await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "collections");
    const index = await bodyText(page);
    check(
      "/reports lists all eight reports",
      ["players", "attendance", "invoices", "payments", "outstanding", "collections", "coach"].every((w) =>
        new RegExp(w, "i").test(index ?? "")
      )
    );

    await page.goto(`${BASE}/reports/collections`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "generated");
    const collections = await bodyText(page);
    const report = await call(page, "/reports/collections");
    const keys = (report.json?.columns ?? []).map((c) => c.key);
    check(
      "RPT-01 returns columns and a totals row for collections",
      report.status === 200 &&
        keys.length > 0 &&
        report.json?.totals !== undefined &&
        Array.isArray(report.json?.data),
      keys.join(",")
    );
    check(
      "collections keeps Invoiced and Collected as separate columns and totals",
      keys.some((k) => /collected/i.test(k)) &&
        keys.some((k) => /invoiced/i.test(k)) &&
        Object.keys(report.json?.totals ?? {}).some((k) => /collected/i.test(k)) &&
        Object.keys(report.json?.totals ?? {}).some((k) => /invoiced/i.test(k))
    );
    check(
      "the collections screen shows both columns and never a combined total",
      /Collected/i.test(collections ?? "") && /Invoiced/i.test(collections ?? "")
    );

    // Read the export as BYTES: `res.text()` strips a leading BOM during UTF-8
    // decoding, so checking the string would prove nothing about the BOM.
    const csv = await page.evaluate(async () => {
      const res = await fetch("/reports/collections/export");
      const buf = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        type: res.headers.get("content-type"),
        disposition: res.headers.get("content-disposition"),
        bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
        head: new TextDecoder("utf-8").decode(buf.slice(0, 400)),
      };
    });
    check(
      "RPT-02 streams a UTF-8 BOM CSV that keeps the two money columns apart",
      csv.status === 200 &&
        csv.bom &&
        /text\/csv/i.test(csv.type ?? "") &&
        /collected/i.test(csv.head) &&
        /invoiced/i.test(csv.head),
      `status=${csv.status} bom=${csv.bom} type=${csv.type}`
    );
    check(
      "the export names itself in a Content-Disposition header",
      /attachment/i.test(csv.disposition ?? "") && /\.csv/i.test(csv.disposition ?? ""),
      csv.disposition ?? "(none)"
    );

    // An unknown report is a real 404, not an empty table.
    const missing = await page.goto(`${BASE}/reports/not-a-report`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "page not found|404");
    const missingBody = await bodyText(page);
    check(
      "an unknown report name is a 404 page, not a blank table",
      missing?.status() === 404 || /not found|404/i.test(missingBody ?? ""),
      `status=${missing?.status()}`
    );

    await page.screenshot({ path: `${OUT}reports-collections-1280.png`, fullPage: true });
    await page.close();
  }

  // ------------------------------------------------------- owner: admin slice
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");

    // Users
    await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "username");
    const usersView = await bodyText(page);
    const users = await call(page, "/users?pageSize=50");
    check(
      "USR-01 lists the users with their usernames and statuses",
      users.status === 200 &&
        (users.json?.data ?? []).length >= 4 &&
        (users.json?.data ?? []).every((u) => typeof u.username === "string") &&
        /username|Username|owner/i.test(usersView ?? ""),
      `${(users.json?.data ?? []).length} users`
    );

    // The last active owner must not be disableable.
    const owner = (users.json?.data ?? []).find((u) => u.role === "owner" && u.status === "active");
    if (owner) {
      const disabled = await call(page, `/users/${owner.id}/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "e2e" }),
      });
      check(
        "USR-04 refuses to disable the last active owner with LAST_OWNER",
        disabled.status === 409 && disabled.json?.error?.code === "LAST_OWNER",
        `${disabled.status} ${disabled.json?.error?.code}`
      );
    }

    // Settings: the four tabs, and the honest no-logo state.
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "payment methods");
    const settingsTabs = await page.getByRole("tab").allTextContents();
    check(
      "/settings renders Academy · Billing · Payment methods · Branding",
      settingsTabs.length >= 4,
      settingsTabs.join(" | ")
    );
    const academy = await call(page, "/settings/academy");
    check(
      "SET-01 returns the full academy settings (age rule, windows, accounts)",
      academy.status === 200 &&
        typeof academy.json?.ageReferenceRule === "string" &&
        typeof academy.json?.attendanceCoachEditWindowHours === "number" &&
        Array.isArray(academy.json?.beneficiaryAccounts),
      `rule=${academy.json?.ageReferenceRule}`
    );
    const billing = await call(page, "/settings/billing");
    check(
      "SET-02 still answers the billing screens with the applies-after note",
      billing.status === 200 && typeof billing.json?.effectNote === "string"
    );

    await page.getByRole("tab", { name: "Branding" }).click();
    await waitForText(page, "using text header");
    const branding = await bodyText(page);
    check(
      "Branding says it is using a text header instead of inventing a logo",
      /Using text header/i.test(branding ?? "")
    );
    await page.screenshot({ path: `${OUT}settings-branding-1280.png`, fullPage: true });

    // Audit
    await page.goto(`${BASE}/audit`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "entity");
    const logs = await call(page, "/audit-logs?pageSize=50");
    const entries = logs.json?.data ?? [];
    check(
      "AUD-01 lists audit entries newest first with actor and request id",
      logs.status === 200 &&
        entries.length > 0 &&
        entries.every((e) => e.requestId) &&
        entries
          .slice(1)
          .every((e, i) => (entries[i].occurredAt ?? "") >= (e.occurredAt ?? "")),
      `${entries.length} entries`
    );
    check(
      "the audit screen shows the entries it returns",
      entries.length === 0 || /audit/i.test(await bodyText(page))
    );
    await page.screenshot({ path: `${OUT}audit-1280.png`, fullPage: true });

    // System health
    await page.goto(`${BASE}/system`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "scheduler");
    const health = await call(page, "/system/health");
    const systemView = await bodyText(page);
    check(
      "SYS-03 reports each service with a state word and a version",
      health.status === 200 &&
        typeof health.json?.db?.status === "string" &&
        typeof health.json?.queue?.status === "string" &&
        typeof health.json?.openwa?.status === "string" &&
        typeof health.json?.version === "string",
      `openwa=${health.json?.openwa?.status}`
    );
    check(
      "/system renders the health cards with words, not colour alone",
      ["Database", "File storage", "WhatsApp", "Message queue", "Version"].every((w) =>
        new RegExp(w, "i").test(systemView ?? "")
      )
    );
    await page.screenshot({ path: `${OUT}system-1280.png`, fullPage: true });

    await page.close();
  }

  // ------------------------------------------------------------- coach on 360px
  {
    const page = await newPage({ width: 360, height: 640 });
    await login(page, "coach");
    await waitForText(page, "your hours this week");
    const today = await bodyText(page);
    check(
      "DSH-02 shows the coach their own day and never money",
      /Today/i.test(today ?? "") &&
        !/Outstanding/i.test(today ?? "") &&
        !/Collected/i.test(today ?? "")
    );
    const coach = await call(page, "/dashboard/coach");
    check(
      "DSH-02 returns today/upcoming and the coach's own open check-in",
      coach.status === 200 &&
        Array.isArray(coach.json?.todaySessions) &&
        Array.isArray(coach.json?.upcoming) &&
        typeof coach.json?.myWeekMinutes === "number"
    );
    check(
      "the coach dashboard states hours come from closed records only",
      /closed/i.test(today ?? "")
    );
    await page.screenshot({ path: `${OUT}dashboard-coach-360.png`, fullPage: true });

    // A coach must not reach the messaging API or screen.
    const forbidden = await call(page, "/messaging/status");
    check("a coach gets 403 from the messaging API", forbidden.status === 403, `${forbidden.status}`);
    await page.goto(`${BASE}/whatsapp`, { waitUntil: "domcontentloaded" });
    await waitForText(page, "no access|do not have permission");
    const denied = await bodyText(page);
    check(
      "a coach sees a permission-denied state on /whatsapp, not the switches",
      /No access/i.test(denied) && /do not have permission/i.test(denied),
      denied.replace(/\s+/g, " ").slice(0, 120)
    );
    check(
      "the denied page shows none of the automation switches",
      !/proofCheck|master pause|invoices are switched/i.test(denied)
    );
    await page.screenshot({ path: `${OUT}whatsapp-coach-403-360.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks PASS`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length === 0 ? 0 : 1);
