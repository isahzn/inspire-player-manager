"use client";

// Audit history (PAGE_SPECIFICATIONS §11 "Audit", API_CONTRACTS AUD-01).
// Owner-only route (`/audit` → `audit:read`), so the guard runs before the API
// call. The table is newest-first (the contract sorts `-occurredAt`) and the
// detail drawer shows the before/after snapshots EXACTLY as the API returned
// them — pretty-printed, nothing reconstructed, masked values left masked.
//
// The drawer is the shared `Modal`, which already traps focus and closes on
// Escape, so the drawer inherits the same keyboard contract as every dialog.
//
// `from`/`to` are sent as `YYYY-MM-DD` and the API is expected to read them as
// inclusive day bounds (academy-local). The contract does not say whether these
// are dates or instants — flagged in the Step 8 handoff rather than guessed at
// in code.

import { Suspense, useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Eye, Filter } from "lucide-react";
import { aud01ListAuditLogs, usr01ListUsers } from "@/api/client";
import type { AuditEntry } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  ListSkeleton,
  Modal,
  SelectField,
  TextField,
} from "@/components/ui";

const PAGE_SIZE = 25;

/** Pretty-print a snapshot without interpreting it (unknown ⇒ shown verbatim). */
function snapshot(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function roleWord(role: string): string {
  return role === "owner" ? "Owner" : role === "coach" ? "Coach" : role;
}

function useAuditFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const actorUserId = searchParams.get("actorUserId") ?? "";
  const entityType = searchParams.get("entityType") ?? "";
  const entityId = searchParams.get("entityId") ?? "";
  const action = searchParams.get("action") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  // One key at a time, merged into the params as they are now — two quick filter
  // changes cannot swallow each other (the same write path the other lists use).
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== "page") next.delete("page");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const clearAll = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  return { actorUserId, entityType, entityId, action, from, to, page, setParam, clearAll };
}

