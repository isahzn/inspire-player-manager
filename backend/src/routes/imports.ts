/**
 * IMP-01 / IMP-02 — the players CSV import (CSV_IMPORT).
 *
 * Two properties this file is responsible for, and that the tests drive through the
 * running HTTP surface:
 *
 *  - **Validate writes no players.** IMP-01 parses, normalizes and checks the file, then
 *    stores one `import_batches` row (`status='validated'`). The parsed rows travel in
 *    that row's `report` jsonb because no object-storage adapter exists until M6 — the
 *    bytes are never kept, only what would be created.
 *  - **Commit is all-or-nothing.** IMP-02 runs in one transaction: a failure on row 400
 *    leaves zero players behind, so there is no half-imported roster to reconcile.
 *    Duplicate-suspect rows are skipped and counted, never silently merged.
 *
 * The CSV parser is deliberately local (RFC4180-ish, quoted fields, `""` escapes, CRLF)
 * rather than a dependency: it only ever *reads* the academy's own export.
 */
import type { MultipartFile } from "@fastify/multipart";
import { normalizePhone } from "../auth/tokens.js";
import { withTransaction } from "../db/pool.js";
import { ApiError, errors } from "../errors.js";
import { isPgError, mapPgError } from "../db/pg-errors.js";
import * as audit from "../audit.js";
import { uuidv7 } from "../ids.js";
import { withIdempotency } from "../http/idempotency.js";
import type { Handler, HandlerResult } from "../http/router.js";
import { viewerAudit } from "./auth.js";
import {
  ageOn,
  allocatePlayerRegistrationNo,
  duplicateReasonText,
  findDuplicatePlayers,
  todayInTimeZone,
} from "./people-helpers.js";

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

