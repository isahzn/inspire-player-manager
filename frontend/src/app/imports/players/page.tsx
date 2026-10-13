"use client";

// CSV import wizard — IMP-01 (validate) → IMP-02 (commit), owner only
// (PAGE_SPECIFICATIONS §4, CSV_IMPORT §3, ROUTES_AND_NAVIGATION §1 → /imports/players).
// Nothing is written by validation: the file is parsed, errors/warnings and a
// preview come back, and players are created only when the owner commits.
import { useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { ApiError, imp01ValidateImport, imp02CommitImport } from "@/api/client";
import type { ImportCommitResult, ImportValidation } from "@/api/types";
import { RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  Button,
  Card,
  DateText,
  InlineAlert,
  ListSkeleton,
  SectionTitle,
  Toast,
  buttonClass,
} from "@/components/ui";

/** The header row the parser expects, verbatim (CSV_IMPORT §2). */
const EXPECTED_HEADER =
  "full_name,date_of_birth,registration_date,age_group,status,guardian1_name,guardian1_phone";

/** Optional columns accepted in the same file (CSV_IMPORT §2). */
const OPTIONAL_COLUMNS =
  "guardian1_relationship, guardian2_name, guardian2_phone, whatsapp_consent, consent_source, notes";

const STEPS = [
  { key: "choose", label: "Choose file" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

interface UploadFailure {
  message: string;
  requestId?: string;
}

function toFailure(error: unknown): UploadFailure {
  if (error instanceof ApiError) {
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "The upload failed. Check your connection and try again." };
}

function StepIndicator({ current }: { current: StepKey }) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);
  return (
    <ol aria-label="Import progress" className="mb-4 flex flex-wrap gap-2">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
        return (
          <li
            key={step.key}
            aria-current={state === "current" ? "step" : undefined}
            className={`flex min-h-[44px] items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold ${
              state === "current"
                ? "border-pitch-600 bg-pitch-50 text-pitch-700"
                : state === "done"
                  ? "border-slate-200 bg-white text-slate-700"
                  : "border-slate-200 bg-white text-slate-500"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] ${
                state === "current" ? "bg-pitch-600 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {state === "done" ? "✓" : index + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function ImportWizard() {
  const [step, setStep] = useState<StepKey>("choose");
  const [fileName, setFileName] = useState<string | null>(null);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [failure, setFailure] = useState<UploadFailure | null>(null);
  const [busy, setBusy] = useState<"validate" | "commit" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // CSV_IMPORT §3 step 3: rows with warnings commit only if the owner ticks it.
  const [importWarnings, setImportWarnings] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const errorCount = validation?.errors.length ?? 0;
  const warningCount = validation?.warnings.length ?? 0;
  const importableCount = validation?.preview.length ?? 0;
  // Distinct rows that carry at least one warning (a row can have several).
  const warningRows = new Set((validation?.warnings ?? []).map((issue) => issue.row)).size;

  async function validateFile(file: File) {
    setFailure(null);
    setBusy("validate");
    try {
      const parsed = await imp01ValidateImport(file);
      setValidation(parsed);
      setStep("review");
    } catch (error) {
      setFailure(toFailure(error));
      setValidation(null);
      setStep("choose");
    } finally {
      setBusy(null);
    }
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    void validateFile(file);
  }

  function onDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    setFileName(file.name);
    void validateFile(file);
  }

  async function commit() {
    if (!validation) return;
    setFailure(null);
    setBusy("commit");
    try {
      const committed = await imp02CommitImport(validation.batchId, {
        importRowsWithWarnings: importWarnings,
      });
      setResult(committed);
      setStep("done");
      setToast(`${committed.created} player${committed.created === 1 ? "" : "s"} imported.`);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(null);
    }
  }

  function restart() {
    setStep("choose");
    setValidation(null);
    setResult(null);
    setFailure(null);
    setFileName(null);
    setImportWarnings(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <>
      <PageHeader
        title="Import players"
        sub="Upload the academy's existing player list once. Rows are validated first and nothing is created until you commit."
        actions={
          <Link href="/players" className={buttonClass("secondary", "sm")}>
            Back to players
          </Link>
        }
      />

      <StepIndicator current={step} />

      {failure ? (
        <div className="mb-4">
          <InlineAlert
            tone="danger"
            title="The file could not be processed"
            action={
              step === "review" ? (
                <Button variant="secondary" size="sm" onClick={commit} pending={busy === "commit"}>
                  Try committing again
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  pending={busy === "validate"}
                >
                  Choose a file again
                </Button>
              )
            }
          >
            <p>{failure.message}</p>
            {failure.requestId ? (
              <p className="mt-1 text-[12px]">
                Reference: <span className="font-mono">{failure.requestId}</span>
              </p>
            ) : null}
          </InlineAlert>
        </div>
      ) : null}

      {step === "choose" ? (
        <Card>
          <SectionTitle>1 · Choose a CSV file</SectionTitle>
          <div className="space-y-4 p-4">
            <div>
              <input
                ref={fileInput}
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={onFileChange}
                disabled={busy === "validate"}
                className="peer sr-only"
              />
              <label
                htmlFor="csv-file"
                onDrop={onDrop}
                onDragOver={(event) => event.preventDefault()}
                className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white px-4 py-6 text-center hover:border-pitch-600 hover:bg-pitch-50 peer-focus-visible:ring-[3px] peer-focus-visible:ring-[#1d5fd1] peer-focus-visible:ring-offset-2"
              >
                <FileSpreadsheet className="h-7 w-7 text-slate-500" aria-hidden="true" />
                <span className="text-[15px] font-semibold text-slate-900">
                  Choose a CSV file
                </span>
                <span className="text-[13px] text-slate-600">
                  Up to 1,000 rows and 2 MB (Excel “CSV UTF-8”), or drop the file here.
                </span>
                {fileName ? (
                  <span className="mt-1 rounded-lg bg-slate-100 px-2 py-1 font-mono text-[12px] text-slate-700">
                    {fileName}
                  </span>
                ) : null}
              </label>
            </div>

            <InlineAlert tone="info" title="Header row">
              <p>The first line of the file must be exactly:</p>
              <p className="mt-1 overflow-x-auto rounded-lg bg-white/70 px-2 py-1 font-mono text-[13px]">
                {EXPECTED_HEADER}
              </p>
              <p className="mt-2">
                Optional columns: <span className="font-mono text-[13px]">{OPTIONAL_COLUMNS}</span>
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                <li>
                  <strong>full_name</strong> is required (2–120 characters).
                </li>
                <li>
                  <strong>date_of_birth</strong> and <strong>registration_date</strong> are optional, as{" "}
                  <span className="font-mono">YYYY-MM-DD</span>; the registration date defaults to today.
                </li>
                <li>
                  <strong>guardian1_name</strong> and <strong>guardian1_phone</strong> are required; the phone is
                  normalised to international format.
                </li>
                <li>
                  <strong>age_group</strong> is optional and must match an existing group name; leave it empty to
                  assign the player later.
                </li>
                <li>
                  <strong>status</strong> defaults to <span className="font-mono">active</span>;{" "}
                  <strong>whatsapp_consent</strong> defaults to <span className="font-mono">unknown</span>, and{" "}
                  <span className="font-mono">granted</span> also needs a{" "}
                  <span className="font-mono">consent_source</span>.
                </li>
                <li>
                  Comma or semicolon delimiters are both accepted; the file is limited to 1,000 rows.
                </li>
              </ul>
            </InlineAlert>

            <InlineAlert tone="warning" title="What happens next">
              <p>
                Validating only reads the file — no player, guardian or invoice is created. Rows with errors stop
                the whole import; when you commit, every valid row is created together.
              </p>
              <p className="mt-1">
                Guardians are imported with the consent the file records — <strong>unknown</strong> unless a row
                says <span className="font-mono">granted</span> with a source — so no WhatsApp message is sent
                until consent is recorded.
              </p>
            </InlineAlert>

            <p className="text-[13px] text-slate-600">
              In this build the file is parsed by the mock server in the browser; committing keeps the new players
              until the page data is cleared. The real backend validates and commits rows in one transaction.
            </p>

            {busy === "validate" ? <ListSkeleton rows={3} /> : null}
          </div>
        </Card>
      ) : null}

      {step === "review" && validation ? (
        <div className="space-y-4">
          <Card>
            <SectionTitle right={<span className="text-[13px] text-slate-600">nothing created yet</span>}>
              2 · Review {validation.rowCount} row{validation.rowCount === 1 ? "" : "s"}
            </SectionTitle>
            <div className="space-y-4 p-4">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Rows read", value: validation.rowCount },
                  { label: "Ready to import", value: importableCount },
                  { label: "Errors", value: errorCount },
                  { label: "Warnings", value: warningCount },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-xl border border-slate-200 px-3 py-2">
                    <dt className="text-[12px] uppercase tracking-wide text-slate-500">{stat.label}</dt>
                    <dd className="tabular font-heading text-[20px] font-semibold text-slate-900">{stat.value}</dd>
                  </div>
                ))}
              </dl>

              {errorCount > 0 ? (
                <InlineAlert tone="danger" title={`${errorCount} row error${errorCount === 1 ? "" : "s"} — this file cannot be imported`}>
                  <p>Fix the rows below in the spreadsheet, export the CSV again and upload it.</p>
                  <ul className="mt-2 space-y-1">
                    {validation.errors.slice(0, 50).map((issue, index) => (
                      <li key={`${issue.row}-${issue.field ?? "row"}-${index}`} className="text-[13px]">
                        <span className="font-semibold">Row {issue.row}</span>
                        {issue.field ? <> · <span className="font-mono">{issue.field}</span></> : null} — {issue.message}
                      </li>
                    ))}
                  </ul>
                  {validation.errors.length > 50 ? (
                    <p className="mt-1 text-[13px]">
                      Showing the first 50 of {validation.errors.length} errors.
                    </p>
                  ) : null}
                </InlineAlert>
              ) : null}

              {warningCount > 0 ? (
                <InlineAlert tone="warning" title={`${warningCount} warning${warningCount === 1 ? "" : "s"} — the import can continue`}>
                  <ul className="space-y-1">
                    {validation.warnings.slice(0, 50).map((issue, index) => (
                      <li key={`${issue.row}-${issue.field ?? "row"}-${index}`} className="text-[13px]">
                        <span className="font-semibold">Row {issue.row}</span>
                        {issue.field ? <> · <span className="font-mono">{issue.field}</span></> : null} — {issue.message}
                      </li>
                    ))}
                  </ul>
                </InlineAlert>
              ) : null}
            </div>
          </Card>

          <Card>
            <SectionTitle>Preview</SectionTitle>
            {validation.preview.length === 0 ? (
              <p className="px-4 py-6 text-[14px] text-slate-600">
                No rows can be imported from this file yet.
              </p>
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full border-collapse text-[14px]">
                    <caption className="sr-only">
                      Parsed rows: {validation.preview.length} of {validation.rowCount}
                    </caption>
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                        <th scope="col" className="px-4 py-3 font-semibold">Row</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Date of birth</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Age group</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Guardian</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.preview.map((row) => (
                        <tr key={row.row} className="border-b border-slate-100 last:border-0">
                          <td className="tabular px-4 py-3 text-slate-600">{row.row}</td>
                          <td className="px-4 py-3 font-semibold text-slate-900">{row.fullName}</td>
                          <td className="px-4 py-3 text-slate-700">
                            <DateText value={row.dateOfBirth} />
                          </td>
                          <td className="px-4 py-3 text-slate-700">{row.ageGroupName ?? "Assign later"}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {(row.status ?? "active").charAt(0).toUpperCase() + (row.status ?? "active").slice(1)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">{row.guardianName || "—"}</td>
                          <td className="px-4 py-3 text-slate-700">{row.guardianPhone}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul className="divide-y divide-slate-100 md:hidden">
                  {validation.preview.map((row) => (
                    <li key={row.row} className="px-4 py-3">
                      <p className="text-[15px] font-semibold text-slate-900">{row.fullName}</p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        Row {row.row} · {row.ageGroupName ?? "Assign later"} ·{" "}
                        {(row.status ?? "active").charAt(0).toUpperCase() + (row.status ?? "active").slice(1)} ·{" "}
                        {row.dateOfBirth ? <DateText value={row.dateOfBirth} /> : "no date of birth"}
                      </p>
                      <p className="mt-1 text-[13px] text-slate-700">
                        {row.guardianName || "Guardian"} · {row.guardianPhone}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {warningCount > 0 && errorCount === 0 ? (
              <div className="border-t border-slate-200 px-4 py-3">
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-[14px] font-semibold text-slate-800">
                  <input
                    id="import-warnings"
                    type="checkbox"
                    className="mt-1 h-6 w-6 cursor-pointer rounded border-slate-400"
                    checked={importWarnings}
                    onChange={(event) => setImportWarnings(event.target.checked)}
                  />
                  <span>
                    Also import the {warningRows} row{warningRows === 1 ? "" : "s"} with warnings
                    <span className="block text-[13px] font-normal text-slate-600">
                      Warnings never block a row, but nothing with a warning is created unless you
                      ask for it. Possible duplicates are the common case.
                    </span>
                  </span>
                </label>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] text-slate-600">
                {errorCount > 0
                  ? "Fix the errors before committing — the import is all-or-nothing."
                  : `All ${importableCount} valid row${importableCount === 1 ? "" : "s"} will be created together${
                      warningCount > 0 && !importWarnings
                        ? `, and ${warningRows} warning row${warningRows === 1 ? "" : "s"} will be skipped`
                        : ""
                    }.`}
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button variant="secondary" onClick={restart} disabled={busy === "commit"}>
                  Choose a different file
                </Button>
                <Button onClick={commit} pending={busy === "commit"} disabled={errorCount > 0 || importableCount === 0}>
                  {busy === "commit"
                    ? "Importing…"
                    : `Commit ${importableCount} player${importableCount === 1 ? "" : "s"}`}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {step === "done" && result ? (
        <Card>
          <SectionTitle>3 · Done</SectionTitle>
          <div className="space-y-4 p-4">
            <InlineAlert tone="success" title="Import finished">
              <p>
                <strong className="tabular">{result.created}</strong> player
                {result.created === 1 ? "" : "s"} created
                {result.skipped > 0 ? (
                  <>
                    , <strong className="tabular">{result.skipped}</strong> row
                    {result.skipped === 1 ? "" : "s"} skipped (row errors, and warnings you did not
                    approve).
                  </>
                ) : (
                  "."
                )}
              </p>
              <p className="mt-1">
                Registration numbers were assigned in order and each player keeps the status the file
                recorded. Guardians carry the consent the file recorded —
                <strong> unknown</strong> unless it was granted with a source, and nothing is sent
                until consent is recorded on the profile.
              </p>
            </InlineAlert>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href="/players" className={buttonClass("primary")}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Go to players
              </Link>
              <Button variant="secondary" onClick={restart}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Import another file
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

export default function ImportPlayersPage() {
  return (
    <RequirePermissions path="/imports">
      <ImportWizard />
    </RequirePermissions>
  );
}
