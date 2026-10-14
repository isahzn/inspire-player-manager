/**
 * Fails unless the test run actually ran everything.
 *
 * WHY THIS EXISTS
 *
 * A green browser tab is not evidence that tests ran. This project has already seen the failure
 * mode twice: vitest reports a file whose `beforeAll` threw as **skipped**, and a run where the
 * database was never reachable therefore finishes quickly and reports 0 failures. The first CI
 * run of this repository passed its whole suite in 40 seconds against a local measurement of 254,
 * which is exactly the shape a "nothing ran" green run has — and nobody can tell the difference
 * from the outside without reading the logs.
 *
 * So the counts are asserted instead of assumed:
 *
 *   · every test that exists passed, and none is skipped/pending/todo;
 *   · the per-project file counts are non-zero — a project cannot silently vanish (the `db`
 *     project is the one that stops running when PostgreSQL is unreachable, and it is the
 *     project that proves RLS);
 *   · the total matches `tests/minimums.json`, raised deliberately whenever tests are added.
 *
 * `minimums` is a floor, not an exact expectation: running a subset locally (`vitest run
 * tests/unit/x.test.ts`) is normal, and this script is meant for the full CI run. It refuses a
 * *short* run, never a longer one.
 *
 *   node scripts/assert-test-report.mjs [report.json]
 *   node scripts/assert-test-report.mjs --self-test      # proves the rules still fire
 *
 * The self-test exists because a guard nobody has seen fail is a guard nobody can trust: it runs
 * the same rule set against a known-good report, an all-skipped report, a missing-project report
 * and a short report, and fails unless each one lands the way it should.
 */
import { readFile } from "node:fs/promises";

const MINIMUMS = JSON.parse(
  await readFile(new URL("./tests-minimums.json", import.meta.url), "utf8"),
);

/**
 * The whole rule set, over a parsed vitest JSON report. Pure: it returns the problems it found
 * rather than exiting, which is what lets the self-test drive it directly.
 */
function problemsIn(report) {
  const files = (report.testResults ?? []).map((file) => String(file.name).replace(/\\/g, "/"));
  const countOf = (fragment) => files.filter((name) => name.includes(fragment)).length;

  const projects = {
    "tests/unit": countOf("/tests/unit/"),
    "tests/db": countOf("/tests/db/"),
    "tests/integration": countOf("/tests/integration/"),
  };

  const problems = [];

  if (report.numFailedTests > 0) {
    problems.push(`${report.numFailedTests} test(s) failed`);
  }
  if ((report.numPendingTests ?? 0) > 0 || (report.numSkippedTests ?? 0) > 0) {
    problems.push(
      `${report.numPendingTests || report.numSkippedTests} test(s) were skipped or pending — ` +
        "a skipped test is a test that did not run, which is what this check exists to catch",
    );
  }
  if ((report.numTodoTests ?? 0) > 0) {
    problems.push(`${report.numTodoTests} test(s) are marked todo`);
  }
  if (report.numPassedTests !== report.numTotalTests) {
    problems.push(
      `${report.numPassedTests} of ${report.numTotalTests} tests passed — the run is short`,
    );
  }

  for (const [name, minimum] of Object.entries(MINIMUMS.files)) {
    if ((projects[name] ?? 0) < minimum) {
      problems.push(
        `${name}: ${projects[name] ?? 0} file(s) ran, expected at least ${minimum} — this ` +
          "project did not run (a database-backed project that cannot reach PostgreSQL " +
          "reports nothing)",
      );
    }
  }
  if (report.numTotalTests < MINIMUMS.tests) {
    problems.push(
      `${report.numTotalTests} test(s) ran in total, expected at least ${MINIMUMS.tests} — ` +
        "if tests were added deliberately, raise backend/scripts/tests-minimums.json",
    );
  }

  return { problems, projects, files };
}