const MAX_ROWS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Strips the control characters a spreadsheet may leave behind, then trims. */
function cleanCell(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

/** Comma or semicolon, decided from the header line (CSV_IMPORT §1). */
function detectDelimiter(headerLine: string): string {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

/** A small RFC4180-ish reader: quoted fields, `""` escapes, CRLF or LF. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Row shapes stored in `import_batches.report`
// ---------------------------------------------------------------------------

interface ImportIssue {
  row: number;
  field?: string;
  message: string;
}

interface ImportGuardian {
  name: string;
  phone: string;
  relationship?: string;
}

interface ImportRow {
  row: number;
  fullName: string;
  dateOfBirth?: string;
  registrationDate: string;
  ageGroupId?: string;
  ageGroupName?: string;
  status: "active" | "inactive" | "withdrawn";
  guardians: ImportGuardian[];
  whatsappConsent: "granted" | "unknown";
  consentSource?: string;
  notes?: string;
}

interface ImportReport {
  rows: ImportRow[];
  /** Row numbers carrying a duplicate-suspect warning; IMP-02 skips them. */
  duplicateRowNumbers: number[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Written by IMP-02 so a replayed commit answers the same counts. */
  result?: { created: number; skipped: number };
}

const HEADER_COLUMNS = [
  "full_name",
  "date_of_birth",
  "registration_date",
  "age_group",
  "status",
  "guardian1_name",
  "guardian1_phone",
  "guardian1_relationship",
  "guardian2_name",
  "guardian2_phone",
  "whatsapp_consent",
  "consent_source",
  "notes",
] as const;

const STATUS_VALUES: readonly string[] = ["active", "inactive", "withdrawn"];
const CONSENT_VALUES: readonly string[] = ["granted", "unknown"];
const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

function isValidDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isFileTooLarge(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: string; statusCode?: number };
  return candidate.code === "FST_REQ_FILE_TOO_LARGE" || candidate.statusCode === 413;
}

// ---------------------------------------------------------------------------
// IMP-01 — validate
// ---------------------------------------------------------------------------

export const imp01Validate: Handler = async ({ ctx, viewer, req }): Promise<HandlerResult> => {
  const multipart = req as unknown as {
    isMultipart?: () => boolean;
    file?: () => Promise<MultipartFile | undefined>;
  };
  if (typeof multipart.isMultipart !== "function" || !multipart.isMultipart()) {
    throw errors.validation([
      { field: "file", issue: "Upload the CSV as multipart/form-data with a `csv` file part." },
    ]);
  }

  let part: MultipartFile | undefined;
  try {
    part = await multipart.file!();
  } catch (err) {
    if (isFileTooLarge(err)) {
      throw new ApiError("FILE_TOO_LARGE", "The CSV must be 2 MB or smaller.");
    }
    throw err;
  }
  if (!part) throw errors.validation([{ field: "file", issue: "Attach a CSV file." }]);

  const mime = (part.mimetype ?? "").toLowerCase();
  if (mime && !CSV_MIME_TYPES.has(mime)) {
    throw new ApiError("UNSUPPORTED_FILE_TYPE", "Upload a UTF-8 CSV file.");
  }

  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (err) {
    if (isFileTooLarge(err)) {
      throw new ApiError("FILE_TOO_LARGE", "The CSV must be 2 MB or smaller.");
    }
    throw err;
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new ApiError("FILE_TOO_LARGE", "The CSV must be 2 MB or smaller.");
  }

  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel writes a BOM.
  if (!text.trim()) throw errors.validation([{ field: "file", issue: "The CSV is empty." }]);

  const firstLineEnd = text.indexOf("\n");
  const headerLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const table = parseCsv(text, detectDelimiter(headerLine)).filter((cells) =>
    cells.some((cell) => cleanCell(cell) !== ""),
  );
  const header = table[0]?.map((cell) => cleanCell(cell).toLowerCase()) ?? [];
  const dataRows = table.slice(1);

  if (dataRows.length === 0) {
    throw errors.validation([{ field: "file", issue: "The CSV has a header but no player rows." }]);
  }
  if (dataRows.length > MAX_ROWS) {
    throw errors.validation([
      { field: "file", issue: `The CSV must have at most ${MAX_ROWS} player rows.` },
    ]);
  }

  const index = new Map<string, number>();
  for (const column of HEADER_COLUMNS) index.set(column, -1);
  header.forEach((name, position) => {
    if (index.has(name)) index.set(name, position);
  });

  const today = todayInTimeZone(viewer.academy.timezone);
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const rows: ImportRow[] = [];
  const duplicateRowNumbers: number[] = [];

  const batch = await withTransaction(
    { userId: viewer.userId, role: viewer.role },
    async (client) => {
      // Resolve age-group names once, case-insensitively (CSV_IMPORT §2).
      const groups = await client.query<{ id: string; name: string }>(
        `select id, name from age_groups where archived_at is null`,
      );
      const groupByName = new Map<string, { id: string; name: string }>();
      for (const group of groups.rows) groupByName.set(group.name.toLowerCase(), group);

      // `row` is the line number in the file (header = 1) — what the owner sees in Excel.
      for (let i = 0; i < dataRows.length; i += 1) {
        const cells = dataRows[i]!;
        const rowNumber = i + 2;
        const cell = (column: string): string => {
          const position = index.get(column) ?? -1;
          return position >= 0 ? cleanCell(cells[position] ?? "") : "";
        };
        const fail = (field: string, message: string): void => {
          issues.push({ row: rowNumber, field, message });
        };

        const fullName = cell("full_name");
        if (fullName.length < 2 || fullName.length > 120) {
          fail("full_name", "Full name must be between 2 and 120 characters.");
        }

        let dateOfBirth: string | undefined;
        const rawDob = cell("date_of_birth");
        if (rawDob) {
          if (!isValidDateStr(rawDob)) {
            fail("date_of_birth", "Date of birth must be YYYY-MM-DD.");
          } else if (rawDob > today) {
            fail("date_of_birth", "Date of birth cannot be in the future.");
          } else {
            dateOfBirth = rawDob;
          }
        }

        let registrationDate = today;
        const rawRegistration = cell("registration_date");
        if (rawRegistration) {
          if (!isValidDateStr(rawRegistration)) {
            fail("registration_date", "Registration date must be YYYY-MM-DD.");
          } else {
            registrationDate = rawRegistration;
          }
        }

        let ageGroupId: string | undefined;
        let ageGroupName: string | undefined;
        const rawGroup = cell("age_group");
        if (rawGroup) {
          const group = groupByName.get(rawGroup.toLowerCase());
          if (!group) {
            fail("age_group", `No active age group named "${rawGroup}".`);
          } else {
            ageGroupId = group.id;
            ageGroupName = group.name;
          }
        }

        let status: ImportRow["status"] = "active";
        const rawStatus = cell("status").toLowerCase();
        if (rawStatus) {
          if (!STATUS_VALUES.includes(rawStatus)) {
            fail("status", "Status must be active, inactive or withdrawn.");
          } else {
            status = rawStatus as ImportRow["status"];
          }
        }

        const guardian1Name = cell("guardian1_name");
        const guardian1Relationship = cell("guardian1_relationship").slice(0, 40);
        if (guardian1Name.length < 2 || guardian1Name.length > 120) {
          fail("guardian1_name", "Guardian 1 name must be between 2 and 120 characters.");
        }
        let guardian1Phone: string | undefined;
        const rawGuardian1Phone = cell("guardian1_phone");
        if (!rawGuardian1Phone) {
          fail("guardian1_phone", "Guardian 1 phone is required.");
        } else {
          try {
            guardian1Phone = normalizePhone(rawGuardian1Phone);
          } catch {
            fail("guardian1_phone", "Guardian 1 phone is not a valid number.");
          }
        }

        const guardian2Name = cell("guardian2_name");
        const rawGuardian2Phone = cell("guardian2_phone");
        let guardian2Phone: string | undefined;
        if (guardian2Name && !rawGuardian2Phone) {
          fail("guardian2_phone", "Guardian 2 needs a phone number.");
        } else if (!guardian2Name && rawGuardian2Phone) {
          fail("guardian2_name", "Guardian 2 needs a name.");
        } else if (guardian2Name && rawGuardian2Phone) {
          if (guardian2Name.length < 2 || guardian2Name.length > 120) {
            fail("guardian2_name", "Guardian 2 name must be between 2 and 120 characters.");
          }
          try {
            guardian2Phone = normalizePhone(rawGuardian2Phone);
          } catch {
            fail("guardian2_phone", "Guardian 2 phone is not a valid number.");
          }
        }

        let whatsappConsent: "granted" | "unknown" = "unknown";
        const rawConsent = cell("whatsapp_consent").toLowerCase();
        const consentSource = cell("consent_source");
        if (rawConsent) {
          if (!CONSENT_VALUES.includes(rawConsent)) {
            fail("whatsapp_consent", "Consent must be granted or unknown.");
          } else {
            whatsappConsent = rawConsent as "granted" | "unknown";
          }
        }
        if (consentSource.length > 60) {
          fail("consent_source", "Consent source must be 60 characters or fewer.");
        }
        if (whatsappConsent === "granted" && !consentSource) {
          fail("consent_source", "A granted consent needs its source.");
        }

        const notes = cell("notes");
        if (notes.length > 1000) fail("notes", "Notes must be 1000 characters or fewer.");

        // Warnings never block a row.
        if (dateOfBirth) {
          const age = ageOn(dateOfBirth, today);
          if (age < 3 || age > 25) {
            warnings.push({
              row: rowNumber,
              field: "date_of_birth",
              message: `Age ${age} is outside the usual 3–25 range.`,
            });
          }
        }
        if (whatsappConsent !== "granted") {
          warnings.push({
            row: rowNumber,
            field: "whatsapp_consent",
            message: "Consent is unknown — no WhatsApp automation will run for this guardian yet.",
          });
        }

        // An error on this row blocks it; it is reported but not previewed or committed.
        if (issues.some((issue) => issue.row === rowNumber)) continue;

        const guardians: ImportGuardian[] = [
          {
            name: guardian1Name,
            phone: guardian1Phone!,
            ...(guardian1Relationship ? { relationship: guardian1Relationship } : {}),
          },
        ];
        if (guardian2Name && guardian2Phone) {
          guardians.push({ name: guardian2Name, phone: guardian2Phone });
        }

        const hits = await findDuplicatePlayers(client, {
          fullName,
          ...(dateOfBirth ? { dateOfBirth } : {}),
          guardianPhones: guardians.map((guardian) => guardian.phone),
        });
        if (hits.length > 0) {
          duplicateRowNumbers.push(rowNumber);
          warnings.push({
            row: rowNumber,
            field: "full_name",
            message: duplicateReasonText(hits[0]!.reason),
          });
        }

        rows.push({
          row: rowNumber,
          fullName,
          ...(dateOfBirth ? { dateOfBirth } : {}),
          registrationDate,
          ...(ageGroupId ? { ageGroupId } : {}),
          ...(ageGroupName ? { ageGroupName } : {}),
          status,
          guardians,
          whatsappConsent,
          ...(consentSource ? { consentSource } : {}),
          ...(notes ? { notes } : {}),
        });
      }

      const batchId = uuidv7();
      const report: ImportReport = { rows, duplicateRowNumbers, errors: issues, warnings };
      await client.query(
        `insert into import_batches (id, kind, status, row_count, error_count, report, created_by)
         values ($1, 'players', 'validated', $2, $3, $4::jsonb, $5)`,
        [batchId, dataRows.length, issues.length, JSON.stringify(report), viewer.userId],
      );
      await audit.record(client, viewerAudit(viewer, ctx), {
        action: "import.validate",
        entityType: "import_batch",
        entityId: batchId,
        after: {
          rowCount: dataRows.length,
          errorCount: issues.length,
          warningCount: warnings.length,
        },
      });
      return { batchId, report };
    },
  );

  return {
    status: 200,
    body: {
      batchId: batch.batchId,
      rowCount: dataRows.length,
      errors: batch.report.errors,
      warnings: batch.report.warnings,
      preview: batch.report.rows.map((row) => ({
        row: row.row,
        fullName: row.fullName,
        ...(row.dateOfBirth ? { dateOfBirth: row.dateOfBirth } : {}),
        registrationDate: row.registrationDate,
        ...(row.ageGroupName ? { ageGroupName: row.ageGroupName } : {}),
        status: row.status,
        guardianName: row.guardians[0]!.name,
        guardianPhone: row.guardians[0]!.phone,
        ...(row.guardians[0]!.relationship
          ? { guardianRelationship: row.guardians[0]!.relationship }
          : {}),
        whatsappConsent: row.whatsappConsent,
        ...(row.consentSource ? { consentSource: row.consentSource } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// IMP-02 — commit
// ---------------------------------------------------------------------------

export const imp02Commit: Handler = withIdempotency(
  async ({ ctx, viewer, params }): Promise<HandlerResult> => {
    const { batchId } = params as { batchId: string };

    try {
      return await withTransaction({ userId: viewer.userId, role: viewer.role }, async (client) => {
        const batchResult = await client.query<{ id: string; status: string; report: ImportReport }>(
          `select id, status, report from import_batches where id = $1 for update`,
          [batchId],
        );
        const batch = batchResult.rows[0];
        if (!batch) throw errors.notFound();

        if (batch.status === "committed") {
          // Replay: the work is already done, answer with the same counts.
          return {
            status: 200,
            body: {
              created: batch.report.result?.created ?? 0,
              skipped: batch.report.result?.skipped ?? 0,
            },
          };
        }
        if (batch.status !== "validated") {
          throw new ApiError(
            "INVALID_STATE_TRANSITION",
            "This batch is not in a state that can be committed.",
          );
        }

        const report = batch.report;
        const skippedRows = new Set(report.duplicateRowNumbers ?? []);
        let created = 0;

        for (const row of report.rows ?? []) {
          // Duplicate-suspect rows are never silently merged (CSV_IMPORT §3).
          if (skippedRows.has(row.row)) continue;

          const registrationYear = Number(row.registrationDate.slice(0, 4));
          const registrationNo = await allocatePlayerRegistrationNo(client, registrationYear);
          const playerId = uuidv7();

          await client.query(
            `insert into players
               (id, registration_no, full_name, date_of_birth, registration_date,
                billing_anchor_date, status, status_effective_date, notes, created_by)
             values ($1, $2, $3, $4, $5, $5, $6, $5, $7, $8)`,
            [
              playerId,
              registrationNo,
              row.fullName,
              row.dateOfBirth ?? null,
              row.registrationDate,
              row.status,
              row.notes ?? null,
              viewer.userId,
            ],
          );

          let isFirstGuardian = true;
          for (const guardian of row.guardians) {
            // Reuse a guardian when the normalized phone *and* name match exactly.
            const existing = await client.query<{ id: string }>(
              `select id from guardians where phone_e164 = $1 and full_name = $2 limit 1`,
              [guardian.phone, guardian.name],
            );
            let guardianId = existing.rows[0]?.id;
            if (!guardianId) {
              guardianId = uuidv7();
              await client.query(
                `insert into guardians
                   (id, full_name, phone_e164, relationship, whatsapp_consent,
                    consent_recorded_at, consent_source)
                 values ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  guardianId,
                  guardian.name,
                  guardian.phone,
                  guardian.relationship ?? null,
                  row.whatsappConsent,
                  row.whatsappConsent === "granted" ? new Date() : null,
                  row.consentSource ?? null,
                ],
              );
            }
            await client.query(
              `insert into player_guardians (player_id, guardian_id, is_primary, receives_invoices)
               values ($1, $2, $3, true)
               on conflict (player_id, guardian_id) do nothing`,
              [playerId, guardianId, isFirstGuardian],
            );
            isFirstGuardian = false;
          }

          if (row.ageGroupId) {
            await client.query(
              `insert into player_group_history
                 (id, player_id, age_group_id, effective_from, changed_by)
               values ($1, $2, $3, $4, $5)`,
              [uuidv7(), playerId, row.ageGroupId, row.registrationDate, viewer.userId],
            );
          }

          await audit.record(client, viewerAudit(viewer, ctx), {
            action: "player.create",
            entityType: "player",
            entityId: playerId,
            after: { registrationNo, fullName: row.fullName, source: "csv_import", batchId },
          });
          created += 1;
        }

        const skipped = skippedRows.size;
        const nextReport: ImportReport = { ...report, result: { created, skipped } };
        await client.query(
          `update import_batches
              set status = 'committed', committed_at = now(), report = $2::jsonb
            where id = $1`,
          [batchId, JSON.stringify(nextReport)],
        );
        await audit.record(client, viewerAudit(viewer, ctx), {
          action: "import.commit",
          entityType: "import_batch",
          entityId: batchId,
          after: { created, skipped },
        });

        return { status: 200, body: { created, skipped } };
      });
    } catch (err) {
      if (isPgError(err) && err.code === "23P01") {
        throw new ApiError("INVALID_STATE_TRANSITION", "The import could not be committed.");
      }
      mapPgError(err);
    }
  },
);
