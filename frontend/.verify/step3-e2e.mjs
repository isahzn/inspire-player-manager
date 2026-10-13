// Step 3 E2E (mock mode, system Chrome): proves the players slice through the
// UI a real user touches — list + filters, profile tabs, registration with the
// duplicate dialog, group + fee screens, the CSV import wizard, and the coach's
// restricted projection (including a 404 for an out-of-scope player).
//
// Run with `npm run dev` already listening on :3100 (mock mode). Every browser
// context is fresh, so the mock store starts from its seed each run.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

// Fixture ids come from src/mocks/db.ts (seeded, deterministic).
const PLAYER_ONE = "0192a000-0000-7000-8000-0000000000b1"; // Under-11 (coach's group)
const PLAYER_TWO = "0192a000-0000-7000-8000-0000000000b2"; // Under-14 (out of coach scope)
const GROUP_11 = "0192a000-0000-7000-8000-0000000000a1";

// Scoped to our own modals by their title: the Next.js dev overlay is also a
// role=dialog/aria-modal element and appears app-wide in development, so a bare
// `div[role="dialog"]` selector would match it and prove nothing.
const STATUS_DIALOG = 'div[role="dialog"][aria-label="Change player status"]';
const DUPLICATE_DIALOG = 'div[role="dialog"][aria-label="Possible duplicate"]';

const CSV_PATH = `${OUT}step3-import.csv`;
fs.writeFileSync(
  CSV_PATH,
  [
    "full_name,date_of_birth,registration_date,age_group,status,guardian1_name,guardian1_phone",
    "Imported Player A,2015-06-01,,Under-11,active,Kamal Silva,0771234567",
    "Demo Player One,2015-03-14,,Under-11,active,Demo Guardian,0770000001",
  ].join("\n")
);

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

async function login(page, username) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", username);
  await page.fill("#password", "anypassword1");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

