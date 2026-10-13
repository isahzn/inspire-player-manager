# API_CONTRACTS

> **Status:** Draft v1 (planned) · **Owner:** Claude (spec) → Freebuff (implements) → frontend (consumes) · **Updated:** 2026-10-11
> **Depends on:** [DATABASE](DATABASE.md), [AUTH_AND_PERMISSIONS](AUTH_AND_PERMISSIONS.md), [BILLING_ENGINE](BILLING_ENGINE.md) · **Source of truth for:** endpoints, payloads, errors, pagination, idempotency.

> **Contract ownership rule ([ADR-009](../engineering/DECISIONS.md#adr-009)):** until milestone **M1 exits**, *this file* is authoritative. At M1 exit Freebuff commits `api/openapi.yaml` (OpenAPI 3.1) generated from this spec and reviewed by the frontend dev; from then on **`openapi.yaml` is authoritative** and this file becomes a human summary carrying a banner linking to it. CI validates: the running server's responses against the spec, and the frontend's generated types against the spec. Neither side may add an endpoint or field that is not in the authoritative file.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` (all examples omit it). Public/hook routes: `/api/v1/public/*`, `/api/v1/webhooks/*`. |
| Format | JSON, UTF-8, **camelCase**. `Content-Type: application/json` except uploads (`multipart/form-data`) and PDF/CSV downloads. |
| Ids | UUID strings. Business dates `YYYY-MM-DD` (academy-local). Instants ISO-8601 UTC `2026-11-01T02:00:00Z`. |
| Money | **integer minor units** named `*Minor` (`totalMinor: 400000` = LKR 4,000.00). Always `currency: "LKR"` on invoice/payment objects. Never decimals/strings. |
| Auth | Cookie session + `X-CSRF-Token` on non-GET ([AUTH](AUTH_AND_PERMISSIONS.md)). Unauthenticated ⇒ 401. |
| Pagination | `?page=1&pageSize=25` (max 100) → `{ data: T[], meta: { page, pageSize, total, totalPages } }`. Unpaginated small lists (age groups, payment methods) return `{ data: T[] }`. |
| Sorting | `?sort=-dueDate,fullName` (`-` = desc). Allowed fields listed per endpoint; unknown ⇒ 422 `INVALID_SORT`. Stable tiebreak by `id`. |
| Filtering | Named query params per endpoint. Date ranges: `from`/`to` inclusive business dates. Free text `q` (min 2 chars). |
| Concurrency | Mutable resources expose `version`; updates send `version`; mismatch ⇒ 409 `VERSION_CONFLICT`. |
| Idempotency | Header `Idempotency-Key: <uuid>` **required** (400 `IDEMPOTENCY_KEY_REQUIRED`) where marked **Idem**. 72 h retention. Replays return the original status/body plus header `Idempotent-Replay: true`. |
| Request id | Every response has `X-Request-Id`; echoed in errors. |
| Versioning | URL major version. Additive changes (new optional fields/endpoints) are non-breaking: clients **must ignore unknown fields**. Breaking changes ⇒ `/api/v2` with ≥ 90 days overlap and `Deprecation`/`Sunset` headers on v1; process in [CHANGE_MANAGEMENT](../engineering/CHANGE_MANAGEMENT.md). |
| Rate limits | login 10/min/IP + 5 failures/account; public invoice 30/min/IP; exports 10/h/user; others 300/min/user. 429 `RATE_LIMITED` with `Retry-After`. |

### 1.1 Error format (all non-2xx)
```ts
type ApiError = { error: {
  code: string;                 // stable machine code, UPPER_SNAKE
  message: string;              // safe, human-readable, English
  details?: { field?: string; issue: string; meta?: Record<string, unknown> }[];
  requestId: string;
}}
```
| HTTP | Codes |
|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `MALFORMED_JSON` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED` |
| 403 | `FORBIDDEN`, `CSRF_FAILED`, `ACCOUNT_DISABLED`, `ACCOUNT_LOCKED` |
| 404 | `NOT_FOUND` (also used for out-of-scope coach resources) |
| 409 | `VERSION_CONFLICT`, `DUPLICATE_SUSPECTED`, `PREVIEW_STALE`, `ALREADY_INVOICED`, `ALLOCATION_EXCEEDS_BALANCE`, `ALLOCATION_EXCEEDS_PAYMENT`, `INVOICE_VOID`, `INVOICE_HAS_ALLOCATIONS`, `PAYMENT_NOT_CONFIRMED`, `PAYMENT_DUPLICATE_REFERENCE`, `INVALID_STATE_TRANSITION`, `LAST_OWNER`, `AGE_GROUP_HAS_ACTIVE_PLAYERS`, `FEE_OVERLAP`, `SESSION_DUPLICATE`, `ALREADY_CHECKED_IN`, `NO_OPEN_CHECK_IN`, `MESSAGE_NOT_RETRYABLE` |
| 413/415 | `FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE` |
| 422 | `VALIDATION_ERROR` (with `details[]`), `INVALID_SORT`, `IDEMPOTENCY_KEY_REUSED`, `PLAYER_NOT_ON_ROSTER`, `ATTENDANCE_WINDOW_CLOSED`, `CHECKIN_WINDOW_CLOSED`, `REASON_REQUIRED` |
| 429 | `RATE_LIMITED` |
| 503 | `DEPENDENCY_UNAVAILABLE` (e.g. storage) |
| 500 | `INTERNAL_ERROR` (no internals leaked) |

## 2. Shared types (TypeScript-style, normative)

```ts
type Id = string; type DateStr = string; type Instant = string; type Minor = number;
type Role = 'owner' | 'coach';
type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } };

