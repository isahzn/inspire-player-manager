"use client";

// Player profile (PLY-03/07/09/10/11, GDN-03/04/05) — PAGE_SPECIFICATIONS §3.
// Owner tabs: Overview · Guardians · Group history · Attendance · Invoices ·
// Messages. A coach gets Overview + Attendance only, with the restricted
// projection (PLY-03) — no balances, guardians list, notes or invoices, and the
// owner endpoints are never called for a coach.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { PencilLine } from "lucide-react";
import {
  ApiError,
  gdn01ListGuardians,
  gdn03LinkGuardian,
  gdn04PatchLink,
  gdn04RemoveLink,
  gdn05SetConsent,
  grp01ListAgeGroups,
  ply03GetPlayer,
  ply05SetPlayerStatus,
  ply06TransferPlayer,
  ply07PlayerGroupHistory,
  ply09PlayerInvoices,
  ply10PlayerAttendance,
  ply11PlayerBalance,
} from "@/api/client";
import {
  isOwnerPlayer,
  type GroupHistoryEntry,
  type Invoice,
  type Page,
  type Player,
  type PlayerAttendance,
  type PlayerListItem,
  type PlayerStatus,
} from "@/api/types";
import { AuthLoading, RequireAuth } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  BackLink,
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  MoneyText,
  SelectField,
  Tabs,
  TextAreaField,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { ageOn, formatDateRange, todayISO } from "@/lib/dates";
import { formatMoneyMinor } from "@/lib/money";

