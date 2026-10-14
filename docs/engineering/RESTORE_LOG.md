# RESTORE_LOG.md — every restore that has actually been performed

`DEPLOYMENT_AND_OPERATIONS` §7: *a backup that has never been restored is not a backup.* Each entry
below records a drill that was **actually run**, on which dump, and what came back. The procedure is
runbook step 12c. The file is append-only, and a failed drill is recorded as a failure — that is the
entry worth having.

| # | Date | Dump | Duration | Result |
|---|---|---|---|---|
| 1 | 2026-10-14 | `ia-2026-10-14_2202.dump` — 186 KiB, 462 archive entries, 35 `TABLE DATA` sections | **3 s** | **Passed.** `pg_restore` exit 0 with **no messages** into a throwaway `ia_restore_test` on the same VPS: 35 tables, 17 migrations, `academy_settings` = “Inspire Academy / Asia/Colombo / LKR”, 1 user (`owner`, `invited`), 2 `audit_logs` rows. The throwaway database was dropped afterwards and `ia_prod` was confirmed untouched. |

## What entry 1 does and does not prove

It proves the **mechanism**: the nightly job produces a complete custom-format archive, and the
documented procedure restores it into a clean database, in seconds, with nothing left behind.

It does **not** establish an RTO for a real database. This one holds a single invited owner and no
invoices, so the restore had almost nothing to write; the number above is a floor, not a guarantee.
Re-measure against a database of realistic size before quoting the RTO that `DEPLOYMENT` §7 asks the
owner to accept (RPO ≤ 15 min / RTO ≤ 4 h, `OPEN-017`), and re-run a drill after any release that
contains a migration.

Two further limits, stated so they are not mistaken for covered ground:

- **The dump is on the machine it protects.** It is written to the `ia_backups` volume on this VPS,
  so losing the VPS still loses the backup. Shipping it off-host is runbook step 12b and is still
  outstanding.
- **`ia_files` is not in the dump.** Payment proofs live in the `ia_files` volume and are the one
  artefact that cannot be re-created; they need their own off-host copy (step 12b).