type User = { id: Id; username: string /* login identifier; case-insensitive UQ; immutable (ADR-018) */; fullName: string; phone?: string; role: Role;
  status: 'invited'|'active'|'disabled'; totpEnabled: boolean; lastLoginAt?: Instant };
type Me = { user: User; csrfToken: string; academy: { name: string; timezone: string; logoUrl?: string };
  permissions: string[]; assignedGroupIds?: Id[] /* coach */ };

type AgeGroup = { id: Id; name: string; minAge?: number; maxAge?: number; sortOrder: number;
  archivedAt?: Instant; currentFeeMinor?: Minor /* owner only */; activePlayerCount?: number };
type GroupFee = { id: Id; ageGroupId: Id; amountMinor: Minor; effectiveFrom: DateStr; effectiveTo?: DateStr };

type Guardian = { id: Id; fullName: string; phone: string /* E.164 */; relationship?: string;
  whatsappConsent: 'unknown'|'granted'|'revoked'; consentRecordedAt?: Instant; consentSource?: string; optedOutAt?: Instant };
type PlayerGuardianLink = { guardian: Guardian; isPrimary: boolean; receivesInvoices: boolean };
type Player = { id: Id; registrationNo: string; fullName: string; dateOfBirth?: DateStr; ageOnReference?: number;
  registrationDate: DateStr; status: 'active'|'inactive'|'withdrawn'; statusEffectiveDate: DateStr; statusReason?: string;
  currentGroup?: { id: Id; name: string; since: DateStr }; guardians: PlayerGuardianLink[];
  notes?: string; coachNotes?: string; billingAnchorDate: DateStr; outstandingMinor?: Minor; version: number };
type PlayerCoachView = { id: Id; registrationNo: string; fullName: string; age?: number; status: Player['status'];
  group: { id: Id; name: string }; coachNotes?: string; primaryGuardian?: { fullName: string; phone: string } /* only if setting */ };
type GroupHistoryEntry = { id: Id; ageGroup: { id: Id; name: string }; effectiveFrom: DateStr; effectiveTo?: DateStr; reason?: string; changedBy: { id: Id; fullName: string } };

type InvoiceItem = { id: Id; lineNo: number; itemType: 'fee'|'adjustment'; description: string; quantity: number; unitAmountMinor: Minor; amountMinor: Minor; reason?: string };
type Invoice = { id: Id; invoiceNumber: string; kind: 'periodic'|'manual';
  status: 'issued'|'partially_paid'|'paid'|'void'; isOverdue: boolean; daysOverdue: number;
  player: { id: Id; fullName: string; registrationNo: string }; guardian?: { id: Id; fullName: string };
  ageGroup: { id: Id; name: string }; periodStart?: DateStr; periodEnd?: DateStr; issueDate: DateStr; dueDate: DateStr;
  currency: 'LKR'; subtotalMinor: Minor; adjustmentsMinor: Minor; totalMinor: Minor; paidMinor: Minor; balanceMinor: Minor;
  items?: InvoiceItem[]; allocations?: Allocation[]; hasPdf: boolean; voidedAt?: Instant; voidReason?: string; version: number };
type PaymentMethod = { code: string; label: string; requiresReference: boolean; isActive: boolean };
type Allocation = { id: Id; paymentId: Id; invoice: { id: Id; invoiceNumber: string }; amountMinor: Minor; allocatedAt: Instant; reversedAt?: Instant };
type Payment = { id: Id; amountMinor: Minor; currency: 'LKR'; method: PaymentMethod; reference?: string; receivedAt: Instant;
  payer?: { guardianId?: Id; name: string }; status: 'pending'|'confirmed'|'rejected'|'reversed';
  allocatedMinor: Minor; unallocatedMinor: Minor; allocations?: Allocation[]; proofs?: ProofMeta[]; receipt?: { id: Id; receiptNumber: string };
  notes?: string; rejectReason?: string; reverseReason?: string;
  proofVerification?: { status: 'none'|'passed'|'warned'|'failed'|'unverifiable'; checkedAt?: Instant }; version: number };
type ProofMeta = { fileId: Id; originalName?: string; mimeType: string; sizeBytes: number; uploadedAt: Instant; uploadedBy: { id: Id; fullName: string };
  docKind: 'bank_receipt_pdf' | 'bank_receipt_image' | 'other'; verification?: ProofVerification };