function summarise(report, { problems, projects, files }) {
  return (
    `test report: ${report.numTotalTests} test(s) in ${files.length} file(s) — ` +
    `unit ${projects["tests/unit"]}, db ${projects["tests/db"]}, ` +
    `integration ${projects["tests/integration"]} · ` +
    `passed ${report.numPassedTests}, failed ${report.numFailedTests}, ` +
    `pending ${report.numPendingTests ?? 0}, todo ${report.numTodoTests ?? 0}\n` +
    (problems.length > 0
      ? problems.map((problem) => `FAIL  ${problem}\n`).join("")
      : "OK — every test ran and passed, in all three projects.\n")
  );
}

/**
 * The self-test's fixture: a report that satisfies every rule, which each case then breaks.
 *
 * The paths are absolute, like vitest's own (`/app/backend/tests/unit/x.test.ts`), because the
 * rules match on the `/tests/unit/` fragment with its leading slash — a fixture of relative
 * paths would silently score zero files for every project and make the first case fail. That
 * happened when this self-test was first run, which is the argument for having one.
 */
function goodReport() {
  const file = (name) => ({ name });
  const at = (project, i) => `/app/backend/tests/${project}/${project}-${i}.test.ts`;
  const testResults = [
    ...Array.from({ length: MINIMUMS.files["tests/unit"] }, (_, i) => file(at("unit", i))),
    ...Array.from({ length: MINIMUMS.files["tests/db"] }, (_, i) => file(at("db", i))),
    ...Array.from({ length: MINIMUMS.files["tests/integration"] }, (_, i) =>
      file(at("integration", i)),
    ),
  ];
  return {
    numTotalTests: MINIMUMS.tests,
    numPassedTests: MINIMUMS.tests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults,
  };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    { name: "a complete, green run passes", report: goodReport(), shouldFail: false },
    {
      name: "an all-skipped run (the failure this guard exists for) fails",
      report: { ...goodReport(), numPassedTests: 0, numSkippedTests: MINIMUMS.tests },
      shouldFail: true,
    },
    {
      name: "a run missing its database project fails",
      report: {
        ...goodReport(),
        testResults: goodReport().testResults.filter(
          (file) => !file.name.includes("/tests/db/"),
        ),
      },
      shouldFail: true,
    },
    {
      name: "a short run fails even with every test green",
      report: {
        ...goodReport(),
        numTotalTests: MINIMUMS.tests - 1,
        numPassedTests: MINIMUMS.tests - 1,
      },
      shouldFail: true,
    },
    {
      name: "a run with one failure fails",
      report: {
        ...goodReport(),
        numPassedTests: MINIMUMS.tests - 1,
        numFailedTests: 1,
      },
      shouldFail: true,
    },
  ];

  let bad = 0;
  for (const testCase of cases) {
    const failed = problemsIn(testCase.report).problems.length > 0;
    const ok = failed === testCase.shouldFail;
    process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${testCase.name}\n`);
    if (!ok) bad += 1;
  }
  process.stdout.write(
    bad === 0
      ? `the guard's own rules hold (${cases.length} cases)\n`
      : `${bad} of ${cases.length} self-test case(s) behaved wrongly — fix the guard before trusting it\n`,
  );
  process.exitCode = bad === 0 ? 0 : 1;
} else {
  const reportPath = process.argv[2] ?? "test-report.json";

  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (err) {
    process.stdout.write(
      `FAIL  could not read ${reportPath} (${err.code ?? err.message}).\n` +
        "A missing report means the run never produced one: the suite did not run.\n",
    );
    process.exitCode = 1;
    report = null;
  }

  if (report) {
    const analysis = problemsIn(report);
    process.stdout.write(summarise(report, analysis));
    if (analysis.problems.length > 0) {
      process.stdout.write(
        "The suite did not run in full. A green run that skipped its tests is worse than a " +
          "red one: it is a claim of verification that was never earned.\n",
      );
      process.exitCode = 1;
    }
  }
}

export { problemsIn };
