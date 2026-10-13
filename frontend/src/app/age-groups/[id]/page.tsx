"use client";

// Group detail (PAGE_SPECIFICATIONS §4): roster, fee history + "Change fee"
// dialog, assigned coaches. Endpoints: GRP-03 (group), PLY-01 filtered by
// ageGroupId (roster), FEE-01/FEE-02 (fees), CCH-02 (assignments, activeOn).
// Coaches get the roster only — fee history and coach assignments are not
// requested for them at all, because the server would answer 403.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  cch02ListAssignments,
  fee01ListFees,
  fee02AddFee,
  grp03GetAgeGroup,
  ply01ListPlayers,
} from "@/api/client";
import { isOwnerPlayer, type AgeGroup, type GroupFee, type PlayerListItem } from "@/api/types";
import { RequireAuth } from "@/components/Guards";
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
  SectionTitle,
  TextField,
  Toast,
  Toggle,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatDateStr, firstOfNextMonthISO, todayISO } from "@/lib/dates";
import { formatMoneyMinor, parseMoneyInput } from "@/lib/money";

function ageRange(group: AgeGroup): string {
  if (group.minAge !== undefined && group.maxAge !== undefined) return `${group.minAge}–${group.maxAge}`;
  if (group.maxAge !== undefined) return `Up to ${group.maxAge}`;
  if (group.minAge !== undefined) return `${group.minAge} and over`;
  return "Ages are not set";
}

function playerAge(player: PlayerListItem): number | null {
  return isOwnerPlayer(player) ? (player.ageOnReference ?? null) : (player.age ?? null);
}