type ProofFinding = { code: string; level: 1|2|3; result: 'pass'|'warn'|'fail'|'unknown'; detail: string; meta?: Record<string, unknown> };
type ProofExtract = { bankName?: string; documentType?: string; reference?: string; transactionAt?: Instant; amountMinor?: Minor; currency?: string;
  payerName?: string; payerAccountMasked?: string; beneficiaryName?: string; beneficiaryAccountMasked?: string; channel?: string; status?: string; remarks?: string };
// VERIFY (OPEN-023): no bank receipt layout is assumed. The parser is per-bank and its version is stored with each result.
type ProofVerification = { docKind: ProofMeta['docKind']; status: 'not_run'|'checked'|'unverifiable'|'failed'; findings: ProofFinding[];
  extracted?: ProofExtract; parserVersion?: string; checkedAt?: Instant };

type TrainingSchedule = { id: Id; ageGroup: { id: Id; name: string }; weekday: 1|2|3|4|5|6|7; startTime: string /* HH:mm */; endTime: string; venue?: string; validFrom: DateStr; validTo?: DateStr; isActive: boolean };
type Session = { id: Id; ageGroup: { id: Id; name: string }; sessionDate: DateStr; startsAt: Instant; endsAt: Instant; venue?: string;
  status: 'scheduled'|'completed'|'cancelled'; cancelReason?: string; leadCoach?: { id: Id; fullName: string };
  attendanceSummary?: { present: number; absent: number; late: number; excused: number; unmarked: number }; version: number };
type AttendanceStatus = 'present'|'absent'|'late'|'excused';
type RosterRow = { player: { id: Id; fullName: string; registrationNo: string }; record?: { status: AttendanceStatus; note?: string; markedAt: Instant; markedBy: string; version: number } };
type CoachAttendance = { id: Id; coach: { id: Id; fullName: string }; session: { id: Id; ageGroupName: string; startsAt: Instant };
  checkInAt: Instant; checkOutAt?: Instant; enteredBy: 'self'|'owner'; corrected: boolean; checkInNote?: string; version: number };

type MessageJob = { id: Id; kind: 'invoice_delivery'|'reminder_pre_due'|'reminder_overdue';
  status: 'queued'|'sending'|'sent'|'failed'|'dead'|'needs_review'|'cancelled'|'skipped'; skipReason?: string;
  deliveryState: 'unknown'|'server_accepted'|'device_delivered'|'read'|'provider_error';
  invoice: { id: Id; invoiceNumber: string }; player: { id: Id; fullName: string }; guardian: { id: Id; fullName: string; phoneMasked: string };
  scheduledFor: Instant; nextAttemptAt?: Instant; attempts: number; maxAttempts: number; sentAt?: Instant;
  lastError?: { code: string; message: string }; manualFallback?: { at: Instant; by: string; note?: string };
  renderedBody?: string; events?: { eventType: string; at: Instant; providerAck?: number }[] };
// VERIFY (spike S1 — [OPENWA_INTEGRATION](OPENWA_INTEGRATION.md) §2 O18): OpenWA's own session
// lifecycle status strings are NOT confirmed. This union is OUR normalized label set (what the API
// exposes), deliberately provider-neutral so it does not reuse any previous provider's strings.
// The backend maps the provider's status onto one of these and MUST map anything unrecognized to
// 'unknown'. Do not treat these strings as OpenWA's values.
type SessionStatusLabel = 'connected'|'awaiting_qr'|'starting'|'stopped'|'failed'|'unknown';
type OwnerDashboard = { range: { from: DateStr; to: DateStr };
  players: { active: number; inactive: number; withdrawn: number; byGroup: { ageGroupId: Id; name: string; count: number }[] };
  coachTime: { checkedInNow: { coach: { id: Id; fullName: string }; session: { id: Id; ageGroupName: string; startsAt: Instant }; checkInAt: Instant; elapsedMinutes: number }[];
    todayMinutes: number; weekMinutes: number; openNeedingCorrection: number };
  sessions: { today: Session[]; next7Days: Session[]; todayAttendance: { present: number; absent: number; late: number; excused: number; unmarked: number } };
  money: { invoicedMinor: Minor; invoicesIssuedCount: number; collectedMinor: Minor /* confirmed payments received in range */;
    outstandingMinor: Minor; overdueMinor: Minor; overdueCount: number; dueSoon: { days: 7; count: number; totalMinor: Minor }; creditHeldMinor: Minor };
  messaging: { automationEnabled: boolean; automations: { invoiceDelivery: boolean; reminderPreDue: boolean; reminderOverdue: boolean; proofCheck: boolean }; sessionStatus: SessionStatusLabel; failed24h: number; dead: number; needsReview: number };
  alerts: { code: string; severity: 'info'|'warning'|'critical'; message: string; link?: string }[] };
