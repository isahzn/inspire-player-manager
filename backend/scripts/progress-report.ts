/**
 * Throwaway progress report: how much of the contract is actually served.
 * Run: npx tsx scripts/progress-report.ts
 */
import { allEndpoints } from "../spec/index.js";
import { handlers } from "../src/routes/index.js";

const byMilestone = new Map<string, { total: number; done: number }>();
for (const ep of allEndpoints) {
  const key = ep.milestone ?? "unassigned";
  const entry = byMilestone.get(key) ?? { total: 0, done: 0 };
  entry.total += 1;
  if (handlers.has(ep.operationId ?? ep.id)) entry.done += 1;
  byMilestone.set(key, entry);
}

let total = 0;
let done = 0;
for (const [milestone, entry] of [...byMilestone].sort(([a], [b]) => a.localeCompare(b))) {
  total += entry.total;
  done += entry.done;
  console.log(`${milestone}: ${entry.done}/${entry.total} implemented`);
  const missing = allEndpoints
    .filter((ep) => ep.milestone === milestone && !handlers.has(ep.operationId ?? ep.id))
    .map((ep) => ep.operationId ?? ep.id);
  if (missing.length) console.log(`   missing: ${missing.join(", ")}`);
}
console.log(`TOTAL: ${done}/${total}`);
