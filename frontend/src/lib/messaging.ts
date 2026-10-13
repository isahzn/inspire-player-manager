// The label-discipline module for messaging — the single place the delivery and
// automation rules are turned into words (the messaging twin of `lib/billing.ts`).
//
// Non-negotiables it encodes:
// · "Delivered" is reachable ONLY for `device_delivered`; `sent` alone is never
//   "Delivered" (PAGE_SPECIFICATIONS §9).
// · `read` is likewise only shown for the provider's own ack — and because the
//   OpenWA ack mapping is UNCONFIRMED (spike S1, OPENWA_INTEGRATION §9/OPEN-019),
//   the mock adapter emits only `server_accepted`/`unknown`, so the Delivered and
//   Read labels stay unreachable rather than guessed.
// · A disabled automation never implies a back-fill (SET-08/ADR-019).

import type {
  Automations,
  AutomationKey,
  MessageJob,
  ReminderRule,
  SessionStatusLabel,
} from "@/api/types";

export const MESSAGE_STATUSES: MessageJob["status"][] = [
  "queued",
  "sending",
  "sent",
  "failed",
  "dead",
  "needs_review",
  "cancelled",
  "skipped",
];

export const MESSAGE_DELIVERY_STATES: MessageJob["deliveryState"][] = [
  "unknown",
  "server_accepted",
  "device_delivered",
  "read",
  "provider_error",
];

/** Closed set — a status word the UI may print for `MessageJob.status`. */
export function messageStatusLabel(status: MessageJob["status"], skipReason?: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed (will retry)";
    case "dead":
      return "Failed permanently";
    case "needs_review":
      return "Needs review";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return skipReason ? `Skipped (${skipReasonLabel(skipReason)})` : "Skipped";
  }
}

/**
 * Delivery words. `device_delivered` is the ONLY state that may read
 * "Delivered"; `provider_error` is not a delivery claim at all.
 */
export function deliveryLabel(state: MessageJob["deliveryState"]): string {
  switch (state) {
    case "device_delivered":
      return "Delivered";
    case "read":
      return "Read";
    case "server_accepted":
      return "Accepted by server";
    case "provider_error":
      return "Provider error";
    case "unknown":
      return "Unknown";
  }
}

/** True when the UI must NOT claim the recipient's phone showed the message. */
export function deliveryIsUnproven(state: MessageJob["deliveryState"]): boolean {
  return state === "unknown" || state === "server_accepted";
}

/**
 * `skipReason` strings are not enumerated in the contract (BIL-02 raised this in
 * the Step 5 handoff), so unknown values are printed verbatim — never guessed at.
 */
export function skipReasonLabel(reason: string): string {
  switch (reason) {
    case "AUTOMATION_DISABLED":
      return "automation turned off";
    case "NO_CONSENT":
    case "CONSENT_REVOKED":
      return "guardian opted out";
    case "INVOICE_VOID":
      return "invoice voided";
    case "INVOICE_PAID":
      return "already paid";
    case "PAUSED":
      return "automation paused";
    case "SESSION_DOWN":
      return "WhatsApp not connected";
    case "NO_TEMPLATE":
      return "no template set";
    default:
      return reason;
  }
}

export function messageKindLabel(kind: MessageJob["kind"]): string {
  switch (kind) {
    case "invoice_delivery":
      return "Invoice";
    case "reminder_pre_due":
      return "Pre-due reminder";
    case "reminder_overdue":
      return "Late reminder";
    case "test":
      return "Test message";
  }
}

/** The provider's lifecycle mapped onto OUR labels — never the provider's text. */
export function sessionStatusLabel(status: SessionStatusLabel): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "awaiting_qr":
      return "Awaiting QR scan";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
  }
}

export function sessionStatusTone(status: SessionStatusLabel): string {
  switch (status) {
    case "connected":
      return "Active";
    case "awaiting_qr":
    case "starting":
      return "Pending";
    case "failed":
      return "Failed";
    case "stopped":
      return "Inactive";
    case "unknown":
      return "Unknown";
  }
}

/** Chip word for a message row (StatusChip styles by the exact word). */
export function messageStatusTone(status: MessageJob["status"], skipReason?: string): string {
  switch (status) {
    case "sent":
    case "sending":
      return "Sent";
    case "failed":
    case "dead":
      return "Failed";
    case "needs_review":
      return "Pending";
    case "cancelled":
    case "skipped":
      return "Inactive";
    case "queued":
      return skipReason ? "Inactive" : "Pending";
  }
}

// --- automations (SET-08, CR-003) -------------------------------------------