type AuditEntry = { id: number; occurredAt: Instant; actor?: { id: Id; fullName: string; role: Role }; action: string; entityType: string; entityId: Id; reason?: string; before?: unknown; after?: unknown; requestId: string };
```

## 3. Endpoints

**Legend:** *Auth*: `—` public · `U` any logged-in user · `O` owner · `C*` coach, scoped to assigned groups (owners also allowed unless stated). **Idem** = `Idempotency-Key` required. **Audit** = writes `audit_logs`. All `O`/`C*` rows imply 401 if not logged in.

### 3.1 Auth and users
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| AUTH-01 | `POST /auth/login` | — | `{username,password,totpCode?}` → `Me` (+`Set-Cookie`) | 401 `INVALID_CREDENTIALS`, 403 `ACCOUNT_LOCKED`; audit login ok/fail |
| AUTH-02 | `POST /auth/logout` | U | — → 204 | revokes current session |
| AUTH-03 | `GET /auth/me` | U | → `Me` | refreshes CSRF token |
| AUTH-04 | `POST /auth/change-password` | U | `{currentPassword,newPassword}` → 204 | revokes other sessions; audit |
| AUTH-05 | `POST /auth/accept-invite` | — | `{token,password}` → `Me` | single-use; rate-limited |
| AUTH-06 | `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | U | own sessions list / revoke | |
| AUTH-07 | `POST /auth/totp/enroll` → `{secretUri}` · `POST /auth/totp/confirm {code}` → 204 · `POST /auth/totp/disable {password}` | U (owner) | | audit |
| USR-01 | `GET /users` | O | `?role,status,q` → `Page<User>` | sort: `fullName,createdAt` |
| USR-02 | `POST /users` | O | `{username,fullName,phone?,role}` → `{user, inviteUrl, inviteExpiresAt}` | audit; invite URL shown once |
| USR-03 | `GET/PATCH /users/{id}` | O | PATCH `{fullName?,phone?,role?}` | `LAST_OWNER` guard |
| USR-04 | `POST /users/{id}/disable` · `/enable` | O | `{reason?}` → `User` | disable revokes sessions; `LAST_OWNER` |
| USR-05 | `POST /users/{id}/reset-password` | O | → `{inviteUrl, inviteExpiresAt}` | audit; revokes sessions |

