# API_INTEGRATION

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Hassen (implementation) · **Updated:** 2026-10-11
> **Depends on:** [API_CONTRACTS](../architecture/API_CONTRACTS.md), [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md) · **Source of truth for:** how the frontend talks to the API. The API contract itself lives only in API_CONTRACTS / `openapi.yaml`.

## 1. Client setup

- One module `apiClient` wraps `fetch`: base URL from env (`API_BASE_URL`), `credentials: 'include'`, JSON in/out, `X-CSRF-Token` header on `POST/PUT/PATCH/DELETE` (token from `AUTH-01`/`AUTH-03`, kept **in memory**, never `localStorage`), `Accept: application/json`, request timeout 20 s (60 s for uploads/exports).
- **Types:** until M1 exit, hand-write types from API_CONTRACTS §2; after M1 generate from `api/openapi.yaml` (e.g., `openapi-typescript`) and delete hand-written copies. CI fails if generated types drift.
- No endpoint is called unless it has an ID in the contract. Wrapper functions are named after endpoint IDs (`ply02_createPlayer`) so reviews can trace them.
- No secrets in the bundle. Only `API_BASE_URL` (and feature flags) are public.

## 2. Authentication behaviour

| Event | Frontend behaviour |
|---|---|
| App start | `GET /auth/me`; 401 → login. Store `Me` in memory (+ query cache). |
| Login | `AUTH-01` → store `csrfToken`; navigate to `next` or dashboard. |
| 401 `UNAUTHENTICATED`/`SESSION_EXPIRED` | Clear in-memory state; show re-login modal if the user was mid-form (preserve draft), else redirect to `/login?next=`. |
| 403 `CSRF_FAILED` | Refresh via `AUTH-03` once and retry **once**; else show error. |
| Window focus | Re-fetch `AUTH-03` (throttled 60 s): detects disabled user/role change. |
| Logout | `AUTH-02`, clear caches and local drafts containing PII. |
| Multi-tab | Broadcast logout via `BroadcastChannel`. |

## 3. Error handling map

| Error | UI |
|---|---|
| Network failure/timeout | "Can't reach the server." + Retry; for saves keep the draft; never claim success |
| 401 | see §2 |
| 403 `FORBIDDEN` | PermissionDenied state/inline message |
| 404 `NOT_FOUND` | Not-found state |
| 409 `VERSION_CONFLICT` | Conflict dialog: reload latest, show what changed, re-apply user's edit manually |
| 409 domain codes (`ALLOCATION_EXCEEDS_BALANCE`, `INVOICE_VOID`, `PREVIEW_STALE`, …) | Map to specific friendly copy in a catalogue keyed by `error.code`; unknown codes show `error.message` |
| 422 `VALIDATION_ERROR` | Map `details[].field` (dot path) to form fields; unmapped → form-level alert |
| 429 | "Too many requests, try again in N s" using `Retry-After` |
| 5xx | Generic message + requestId; Retry; don't auto-retry non-idempotent calls |

## 4. Idempotency and retries

For every endpoint marked **Idem**: generate a UUID when the user **opens** the dialog/form (not on each click), send it as `Idempotency-Key`, **reuse it** on any retry of the same intent (network error, re-login), and discard it after success or when the user edits the payload (new intent ⇒ new key). Replays return the original result (`Idempotent-Replay: true`) — treat as success. Never auto-retry money endpoints without the same key. Disable the submit button while pending (double-click guard) — the key is the safety net, not the only guard.

## 5. Pagination, sorting, filtering

Keep `page`, `pageSize`, `sort`, and filters in the URL query string; map 1:1 to API params. Use `meta.totalPages`. Debounce search (300 ms, min 2 chars). On filter change reset `page=1`. Keep previous page data while fetching (no flash). Don't fetch all pages to filter client-side.

## 6. Money, dates, phones (shared helpers; unit-tested)

| Helper | Spec |
|---|---|
| `parseMoneyInput(text) → minor \| error` | Strip thousands separators/`Rs`/`LKR`; accept `^\d{1,9}(\.\d{1,2})?$`; compute with string/integer arithmetic (**no `parseFloat`, no `×100` on floats**); reject > cap; enforce whole rupees when settings say so (settings from `SET-01/02` or inline hint) |
| `formatMoney(minor, {style}) ` | `Rs. 4,000` / `Rs. 4,000.50` (UI), `LKR 4,000.00` (documents/exports); negative with minus; tests for 0, 1, 99, 100, 123456789 |
| `formatDate/Time(iso, tz)` | Use `Intl.DateTimeFormat` with `Me.academy.timezone`; never the device zone; show tz abbreviation in tooltips |
| `todayInAcademyTz()` | for default dates ("today") — not `new Date().toISOString()` |
| `normalizePhone(text)` | Display-only preview of E.164 (default region LK); server remains authoritative |

## 7. Forms and submission pattern

1. Client validation mirrors server rules for UX only; **server errors always win**.
2. Submit: disable controls → call → on success invalidate related queries and navigate/toast → on `422` map errors and focus first invalid field → on other errors keep data.
3. Updates carry `version` from the last fetch; after success replace local data from the response.
4. Dangerous actions use ConfirmDialog/ReasonDialog; reason text sent exactly as typed (trimmed).
5. Unsaved-changes guard on route change.

## 8. Caching and invalidation

Use a query cache (e.g., TanStack Query/SWR). Keys include endpoint ID + params. Defaults: staleTime 30 s for lists, 5 min for reference data (age groups, payment methods, settings), `0` for dashboards on focus, never cache `/auth/me` beyond 60 s. Invalidate: payment mutations → `payments`, `invoices`, `players/{id}/balance`, `guardians/{id}/balance`, `dashboard`; invoice mutations → `invoices`, `dashboard`, `messages`; attendance saves → `sessions`, `session attendance`, `dashboard`. Never cache authenticated responses in a shared/CDN cache (API sends `Cache-Control: no-store`/`private`).

## 9. Files, PDFs, exports

- **Uploads (`PRF-01`, `SET-03`):** client pre-checks type/size for UX; send `multipart/form-data`; show progress; on 413/415 show the server message; never trust the filename.
- **Proof/PDF viewing:** call the endpoint on click; open returned signed URL in a new tab (`rel="noopener noreferrer"`) — don't store signed URLs. `INV-06/RCT-02` stream: fetch as blob with credentials and open via object URL, or navigate with `target=_blank` to the API URL (cookie auth) — pick one and use it consistently. `409 PDF_NOT_READY` → poll every 2 s up to 20 s.
- **CSV exports (`RPT-02`):** trigger download via authenticated request; handle 429.

## 10. Attendance draft/offline behaviour

Persist unsaved attendance (`sessionId`, selections, notes, `Idempotency-Key`) in `localStorage` for 24 h (non-sensitive: player ids/status only; cleared at logout). On network failure keep draft + show "Not saved — Retry". On reload offer "Restore unsaved attendance". No background sync in v1.

## 11. Developing before the backend exists

Use **MSW** (or equivalent) handlers fed by [MOCK_DATA](../engineering/MOCK_DATA.md); handlers must return the exact contract shapes and error format, including `VERSION_CONFLICT`, `PREVIEW_STALE`, `ALLOCATION_EXCEEDS_BALANCE`, `RATE_LIMITED`. Switch to the real API via env flag; run the contract test suite against both. When the real backend differs from the contract, **report it** (HANDOFF) instead of adapting silently.
