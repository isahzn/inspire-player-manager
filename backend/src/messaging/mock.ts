/**
 * Mock messaging provider (BACKEND_BUILD_GUIDE §7: a first-class implementation, used by
 * every automated test). It records what would have been sent and can be told to fail,
 * so retry/backoff/needs-review behaviour is testable without a real WhatsApp session.
 *
 * It never produces `device_delivered`/`read`: until spike S1 confirms OpenWA's ack
 * semantics, no code path may claim delivery (T-MSG-06).
 */
import type {
  MessagingProvider,
  NormalizedEvent,
  ProviderHealth,
  SendResult,
} from "./provider.js";

export interface SentMessage {
  toE164: string;
  body: string;
  kind: "text" | "document";
  clientRef?: string;
  at: string;
}

export interface MockProvider extends MessagingProvider {
  readonly sent: SentMessage[];
  reset(): void;
  /** Makes every send fail with the given classification until cleared. */
  failNext(count: number, behaviour?: "throw" | "timeout"): void;
  /** Simulates a provider disconnect (health) without failing sends. */
  setHealth(health: ProviderHealth): void;
  /** Queues a webhook payload to be returned by `verifyAndParseWebhook`. */
  queueEvents(events: NormalizedEvent[]): void;
}

export function createMockProvider(): MockProvider {
  const sent: SentMessage[] = [];
  let failures = 0;
  let failureBehaviour: "throw" | "timeout" = "throw";
  let health: ProviderHealth = {
    status: "healthy",
    checkedAt: new Date().toISOString(),
  };
  let queuedEvents: NormalizedEvent[] = [];
  let counter = 0;

  return {
    name: "mock",
    sent,
    reset() {
      sent.length = 0;
      failures = 0;
      queuedEvents = [];
      counter = 0;
      health = { status: "healthy", checkedAt: new Date().toISOString() };
    },
    failNext(count, behaviour = "throw") {
      failures = count;
      failureBehaviour = behaviour;
    },
    setHealth(next) {
      health = next;
    },
    queueEvents(events) {
      queuedEvents = events;
    },
    async sendText(toE164, body, clientRef): Promise<SendResult> {
      if (failures > 0) {
        failures -= 1;
        if (failureBehaviour === "timeout") {
          // "Request may have been sent, no response" — the case that must become
          // needs_review rather than an automatic resend (T-MSG-03/04).
          throw Object.assign(new Error("mock timeout"), { code: "ETIMEDOUT" });
        }
        throw Object.assign(new Error("mock connection refused"), { code: "ECONNREFUSED" });
      }
      counter += 1;
      const at = new Date().toISOString();
      sent.push({ toE164, body, kind: "text", ...(clientRef ? { clientRef } : {}), at });
      return { providerMessageId: `mock-${counter}`, acceptedAt: at };
    },
    async sendDocument(toE164, fileRef, caption): Promise<SendResult> {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("mock connection refused"), { code: "ECONNREFUSED" });
      }
      counter += 1;
      const at = new Date().toISOString();
      sent.push({
        toE164,
        body: caption ?? fileRef,
        kind: "document",
        clientRef: fileRef,
        at,
      });
      return { providerMessageId: `mock-${counter}`, acceptedAt: at };
    },
    async getHealth(): Promise<ProviderHealth> {
      return health;
    },
    verifyAndParseWebhook(): NormalizedEvent[] {
      const events = queuedEvents;
      queuedEvents = [];
      return events;
    },
  };
}
