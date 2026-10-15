"use client";

// Shared mock state for Steps 6–8: users (USR-*), the audit log (AUD-01), the
// reminder rules/templates/messaging settings (SET-05..08) and the academy
// settings (SET-01..04). Kept out of `db.ts` on purpose so the messaging, admin
// and dashboard/report handler slices all read ONE store instead of each
// growing its own copy (a second copy is how the slices drift apart).
//
// Message jobs themselves live in `db.messages` — the billing slice already
// enqueues them on a run (BIL-02 `queueWhatsApp`), and MSG-* must act on the
// same rows. This module only *derives* (queue counts, status) and *mutates
// under a rule* (SET-08 cancelling a disabled automation's unsent sends).
//
// The mock mirrors to localStorage (`ia_mock_admin_v1`) exactly like db.ts, so a
// reload does not undo an invite, a switch or an audit entry.

import type {
  AcademySettings,
  AuditEntry,
  Automations,
  AutomationKey,
  AutomationsResponse,
  MessageJob,
  MessageTemplate,
  MessagingSettings,
  MessagingStatus,
  ReminderRule,
  Role,
  SessionStatusLabel,
  User,
} from "@/api/types";
import { addDaysISO, todayISO } from "@/lib/dates";
import { COACH2_ID, COACH_ID, OWNER_ID, getDb, saveDb } from "./db";

const STORE_KEY = "ia_mock_admin_v1";

export interface AdminStore {
  schema: 1;
  users: User[];
  audit: AuditEntry[];
  auditSeq: number;
  reminders: ReminderRule[];
  templates: MessageTemplate[];
  messaging: MessagingSettings;
  automations: Automations;
  /** MSG-07 mirror (`messaging_automation_enabled`); stored inverted as "paused". */
  masterPaused: boolean;
  academy: AcademySettings;
  /** The AppShell banner + MSG-06 read this (see `MockSettings.whatsappSession`). */
  sessionStatus: SessionStatusLabel;
  sessionCheckedAt: string;
  logoUrl?: string;
  /** One-time flag: the seeded message jobs were pushed into `db.messages`. */
  messagesSeeded: boolean;
}

// --- seed -------------------------------------------------------------------

const OWNER_USERNAME = "owner";

