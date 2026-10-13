"use client";

// Unsent attendance drafts, per ADR-011: the v1 API is online-only, but the
// sheet must not lose a coach's marks when the network drops at the pitch. The
// draft is keyed by session, kept for 24 h, and it carries its own
// `Idempotency-Key` so a retry is replayed by the server instead of duplicating
// records (ATTENDANCE §3). `auth.tsx` clears everything under this prefix on
// sign-out, so a shared phone never leaves a draft behind.
import type { AttendanceStatus } from "@/api/types";
import { idempotencyKey } from "@/api/client";

export interface DraftRow {
  /** `null` = unmarked. */
  status: AttendanceStatus | null;
  note?: string;
  reason?: string;
}

export interface StoredDraft {
  key: string;
  savedAt: string;
  records: Record<string, DraftRow>;
}

const PREFIX = "ia-attendance-draft:";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function loadDraft(sessionId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed?.key || !parsed.records) return null;
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) {
      localStorage.removeItem(`${PREFIX}${sessionId}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(
  sessionId: string,
  records: StoredDraft["records"],
  key: string
): StoredDraft {
  const draft: StoredDraft = { key, savedAt: new Date().toISOString(), records };
  try {
    localStorage.setItem(`${PREFIX}${sessionId}`, JSON.stringify(draft));
  } catch {
    // Storage unavailable (private mode): the draft lives in memory only.
  }
  return draft;
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(`${PREFIX}${sessionId}`);
  } catch {
    // ignore
  }
}

/** The draft's idempotency key, or a fresh one when there is no draft yet. */
export function draftKey(sessionId: string, current?: string | null): string {
  if (current) return current;
  return loadDraft(sessionId)?.key ?? idempotencyKey();
}
