"use client";

// MSW handlers for the WhatsApp slice (Step 6): MSG-01..08 and SET-05..08.
// Every response is the contract shape from API_CONTRACTS §3.7 and every failure
// is the exact envelope + a code the contract actually names.
//
// Two rules this slice must not soften:
// · `deliveryState` never claims an acknowledgement we cannot map. OpenWA's ack
//   semantics are UNCONFIRMED (spike S1, OPEN-019), so nothing here may write
//   `device_delivered`/`read` — "Delivered" and "Read" stay unreachable rather
//   than guessed (PAGE_SPECIFICATIONS §9).
// · MSG-07 pause stops the worker CLAIMING jobs; queued jobs stay queued
//   (API_CONTRACTS §4). It therefore does not refuse a retry/enqueue.
//
// Message jobs live in `db.messages` (the billing slice enqueues there too); the
// messaging settings, rules, templates and switches live in `store678`.
import { delay, http } from "msw";
import type { MessageJob, Page, ReminderRule } from "@/api/types";
import { SAMPLE_TEMPLATE_VALUES, renderTemplate, templateVars } from "@/lib/messaging";
import { normalizeLkPhone } from "@/lib/phone";
import { MockError, OWNER_ID, getDb, saveDb } from "./db";
import { idempotent, json, jsonBody, ownerOnly } from "./http";
import { err } from "./session";
import {
  actorFor,
  getAdmin,
  logAudit,
  messagingStatus,
  patchAutomations,
  saveAdmin,
  setMasterPaused,
} from "./store678";

// --- helpers ----------------------------------------------------------------

function pageOf<T>(items: T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const start = (Math.min(Math.max(page, 1), totalPages) - 1) * pageSize;
  return {
    data: items.slice(start, start + pageSize),
    meta: { page, pageSize, total, totalPages },
  };
}

function intParam(raw: string | null, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Message list rows are the shorter shape: no `events`/`renderedBody` (MSG-01). */
function listShape(job: MessageJob): MessageJob {
  const row = { ...job };
  delete row.events;
  delete row.renderedBody;
  return row;
}

const RETRYABLE: MessageJob["status"][] = ["failed", "dead", "needs_review"];
const CANCELLABLE: MessageJob["status"][] = ["queued", "failed"];

function jobById(id: string): MessageJob | undefined {
  return getDb().messages.find((j) => j.id === id);
}

/** The provider-neutral ack timeline. `providerAck` is omitted on purpose. */
function timeline(job: MessageJob): NonNullable<MessageJob["events"]> {
  const events: NonNullable<MessageJob["events"]> = [
    { eventType: "queued", at: job.scheduledFor },
  ];
  if (job.attempts > 0 && job.status !== "queued") {
    events.push({ eventType: "attempt", at: job.nextAttemptAt ?? job.scheduledFor });
  }
  if (job.sentAt) events.push({ eventType: "sent", at: job.sentAt });
  if (job.lastError && (job.status === "failed" || job.status === "dead" || job.status === "needs_review")) {
    events.push({ eventType: "failed", at: job.nextAttemptAt ?? job.scheduledFor });
  }
  if (job.manualFallback) events.push({ eventType: "manual_fallback", at: job.manualFallback.at });
  if (job.status === "cancelled") events.push({ eventType: "cancelled", at: job.scheduledFor });
  return events;
}

/**
 * MSG-03's "re-check consent/invoice state". A retry that would send to a
 * guardian who opted out, or chase a void/paid invoice, must not queue.
 * Returns the plain-language reason or null when the send is still allowed.
 */
function retryBlockedReason(job: MessageJob): string | null {
  const db = getDb();
  const guardian = db.guardians.find((g) => g.id === job.guardian.id);
  if (guardian && (guardian.whatsappConsent === "revoked" || guardian.optedOutAt)) {
    return "This guardian opted out of WhatsApp messages, so nothing can be sent.";
  }
  const invoice = db.invoices.find((i) => i.id === job.invoice.id);
  if (invoice?.status === "void") return "This invoice was voided, so there is nothing to send.";
  if (invoice && invoice.balanceMinor <= 0) return "This invoice is fully paid, so there is nothing to send.";
  return null;
}

function isOwnerPhone(phone: string): boolean {
  const wanted = normalizeLkPhone(phone);
  if (!wanted) return false;
  return getAdmin().users.some((u) => u.role === "owner" && u.phone && normalizeLkPhone(u.phone) === wanted);
}

/** Validate an `HH:mm` send window value. */
function isHhMm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// --- error helpers ----------------------------------------------------------
// These MUST be `MockError`: it is the only error class the shared `ownerOnly`
// guard turns into the API envelope, so a local subclass would surface as an
// unhandled exception instead of a 404/409/422.

/** 409 with the only code the contract names for an illegal message action. */
function messageNotRetryable(message: string): MockError {
  return new MockError("MESSAGE_NOT_RETRYABLE", message, 409);
}

function notFound(message: string): MockError {
  return new MockError("NOT_FOUND", message, 404);
}

/** The same 404 for handlers that return instead of throwing. */
function notFoundResponse(message: string) {
  return err("NOT_FOUND", message, 404);
}

function validation(field: string, issue: string): MockError {
  return new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
    { field, issue },
  ]);
}

