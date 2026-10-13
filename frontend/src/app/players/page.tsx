"use client";

// PLY-01 player list (PAGE_SPECIFICATIONS §3, ROUTES_AND_NAVIGATION §1).
// Owner columns include the primary guardian phone and the outstanding balance;
// a coach sees the PlayerCoachView projection (reg no, name, age, group, status)
// and never the money or guardian columns.
// Filter/sort/page state lives in the URL so it is shareable and back-button safe.
import { Suspense, useCallback, useDeferredValue, useMemo, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Upload, UserPlus } from "lucide-react";
import { grp01ListAgeGroups, ply01ListPlayers } from "@/api/client";
import { isOwnerPlayer, type PlayerListItem, type PlayerStatus } from "@/api/types";
import { RequireAuth } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { Button, Card, EmptyState, ErrorState, ListSkeleton, TextField, buttonClass } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { formatMoneyMinor } from "@/lib/money";

const PAGE_SIZE = 25;

/** Columns the contract allows for `sort` (PLY-01). */
type SortField = "fullName" | "registrationDate" | "registrationNo";

function statusLabel(status: PlayerStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PlayersList() {
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const q = searchParams.get("q") ?? "";
  const status = (searchParams.get("status") ?? "active") as PlayerStatus;
  const ageGroupId = searchParams.get("ageGroupId") ?? "";
  const hasOutstanding = searchParams.get("hasOutstanding") === "true";
  const sort = searchParams.get("sort") ?? "fullName";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  // The URL is the single source of truth for the search text and the filters:
  // a soft navigation re-renders this subtree, and a local draft would swallow
  // whatever the user typed while that happened. `useDeferredValue` keeps the
  // field responsive without firing a request per keystroke.
  const deferredQ = useDeferredValue(q);

  // URL-first filter state, with one wrinkle: `router.replace` commits the new
  // query a moment later, so two filter changes in the same moment (change the
  // status, then start typing) would otherwise both rebuild from the query the
  // browser still reports and the second would silently undo the first. While a
  // write is in flight we therefore merge into the query we asked for; once it
  // lands — or after a short window, so a Back press wins — the URL is the only
  // source of truth again.
  const lastWrite = useRef<{ query: string; at: number } | null>(null);
  const renderedQuery = searchParams.toString();

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const inFlight = lastWrite.current;
      const pending =
        Boolean(inFlight) &&
        Date.now() - (inFlight?.at ?? 0) < 1500 &&
        inFlight?.query !== renderedQuery;
      const next = new URLSearchParams(pending ? (inFlight?.query ?? "") : renderedQuery);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // Any filter change restarts paging unless it *is* the page change.
      if (!("page" in patch)) next.delete("page");
      const query = next.toString();
      lastWrite.current = { query, at: Date.now() };
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, renderedQuery, router]
  );

  const playersQuery = useQuery({
    queryKey: [
      "players",
      { q: deferredQ, status, ageGroupId, hasOutstanding, sort, page, role: me?.user.role },
    ],
    queryFn: () =>
      ply01ListPlayers({
        // The contract only applies `q` from 2 characters.
        q: deferredQ.trim().length >= 2 ? deferredQ.trim() : undefined,
        status,
        ageGroupId: ageGroupId || undefined,
        hasOutstanding,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: Boolean(me),
    // Keep the current rows on screen while the next page arrives instead of
    // flashing the skeleton on every keystroke.
    placeholderData: (previous) => previous,
  });

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
    enabled: isOwner,
  });

  const rows = playersQuery.data?.data ?? [];
  const meta = playersQuery.data?.meta;
  const activeFilterCount = useMemo(
    () =>
      [q ? 1 : 0, status !== "active" ? 1 : 0, ageGroupId ? 1 : 0, hasOutstanding ? 1 : 0].reduce(
        (a, b) => a + b,
        0
      ),
    [q, status, ageGroupId, hasOutstanding]
  );

  return (
    <>
      <PageHeader
        title="Players"
        sub={`Ages are measured on 1 January ${todayISO().slice(0, 4)}. Invoiced and collected balances are always shown separately.`}
        actions={
          isOwner ? (
            <>
              <Link href="/imports/players" className={buttonClass("secondary", "sm")}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Import CSV
              </Link>
              <Link href="/players/new" className={buttonClass("primary", "sm")}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Register player
              </Link>
            </>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            id="player-search"
            label="Search"
            placeholder="Name or registration no."
            value={q}
            onChange={(e) => setParams({ q: e.target.value || null })}
            hint="Two characters or more."
          />
          <div>
            <label htmlFor="player-status" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Status
            </label>
            <select
              id="player-status"
              value={status}
              onChange={(e) => setParams({ status: e.target.value })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </div>
          {isOwner ? (
            <div>
              <label htmlFor="player-group" className="mb-1 block text-[14px] font-semibold text-slate-800">
                Age group
              </label>
              <select
                id="player-group"
                value={ageGroupId}
                onChange={(e) => setParams({ ageGroupId: e.target.value || null })}
                className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
              >
                <option value="">All groups</option>
                {(groupsQuery.data?.data ?? []).map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {isOwner ? (
            <div className="flex items-end">
              <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] font-semibold text-slate-800">
                <input
                  type="checkbox"
                  className="h-6 w-6 cursor-pointer rounded border-slate-400"
                  checked={hasOutstanding}
                  onChange={(e) => setParams({ hasOutstanding: e.target.checked ? "true" : null })}
                />
                Has outstanding
              </label>
            </div>
          ) : null}
        </div>
        {activeFilterCount > 1 ? (
          <div className="border-t border-slate-200 px-4 py-2">
            <button
              type="button"
              className="cursor-pointer text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              onClick={() => setParams({ q: null, status: "active", ageGroupId: null, hasOutstanding: null })}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </Card>

      <Card>
        {playersQuery.isLoading ? (
          <ListSkeleton rows={6} />
        ) : playersQuery.isError ? (
          <ErrorState error={playersQuery.error} onRetry={() => playersQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q || activeFilterCount ? "No players match these filters" : "No players yet"}
            description={
              q || activeFilterCount
                ? "Try a different search term or clear the filters."
                : isOwner
                  ? "Register the first player to start building the roster."
                  : "Players from your groups will show up here once they are assigned."
            }
            action={
              isOwner ? (
                <Link href="/players/new" className={buttonClass("primary")}>
                  Register player
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Players{meta ? `, ${meta.total} matching, page ${meta.page} of ${meta.totalPages}` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <SortHeader label="Reg no" field="registrationNo" sort={sort} onSort={(next) => setParams({ sort: next })} />
                    <SortHeader label="Name" field="fullName" sort={sort} onSort={(next) => setParams({ sort: next })} />
                    <th scope="col" className="px-4 py-3 font-semibold">Age group</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Age</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    {isOwner ? <th scope="col" className="px-4 py-3 font-semibold">Primary guardian</th> : null}
                    {isOwner ? <th scope="col" className="px-4 py-3 text-right font-semibold">Outstanding</th> : null}
                    <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((player) => (
                    <tr key={player.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-600">{player.registrationNo}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        <Link href={`/players/${player.id}`} className="underline-offset-2 hover:underline">
                          {player.fullName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{groupName(player)}</td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">{ageOf(player) ?? "—"}</td>
                      <td className="px-4 py-3"><StatusChip status={statusLabel(player.status)} /></td>
                      {isOwner ? (
                        <td className="px-4 py-3 text-slate-700">{guardianPhone(player)}</td>
                      ) : null}
                      {isOwner ? (
                        <td className="tabular px-4 py-3 text-right font-semibold text-slate-900">
                          {outstandingText(player)}
                        </td>
                      ) : null}
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/players/${player.id}`}
                          className="font-semibold text-pitch-700 underline underline-offset-2"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {rows.map((player) => (
                <li key={player.id}>
                  <Link href={`/players/${player.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-slate-900">{player.fullName}</p>
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          <span className="font-mono">{player.registrationNo}</span> · {groupName(player)}
                          {ageOf(player) !== null ? ` · age ${ageOf(player)}` : ""}
                        </p>
                      </div>
                      <StatusChip status={statusLabel(player.status)} />
                    </div>
                    {isOwner && isOwnerPlayer(player) ? (
                      <p className="tabular mt-2 text-[13px] text-slate-700">
                        {guardianPhone(player)} · Outstanding {outstandingText(player)}
                      </p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}

        {meta && meta.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[14px]">
            <p className="text-slate-600">
              Showing <span className="tabular">{rows.length}</span> of{" "}
              <span className="tabular">{meta.total}</span> {status}
              {q ? " matching" : ""} players
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setParams({ page: String(page - 1) })}
              >
                Previous
              </Button>
              <span className="tabular text-slate-600">
                {meta.page} / {meta.totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= meta.totalPages}
                onClick={() => setParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function SortHeader({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: string;
  onSort: (next: string) => void;
}) {
  const active = sort === field || sort === `-${field}`;
  const descending = sort === `-${field}`;
  return (
    <th
      scope="col"
      aria-sort={active ? (descending ? "descending" : "ascending") : "none"}
      className="px-4 py-3 font-semibold"
    >
      <button
        type="button"
        onClick={() => onSort(descending ? field : `-${field}`)}
        className="inline-flex cursor-pointer items-center gap-1 text-[13px] uppercase tracking-wide text-slate-500 hover:text-slate-900"
      >
        {label}
        {active ? (
          descending ? (
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : null}
      </button>
    </th>
  );
}

function groupName(player: PlayerListItem): string {
  if (isOwnerPlayer(player)) return player.currentGroup?.name ?? "Assignment pending";
  return player.group?.name ?? "—";
}

function ageOf(player: PlayerListItem): number | null {
  if (isOwnerPlayer(player)) return player.ageOnReference ?? null;
  return player.age ?? null;
}

function guardianPhone(player: PlayerListItem): string {
  if (!isOwnerPlayer(player)) return "—";
  const primary = player.guardians.find((link) => link.isPrimary) ?? player.guardians[0];
  return primary?.guardian.phone ?? "—";
}

function outstandingText(player: PlayerListItem): string {
  if (!isOwnerPlayer(player)) return "—";
  return formatMoneyMinor(player.outstandingMinor ?? 0);
}

export default function PlayersPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<ListSkeleton rows={6} />}>
        <PlayersList />
      </Suspense>
    </RequireAuth>
  );
}
