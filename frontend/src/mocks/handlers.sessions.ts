"use client";

// MSW handlers for the training slice (Step 4): sessions (SES), player
// attendance (ATT) and coach check-in/out (CAT). Every response is the contract
// shape; every failure is the exact error envelope + code from API_CONTRACTS
// §1.1. Authorization mirrors the server: unauthenticated ⇒ 401, coach on an
// owner route ⇒ 403, coach outside their assigned groups ⇒ 404.
import { delay, http } from "msw";
import type { AttendanceRecordInput, AttendanceStatus, SessionStatus } from "@/api/types";
import * as db from "./db";
import { MockError } from "./db";
import { authed, idempotent, json, jsonBody, ownerOnly } from "./http";
import { err } from "./session";

const STATUSES: AttendanceStatus[] = ["present", "absent", "late", "excused"];

export const sessionHandlers = [
  // --- SES-01/02 ----------------------------------------------------------
  http.get(
    "*/sessions",
    authed(async ({ request, viewer }) => {
      await delay(300);
      const sp = new URL(request.url).searchParams;
      const status = sp.get("status") ?? undefined;
      if (status && !["scheduled", "completed", "cancelled"].includes(status)) {
        return err("VALIDATION_ERROR", "Unknown status filter.", 422, [
          { field: "status", issue: "Use scheduled, completed or cancelled" },
        ]);
      }
      return json(
        db.listSessions(
          {
            from: sp.get("from") ?? undefined,
            to: sp.get("to") ?? undefined,
            ageGroupId: sp.get("ageGroupId") ?? undefined,
            status: (status as SessionStatus | undefined) ?? undefined,
          },
          viewer
        )
      );
    })
  ),

  http.post(
    "*/sessions",
    ownerOnly(async ({ request }) => {
      await delay(400);
      return json(db.createSession(await jsonBody(request)), 201);
    })
  ),

  // --- SES-03/04 ----------------------------------------------------------
  http.get(
    "*/sessions/:id",
    authed(async ({ params, viewer }) => {
      await delay(250);
      const session = db.getSessionFor(String(params.id), viewer);
      // An out-of-scope coach gets the same answer as a missing id.
      if (!session) return err("NOT_FOUND", "Session not found.", 404);
      return json(session);
    })
  ),

  http.post(
    "*/sessions/:id/cancel",
    ownerOnly(async ({ request, params }) => {
      await delay(400);
      const body = await jsonBody<{ reason: string }>(request);
      return json(db.cancelSession(String(params.id), body.reason));
    })
  ),

  // --- ATT-01 -------------------------------------------------------------
  http.get(
    "*/sessions/:id/attendance",
    authed(async ({ params, viewer }) => {
      await delay(350);
      const payload = db.sessionAttendanceFor(String(params.id), viewer);
      if (!payload) return err("NOT_FOUND", "Session not found.", 404);
      return json(payload);
    })
  ),

  // --- ATT-02 (Idem: the draft id is the key, so a retry cannot duplicate) --
  http.put(
    "*/sessions/:id/attendance",
    authed(async ({ request, params, viewer }) => {
      await delay(500);
      const sessionId = String(params.id);
      return idempotent(request, async () => {
        const body = await jsonBody<{ records?: AttendanceRecordInput[] }>(request);
        const records = Array.isArray(body.records) ? body.records : [];
        if (records.length === 0) {
          throw new MockError("VALIDATION_ERROR", "No attendance records were sent.", 422, [
            { field: "records", issue: "At least one record is required" },
          ]);
        }
        for (const rec of records) {
          if (!rec.playerId || !STATUSES.includes(rec.status)) {
            throw new MockError("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
              { field: rec.playerId ?? "records", issue: "Each record needs a player and a valid status" },
            ]);
          }
        }
        // Throwing (not returning) on failure is deliberate: `idempotent` only
        // replays SAVED results, so a failed attempt must not poison the key.
        return db.saveAttendance(sessionId, records, viewer);
      });
    })
  ),

  // --- ATT-03 -------------------------------------------------------------
  http.patch(
    "*/sessions/:id/attendance/:playerId",
    authed(async ({ request, params, viewer }) => {
      await delay(400);
      const body = await jsonBody<{
        status?: AttendanceStatus;
        note?: string;
        reason: string;
        version: number;
      }>(request);
      if (body.version === undefined) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "version", issue: "Send the record version you are changing" },
        ]);
      }
      return json(
        db.patchAttendance(String(params.id), String(params.playerId), body, viewer)
      );
    })
  ),

  // --- CAT-01/02: check-in and check-out ----------------------------------
  // The client sends no times; the mock stamps them from its own clock
  // (ATTENDANCE §4). The check-in bar reads its state back from here.
  http.post(
    "*/coach-attendance/check-in",
    authed(async ({ request, viewer }) => {
      await delay(400);
      const body = await jsonBody<{ sessionId: string; note?: string }>(request);
      if (!body.sessionId) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "sessionId", issue: "Choose a session" },
        ]);
      }
      return json(db.checkIn(body.sessionId, body.note, viewer), 201);
    })
  ),

  http.post(
    "*/coach-attendance/check-out",
    authed(async ({ request, viewer }) => {
      await delay(400);
      const body = await jsonBody<{ sessionId: string }>(request);
      if (!body.sessionId) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "sessionId", issue: "Choose a session" },
        ]);
      }
      return json(db.checkOut(body.sessionId, viewer));
    })
  ),

  // --- CAT-03 -------------------------------------------------------------
  http.get(
    "*/coach-attendance",
    authed(async ({ request, viewer }) => {
      await delay(300);
      const sp = new URL(request.url).searchParams;
      if (viewer.role === "coach") {
        // A coach asking for someone else's log is a scope violation, not an
        // empty list: `coachUserId` is owner-only (C*).
        const asked = sp.get("coachUserId");
        if (asked && asked !== viewer.userId) {
          return err("FORBIDDEN", "Owners only.", 403);
        }
      }
      return json(
        db.listCoachAttendance(
          {
            from: sp.get("from") ?? undefined,
            to: sp.get("to") ?? undefined,
            coachUserId: sp.get("coachUserId") ?? undefined,
          },
          viewer
        )
      );
    })
  ),

  // --- CAT-04 -------------------------------------------------------------
  http.post(
    "*/coach-attendance",
    ownerOnly(async ({ request }) => {
      await delay(450);
      return json(db.createCoachAttendanceEntry(await jsonBody(request)), 201);
    })
  ),

  // --- CAT-05 -------------------------------------------------------------
  http.patch(
    "*/coach-attendance/:id",
    ownerOnly(async ({ request, params }) => {
      await delay(450);
      const body = await jsonBody<{
        checkInAt?: string;
        checkOutAt?: string | null;
        reason: string;
        version: number;
      }>(request);
      return json(db.patchCoachAttendance(String(params.id), body));
    })
  ),
];
