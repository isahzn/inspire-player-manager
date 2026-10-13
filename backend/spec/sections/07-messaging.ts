/**
 * API_CONTRACTS §3.7 — the WhatsApp surface (MSG-01..08) and the provider webhook.
 *
 * Two rules this section is built around:
 *  - **Honesty about delivery:** `deliveryState` may only become
 *    `device_delivered`/`read` from a provider-reported ack. Until spike S1 records
 *    OpenWA's ack semantics (O19) the adapter emits `server_accepted`/`unknown`
 *    only, so the UI can never claim "Delivered" on an assumption.
 *  - **The master pause is not the automation switches:** MSG-07 stops everything;
 *    SET-08 switches each kind off individually (CR-003/ADR-019). WHK-01 is signed,
 *    not authenticated as a user: it has no role and no permission.
 */
import { endpoint, section, res, z, type Section } from "../registry.js";
import { Id, Instant, MessageJob, MessagingStatus, pageOf, pageQuery, sortParam } from "../components.js";

const idParam = z.object({ id: Id });

const messageStatus = z.enum([
  "queued",
  "sending",
  "sent",
  "failed",
  "dead",
  "needs_review",
  "cancelled",
  "skipped",
]);
const messageKind = z.enum([
  "invoice_delivery",
  "reminder_pre_due",
  "reminder_overdue",
  "test",
]);

