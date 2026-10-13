"use client";

// MSW handlers for the people slice (Step 3): age groups + fees (GRP/FEE),
// players (PLY), guardians (GDN), coaches and assignments (CCH) and CSV import
// (IMP). Every response is the contract shape; every failure is the exact error
// envelope + code from API_CONTRACTS §1.1. Authorization mirrors the server:
// unauthenticated ⇒ 401, coach on an owner route ⇒ 403, coach out of scope ⇒ 404.
import { delay, http } from "msw";
import type { Invoice, PlayerCreate, PlayerStatus } from "@/api/types";
import * as db from "./db";
import { authed, json, jsonBody, ownerOnly } from "./http";
import { err } from "./session";
import { actorFor, getAdmin, logAudit, saveAdmin } from "./store678";

export const peopleHandlers = [
  // --- GRP-01..05, FEE-01/02 ----------------------------------------------
  http.get("*/age-groups/suggest", ownerOnly(async ({ request }) => {
    await delay(200);
    const dateOfBirth = new URL(request.url).searchParams.get("dateOfBirth") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return err("VALIDATION_ERROR", "Enter a valid date of birth.", 422, [
        { field: "dateOfBirth", issue: "Use YYYY-MM-DD" },
      ]);
    }
    return json(db.suggestGroup(dateOfBirth));
  })),

  http.get("*/age-groups", authed(async ({ request, viewer }) => {
    await delay(250);
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
    return json({ data: db.listGroups(includeArchived, viewer) });
  })),

  http.post("*/age-groups", ownerOnly(async ({ request }) => {
    await delay(300);
    const body = await jsonBody<{ name: string; minAge?: number; maxAge?: number; sortOrder?: number }>(request);
    if (!body.name || body.name.trim().length < 2) {
      return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: "name", issue: "Name is required (2–60 characters)" },
      ]);
    }
    return json(db.createGroup(body), 201);
  })),

  http.get("*/age-groups/:id", authed(async ({ params, viewer }) => {
    await delay(250);
    const group = db.getGroup(String(params.id));
    if (!group || group.archivedAt) return err("NOT_FOUND", "Age group not found.", 404);
    if (viewer.role === "coach" && !db.listGroups(false, viewer).some((g) => g.id === group.id)) {
      return err("NOT_FOUND", "Age group not found.", 404);
    }
    return json(viewer.role === "coach" ? { ...group, currentFeeMinor: undefined } : group);
  })),

  http.patch("*/age-groups/:id", ownerOnly(async ({ request, params }) => {
    await delay(300);
    return json(db.patchGroup(String(params.id), await jsonBody(request)));
  })),

  http.post("*/age-groups/:id/archive", ownerOnly(async ({ params }) => {
    await delay(300);
    return json(db.archiveGroup(String(params.id), true));
  })),

  http.post("*/age-groups/:id/unarchive", ownerOnly(async ({ params }) => {
    await delay(300);
    return json(db.archiveGroup(String(params.id), false));
  })),

  http.get("*/age-groups/:id/fees", ownerOnly(async ({ params }) => {
    await delay(250);
    if (!db.getGroup(String(params.id))) return err("NOT_FOUND", "Age group not found.", 404);
    return json({ data: db.groupFees(String(params.id)) });
  })),

  http.post("*/age-groups/:id/fees", ownerOnly(async ({ request, params }) => {
    await delay(400);
    const body = await jsonBody<{ amountMinor: number; effectiveFrom: string; allowPast?: boolean }>(request);
    return json(db.addFee(String(params.id), body), 201);
  })),

  // --- PLY-01..11 ---------------------------------------------------------
  // /check-duplicates must be matched before /players/:id.
  http.post("*/players/check-duplicates", ownerOnly(async ({ request }) => {
    await delay(300);
    const body = await jsonBody<{ fullName: string; dateOfBirth?: string; guardianPhones?: string[] }>(request);
    if (!body.fullName || body.fullName.trim().length < 2) {
      return json({ matches: [] });
    }
    return json({ matches: db.checkDuplicates(body) });
  })),

  http.get("*/players", authed(async ({ request, viewer }) => {
    await delay(300);
    const sp = new URL(request.url).searchParams;
    const status = (sp.get("status") ?? "active") as PlayerStatus;
    if (!["active", "inactive", "withdrawn"].includes(status)) {
      return err("VALIDATION_ERROR", "Unknown status filter.", 422, [
        { field: "status", issue: "Use active, inactive or withdrawn" },
      ]);
    }
    return json(
      db.listPlayers(
        {
          q: sp.get("q") ?? undefined,
          status,
          ageGroupId: sp.get("ageGroupId") ?? undefined,
          hasOutstanding: sp.get("hasOutstanding") === "true",
          page: Number(sp.get("page") ?? 1),
          pageSize: Number(sp.get("pageSize") ?? 25),
          sort: sp.get("sort") ?? undefined,
        },
        viewer
      )
    );
  })),

  http.post("*/players", ownerOnly(async ({ request }) => {
    await delay(450);
    const body = await jsonBody<PlayerCreate>(request);
    const errors: { field: string; issue: string }[] = [];
    const name = body.fullName?.trim() ?? "";
    if (name.length < 2 || name.length > 120) errors.push({ field: "fullName", issue: "Use 2–120 characters" });
    if (!body.registrationDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.registrationDate)) {
      errors.push({ field: "registrationDate", issue: "Enter a registration date" });
    }
    if (!Array.isArray(body.guardians) || body.guardians.length === 0) {
      errors.push({ field: "guardians.0.fullName", issue: "At least one guardian is required" });
    } else {
      body.guardians.forEach((g, index) => {
        if ("fullName" in g) {
          if (!g.fullName || g.fullName.trim().length < 2) {
            errors.push({ field: `guardians.${index}.fullName`, issue: "Guardian name is required" });
          }
          if (!g.phone || !/^\+?[0-9]{9,15}$/.test(g.phone)) {
            errors.push({ field: `guardians.${index}.phone`, issue: "Enter a valid phone number" });
          }
        }
      });
      if (!body.guardians.some((g) => g.isPrimary)) {
        errors.push({ field: "guardians.0.isPrimary", issue: "Mark one guardian as primary" });
      }
    }
    if (errors.length) return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, errors);
    return json(db.createPlayer({ ...body, fullName: name }), 201);
  })),

  http.get("*/players/:id", authed(async ({ params, viewer }) => {
    await delay(250);
    const player = db.getPlayer(String(params.id), viewer);
    // Out-of-scope coach gets the same answer as a missing id — never reveal it.
    if (!player) return err("NOT_FOUND", "Player not found.", 404);
    return json(player);
  })),

  http.patch("*/players/:id", ownerOnly(async ({ request, params }) => {
    await delay(400);
    return json(db.patchPlayer(String(params.id), await jsonBody(request)));
  })),

  http.post("*/players/:id/status", ownerOnly(async ({ request, params }) => {
    await delay(400);
    const body = await jsonBody<{ status: PlayerStatus; effectiveDate: string; reason?: string }>(request);
    return json(db.setPlayerStatus(String(params.id), body));
  })),

  http.post("*/players/:id/transfer", ownerOnly(async ({ request, params }) => {
    await delay(400);
    const body = await jsonBody<{ ageGroupId: string; effectiveFrom: string; reason: string; version?: number }>(request);
    if (!body.reason || body.reason.trim().length < 5) {
      return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: "reason", issue: "Give a reason (at least 5 characters)" },
      ]);
    }
    return json(db.transferPlayer(String(params.id), body));
  })),

  http.get("*/players/:id/group-history", ownerOnly(async ({ params }) => {
    await delay(200);
    return json({ data: db.playerHistory(String(params.id)) });
  })),

  http.get("*/players/:id/invoices", ownerOnly(async ({ params }) => {
    await delay(250);
    const data: Invoice[] = db.playerInvoices(String(params.id));
    return json({
      data,
      meta: { page: 1, pageSize: data.length || 25, total: data.length, totalPages: 1 },
    });
  })),

  http.get("*/players/:id/attendance", authed(async ({ request, params, viewer }) => {
    await delay(300);
    const player = db.getPlayer(String(params.id), viewer);
    if (!player) return err("NOT_FOUND", "Player not found.", 404);
    const sp = new URL(request.url).searchParams;
    return json(db.playerAttendance(String(params.id), sp.get("from") ?? undefined, sp.get("to") ?? undefined));
  })),

  http.get("*/players/:id/balance", ownerOnly(async ({ params }) => {
    await delay(200);
    return json(db.playerBalance(String(params.id)));
  })),

  // --- GDN-01..06 ---------------------------------------------------------
  http.post("*/players/:id/guardians", ownerOnly(async ({ request, params }) => {
    await delay(350);
    const body = await jsonBody<{ guardianId: string; isPrimary: boolean; receivesInvoices: boolean }>(request);
    return json(db.linkGuardian(String(params.id), body));
  })),

  http.patch("*/players/:id/guardians/:guardianId", ownerOnly(async ({ request, params }) => {
    await delay(350);
    return json(db.patchLink(String(params.id), String(params.guardianId), await jsonBody(request)));
  })),

  http.delete("*/players/:id/guardians/:guardianId", ownerOnly(async ({ params }) => {
    await delay(350);
    db.removeLink(String(params.id), String(params.guardianId));
    return new Response(null, { status: 204 });
  })),

  http.get("*/guardians", ownerOnly(async ({ request }) => {
    await delay(250);
    const q = new URL(request.url).searchParams.get("q") ?? undefined;
    const data = db.listGuardians(q);
    return json({ data, meta: { page: 1, pageSize: data.length || 25, total: data.length, totalPages: 1 } });
  })),

  http.patch("*/guardians/:id", ownerOnly(async ({ request, params }) => {
    await delay(300);
    return json(db.patchGuardian(String(params.id), await jsonBody(request)));
  })),

  http.post("*/guardians/:id/consent", ownerOnly(async ({ request, params }) => {
    await delay(350);
    const body = await jsonBody<{ status: "granted" | "revoked" | "unknown"; source: string; note?: string }>(request);
    return json(db.setConsent(String(params.id), body));
  })),

  http.get("*/guardians/:id/balance", ownerOnly(async ({ params }) => {
    await delay(200);
    return json(db.guardianBalance(String(params.id)));
  })),

  // --- INV-02 moved to the billing slice (handlers.billing.ts) -------------
  // The Step 3 placeholder returned the invoice row without `items` or
  // `allocations`; the real INV-02 response carries both. MSW resolves with the
  // first registered match, so keeping the placeholder here would have shadowed
  // the billing handler and quietly served the wrong shape.

  // --- CCH-01..04 + USR-02 ------------------------------------------------
  http.get("*/coaches", ownerOnly(async ({ request }) => {
    await delay(250);
    const q = new URL(request.url).searchParams.get("q") ?? undefined;
    const data = db.listCoaches(q);
    return json({ data, meta: { page: 1, pageSize: data.length || 25, total: data.length, totalPages: 1 } });
  })),

  http.get("*/coach-assignments", ownerOnly(async ({ request }) => {
    await delay(200);
    const sp = new URL(request.url).searchParams;
    return json({
      data: db.listAssignments({
        coachUserId: sp.get("coachUserId") ?? undefined,
        ageGroupId: sp.get("ageGroupId") ?? undefined,
      }),
    });
  })),

  http.post("*/coach-assignments", ownerOnly(async ({ request }) => {
    await delay(350);
    return json(db.createAssignment(await jsonBody(request)), 201);
  })),

  http.post("*/coach-assignments/:id/end", ownerOnly(async ({ request, params }) => {
    await delay(350);
    const body = await jsonBody<{ assignedTo: string }>(request);
    return json(db.endAssignment(String(params.id), body.assignedTo));
  })),

  http.post("*/users", ownerOnly(async ({ request }) => {
    await delay(400);
    const body = await jsonBody<{ username: string; fullName: string; phone?: string; role: "owner" | "coach" }>(request);
    if (body.role !== "coach") {
      return err("VALIDATION_ERROR", "This slice only invites coaches.", 422, [
        { field: "role", issue: "Use coach" },
      ]);
    }
    const created = db.createCoachUser(body);
    // The Step 8 admin slice owns `/users` (USR-01) and reads `store678.users`, so
    // an invited coach has to land in that list too — otherwise the person who was
    // just invited would not appear on the Users screen.
    const admin = getAdmin();
    if (!admin.users.some((u) => u.id === created.user.id)) {
      admin.users.push(created.user);
    }
    saveAdmin();
    logAudit({
      action: "user.invite",
      entityType: "user",
      entityId: created.user.id,
      after: created.user,
      actor: actorFor(db.OWNER_ID),
    });
    return json(created, 201);
  })),

  // --- IMP-01/02 ----------------------------------------------------------
  http.post("*/imports/players/validate", ownerOnly(async ({ request }) => {
    await delay(500);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return err("VALIDATION_ERROR", "Choose a CSV file first.", 422, [
        { field: "file", issue: "No file received" },
      ]);
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      return err("UNSUPPORTED_FILE_TYPE", "Only CSV files are accepted.", 415);
    }
    if (file.size > 2 * 1024 * 1024) {
      return err("FILE_TOO_LARGE", "The file is larger than 2 MB.", 413);
    }
    return json(db.validateImport(file.name, await file.text()));
  })),

  http.post("*/imports/players/:batchId/commit", ownerOnly(async ({ request, params }) => {
    await delay(600);
    const body = (await request.json().catch(() => ({}))) as {
      importRowsWithWarnings?: boolean;
    };
    return json(
      db.commitImport(String(params.batchId), body.importRowsWithWarnings ?? false)
    );
  })),
];
