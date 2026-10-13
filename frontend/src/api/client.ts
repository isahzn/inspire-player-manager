// apiClient per docs/frontend/API_INTEGRATION.md §1–§4.
// One module wraps fetch: base URL from env, credentials include, in-memory
// CSRF token (never localStorage), 20 s timeout (60 s uploads/exports).
// Wrapper functions are named after contract endpoint IDs (AUTH-01 → auth01…).

import type {
  AcademyPaymentSettings,
  AcademySettings,
  AgeGroup,
  AuditEntry,
  Automations,
  AutomationsResponse,
  CoachDashboard,
  AgeGroupSuggestion,
  Allocation,
  ApiErrorDetail,
  AttendanceRecordInput,
  AttendanceStatus,
  AuthSession,
  BillingAdjustment,
  BillingPreview,
  BillingRun,
  BillingSettings,
  CoachAssignment,
  CoachAttendance,
  CoachRow,
  CreateUserResponse,
  DuplicateMatch,
  GroupFee,
  GroupHistoryEntry,
  Guardian,
  GuardianBalance,
  GuardianWithPlayers,
  ImportCommitResult,
  ImportValidation,
  Invoice,
  Me,
  MessageJob,
  MessageTemplate,
  MessagingSettings,
  MessagingStatus,
  OwnerDashboard,
  Page,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Player,
  PlayerAttendance,
  PlayerBalance,
  PlayerCreate,
  PlayerListItem,
  PlayerStatus,
  ProofMeta,
  ProofVerification,
  ReceiptSummary,
  ReminderRule,
  ReportName,
  ReportResult,
  RosterRow,
  Session,
  SessionAttendance,
  SessionStatus,
  SystemHealth,
  User,
} from "./types";

// Mock mode uses same-origin URLs so the MSW worker intercepts reliably
// (cross-origin would add CORS/preflight fragility with no server present).
const API_BASE =
  process.env.NEXT_PUBLIC_USE_MOCKS === "true"
    ? ""
    : (process.env.NEXT_PUBLIC_API_BASE_URL ?? "");

// ---------------------------------------------------------------------------
// In-memory CSRF token (module scope — never persisted).
// ---------------------------------------------------------------------------
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}
export function getCsrfToken() {
  return csrfToken;
}

// ---------------------------------------------------------------------------
// Error model: catalogue keyed by error.code; unknown codes surface message.
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  code: string;
  status: number;
  details?: ApiErrorDetail[];
  requestId?: string;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    details?: ApiErrorDetail[];
    requestId?: string;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }

  /** Inline form errors from `details[]` (PAGE_SPEC §0 forms). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details ?? []) {
      if (d.field && d.issue) out[d.field] = d.issue;
    }
    return out;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RequestOpts {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** internal: allow exactly one CSRF refresh + retry */
  retryCsrf?: boolean;
}

