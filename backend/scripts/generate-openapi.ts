/**
 * Emits `api/openapi.yaml` (OpenAPI 3.1) from the contract registry.
 *
 * ADR-009: from M1 exit the generated file is authoritative and `API_CONTRACTS.md`
 * becomes a human summary. The same Zod schemas validate requests at runtime, so the
 * document cannot drift from the server the way a hand-written file would.
 *
 * Usage: `npm run openapi` → writes ../api/openapi.yaml and ../api/openapi.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import YAML from "yaml";
import { registry, ERROR_STATUS } from "../spec/registry.js";
import { sections } from "../spec/index.js";

const OUT_DIR = path.resolve(process.cwd(), "..", "api");

const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Inspire Academy management system API",
    version: "0.1.0-draft",
    license: { name: "Proprietary — Inspire Academy" },
    description: [
      "Generated from the contract registry (`backend/spec/**`) — do not edit by hand.",
      "",
      "Conventions (API_CONTRACTS §1): base path `/api/v1`; JSON with camelCase fields;",
      "money as integer minor units named `*Minor`; business dates `YYYY-MM-DD`",
      "academy-local; instants ISO-8601 UTC; cookie session plus a required",
      "`X-CSRF-Token` header on every non-GET request (AUTH_AND_PERMISSIONS §2);",
      "`Idempotency-Key` required where marked `x-ia-idempotent`; every response carries",
      "`X-Request-Id`; pagination `?page&pageSize` → `{data, meta}`; errors always use the",
      "`ApiError` envelope.",
      "",
      "`x-ia-milestone` names the milestone that implements the endpoint",
      "(IMPLEMENTATION_PLAN §2). Endpoints documented here but owned by a later",
      "milestone are not served yet.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1", description: "Same-origin / reverse-proxied deployment" }],
  tags: [
    { name: "Auth", description: "AUTH-01..07 — sign-in, sessions, TOTP" },
    { name: "Users", description: "USR-01..05 — owner-managed users and invites" },
    { name: "Settings", description: "SET-01..08 — academy, billing, messaging configuration" },
    { name: "Groups", description: "GRP/FEE/CCH — age groups, fees, coach assignments" },
    { name: "Players", description: "PLY/GDN — players, guardians, history" },
    { name: "Attendance", description: "SCH/SES/ATT — schedules, sessions, attendance" },
    { name: "CoachTime", description: "CAT — coach check-in/out and corrections" },
    { name: "Billing", description: "BIL/INV/PAY/PRF/RCT — invoices, payments, proofs, receipts" },
    { name: "Public", description: "PUB — token-authenticated invoice links" },
    { name: "Messaging", description: "MSG/WHK — WhatsApp queue, templates, webhook" },
    { name: "Dashboard", description: "DSH-01/02 — owner and coach dashboards" },
    { name: "Reports", description: "RPT-01/02 — reports and CSV export" },
    { name: "Admin", description: "AUD/SYS/IMP — audit, health, CSV import" },
  ],
});

// Security schemes: the session cookie is the only way in for humans; the webhook
// uses an HMAC signature header (not a role — AUTH_AND_PERMISSIONS §3).
doc.components = {
  ...doc.components,
  securitySchemes: {
    sessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "ia_session",
      description: "Opaque session token; HttpOnly, Secure, SameSite=Lax (AUTH §1)",
    },
    webhookSignature: {
      type: "apiKey",
      in: "header",
      name: "X-OpenWA-Signature",
      description:
        "`sha256=<hex>` HMAC-SHA256 over the exact raw body, constant-time compared before JSON parsing (OPENWA_INTEGRATION §9)",
    },
  },
};

// Error catalogue as documentation only (x- extension), so the enum of codes is
// discoverable without duplicating it in prose.
doc["x-ia-error-catalogue"] = ERROR_STATUS;

const operationIds = Object.values(doc.paths ?? {}).flatMap((p) =>
  Object.values(p).map((op) => (op as { operationId?: string }).operationId),
);
const duplicates = operationIds.filter((id, i) => id && operationIds.indexOf(id) !== i);
if (duplicates.length) {
  throw new Error(`duplicate operationId(s): ${[...new Set(duplicates)].join(", ")}`);
}

await mkdir(OUT_DIR, { recursive: true });
const yaml = YAML.stringify(doc, { lineWidth: 0 });
await writeFile(path.join(OUT_DIR, "openapi.yaml"), yaml, "utf8");
await writeFile(path.join(OUT_DIR, "openapi.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf8");

const operationCount = operationIds.filter(Boolean).length;
const endpointIds = sections.flatMap((s) => s.endpoints.map((e) => e.id));
console.log(`wrote api/openapi.yaml — ${operationCount} operations from ${endpointIds.length} endpoint ids`);
console.log(`sections: ${sections.map((s) => `${s.name}(${s.endpoints.length})`).join(", ")}`);
