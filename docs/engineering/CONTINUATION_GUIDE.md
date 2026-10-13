# CONTINUATION_GUIDE (for future Claude sessions)

> **Status:** Draft v1 · **Owner:** Claude · **Updated:** 2026-10-11
> Memory of earlier chats is unreliable; **this repository is the memory.** Follow the procedure exactly.

## 1. Operating procedure

1. Read root [CLAUDE.md](../../CLAUDE.md).
2. Read [PROJECT_STATUS](PROJECT_STATUS.md).
3. Read [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md).
4. Read [DECISIONS](DECISIONS.md), [KNOWN_RISKS](KNOWN_RISKS.md) and [OPEN_DECISIONS](OPEN_DECISIONS.md).
5. Read the documents relevant to the requested task (use the matrix in [CHANGE_MANAGEMENT](CHANGE_MANAGEMENT.md) §3).
6. **Inspect the actual repository and current changes** (`git log`, `git status`, diff since last status date, existing migrations/routes/tests, CI results, latest HANDOFF reports).
   - **Known caveat (checked 2026-10-12): this project is NOT under version control.** `git ls-files .` returns **0** — `docs/`, `frontend/` and `design/` are untracked in the surrounding workspace repo, so `git log`/`git diff`/`git status` show nothing about this project and no change can be reverted. Inspect files directly (and treat "make a commit" as unavailable until step 1 of PROJECT_STATUS' next actions is done). Do **not** read an empty diff as "nothing changed".
7. Confirm the **current milestone and its exit criteria**.
8. Continue from the **first unfinished task** in that milestone.
9. **Do not redo completed work** unless an issue (failed test, spec conflict, bug) justifies it — and say why.
10. Run or specify the **verification steps** (T-IDs) for the work.
11. Update PROJECT_STATUS, DECISIONS, KNOWN_RISKS, OPEN_DECISIONS and every affected doc together.
12. Leave a **precise next-step handoff** (who does what, which files, which commands, expected evidence).

## 2. Identifying the current phase
Open PROJECT_STATUS → "Milestones" table. The current phase is the lowest-numbered milestone not marked **Done with evidence**. If PROJECT_STATUS conflicts with the repo (e.g., claims done but tests absent), **trust the repo, correct the status, and note the discrepancy.**

## 3. Evidence ladder: planned → implemented → tested → verified

| Level | Meaning | Acceptable evidence |
|---|---|---|
| Planned | Documented only | spec text |
| Implemented | Code/migration exists in repo | commit/PR reference reviewed against the spec |
| Tested | Automated tests for its T-IDs exist and passed | CI run link/log summary with date |
| Verified | Behaviour confirmed in staging/prod-like env or by a human check (e.g., restore test, real-number WhatsApp, device test) | dated record in PROJECT_STATUS / RESTORE_LOG / HANDOFF |

A task is **complete** only at "Tested" (or "Verified" where its row says manual). **Documentation written is not proof code exists or works.** Never mark a milestone done on a claim alone — ask for or inspect evidence.

## 4. Never assume Freebuff followed the spec
Before proposing backend-dependent frontend changes: diff real endpoints/fields against API_CONTRACTS/OpenAPI; run or read contract tests; list drift in a HANDOFF note.

## 5. Handing off and recording progress
- To Freebuff: a message that links the milestone, task list, relevant doc sections, T-IDs, and the HANDOFF template.
- To Hassen: same, for frontend.
- Record: PROJECT_STATUS (state, evidence, next actions), DECISIONS (new ADRs), OPEN_DECISIONS (new/resolved), KNOWN_RISKS (new/changed), HANDOFF reports (store under `docs/engineering/handoffs/YYYY-MM-DD-<topic>.md`).
- End every session with "Exact next actions" in PROJECT_STATUS that a fresh session can follow without chat history.

## 6. Documentation lint checklist (run before finishing a session that edited docs)
- Every endpoint ID in PAGE_SPEC/TESTING exists in API_CONTRACTS.
- Every table/column named in API types exists in DATABASE.
- Every OPEN-xxx / ADR-xxx / T-xxx referenced exists.
- Permission matrix == route auth column.
- Money fields end in `Minor`/`_minor` everywhere; no floats.
- Relative links resolve.
- **No stale provider references:** `node tools/check-stale-refs.mts` exits 0. It knows which mentions are intentional (historical ADRs, the `supersedes` header, CR-001's record) and fails only on unexplained ones — a raw grep for the previous provider name cannot answer this, because those historical mentions must stay. Run it after any provider/gateway change; edit `STALE_PATTERNS`/`ALLOW_RULES` at the top of that file when a provider changes again. Run `node tools/check-stale-refs.mts --self-test` after editing it — that proves the patterns still match what they claim and that the allow rules do not over-permit.
- PROJECT_STATUS date updated; nothing marked complete without evidence.

## 7. Resuming with a new Claude chat (copy-paste starter)
> "Read `CLAUDE.md`, then follow `docs/engineering/CONTINUATION_GUIDE.md`. Current repo is at <path>. Task: <task>. Use the milestone in `PROJECT_STATUS.md`."