export interface AutomationMeta {
  key: AutomationKey;
  label: string;
  effect: string;
  /** What the switch does not do, stated on the control itself. */
  whenOff: string;
}

export const AUTOMATIONS: AutomationMeta[] = [
  {
    key: "invoiceDelivery",
    label: "Invoices",
    effect: "Send each invoice to the guardian's WhatsApp when it is issued.",
    whenOff:
      "No new invoices are sent, and unsent ones are cancelled. Messages missed while off are not sent retroactively.",
  },
  {
    key: "reminderPreDue",
    label: "Pre-due reminders",
    effect: "Send a reminder before the due date, at the offsets in the rules below.",
    whenOff:
      "No new pre-due reminders are sent, and unsent ones are cancelled. Missed reminders are not sent retroactively.",
  },
  {
    key: "reminderOverdue",
    label: "Late (overdue) reminders",
    effect: "Send a reminder after the due date, at the offsets in the rules below.",
    whenOff:
      "No new late reminders are sent, and unsent ones are cancelled. Missed reminders are not sent retroactively.",
  },
  {
    key: "proofCheck",
    label: "Bank-transfer proof checks",
    effect:
      "Read the bank's PDF e-receipt when a proof is uploaded and report advisory findings. It never confirms a payment.",
    whenOff:
      "No automatic checks run on upload. You can still run a check by hand on any proof, and turning this off never changes a payment.",
  },
];

export function automationMeta(key: AutomationKey): AutomationMeta {
  return AUTOMATIONS.find((a) => a.key === key) ?? AUTOMATIONS[0];
}

/**
 * The two states that must never be confused: an automation can be ON while the
 * master pause is up (nothing sends), and it can be OFF while unpaid invoices
 * exist (R-20 — the owner must not believe reminders are running).
 */
export function automationStateLine(
  enabled: boolean,
  masterPaused: boolean,
  sessionStatus: SessionStatusLabel
): string {
  if (masterPaused) return "Paused (master)";
  if (!enabled) return "Off";
  if (sessionStatus !== "connected") return "On — waiting for WhatsApp to reconnect";
  return "On";
}

/** R-20: an automation that is off while money is outstanding is worth saying out loud. */
export function automationWarning(
  automations: Automations,
  masterPaused: boolean,
  outstandingCount: number
): string | null {
  if (masterPaused || outstandingCount === 0) return null;
  const off: string[] = [];
  if (!automations.invoiceDelivery) off.push("invoice sending");
  if (!automations.reminderPreDue) off.push("pre-due reminders");
  if (!automations.reminderOverdue) off.push("late reminders");
  if (off.length === 0) return null;
  return `${off.join(", ")} ${off.length === 1 ? "is" : "are"} switched off while ${outstandingCount} invoice${
    outstandingCount === 1 ? "" : "s"
  } still carry a balance — nothing will be sent.`;
}

// --- templates (SET-06) -----------------------------------------------------

/** `{{var}}` tokens in a body, in order, de-duplicated. */
export function templateVars(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Variables used but not offered by the template — SET-06 answers 422 on these. */
export function unknownTemplateVars(body: string, allowed: string[]): string[] {
  return templateVars(body).filter((v) => !allowed.includes(v));
}

export function renderTemplate(body: string, sample: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) =>
    name in sample ? sample[name] : whole
  );
}

export const SAMPLE_TEMPLATE_VALUES: Record<string, string> = {
  guardian_name: "Demo Guardian",
  player_name: "Demo Player One",
  invoice_number: "INV-2026-0001",
  amount: "LKR 4,000.00",
  due_date: "2026-11-10",
  link: "https://pay.inspireacademy.lk/i/abc123",
  receipt_number: "RCT-2026-0001",
};

/** The reminder rule's own wording (SET-05). */
export function reminderRuleLabel(rule: Pick<ReminderRule, "kind" | "offsetDays">): string {
  const day = rule.offsetDays === 1 ? "day" : "days";
  return rule.kind === "reminder_pre_due"
    ? `${rule.offsetDays} ${day} before the due date`
    : `${rule.offsetDays} ${day} after the due date`;
}

// --- manual fallback (MSG-05) ----------------------------------------------

/**
 * The copy-and-open helper's message. The mock never sends through wa.me itself
 * (that is the owner's own WhatsApp, opened by hand) — it only puts the text and
 * the link on the clipboard, and the API records that the owner did it.
 */
export function waMeLink(phone: string, body: string): string {
  return `https://wa.me/${phone.replace(/[^\d]/g, "")}?text=${encodeURIComponent(body)}`;
}

export const ASK_FOR_PDF_MESSAGE =
  "Please send the bank transfer receipt as a PDF from your bank app — a photo can't be verified.";