export const messagingSection: Section = section("3.7 Messaging (WhatsApp)", [
  endpoint({
    id: "MSG-01",
    method: "get",
    path: "/messages",
    auth: "owner",
    permission: "messaging:manage",
    scope: "No coach policy on message jobs — RLS denies the role",
    summary: "List message jobs",
    description:
      "The queue and the owner-visible log are the same rows, so a job's current state is never guessed from a separate log.",
    tags: ["Messaging"],
    query: pageQuery.extend({
      status: messageStatus.optional(),
      kind: messageKind.optional(),
      invoiceId: Id.optional(),
      guardianId: Id.optional(),
      playerId: Id.optional(),
      from: Instant.optional(),
      to: Instant.optional(),
      sort: sortParam.describe("scheduledFor | createdAt"),
    }),
    responses: [res.json(200, pageOf(MessageJob), "One page of message jobs")],
    errors: ["INVALID_SORT"],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-02",
    method: "get",
    path: "/messages/{id}",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Read a message job with its event history",
    description:
      "Includes `renderedBody` (the text actually sent, snapshotted at send time) and the append-only `events`.",
    tags: ["Messaging"],
    params: idParam,
    responses: [res.json(200, MessageJob, "The job, its rendered body and its events")],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-03",
    method: "post",
    path: "/messages/{id}/retry",
    auth: "owner",
    permission: "messaging:manage",
    idempotent: true,
    mutating: true,
    audit: "message.retry",
    summary: "Retry a failed message",
    description:
      "Only `failed`, `dead` or `needs_review` can be retried, and the pre-send checks run again: consent, invoice state (paid/void) and phone presence are re-evaluated, so a retry can legitimately end as `skipped`. Resets the attempt counter.",
    tags: ["Messaging"],
    params: idParam,
    responses: [res.json(200, MessageJob, "The requeued job")],
    errors: ["MESSAGE_NOT_RETRYABLE", "INVALID_STATE_TRANSITION"],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-04",
    method: "post",
    path: "/messages/{id}/cancel",
    auth: "owner",
    permission: "messaging:manage",
    mutating: true,
    audit: "message.cancel",
    summary: "Cancel a queued or failed message",
    description: "Only `queued` or `failed` can be cancelled — a job already accepted by the provider cannot be unsent.",
    tags: ["Messaging"],
    params: idParam,
    responses: [res.json(200, MessageJob, "The cancelled job")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-05",
    method: "post",
    path: "/messages/{id}/manual-fallback",
    auth: "owner",
    permission: "messaging:manage",
    mutating: true,
    audit: "message.manual_fallback",
    summary: "Mark a message as sent manually",
    description:
      "Records that the owner contacted the guardian themselves and stops automation for that job. This is the escape hatch that keeps a messaging outage from ever blocking billing (OPENWA §10).",
    tags: ["Messaging"],
    params: idParam,
    body: z.strictObject({ note: z.string().max(500).optional() }),
    responses: [res.json(200, MessageJob, "The job marked as handled manually")],
    errors: ["INVALID_STATE_TRANSITION"],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-06",
    method: "get",
    path: "/messaging/status",
    auth: "owner",
    permission: "messaging:manage",
    summary: "Provider, session and queue status",
    description:
      "`session.status` is OUR normalized label set; OpenWA's own lifecycle strings are unconfirmed until spike S1 (O18, OPENWA §2), and anything unrecognized maps to `unknown` rather than being passed through.",
    tags: ["Messaging"],
    responses: [res.json(200, MessagingStatus, "Current messaging status")],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-07",
    operationId: "MSG-07.pause",
    method: "post",
    path: "/messaging/pause",
    auth: "owner",
    permission: "messaging:manage",
    mutating: true,
    audit: "messaging.pause",
    summary: "Pause all automation (master switch)",
    description:
      "The master switch: while paused the worker claims nothing, whatever the SET-08 per-automation flags say. Queued jobs stay queued rather than being cancelled, so resuming continues where it stopped.",
    tags: ["Messaging"],
    body: z.strictObject({ reason: z.string().max(200).optional() }),
    responses: [res.json(200, MessagingStatus, "Status with automation disabled")],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-07",
    operationId: "MSG-07.resume",
    method: "post",
    path: "/messaging/resume",
    auth: "owner",
    permission: "messaging:manage",
    mutating: true,
    audit: "messaging.resume",
    summary: "Resume automation",
    description:
      "Resuming does not back-fill: reminders missed while paused are not retro-enqueued (they would otherwise arrive as a burst).",
    tags: ["Messaging"],
    body: z.strictObject({ reason: z.string().max(200).optional() }),
    responses: [res.json(200, MessagingStatus, "Status with automation enabled")],
    milestone: "m7",
  }),

  endpoint({
    id: "MSG-08",
    method: "post",
    path: "/messaging/test",
    auth: "owner",
    permission: "messaging:manage",
    idempotent: true,
    mutating: true,
    audit: "messaging.test_send",
    summary: "Send a test message to the owner's own number",
    description:
      "The only safe way to verify a linked session: `phone` must equal an owner user's phone, so a test can never message a guardian. Returns a `test`-kind job whose delivery state follows the same ack rules as any other message.",
    tags: ["Messaging"],
    body: z.strictObject({ phone: z.string() }),
    responses: [res.json(200, MessageJob, "The test job")],
    errors: ["VALIDATION_ERROR", "INVALID_STATE_TRANSITION"],
    milestone: "m7",
  }),

  // -------------------------------------------------------------------------
  // Provider webhook (WHK-01)
  // -------------------------------------------------------------------------
  endpoint({
    id: "WHK-01",
    method: "post",
    path: "/webhooks/openwa",
    auth: "webhook_hmac",
    summary: "Provider event webhook",
    description:
      "Not a user route: authenticated by the `X-OpenWA-Signature` HMAC-SHA256 over the exact raw body, compared constant-time **before** JSON parsing, with a 256 KB body cap and an IP allow-list in front. Repeats of a `X-OpenWA-Delivery-Id` are deduped (OpenWA retries automatically and may deliver out of order), `X-OpenWA-Retry-Count` is logged, and an unknown event type is acknowledged with 204 rather than failing. Inbound text is never stored — only the exact configured opt-out keywords from a known guardian number are acted on. Delivery state is updated monotonically, so an out-of-order event can never lower it.",
    tags: ["Messaging"],
    mutating: true,
    rateLimit: "webhook",
    body: z.object({
      event: z.string().optional(),
      sessionId: z.string().optional(),
      messageId: z.string().optional(),
      ack: z.number().optional(),
      from: z.string().optional(),
      body: z.string().optional(),
    }),
    responses: [res.empty(204, "Accepted; nothing to report")],
    errors: ["INTERNAL_ERROR"],
    milestone: "m7",
  }),
]);
