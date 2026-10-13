/**
 * The billing period rules as SQL (0012, BILLING_ENGINE §3).
 *
 * These are database-layer tests on purpose: `app.billing_period_start`/`_end` are the single
 * definition of a period that the preview, the run and any later report all call, so the
 * place to prove them is where they live — not through a preview response, where a wrong
 * period would look like a plausible set of dates.
 *
 * The cases that matter are the boundaries. An anchored month must be measured **from the
 * anchor** and never from the previous start: with an anchor on the 31st the sequence is
 * 31 Jan → 28 Feb → 31 Mar, so the February period ends on 30 March. `age()` — the obvious
 * implementation — answers that boundary wrongly, which is why the function does not use it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { clientConfigFrom } from "../helpers/test-db.js";

interface Period {
  start_date: string;
  end_date: string;
}

describe("billing periods (BILLING_ENGINE §3)", () => {
  let client: Client;

  beforeAll(async () => {
    const url = process.env["DATABASE_MIGRATOR_URL"];
    if (!url) throw new Error("DATABASE_MIGRATOR_URL must point at ia_test");
    const { migrate } = await import("../../scripts/migrate.js");
    await migrate(url);
    client = new Client(clientConfigFrom(url));
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function period(
    anchor: string,
    date: string,
    frequency: "weekly" | "monthly",
    mode: "calendar" | "anchored",
    weekStartDay = 1,
  ): Promise<string> {
    const result = await client.query<Period>(
      `select app.billing_period_start($1::date, $2::date, $3, $4, $5)::text as start_date,
              app.billing_period_end($1::date, $2::date, $3, $4, $5)::text as end_date`,
      [anchor, date, frequency, mode, weekStartDay],
    );
    const row = result.rows[0]!;
    return `${row.start_date}..${row.end_date}`;
  }

  it("clamps an anchored month to the anchor, not to the previous start", async () => {
    const anchor = "2026-01-31";
    // The sequence the doc gives as a worked example: 31 Jan → 28 Feb → 31 Mar.
    expect(await period(anchor, "2026-01-31", "monthly", "anchored")).toBe(
      "2026-01-31..2026-02-27",
    );
    expect(await period(anchor, "2026-02-28", "monthly", "anchored")).toBe(
      "2026-02-28..2026-03-30",
    );
    expect(await period(anchor, "2026-03-15", "monthly", "anchored")).toBe(
      "2026-02-28..2026-03-30",
    );
    expect(await period(anchor, "2026-03-31", "monthly", "anchored")).toBe(
      "2026-03-31..2026-04-29",
    );
    expect(await period(anchor, "2026-04-30", "monthly", "anchored")).toBe(
      "2026-04-30..2026-05-30",
    );
  });

  it("uses the calendar month when the mode is calendar", async () => {
    expect(await period("2026-01-31", "2026-11-15", "monthly", "calendar")).toBe(
      "2026-11-01..2026-11-30",
    );
    expect(await period("2026-01-31", "2026-12-31", "monthly", "calendar")).toBe(
      "2026-12-01..2026-12-31",
    );
  });

  it("starts a week on the configured week-start day", async () => {
    // 2026-10-13 is a Tuesday; ISO day 1 is Monday, so the week runs 12–18.
    expect(await period("2026-01-31", "2026-10-13", "weekly", "calendar")).toBe(
      "2026-10-12..2026-10-18",
    );
    // A date that *is* the start day belongs to its own period, not the previous one.
    expect(await period("2026-01-31", "2026-10-12", "weekly", "calendar")).toBe(
      "2026-10-12..2026-10-18",
    );
  });

  it("anchors a week on its own start date, including before it", async () => {
    const anchor = "2026-01-05";
    expect(await period(anchor, "2026-10-13", "weekly", "anchored")).toBe(
      "2026-10-12..2026-10-18",
    );
    // Before the anchor the index floors (it must not truncate toward zero, or the week
    // would silently become the anchor's own).
    expect(await period(anchor, "2026-01-01", "weekly", "anchored")).toBe(
      "2025-12-29..2026-01-04",
    );
  });
});
