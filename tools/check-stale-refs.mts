/**
 * check-stale-refs.mts — stale provider-reference checker
 *
 * Why this exists: the messaging provider moved from WAHA to OpenWA (CR-001 / ADR-017).
 * Historical ADRs and the "do not carry over" warnings *must* keep saying WAHA, while
 * everything else must not. A plain `grep -r WAHA` therefore cannot answer "am I done?" —
 * it drowns the few real leftovers in expected hits. This tool encodes which mentions are
 * intentional and fails only on the unexplained ones.
 *
 * Run:  node tools/check-stale-refs.mts             (exit 1 if anything unexplained)
 *       node tools/check-stale-refs.mts --all       (also list the intentional hits)
 *       node tools/check-stale-refs.mts --self-test (verify the checker's own rules)
 *
 * Node 24+ runs this file directly (type stripping); no build step, no dependencies.
 * The `.mts` extension is deliberate: this directory has no package.json, so `.ts` would be
 * CommonJS to both `tsc` and Node and `import.meta` would fail. `.mts` is unambiguously ESM.
 * Type-check it with: npx tsc --noEmit --strict --target es2022 --skipLibCheck tools/check-stale-refs.mts
 * When a provider changes again, edit STALE_PATTERNS / ALLOW_RULES below.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Directories never worth scanning (generated, vendored, or our own artifacts). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".verify",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
]);

/**
 * Files excluded from scanning. This tool necessarily contains the very patterns it looks
 * for, so it would otherwise always report itself.
 */
const SKIP_FILES = new Set(["tools/check-stale-refs.mts"]);

/** Extensions treated as text. Dotfiles such as `.env.local` are matched too. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".html",
  ".css",
  ".yml",
  ".yaml",
  ".example",
  ".env",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Tokens that should no longer appear outside an allowed context. */
const STALE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Deliberately no word boundaries: `wahaLabel`, `WAHA_SESSION` and similar identifiers
  // must be caught too. The replacement name ("OpenWA"/"openwa") does not contain the
  // substring "waha", so this stays false-positive-free.
  { name: "previous provider name (WAHA)", re: /waha/i },
  { name: "previous provider env prefix (WAHA_*)", re: /\bWAHA_[A-Z0-9_]+\b/ },
  { name: "previous webhook header (X-Webhook-Hmac)", re: /X-Webhook-Hmac/i },
  { name: "previous webhook env var (WHATSAPP_HOOK_HMAC_KEY)", re: /WHATSAPP_HOOK_HMAC_KEY/ },
  { name: "previous vendor domain (waha.devlike.pro)", re: /waha\.devlike\.pro/i },
  { name: "previous session status value (scanqr)", re: /\bscanqr\b/i },
];

/**
 * A hit in one of these files is intentional only when the same line matches `requires`.
 * Prefer a line-level marker over allow-listing a whole file: a whole-file rule is exactly
 * how stale text hid in design/app.js during the migration.
 */
const ALLOW_RULES: Array<{ file: string; requires?: RegExp; note: string }> = [
  {
    file: "docs/engineering/DECISIONS.md",
    note: "historical ADRs are never edited (supersede only)",
  },
  {
    file: "docs/architecture/OPENWA_INTEGRATION.md",
    requires: /supersed|previous|carry|invalid|Core\/Plus|not carried|switching from/i,
    note: "supersedes header, do-not-carry-over warnings and risk-continuity note",
  },
  {
    file: "docs/engineering/PROJECT_STATUS.md",
    requires: /CR-001|WAHA -> OpenWA|Not carried over|replaces|superseded|instead of WAHA|stay on WAHA/i,
    note: "CR-001 change record (problem statement and alternatives)",
  },
  {
    file: "docs/engineering/MOCK_DATA.md",
    requires: /do not reuse|VERIFY/i,
    note: "warning not to reuse the previous provider's status value",
  },
  {
    file: "docs/engineering/OPEN_DECISIONS.md",
    requires: /resolved|previous|replaced|now \*\*OpenWA\*\*/i,
    note: "open decision resolved by the switch",
  },
  {
    file: "docs/architecture/OVERVIEW.md",
    requires: /previously|replaced|CR-001|ADR-017/i,
    note: "dated research provenance",
  },
  {
    file: "docs/engineering/BACKEND_BUILD_GUIDE.md",
    requires: /not carried over|do not carry|invalid for OpenWA/i,
    note: "do-not-carry-over warning",
  },
  {
    file: "README.md",
    requires: /not WAHA|ADR-017|CR-001/i,
    note: "status line records the provider switch",
  },
];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