function statusLabel(status: PlayerStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function PlayerProfilePage() {
  return (
    <RequireAuth>
      <Suspense fallback={<AuthLoading />}>
        <PlayerProfile />
      </Suspense>
    </RequireAuth>
  );
}

function PlayerProfile() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = params?.id ?? "";
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const queryClient = useQueryClient();

  const [tab, setTab] = useState("overview");
  const [toast, setToast] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [attendanceFrom, setAttendanceFrom] = useState("");
  const [attendanceTo, setAttendanceTo] = useState("");
  // The register screen arrives with ?created=1. Derived from the URL rather
  // than copied into state by an effect, so a back/forward navigation is exact.
  const [createdNoticeDismissed, setCreatedNoticeDismissed] = useState(false);
  const createdNotice = searchParams.get("created") === "1" && !createdNoticeDismissed;

  const playerQuery = useQuery({
    queryKey: ["player", id],
    queryFn: () => ply03GetPlayer(id),
    enabled: Boolean(id),
  });

  const player = playerQuery.data;
  // Narrowed owner projection (a coach never receives guardians/balances).
  const ownerPlayer = player && isOwnerPlayer(player) ? player : null;

  const historyQuery = useQuery({
    queryKey: ["player-history", id],
    queryFn: () => ply07PlayerGroupHistory(id),
    enabled: Boolean(id) && Boolean(isOwner),
  });

  const invoicesQuery = useQuery({
    queryKey: ["player-invoices", id],
    queryFn: () => ply09PlayerInvoices(id),
    enabled: Boolean(id) && Boolean(isOwner),
  });

  const balanceQuery = useQuery({
    queryKey: ["player-balance", id],
    queryFn: () => ply11PlayerBalance(id),
    enabled: Boolean(id) && Boolean(isOwner),
  });

  const attendanceQuery = useQuery({
    queryKey: ["player-attendance", id, { attendanceFrom, attendanceTo }],
    queryFn: () =>
      ply10PlayerAttendance(id, {
        from: attendanceFrom || undefined,
        to: attendanceTo || undefined,
      }),
    enabled: Boolean(id),
  });

  async function refreshPlayer() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["player", id] }),
      queryClient.invalidateQueries({ queryKey: ["player-history", id] }),
      queryClient.invalidateQueries({ queryKey: ["player-balance", id] }),
      queryClient.invalidateQueries({ queryKey: ["players"] }),
    ]);
  }

  if (playerQuery.isLoading) {
    return (
      <>
        <BackLink href="/players">Players</BackLink>
        <ListSkeleton rows={5} />
      </>
    );
  }
  if (playerQuery.isError || !player) {
    return (
      <>
        <BackLink href="/players">Players</BackLink>
        <Card>
          <ErrorState error={playerQuery.error} onRetry={() => playerQuery.refetch()} />
        </Card>
      </>
    );
  }

  const tabs = isOwner
    ? [
        { key: "overview", label: "Overview" },
        { key: "guardians", label: "Guardians" },
        { key: "history", label: "Group history" },
        { key: "attendance", label: "Attendance" },
        { key: "invoices", label: "Invoices" },
        { key: "messages", label: "Messages" },
      ]
    : [
        { key: "overview", label: "Overview" },
        { key: "attendance", label: "Attendance" },
      ];

  return (
    <>
      <BackLink href="/players">Players</BackLink>
      <PageHeader
        title={player.fullName}
        sub={`${player.registrationNo} · ${groupLabel(player)}`}
        actions={
          isOwner ? (
            <>
              <Link href={`/players/${player.id}/edit`} className={buttonClass("secondary", "sm")}>
                <PencilLine className="h-4 w-4" aria-hidden="true" />
                Edit
              </Link>
              <Button variant="secondary" size="sm" onClick={() => setTransferOpen(true)}>
                Transfer group
              </Button>
              <Button size="sm" onClick={() => setStatusOpen(true)}>
                Change status
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusChip status={statusLabel(player.status)} />
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
          {groupLabel(player)}
        </span>
        {ownerPlayer ? (
          <span className="tabular rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700">
            Outstanding {moneyOf(ownerPlayer)}
          </span>
        ) : null}
        {ownerPlayer && player.status !== "active" ? (
          <span className="text-[13px] text-slate-600">
            {statusLabel(player.status)} since <DateText value={ownerPlayer.statusEffectiveDate} />
            {ownerPlayer.statusReason ? ` — ${ownerPlayer.statusReason}` : ""}
          </span>
        ) : null}
      </div>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
      {createdNotice ? (
        <Toast message="Player registered." onDismiss={() => setCreatedNoticeDismissed(true)} />
      ) : null}

      <Card>
        <div className="px-4 pt-2">
          <Tabs idPrefix="player" tabs={tabs} active={tab} onChange={setTab} />
        </div>

        <div
          id={`player-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`player-tab-${tab}`}
          className="p-4"
        >
          {tab === "overview" ? <OverviewTab player={player} isOwner={Boolean(isOwner)} /> : null}
          {tab === "attendance" ? (
            <AttendanceTab
              query={attendanceQuery}
              from={attendanceFrom}
              to={attendanceTo}
              onFrom={setAttendanceFrom}
              onTo={setAttendanceTo}
            />
          ) : null}
          {tab === "guardians" && ownerPlayer ? (
            <GuardiansTab player={ownerPlayer} onChanged={refreshPlayer} onToast={setToast} />
          ) : null}
          {tab === "history" ? (
            <GroupHistoryTab query={historyQuery} />
          ) : null}
          {tab === "invoices" ? <InvoicesTab query={invoicesQuery} /> : null}
          {tab === "messages" ? (
            <InlineAlert tone="info" title="Messages arrive with the WhatsApp slice">
              The per-player message history (MSG-01 filtered by player) is built in the messaging
              step. Nothing is sent from this screen, and no delivery state is assumed here.
            </InlineAlert>
          ) : null}
        </div>
      </Card>

      {/* Mounted on open, so each dialog starts from the current record with no
          reset effect (and never shows a stale status or group). */}
      {isOwner && ownerPlayer && statusOpen ? (
        <StatusDialog
          key={`status-${ownerPlayer.version}`}
          player={ownerPlayer}
          onClose={() => setStatusOpen(false)}
          onSaved={async (message) => {
            setStatusOpen(false);
            await refreshPlayer();
            setToast(message);
          }}
        />
      ) : null}
      {isOwner && ownerPlayer && transferOpen ? (
        <TransferDialog
          key={`transfer-${ownerPlayer.version}`}
          player={ownerPlayer}
          onClose={() => setTransferOpen(false)}
          onSaved={async () => {
            setTransferOpen(false);
            await refreshPlayer();
            setToast("Group changed. Existing invoices are unchanged.");
          }}
        />
      ) : null}

      {isOwner && balanceQuery.data ? (
        <p className="mt-3 text-[13px] text-slate-600">
          Balances: outstanding <MoneyText minor={balanceQuery.data.outstandingMinor} /> · overdue{" "}
          <MoneyText minor={balanceQuery.data.overdueMinor} /> · credit held{" "}
          <MoneyText minor={balanceQuery.data.creditMinor} />. Invoice totals and collected amounts
          are always read separately.
        </p>
      ) : null}
    </>
  );
}

function groupLabel(player: PlayerListItem): string {
  if (isOwnerPlayer(player)) return player.currentGroup?.name ?? "Assignment pending";
  return player.group?.name ?? "No group";
}

function moneyOf(player: Player): string {
  return formatMoneyMinor(player.outstandingMinor ?? 0);
}

function OverviewTab({ player, isOwner }: { player: PlayerListItem; isOwner: boolean }) {
  const owner = isOwnerPlayer(player);
  const reference = `${todayISO().slice(0, 4)}-01-01`;
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Registration no", value: <span className="font-mono">{player.registrationNo}</span> },
    { label: "Status", value: statusLabel(player.status) },
  ];
  if (owner) {
    rows.push(
      {
        label: "Date of birth",
        value: player.dateOfBirth ? (
          <span>
            <DateText value={player.dateOfBirth} /> (age {player.ageOnReference ?? ageOn(player.dateOfBirth, reference)} on {reference})
          </span>
        ) : (
          "Not recorded"
        ),
      },
      { label: "Registration date", value: <DateText value={player.registrationDate} /> },
      {
        label: "Billing anchor",
        value: <DateText value={player.billingAnchorDate} />,
      },
      {
        label: "Current group since",
        value: player.currentGroup ? <DateText value={player.currentGroup.since} /> : "Not assigned",
      },
      { label: "Status effective from", value: <DateText value={player.statusEffectiveDate} /> }
    );
  } else {
    rows.push(
      { label: "Age", value: player.age ?? "Not recorded" },
      { label: "Group", value: groupLabel(player) }
    );
    if (player.primaryGuardian) {
      rows.push({
        label: "Primary guardian",
        value: `${player.primaryGuardian.fullName} · ${player.primaryGuardian.phone}`,
      });
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <h2 className="font-heading text-[15px] font-semibold text-slate-900">Details</h2>
        <dl className="mt-2 divide-y divide-slate-100">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-wrap justify-between gap-2 py-2 text-[14px]">
              <dt className="text-slate-600">{row.label}</dt>
              <dd className="font-medium text-slate-900">{row.value}</dd>
            </div>
          ))}
        </dl>
        {!isOwner && player.status !== "active" ? (
          <p className="mt-2 text-[13px] text-slate-600">
            Only the academy owner can change a player&apos;s status or group.
          </p>
        ) : null}
      </div>
      <div className="space-y-4">
        {owner ? (
          <div>
            <h2 className="font-heading text-[15px] font-semibold text-slate-900">Notes (owner only)</h2>
            <p className="mt-1 whitespace-pre-wrap text-[14px] text-slate-700">
              {player.notes?.trim() ? player.notes : "No notes."}
            </p>
          </div>
        ) : null}
        <div>
          <h2 className="font-heading text-[15px] font-semibold text-slate-900">Coach notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-[14px] text-slate-700">
            {player.coachNotes?.trim() ? player.coachNotes : "No coach notes."}
          </p>
        </div>
      </div>
    </div>
  );
}

function GuardiansTab({
  player,
  onChanged,
  onToast,
}: {
  player: Player;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function guarded(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await onChanged();
      onToast(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not save. Please retry.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-[15px] font-semibold text-slate-900">
          Guardians ({player.guardians.length})
        </h2>
        <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          Add guardian
        </Button>
      </div>

      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {player.guardians.map((link) => (
          <li key={link.guardian.id} className="space-y-3 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-slate-900">
                  {link.guardian.fullName}
                  {link.isPrimary ? (
                    <span className="ml-2 rounded-full bg-pitch-50 px-2 py-0.5 text-[12px] font-semibold text-pitch-700">
                      Primary
                    </span>
                  ) : null}
                </p>
                <p className="text-[13px] text-slate-600">
                  {link.guardian.phone}
                  {link.guardian.relationship ? ` · ${link.guardian.relationship}` : ""}
                </p>
              </div>
              <StatusChip
                status={
                  link.guardian.whatsappConsent.charAt(0).toUpperCase() +
                  link.guardian.whatsappConsent.slice(1)
                }
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor={`consent-${link.guardian.id}`}
                  className="mb-1 block text-[13px] font-semibold text-slate-800"
                >
                  WhatsApp consent (GDN-05)
                </label>
                <select
                  id={`consent-${link.guardian.id}`}
                  value={link.guardian.whatsappConsent}
                  disabled={busy === `consent-${link.guardian.id}`}
                  onChange={(e) =>
                    void guarded(
                      `consent-${link.guardian.id}`,
                      () =>
                        gdn05SetConsent(link.guardian.id, {
                          status: e.target.value as "granted" | "revoked" | "unknown",
                          source: "owner_entry",
                        }),
                      "Consent updated."
                    )
                  }
                  className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-[15px]"
                >
                  <option value="unknown">Unknown — no automation</option>
                  <option value="granted">Granted</option>
                  <option value="revoked">Revoked — opt-out</option>
                </select>
                {link.guardian.whatsappConsent === "revoked" ? (
                  <p className="mt-1 text-[12px] text-red-700">
                    Opted out on <DateText value={link.guardian.optedOutAt?.slice(0, 10)} />. Queued
                    messages for this guardian are cancelled.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Toggle
                  id={`primary-${link.guardian.id}`}
                  label="Primary contact"
                  checked={link.isPrimary}
                  disabled={link.isPrimary || busy === `primary-${link.guardian.id}`}
                  onChange={(next) =>
                    void guarded(
                      `primary-${link.guardian.id}`,
                      () => gdn04PatchLink(player.id, link.guardian.id, { isPrimary: next }),
                      "Primary contact updated."
                    )
                  }
                />
                <Toggle
                  id={`invoices-${link.guardian.id}`}
                  label="Receives invoices"
                  checked={link.receivesInvoices}
                  disabled={busy === `invoices-${link.guardian.id}`}
                  onChange={(next) =>
                    void guarded(
                      `invoices-${link.guardian.id}`,
                      () => gdn04PatchLink(player.id, link.guardian.id, { receivesInvoices: next }),
                      "Invoice preference updated."
                    )
                  }
                />
              </div>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={player.guardians.length <= 1 || busy === `remove-${link.guardian.id}`}
                  onClick={() =>
                    void guarded(
                      `remove-${link.guardian.id}`,
                      () => gdn04RemoveLink(player.id, link.guardian.id),
                      "Guardian removed."
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
            {player.guardians.length <= 1 ? (
              <p className="text-[12px] text-slate-500">
                A player must keep at least one guardian.
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <AddGuardianDialog
        open={addOpen}
        playerId={player.id}
        existingGuardianIds={player.guardians.map((l) => l.guardian.id)}
        onClose={() => setAddOpen(false)}
        onLinked={async () => {
          setAddOpen(false);
          await onChanged();
          onToast("Guardian linked.");
        }}
      />
    </div>
  );
}

function AddGuardianDialog({
  open,
  playerId,
  existingGuardianIds,
  onClose,
  onLinked,
}: {
  open: boolean;
  playerId: string;
  existingGuardianIds: string[];
  onClose: () => void;
  onLinked: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchQuery = useQuery({
    queryKey: ["guardians", { q: search }],
    queryFn: () => gdn01ListGuardians({ q: search }),
    enabled: open && search.trim().length >= 2,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add guardian"
      description="Search the guardians already recorded (GDN-01) — siblings share a guardian record, so the same person is not stored twice."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3">
        <TextField
          id="guardian-search"
          label="Search guardians"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or phone"
          hint="Two characters or more."
        />
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {searchQuery.isLoading ? <ListSkeleton rows={2} /> : null}
        {searchQuery.data && searchQuery.data.data.length === 0 ? (
          <p className="text-[14px] text-slate-600">
            No guardian matches. A new guardian is created on the register-player screen.
          </p>
        ) : null}
        <ul className="divide-y divide-slate-100">
          {(searchQuery.data?.data ?? []).map((guardian) => {
            const already = existingGuardianIds.includes(guardian.id);
            return (
              <li key={guardian.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-slate-900">{guardian.fullName}</p>
                  <p className="text-[13px] text-slate-600">
                    {guardian.phone}
                    {guardian.players.length
                      ? ` · guardian of ${guardian.players.map((p) => p.fullName).join(", ")}`
                      : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={already ? "secondary" : "primary"}
                  disabled={already || pending}
                  onClick={async () => {
                    setPending(true);
                    setError(null);
                    try {
                      await gdn03LinkGuardian(playerId, {
                        guardianId: guardian.id,
                        isPrimary: false,
                        receivesInvoices: true,
                      });
                      await onLinked();
                    } catch (err) {
                      setError(
                        err instanceof ApiError ? err.message : "That did not save. Please retry."
                      );
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  {already ? "Already linked" : "Link"}
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

function GroupHistoryTab({
  query,
}: {
  query: UseQueryResult<{ data: GroupHistoryEntry[] }, Error>;
}) {
  if (query.isLoading) return <ListSkeleton rows={3} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const entries = query.data?.data ?? [];
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No group history yet"
        description="Group changes appear here with their effective dates; existing invoices never change."
      />
    );
  }
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {entries.map((entry) => (
        <li key={entry.id} className="relative">
          <span
            aria-hidden="true"
            className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full border-2 border-white ${
              entry.effectiveTo ? "bg-slate-400" : "bg-pitch-600"
            }`}
          />
          <p className="text-[15px] font-semibold text-slate-900">
            {entry.ageGroup.name}
            {entry.effectiveTo ? "" : " (current)"}
          </p>
          <p className="text-[13px] text-slate-600">
            {formatDateRange(entry.effectiveFrom, entry.effectiveTo)}
            {entry.changedBy?.fullName ? ` · recorded by ${entry.changedBy.fullName}` : ""}
          </p>
          {entry.reason ? <p className="mt-1 text-[13px] text-slate-700">{entry.reason}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function AttendanceTab({
  query,
  from,
  to,
  onFrom,
  onTo,
}: {
  query: UseQueryResult<PlayerAttendance, Error>;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-md">
        <TextField
          id="attendance-from"
          label="From"
          type="date"
          value={from}
          onChange={(e) => onFrom(e.target.value)}
        />
        <TextField
          id="attendance-to"
          label="To"
          type="date"
          value={to}
          onChange={(e) => onTo(e.target.value)}
        />
      </div>

      {query.isLoading ? (
        <ListSkeleton rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["Present", query.data?.summary.present ?? 0],
                ["Late", query.data?.summary.late ?? 0],
                ["Absent", query.data?.summary.absent ?? 0],
                ["Excused", query.data?.summary.excused ?? 0],
              ] as const
            ).map(([label, value]) => (
              <span
                key={label}
                className="tabular rounded-full border border-slate-200 bg-white px-3 py-1 text-[13px] font-semibold text-slate-700"
              >
                {label} {value}
              </span>
            ))}
          </div>
          {(query.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              title="No attendance in this range"
              description="Attendance is recorded on the session sheet and appears here afterwards."
            />
          ) : (
            <>
              <table className="hidden w-full border-collapse text-[14px] md:table">
                <caption className="sr-only">Attendance sessions</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="py-3 font-semibold">Session date</th>
                    <th scope="col" className="py-3 font-semibold">Status</th>
                    <th scope="col" className="py-3 font-semibold">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data?.data.map((row) => (
                    <tr key={row.sessionId} className="border-b border-slate-100 last:border-0">
                      <td className="py-3"><DateText value={row.sessionDate} /></td>
                      <td className="py-3">
                        <StatusChip
                          status={row.status.charAt(0).toUpperCase() + row.status.slice(1)}
                        />
                      </td>
                      <td className="py-3 text-slate-600">{row.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="divide-y divide-slate-100 md:hidden">
                {query.data?.data.map((row) => (
                  <li key={row.sessionId} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-[14px] font-semibold">
                        <DateText value={row.sessionDate} />
                      </p>
                      {row.note ? <p className="text-[13px] text-slate-600">{row.note}</p> : null}
                    </div>
                    <StatusChip status={row.status.charAt(0).toUpperCase() + row.status.slice(1)} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function InvoicesTab({
  query,
}: {
  query: UseQueryResult<Page<Invoice>, Error>;
}) {
  if (query.isLoading) return <ListSkeleton rows={3} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const invoices = query.data?.data ?? [];
  if (invoices.length === 0) {
    return (
      <EmptyState
        title="No invoices yet"
        description="Invoices appear here once a billing run or a manual invoice is issued."
      />
    );
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-[13px]">
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          Invoiced{" "}
          <MoneyText minor={invoices.reduce((sum, i) => (i.status === "void" ? sum : sum + i.totalMinor), 0)} />
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          Collected{" "}
          <MoneyText minor={invoices.reduce((sum, i) => (i.status === "void" ? sum : sum + i.paidMinor), 0)} />
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-semibold text-slate-700">
          Outstanding{" "}
          <MoneyText minor={invoices.reduce((sum, i) => (i.status === "void" ? sum : sum + i.balanceMinor), 0)} />
        </span>
      </div>
      <table className="w-full border-collapse text-[14px]">
        <caption className="sr-only">Invoices for this player</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
            <th scope="col" className="py-3 font-semibold">Invoice</th>
            <th scope="col" className="hidden py-3 font-semibold sm:table-cell">Period</th>
            <th scope="col" className="hidden py-3 font-semibold sm:table-cell">Due</th>
            <th scope="col" className="py-3 text-right font-semibold">Balance</th>
            <th scope="col" className="py-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} className="border-b border-slate-100 last:border-0">
              <td className="py-3">
                <Link
                  href={`/billing/invoices/${invoice.id}`}
                  className="font-mono text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
                >
                  {invoice.invoiceNumber}
                </Link>
              </td>
              <td className="hidden py-3 text-slate-600 sm:table-cell">
                {formatDateRange(invoice.periodStart, invoice.periodEnd)}
              </td>
              <td className="hidden py-3 text-slate-600 sm:table-cell">
                <DateText value={invoice.dueDate} />
              </td>
              <td className="tabular py-3 text-right font-semibold">
                <MoneyText minor={invoice.balanceMinor} />
              </td>
              <td className="py-3">
                <StatusChip
                  status={
                    invoice.status === "void"
                      ? "Void"
                      : invoice.isOverdue
                        ? "Overdue"
                        : invoice.status === "paid"
                          ? "Paid"
                          : invoice.status === "partially_paid"
                            ? "Partially"
                            : "Issued"
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusDialog({
  player,
  onClose,
  onSaved,
}: {
  player: Player;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<PlayerStatus>(player.status);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [stopReminders, setStopReminders] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open
      onClose={onClose}
      title="Change player status"
      description="Withdrawn and inactive players are kept and searchable — nothing is deleted, and past invoices never change."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await ply05SetPlayerStatus(player.id, {
                  status,
                  effectiveDate,
                  reason: reason || undefined,
                  stopReminders: status === "withdrawn" ? stopReminders : undefined,
                  version: player.version,
                });
                await onSaved("Player status updated.");
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "That did not save. Please retry.");
              } finally {
                setPending(false);
              }
            }}
          >
            Save status
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <SelectField
          id="status-select"
          label="New status"
          value={status}
          onChange={(e) => setStatus(e.target.value as PlayerStatus)}
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="withdrawn">Withdrawn</option>
        </SelectField>
        <TextField
          id="status-date"
          label="Effective from"
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
        />
        <TextAreaField
          id="status-reason"
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Recorded in the audit history."
        />
        {status === "withdrawn" ? (
          <Toggle
            id="status-reminders"
            label="Stop reminders"
            hint="Queued and future reminders for this player are cancelled."
            checked={stopReminders}
            onChange={setStopReminders}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function TransferDialog({
  player,
  onClose,
  onSaved,
}: {
  player: Player;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [ageGroupId, setAgeGroupId] = useState(player.currentGroup?.id ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Transfer group"
      description="Existing invoices are not changed; the next invoice uses the new group's fee."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            pending={pending}
            disabled={!ageGroupId || reason.trim().length < 5}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await ply06TransferPlayer(player.id, {
                  ageGroupId,
                  effectiveFrom,
                  reason: reason.trim(),
                  version: player.version,
                });
                await onSaved();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "That did not save. Please retry.");
              } finally {
                setPending(false);
              }
            }}
          >
            Transfer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <SelectField
          id="transfer-group"
          label="New group"
          value={ageGroupId}
          onChange={(e) => setAgeGroupId(e.target.value)}
        >
          <option value="">Choose a group…</option>
          {(groupsQuery.data?.data ?? []).map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </SelectField>
        <TextField
          id="transfer-date"
          label="Effective from"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
        <TextAreaField
          id="transfer-reason"
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="At least 5 characters. Stored with the group history."
          error={reason.length > 0 && reason.trim().length < 5 ? "Give a reason (at least 5 characters)" : undefined}
        />
      </div>
    </Modal>
  );
}