function seed(): AdminStore {
  const today = todayISO();
  const now = new Date().toISOString();

  const users: User[] = [
    {
      id: OWNER_ID,
      username: OWNER_USERNAME,
      fullName: "Hassen (Owner)",
      phone: "+94770000009",
      role: "owner",
      status: "active",
      totpEnabled: false,
      lastLoginAt: `${today}T04:12:00Z`,
    },
    {
      id: COACH_ID,
      username: "coach",
      fullName: "Coach Perera",
      phone: "+94770000010",
      role: "coach",
      status: "active",
      totpEnabled: false,
      lastLoginAt: `${today}T02:40:00Z`,
    },
    {
      id: COACH2_ID,
      username: "coach.silva",
      fullName: "Coach Silva",
      phone: "+94770000011",
      role: "coach",
      status: "active",
      totpEnabled: false,
      lastLoginAt: addDaysISO(today.slice(0, 10), -2) + "T09:05:00Z",
    },
    {
      id: "0192a000-0000-7000-8000-000000000004",
      username: "coach.fernando",
      fullName: "Coach Fernando",
      phone: "+94770000012",
      role: "coach",
      status: "invited",
      totpEnabled: false,
    },
    {
      id: "0192a000-0000-7000-8000-000000000005",
      username: "coach.old",
      fullName: "Coach Jayawardene",
      role: "coach",
      status: "disabled",
      totpEnabled: false,
      lastLoginAt: addDaysISO(today.slice(0, 10), -40) + "T05:00:00Z",
    },
  ];

  const reminders: ReminderRule[] = [
    { id: "rr_1", kind: "reminder_pre_due", offsetDays: 3, isActive: true },
    { id: "rr_2", kind: "reminder_pre_due", offsetDays: 1, isActive: true },
    { id: "rr_3", kind: "reminder_overdue", offsetDays: 3, isActive: true },
    { id: "rr_4", kind: "reminder_overdue", offsetDays: 10, isActive: false },
  ];

  const templates: MessageTemplate[] = [
    {
      key: "invoice_delivery",
      label: "Invoice delivery",
      variables: ["guardian_name", "player_name", "invoice_number", "amount", "due_date", "link"],
      body:
        "Hi {{guardian_name}}, the {{invoice_number}} for {{player_name}} is ready: {{amount}}, due {{due_date}}. View it here: {{link}} — Inspire Academy",
    },
    {
      key: "reminder_pre_due",
      label: "Pre-due reminder",
      variables: ["guardian_name", "player_name", "invoice_number", "amount", "due_date", "link"],
      body:
        "Hi {{guardian_name}}, a friendly reminder that {{invoice_number}} for {{player_name}} ({{amount}}) is due on {{due_date}}. Pay here: {{link}}",
    },
    {
      key: "reminder_overdue",
      label: "Late (overdue) reminder",
      variables: ["guardian_name", "player_name", "invoice_number", "amount", "link"],
      body:
        "Hi {{guardian_name}}, {{invoice_number}} for {{player_name}} ({{amount}}) is now overdue. Pay here: {{link}} — Inspire Academy",
    },
    {
      key: "receipt_delivery",
      label: "Receipt",
      variables: ["guardian_name", "receipt_number", "amount"],
      body: "Thank you {{guardian_name}} — we received {{amount}}. Receipt {{receipt_number}}. Inspire Academy",
    },
  ];

  const messaging: MessagingSettings = {
    sendWindowStart: "08:00",
    sendWindowEnd: "20:00",
    invoiceMode: "link",
    pacingMinSeconds: 20,
    pacingMaxSeconds: 45,
    maxPerHour: 60,
    optOutKeywords: ["STOP", "UNSUBSCRIBE", "NO MESSAGES"],
    consentPolicyText:
      "We send invoices and payment reminders on WhatsApp to the number you gave us. Reply STOP at any time to opt out; we then only contact you by phone.",
  };

  const automations: Automations = {
    invoiceDelivery: true,
    reminderPreDue: true,
    reminderOverdue: true,
    // CR-003/CR-004: off by default; the explicit PRF-04 re-check is always available.
    proofCheck: false,
  };

  // Field names follow the contract (`openapi.yaml` `AcademySettings`): `name`, and the
  // `jan_1_of_year | fixed_month_day | today` enum. The mock used to invent `academyName`
  // and `jan_1`, and because mock mode was the only mode the frontend had ever been built
  // in, that spelling is what the real screens were written against — which is what made
  // `/settings` throw on the live deployment (2026-10-15 audit, defect A2).
  const academy: AcademySettings = {
    name: "Inspire Academy",
    address: "12 Galle Road, Dehiwala",
    phone: "+94112223344",
    email: "hello@inspireacademy.lk",
    paymentInstructions:
      "Bank transfer to Inspire Academy · Bank of Ceylon · 0071234567 (Colombo 04). Put the invoice number in the reference. A proof is evidence only — your payment counts once we confirm it.",
    timezone: "Asia/Colombo",
    ageReferenceRule: "jan_1_of_year",
    coachCanSeeGuardianPhone: true,
    attendanceCoachEditWindowHours: 24,
    coachCheckinOpensMinutesBefore: 30,
    coachCheckinClosesMinutesAfterEnd: 60,
    invoiceLinkTtlDays: 30,
    beneficiaryAccounts: [{ name: "Inspire Academy", accountMasked: "••••4567" }],
  };

  const audit: AuditEntry[] = [
    {
      id: 3,
      occurredAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      actor: { id: OWNER_ID, fullName: "Hassen (Owner)", role: "owner" },
      action: "invoice.issue",
      entityType: "invoice",
      entityId: "0192a000-0000-7000-8000-00000000i001",
      requestId: "req_seed_003",
    },
    {
      id: 2,
      occurredAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      actor: { id: OWNER_ID, fullName: "Hassen (Owner)", role: "owner" },
      action: "payment.confirm",
      entityType: "payment",
      entityId: "0192a000-0000-7000-8000-0000000000p01",
      reason: "Bank slip matched",
      before: { status: "pending" },
      after: { status: "confirmed" },
      requestId: "req_seed_002",
    },
    {
      id: 1,
      occurredAt: new Date(Date.now() - 50 * 3600_000).toISOString(),
      actor: { id: COACH_ID, fullName: "Coach Perera", role: "coach" },
      action: "attendance.save",
      entityType: "session",
      entityId: "0192a000-0000-7000-8000-00000000s001",
      requestId: "req_seed_001",
    },
  ];

  return {
    schema: 1,
    users,
    audit,
    auditSeq: 4,
    reminders,
    templates,
    messaging,
    automations,
    masterPaused: false,
    academy,
    sessionStatus: "awaiting_qr",
    sessionCheckedAt: now,
    messagesSeeded: false,
  };
}

// --- persistence ------------------------------------------------------------

let cache: AdminStore | null = null;

function readStored(): AdminStore | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminStore;
    if (parsed.schema !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(store: AdminStore) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable: the store still works for this document.
  }
}

