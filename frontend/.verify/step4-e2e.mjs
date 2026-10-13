// Step 4 E2E (mock mode, system Chrome): proves the training slice through the
// UI a coach actually holds at the pitch — the sessions list, the mobile
// attendance sheet (counts, one-tap mark-all, required reason on a saved row,
// save + local draft + retry), the one-tap check-in bar, the coach-attendance
// log with owner corrections, and the coach's scope (out-of-scope session ⇒ 404,
// past session ⇒ read-only).
//
// Run with `npm run dev` already listening on :3100 (mock mode). Every browser
// context is fresh, so the mock store starts from its seed each run.
//
// Assertions are scoped to the SESSION ROWS or the dialog, never to the whole
// body: the filter controls themselves contain the words "Under-14" and
// "Cancelled", so a body-wide `includes` would pass or fail for the wrong reason.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

// Fixture ids come from src/mocks/db.ts (seeded, deterministic).
const S_TODAY_11 = "0192a000-0000-7000-8000-0000000000s7"; // today, Under-11, check-in window open now
const S_FUTURE_14 = "0192a000-0000-7000-8000-0000000000s8"; // today +3 h, Under-14, not the coach's group
const S_PAST_11 = "0192a000-0000-7000-8000-0000000000s1"; // 14 days ago, Under-11, window closed
const PLAYER_B1 = "0192a000-0000-7000-8000-0000000000b1"; // Demo Player One (unmarked today)
const PLAYER_B5 = "0192a000-0000-7000-8000-0000000000b5"; // Tharindu Silva (saved absent today)
const GROUP_11 = "0192a000-0000-7000-8000-0000000000a1";

// The Next.js dev overlay is also role=dialog, so selectors are scoped to our
// own dialogs by their titles (same rule as step 3).
const DIALOG = (title) => `div[role="dialog"][aria-label="${title}"]`;

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

