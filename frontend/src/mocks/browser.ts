"use client";

// Starts the MSW browser worker when NEXT_PUBLIC_USE_MOCKS=true.
// Unhandled requests bypass (Next.js internals, fonts, RSC).
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

let started = false;

export async function startMocks() {
  if (started) return;
  if (process.env.NEXT_PUBLIC_USE_MOCKS !== "true") return;
  started = true;
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
}