### 3.2 Settings
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| SET-01 | `GET/PATCH /settings/academy` | O | name, contact, `paymentInstructions`, `timezone`, age rule (`ageReferenceRule`,`ageReferenceMonthDay`), `coachCanSeeGuardianPhone`, `attendanceCoachEditWindowHours`, `coachCheckinOpensMinutesBefore`, `coachCheckinClosesMinutesAfterEnd`, `invoiceLinkTtlDays` | audit before/after |
| SET-02 | `GET/PATCH /settings/billing` | O | `billingFrequency`,`billingPeriodMode`,`weekStartDay`,`invoiceIssueTiming`,`dueRuleType`,`dueRuleValue` | audit; response includes `effectNote: "Applies to invoices issued after now"` |
| SET-03 | `POST /settings/logo` (multipart `file`: PNG/JPEG/SVG≤1 MB) | O | → `{logoUrl}` | |
| SET-04 | `GET/POST /settings/payment-methods` · `PATCH /settings/payment-methods/{code}` | O | `PaymentMethod` | codes immutable; deactivate instead of delete |
| SET-05 | `GET/POST /settings/reminder-rules` · `PATCH/DELETE /settings/reminder-rules/{id}` | O | `{kind,offsetDays,isActive}` | UQ `(kind,offsetDays)` |
| SET-07 | `GET/PATCH /settings/messaging` | O | `sendWindowStart`,`sendWindowEnd`,`invoiceMode:'link'|'attachment_and_link'`,`pacingMinSeconds`,`pacingMaxSeconds`,`maxPerHour`,`optOutKeywords[]` | the **master** pause/resume is MSG-07; **per-automation** switches are SET-08 (CR-003); `attachment_and_link` rejected (422) until a passing spike-S1 media test has confirmed document sending on the deployed engine (no paid tier is involved — OpenWA is MIT with no feature gates) |
| SET-06 | `GET /settings/message-templates` · `PUT /settings/message-templates/{key}` | O | `{body}`; response includes `preview` rendered with sample data | unknown `{{vars}}` ⇒ 422 |
| SET-08 | `GET/PATCH /settings/automations` | O | `{invoiceDelivery, reminderPreDue, reminderOverdue, proofCheck}` (booleans, all default **false**) → same object + `masterPaused` (read-only mirror of `messaging_automation_enabled`) | per-automation switches ([ADR-019](../engineering/DECISIONS.md#adr-019), CR-003). Takes effect immediately: disabling stops new enqueues **and** cancels that kind's not-yet-sent jobs (`cancelled` + `skipReason:'AUTOMATION_DISABLED'`); **re-enabling never back-fills** missed sends; every toggle audited. `proofCheck` runs the deterministic L1/L2 bank-receipt checks (extraction + cross-check, [PAYMENT_VERIFICATION](PAYMENT_VERIFICATION.md)) **when a proof is uploaded**; an explicit re-check is always allowed (`PRF-04`) and turning the switch off never confirms or changes a payment ([ADR-020](../engineering/DECISIONS.md#adr-020), [ADR-021](../engineering/DECISIONS.md#adr-021)) |

### 3.3 Age groups, fees, coaches
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| GRP-01 | `GET /age-groups` | C* | `?includeArchived` → `{data: AgeGroup[]}` | coach: assigned only, no fee fields |
| GRP-02 | `POST /age-groups` | O | `{name,minAge?,maxAge?,sortOrder?}` → `AgeGroup` | audit |
| GRP-03 | `GET /age-groups/{id}` · `PATCH` | C*(GET) / O | | |
| GRP-04 | `POST /age-groups/{id}/archive` · `/unarchive` | O | → `AgeGroup` | 409 `AGE_GROUP_HAS_ACTIVE_PLAYERS` |
| GRP-05 | `GET /age-groups/suggest?dateOfBirth=` | O | → `{referenceDate, ageOnReference, suggestions:[{ageGroupId,name}]}` | suggestion only |
| FEE-01 | `GET /age-groups/{id}/fees` | O | → `{data: GroupFee[]}` | |
| FEE-02 | `POST /age-groups/{id}/fees` | O Idem | `{amountMinor,effectiveFrom}` → `GroupFee` | closes previous row; `effectiveFrom` ≥ today unless owner confirms past date (`allowPast:true`); never alters issued invoices; audit |
| CCH-01 | `GET /coaches` | O | `?q` → `Page<{user:User, groups:{id,name}[]}>` | coaches are users with role `coach` |
| CCH-02 | `GET /coach-assignments` | O | `?coachUserId,ageGroupId,activeOn` | |
| CCH-03 | `POST /coach-assignments` | O | `{coachUserId,ageGroupId,assignedFrom}` → assignment | overlap ⇒ 409 |
| CCH-04 | `POST /coach-assignments/{id}/end` | O | `{assignedTo}` | audit |
| CCH-05 | `GET /me/groups` | C* | → `{data:{id,name,playerCount}[]}` | |

### 3.4 Players and guardians
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| PLY-01 | `GET /players` | C* | `?q,status,ageGroupId,hasOutstanding(O),page,pageSize,sort` → `Page<Player>` (owner) / `Page<PlayerCoachView>` (coach) | sort: `fullName,registrationDate,registrationNo`. Default `status=active` |
| PLY-02 | `POST /players` | O | `PlayerCreate` → `Player` 201 | below |
| PLY-03 | `GET /players/{id}` | C* | → `Player`/`PlayerCoachView` | out-of-scope coach ⇒ 404 |
| PLY-04 | `PATCH /players/{id}` | O | `{fullName?,dateOfBirth?,registrationDate?,notes?,coachNotes?,billingAnchorDate?,version}` | anchor change blocked once invoiced |
| PLY-05 | `POST /players/{id}/status` | O | `{status,effectiveDate,reason?,stopReminders?,version}` | withdrawal: `stopReminders` default true |
| PLY-06 | `POST /players/{id}/transfer` | O | `{ageGroupId,effectiveFrom,reason,version}` → `Player` | history preserved |
| PLY-07 | `GET /players/{id}/group-history` | O | → `{data: GroupHistoryEntry[]}` | |
| PLY-08 | `POST /players/check-duplicates` | O | `{fullName,dateOfBirth?,guardianPhones?}` → `{matches:[{player,reason,score}]}` | advisory |
| PLY-09 | `GET /players/{id}/invoices` | O | `?status` → `Page<Invoice>` | |
| PLY-10 | `GET /players/{id}/attendance` | C* | `?from,to` → `{summary, data:{sessionId,sessionDate,status,note}[]}` | |
| PLY-11 | `GET /players/{id}/balance` | O | → `{outstandingMinor, overdueMinor, creditMinor}` | |
```ts
type PlayerCreate = { fullName: string; dateOfBirth?: DateStr; registrationDate: DateStr; ageGroupId?: Id; notes?: string; coachNotes?: string;
  guardians: ({ guardianId: Id } | { fullName: string; phone: string; relationship?: string; whatsappConsent?: { status: 'granted'|'unknown'; source: string } })[] & { isPrimary: boolean; receivesInvoices: boolean }[]; // ≥1, exactly one primary
  acknowledgeDuplicates?: boolean };
```
`PLY-02` returns 409 `DUPLICATE_SUSPECTED` (`details[].meta.matches`) unless `acknowledgeDuplicates=true`. Validation: `fullName` 2–120; DOB not future, age 3–25 (warn outside); `registrationDate` ≤ today+30 d; phone normalized to E.164 (LK default).

| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| GDN-01 | `GET /guardians` | O | `?q,page` → `Page<Guardian & {players:{id,fullName}[]}>` | |
| GDN-02 | `PATCH /guardians/{id}` | O | `{fullName?,phone?,relationship?}` | audit (masked) |
| GDN-03 | `POST /players/{id}/guardians` | O | `{guardianId}` or new guardian + `{isPrimary,receivesInvoices}` | |
| GDN-04 | `PATCH/DELETE /players/{id}/guardians/{guardianId}` | O | `{isPrimary?,receivesInvoices?}` | cannot remove the last guardian |
| GDN-05 | `POST /guardians/{id}/consent` | O | `{status:'granted'|'revoked'|'unknown', source, note?}` → `Guardian` | `revoked` ⇒ cancels queued messages; audit |
| GDN-06 | `GET /guardians/{id}/balance` | O | → `{outstandingMinor, overdueMinor, creditMinor, openInvoices: Invoice[]}` | |

### 3.5 Sessions and attendance
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| SCH-01 | `GET /training-schedules` · `POST` · `PATCH /{id}` · `POST /{id}/deactivate` | O | `TrainingSchedule` | |
| SCH-02 | `POST /training-schedules/{id}/generate` | O Idem | `{from,to}` → `{created, skipped}` | idempotent per UQ; max 90 days |
| SES-01 | `GET /sessions` | C* | `?from,to,ageGroupId,status` → `Page<Session>` | default: today..+14 d; sort `startsAt` |
| SES-02 | `POST /sessions` | O | `{ageGroupId,startsAt,endsAt,venue?,leadCoachUserId?}` | `SESSION_DUPLICATE` |
| SES-03 | `GET /sessions/{id}` · `PATCH` | C*(GET) / O | | |
| SES-04 | `POST /sessions/{id}/cancel` | O | `{reason}` | audit |
| ATT-01 | `GET /sessions/{id}/attendance` | C* | → `{session, roster: RosterRow[], editableUntil: Instant, canEdit: boolean}` | roster = players on roster at `sessionDate` |
| ATT-02 | `PUT /sessions/{id}/attendance` | C* Idem | `{records:[{playerId,status,note?,version?,reason?}]}` → `{saved:n, roster: RosterRow[]}` | bulk upsert, all-or-nothing; `reason` required when changing an existing record; 422 `ATTENDANCE_WINDOW_CLOSED` for coach outside window; audit per changed record |
| ATT-03 | `PATCH /sessions/{id}/attendance/{playerId}` | C* | `{status?,note?,reason,version}` → `RosterRow` | single correction |
| CAT-01 | `POST /coach-attendance/check-in` | C* | `{sessionId,note?}` → `CoachAttendance` | `ALREADY_CHECKED_IN`; `CHECKIN_WINDOW_CLOSED` |
| CAT-02 | `POST /coach-attendance/check-out` | C* | `{sessionId}` → `CoachAttendance` | `NO_OPEN_CHECK_IN` |
| CAT-03 | `GET /coach-attendance` | C* | `?from,to,coachUserId(O)` → `Page<CoachAttendance>` | coach: own only |
| CAT-04 | `POST /coach-attendance` | O | `{coachUserId,sessionId,checkInAt,checkOutAt?,reason}` | owner manual entry; audit |
| CAT-05 | `PATCH /coach-attendance/{id}` | O | `{checkInAt?,checkOutAt?,reason,version}` | sets `corrected=true`; audit |

### 3.6 Billing, invoices, payments
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| BIL-01 | `POST /billing/previews` | O | `{targetDate,ageGroupIds?,playerIds?}` → `BillingPreview` | read-only; nothing stored |
| BIL-02 | `POST /billing/runs` | O Idem | `{targetDate,previewHash,ageGroupIds?,playerIds?,adjustments?:[{playerId,amountMinor(<0),reason}],queueWhatsApp?:boolean}` → 201 `BillingRun` | 409 `PREVIEW_STALE`; one tx per run (T1); audit |
| BIL-03 | `GET /billing/runs` · `GET /billing/runs/{id}` | O | `Page<BillingRun>` | |
| INV-01 | `GET /invoices` | O | `?status,overdue(bool),playerId,guardianId,ageGroupId,issueFrom,issueTo,dueFrom,dueTo,q,page,pageSize,sort` → `Page<Invoice>` (no items) | sort: `dueDate,issueDate,invoiceNumber,balanceMinor,playerName` |
| INV-02 | `GET /invoices/{id}` | O | → `Invoice` (items, allocations) | |
| INV-03 | `POST /invoices` | O Idem | `{playerId,description,amountMinor,dueDate,guardianId?}` → `Invoice` | manual one-off (`kind=manual`); audit |
| INV-04 | `POST /invoices/{id}/void` | O Idem | `{reason,releaseAllocations?:boolean,allowReissue?:boolean,version}` → `Invoice` | 409 `INVOICE_HAS_ALLOCATIONS` unless release; T5 |
| INV-05 | `POST /invoices/{id}/adjustments` | O Idem | `{amountMinor(<0),reason,version}` → `Invoice` | `|amount| ≤ balance` |
| INV-06 | `GET /invoices/{id}/pdf` | O | → `200 application/pdf` stream (or `409 PDF_NOT_READY` + `Retry-After`) | audited read |
| INV-07 | `POST /invoices/{id}/pdf/regenerate` | O | → 202 | rebuilds from snapshot only |
| INV-08 | `POST /invoices/{id}/send` | O Idem | `{guardianIds?:Id[]}` → `{messageJobs: MessageJob[]}` 202 | enqueue `invoice_delivery`; skipped jobs carry `skipReason` |
| PAY-01 | `GET /payments` | O | `?status,methodCode,guardianId,playerId,from,to,q,hasCredit` → `Page<Payment>` | sort `receivedAt,amountMinor` |
| PAY-02 | `POST /payments` | O Idem | `{amountMinor,methodCode,reference?,receivedAt,payerGuardianId?,payerName?,notes?,status:'confirmed'|'pending',allocations?:[{invoiceId,amountMinor}]}` → 201 `Payment` | `reference` required if method requires; `PAYMENT_DUPLICATE_REFERENCE`; `allocations` with `status:'pending'` ⇒ 409 `PAYMENT_NOT_CONFIRMED` (allocate only after the owner confirms, §11); T2 when confirmed |
| PAY-03 | `GET /payments/{id}` · `PATCH` | O | PATCH `{reference?,notes?,receivedAt?,version}` | amount/method immutable |
| PAY-04 | `POST /payments/{id}/confirm` | O Idem | `{allocations?,version}` → `Payment` | from `pending` only; **never** called by an automation — proof checks are advisory ([ADR-020](../engineering/DECISIONS.md#adr-020)) and the owner's confirm is the only thing that changes a balance |
| PAY-05 | `POST /payments/{id}/reject` | O Idem | `{reason,version}` | from `pending` only |
| PAY-06 | `POST /payments/{id}/allocate` | O Idem | `{allocations:[{invoiceId,amountMinor}],version}` → `Payment` | uses credit; T3 |
| PAY-07 | `POST /payments/{id}/reverse` | O Idem | `{reason,version}` → `Payment` | T4 |
| PAY-08 | `GET /payments/{id}/allocation-suggestion` | O | `?guardianId` → `{suggested:[{invoiceId,amountMinor}], creditMinor}` | oldest due first |
| PRF-01 | `POST /payments/{id}/proofs` | O | multipart `file` (+`note`) → `ProofMeta` 201 | PDF/JPEG/PNG/WebP ≤ 5 MB, ≤ 5 per payment; server sniffs magic bytes. For a `bank_transfer` payment the **bank's PDF e-receipt** is what gets verified; an image is stored as `docKind='bank_receipt_image'` (supporting evidence only) and can never produce a passing check ([PAYMENT_VERIFICATION](PAYMENT_VERIFICATION.md), [ADR-021](../engineering/DECISIONS.md#adr-021)) |
| PRF-02 | `GET /payments/{id}/proofs/{fileId}/download` | O | → `{url, expiresAt}` (signed, ≤ 5 min) or streamed bytes | audited read |
| PRF-03 | `DELETE /payments/{id}/proofs/{fileId}` | O | → 204 | only while payment `pending`; audit |
| PRF-04 | `POST /payments/{id}/proofs/{fileId}/verify` | O | → `ProofVerification` | re-runs L1/L2 extraction + cross-check in the sandbox; audit; a PDF e-receipt that is silent/successful **can never** confirm the payment (advisory — [ADR-021](../engineering/DECISIONS.md#adr-021)). Allowed even when `SET-08.proofCheck` is off: the switch governs automatic checking on upload, not this explicit action |
| RCT-01 | `GET /receipts` | O | `?paymentId,from,to` → `Page<{id,receiptNumber,paymentId,issuedAt,voided}>` | |
| RCT-02 | `GET /receipts/{id}/pdf` · `POST /receipts/{id}/pdf/regenerate` | O | PDF stream / 202 | |
| PUB-01 | `GET /public/invoices/{token}/pdf` | — | → PDF | token validated by hash, expiry, revocation; 404 for all failure kinds; `Cache-Control: no-store`; `Referrer-Policy: no-referrer`; rate-limited; increments `use_count` |

```ts
type BillingPreview = { previewHash: string; targetDate: DateStr; frequency: 'weekly'|'monthly'; mode: 'calendar'|'anchored';
  lines: { playerId: Id; playerName: string; registrationNo: string; ageGroup: { id: Id; name: string }; periodStart: DateStr; periodEnd: DateStr;
    issueDate: DateStr; dueDate: DateStr; feeMinor: Minor; feeId: Id; guardian?: { id: Id; fullName: string }; warnings: string[] }[];
  skipped: { playerId: Id; playerName: string; reason: 'NO_GROUP'|'NO_FEE'|'NOT_ACTIVE'|'ALREADY_INVOICED'|'NOT_YET_REGISTERED' }[];
  totals: { count: number; totalMinor: Minor } };
type BillingRun = { id: Id; runKey: string; status: 'issued'|'partial'|'failed'; targetDate: DateStr; invoicesCreated: number; invoicesSkipped: number; invoiceIds: Id[]; startedAt: Instant; completedAt?: Instant };
```

### 3.7 Messaging (WhatsApp)
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| MSG-01 | `GET /messages` | O | `?status,kind,invoiceId,guardianId,playerId,from,to,page` → `Page<MessageJob>` | sort `scheduledFor,createdAt` |
| MSG-02 | `GET /messages/{id}` | O | → `MessageJob` with `events`, `renderedBody` | |
| MSG-03 | `POST /messages/{id}/retry` | O Idem | → `MessageJob` | only `failed|dead|needs_review`; re-checks consent/invoice state; `MESSAGE_NOT_RETRYABLE` |
| MSG-04 | `POST /messages/{id}/cancel` | O | → `MessageJob` | only `queued|failed` |
| MSG-05 | `POST /messages/{id}/manual-fallback` | O | `{note?}` → `MessageJob` | records "owner sent manually"; stops retries |
| MSG-06 | `GET /messaging/status` | O | → `{automationEnabled, automations:{invoiceDelivery,reminderPreDue,reminderOverdue,proofCheck}, provider:'openwa', session:{status: SessionStatusLabel, checkedAt}, queue:{queued,sending,failedLast24h,dead,needsReview}, lastSentAt?}` | `session.status` values: **VERIFY** — see `SessionStatusLabel` in §2 (OpenWA's lifecycle strings are unconfirmed until spike S1, [OPENWA_INTEGRATION](OPENWA_INTEGRATION.md) §2 O18) |
| MSG-07 | `POST /messaging/pause` · `/resume` | O | `{reason?}` → status | toggles `messaging_automation_enabled`; audit |
| MSG-08 | `POST /messaging/test` | O Idem | `{phone}` → `MessageJob` | to the **owner's own** number only (must equal an owner user phone) |
| WHK-01 | `POST /webhooks/openwa` | HMAC | provider event → 2xx/204 | verify `X-OpenWA-Signature` (`sha256=<hex>`, **HMAC-SHA256** over the exact raw body) with a constant-time compare **before** JSON parsing; 401 on mismatch/malformed/missing; **dedupe on `X-OpenWA-Delivery-Id`** and log `X-OpenWA-Retry-Count`; idempotent; never 5xx on unknown event (log + 204) |

### 3.8 Dashboard, reports, audit, system
| ID | Method & route | Auth | Request → Response | Notes |
|---|---|---|---|---|
| DSH-01 | `GET /dashboard/owner` | O | `?from,to` (default current month) → `OwnerDashboard` | `invoicedMinor` and `collectedMinor` are separate fields; `outstandingMinor`/`overdueMinor` are "as of now" |
| DSH-02 | `GET /dashboard/coach` | C* | → `{todaySessions: Session[], upcoming: Session[], myOpenCheckIn?: CoachAttendance}` | |
| RPT-01 | `GET /reports/{name}` | O | `name ∈ players,attendance-summary,attendance-detail,invoices,payments,outstanding,collections,coach-attendance` + filters → `Page<Row>` + `totals` | filter sets in [PAGE_SPECIFICATIONS](../frontend/PAGE_SPECIFICATIONS.md) §Reports |
| RPT-02 | `GET /reports/{name}/export` | O | same filters → `text/csv; charset=utf-8` (BOM, `Content-Disposition`) | streamed; max 50k rows; formula-injection neutralization; audit with filters; rate-limited |
| AUD-01 | `GET /audit-logs` | O | `?actorUserId,entityType,entityId,action,from,to,page` | sort `-occurredAt` |
| SYS-01 | `GET /health` | — | → `{status:'ok'}` | liveness only; no details |
| SYS-02 | `GET /ready` | — | → 200/503 | DB reachable; used by host health checks |
| SYS-03 | `GET /system/health` | O | → `{db, storage, openwa, queue, scheduler:{lastRunAt}, lastBackup:{at,status}, version}` | |
| IMP-01 | `POST /imports/players/validate` | O | multipart CSV → `{batchId,rowCount,errors[],warnings[],preview[]}` | see [CSV_IMPORT](../engineering/CSV_IMPORT.md) |
| IMP-02 | `POST /imports/players/{batchId}/commit` | O Idem | → `{created,skipped}` | all-or-nothing |

## 4. Side-effect summary

| Endpoint family | Side effects (all after commit unless stated) |
|---|---|
| BIL-02, INV-03 | invoice rows + audit (in tx); enqueue PDF generation; optional enqueue `invoice_delivery` |
| PAY-02/04/06 | allocations, invoice status, receipt row, audit (in tx); enqueue receipt PDF |
| INV-04 | invoice void, allocations released, tokens revoked, queued messages cancelled (in tx) |
| GDN-05 `revoked` | queued/failed jobs for that guardian → `cancelled` |
| MSG-07 pause | worker stops claiming jobs; queued jobs stay queued |

## 5. Contract change checklist
Any change here ⇒ follow [CHANGE_MANAGEMENT](../engineering/CHANGE_MANAGEMENT.md): update DATABASE/AUTH/test matrix/frontend pages/mock data together; bump `docs/engineering/PROJECT_STATUS.md`.