/** Text of the rendered session rows only (not the filter controls). */
const SESSION_ROWS = () =>
  Array.from(document.querySelectorAll("li"))
    .filter((li) => li.textContent?.includes("Open sheet"))
    .map((li) => li.textContent ?? "");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  return ctx.newPage();
}

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", username);
  await page.fill("#password", "anypassword1");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function openSheet(page, sessionId) {
  await page.goto(`${BASE}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('ul[aria-label="Attendance roster"]', { timeout: 25000 });
}

try {
  // ------------------------------------------------------------ owner: list
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");
    await page.click('a[href="/sessions"]');
    await page.waitForSelector("#session-from", { timeout: 25000 });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("li")).some((li) =>
          li.textContent?.includes("Open sheet")
        ),
      null,
      { timeout: 25000 }
    );

    const all = await page.evaluate(SESSION_ROWS);
    check(
      "owner /sessions lists today's and upcoming sessions for both groups",
      all.length >= 10 &&
        all.some((r) => r.includes("Under-11")) &&
        all.some((r) => r.includes("Under-14")) &&
        all.some((r) => r.includes("Scheduled")),
      `${all.length} rows`
    );
    check(
      "each row shows the academy-time range and the attendance progress",
      all.every((r) => /\d{2}:\d{2}–\d{2}:\d{2}/.test(r)) && all.some((r) => /of \d+ marked/.test(r))
    );
    await page.screenshot({ path: `${OUT}sessions-1280.png` });

    // Group filter: drives the select, then waits for the rows to actually change.
    await page.selectOption("#session-group", GROUP_11);
    await page.waitForFunction(() => location.search.includes("ageGroupId="), { timeout: 15000 });
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll("li")).filter((li) =>
          li.textContent?.includes("Open sheet")
        );
        return rows.length > 0 && rows.every((li) => li.textContent?.includes("Under-11"));
      },
      null,
      { timeout: 20000 }
    );
    const filtered = await page.evaluate(SESSION_ROWS);
    check(
      "the group filter narrows the rows and lives in the URL",
      page.url().includes("ageGroupId=") &&
        filtered.length > 0 &&
        !filtered.some((r) => r.includes("Under-14")),
      `${filtered.length} rows · ${page.url()}`
    );

    // Status filter finds the seeded cancelled session and offers no cancel action on it.
    // (The unfiltered list already contains "Ground unavailable", so the wait has to
    // be on the ROWS BECOMING all-cancelled, not on that text existing.)
    await page.selectOption("#session-status", "cancelled");
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll("li")).filter((li) =>
          li.textContent?.includes("Open sheet")
        );
        return rows.length > 0 && rows.every((li) => li.textContent?.includes("Cancelled"));
      },
      null,
      { timeout: 20000 }
    );
    const cancelledRows = await page.evaluate(SESSION_ROWS);
    const cancelButtons = await page
      .locator("li")
      .filter({ hasText: "Open sheet" })
      .locator('button:has-text("Cancel")')
      .count();
    check(
      "the cancelled filter finds the cancelled session with its reason",
      cancelledRows.length === 1 && cancelledRows[0].includes("Ground unavailable")
    );
    check("a cancelled session offers no cancel action", cancelButtons === 0);

    // Two filter changes with no pause between them: the write path must merge
    // into the query it asked for, not rebuild from the one the browser still
    // reports (the race fixed in Step 3 for /players; this is its copy).
    await page.selectOption("#session-status", "");
    await page.waitForFunction(() => !location.search.includes("status="), null, { timeout: 15000 });
    await page.selectOption("#session-group", GROUP_11);
    await page.selectOption("#session-status", "cancelled");
    await page.waitForFunction(
      () => location.search.includes("ageGroupId=") && location.search.includes("status=cancelled"),
      null,
      { timeout: 20000 }
    );
    await page.waitForFunction(
      () => {
        const rows = Array.from(document.querySelectorAll("li")).filter((li) =>
          li.textContent?.includes("Open sheet")
        );
        return rows.length === 1 && rows[0].textContent?.includes("Cancelled");
      },
      null,
      { timeout: 20000 }
    );
    check(
      "two quick filter changes both survive (no stale-URL write)",
      page.url().includes("ageGroupId=") && page.url().includes("status=cancelled")
    );

    // An empty window explains itself instead of showing a blank page (driven
    // through the date filter, not a direct URL, so no soft navigation races).
    await page.selectOption("#session-status", "");
    await page.fill("#session-from", "2020-01-01");
    await page.fill("#session-to", "2020-01-02");
    await page.waitForFunction(
      () => document.body.innerText.includes("No sessions in this window"),
      null,
      { timeout: 20000 }
    );
    check(
      "an empty window shows the empty state and keeps the dates in the URL",
      page.url().includes("from=2020-01-01")
    );

    // -------------------------------------------------------- owner: sheet
    await openSheet(page, S_TODAY_11);
    let body = await page.textContent("body");
    check(
      "the sheet shows the roster with one saved row and its counts",
      body.includes("Demo Player One") &&
        body.includes("Tharindu Silva") &&
        body.includes("Unmarked 2") &&
        body.includes("by Demo Owner")
    );
    check(
      "the sheet exposes no money and no guardian data",
      !body.includes("Rs.") && !body.includes("+9477")
    );
    await page.screenshot({ path: `${OUT}attendance-sheet-1280.png` });

    // Mark all present fills only the UNSAVED rows.
    await page.click('button:has-text("Mark all present")');
    await page.waitForFunction(() => document.body.innerText.includes("Present 2"), null, {
      timeout: 15000,
    });
    body = await page.textContent("body");
    check(
      "mark all present fills unmarked rows only (a saved row keeps its record)",
      body.includes("Present 2") && body.includes("Absent 1") && body.includes("Unmarked 0")
    );

    // Changing a SAVED row demands a reason.
    const savedRow = page.locator("li", { hasText: "Tharindu Silva" }).first();
    await savedRow.locator('[data-attendance-choice="present"]').click();
    await page.waitForSelector(`#reason-${PLAYER_B5}`, { timeout: 15000 });
    check("changing a saved record reveals the required reason field", true);

    await page.click('button:has-text("Save attendance")');
    await page.waitForSelector("text=Reason needed", { timeout: 15000 });
    check("saving without a reason is refused before anything is written", true);

    // The unsent marks are kept locally, with the Idempotency-Key a retry reuses.
    const draft = await page.evaluate(
      (id) => localStorage.getItem(`ia-attendance-draft:${id}`),
      S_TODAY_11
    );
    check(
      "the unsent draft is persisted locally with its Idempotency-Key",
      Boolean(draft) && JSON.parse(draft).key.length > 8
    );

    await page.fill(`#reason-${PLAYER_B5}`, "Owner corrected the sheet after the session.");
    await page.click('button:has-text("Save attendance")');
    await page.waitForSelector("text=3 attendance records saved.", { timeout: 25000 });
    await page.waitForFunction(() => document.body.innerText.includes("Present 3"), null, {
      timeout: 20000,
    });
    body = await page.textContent("body");
    check(
      "saving with a reason writes all three records and refreshes the sheet from the server",
      body.includes("Present 3") && body.includes("Unmarked 0") && body.includes("No changes yet.")
    );
    const clearedDraft = await page.evaluate(
      (id) => localStorage.getItem(`ia-attendance-draft:${id}`),
      S_TODAY_11
    );
    check("the draft is cleared once the save lands", clearedDraft === null);

    // The save is server state, not just React state: reload and re-read.
    await openSheet(page, S_TODAY_11);
    body = await page.textContent("body");
    check(
      "the saved sheet survives a reload",
      body.includes("Present 3") && body.includes("Unmarked 0")
    );

    // Server-side rules, proved against the API the app itself calls.
    const rules = await page.evaluate(
      async (ids) => {
        const current = await fetch(`/sessions/${ids.sessionId}/attendance`).then((r) => r.json());
        const version = current.roster.find((row) => row.player.id === ids.playerId)?.record?.version;
        const put = (payload, key) =>
          fetch(`/sessions/${ids.sessionId}/attendance`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              ...(key ? { "Idempotency-Key": key } : {}),
            },
            body: JSON.stringify(payload),
          }).then(async (r) => ({
            status: r.status,
            replay: r.headers.get("Idempotent-Replay"),
            json: await r.json().catch(() => null),
          }));
        const noReason = await put(
          { records: [{ playerId: ids.playerId, status: "absent", version }] },
          "e2e-no-reason-key"
        );
        const first = await put(
          { records: [{ playerId: ids.playerId, status: "late", version, reason: "E2E replay check." }] },
          "e2e-replay-key"
        );
        const second = await put(
          { records: [{ playerId: ids.playerId, status: "late", version, reason: "E2E replay check." }] },
          "e2e-replay-key"
        );
        const noKey = await put(
          { records: [{ playerId: ids.playerId, status: "late", version, reason: "E2E key check." }] },
          null
        );
        return { version, noReason, first, second, noKey };
      },
      { sessionId: S_TODAY_11, playerId: PLAYER_B1 }
    );
    check(
      "changing a saved record without a reason is 422 REASON_REQUIRED server-side",
      rules.noReason.status === 422 && rules.noReason.json?.error?.code === "REASON_REQUIRED",
      `status ${rules.noReason.status}`
    );
    check(
      "a repeated Idempotency-Key replays the first result instead of duplicating",
      rules.first.status === 200 &&
        rules.second.status === 200 &&
        rules.second.replay === "true",
      `first ${rules.first.status}, second replay ${rules.second.replay}`
    );
    check(
      "a missing Idempotency-Key is rejected with 400 IDEMPOTENCY_KEY_REQUIRED",
      rules.noKey.status === 400 && rules.noKey.json?.error?.code === "IDEMPOTENCY_KEY_REQUIRED",
      `status ${rules.noKey.status}`
    );

    // ------------------------------------------------------- owner: cancels
    await page.goto(`${BASE}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("li")).some((li) =>
          li.textContent?.includes("Open sheet")
        ),
      null,
      { timeout: 25000 }
    );
    await page
      .locator("li")
      .filter({ hasText: "Open sheet" })
      .first()
      .locator('button:has-text("Cancel")')
      .first()
      .click();
    await page.waitForSelector(DIALOG("Cancel session"), { timeout: 15000 });
    check("the owner can open the cancel dialog from the list", true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ----------------------------------------------- owner: coach time log
    await page.goto(`${BASE}/coach-attendance`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ca-from", { timeout: 25000 });
    await page.waitForFunction(
      () => document.querySelector("table tbody")?.textContent?.includes("Demo Coach") ?? false,
      null,
      { timeout: 25000 }
    );
    const table = await page.textContent("table tbody");
    const totalsCard = await page.textContent("body");
    check(
      "the coach-time log lists both coaches with a duration",
      table.includes("Demo Coach") &&
        table.includes("Nimal Perera") &&
        /\d+\s*h(\s*\d+\s*m)?|\d+\s*min/.test(table)
    );
    check(
      "an open check-in is flagged and excluded from the hours total",
      table.includes("Needs correction") &&
        table.includes("Open ·") &&
        totalsCard.includes("Σ hours (closed records only)")
    );
    check(
      "the self-reporting disclaimer is shown verbatim",
      totalsCard.includes(
        "Check-ins are self-reported and server-timestamped; they don't prove physical presence."
      )
    );
    await page.screenshot({ path: `${OUT}coach-attendance-1280.png` });

    // Owner correction: a too-short reason is refused by the app's own validation,
    // then the record reads Corrected.
    // (An EMPTY field is stopped earlier by the browser's `required` attribute — the
    // app-wide convention since Step 2 — so the app-level rule is exercised with a
    // non-empty but invalid value.)
    await page
      .locator("table tbody tr")
      .filter({ hasText: "Demo Coach" })
      .first()
      .locator('button:has-text("Correct")')
      .click();
    await page.waitForSelector(DIALOG("Correct check-in"), { timeout: 15000 });
    const reasonField = page.locator(`${DIALOG("Correct check-in")} textarea`).first();
    await reasonField.fill("ten");
    await page.click(`${DIALOG("Correct check-in")} button:has-text("Save correction")`);
    await page.waitForTimeout(700);
    const dialogText = await page.textContent(DIALOG("Correct check-in"));
    check(
      "a too-short reason is refused with an inline message (no request sent)",
      dialogText.includes("A reason is required for a correction (at least 5 characters)")
    );

    await reasonField.fill("Clock-out was ten minutes out.");
    await page.click(`${DIALOG("Correct check-in")} button:has-text("Save correction")`);
    await page.waitForFunction(
      () => document.querySelector("table tbody")?.textContent?.includes("Corrected") ?? false,
      null,
      { timeout: 25000 }
    );
    check("the correction is saved and the row is marked Corrected", true);
    await page.close();
  }

  // ------------------------------------------------------------- coach: mobile
  {
    const page = await newPage({ width: 360, height: 640 });
    await login(page, "coach");
    // At 360 px the sidebar link is display:none, so use the mobile tab bar
    // (this also proves the coach's tab bar reaches the sessions list).
    await page.locator('nav[aria-label="Mobile"] a[href="/sessions"]').first().click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("li")).some((li) =>
          li.textContent?.includes("Open sheet")
        ),
      null,
      { timeout: 25000 }
    );
    const coachRows = await page.evaluate(SESSION_ROWS);
    check(
      "the coach sees only their assigned group's sessions",
      coachRows.length > 0 &&
        coachRows.every((r) => r.includes("Under-11")) &&
        !coachRows.some((r) => r.includes("Under-14") || r.includes("Under-17")),
      `${coachRows.length} rows`
    );
    check(
      "the coach has no cancel action",
      (await page.locator('button:has-text("Cancel")').count()) === 0
    );
    await page.screenshot({ path: `${OUT}sessions-coach-360.png` });

    // The one-tap clock: no dialog, ≥ 48 px, elapsed visible while clocked in.
    await openSheet(page, S_TODAY_11);
    let body = await page.textContent("body");
    check(
      "the check-in bar is offered inside the window",
      body.includes("Not clocked in for this session") && body.includes("Check in")
    );
    const checkInBox = await page.locator('button:has-text("Check in")').first().boundingBox();
    const checkInTarget = checkInBox ? Math.min(checkInBox.width, checkInBox.height) : 0;
    await page.click('button:has-text("Check in")');
    // The Next.js dev overlay is also role=dialog (app-wide in development), so
    // only dialogs outside <nextjs-portal> count as ours (same rule as DIALOG()).
    const ownDialogs = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('div[role="dialog"]')).filter(
          (d) => !d.closest("nextjs-portal")
        ).length
    );
    await page.waitForSelector("text=Checked in at", { timeout: 25000 });
    check("one tap clocks the coach in, with no confirmation dialog", ownDialogs === 0);
    body = await page.textContent("body");
    check(
      "the open check-in shows the server time, elapsed time and a one-tap check-out",
      /Checked in at \d{2}:\d{2}/.test(body) && body.includes("elapsed") && body.includes("Check out")
    );

    // One-handed at 360 px: ≥ 48 px targets, and Save not hidden under the tab bar.
    const saveBox = await page.locator('button:has-text("Save attendance")').first().boundingBox();
    const navBox = await page.locator('nav[aria-label="Mobile"]').first().boundingBox();
    check("the check-in target is at least 48 px", checkInTarget >= 48, `${checkInTarget}px`);
    check(
      "the sticky Save sits above the mobile tab bar and inside the viewport",
      Boolean(saveBox && navBox) &&
        saveBox.height >= 48 &&
        saveBox.y + saveBox.height <= navBox.y + 2 &&
        saveBox.y + saveBox.height <= 640,
      saveBox && navBox
        ? `save bottom ${Math.round(saveBox.y + saveBox.height)}, nav top ${Math.round(navBox.y)}`
        : "missing"
    );
    const presentBox = await page.locator('[data-attendance-choice="present"]').first().boundingBox();
    const rowBox = await page.locator('ul[aria-label="Attendance roster"] li').first().boundingBox();
    check(
      "P/L/A/E targets are at least 48 px and rows at least 56 px",
      Boolean(presentBox && rowBox) &&
        Math.min(presentBox.width, presentBox.height) >= 48 &&
        rowBox.height >= 56,
      presentBox && rowBox
        ? `${Math.round(presentBox.width)}×${Math.round(presentBox.height)}, row ${Math.round(rowBox.height)}px`
        : "missing"
    );
    await page.screenshot({ path: `${OUT}attendance-sheet-360.png` });

    // The whole point of the screen: fill the sheet in a few taps, then save.
    await page.click('button:has-text("Mark all present")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Save attendance")');
    await page.waitForSelector("text=attendance records saved.", { timeout: 25000 });
    check("the coach can save the sheet from the phone layout", true);

    // Clock out: the recorded span replaces the elapsed counter.
    await page.click('button:has-text("Check out")');
    await page.waitForSelector("text=Done", { timeout: 25000 });
    body = await page.textContent("body");
    check(
      "clocking out closes the span and stops the elapsed counter",
      body.includes("Done") && body.includes("recorded span")
    );

    // Scope: an out-of-scope session is a 404, not a permission error.
    await page.goto(`${BASE}/sessions/${S_FUTURE_14}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Not found", { timeout: 25000 });
    body = await page.textContent("body");
    check(
      "an out-of-scope session answers 404 without revealing it exists",
      body.includes("Not found") && !body.includes("Under-14")
    );
    await page.screenshot({ path: `${OUT}session-404-360.png` });

    // The edit window: a past session is read-only for a coach.
    await openSheet(page, S_PAST_11);
    body = await page.textContent("body");
    check(
      "a past session is read-only for the coach, with the window explained",
      body.includes("Read-only") &&
        body.includes("editing window") &&
        body.includes("Ask an owner")
    );
    check(
      "read-only disables the P/L/A/E controls",
      await page.locator('[data-attendance-choice="present"]').first().isDisabled()
    );
    check(
      "check-in is closed outside the window, with the reason shown",
      body.includes("Check-in is closed") && body.includes("An owner can add or correct coach time")
    );
    await page.screenshot({ path: `${OUT}attendance-readonly-360.png` });

    // The coach's own log is read-only, and it is their own.
    await page.goto(`${BASE}/coach-attendance`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("table tbody, ul li")?.textContent?.includes("Demo Coach") ?? false,
      null,
      { timeout: 25000 }
    );
    body = await page.textContent("body");
    check(
      "the coach sees their own time read-only",
      body.includes("Demo Coach") &&
        !body.includes("Nimal Perera") &&
        (await page.locator('button:has-text("Add entry")').count()) === 0 &&
        (await page.locator('button:has-text("Correct")').count()) === 0
    );
    check(
      "the coach's log keeps the disclaimer",
      body.includes(
        "Check-ins are self-reported and server-timestamped; they don't prove physical presence."
      )
    );
    await page.screenshot({ path: `${OUT}coach-attendance-360.png` });
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