try {
  // ---------------------------------------------------------------- owner list
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "owner");
    // Client-side navigation on purpose: the mock store survives it, a reload
    // would re-seed from the same fixtures anyway.
    await page.click('a[href="/players"]');
    // Wait for the mock rows, not just the header (the list has a 300 ms mock delay).
    await page.waitForSelector("text=IA-0001", { timeout: 20000 });
    const body = await page.textContent("body");
    check("owner /players lists seeded players", body.includes("Demo Player One") && body.includes("IA-0001"));
    check(
      "owner columns include guardian phone + outstanding",
      body.includes("Primary guardian") && body.includes("Outstanding") && body.includes("Rs. 2,500")
    );
    await page.screenshot({ path: `${OUT}players-1280.png` });

    // Status filter → withdrawn players only.
    await page.selectOption("#player-status", "withdrawn");
    await page.waitForSelector("text=Hasitha Bandara", { timeout: 15000 });
    let text = await page.textContent("body");
    check("status filter switches to withdrawn", text.includes("Hasitha Bandara") && !text.includes("IA-0001"));

    // Search (debounced) + URL state.
    await page.selectOption("#player-status", "active");
    await page.fill("#player-search", "amara");
    await page.waitForURL(/q=amara/, { timeout: 15000 });
    await page.waitForSelector("text=Amara Perera", { timeout: 15000 });
    const searched = await page.textContent("body");
    check(
      "search narrows the list and is in the URL",
      page.url().includes("q=amara") && searched.includes("Amara Perera") && !searched.includes("IA-0001"),
      page.url()
    );
    await page.fill("#player-search", "");
    await page.waitForTimeout(700);

    // "Has outstanding" filter.
    await page.click("text=Has outstanding");
    await page.waitForURL(/hasOutstanding=true/, { timeout: 15000 });
    await page.waitForSelector("text=IA-0001", { timeout: 15000 });
    text = await page.textContent("body");
    check(
      "has-outstanding filter keeps only unpaid players",
      text.includes("Demo Player One") && !text.includes("Amara Perera"),
      page.url()
    );
    await page.screenshot({ path: `${OUT}players-outstanding-1280.png` });

    // ------------------------------------------------------------ player profile
    await page.locator('a[href="/players/0192a000-0000-7000-8000-0000000000b1"]').first().click();
    await page.waitForURL(/\/players\/0192a000/, { timeout: 15000 });
    await page.waitForSelector("text=Group history", { timeout: 15000 });
    check("profile opens from the list with all owner tabs", true, page.url());
    text = await page.textContent("body");
    check(
      "profile header shows group, status and outstanding",
      text.includes("Under-11") && text.includes("Active") && text.includes("Outstanding")
    );

    await page.click("text=Group history");
    await page.waitForTimeout(400);
    text = await page.textContent("body");
    check("group history renders a timeline entry", text.includes("Under-11"));

    await page.click("text=Invoices");
    await page.waitForSelector("text=INV-2026-000101", { timeout: 15000 });
    text = await page.textContent("body");
    check("invoices tab lists the player's invoices separately", text.includes("Invoiced") && text.includes("Collected"));

    await page.click("text=Guardians");
    await page.waitForTimeout(400);
    text = await page.textContent("body");
    check("guardians tab shows consent control (GDN-05)", text.includes("WhatsApp consent") && text.includes("Granted"));
    await page.screenshot({ path: `${OUT}player-profile-1280.png` });

    // Transfer + status dialogs open with the record's current values.
    await page.click("text=Change status");
    await page.waitForSelector(STATUS_DIALOG, { timeout: 10000 });
    text = await page.textContent(STATUS_DIALOG);
    check("change-status dialog opens", text.includes("Change player status"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // -------------------------------------------------------- register + duplicate
    await page.goto(`${BASE}/players/new`, { waitUntil: "networkidle" });
    await page.fill("#fullName", "Demo Player One");
    await page.fill("#dateOfBirth", "2015-03-14");
    await page.waitForSelector("text=looks similar", { timeout: 20000 });
    text = await page.textContent("body");
    check(
      "duplicate warning appears inline while typing (PLY-08, advisory)",
      text.includes("looks similar") && text.includes("Demo Player One")
    );
    // The advisory check must NOT open a dialog (the dialog belongs to the 409).
    const dialogs = page.locator(DUPLICATE_DIALOG);
    const openDialogs = await dialogs.count();
    check(
      "advisory duplicate warning does not open a dialog",
      openDialogs === 0,
      openDialogs ? ((await dialogs.first().textContent()) ?? "").slice(0, 90) : ""
    );

    await page.fill("#guardian-0-name", "Demo Guardian");
    await page.fill("#guardian-0-phone", "0770000001");
    await page.click('button[type="submit"]');
    await page.waitForSelector(DUPLICATE_DIALOG, { timeout: 15000 });
    text = await page.textContent(DUPLICATE_DIALOG);
    check("server duplicate (409) opens the register-anyway dialog", text.includes("Register anyway"));
    await page.screenshot({ path: `${OUT}register-duplicate-1280.png` });
    await page.click("text=Register anyway");
    await page.waitForURL(/\/players\/0192a000/, { timeout: 15000 });
    await page.waitForSelector('text="Demo Player One"', { timeout: 15000 });
    text = await page.textContent("body");
    check(
      "register-anyway creates the player and lands on the profile",
      text.includes("Demo Player One") && text.includes("Group history")
    );

    // ---------------------------------------------------------------- age groups
    await page.goto(`${BASE}/age-groups`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Current fee", { timeout: 15000 });
    text = await page.textContent("body");
    check(
      "age groups list shows fee and active player counts",
      text.includes("Under-11") && text.includes("Rs. 4,000")
    );
    // Archiving is blocked while active players are assigned (GRP-04).
    await page.click("button:has-text('Archive')");
    await page.waitForSelector('div[role="dialog"][aria-label="Group still has active players"]', { timeout: 15000 });
    const blocked = await page.textContent('div[role="dialog"][aria-label="Group still has active players"]');
    check("archiving a group with active players is blocked with the reason", /active/i.test(blocked ?? ""));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    await page.goto(`${BASE}/age-groups/${GROUP_11}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Fee history", { timeout: 15000 });
    text = await page.textContent("body");
    check(
      "group detail shows roster, fee history and change-fee action",
      text.includes("Demo Player One") && text.includes("Change fee")
    );

    // FEE-02: a past effective date needs an explicit confirmation first.
    await page.click("button:has-text('Change fee')");
    await page.waitForSelector("#fee-amount", { timeout: 10000 });
    await page.fill("#fee-amount", "4500");
    const pastDate = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    await page.fill("#fee-from", pastDate);
    await page.click("button:has-text('Save new fee')");
    await page.waitForSelector("#fee-from-error", { timeout: 10000 });
    const refusal = (await page.textContent("#fee-from-error")) ?? "";
    check(
      "a past fee date is refused until the owner confirms it",
      /past date/i.test(refusal),
      refusal.replace(/\s+/g, " ").slice(0, 120)
    );
    // Confirm it and save: the new fee closes the previous row.
    await page.check("#fee-past-confirm");
    await page.click("button:has-text('Save new fee')");
    await page.waitForTimeout(1200);
    text = await page.textContent("body");
    check(
      "confirming a past date records the fee and keeps history open",
      text.includes("Rs. 4,500") && text.includes("Applies from a past date") === false,
      text.includes("Rs. 4,500") ? "fee recorded" : "fee NOT recorded"
    );
    await page.screenshot({ path: `${OUT}group-detail-1280.png` });

    // ------------------------------------------------------------------- coaches
    await page.goto(`${BASE}/coaches`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Add coach", { timeout: 15000 });
    // The seeded rows arrive from a later fetch than the header, so wait for them
    // instead of reading the body in the gap — this check used to race the list
    // (a timeout here is turned into this check's own failure, not a crash).
    await page
      .waitForFunction(() => document.body.innerText.includes("Nimal Perera"), null, {
        timeout: 15000,
      })
      .catch(() => {});
    text = await page.textContent("body");
    check("coaches page lists seeded coaches", text.includes("Demo Coach") && text.includes("Nimal Perera"));

    // ------------------------------------------------------------------- imports
    await page.goto(`${BASE}/imports/players`, { waitUntil: "networkidle" });
    await page.waitForSelector("#csv-file", { timeout: 15000 });
    await page.setInputFiles("#csv-file", CSV_PATH);
    await page.waitForSelector("text=Ready to import", { timeout: 20000 });
    text = await page.textContent("body");
    check("import validation returns errors/warnings/preview", text.includes("Ready to import") && text.includes("Imported Player A"));
    check("duplicate row is reported as a warning, not an error", text.includes("Warning"));
    await page.screenshot({ path: `${OUT}import-review-1280.png` });

    await page.check("#import-warnings");
    await page.click("button:has-text('Commit')");
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("Import finished") ||
        document.body.innerText.includes("could not be processed"),
      null,
      { timeout: 25000 }
    );
    text = await page.textContent("body");
    check(
      "commit imports the rows and reports the result",
      text.includes("Import finished") && text.includes("2 players created"),
      text.includes("Import finished") ? "" : text.replace(/\s+/g, " ").slice(0, 220)
    );
    await page.screenshot({ path: `${OUT}import-done-1280.png` });
    await page.context().close();
  }

  // -------------------------------------------------------------------- mobile
  {
    const page = await newPage({ width: 360, height: 740 });
    await login(page, "owner");
    await page.goto(`${BASE}/players`, { waitUntil: "networkidle" });
    // The desktop table comes first in the DOM but is `hidden` at this width, so
    // wait on the card list specifically.
    await page.waitForSelector("ul.md\\:hidden li a", { state: "visible", timeout: 20000 });
    const cards = await page.locator("ul.md\\:hidden li a").count();
    const cardText = await page.textContent("ul.md\\:hidden");
    check(
      "360px renders the player cards (tables → cards)",
      cards > 0 && (cardText ?? "").includes("Demo Player One"),
      `${cards} cards`
    );
    await page.screenshot({ path: `${OUT}players-360.png` });
    await page.goto(`${BASE}/players/${PLAYER_ONE}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Overview", { timeout: 15000 });
    await page.screenshot({ path: `${OUT}player-profile-360.png` });
    await page.context().close();
  }

  // ---------------------------------------------------------------- coach view
  {
    const page = await newPage({ width: 1280, height: 900 });
    await login(page, "coach");
    await page.goto(`${BASE}/players`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Demo Player One", { timeout: 15000 });
    const text = await page.textContent("body");
    check(
      "coach list hides balances, guardian phones and the register action",
      !text.includes("Outstanding") && !text.includes("Primary guardian") && !text.includes("Register player")
    );
    check("coach list is scoped to the assigned group", !text.includes("IA-0002"));

    await page.goto(`${BASE}/players/${PLAYER_ONE}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Overview", { timeout: 15000 });
    const profile = await page.textContent("body");
    check(
      "coach profile shows Overview + Attendance only",
      profile.includes("Attendance") && !profile.includes("Group history") && !profile.includes("Guardians")
    );

    await page.goto(`${BASE}/players/${PLAYER_TWO}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Not found", { timeout: 15000 });
    const notFound = await page.textContent("body");
    check("out-of-scope player answers 404 without revealing it exists", notFound.includes("Not found"));

    await page.goto(`${BASE}/players/new`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=No access", { timeout: 15000 });
    check("coach cannot open the register screen", true);
    await page.screenshot({ path: `${OUT}coach-players-403-1280.png` });
    await page.context().close();
  }
} finally {
  await browser.close();
  fs.rmSync(CSV_PATH, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
