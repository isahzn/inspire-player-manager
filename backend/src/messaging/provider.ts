/**
 * The messaging port (ADR-007). Domain code depends on this interface only; only an
 * adapter may know a provider's paths, headers or status strings.
 *
 * ADR-017: the provider is OpenWA. Its session/delivery semantics are unconfirmed
 * (OPENWA_INTEGRATION §2, O18–O22) until spike S1, so the real adapter is not built in
 * M2 — the factory refuses to start with `MESSAGING_PROVIDER=openwa` rather than
 * pretending to send. Every automated test uses the mock provider, which the spec makes
 * a first-class implementation.
 */
import type { SessionStatusLabel } from "../../spec/components.js";
import { config } from "../config.js";
import { createMockProvider, type MockProvider } from "./mock.js";

export interface NormalizedEvent {
  kind: "ack" | "session" | "inbound";
  providerMessageId?: string;
  /** Provider-native ack: do not assume a numeric enum (O19). */
  ack?: number;
  sessionStatus?: SessionStatusLabel;
  fromE164?: string;
  text?: string;
  occurredAt: string;
}

export interface SendResult {
  providerMessageId: string;
  acceptedAt: string;
}

export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface ProviderHealth {
  status: ProviderHealthStatus;
  detail?: string;
  checkedAt: string;
}

export interface MessagingProvider {
  readonly name: string;
  sendText(toE164: string, body: string, clientRef?: string): Promise<SendResult>;
  sendDocument(toE164: string, fileRef: string, caption?: string): Promise<SendResult>;
  getHealth(): Promise<ProviderHealth>;
  /**
   * Verifies the provider signature **before** parsing and returns normalized events.
   * A bad signature, a missing one or an oversized body must throw — never return [].
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): NormalizedEvent[];
}

let provider: MessagingProvider | undefined;

/** Process-wide provider instance (worker/API share one). */
export function messagingProvider(): MessagingProvider {
  if (provider) return provider;
  switch (config.messagingProvider) {
    case "mock":
      provider = createMockProvider();
      return provider;
    case "openwa":
      throw new Error(
        "MESSAGING_PROVIDER=openwa is not available yet: the OpenWA adapter lands in M7, after spike S1 " +
          "records O18–O22 (OPENWA_INTEGRATION §2). Use MESSAGING_PROVIDER=mock.",
      );
    default:
      throw new Error(`unknown MESSAGING_PROVIDER "${config.messagingProvider}"`);
  }
}

export function setMessagingProvider(next: MessagingProvider | undefined): void {
  provider = next;
}

export function mockProvider(): MockProvider {
  const current = messagingProvider();
  if (current.name !== "mock") throw new Error("the active provider is not the mock");
  return current as MockProvider;
}
