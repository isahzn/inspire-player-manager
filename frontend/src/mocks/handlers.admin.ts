"use client";

// MSW handlers for the admin slice (Step 8): users (USR-01..05), the full
// academy settings (SET-01), branding logo upload (SET-03), payment-method
// writes (SET-04), the audit trail (AUD-01) and system health (SYS-03).
//
// Every response is the contract shape and every failure is the exact envelope +
// code from API_CONTRACTS §1.1; every mutation is audited through
// `store678.logAudit`, so AUD-01 shows real history instead of a frozen fixture.
//
// Ownership notes (MSW resolves with the FIRST registered match, and this slice
// is registered BEFORE the billing slice in `handlers.ts`):
//  · `GET /settings/academy` is served HERE and returns the FULL
//    `AcademySettings`. The money screens read the same route through
//    `set01GetAcademyPaymentSettings` (a subset type), so the response must keep
//    `name`, `paymentInstructions` and `beneficiaryAccounts` sourced from
//    `db.settings` — the row the billing slice and the AppShell already read.
//  · `GET /settings/billing` and `GET /settings/payment-methods` stay with the
//    billing slice; only the WRITES are added here.
//  · `POST /users` (USR-02) stays with the people slice (it also creates the
//    coach assignment rows); this worker added one line there so an invited user
//    also lands in `store678.users`, which is the list `/users` reads.
import { delay, http } from "msw";
import type { AcademySettings, AuditEntry, PaymentMethod, SystemHealth, User } from "@/api/types";
import { OWNER_ID, getDb, saveDb } from "./db";
import { ownerOnly, json, jsonBody } from "./http";
import { err } from "./session";
import { actorFor, getAdmin, logAudit, saveAdmin, setLogo } from "./store678";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const ACADEMY_FIELDS: (keyof AcademySettings)[] = [
  "name",
  "address",
  "phone",
  "email",
  "paymentInstructions",
  "timezone",
  "ageReferenceRule",
  "ageReferenceMonthDay",
  "coachCanSeeGuardianPhone",
  "attendanceCoachEditWindowHours",
  "coachCheckinOpensMinutesBefore",
  "coachCheckinClosesMinutesAfterEnd",
  "invoiceLinkTtlDays",
];

function paginate<T>(rows: T[], page: number, pageSize: number) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (Math.min(Math.max(page, 1), totalPages) - 1) * pageSize;
  return {
    data: rows.slice(start, start + pageSize),
    meta: { page: Math.min(Math.max(page, 1), totalPages), pageSize, total, totalPages },
  };
}

function inviteUrl(): { inviteUrl: string; inviteExpiresAt: string } {
  return {
    inviteUrl: `https://app.inspireacademy.lk/accept-invite?token=${crypto.randomUUID()}`,
    inviteExpiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
  };
}

/** `LAST_OWNER`: the academy must always keep one active owner (USR-03/04). */
function activeOwners(users: User[]): User[] {
  return users.filter((u) => u.role === "owner" && u.status === "active");
}

/**
 * The academy row is split across two mock stores: `db.settings` holds the
 * identity/payment fields the money slice and the AppShell read, `store678`
 * holds the full SET-01 set. One response merges them so both readers agree.
 */
function fullAcademySettings(): AcademySettings {
  const s = getDb().settings;
  return {
    ...getAdmin().academy,
    name: s.academyName,
    paymentInstructions: s.paymentInstructions,
    beneficiaryAccounts: s.beneficiaryAccounts,
  };
}

