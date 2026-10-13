// Step 2 E2E (mock mode, system Chrome): proves the demo criteria —
// owner login → full nav + dashboard; coach → restricted + /403 on owner
// routes; logged-out guard → /login?next=; invalid creds + TOTP behaviours.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME =
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox"],
});
try {
  async function freshPage(viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.contextsToClose = ctx;
    return page;
  }
  async function closePage(page) {
    await page.context().close();
  }

  // 1. Logged-out guard: /dashboard → /login?next=
  {
    const page = await freshPage({ width: 1280, height: 800 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/login\?next=/, { timeout: 15000 });
    check("logged-out /dashboard redirects to /login?next=", true, page.url());
    await page.waitForSelector("#username", { timeout: 10000 });
    await page.screenshot({ path: `${OUT}login-360.png` });
    await closePage(page);
  }

  // 2. Invalid credentials → generic error (no field reveal)
  {
    const page = await freshPage();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "nobody");
    await page.fill("#password", "wrongpassword1");
    await page.click('button[type="submit"]');
    await page.waitForSelector("#login-error", { timeout: 10000 });
    const text = await page.textContent("#login-error");
    check("invalid creds show generic error", text.includes("incorrect"), text.trim());
    await closePage(page);
  }

  // 3. TOTP flow: code field appears only after server says so
  {
    const page = await freshPage();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "totp");
    await page.fill("#password", "anypassword1");
    await page.click('button[type="submit"]');
    await page.waitForSelector("#totp", { timeout: 10000 });
    check("TOTP field appears after TOTP_REQUIRED", true);
    await page.fill("#totp", "123456");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    check("TOTP login reaches dashboard", true);
    await closePage(page);
  }

  // 4. Owner login → dashboard with separate Invoiced/Collected + full nav
  {
    const page = await freshPage({ width: 1280, height: 800 });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "owner");
    await page.fill("#password", "anypassword1");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    // Step 7 replaced this page's placeholder copy with the real DSH-01 blocks,
    // so the anchor is its own heading and the assertion is the money rule that
    // still has to hold: four SEPARATE figures, never Invoiced + Collected.
    await page.waitForSelector("text=Coaches today", { timeout: 25000 });
    const body = await page.evaluate(() => document.body.innerText ?? "");
    check(
      "owner dashboard shows Invoiced + Collected as separate figures",
      body.includes("Invoiced") &&
        body.includes("Collected") &&
        body.includes("Outstanding") &&
        body.includes("Overdue")
    );
    check("owner nav has Billing + Users", body.includes("Billing") && body.includes("Users"));
    await page.screenshot({ path: `${OUT}dashboard-owner-1280.png` });
    // Owner can open an owner route (guard passes, no 403)
    await page.goto(`${BASE}/billing`, { waitUntil: "networkidle" });
    const billing = await page.textContent("body");
    check("owner opens /billing (no 403)", !billing.includes("No access"));
    await closePage(page);
  }

  // 5. Coach login → restricted nav; /billing → inline 403 (no owner API call)
  {
    const page = await freshPage({ width: 360, height: 740 });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "coach");
    await page.fill("#password", "anypassword1");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    const body = await page.textContent("body");
    check("coach nav hides Billing/Users", !body.includes("Billing") && !body.includes("Users"));
    await page.goto(`${BASE}/billing`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=No access", { timeout: 30000 });
    check("coach /billing renders 403 state", true);
    await page.screenshot({ path: `${OUT}billing-coach-403-360.png` });
    // Coach sessions page is allowed
    await page.goto(`${BASE}/sessions`, { waitUntil: "networkidle" });
    const sess = await page.textContent("body");
    check("coach opens /sessions", sess.includes("Sessions"));
    await closePage(page);
  }

  // 6. Locked account message
  {
    const page = await freshPage();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "locked");
    await page.fill("#password", "anypassword1");
    await page.click('button[type="submit"]');
    await page.waitForSelector("#login-error", { timeout: 10000 });
    const text = await page.textContent("#login-error");
    check("locked account shows 15-minute message", text.includes("15 minutes"), text.trim());
    await closePage(page);
  }

  // 7. Profile page sections render (owner)
  {
    const page = await freshPage({ width: 360, height: 740 });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#username", "owner");
    await page.fill("#password", "anypassword1");
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    await page.goto(`${BASE}/profile`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Two-factor authentication", { timeout: 10000 });
    const body = await page.textContent("body");
    check(
      "profile has password + sessions + TOTP",
      body.includes("Change password") && body.includes("Sessions") && body.includes("Two-factor")
    );
    await page.screenshot({ path: `${OUT}profile-360.png` });
    await closePage(page);
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