export function getAdmin(): AdminStore {
  if (cache) return cache;
  cache = readStored() ?? seed();
  persist(cache);
  // The message jobs are seeded lazily because they must reference real
  // invoices/players from the (separately seeded) people store.
  if (!cache.messagesSeeded) seedMessages(cache);
  return cache;
}

export function saveAdmin(): AdminStore {
  const store = getAdmin();
  persist(store);
  return store;
}

/** Dev helper: drop the mirrored store (the E2E script uses this for a clean run). */
export function resetAdminMock() {
  cache = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

// --- audit ------------------------------------------------------------------

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  actor?: { id: string; fullName: string; role: Role };
}

/**
 * Append an audit entry. Every sensitive mutation in these slices calls this —
 * AUD-01 then shows something real instead of a fixture that never moves.
 */
export function logAudit(input: AuditInput): AuditEntry {
  const store = getAdmin();
  const entry: AuditEntry = {
    id: store.auditSeq++,
    occurredAt: new Date().toISOString(),
    actor: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    reason: input.reason,
    before: input.before,
    after: input.after,
    requestId: `req_mock_${String(store.auditSeq).padStart(3, "0")}`,
  };
  store.audit.unshift(entry);
  saveAdmin();
  return entry;
}

export function actorFor(userId: string): { id: string; fullName: string; role: Role } {
  const user = getAdmin().users.find((u) => u.id === userId);
  return user
    ? { id: user.id, fullName: user.fullName, role: user.role }
    : { id: userId, fullName: "Unknown", role: "owner" };
}

// --- messaging: seeding the jobs once ---------------------------------------

function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `+${digits.slice(0, 3)} ••• ••• ${digits.slice(-2)}`;
}

/**
 * Seed the message list against the invoices the money slice created. Without
 * this the Messages tab is empty on a fresh store until a billing run queues
 * something, which hides the delivery-label rules the screen exists to show.
 */
function seedMessages(store: AdminStore) {
  const db = getDb();
  const invoices = db.invoices.filter((i) => i.status !== "void");
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  const job = (
    n: number,
    kind: MessageJob["kind"],
    status: MessageJob["status"],
    deliveryState: MessageJob["deliveryState"],
    hoursAgo: number,
    extra: Partial<MessageJob> = {}
  ): MessageJob | null => {
    const inv = invoices[n % Math.max(invoices.length, 1)];
    if (!inv) return null;
    const guardian = inv.guardian ?? db.guardians[0];
    if (!guardian) return null;
    return {
      id: `0192a000-0000-7000-8000-0000000m${String(n).padStart(4, "0")}`,
      kind,
      status,
      deliveryState,
      invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber },
      player: { id: inv.player.id, fullName: inv.player.fullName },
      guardian: {
        id: guardian.id,
        fullName: guardian.fullName,
        phoneMasked: maskPhone(
          "phone" in guardian && typeof guardian.phone === "string"
            ? guardian.phone
            : "+94770000001"
        ),
      },
      scheduledFor: at(hoursAgo),
      attempts: status === "failed" || status === "needs_review" ? 2 : 1,
      maxAttempts: 5,
      ...extra,
    };
  };

  const seeded = [
    job(1, "invoice_delivery", "sent", "server_accepted", 30),
    job(2, "reminder_pre_due", "queued", "unknown", 2),
    job(3, "reminder_overdue", "failed", "provider_error", 20, {
      nextAttemptAt: at(-1),
      lastError: { code: "TIMEOUT", message: "The provider did not answer in time." },
    }),
    job(4, "invoice_delivery", "needs_review", "unknown", 8, {
      lastError: { code: "AMBIGUOUS_SEND", message: "The provider's answer was ambiguous." },
    }),
    job(5, "reminder_overdue", "dead", "provider_error", 72, {
      lastError: { code: "NOT_ON_WHATSAPP", message: "This number is not on WhatsApp." },
    }),
    job(6, "invoice_delivery", "cancelled", "unknown", 26, { skipReason: "INVOICE_VOID" }),
    job(7, "reminder_pre_due", "skipped", "unknown", 26, { skipReason: "CONSENT_REVOKED" }),
    job(8, "invoice_delivery", "sent", "read", 96, { sentAt: at(96) }),
  ].filter((j): j is MessageJob => j !== null);

  // OpenWA ack semantics are UNCONFIRMED (spike S1, OPEN-019). Per the spec the
  // adapter may only emit `server_accepted`/`unknown`, so the seeded "read"/"sent"
  // rows would claim an ack we cannot map yet. Keep the enum honest: anything the
  // seed cannot justify reads `unknown` or `server_accepted`.
  for (const j of seeded) {
    if (j.deliveryState === "device_delivered" || j.deliveryState === "read") {
      j.deliveryState = "server_accepted";
    }
    j.sentAt ??= j.status === "sent" ? j.scheduledFor : undefined;
    j.events = [{ eventType: "queued", at: j.scheduledFor }];
    if (j.status !== "queued") j.events.push({ eventType: "attempt", at: j.scheduledFor });
    j.renderedBody = "Rendered with sample data — see the template.";
  }

  db.messages.push(...seeded);
  saveDb();
  store.messagesSeeded = true;
  saveAdmin();
}

