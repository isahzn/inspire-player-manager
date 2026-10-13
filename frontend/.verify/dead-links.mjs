// App-level dead-link audit: every static `href` in the app must resolve to a
// route that exists (the Step 2 audit, kept runnable). Dynamic ids are skipped —
// they are covered by the E2E scripts, which navigate them for real.
//
// Run: node .verify/dead-links.mjs   (exit 1 when an href has no route)
import fs from "node:fs";
import path from "node:path";

const SRC = "src";
const APP = path.join(SRC, "app");

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

// Built routes, from the App Router tree: [id] segments collapse to /[id].
const routes = new Set();
walk(APP, (file) => {
  if (path.basename(file) !== "page.tsx") return;
  const rel = path.relative(APP, path.dirname(file)).split(path.sep).join("/");
  const route = `/${rel.replace(/\[[^\]]+\]/g, "[id]")}`.replace(/\/$/, "");
  routes.add(route === "" ? "/" : route);
});

const DYNAMIC = [/^\/sessions\/[^/]+$/, /^\/players\/[^/]+$/, /^\/billing\/invoices\/[^/]+$/];

const dead = [];
walk(SRC, (file) => {
  if (!/\.tsx?$/.test(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/href=\{?["'`]([^"'`${}]+)["'`]/g)) {
    const target = match[1];
    if (!target.startsWith("/")) continue;
    const route = (target.split("?")[0] || "/").replace(/\/$/, "") || "/";
    if (DYNAMIC.some((re) => re.test(route))) continue;
    if (!routes.has(route)) dead.push(`${path.relative(".", file)} -> ${target}`);
  }
});

console.log(`dead-links: ${routes.size} routes · ${dead.length} unresolved href(s)`);
if (dead.length === 0) {
  console.log("\nOK — every static href has a route.");
  process.exit(0);
}
console.log("\nUNRESOLVED:");
for (const line of dead) console.log(`  ${line}`);
process.exit(1);