type Hit = {
  /** repo-relative POSIX path */
  file: string;
  line: number;
  text: string;
  pattern: string;
  allowed: boolean;
  note: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toPosix = (p: string) => p.split(path.sep).join("/");

function isTextCandidate(fileName: string): boolean {
  if (fileName.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function collectFiles(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && isTextCandidate(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function allowRuleFor(relFile: string): { requires?: RegExp; note: string } | null {
  for (const rule of ALLOW_RULES) {
    if (relFile === rule.file) return rule;
  }
  return null;
}

/**
 * A lockfile entry holding a base64 integrity hash.
 *
 * A short token can occur by chance inside a hash — `sha512-wAhAQ+es0…` in
 * `backend/package-lock.json` is not a WAHA reference — and a stale provider name would never
 * exist *only* inside one. The line is skipped rather than the file: the rest of the lockfile
 * is still scanned, so a real `waha` dependency name is still caught (and the lockfile is
 * generated from `package.json`, which is scanned in its own right).
 */
const INTEGRITY_LINE = /^\s*"integrity":\s*"sha\d+-[A-Za-z0-9+/=]+"\s*,?\s*$/;

function scanLines(relFile: string, content: string): Hit[] {
  const rule = allowRuleFor(relFile);
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (INTEGRITY_LINE.test(line)) continue;
    for (const { name, re } of STALE_PATTERNS) {
      if (!re.test(line)) continue;
      // A file-level rule without `requires` means every hit in it is intentional.
      const allowed = rule ? (rule.requires ? rule.requires.test(line) : true) : false;
      hits.push({
        file: relFile,
        line: i + 1,
        text: line.trim(),
        pattern: name,
        allowed,
        note: allowed && rule ? rule.note : "",
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Guards the checker itself: verifies the patterns still match what they claim and that the
 * allow rules classify known-good and known-bad lines correctly. Run: --self-test
 */
function selfTest(): void {
  const failures: string[] = [];
  const ok = (label: string, condition: boolean) => {
    if (!condition) failures.push(label);
  };

  const staleSamples = [
    "WAHA",
    "waha",
    'id="wahaLabel"',
    "WAHA_SESSION",
    "X-Webhook-Hmac",
    "WHATSAPP_HOOK_HMAC_KEY",
    "https://waha.devlike.pro/pricing",
    'provider:"waha"',
    "status scanqr",
  ];
  for (const sample of staleSamples) {
    ok(`should be flagged: ${sample}`, STALE_PATTERNS.some((p) => p.re.test(sample)));
  }

  const currentSamples = [
    "OpenWA",
    "openwa",
    "X-OpenWA-Signature",
    "OPENWA_API_KEY",
    "awaiting_qr",
    "github.com/rmyndharis/OpenWA",
  ];
  for (const sample of currentSamples) {
    ok(`must NOT be flagged: ${sample}`, !STALE_PATTERNS.some((p) => p.re.test(sample)));
  }

  // Allow rules must pass intentional context and still reject plain stale text.
  const classified = (file: string, line: string): boolean => {
    const hits = scanLines(file, line);
    return hits.length > 0 && hits.every((h) => h.allowed);
  };
  ok(
    "historical ADR mention allowed",
    classified("docs/engineering/DECISIONS.md", "only the WAHA adapter knows WAHA")
  );
  ok(
    "supersedes warning allowed",
    classified(
      "docs/architecture/OPENWA_INTEGRATION.md",
      "**Switching from WAHA does not change these risks**"
    )
  );
  ok(
    "CR-001 problem statement allowed",
    classified("docs/engineering/PROJECT_STATUS.md", "run OpenWA instead of WAHA as the gateway")
  );
  ok(
    "unmarked line inside an allowed file is still flagged",
    !classified("docs/architecture/OPENWA_INTEGRATION.md", "TODO: still on WAHA here")
  );
  ok(
    "stale code is flagged",
    !classified("design/app.js", 'whatsapp:["WhatsApp (WAHA)"]')
  );
  // A hash is not a reference (the reason INTEGRITY_LINE exists), and skipping it must not
  // blunt the pattern: the same token on a normal line is still flagged.
  ok(
    "a base64 integrity hash is not a reference",
    scanLines("backend/package-lock.json", '      "integrity": "sha512-wAhAQ+es0aH+x5OofdCHlZZFdqw==",').length === 0
  );
  ok(
    "a real dependency name in the lockfile is still flagged",
    scanLines("backend/package-lock.json", '    "node_modules/waha": {').some((h) => !h.allowed)
  );

  if (failures.length === 0) {
    console.log(`check-stale-refs --self-test: PASS (${staleSamples.length + currentSamples.length + 7} assertions)`);
    process.exit(0);
  }
  console.log("check-stale-refs --self-test: FAIL");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const showAll = process.argv.includes("--all");
  const files = await collectFiles(ROOT);
  const hits: Hit[] = [];

  for (const absolute of files) {
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    if (info.size > MAX_FILE_BYTES) continue;
    const rel = toPosix(path.relative(ROOT, absolute));
    if (SKIP_FILES.has(rel)) continue;
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue; // binary
    hits.push(...scanLines(rel, content));
  }

  const stale = hits.filter((h) => !h.allowed);
  const allowed = hits.filter((h) => h.allowed);

  console.log(
    `check-stale-refs: scanned ${files.length} files · ${STALE_PATTERNS.length} patterns · ` +
      `${hits.length} hit(s) → ${stale.length} unexplained, ${allowed.length} intentional`
  );

  if (stale.length > 0) {
    console.log("\nUNEXPLAINED (fix these or add a precise ALLOW_RULES entry):");
    for (const h of stale) {
      console.log(`  ${h.file}:${h.line}  [${h.pattern}]`);
      console.log(`      ${h.text.slice(0, 160)}`);
    }
  }

  if (showAll && allowed.length > 0) {
    console.log("\nINTENTIONAL (allow-listed):");
    for (const h of allowed) {
      console.log(`  ${h.file}:${h.line}  — ${h.note}`);
    }
  } else if (allowed.length > 0) {
    const byFile = new Map<string, number>();
    for (const h of allowed) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    console.log("\nintentional mentions: " + [...byFile].map(([f, n]) => `${f} (${n})`).join(", "));
    console.log("(run with --all to list them)");
  }

  if (stale.length === 0) {
    console.log("\nOK — no stale provider references.");
    process.exit(0);
  }
  console.log(`\nFAIL — ${stale.length} stale reference(s).`);
  process.exit(1);
}

main().catch((err) => {
  console.error("check-stale-refs: unexpected error:", err);
  process.exit(2);
});