export const adminHandlers = [
  // --- USR-01 .. USR-05 -----------------------------------------------------
  http.get(
    "*/users",
    ownerOnly(async ({ request }) => {
      await delay(250);
      const sp = new URL(request.url).searchParams;
      const role = sp.get("role");
      const status = sp.get("status");
      const q = (sp.get("q") ?? "").trim().toLowerCase();
      let rows = [...getAdmin().users];
      if (role === "owner" || role === "coach") rows = rows.filter((u) => u.role === role);
      if (status && ["invited", "active", "disabled"].includes(status)) {
        rows = rows.filter((u) => u.status === status);
      }
      if (q) {
        rows = rows.filter(
          (u) =>
            u.fullName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
        );
      }
      rows.sort((a, b) => a.fullName.localeCompare(b.fullName));
      return json(
        paginate(rows, Number(sp.get("page") ?? 1), Number(sp.get("pageSize") ?? 25))
      );
    })
  ),

  http.get(
    "*/users/:id",
    ownerOnly(async ({ params }) => {
      await delay(200);
      const user = getAdmin().users.find((u) => u.id === String(params.id));
      if (!user) return err("NOT_FOUND", "User not found.", 404);
      return json(user);
    })
  ),

  http.patch(
    "*/users/:id",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const id = String(params.id);
      const body = await jsonBody<{
        fullName?: string;
        phone?: string;
        role?: "owner" | "coach";
        username?: string;
      }>(request);
      // ADR-018: the username is the handle of record and cannot be edited; a
      // change means re-inviting. Refuse rather than ignore it silently.
      if (body.username !== undefined) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          {
            field: "username",
            issue: "A username cannot be edited — invite the person again with the new username",
          },
        ]);
      }
      const users = getAdmin().users;
      const user = users.find((u) => u.id === id);
      if (!user) return err("NOT_FOUND", "User not found.", 404);
      if (body.fullName !== undefined && (body.fullName.trim().length < 2 || body.fullName.trim().length > 120)) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "fullName", issue: "Use 2–120 characters" },
        ]);
      }
      if (body.role !== undefined && !["owner", "coach"].includes(body.role)) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "role", issue: "Use owner or coach" },
        ]);
      }
      if (
        body.role === "coach" &&
        user.role === "owner" &&
        user.status === "active" &&
        activeOwners(users).length <= 1
      ) {
        return err(
          "LAST_OWNER",
          "This is the only active owner — promote another owner first.",
          409
        );
      }
      const before = { ...user };
      if (body.fullName !== undefined) user.fullName = body.fullName.trim();
      if (body.phone !== undefined) user.phone = body.phone;
      if (body.role !== undefined) user.role = body.role;
      saveAdmin();
      logAudit({
        action: "user.update",
        entityType: "user",
        entityId: user.id,
        before,
        after: { ...user },
        actor: actorFor(OWNER_ID),
      });
      return json(user);
    })
  ),

  http.post(
    "*/users/:id/disable",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const id = String(params.id);
      const body = await jsonBody<{ reason?: string }>(request).catch(() => ({ reason: undefined }));
      const users = getAdmin().users;
      const user = users.find((u) => u.id === id);
      if (!user) return err("NOT_FOUND", "User not found.", 404);
      if (user.role === "owner" && user.status === "active" && activeOwners(users).length <= 1) {
        return err(
          "LAST_OWNER",
          "This is the only active owner — promote another owner first.",
          409
        );
      }
      const before = { ...user };
      user.status = "disabled";
      saveAdmin();
      // Disabling revokes the user's sessions on the server; a disabled user
      // cannot sign in, so there is nothing to revoke in this mock.
      logAudit({
        action: "user.disable",
        entityType: "user",
        entityId: user.id,
        reason: body.reason,
        before,
        after: { ...user },
        actor: actorFor(OWNER_ID),
      });
      return json(user);
    })
  ),

  http.post(
    "*/users/:id/enable",
    ownerOnly(async ({ params }) => {
      await delay(300);
      const user = getAdmin().users.find((u) => u.id === String(params.id));
      if (!user) return err("NOT_FOUND", "User not found.", 404);
      const before = { ...user };
      user.status = user.status === "invited" ? "invited" : "active";
      saveAdmin();
      logAudit({
        action: "user.enable",
        entityType: "user",
        entityId: user.id,
        before,
        after: { ...user },
        actor: actorFor(OWNER_ID),
      });
      return json(user);
    })
  ),

  http.post(
    "*/users/:id/reset-password",
    ownerOnly(async ({ params }) => {
      await delay(350);
      const user = getAdmin().users.find((u) => u.id === String(params.id));
      if (!user) return err("NOT_FOUND", "User not found.", 404);
      const next = inviteUrl();
      logAudit({
        action: "user.reset_password",
        entityType: "user",
        entityId: user.id,
        after: { inviteExpiresAt: next.inviteExpiresAt },
        actor: actorFor(OWNER_ID),
      });
      return json(next);
    })
  ),

  // --- SET-01 academy settings (full) --------------------------------------
  http.get(
    "*/settings/academy",
    ownerOnly(async () => {
      await delay(200);
      return json(fullAcademySettings());
    })
  ),

  http.patch(
    "*/settings/academy",
    ownerOnly(async ({ request }) => {
      await delay(350);
      const body = await jsonBody<Partial<AcademySettings>>(request);
      const before = fullAcademySettings();
      const details: { field: string; issue: string }[] = [];

      for (const key of Object.keys(body)) {
        if (!ACADEMY_FIELDS.includes(key as keyof AcademySettings)) {
          details.push({ field: key, issue: "This setting cannot be changed" });
        }
      }
      if (body.name !== undefined && body.name.trim().length < 2) {
        details.push({ field: "name", issue: "Use 2–120 characters" });
      }
      if (body.timezone !== undefined && body.timezone.trim().length === 0) {
        details.push({ field: "timezone", issue: "Choose a timezone" });
      }
      if (
        body.ageReferenceRule !== undefined &&
        !["jan_1_of_year", "fixed_month_day", "today"].includes(body.ageReferenceRule)
      ) {
        details.push({ field: "ageReferenceRule", issue: "Choose one of the three age rules" });
      }
      const rule = body.ageReferenceRule ?? before.ageReferenceRule;
      const monthDay = body.ageReferenceMonthDay ?? before.ageReferenceMonthDay;
      if (rule === "fixed_month_day" && !monthDay) {
        details.push({
          field: "ageReferenceMonthDay",
          issue: "A fixed-date age rule needs the month and day",
        });
      }
      if (monthDay !== undefined && !/^\d{2}-\d{2}$/.test(monthDay)) {
        details.push({ field: "ageReferenceMonthDay", issue: "Use MM-DD" });
      }
      const minutes: [string, number | undefined][] = [
        ["attendanceCoachEditWindowHours", body.attendanceCoachEditWindowHours],
        ["coachCheckinOpensMinutesBefore", body.coachCheckinOpensMinutesBefore],
        ["coachCheckinClosesMinutesAfterEnd", body.coachCheckinClosesMinutesAfterEnd],
        ["invoiceLinkTtlDays", body.invoiceLinkTtlDays],
      ];
      for (const [field, value] of minutes) {
        if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 8760)) {
          details.push({ field, issue: "Use a whole number between 0 and 8760" });
        }
      }
      if (details.length) return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, details);

      const store = getAdmin();
      const db = getDb();
      // `beneficiaryAccounts` is not in ACADEMY_FIELDS on purpose: the accounts a
      // bank receipt is matched against are read from `db.settings` and are not
      // editable from this screen in v1 (PAYMENT_VERIFICATION §3).
      for (const key of ACADEMY_FIELDS) {
        if (!(key in body)) continue;
        const value = body[key];
        (store.academy as unknown as Record<string, unknown>)[key] =
          typeof value === "string" ? value.trim() : value;
      }
      // Keep the fields the money slice owns in step with the same edit, so an
      // invoice PDF and the settings screen can never disagree.
      if (body.name !== undefined) db.settings.academyName = store.academy.name;
      if (body.paymentInstructions !== undefined) {
        db.settings.paymentInstructions = store.academy.paymentInstructions;
      }
      saveAdmin();
      saveDb();
      logAudit({
        action: "settings.academy.update",
        entityType: "settings",
        entityId: "academy",
        before,
        after: fullAcademySettings(),
        actor: actorFor(OWNER_ID),
      });
      return json(fullAcademySettings());
    })
  ),

  // --- SET-03 branding logo -------------------------------------------------
  http.post(
    "*/settings/logo",
    ownerOnly(async ({ request }) => {
      await delay(500);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return err("VALIDATION_ERROR", "Choose an image first.", 422, [
          { field: "file", issue: "No file received" },
        ]);
      }
      // Same codes as the CSV upload route (handlers.people.ts) — one failure
      // class, one code, instead of a second vocabulary for the same thing.
      const name = file.name.toLowerCase();
      const okType =
        ["image/png", "image/jpeg", "image/svg+xml"].includes(file.type) ||
        /\.(png|jpe?g|svg)$/.test(name);
      if (!okType) {
        return err("UNSUPPORTED_FILE_TYPE", "Use a PNG, JPEG or SVG file.", 415);
      }
      if (file.size > 1024 * 1024) {
        return err("FILE_TOO_LARGE", "The logo must be 1 MB or smaller.", 413);
      }
      const logoUrl = setLogo(file.name);
      logAudit({
        action: "settings.logo.upload",
        entityType: "settings",
        entityId: "logo",
        after: { logoUrl, originalName: file.name, sizeBytes: file.size },
        actor: actorFor(OWNER_ID),
      });
      return json({ logoUrl });
    })
  ),

  // --- SET-04 payment-method writes (the read stays with the billing slice) --
  http.post(
    "*/settings/payment-methods",
    ownerOnly(async ({ request }) => {
      await delay(300);
      const body = await jsonBody<{
        code?: string;
        label?: string;
        requiresReference?: boolean;
      }>(request);
      const db = getDb();
      const code = (body.code ?? "").trim().toLowerCase();
      const label = (body.label ?? "").trim();
      if (!/^[a-z][a-z0-9_]{2,29}$/.test(code)) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "code", issue: "Use 3–30 characters: a letter, then letters, digits or _" },
        ]);
      }
      if (label.length < 2) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "label", issue: "Give the method a name" },
        ]);
      }
      if (db.methods.some((m) => m.code === code)) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "code", issue: "This code is already in use — codes cannot be reused" },
        ]);
      }
      const method: PaymentMethod = {
        code,
        label,
        requiresReference: body.requiresReference ?? false,
        isActive: true,
      };
      db.methods.push(method);
      saveDb();
      logAudit({
        action: "settings.payment_method.create",
        entityType: "payment_method",
        entityId: code,
        after: method,
        actor: actorFor(OWNER_ID),
      });
      return json(method, 201);
    })
  ),

  http.patch(
    "*/settings/payment-methods/:code",
    ownerOnly(async ({ request, params }) => {
      await delay(300);
      const db = getDb();
      const code = String(params.code);
      const body = await jsonBody<{
        code?: string;
        label?: string;
        requiresReference?: boolean;
        isActive?: boolean;
      }>(request);
      // The code is the identity of the method and appears on payments already
      // recorded against it — immutable in the contract, so refuse the edit.
      if (body.code !== undefined) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "code", issue: "A method code cannot be changed — deactivate it and add a new one" },
        ]);
      }
      const method = db.methods.find((m) => m.code === code);
      if (!method) return err("NOT_FOUND", "Payment method not found.", 404);
      if (body.label !== undefined && body.label.trim().length < 2) {
        return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
          { field: "label", issue: "Give the method a name" },
        ]);
      }
      const before = { ...method };
      if (body.label !== undefined) method.label = body.label.trim();
      if (body.requiresReference !== undefined) method.requiresReference = body.requiresReference;
      if (body.isActive !== undefined) method.isActive = body.isActive;
      saveDb();
      logAudit({
        action: "settings.payment_method.update",
        entityType: "payment_method",
        entityId: code,
        before,
        after: { ...method },
        actor: actorFor(OWNER_ID),
      });
      return json(method);
    })
  ),

  // --- AUD-01 ---------------------------------------------------------------
  http.get(
    "*/audit-logs",
    ownerOnly(async ({ request }) => {
      await delay(300);
      const sp = new URL(request.url).searchParams;
      const actorUserId = sp.get("actorUserId");
      const entityType = sp.get("entityType");
      const entityId = sp.get("entityId");
      const action = sp.get("action");
      const from = sp.get("from");
      const to = sp.get("to");
      let rows: AuditEntry[] = [...getAdmin().audit];
      if (actorUserId) rows = rows.filter((e) => e.actor?.id === actorUserId);
      if (entityType) rows = rows.filter((e) => e.entityType === entityType);
      if (entityId) rows = rows.filter((e) => e.entityId === entityId);
      if (action) rows = rows.filter((e) => e.action.includes(action));
      if (from) rows = rows.filter((e) => e.occurredAt >= from);
      if (to) rows = rows.filter((e) => e.occurredAt <= to);
      // The contract sorts `-occurredAt`; the store already prepends, but sort
      // anyway so a filtered view cannot depend on insertion order.
      rows.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
      return json(paginate(rows, Number(sp.get("page") ?? 1), Number(sp.get("pageSize") ?? 25)));
    })
  ),

  // --- SYS-03 ---------------------------------------------------------------
  http.get(
    "*/system/health",
    ownerOnly(async () => {
      await delay(400);
      const store = getAdmin();
      // The session state the whole mock actually flips (`billing.setWhatsappSession`)
      // and the AppShell banner renders. `store678.sessionStatus` carries the same
      // fact and today agrees (`awaiting_qr`); the duplication is flagged for the
      // coordinator rather than worked around silently here.
      const session = getDb().settings.whatsappSession;
      const health: SystemHealth = {
        db: { status: "ok", detail: "Mock store in memory + localStorage" },
        storage: { status: "ok", detail: "Proof files are not kept by the mock" },
        openwa: {
          status: session === "connected" ? "ok" : "degraded",
          detail: session === "connected" ? "Session connected" : "Awaiting QR scan",
        },
        queue: { status: "ok", detail: "Mock queue is served from the message list" },
        scheduler: { lastRunAt: store.sessionCheckedAt },
        lastBackup: {
          at: new Date(Date.now() - 8 * 3600_000).toISOString(),
          status: "ok",
        },
        version: "0.1.0-mock",
      };
      return json(health);
    })
  ),
];