function ChangeFeeDialog({
  groupId,
  groupName,
  open,
  onClose,
  onSaved,
}: {
  groupId: string;
  groupName: string;
  open: boolean;
  onClose: () => void;
  onSaved: (fee: GroupFee) => void;
}) {
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(firstOfNextMonthISO());
  const [pastConfirmed, setPastConfirmed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);

  const parsed = parseMoneyInput(amount);
  const isPast = from !== "" && from < todayISO();

  const mutation = useMutation({
    mutationFn: (input: { amountMinor: number; effectiveFrom: string; allowPast?: boolean }) =>
      fee02AddFee(groupId, input),
    onSuccess: (fee) => {
      onSaved(fee);
      setAmount("");
      setErrors({});
      setAlert(null);
      setPastConfirmed(false);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
        const fields = error.fieldErrors();
        setErrors(Object.keys(fields).length ? fields : { amountMinor: error.message });
        return;
      }
      setAlert(error instanceof ApiError ? error.message : "Could not save the fee. Please retry.");
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if ("error" in parsed) nextErrors.amountMinor = parsed.error;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) nextErrors.effectiveFrom = "Choose an effective from date";
    if (isPast && !pastConfirmed) {
      nextErrors.effectiveFrom = "Confirm that this applies from a past date";
    }
    if (Object.keys(nextErrors).length || "error" in parsed) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setAlert(null);
    mutation.mutate({ amountMinor: parsed.minor, effectiveFrom: from, allowPast: isPast });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Change the fee for ${groupName}`}
      description="This closes the current fee and starts a new one. Issued invoices are never changed."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="change-fee-form" pending={mutation.isPending}>
            Save new fee
          </Button>
        </>
      }
    >
      <form id="change-fee-form" onSubmit={submit} className="space-y-4">
        {alert ? <InlineAlert tone="danger" title="Could not save">{alert}</InlineAlert> : null}
        <TextField
          id="fee-amount"
          label="Amount (rupees)"
          required
          inputMode="decimal"
          placeholder="4000"
          value={amount}
          error={errors.amountMinor}
          onChange={(e) => setAmount(e.target.value)}
          hint="Whole rupees, or two decimals (4000.50)."
        />
        <TextField
          id="fee-from"
          label="Effective from"
          required
          type="date"
          value={from}
          error={errors.effectiveFrom}
          onChange={(e) => setFrom(e.target.value)}
          hint="Defaults to the first day of the next period."
        />
        {isPast ? (
          <Toggle
            id="fee-past-confirm"
            label="Applies from a past date; issued invoices are NOT changed"
            hint={`${formatDateStr(from)} is before today. Only invoices issued after this date use the new fee.`}
            checked={pastConfirmed}
            onChange={setPastConfirmed}
          />
        ) : null}
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-[14px] text-slate-700">
          {amount && "minor" in parsed ? (
            <>
              New invoices for periods starting on or after <strong>{formatDateStr(from)}</strong> will be{" "}
              <strong>{formatMoneyMinor(parsed.minor, { full: true })}</strong>.
            </>
          ) : (
            <>Enter an amount to see the new invoice fee for this group.</>
          )}
        </p>
      </form>
    </Modal>
  );
}

function GroupDetailBody() {
  const params = useParams<{ id: string }>();
  const groupId = params?.id ?? "";
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const queryClient = useQueryClient();
  const [feeOpen, setFeeOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const groupQuery = useQuery({
    queryKey: ["age-group", groupId, { role: me?.user.role }],
    queryFn: () => grp03GetAgeGroup(groupId),
    enabled: Boolean(me && groupId),
  });

  const rosterQuery = useQuery({
    queryKey: ["players", { ageGroupId: groupId, status: "active", pageSize: 100, role: me?.user.role }],
    queryFn: () => ply01ListPlayers({ ageGroupId: groupId, status: "active", pageSize: 100 }),
    enabled: Boolean(me && groupId),
  });

  const feesQuery = useQuery({
    queryKey: ["group-fees", groupId],
    queryFn: () => fee01ListFees(groupId),
    enabled: Boolean(me && groupId && isOwner),
  });

  const coachesQuery = useQuery({
    queryKey: ["coach-assignments", { ageGroupId: groupId }],
    queryFn: () => cch02ListAssignments({ ageGroupId: groupId, activeOn: todayISO() }),
    enabled: Boolean(me && groupId && isOwner),
  });

  const group = groupQuery.data;
  const roster = rosterQuery.data?.data ?? [];
  const fees = feesQuery.data?.data ?? [];
  const assignments = coachesQuery.data?.data ?? [];

  if (groupQuery.isLoading) {
    return <Card><ListSkeleton rows={5} /></Card>;
  }

  if (groupQuery.isError || !group) {
    return (
      <Card>
        <ErrorState error={groupQuery.error} onRetry={() => groupQuery.refetch()} />
      </Card>
    );
  }

  return (
    <>
      <BackLink href="/age-groups">All age groups</BackLink>

      <div className="mt-2">
        <PageHeader
          title={group.name}
          sub={`${ageRange(group)} · ${group.activePlayerCount ?? 0} active ${
            (group.activePlayerCount ?? 0) === 1 ? "player" : "players"
          }`}
          actions={
            isOwner ? (
              <Button onClick={() => setFeeOpen(true)}>Change fee</Button>
            ) : undefined
          }
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusChip status={group.archivedAt ? "Archived" : "Active"} />
        {isOwner && group.currentFeeMinor !== undefined ? (
          <span className="text-[13px] text-slate-600">
            Current fee <MoneyText minor={group.currentFeeMinor} />
          </span>
        ) : null}
        {group.archivedAt ? (
          <span className="text-[13px] text-slate-600">
            Archived <DateText value={group.archivedAt} withTime /> — no new players are assigned.
          </span>
        ) : null}
      </div>

      {!isOwner ? (
        <div className="mb-4">
          <InlineAlert tone="info" title="Roster only">
            You can see the players in this group. Fees and invoice figures are
            owner-only and are not sent to your device.
          </InlineAlert>
        </div>
      ) : null}

      <Card className="mb-4">
        <SectionTitle right={<span className="text-[13px] text-slate-600">{roster.length} active</span>}>
          Roster
        </SectionTitle>
        {rosterQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : rosterQuery.isError ? (
          <ErrorState error={rosterQuery.error} onRetry={() => rosterQuery.refetch()} />
        ) : roster.length === 0 ? (
          <EmptyState
            title="No active players in this group"
            description="Assign a player to this group from the player's profile, or register a new player."
            action={
              isOwner ? (
                <Link
                  href="/players/new"
                  className="font-semibold text-pitch-700 underline underline-offset-2"
                >
                  Register a player
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">Active players in {group.name}</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Reg no</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Age</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((player) => (
                    <tr key={player.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-600">{player.registrationNo}</td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        <Link href={`/players/${player.id}`} className="underline-offset-2 hover:underline">
                          {player.fullName}
                        </Link>
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">{playerAge(player) ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {isOwnerPlayer(player) && player.currentGroup ? (
                          <DateText value={player.currentGroup.since} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-slate-100 md:hidden">
              {roster.map((player) => (
                <li key={player.id}>
                  <Link href={`/players/${player.id}`} className="block px-4 py-3 hover:bg-slate-50">
                    <p className="text-[15px] font-semibold text-slate-900">{player.fullName}</p>
                    <p className="mt-0.5 text-[13px] text-slate-600">
                      <span className="font-mono">{player.registrationNo}</span>
                      {playerAge(player) !== null ? ` · age ${playerAge(player)}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {isOwner ? (
        <Card className="mb-4">
          <SectionTitle
            right={
              <Button variant="secondary" size="sm" onClick={() => setFeeOpen(true)}>
                Change fee
              </Button>
            }
          >
            Fee history
          </SectionTitle>
          {feesQuery.isLoading ? (
            <ListSkeleton rows={3} />
          ) : feesQuery.isError ? (
            <ErrorState error={feesQuery.error} onRetry={() => feesQuery.refetch()} />
          ) : fees.length === 0 ? (
            <EmptyState
              title="No fee set for this group"
              description="Without a fee, billing runs skip players in this group with the reason “No fee set for the group”."
              action={<Button onClick={() => setFeeOpen(true)}>Set the first fee</Button>}
            />
          ) : (
            <>
              <div className="hidden md:block">
                <table className="w-full border-collapse text-[14px]">
                  <caption className="sr-only">Fee history for {group.name}, newest first</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                      <th scope="col" className="px-4 py-3 font-semibold">Effective from</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Effective to</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fees.map((fee) => (
                      <tr key={fee.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 text-slate-800">
                          <DateText value={fee.effectiveFrom} />
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {fee.effectiveTo ? <DateText value={fee.effectiveTo} /> : "Current"}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-900">
                          <MoneyText minor={fee.amountMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-slate-100 md:hidden">
                {fees.map((fee) => (
                  <li key={fee.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-[15px] font-semibold text-slate-900">
                        <MoneyText minor={fee.amountMinor} />
                      </p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        From <DateText value={fee.effectiveFrom} />
                        {fee.effectiveTo ? (
                          <>
                            {" "}
                            to <DateText value={fee.effectiveTo} />
                          </>
                        ) : (
                          " · current"
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      ) : null}

      {isOwner ? (
        <Card className="mb-4">
          <SectionTitle>Assigned coaches</SectionTitle>
          {coachesQuery.isLoading ? (
            <ListSkeleton rows={2} />
          ) : coachesQuery.isError ? (
            <ErrorState error={coachesQuery.error} onRetry={() => coachesQuery.refetch()} />
          ) : assignments.length === 0 ? (
            <EmptyState
              title="No coach assigned"
              description="Coaches only see the groups they are assigned to."
              action={
                <Link href="/coaches" className="font-semibold text-pitch-700 underline underline-offset-2">
                  Manage coaches
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {assignments.map((assignment) => (
                <li key={assignment.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-[15px] font-semibold text-slate-900">{assignment.coachName}</p>
                    <p className="text-[13px] text-slate-600">
                      Since <DateText value={assignment.assignedFrom} />
                      {assignment.assignedTo ? (
                        <>
                          {" "}
                          · ended <DateText value={assignment.assignedTo} />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Link href="/coaches" className="text-[14px] font-semibold text-pitch-700 underline underline-offset-2">
                    Manage
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Training schedules</SectionTitle>
        <div className="px-4 py-4 text-[14px] text-slate-600">
          Weekly training schedules for this group (SCH-01, with “generate sessions”) arrive in a later
          slice. Nothing is configured for this group yet.
        </div>
      </Card>

      <ChangeFeeDialog
        groupId={groupId}
        groupName={group.name}
        open={feeOpen}
        onClose={() => setFeeOpen(false)}
        onSaved={(fee) => {
          setToast(`New fee of ${formatMoneyMinor(fee.amountMinor)} starts ${formatDateStr(fee.effectiveFrom)}.`);
          void queryClient.invalidateQueries({ queryKey: ["group-fees", groupId] });
          void queryClient.invalidateQueries({ queryKey: ["age-groups"] });
          void queryClient.invalidateQueries({ queryKey: ["age-group", groupId] });
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

export default function AgeGroupDetailPage() {
  return (
    <RequireAuth>
      <GroupDetailBody />
    </RequireAuth>
  );
}
