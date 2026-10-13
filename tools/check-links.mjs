/**
 * check-links.mjs — documentation relative-link checker
 *
 * Why this exists: PROJECT_STATUS claims "every relative link resolves". That claim is only
 * worth something if it is reproducible, so this tool re-derives it from the files on disk.
 * It checks Markdown links only (`[text](target)`) and ignores absolute URLs, `mailto:` and
 * pure `#anchor` targets — anchors are not verified (no heading-slug check yet).
 *
 * Run:  node tools/check-links.mjs          (exit 1 if any relative link is broken)
 *
 * No dependencies; Node 24+ runs it directly.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directories never worth scanning (generated, vendored, or artifacts). */
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function markdownFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await markdownFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const files = await markdownFiles(ROOT);
let links = 0;
const broken = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  // `[text](target)` — stops the target at whitespace or the closing paren.
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match;
  while ((match = re.exec(text))) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const hashless = target.split("#")[0];
    if (!hashless) continue;
    links++;
    const absolute = path.resolve(path.dirname(file), decodeURIComponent(hashless));
    if (!existsSync(absolute)) {
      broken.push(`${path.relative(ROOT, file).split(path.sep).join("/")} -> ${target}`);
    }
  }
}

console.log(
  `check-links: ${files.length} files · ${links} relative links · ${broken.length} broken`,
);

if (broken.length === 0) {
  console.log("\nOK — every relative link resolves.");
  process.exit(0);
}

console.log("\nBROKEN:");
for (const b of broken) console.log(`  ${b}`);
process.exit(1);