// --- messaging: derived state ------------------------------------------------

export function queueCounts(): MessagingStatus["queue"] {
  const db = getDb();
  const since = Date.now() - 24 * 3600_000;
  const jobs = db.messages;
  return {
    queued: jobs.filter((j) => j.status === "queued").length,
    sending: jobs.filter((j) => j.status === "sending").length,
    failedLast24h: jobs.filter(
      (j) => j.status === "failed" && new Date(j.scheduledFor).getTime() >= since
    ).length,
    dead: jobs.filter((j) => j.status === "dead").length,
    needsReview: jobs.filter((j) => j.status === "needs_review").length,
  };
}

export function lastSentAt(): string | undefined {
  const sent = getDb()
    .messages.filter((j) => j.sentAt)
    .sort((a, b) => (a.sentAt! < b.sentAt! ? 1 : -1));
  return sent[0]?.sentAt;
}

export function messagingStatus(): MessagingStatus {
  const store = saveAdmin();
  return {
    automationEnabled: !store.masterPaused,
    automations: store.automations,
    provider: "openwa",
    session: { status: store.sessionStatus, checkedAt: store.sessionCheckedAt },
    queue: queueCounts(),
    lastSentAt: lastSentAt(),
  };
}

/** `AUTOMATION_DISABLED` is the contract's own skipReason for SET-08 (CR-003). */
export const AUTOMATION_DISABLED = "AUTOMATION_DISABLED";

/** Which job kind each switch governs. `proofCheck` governs no message kind. */
export const AUTOMATION_KIND: Record<AutomationKey, MessageJob["kind"] | null> = {
  invoiceDelivery: "invoice_delivery",
  reminderPreDue: "reminder_pre_due",
  reminderOverdue: "reminder_overdue",
  proofCheck: null,
};

const UNSENT: MessageJob["status"][] = ["queued", "sending", "failed", "needs_review"];

/**
 * SET-08 write. Takes effect immediately: switching an automation OFF stops new
 * enqueues **and** cancels that kind's not-yet-sent jobs (`cancelled` +
 * `skipReason: AUTOMATION_DISABLED`). Re-enabling **never back-fills** — the
 * cancelled rows stay cancelled, which is the rule the UI has to state.
 */
export function patchAutomations(
  patch: Partial<Automations>,
  actor: { id: string; fullName: string; role: Role }
): AutomationsResponse {
  const store = getAdmin();
  const before = { ...store.automations };
  const cancelledKinds: MessageJob["kind"][] = [];
  for (const [key, next] of Object.entries(patch) as [AutomationKey, boolean][]) {
    if (store.automations[key] === next) continue;
    store.automations[key] = next;
    const kind = AUTOMATION_KIND[key];
    if (!next && kind) cancelledKinds.push(kind);
  }
  if (cancelledKinds.length > 0) {
    const db = getDb();
    for (const j of db.messages) {
      if (cancelledKinds.includes(j.kind) && UNSENT.includes(j.status)) {
        j.status = "cancelled";
        j.skipReason = AUTOMATION_DISABLED;
        j.nextAttemptAt = undefined;
      }
    }
    saveDb();
  }
  saveAdmin();
  logAudit({
    action: "settings.automations.update",
    entityType: "settings",
    entityId: "automations",
    before,
    after: { ...store.automations },
    actor,
  });
  return { ...store.automations, masterPaused: store.masterPaused };
}

/** MSG-07. */
export function setMasterPaused(
  paused: boolean,
  reason: string | undefined,
  actor: { id: string; fullName: string; role: Role }
): MessagingStatus {
  const store = getAdmin();
  const before = store.masterPaused;
  store.masterPaused = paused;
  saveAdmin();
  logAudit({
    action: paused ? "messaging.pause" : "messaging.resume",
    entityType: "settings",
    entityId: "messaging_automation_enabled",
    reason,
    before: { masterPaused: before },
    after: { masterPaused: paused },
    actor,
  });
  return messagingStatus();
}

/** SET-03 logo upload — the mock keeps only the filename, never the bytes. */
export function setLogo(fileName: string): string {
  const store = getAdmin();
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".png";
  store.logoUrl = `/mock/logo${ext}`;
  saveAdmin();
  return store.logoUrl;
}
