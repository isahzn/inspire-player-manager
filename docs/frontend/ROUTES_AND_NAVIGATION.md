# ROUTES_AND_NAVIGATION

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) / Hassen (implementation) · **Updated:** 2026-10-11
> **Depends on:** [AUTH_AND_PERMISSIONS](../architecture/AUTH_AND_PERMISSIONS.md), [API_CONTRACTS](../architecture/API_CONTRACTS.md) · **Source of truth for:** URL structure, navigation, role visibility. Page content: [PAGE_SPECIFICATIONS](PAGE_SPECIFICATIONS.md).

Framework-agnostic paths (Next.js App Router suggested). `[id]` = UUID. Hiding a link is cosmetic; **every route also handles 401/403/404 from the API**.

## 1. Route map

| Route | Page | Owner | Coach | Primary API IDs |
|---|---|---|---|---|
| `/login` | Sign in | public | public | AUTH-01 |
| `/accept-invite?token=` | Set password | public | public | AUTH-05 |
| `/forgot-password` | Static help: "Ask an owner to reset your password" | public | public | — |
| `/` | Redirect → `/dashboard` (or `/login`) | ✔ | ✔ | AUTH-03 |
| `/dashboard` | Owner dashboard / Coach "Today" | ✔ (DSH-01) | ✔ (DSH-02) | DSH-01/02 |
| `/players` | Player list | ✔ full | ✔ assigned groups, restricted | PLY-01 |
| `/players/new` | Register player | ✔ | ✖ | PLY-02, PLY-08, GRP-05 |
| `/players/[id]` | Player profile (tabs: Overview · Guardians · Group history · Attendance · Invoices · Messages) | ✔ | ✔ Overview + Attendance only | PLY-03/07/09/10/11, GDN-* |
| `/players/[id]/edit` | Edit player | ✔ | ✖ | PLY-04/05/06 |
| `/age-groups` | Age groups + fees | ✔ | ✔ read, no fees (`/my-groups` preferred) | GRP-01, FEE-01 |
| `/age-groups/[id]` | Group detail: roster, fee history, schedules, coaches | ✔ | ✔ roster only | GRP-03, FEE-01/02 |
| `/coaches` | Coaches & assignments | ✔ | ✖ | CCH-01..04 |
| `/schedules` | Training schedules | ✔ | ✖ | SCH-01/02 |
| `/sessions` | Sessions calendar/list | ✔ all | ✔ assigned | SES-01 |
| `/sessions/[id]` | Session + attendance sheet + coach check-in | ✔ | ✔ assigned | SES-03, ATT-01..03, CAT-01/02 |
| `/coach-attendance` | Coach attendance log & corrections | ✔ all | ✔ own (read) | CAT-03..05 |
| `/billing` | Billing hub (tabs: Invoices · Runs) | ✔ | ✖ | INV-01, BIL-03 |
| `/billing/new` | New billing run (preview → issue) | ✔ | ✖ | BIL-01/02 |
| `/billing/invoices/[id]` | Invoice detail | ✔ | ✖ | INV-02..08 |
| `/billing/invoices/new` | Manual invoice | ✔ | ✖ | INV-03 |
| `/payments` | Payments list (tabs: All · Pending · **Verification** (CR-003, shown when `SET-08.proofCheck` is on) · Credit) | ✔ | ✖ | PAY-01 |
| `/payments/new` | Record payment | ✔ | ✖ | PAY-02/08, PRF-01 |
| `/payments/[id]` | Payment detail: allocations, proofs, receipt | ✔ | ✖ | PAY-03..07, PRF-*, RCT-* |
| `/whatsapp` | Tabs: Status · Messages · Reminders & templates · Settings | ✔ | ✖ | MSG-*, SET-05/06/07 |
| `/whatsapp/messages/[id]` | Message detail & events | ✔ | ✖ | MSG-02..05 |
| `/reports` | Reports index | ✔ | ✖ | RPT-01 |
| `/reports/[name]` | Report with filters + CSV export | ✔ | ✖ | RPT-01/02 |
| `/users` | Users | ✔ | ✖ | USR-* |
| `/settings` | Tabs: Academy · Billing · Payment methods · Branding | ✔ | ✖ | SET-01..04 |
| `/imports/players` | CSV import wizard | ✔ | ✖ | IMP-01/02 |
| `/audit` | Audit history | ✔ | ✖ | AUD-01 |
| `/system` | System health | ✔ | ✖ | SYS-03 |
| `/profile` | My account: password, sessions, TOTP | ✔ | ✔ | AUTH-04/06/07 |
| `/403`, `/404` | Permission denied / not found | ✔ | ✔ | — |

Public (unauthenticated) invoice links are **backend** URLs (`PUB-01`) opened directly by guardians; the frontend does not render them.

## 2. Navigation structure

**Owner** (sidebar groups): Dashboard · People (Players, Age groups, Coaches) · Training (Sessions, Schedules, Coach attendance) · Money (Billing, Payments) · Messaging (WhatsApp) · Reports · Admin (Users, Settings, Imports, Audit, System).
**Coach**: Today (dashboard) · Sessions · My groups · My attendance · Profile.

| Viewport | Owner | Coach |
|---|---|---|
| < 640 px (mobile) | Top bar (logo, search, alert bell) + **bottom tab bar**: Dashboard · Players · Billing · WhatsApp · More (sheet with the rest) | **Bottom tab bar** (large targets): Today · Sessions · Groups · Profile |
| 640–1023 px (tablet) | Collapsible icon rail + top bar | Rail + top bar |
| ≥ 1024 px (desktop) | Persistent left sidebar (grouped) + top bar | Same simplified sidebar |

Global elements: academy logo/name (top-left), **system banner area** (WhatsApp disconnected, backup failure, open coach check-ins), user menu (profile, sign out), global player search (owner; `PLY-01 q`).

## 3. Guards and redirects

| Situation | Behaviour |
|---|---|
| No session / `401` | Redirect to `/login?next=<path>` (same-origin paths only). After login go to `next` or `/dashboard`. |
| Coach opens an owner-only route | Render `/403` (do not call owner APIs). |
| `403` from API | Inline permission-denied state (not a redirect), with "Go to dashboard". |
| `404` on an id (including out-of-scope for coaches) | Not-found state — never reveal that it exists. |
| `SESSION_EXPIRED` mid-action | Preserve unsaved form/attendance draft locally, show re-login modal, retry with the same `Idempotency-Key`. |
| Deep link while logged out | `next` param round-trip. |
| Role change while logged in | `GET /auth/me` on window focus; if role/permissions changed → reload shell. |

Route guard source: `Me.permissions` from `AUTH-03` (not hard-coded roles) so future roles need no navigation rewrite.
