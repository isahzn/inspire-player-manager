# HANDOFF_TEMPLATE

> Copy to `docs/engineering/handoffs/YYYY-MM-DD-<topic>.md` after each task/PR. Used by Freebuff (backend), Hassen (frontend), and Claude (review). Keep it factual; paste evidence, don't paraphrase it.

```
# HANDOFF <date> — <topic>
Author: <Freebuff | Hassen | Claude>      Milestone: M<n>      Branch/PR: <link>

## 1. Scope delivered
- Endpoint IDs / pages implemented: <PLY-02, PLY-03 …>
- Migrations added: <NNNN_name — tables/constraints>
- Docs read before starting: <list>

## 2. Evidence
- Tests run (T-IDs) and result summary: <pass/fail counts, CI link, date>
- Manual checks performed (device/env): <what, when, result>
- Coverage of billing/permission modules (if touched): <%>

## 3. Deviations from the spec  (must be "none" unless approved)
| Spec ref | What differs | Why | Needs spec change? (CR-###) |

## 4. Contract drift / requests
- Contract items changed or missing (endpoint/field/error code): <…>
- Frontend/backend expectations I could not satisfy: <…>

## 5. Known gaps and risks
- <not done / partial / flaky tests / security concerns>

## 6. How to run / verify
- <commands, env vars, seed data, URLs>

## 7. Next steps (exact)
- <who does what next>

## 8. Reviewer checklist (Claude/Hassen fills)
[ ] Compared to DATABASE/API docs  [ ] Permissions verified by route matrix  [ ] No money floats
[ ] Audit rows present  [ ] Tests evidence reviewed  [ ] PROJECT_STATUS updated  [ ] Verdict: accepted / changes requested
```
