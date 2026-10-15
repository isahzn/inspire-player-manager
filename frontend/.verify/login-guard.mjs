// Login guard (mode-independent): the credential must never reach the URL.
//
// If the login form is submitted before React hydrates, the browser does a NATIVE
// form submission, and a form's default method is GET — the password would then be
// in the address bar, the history entry and the Referer header. The submit button
// is therefore rendered `disabled` by the server (and a disabled default button
// also blocks implicit Enter submission), and enabled only once the client is
// live.
//
// Phase 1 withholds every JavaScript chunk, so the page under test is exactly the
// server-rendered HTML — the state a user on a slow connection sits in, and the
// only state that can be tested without racing hydration.
//
// Run with `npm run dev` already listening on :3100 (mock or live mode).
//
//   npm run verify:login-guard
import { chromium } from "playwright-core";

const BASE = "http://localhost:3100";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

// --- Phase 1: no JavaScript at all ------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/_next/static/**", (route) => route.abort());
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username", { state: "visible", timeout: 20000 });

  const ssrDisabled = await page.isDisabled('form button[type="submit"]');
  check(
    "the server-rendered submit button is disabled (nothing submits before hydration)",
    ssrDisabled,
    `disabled=${ssrDisabled}`,
  );

  await page.fill("#username", "huzzam");
  await page.fill("#password", "12345");
  // The realistic pre-hydration action: Enter in the password field, which is the
  // browser's implicit form submission.
  await page.press("#password", "Enter");
  await page.waitForTimeout(2500);

  const url = page.url();
  console.log(`URL after pressing Enter on the un-hydrated page: ${url}`);
  check("the password never appears in the URL", !/password=/.test(url), url);
  check("the username never appears in the URL", !/username=/.test(url), url);
  await ctx.close();
}

// --- Phase 2: with JavaScript, the guard must not strand the form ------------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username", { state: "visible", timeout: 20000 });

  let enabled = true;
  try {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('form button[type="submit"]');
        return btn instanceof HTMLButtonElement && !btn.disabled;
      },
      { timeout: 20000 },
    );
  } catch {
    enabled = false;
  }
  check("the button enables itself once hydrated (the form is not stranded)", enabled);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