let ruleSeq = 0;

export const messagingHandlers = [
  // --- MSG-01/02 ------------------------------------------------------------
  http.get(
    "*/messages",
    ownerOnly(async ({ request }) => {
      await delay(300);
      const sp = new URL(request.url).searchParams;
      const page = intParam(sp.get("page"), 1);
      const pageSize = intParam(sp.get("pageSize"), 20);
      const from = sp.get("from") ?? undefined;
      const to = sp.get("to") ?? undefined;

      const rows = getDb()
        .messages.filter((j) => {
          if (sp.get("status") && j.status !== sp.get("status")) return false;
          if (sp.get("kind") && j.kind !== sp.get("kind")) return false;
          if (sp.get("invoiceId") && j.invoice.id !== sp.get("invoiceId")) return false;
          if (sp.get("guardianId") && j.guardian.id !== sp.get("guardianId")) return false;
          if (sp.get("playerId") && j.player.id !== sp.get("playerId")) return false;
          if (from && j.scheduledFor < from) return false;
          if (to && j.scheduledFor > to) return false;
          return true;
        })
        // Newest first: this is a send log, not a queue (the contract's default
        // sort is just `scheduledFor,createdAt`, so the direction is ours).
        .sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : a.scheduledFor > b.scheduledFor ? -1 : 0))
        .map(listShape);

      return json(pageOf(rows, page, pageSize));
    })
  ),

  http.get(
    "*/messages/:id",
    ownerOnly(async ({ params }) => {
      await delay(250);
      const job = jobById(String(params.id));
      if (!job) return err("NOT_FOUND", "Message not found.", 404);
      return json({ ...job, events: timeline(job), renderedBody: job.renderedBody });
    })
  ),

  // --- MSG-03 retry (Idem) --------------------------------------------------
  http.post(
    "*/messages/:id/retry",
    ownerOnly(async ({ request, params }) => {
      await delay(400);
      return idempotent(request, () => {
        const job = jobById(String(params.id));
        if (!job) throw notFound("Message not found.");
        if (!RETRYABLE.includes(job.status)) {
          throw messageNotRetryable(
            "Only a failed, permanently failed or needs-review message can be retried."
          );
        }
        const reason = retryBlockedReason(job);
        if (reason) throw messageNotRetryable(reason);
        const before = job.status;
        job.status = "queued";
        job.attempts += 1;
        // Never a delivery claim: the queue has not reached the provider yet.
        job.deliveryState = "unknown";
        job.nextAttemptAt = new Date().toISOString();
        job.sentAt = undefined;
        job.lastError = undefined;
        job.events = timeline(job);
        saveDb();
        logAudit({
          action: "messaging.retry",
          entityType: "message",
          entityId: job.id,
          before: { status: before, attempts: job.attempts - 1 },
          after: { status: job.status, attempts: job.attempts },
          actor: actorFor(OWNER_ID),
        });
        return job;
      });
    })
  ),

  // --- MSG-04 cancel --------------------------------------------------------
  http.post(
    "*/messages/:id/cancel",
    ownerOnly(async ({ params }) => {
      await delay(300);
      const job = jobById(String(params.id));
      if (!job) return notFoundResponse("Message not found.");
      if (!CANCELLABLE.includes(job.status)) {
        return err(
          "MESSAGE_NOT_RETRYABLE",
          "Only a queued or failed message can be cancelled — this one has already left the queue.",
          409
        );
      }
      const before = job.status;
      job.status = "cancelled";
      // The contract does not enumerate `skipReason` values (raised in the
      // Step 5 handoff); the UI prints an unknown value verbatim.
      job.skipReason = "CANCELLED_BY_OWNER";
      job.nextAttemptAt = undefined;
      saveDb();
      logAudit({
        action: "messaging.cancel",
        entityType: "message",
        entityId: job.id,
        before: { status: before },
        after: { status: job.status },
        actor: actorFor(OWNER_ID),
      });
      return json({ ...job, events: timeline(job) });
    })
  ),

  // --- MSG-05 manual fallback ----------------------------------------------
  http.post(
    "*/messages/:id/manual-fallback",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const job = jobById(String(params.id));
      if (!job) return notFoundResponse("Message not found.");
      const body = await jsonBody<{ note?: string }>(request).catch(() => ({}) as { note?: string });
      job.status = "sent";
      // The OWNER sent it by hand from their own phone. We have no provider ack,
      // so this may never read "Delivered".
      job.deliveryState = "unknown";
      job.manualFallback = { at: new Date().toISOString(), by: OWNER_ID, note: body.note };
      job.sentAt = job.manualFallback.at;
      job.nextAttemptAt = undefined;
      job.lastError = undefined;
      saveDb();
      logAudit({
        action: "messaging.manual_fallback",
        entityType: "message",
        entityId: job.id,
        reason: body.note,
        after: { status: job.status, deliveryState: job.deliveryState },
        actor: actorFor(OWNER_ID),
      });
      return json({ ...job, events: timeline(job) });
    })
  ),

  // --- MSG-06 status --------------------------------------------------------
  http.get(
    "*/messaging/status",
    ownerOnly(async () => {
      await delay(200);
      return json(messagingStatus());
    })
  ),

  // --- MSG-07 pause / resume ------------------------------------------------
  http.post(
    "*/messaging/pause",
    ownerOnly(async ({ request }) => {
      await delay(300);
      const body = await jsonBody<{ reason?: string }>(request).catch(() => ({}) as { reason?: string });
      return json(setMasterPaused(true, body.reason, actorFor(OWNER_ID)));
    })
  ),

  http.post(
    "*/messaging/resume",
    ownerOnly(async () => {
      await delay(300);
      return json(setMasterPaused(false, undefined, actorFor(OWNER_ID)));
    })
  ),

  // --- MSG-08 test send (Idem) ---------------------------------------------
  http.post(
    "*/messaging/test",
    ownerOnly(async ({ request }) => {
      await delay(400);
      return idempotent(request, async () => {
        const body = await jsonBody<{ phone?: string }>(request);
        const phone = body.phone ?? "";
        if (!normalizeLkPhone(phone)) {
          throw validation("phone", "Enter a Sri Lankan mobile number, e.g. 077 000 0000");
        }
        if (!isOwnerPhone(phone)) {
          // API_CONTRACTS MSG-08: the owner's OWN number only.
          throw validation("phone", "A test message can only go to your own number.");
        }
        const db = getDb();
        db.counters.message += 1;
        const owner = getAdmin().users.find((u) => u.id === OWNER_ID);
        const normalized = normalizeLkPhone(phone)!;
        const digits = normalized.replace(/[^\d]/g, "");
        const job: MessageJob = {
          id: `0192a000-0000-7000-8000-0000000t${String(db.counters.message).padStart(4, "0")}`,
          kind: "test",
          status: db.settings.whatsappSession === "connected" ? "sent" : "queued",
          deliveryState: "unknown",
          // A test send is not tied to an invoice or a player — the contract's
          // MessageJob requires both, which it cannot supply (Step 6 handoff §4).
          invoice: { id: "test", invoiceNumber: "TEST" },
          player: { id: "test", fullName: "Test message" },
          guardian: {
            id: OWNER_ID,
            fullName: owner?.fullName ?? "Owner",
            phoneMasked: `+${digits.slice(0, 3)} ••• ••• ${digits.slice(-2)}`,
          },
          scheduledFor: new Date().toISOString(),
          attempts: 0,
          maxAttempts: 5,
          renderedBody: renderTemplate(
            getAdmin().templates.find((t) => t.key === "invoice_delivery")?.body ?? "",
            SAMPLE_TEMPLATE_VALUES
          ),
        };
        job.events = timeline(job);
        if (job.status === "sent") job.sentAt = job.scheduledFor;
        db.messages.push(job);
        saveDb();
        logAudit({
          action: "messaging.test_send",
          entityType: "message",
          entityId: job.id,
          after: { phoneMasked: job.guardian.phoneMasked, status: job.status },
          actor: actorFor(OWNER_ID),
        });
        return job;
      });
    })
  ),

  // --- SET-05 reminder rules ------------------------------------------------
  http.get(
    "*/settings/reminder-rules",
    ownerOnly(async () => {
      await delay(200);
      return json({ data: getAdmin().reminders });
    })
  ),

  http.post(
    "*/settings/reminder-rules",
    ownerOnly(async ({ request }) => {
      await delay(300);
      const body = await jsonBody<{
        kind?: ReminderRule["kind"];
        offsetDays?: number;
        isActive?: boolean;
      }>(request);
      if (body.kind !== "reminder_pre_due" && body.kind !== "reminder_overdue") {
        throw validation("kind", "Choose pre-due or late reminders.");
      }
      const offsetDays = Number(body.offsetDays);
      if (!Number.isInteger(offsetDays) || offsetDays < 1 || offsetDays > 365) {
        throw validation("offsetDays", "Use a whole number of days between 1 and 365.");
      }
      const store = getAdmin();
      if (store.reminders.some((r) => r.kind === body.kind && r.offsetDays === offsetDays)) {
        // UQ (kind, offsetDays) — API_CONTRACTS SET-05.
        throw validation("offsetDays", "A rule for that reminder and offset already exists.");
      }
      ruleSeq += 1;
      const rule: ReminderRule = {
        id: `rr_new_${ruleSeq}`,
        kind: body.kind,
        offsetDays,
        isActive: body.isActive !== false,
      };
      store.reminders.push(rule);
      saveAdmin();
      logAudit({
        action: "settings.reminder_rule.create",
        entityType: "reminder_rule",
        entityId: rule.id,
        after: { ...rule },
        actor: actorFor(OWNER_ID),
      });
      return json(rule, 201);
    })
  ),

  http.patch(
    "*/settings/reminder-rules/:id",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const id = String(params.id);
      const rule = getAdmin().reminders.find((r) => r.id === id);
      if (!rule) return err("NOT_FOUND", "Reminder rule not found.", 404);
      const body = await jsonBody<Partial<Pick<ReminderRule, "kind" | "offsetDays" | "isActive">>>(
        request
      );
      const nextKind = body.kind ?? rule.kind;
      const nextOffset = body.offsetDays ?? rule.offsetDays;
      if (nextKind !== "reminder_pre_due" && nextKind !== "reminder_overdue") {
        throw validation("kind", "Choose pre-due or late reminders.");
      }
      if (!Number.isInteger(nextOffset) || nextOffset < 1 || nextOffset > 365) {
        throw validation("offsetDays", "Use a whole number of days between 1 and 365.");
      }
      const clash = getAdmin().reminders.some(
        (r) => r.id !== id && r.kind === nextKind && r.offsetDays === nextOffset
      );
      if (clash) throw validation("offsetDays", "A rule for that reminder and offset already exists.");
      const before = { ...rule };
      rule.kind = nextKind;
      rule.offsetDays = nextOffset;
      if (typeof body.isActive === "boolean") rule.isActive = body.isActive;
      saveAdmin();
      logAudit({
        action: "settings.reminder_rule.update",
        entityType: "reminder_rule",
        entityId: rule.id,
        before,
        after: { ...rule },
        actor: actorFor(OWNER_ID),
      });
      return json(rule);
    })
  ),

  http.delete(
    "*/settings/reminder-rules/:id",
    ownerOnly(async ({ params }) => {
      await delay(250);
      const store = getAdmin();
      const index = store.reminders.findIndex((r) => r.id === String(params.id));
      const removed = index >= 0 ? store.reminders[index] : undefined;
      if (!removed) return err("NOT_FOUND", "Reminder rule not found.", 404);
      store.reminders.splice(index, 1);
      saveAdmin();
      logAudit({
        action: "settings.reminder_rule.delete",
        entityType: "reminder_rule",
        entityId: removed.id,
        before: { ...removed },
        actor: actorFor(OWNER_ID),
      });
      return json({ ok: true, id: removed.id });
    })
  ),

  // --- SET-06 message templates --------------------------------------------
  http.get(
    "*/settings/message-templates",
    ownerOnly(async () => {
      await delay(200);
      return json({ data: getAdmin().templates });
    })
  ),

  http.put(
    "*/settings/message-templates/:key",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const key = String(params.key);
      const template = getAdmin().templates.find((t) => t.key === key);
      if (!template) return err("NOT_FOUND", "That template does not exist.", 404);
      const body = await jsonBody<{ body?: string }>(request);
      const text = (body.body ?? "").trim();
      if (text.length === 0) throw validation("body", "The template cannot be empty.");
      if (text.length > 1000) throw validation("body", "Keep the template under 1000 characters.");
      // Unknown {{vars}} are a 422 in the contract, never silently stripped.
      const allowed = template.variables;
      const unknown = templateVars(text).filter((v) => !allowed.includes(v));
      if (unknown.length > 0) {
        throw validation(
          "body",
          `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown
            .map((v) => `{{${v}}}`)
            .join(", ")}. Use one of: ${allowed.map((v) => `{{${v}}}`).join(", ")}.`
        );
      }
      const before = template.body;
      template.body = text;
      template.preview = renderTemplate(text, SAMPLE_TEMPLATE_VALUES);
      saveAdmin();
      logAudit({
        action: "settings.message_template.update",
        entityType: "message_template",
        entityId: template.key,
        before: { body: before },
        after: { body: text },
        actor: actorFor(OWNER_ID),
      });
      return json(template);
    })
  ),

  // --- SET-07 messaging settings -------------------------------------------
  http.get(
    "*/settings/messaging",
    ownerOnly(async () => {
      await delay(200);
      return json(getAdmin().messaging);
    })
  ),

  http.patch(
    "*/settings/messaging",
    ownerOnly(async ({ request }) => {
      await delay(400);
      const body = await jsonBody<Record<string, unknown>>(request);
      const store = getAdmin();
      const before = { ...store.messaging };
      const next = { ...store.messaging };

      if (typeof body.sendWindowStart === "string" || typeof body.sendWindowEnd === "string") {
        const start = typeof body.sendWindowStart === "string" ? body.sendWindowStart : next.sendWindowStart;
        const end = typeof body.sendWindowEnd === "string" ? body.sendWindowEnd : next.sendWindowEnd;
        if (!isHhMm(start) || !isHhMm(end)) {
          throw validation("sendWindowStart", "Use a 24-hour time like 08:00.");
        }
        if (start >= end) {
          throw validation("sendWindowEnd", "The window has to end after it starts.");
        }
        next.sendWindowStart = start;
        next.sendWindowEnd = end;
      }

      if (typeof body.invoiceMode === "string") {
        if (body.invoiceMode === "attachment_and_link") {
          // Contract: rejected 422 until a passing spike-S1 media test. OpenWA is
          // MIT with no paid tier — the capability must be PROVEN, not bought.
          return err(
            "VALIDATION_ERROR",
            "Attaching the invoice PDF is not available yet: sending documents on the deployed engine has not passed its test (spike S1). Invoices go out as a link for now.",
            422,
            [{ field: "invoiceMode", issue: "Unavailable until the media test passes (spike S1)" }]
          );
        }
        if (body.invoiceMode !== "link") {
          throw validation("invoiceMode", "Choose link or attachment and link.");
        }
        next.invoiceMode = "link";
      }

      if (body.pacingMinSeconds !== undefined || body.pacingMaxSeconds !== undefined) {
        const min = Number(body.pacingMinSeconds ?? next.pacingMinSeconds);
        const max = Number(body.pacingMaxSeconds ?? next.pacingMaxSeconds);
        if (!Number.isFinite(min) || min < 1) throw validation("pacingMinSeconds", "Use at least 1 second.");
        if (!Number.isFinite(max) || max < 1) throw validation("pacingMaxSeconds", "Use at least 1 second.");
        if (min > max) {
          throw validation("pacingMaxSeconds", "The longest gap cannot be shorter than the shortest gap.");
        }
        next.pacingMinSeconds = Math.floor(min);
        next.pacingMaxSeconds = Math.floor(max);
      }

      if (body.maxPerHour !== undefined) {
        const maxPerHour = Number(body.maxPerHour);
        if (!Number.isFinite(maxPerHour) || maxPerHour < 1) {
          throw validation("maxPerHour", "Send at least one message per hour.");
        }
        next.maxPerHour = Math.floor(maxPerHour);
      }

      if (body.optOutKeywords !== undefined) {
        if (!Array.isArray(body.optOutKeywords)) {
          throw validation("optOutKeywords", "List the opt-out keywords one per line.");
        }
        const keywords = body.optOutKeywords
          .map((k) => String(k).trim().toUpperCase())
          .filter((k) => k.length > 0);
        if (keywords.length === 0) {
          throw validation("optOutKeywords", "Keep at least one opt-out keyword — consent needs a way out.");
        }
        next.optOutKeywords = Array.from(new Set(keywords));
      }

      store.messaging = next;
      saveAdmin();
      logAudit({
        action: "settings.messaging.update",
        entityType: "settings",
        entityId: "messaging",
        before,
        after: { ...next },
        actor: actorFor(OWNER_ID),
      });
      return json(next);
    })
  ),

  // --- SET-08 per-automation switches (CR-003) ------------------------------
  http.get(
    "*/settings/automations",
    ownerOnly(async () => {
      await delay(200);
      const store = getAdmin();
      return json({ ...store.automations, masterPaused: store.masterPaused });
    })
  ),

  http.patch(
    "*/settings/automations",
    ownerOnly(async ({ request }) => {
      await delay(350);
      const body = await jsonBody<Record<string, unknown>>(request);
      const keys = ["invoiceDelivery", "reminderPreDue", "reminderOverdue", "proofCheck"] as const;
      const patch: Partial<Record<(typeof keys)[number], boolean>> = {};
      for (const key of keys) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== "boolean") {
          throw validation(key, "This switch only takes on or off.");
        }
        patch[key] = body[key] as boolean;
      }
      if (Object.keys(patch).length === 0) {
        throw validation("invoiceDelivery", "Nothing to change.");
      }
      // `patchAutomations` also cancels the disabled kind's unsent jobs
      // (`AUTOMATION_DISABLED`) and never back-fills on re-enable.
      return json(patchAutomations(patch, actorFor(OWNER_ID)));
    })
  ),
];