async function rawRequest(path: string, opts: RequestOpts = {}) {
  const method = opts.method ?? "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (MUTATING.has(method) && csrfToken) {
      headers["X-CSRF-Token"] = csrfToken;
    }
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });

    // 403 CSRF_FAILED → refresh via AUTH-03 once, retry once (§2).
    if (res.status === 403 && opts.retryCsrf !== false) {
      const probe = await res.clone().json().catch(() => null);
      if (probe?.error?.code === "CSRF_FAILED") {
        const meRes = await fetch(`${API_BASE}/auth/me`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (meRes.ok) {
          const me = (await meRes.json()) as Me;
          setCsrfToken(me.csrfToken);
          return rawRequest(path, { ...opts, retryCsrf: false });
        }
      }
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError({
        code: data?.error?.code ?? `HTTP_${res.status}`,
        message: data?.error?.message ?? "Something went wrong. Please retry.",
        status: res.status,
        details: data?.error?.details,
        requestId: data?.error?.requestId,
      });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError({
        code: "TIMEOUT",
        message: "Can't reach the server.",
        status: 0,
      });
    }
    throw new ApiError({
      code: "NETWORK_ERROR",
      message: "Can't reach the server.",
      status: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function apiRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  return (await rawRequest(path, opts)) as T;
}

/** Query string from defined params only — `?page=1&q=…`. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    sp.set(key, String(value));
  }
  const text = sp.toString();
  return text ? `?${text}` : "";
}

/** `Idempotency-Key` for IDem endpoints (client-generated UUID v4). */
export function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Endpoint wrappers (named by contract ID).
// ---------------------------------------------------------------------------
export function auth01Login(input: {
  username: string;
  password: string;
  totpCode?: string;
}): Promise<Me> {
  return apiRequest<Me>("/auth/login", { method: "POST", body: input });
}

export async function auth02Logout(): Promise<void> {
  await apiRequest("/auth/logout", { method: "POST" });
}

export function auth03Me(): Promise<Me> {
  return apiRequest<Me>("/auth/me");
}

export async function auth04ChangePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await apiRequest("/auth/change-password", { method: "POST", body: input });
}

export function auth05AcceptInvite(input: {
  token: string;
  password: string;
}): Promise<Me> {
  return apiRequest<Me>("/auth/accept-invite", { method: "POST", body: input });
}

export function auth06ListSessions(): Promise<{ data: AuthSession[] }> {
  return apiRequest("/auth/sessions");
}

export async function auth06RevokeSession(id: string): Promise<void> {
  await apiRequest(`/auth/sessions/${id}`, { method: "DELETE" });
}

export function auth07TotpEnroll(): Promise<{ secretUri: string }> {
  return apiRequest("/auth/totp/enroll", { method: "POST" });
}

export async function auth07TotpConfirm(code: string): Promise<void> {
  await apiRequest("/auth/totp/confirm", { method: "POST", body: { code } });
}

export async function auth07TotpDisable(password: string): Promise<void> {
  await apiRequest("/auth/totp/disable", { method: "POST", body: { password } });
}

// --- USR-02 (used by the coaches page invite dialog) ------------------------
export function usr02CreateUser(input: {
  username: string;
  fullName: string;
  phone?: string;
  role: "owner" | "coach";
}): Promise<CreateUserResponse> {
  return apiRequest("/users", {
    method: "POST",
    body: input,
    idempotencyKey: idempotencyKey(),
  });
}

// --- Age groups and fees (GRP-01..05, FEE-01/02) ----------------------------
export function grp01ListAgeGroups(params: {
  includeArchived?: boolean;
} = {}): Promise<{ data: AgeGroup[] }> {
  return apiRequest(`/age-groups${qs({ includeArchived: params.includeArchived })}`);
}

export function grp02CreateAgeGroup(input: {
  name: string;
  minAge?: number;
  maxAge?: number;
  sortOrder?: number;
}): Promise<AgeGroup> {
  return apiRequest("/age-groups", { method: "POST", body: input });
}

export function grp03GetAgeGroup(id: string): Promise<AgeGroup> {
  return apiRequest(`/age-groups/${id}`);
}

export function grp03PatchAgeGroup(
  id: string,
  input: { name?: string; minAge?: number; maxAge?: number; sortOrder?: number }
): Promise<AgeGroup> {
  return apiRequest(`/age-groups/${id}`, { method: "PATCH", body: input });
}

export function grp04ArchiveAgeGroup(id: string, archive: boolean): Promise<AgeGroup> {
  return apiRequest(`/age-groups/${id}/${archive ? "archive" : "unarchive"}`, {
    method: "POST",
  });
}

export function grp05SuggestAgeGroup(dateOfBirth: string): Promise<AgeGroupSuggestion> {
  return apiRequest(`/age-groups/suggest${qs({ dateOfBirth })}`);
}

export function fee01ListFees(ageGroupId: string): Promise<{ data: GroupFee[] }> {
  return apiRequest(`/age-groups/${ageGroupId}/fees`);
}

export function fee02AddFee(
  ageGroupId: string,
  input: { amountMinor: number; effectiveFrom: string; allowPast?: boolean }
): Promise<GroupFee> {
  return apiRequest(`/age-groups/${ageGroupId}/fees`, {
    method: "POST",
    body: input,
    idempotencyKey: idempotencyKey(),
  });
}

// --- Players (PLY-01..11) ---------------------------------------------------
export interface PlayerListParams {
  q?: string;
  status?: PlayerStatus;
  ageGroupId?: string;
  hasOutstanding?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export function ply01ListPlayers(
  params: PlayerListParams = {}
): Promise<Page<PlayerListItem>> {
  return apiRequest(
    `/players${qs({
      q: params.q,
      status: params.status,
      ageGroupId: params.ageGroupId,
      hasOutstanding: params.hasOutstanding ? true : undefined,
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort,
    })}`
  );
}

export function ply02CreatePlayer(input: PlayerCreate): Promise<Player> {
  return apiRequest("/players", {
    method: "POST",
    body: input,
    idempotencyKey: idempotencyKey(),
  });
}

export function ply03GetPlayer(id: string): Promise<PlayerListItem> {
  return apiRequest(`/players/${id}`);
}

export function ply04PatchPlayer(
  id: string,
  input: {
    fullName?: string;
    dateOfBirth?: string;
    registrationDate?: string;
    notes?: string;
    coachNotes?: string;
    billingAnchorDate?: string;
    version: number;
  }
): Promise<Player> {
  return apiRequest(`/players/${id}`, { method: "PATCH", body: input });
}

export function ply05SetPlayerStatus(
  id: string,
  input: {
    status: PlayerStatus;
    effectiveDate: string;
    reason?: string;
    stopReminders?: boolean;
    version: number;
  }
): Promise<Player> {
  return apiRequest(`/players/${id}/status`, { method: "POST", body: input });
}

export function ply06TransferPlayer(
  id: string,
  input: { ageGroupId: string; effectiveFrom: string; reason: string; version: number }
): Promise<Player> {
  return apiRequest(`/players/${id}/transfer`, { method: "POST", body: input });
}

export function ply07PlayerGroupHistory(
  id: string
): Promise<{ data: GroupHistoryEntry[] }> {
  return apiRequest(`/players/${id}/group-history`);
}

export function ply08CheckDuplicates(input: {
  fullName: string;
  dateOfBirth?: string;
  guardianPhones?: string[];
}): Promise<{ matches: DuplicateMatch[] }> {
  return apiRequest("/players/check-duplicates", { method: "POST", body: input });
}

export function ply09PlayerInvoices(
  id: string,
  params: { status?: string } = {}
): Promise<Page<Invoice>> {
  return apiRequest(`/players/${id}/invoices${qs({ status: params.status })}`);
}

export function ply10PlayerAttendance(
  id: string,
  params: { from?: string; to?: string } = {}
): Promise<PlayerAttendance> {
  return apiRequest(`/players/${id}/attendance${qs(params)}`);
}

export function ply11PlayerBalance(id: string): Promise<PlayerBalance> {
  return apiRequest(`/players/${id}/balance`);
}

// --- Guardians (GDN-01..06) -------------------------------------------------
export function gdn01ListGuardians(params: {
  q?: string;
  page?: number;
} = {}): Promise<Page<GuardianWithPlayers>> {
  return apiRequest(`/guardians${qs({ q: params.q, page: params.page })}`);
}

export function gdn02PatchGuardian(
  id: string,
  input: { fullName?: string; phone?: string; relationship?: string }
): Promise<Guardian> {
  return apiRequest(`/guardians/${id}`, { method: "PATCH", body: input });
}

export function gdn03LinkGuardian(
  playerId: string,
  input: { guardianId: string; isPrimary: boolean; receivesInvoices: boolean }
): Promise<Player> {
  return apiRequest(`/players/${playerId}/guardians`, { method: "POST", body: input });
}

export function gdn04PatchLink(
  playerId: string,
  guardianId: string,
  input: { isPrimary?: boolean; receivesInvoices?: boolean }
): Promise<Player> {
  return apiRequest(`/players/${playerId}/guardians/${guardianId}`, {
    method: "PATCH",
    body: input,
  });
}

export async function gdn04RemoveLink(
  playerId: string,
  guardianId: string
): Promise<void> {
  await apiRequest(`/players/${playerId}/guardians/${guardianId}`, { method: "DELETE" });
}

export function gdn05SetConsent(
  guardianId: string,
  input: { status: "granted" | "revoked" | "unknown"; source: string; note?: string }
): Promise<Guardian> {
  return apiRequest(`/guardians/${guardianId}/consent`, { method: "POST", body: input });
}

export function gdn06GuardianBalance(guardianId: string): Promise<GuardianBalance> {
  return apiRequest(`/guardians/${guardianId}/balance`);
}

// --- Invoices (read-only here; the billing slice owns the rest of INV-*) ----
// Added for the Step 3 player-profile invoice link (PLY-09 → INV-02).
export function inv02GetInvoice(id: string): Promise<Invoice> {
  return apiRequest(`/invoices/${id}`);
}

// --- Coaches and assignments (CCH-01..04) ----------------------------------
export function cch01ListCoaches(params: { q?: string } = {}): Promise<Page<CoachRow>> {
  return apiRequest(`/coaches${qs({ q: params.q })}`);
}

export function cch02ListAssignments(params: {
  coachUserId?: string;
  ageGroupId?: string;
  activeOn?: string;
} = {}): Promise<{ data: CoachAssignment[] }> {
  return apiRequest(
    `/coach-assignments${qs({
      coachUserId: params.coachUserId,
      ageGroupId: params.ageGroupId,
      activeOn: params.activeOn,
    })}`
  );
}

export function cch03CreateAssignment(input: {
  coachUserId: string;
  ageGroupId: string;
  assignedFrom: string;
}): Promise<CoachAssignment> {
  return apiRequest("/coach-assignments", { method: "POST", body: input });
}

export function cch04EndAssignment(
  id: string,
  input: { assignedTo: string }
): Promise<CoachAssignment> {
  return apiRequest(`/coach-assignments/${id}/end`, { method: "POST", body: input });
}

// --- CSV import (IMP-01/02) -------------------------------------------------
export async function imp01ValidateImport(file: File): Promise<ImportValidation> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/imports/players/validate`, {
    method: "POST",
    body: form,
    credentials: "include",
    cache: "no-store",
    headers: csrfToken ? { "X-CSRF-Token": csrfToken } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError({
      code: data?.error?.code ?? `HTTP_${res.status}`,
      message: data?.error?.message ?? "Upload failed. Please retry.",
      status: res.status,
      details: data?.error?.details,
      requestId: data?.error?.requestId,
    });
  }
  return data as ImportValidation;
}

export function imp02CommitImport(
  batchId: string,
  opts: { importRowsWithWarnings?: boolean } = {}
): Promise<ImportCommitResult> {
  return apiRequest(`/imports/players/${batchId}/commit`, {
    method: "POST",
    // `importRowsWithWarnings` is CSV_IMPORT §3 step 3 (rows with warnings
    // commit only if the owner ticked it). It is NOT in API_CONTRACTS yet —
    // raised as contract drift in the Step 3 handoff §4.
    body: { importRowsWithWarnings: opts.importRowsWithWarnings ?? false },
    idempotencyKey: idempotencyKey(),
  });
}

// --- Sessions and attendance (SES-01..04, ATT-01..03, CAT-01..05) -----------
export function ses01ListSessions(params: {
  from?: string;
  to?: string;
  ageGroupId?: string;
  status?: SessionStatus;
} = {}): Promise<Page<Session>> {
  return apiRequest(
    `/sessions${qs({
      from: params.from,
      to: params.to,
      ageGroupId: params.ageGroupId,
      status: params.status,
    })}`
  );
}

/** SES-02. `startsAt`/`endsAt` are UTC instants; the form converts the academy
 *  wall-clock time with `academyLocalToInstant` (ATTENDANCE §2). */
export function ses02CreateSession(input: {
  ageGroupId: string;
  startsAt: string;
  endsAt: string;
  venue?: string;
  leadCoachUserId?: string;
}): Promise<Session> {
  return apiRequest("/sessions", { method: "POST", body: input });
}

export function ses03GetSession(id: string): Promise<Session> {
  return apiRequest(`/sessions/${id}`);
}

/** SES-04. Cancelled sessions keep their marks for history (ATTENDANCE §1). */
export function ses04CancelSession(id: string, input: { reason: string }): Promise<Session> {
  return apiRequest(`/sessions/${id}/cancel`, { method: "POST", body: input });
}

export function att01GetAttendance(id: string): Promise<SessionAttendance> {
  return apiRequest(`/sessions/${id}/attendance`);
}

/** ATT-02. `idempotencyKey` is the draft id: a retry can never duplicate a save. */
export function att02SaveAttendance(
  id: string,
  records: AttendanceRecordInput[],
  key: string
): Promise<{ saved: number; roster: RosterRow[] }> {
  return apiRequest(`/sessions/${id}/attendance`, {
    method: "PUT",
    body: { records },
    idempotencyKey: key,
  });
}

/** ATT-03. Single correction; `reason` and the current `version` are required. */
export function att03PatchAttendance(
  id: string,
  playerId: string,
  input: { status?: AttendanceStatus; note?: string; reason: string; version: number }
): Promise<RosterRow> {
  return apiRequest(`/sessions/${id}/attendance/${playerId}`, {
    method: "PATCH",
    body: input,
  });
}

export function cat01CheckIn(input: {
  sessionId: string;
  note?: string;
}): Promise<CoachAttendance> {
  return apiRequest("/coach-attendance/check-in", { method: "POST", body: input });
}

export function cat02CheckOut(input: { sessionId: string }): Promise<CoachAttendance> {
  return apiRequest("/coach-attendance/check-out", { method: "POST", body: input });
}

export function cat03ListCoachAttendance(params: {
  from?: string;
  to?: string;
  coachUserId?: string;
} = {}): Promise<Page<CoachAttendance>> {
  return apiRequest(
    `/coach-attendance${qs({
      from: params.from,
      to: params.to,
      coachUserId: params.coachUserId,
    })}`
  );
}

/** CAT-04. Owner manual entry; `checkInAt`/`checkOutAt` are UTC instants. */
export function cat04CreateCoachAttendance(input: {
  coachUserId: string;
  sessionId: string;
  checkInAt: string;
  checkOutAt?: string;
  reason: string;
}): Promise<CoachAttendance> {
  return apiRequest("/coach-attendance", { method: "POST", body: input });
}

/** CAT-05. Owner correction; omitted `checkOutAt` leaves it open, `null` reopens. */
export function cat05PatchCoachAttendance(
  id: string,
  input: { checkInAt?: string; checkOutAt?: string | null; reason: string; version: number }
): Promise<CoachAttendance> {
  return apiRequest(`/coach-attendance/${id}`, { method: "PATCH", body: input });
}

// ---------------------------------------------------------------------------
// Billing and payments (SET-01/02/04 reads, BIL-01..03, INV-01..08,
// PAY-01..08, PRF-01..04, RCT-01/02 — API_CONTRACTS §3.6).
//
// Money endpoints are `Idem` in the contract: each wrapper takes the key the
// caller generated when the dialog/form OPENED (API_INTEGRATION §4), so a retry
// reuses it instead of duplicating a payment. Pages that do not care pass no key
// and get a fresh one.
// ---------------------------------------------------------------------------

/** SET-02 read — the billing wizard shows these read-only. */
export function set02GetBillingSettings(): Promise<BillingSettings> {
  return apiRequest("/settings/billing");
}

/** SET-01 subset the money screens need to be honest about (no settings UI yet). */
export function set01GetAcademyPaymentSettings(): Promise<AcademyPaymentSettings> {
  return apiRequest("/settings/academy");
}

/** SET-04 read — the method list behind the record-payment form. */
export function set04ListPaymentMethods(): Promise<{ data: PaymentMethod[] }> {
  return apiRequest("/settings/payment-methods");
}

// --- Billing runs (BIL-01..03) ----------------------------------------------
export function bil01CreatePreview(input: {
  targetDate: string;
  ageGroupIds?: string[];
  playerIds?: string[];
}): Promise<BillingPreview> {
  return apiRequest("/billing/previews", { method: "POST", body: input });
}

/** BIL-02. `previewHash` is what turns a stale preview into 409 PREVIEW_STALE. */
export function bil02CreateRun(
  input: {
    targetDate: string;
    previewHash: string;
    ageGroupIds?: string[];
    playerIds?: string[];
    adjustments?: BillingAdjustment[];
    queueWhatsApp?: boolean;
  },
  key: string = idempotencyKey()
): Promise<BillingRun> {
  return apiRequest("/billing/runs", { method: "POST", body: input, idempotencyKey: key });
}

export function bil03ListRuns(params: { page?: number; pageSize?: number } = {}): Promise<
  Page<BillingRun>
> {
  return apiRequest(`/billing/runs${qs({ page: params.page, pageSize: params.pageSize })}`);
}

export function bil03GetRun(id: string): Promise<BillingRun> {
  return apiRequest(`/billing/runs/${id}`);
}

// --- Invoices (INV-01..08) ---------------------------------------------------
export interface InvoiceListParams {
  status?: Invoice["status"];
  overdue?: boolean;
  playerId?: string;
  guardianId?: string;
  ageGroupId?: string;
  issueFrom?: string;
  issueTo?: string;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export function inv01ListInvoices(params: InvoiceListParams = {}): Promise<Page<Invoice>> {
  return apiRequest(
    `/invoices${qs({
      status: params.status,
      overdue: params.overdue ? true : undefined,
      playerId: params.playerId,
      guardianId: params.guardianId,
      ageGroupId: params.ageGroupId,
      issueFrom: params.issueFrom,
      issueTo: params.issueTo,
      dueFrom: params.dueFrom,
      dueTo: params.dueTo,
      q: params.q,
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort,
    })}`
  );
}

/** INV-03 manual one-off invoice (`kind=manual`). */
export function inv03CreateInvoice(
  input: { playerId: string; description: string; amountMinor: number; dueDate: string; guardianId?: string },
  key: string = idempotencyKey()
): Promise<Invoice> {
  return apiRequest("/invoices", { method: "POST", body: input, idempotencyKey: key });
}

/** INV-04. `releaseAllocations` turns the paid part into payment credit. */
export function inv04VoidInvoice(
  id: string,
  input: { reason: string; releaseAllocations?: boolean; allowReissue?: boolean; version: number },
  key: string = idempotencyKey()
): Promise<Invoice> {
  return apiRequest(`/invoices/${id}/void`, { method: "POST", body: input, idempotencyKey: key });
}

/** INV-05. Negative amount only; |amount| ≤ balance (BILLING_ENGINE §10). */
export function inv05AddAdjustment(
  id: string,
  input: { amountMinor: number; reason: string; version: number },
  key: string = idempotencyKey()
): Promise<Invoice> {
  return apiRequest(`/invoices/${id}/adjustments`, { method: "POST", body: input, idempotencyKey: key });
}

/**
 * INV-06. Streams the PDF with cookie auth; the caller opens the Blob in a new
 * tab (API_INTEGRATION §9 — one method everywhere, no stored signed URLs).
 * 409 `PDF_NOT_READY` carries no body to read, so the code is mapped here.
 */
export async function inv06DownloadInvoicePdf(id: string): Promise<Blob> {
  return downloadFile(`/invoices/${id}/pdf`, "application/pdf");
}

/** INV-07. 202 — the PDF is rebuilt from the snapshot. */
export async function inv07RegenerateInvoicePdf(id: string): Promise<void> {
  await apiRequest(`/invoices/${id}/pdf/regenerate`, { method: "POST" });
}

/** INV-08. Returns the enqueued jobs; skipped jobs carry a `skipReason`. */
export function inv08SendInvoice(
  id: string,
  input: { guardianIds?: string[] } = {},
  key: string = idempotencyKey()
): Promise<{ messageJobs: MessageJob[] }> {
  return apiRequest(`/invoices/${id}/send`, { method: "POST", body: input, idempotencyKey: key });
}

// --- Payments (PAY-01..08) ---------------------------------------------------
export interface PaymentListParams {
  status?: PaymentStatus;
  methodCode?: string;
  guardianId?: string;
  playerId?: string;
  from?: string;
  to?: string;
  q?: string;
  hasCredit?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export function pay01ListPayments(params: PaymentListParams = {}): Promise<Page<Payment>> {
  return apiRequest(
    `/payments${qs({
      status: params.status,
      methodCode: params.methodCode,
      guardianId: params.guardianId,
      playerId: params.playerId,
      from: params.from,
      to: params.to,
      q: params.q,
      hasCredit: params.hasCredit ? true : undefined,
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort,
    })}`
  );
}

/** PAY-02. `status: 'confirmed'` with allocations is how a checked payment lands. */
export function pay02CreatePayment(
  input: {
    amountMinor: number;
    methodCode: string;
    reference?: string;
    receivedAt: string;
    payerGuardianId?: string;
    payerName?: string;
    notes?: string;
    status: "confirmed" | "pending";
    allocations?: { invoiceId: string; amountMinor: number }[];
  },
  key: string = idempotencyKey()
): Promise<Payment> {
  return apiRequest("/payments", { method: "POST", body: input, idempotencyKey: key });
}

/** PAY-03. Amount, method and allocations are immutable — reverse instead. */
export function pay03GetPayment(id: string): Promise<Payment> {
  return apiRequest(`/payments/${id}`);
}

export function pay03PatchPayment(
  id: string,
  input: { reference?: string; notes?: string; receivedAt?: string; version: number }
): Promise<Payment> {
  return apiRequest(`/payments/${id}`, { method: "PATCH", body: input });
}

/** PAY-04 — the ONLY thing that changes a balance (ADR-020). */
export function pay04ConfirmPayment(
  id: string,
  input: { allocations?: { invoiceId: string; amountMinor: number }[]; version: number },
  key: string = idempotencyKey()
): Promise<Payment> {
  return apiRequest(`/payments/${id}/confirm`, { method: "POST", body: input, idempotencyKey: key });
}

export function pay05RejectPayment(
  id: string,
  input: { reason: string; version: number },
  key: string = idempotencyKey()
): Promise<Payment> {
  return apiRequest(`/payments/${id}/reject`, { method: "POST", body: input, idempotencyKey: key });
}

export function pay06AllocatePayment(
  id: string,
  input: { allocations: { invoiceId: string; amountMinor: number }[]; version: number },
  key: string = idempotencyKey()
): Promise<Payment> {
  return apiRequest(`/payments/${id}/allocate`, { method: "POST", body: input, idempotencyKey: key });
}

export function pay07ReversePayment(
  id: string,
  input: { reason: string; version: number },
  key: string = idempotencyKey()
): Promise<Payment> {
  return apiRequest(`/payments/${id}/reverse`, { method: "POST", body: input, idempotencyKey: key });
}

/**
 * PAY-08. The contract path carries a payment id while the suggestion is keyed by
 * `guardianId` — the record-payment form has no payment yet, so it calls this
 * with the literal id `new` plus the payer, and the mock accepts it. Raised as
 * contract drift in the Step 5 handoff.
 */
export function pay08AllocationSuggestion(
  id: string,
  params: { guardianId?: string } = {}
): Promise<{ suggested: { invoiceId: string; amountMinor: number }[]; creditMinor: number }> {
  return apiRequest(`/payments/${id}/allocation-suggestion${qs({ guardianId: params.guardianId })}`);
}

export type { Allocation };

// --- Payment proofs (PRF-01..04) ---------------------------------------------
/** PRF-01. Client pre-checks type/size, then sends multipart (API_INTEGRATION §9). */
export async function prf01UploadProof(
  paymentId: string,
  file: File,
  note?: string
): Promise<ProofMeta> {
  const form = new FormData();
  form.append("file", file);
  if (note) form.append("note", note);
  return uploadMultipart(`/payments/${paymentId}/proofs`, form, "proof");
}

/** PRF-02. A short-lived signed URL — never stored (audited read). */
export function prf02ProofDownloadUrl(
  paymentId: string,
  fileId: string
): Promise<{ url: string; expiresAt: string }> {
  return apiRequest(`/payments/${paymentId}/proofs/${fileId}/download`);
}

/** PRF-03. Only while the payment is `pending`. */
export async function prf03DeleteProof(paymentId: string, fileId: string): Promise<void> {
  await apiRequest(`/payments/${paymentId}/proofs/${fileId}`, { method: "DELETE" });
}

/** PRF-04. Advisory re-check; allowed even when automatic checks are off. */
export function prf04VerifyProof(paymentId: string, fileId: string): Promise<ProofVerification> {
  return apiRequest(`/payments/${paymentId}/proofs/${fileId}/verify`, { method: "POST" });
}

// --- Receipts (RCT-01/02) ----------------------------------------------------
export function rct01ListReceipts(
  params: { paymentId?: string; from?: string; to?: string } = {}
): Promise<Page<ReceiptSummary>> {
  return apiRequest(`/receipts${qs(params)}`);
}

export async function rct02DownloadReceiptPdf(id: string): Promise<Blob> {
  return downloadFile(`/receipts/${id}/pdf`, "application/pdf");
}

export async function rct02RegenerateReceiptPdf(id: string): Promise<void> {
  await apiRequest(`/receipts/${id}/pdf/regenerate`, { method: "POST" });
}

/**
 * GET a binary response with cookie auth, mapped onto the same ApiError model.
 * `PDF_NOT_READY` is a 409 the caller polls every 2 s for up to 20 s
 * (API_INTEGRATION §9).
 */
async function downloadFile(path: string, accept: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: { Accept: accept },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError({
      code: data?.error?.code ?? (res.status === 409 ? "PDF_NOT_READY" : `HTTP_${res.status}`),
      message:
        data?.error?.message ??
        (res.status === 409 ? "The PDF is still being prepared." : "Download failed. Please retry."),
      status: res.status,
      details: data?.error?.details,
      requestId: data?.error?.requestId,
    });
  }
  return res.blob();
}

/** Multipart POST (uploads bypass `apiRequest` — no JSON content type). */
async function uploadMultipart<T>(path: string, form: FormData, what: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: form,
    credentials: "include",
    cache: "no-store",
    headers: csrfToken ? { "X-CSRF-Token": csrfToken } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError({
      code: data?.error?.code ?? `HTTP_${res.status}`,
      message: data?.error?.message ?? `Could not upload the ${what}. Please retry.`,
      status: res.status,
      details: data?.error?.details,
      requestId: data?.error?.requestId,
    });
  }
  return data as T;
}

// ===========================================================================
// Step 6 — WhatsApp (MSG-01..08, SET-05..08 — API_CONTRACTS §3.7)
//
// Delivery discipline lives in the labels, not here: `deliveryState` is the
// provider-neutral enum and "Delivered" is only reachable for
// `device_delivered` (OPENWA_INTEGRATION §9). MSG-03/08 are `Idem`.
// ===========================================================================

export interface MessageListParams {
  status?: MessageJob["status"];
  kind?: MessageJob["kind"];
  invoiceId?: string;
  guardianId?: string;
  playerId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** MSG-01. */
export function msg01ListMessages(params: MessageListParams = {}): Promise<Page<MessageJob>> {
  return apiRequest(`/messages${qs({ ...params })}`);
}

/** MSG-02. Includes `events` and `renderedBody`. */
export function msg02GetMessage(id: string): Promise<MessageJob> {
  return apiRequest(`/messages/${id}`);
}

/** MSG-03. Only `failed|dead|needs_review`; the key is generated when the drawer opens. */
export function msg03RetryMessage(id: string, key: string = idempotencyKey()): Promise<MessageJob> {
  return apiRequest(`/messages/${id}/retry`, { method: "POST", body: {}, idempotencyKey: key });
}

/** MSG-04. Only `queued|failed`. */
export function msg04CancelMessage(id: string): Promise<MessageJob> {
  return apiRequest(`/messages/${id}/cancel`, { method: "POST", body: {} });
}

/** MSG-05. Records "owner sent manually" and stops retries. */
export function msg05ManualFallback(id: string, input: { note?: string } = {}): Promise<MessageJob> {
  return apiRequest(`/messages/${id}/manual-fallback`, { method: "POST", body: input });
}

/** MSG-06. */
export function msg06GetMessagingStatus(): Promise<MessagingStatus> {
  return apiRequest("/messaging/status");
}

/** MSG-07. The master pause/resume; both return the fresh status. */
export function msg07PauseMessaging(input: { reason?: string } = {}): Promise<MessagingStatus> {
  return apiRequest("/messaging/pause", { method: "POST", body: input });
}

export function msg07ResumeMessaging(): Promise<MessagingStatus> {
  return apiRequest("/messaging/resume", { method: "POST", body: {} });
}

/** MSG-08. To an owner's own number only; `Idem`. */
export function msg08SendTestMessage(
  input: { phone: string },
  key: string = idempotencyKey()
): Promise<MessageJob> {
  return apiRequest("/messaging/test", { method: "POST", body: input, idempotencyKey: key });
}

// --- reminder rules (SET-05) ------------------------------------------------
export function set05ListReminderRules(): Promise<{ data: ReminderRule[] }> {
  return apiRequest("/settings/reminder-rules");
}

export function set05CreateReminderRule(input: {
  kind: ReminderRule["kind"];
  offsetDays: number;
  isActive: boolean;
}): Promise<ReminderRule> {
  return apiRequest("/settings/reminder-rules", { method: "POST", body: input });
}

export function set05PatchReminderRule(
  id: string,
  patch: Partial<Pick<ReminderRule, "kind" | "offsetDays" | "isActive">>
): Promise<ReminderRule> {
  return apiRequest(`/settings/reminder-rules/${id}`, { method: "PATCH", body: patch });
}

export async function set05DeleteReminderRule(id: string): Promise<void> {
  await apiRequest(`/settings/reminder-rules/${id}`, { method: "DELETE" });
}

// --- message templates (SET-06) ---------------------------------------------
export function set06ListMessageTemplates(): Promise<{ data: MessageTemplate[] }> {
  return apiRequest("/settings/message-templates");
}

/** Unknown `{{vars}}` are a 422 from the server — never silently stripped. */
export function set06PutMessageTemplate(key: string, input: { body: string }): Promise<MessageTemplate> {
  return apiRequest(`/settings/message-templates/${key}`, { method: "PUT", body: input });
}

// --- messaging settings (SET-07) --------------------------------------------
export function set07GetMessagingSettings(): Promise<MessagingSettings> {
  return apiRequest("/settings/messaging");
}

export function set07PatchMessagingSettings(
  patch: Partial<Omit<MessagingSettings, "consentPolicyText">>
): Promise<MessagingSettings> {
  return apiRequest("/settings/messaging", { method: "PATCH", body: patch });
}

// --- per-automation switches (SET-08, CR-003) -------------------------------
export function set08GetAutomations(): Promise<AutomationsResponse> {
  return apiRequest("/settings/automations");
}

export function set08PatchAutomations(patch: Partial<Automations>): Promise<AutomationsResponse> {
  return apiRequest("/settings/automations", { method: "PATCH", body: patch });
}

// ===========================================================================
// Step 7 — Dashboard (DSH-01/02) and reports (RPT-01/02 — API_CONTRACTS §3.8)
// ===========================================================================

/** DSH-01. `from`/`to` affect invoiced/collected only; the rest is "as of now". */
export function dsh01GetOwnerDashboard(
  params: { from?: string; to?: string } = {}
): Promise<OwnerDashboard> {
  return apiRequest(`/dashboard/owner${qs({ from: params.from, to: params.to })}`);
}

/** DSH-02. Coaches (scoped) and owners. */
export function dsh02GetCoachDashboard(): Promise<CoachDashboard> {
  return apiRequest("/dashboard/coach");
}

/** RPT-01. Filters are the report's own set (PAGE_SPECIFICATIONS §10). */
export function rpt01GetReport(
  name: ReportName,
  filters: Record<string, string | number | boolean | undefined> = {}
): Promise<ReportResult> {
  return apiRequest(`/reports/${name}${qs({ ...filters })}`);
}

/**
 * RPT-02. Streams a UTF-8 CSV with a BOM; the caller saves it through
 * `lib/download.ts`. 429 / the 50k row cap arrive as the usual envelope.
 */
export async function rpt02ExportReportCsv(
  name: ReportName,
  filters: Record<string, string | number | boolean | undefined> = {}
): Promise<Blob> {
  return downloadFile(`/reports/${name}/export${qs({ ...filters })}`, "text/csv");
}

// ===========================================================================
// Step 8 — Admin (USR-01..05, SET-01..04, AUD-01, SYS-03)
// ===========================================================================

/** USR-01. */
export function usr01ListUsers(
  params: { role?: "owner" | "coach"; status?: User["status"]; q?: string; page?: number; pageSize?: number } = {}
): Promise<Page<User>> {
  return apiRequest(`/users${qs({ ...params })}`);
}

// USR-02 already exists above (the coaches page's invite dialog owns it) — the
// invite URL is shown once per ADR-018, and this slice must not redefine it.

export function usr03GetUser(id: string): Promise<User> {
  return apiRequest(`/users/${id}`);
}

/** USR-03. `username` is not patchable — re-invite instead (ADR-018). */
export function usr03PatchUser(
  id: string,
  patch: { fullName?: string; phone?: string; role?: "owner" | "coach" }
): Promise<User> {
  return apiRequest(`/users/${id}`, { method: "PATCH", body: patch });
}

/** USR-04. `LAST_OWNER` guard lives on the server. */
export function usr04DisableUser(id: string, input: { reason?: string } = {}): Promise<User> {
  return apiRequest(`/users/${id}/disable`, { method: "POST", body: input });
}

export function usr04EnableUser(id: string): Promise<User> {
  return apiRequest(`/users/${id}/enable`, { method: "POST", body: {} });
}

/** USR-05. Revokes sessions and returns a fresh single-use invite URL. */
export function usr05ResetPassword(id: string): Promise<{ inviteUrl: string; inviteExpiresAt: string }> {
  return apiRequest(`/users/${id}/reset-password`, { method: "POST", body: {} });
}

// --- academy settings (SET-01) ----------------------------------------------
/** SET-01 full read. The money screens use the `set01GetAcademyPaymentSettings` subset. */
export function set01GetAcademySettings(): Promise<AcademySettings> {
  return apiRequest("/settings/academy");
}

export function set01PatchAcademySettings(
  patch: Partial<Omit<AcademySettings, "beneficiaryAccounts">>
): Promise<AcademySettings> {
  return apiRequest("/settings/academy", { method: "PATCH", body: patch });
}

/** SET-02 write. The response carries the "applies to invoices after now" note. */
export function set02PatchBillingSettings(
  patch: Partial<Omit<BillingSettings, "effectNote">>
): Promise<BillingSettings> {
  return apiRequest("/settings/billing", { method: "PATCH", body: patch });
}

/** SET-03. PNG/JPEG/SVG ≤ 1 MB; returns the stored URL. */
export function set03UploadLogo(file: File): Promise<{ logoUrl: string }> {
  const form = new FormData();
  form.append("file", file);
  return uploadMultipart(`/settings/logo`, form, "logo");
}

/** SET-04 writes. Codes are immutable — deactivate instead of deleting. */
export function set04CreatePaymentMethod(input: {
  code: string;
  label: string;
  requiresReference: boolean;
}): Promise<PaymentMethod> {
  return apiRequest("/settings/payment-methods", { method: "POST", body: input });
}

export function set04PatchPaymentMethod(
  code: string,
  patch: { label?: string; requiresReference?: boolean; isActive?: boolean }
): Promise<PaymentMethod> {
  return apiRequest(`/settings/payment-methods/${code}`, { method: "PATCH", body: patch });
}

// --- audit (AUD-01) and system health (SYS-03) -------------------------------
export interface AuditListParams {
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function aud01ListAuditLogs(params: AuditListParams = {}): Promise<Page<AuditEntry>> {
  return apiRequest(`/audit-logs${qs({ ...params })}`);
}

/** SYS-03. Owner-only; `/health` and `/ready` are the host's, not the UI's. */
export function sys03GetSystemHealth(): Promise<SystemHealth> {
  return apiRequest("/system/health");
}