function AuditScreen() {
  const { actorUserId, entityType, entityId, action, from, to, page, setParam, clearAll } =
    useAuditFilters();
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  // The actor filter needs the user list; the page is owner-only, so USR-01 is
  // an allowed read here. If it fails the filter degrades to "All actors".
  const usersQuery = useQuery({
    queryKey: ["users", { role: undefined, status: undefined, q: "", page: 1 }],
    queryFn: () => usr01ListUsers({ pageSize: 100 }),
  });

  const logsQuery = useQuery({
    queryKey: ["audit", { actorUserId, entityType, entityId, action, from, to, page }],
    queryFn: () =>
      aud01ListAuditLogs({
        actorUserId: actorUserId || undefined,
        entityType: entityType.trim() || undefined,
        entityId: entityId.trim() || undefined,
        action: action.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });

  // Memoised so the `[]` fallback is not a new array on every render — the
  // entity-type list below depends on it.
  const entries = useMemo(() => logsQuery.data?.data ?? [], [logsQuery.data]);
  const meta = logsQuery.data?.meta;
  const users = usersQuery.data?.data ?? [];

  const entityTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of entries) seen.add(entry.entityType);
    return [...seen].sort();
  }, [entries]);

  const isFiltered = Boolean(actorUserId || entityType || entityId || action || from || to);

  return (
    <>
      <PageHeader
        title="Audit"
        sub="Every sensitive change, newest first — who did it, what changed, and the reference to quote if something looks wrong."
      />

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            id="audit-actor"
            label="Actor"
            value={actorUserId}
            onChange={(e) => setParam("actorUserId", e.target.value || null)}
            hint={
              usersQuery.isError
                ? "The user list could not be loaded, so only All actors is available."
                : undefined
            }
          >
            <option value="">All actors</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.fullName} · {roleWord(user.role)}
              </option>
            ))}
          </SelectField>
          <TextField
            id="audit-entity-type"
            label="Entity type"
            placeholder="invoice, payment, player…"
            value={entityType}
            onChange={(e) => setParam("entityType", e.target.value || null)}
            list="audit-entity-types"
          />
          <datalist id="audit-entity-types">
            {entityTypes.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
          <TextField
            id="audit-entity-id"
            label="Entity id"
            placeholder="Exact id"
            value={entityId}
            onChange={(e) => setParam("entityId", e.target.value || null)}
          />
          <TextField
            id="audit-action"
            label="Action"
            placeholder="invoice.issue, payment.confirm…"
            value={action}
            onChange={(e) => setParam("action", e.target.value || null)}
          />
          <TextField
            id="audit-from"
            label="From"
            type="date"
            value={from}
            onChange={(e) => setParam("from", e.target.value || null)}
            hint="Inclusive, academy-local day."
          />
          <TextField
            id="audit-to"
            label="To"
            type="date"
            value={to}
            onChange={(e) => setParam("to", e.target.value || null)}
            hint="Inclusive, academy-local day."
          />
        </div>
        {isFiltered ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
            <p className="text-[13px] text-slate-600">
              Filters applied. The same filters are recorded with every export an owner makes from
              the reports screens.
            </p>
            <Button size="sm" variant="secondary" onClick={clearAll}>
              <Filter className="h-4 w-4" aria-hidden="true" />
              Clear filters
            </Button>
          </div>
        ) : null}
      </Card>

      <Card>
        {logsQuery.isLoading ? (
          <ListSkeleton rows={6} />
        ) : logsQuery.isError ? (
          <ErrorState error={logsQuery.error} onRetry={() => logsQuery.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState
            title={isFiltered ? "Nothing matches these filters" : "No activity recorded yet"}
            description={
              isFiltered
                ? "Widen the date range or clear a filter. The table only lists what the server recorded."
                : "Sensitive changes — issuing invoices, confirming payments, editing settings — appear here as they happen."
            }
            action={
              isFiltered ? (
                <Button variant="secondary" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Audit history{meta ? `, ${meta.total} entries` : ""}, newest first
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">When</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Actor</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Action</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Entity</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Reason</th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Detail</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100 last:border-0 align-top">
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                        <DateText value={entry.occurredAt} withTime />
                      </td>
                      <td className="px-4 py-3 text-slate-800">
                        {entry.actor ? (
                          <>
                            <span className="font-semibold">{entry.actor.fullName}</span>
                            <p className="mt-0.5 text-[13px] text-slate-600">
                              {roleWord(entry.actor.role)}
                            </p>
                          </>
                        ) : (
                          <span className="text-slate-500">System</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-800">
                        {entry.action}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <span className="font-semibold">{entry.entityType}</span>
                        <p className="mt-0.5 font-mono text-[12px] text-slate-500 break-all">
                          {entry.entityId}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {entry.reason ?? <span className="text-slate-500">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelected(entry)}
                          aria-label={`View detail for ${entry.action}`}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                          Detail
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {entries.map((entry) => (
                <li key={entry.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-[13px] font-semibold text-slate-900">
                        {entry.action}
                      </p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        <DateText value={entry.occurredAt} withTime />
                      </p>
                      <p className="mt-0.5 text-[13px] text-slate-700">
                        {entry.actor ? entry.actor.fullName : "System"}
                        {entry.actor ? ` · ${roleWord(entry.actor.role)}` : ""}
                      </p>
                      <p className="mt-0.5 break-all text-[12px] text-slate-500">
                        {entry.entityType} · {entry.entityId}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-3"
                    onClick={() => setSelected(entry)}
                  >
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    Detail
                  </Button>
                </li>
              ))}
            </ul>

            {meta && meta.totalPages > 1 ? (
              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                <p className="text-[13px] text-slate-600">
                  Page {meta.page} of {meta.totalPages} · {meta.total} entries
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={meta.page <= 1}
                    onClick={() => setParam("page", String(meta.page - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={meta.page >= meta.totalPages}
                    onClick={() => setParam("page", String(meta.page + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <AuditDetailDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function AuditDetailDrawer({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;
  const before = snapshot(entry.before);
  const after = snapshot(entry.after);

  return (
    <Modal
      open
      onClose={onClose}
      title={entry.action}
      description={`${entry.entityType} · ${entry.entityId}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <dl className="grid grid-cols-1 gap-3 text-[14px] sm:grid-cols-2">
        <div>
          <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">When</dt>
          <dd className="mt-0.5 text-slate-800">
            <DateText value={entry.occurredAt} withTime />
          </dd>
        </div>
        <div>
          <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Actor</dt>
          <dd className="mt-0.5 text-slate-800">
            {entry.actor ? `${entry.actor.fullName} · ${roleWord(entry.actor.role)}` : "System"}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Entity id
          </dt>
          <dd className="mt-0.5 break-all font-mono text-[13px] text-slate-800">
            {entry.entityId}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Reference
          </dt>
          <dd className="mt-0.5 font-mono text-[13px] text-slate-800">{entry.requestId}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            Reason
          </dt>
          <dd className="mt-0.5 text-slate-800">
            {entry.reason ?? <span className="text-slate-500">No reason was recorded.</span>}
          </dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4">
        <SnapshotBlock label="Before" value={before} empty="No earlier state recorded." />
        <SnapshotBlock label="After" value={after} empty="No later state recorded." />
      </div>

      <p className="mt-4 text-[13px] text-slate-600">
        Values are shown exactly as the server recorded them, including anything it masked. Nothing
        here is reconstructed or reformatted beyond indentation.
      </p>
    </Modal>
  );
}

function SnapshotBlock({
  label,
  value,
  empty,
}: {
  label: string;
  value: string;
  empty: string;
}) {
  return (
    <section aria-label={label}>
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">{label}</h3>
      {value ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-800">
          {value}
        </pre>
      ) : (
        <p className="mt-1.5 rounded-xl border border-dashed border-slate-200 px-3 py-2 text-[13px] text-slate-500">
          {empty}
        </p>
      )}
    </section>
  );
}

export default function AuditPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/audit">
        <Suspense fallback={<ListSkeleton rows={6} />}>
          <AuditScreen />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
