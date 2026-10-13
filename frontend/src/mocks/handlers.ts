// MSW handlers fed by docs/engineering/MOCK_DATA.md shapes.
// Must return the EXACT contract shapes + error envelope, including
// INVALID_CREDENTIALS, ACCOUNT_LOCKED, TOTP_REQUIRED, VALIDATION_ERROR,
// INVITE_INVALID and RATE_LIMITED. Real backend drifts get reported, never
// silently adapted (API_INTEGRATION §11).
//
// Session realism: the mock mirrors cookie-session auth (ADR-004) and sets a
// real ia_mock_role cookie on login. MSW page-thread resolvers cannot SEE
// Cookie headers (forbidden header, dropped when the worker forwards the
// request), so the mock session store of record is localStorage ia_mock_role
// (origin-scoped, survives reloads). Production uses HttpOnly cookies.
import { delay, http, HttpResponse } from "msw";
import type { Me } from "@/api/types";
import { COACH_ME, OWNER_ME } from "@/lib/mock";
import { adminHandlers } from "./handlers.admin";
import { billingHandlers } from "./handlers.billing";
import { dashboardHandlers } from "./handlers.dashboard";
import { messagingHandlers } from "./handlers.messaging";
import { peopleHandlers } from "./handlers.people";
import { sessionHandlers } from "./handlers.sessions";
import {
  clearSessionCookie,
  err,
  roleFromStore,
  sessionCookie,
  writeRoleStore,
  type MockRole,
} from "./session";

let loginAttempts = 0;

function toMe(fixture: typeof OWNER_ME): Me {
  return {
    user: { ...fixture.user, status: "active" },
    csrfToken: fixture.csrfToken,
    academy: fixture.academy,
    permissions: fixture.permissions,
    assignedGroupIds: fixture.assignedGroupIds,
  };
}

// Session/store/error helpers live in ./session.ts so the people handlers use
// the same session of record and the same error envelope.
const authHandlers = [
  // AUTH-01 ---------------------------------------------------------------
  http.post("*/auth/login", async ({ request }) => {
    await delay(300);
    const body = (await request.json()) as {
      username?: string;
      password?: string;
      totpCode?: string;
    };
    loginAttempts += 1;
    if (loginAttempts % 25 === 0) {
      return err("RATE_LIMITED", "Too many requests.", 429);
    }
    if (body.username === "locked") {
      return err("ACCOUNT_LOCKED", "Too many attempts. Try again in 15 minutes.", 403);
    }
    const ok = (role: MockRole, fixture: typeof OWNER_ME) => {
      writeRoleStore(role);
      return HttpResponse.json(toMe(fixture), {
        headers: { "Set-Cookie": sessionCookie(role) },
      });
    };
    if (body.username === "owner" && body.password) {
      return ok("owner", OWNER_ME);
    }
    if (body.username === "coach" && body.password) {
      return ok("coach", COACH_ME);
    }
    if (body.username === "totp" && body.password) {
      if (!body.totpCode) {
        return err("TOTP_REQUIRED", "Enter the 6-digit code from your app.", 401);
      }
      return ok("owner", OWNER_ME);
    }
    return err("INVALID_CREDENTIALS", "Username or password is incorrect.", 401);
  }),

  // AUTH-02 ---------------------------------------------------------------
  http.post("*/auth/logout", async () => {
    await delay(100);
    writeRoleStore(null);
    return new HttpResponse(null, {
      status: 204,
      headers: { "Set-Cookie": clearSessionCookie() },
    });
  }),

  // AUTH-03 ---------------------------------------------------------------
  http.get("*/auth/me", async () => {
    await delay(150);
    const role = roleFromStore();
    if (!role) {
      return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    return HttpResponse.json(toMe(role === "owner" ? OWNER_ME : COACH_ME));
  }),

  // AUTH-04 ---------------------------------------------------------------
  http.post("*/auth/change-password", async ({ request }) => {
    await delay(200);
    if (!roleFromStore()) {
      return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    const body = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!body.currentPassword || !body.newPassword || body.newPassword.length < 12) {
      return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: "newPassword", issue: "Use at least 12 characters" },
      ]);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // AUTH-05 ---------------------------------------------------------------
  http.post("*/auth/accept-invite", async ({ request }) => {
    await delay(300);
    const body = (await request.json()) as { token?: string; password?: string };
    if (body.token !== "valid-invite-token") {
      return err("INVITE_INVALID", "This invite link is invalid or expired.", 404);
    }
    if (!body.password || body.password.length < 12) {
      return err("VALIDATION_ERROR", "Please correct the highlighted fields.", 422, [
        { field: "password", issue: "Use at least 12 characters" },
      ]);
    }
    writeRoleStore("coach");
    return HttpResponse.json(toMe(COACH_ME), {
      headers: { "Set-Cookie": sessionCookie("coach") },
    });
  }),

  // AUTH-06 ---------------------------------------------------------------
  http.get("*/auth/sessions", async () => {
    await delay(150);
    if (!roleFromStore()) {
      return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    return HttpResponse.json({
      data: [
        {
          id: "sess_current",
          createdAt: "2026-10-11T08:00:00Z",
          lastSeenAt: "2026-10-11T10:00:00Z",
          userAgent: "This device (mock)",
          current: true,
        },
        {
          id: "sess_old",
          createdAt: "2026-10-09T08:00:00Z",
          lastSeenAt: "2026-10-10T18:00:00Z",
          userAgent: "Old phone (mock)",
          current: false,
        },
      ],
    });
  }),

  http.delete("*/auth/sessions/:id", async () => {
    await delay(150);
    if (!roleFromStore()) {
      return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // AUTH-07 (owner TOTP) ----------------------------------------------------
  http.post("*/auth/totp/enroll", async () => {
    await delay(200);
    if (!roleFromStore()) {
      return err("UNAUTHENTICATED", "Sign in to continue.", 401);
    }
    return HttpResponse.json({
      secretUri: "otpauth://totp/InspireAcademy:owner?secret=MOCKSECRET&issuer=InspireAcademy",
    });
  }),

  http.post("*/auth/totp/confirm", async () => {
    await delay(200);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("*/auth/totp/disable", async () => {
    await delay(200);
    return new HttpResponse(null, { status: 204 });
  }),
];

// Step 3 slice: age groups + fees, players, guardians, coaches, CSV import.
// Step 4 slice: sessions, player attendance, coach check-in/out.
// Step 5 slice: billing runs, invoices, payments, allocations, proofs, receipts.
// Step 6 slice: message jobs, messaging status/pause, automations, reminder
//   rules, templates, send-window settings.
// Step 7 slice: owner/coach dashboards and the report + CSV export routes.
// Step 8 slice: users, full academy settings, logo, payment methods, audit,
//   system health.
// Order matters: MSW resolves with the FIRST registered match. The admin slice
// owns `GET /settings/academy`, so it must come BEFORE the billing slice (which
// still serves the payment subset of the same route through that superset
// response) — and nothing later may re-register a route an earlier slice owns.
export const handlers = [
  ...authHandlers,
  ...peopleHandlers,
  ...sessionHandlers,
  ...messagingHandlers,
  ...adminHandlers,
  ...dashboardHandlers,
  ...billingHandlers,
];
