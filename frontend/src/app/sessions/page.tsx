"use client";

// SES-01 sessions list (+ SES-02 add, SES-04 cancel) — PAGE_SPECIFICATIONS §5,
// ROUTES_AND_NAVIGATION §1. Default window is today .. +14 days.
// Times are always rendered in the ACADEMY timezone from the server instants
// (ATTENDANCE §2) — the device clock is never used for display or input, and the
// form converts the wall-clock time back with `academyLocalToInstant`.
// Filter state lives in the URL so a link to "next week, Under-11" is shareable.
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Plus } from "lucide-react";
import {
  ApiError,
  cch01ListCoaches,
  grp01ListAgeGroups,
  ses01ListSessions,
  ses02CreateSession,
  ses04CancelSession,
} from "@/api/client";
import type { AgeGroup, CoachRow, Session, SessionStatus } from "@/api/types";
import { RequireAuth, RequirePermission } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  TextAreaField,
  TextField,
  Toast,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { academyLocalToInstant, academyTime, addDaysISO, formatDateStr, todayISO } from "@/lib/dates";

const DEFAULT_WINDOW_DAYS = 14;

const STATUS_LABEL: Record<SessionStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

function SessionsList() {
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const canManage = Boolean(me?.permissions.includes("sessions:manage"));
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const today = todayISO();
  const from = searchParams.get("from") ?? today;
  const to = searchParams.get("to") ?? addDaysISO(today, DEFAULT_WINDOW_DAYS);
  const ageGroupId = searchParams.get("ageGroupId") ?? "";
  const status = (searchParams.get("status") ?? "") as SessionStatus | "";

  const [addOpen, setAddOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Session | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Same URL-write rule as /players: `router.replace` commits a moment later, so
  // two filter changes in quick succession must merge into the query we asked
  // for instead of rebuilding from the one the browser still reports.
  const lastWrite = useRef<{ query: string; at: number } | null>(null);
  const renderedQuery = searchParams.toString();

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const inFlight = lastWrite.current;
      const pending =
        Boolean(inFlight) && Date.now() - (inFlight?.at ?? 0) < 1500 && inFlight?.query !== renderedQuery;
      const next = new URLSearchParams(pending ? (inFlight?.query ?? "") : renderedQuery);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      lastWrite.current = { query, at: Date.now() };
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, renderedQuery, router]
  );

  const sessionsQuery = useQuery({
    queryKey: ["sessions", { from, to, ageGroupId, status, role: me?.user.role }],
    queryFn: () =>
      ses01ListSessions({
        from,
        to,
        ageGroupId: ageGroupId || undefined,
        status: status || undefined,
      }),
    enabled: Boolean(me),
    placeholderData: (previous) => previous,
  });

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
    enabled: canManage,
  });

  // Memoised so the grouping below is not rebuilt on every render.
  const rows = useMemo(() => sessionsQuery.data?.data ?? [], [sessionsQuery.data]);

  // The API sorts by starts_at, so a simple insertion-ordered grouping keeps the
  // days and the sessions inside each day in time order.
  const byDay = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of rows) {
      const bucket = map.get(session.sessionDate);
      if (bucket) bucket.push(session);
      else map.set(session.sessionDate, [session]);
    }
    return [...map.entries()];
  }, [rows]);

  const filtered = Boolean(
    searchParams.get("ageGroupId") || searchParams.get("status") || searchParams.get("from") || searchParams.get("to")
  );
  const markedCount = (session: Session) => {
    const s = session.attendanceSummary;
    if (!s) return null;
    const marked = s.present + s.late + s.absent + s.excused;
    return { marked, unmarked: s.unmarked, total: marked + s.unmarked };
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        sub={`${formatDateStr(from)} – ${formatDateStr(to)} · times are shown in the academy timezone.`}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add session
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            id="session-from"
            label="From"
            type="date"
            value={from}
            onChange={(e) => setParams({ from: e.target.value || null })}
          />
          <TextField
            id="session-to"
            label="To"
            type="date"
            value={to}
            onChange={(e) => setParams({ to: e.target.value || null })}
          />
          <div>
            <label htmlFor="session-group" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Age group
            </label>
            <select
              id="session-group"
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
          <div>
            <label htmlFor="session-status" className="mb-1 block text-[14px] font-semibold text-slate-800">
              Status
            </label>
            <select
              id="session-status"
              value={status}
              onChange={(e) => setParams({ status: e.target.value || null })}
              className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
            >
              <option value="">All statuses</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>
        {filtered ? (
          <div className="border-t border-slate-200 px-4 py-2">
            <button
              type="button"
              className="cursor-pointer text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
              onClick={() => setParams({ from: null, to: null, ageGroupId: null, status: null })}
            >
              Reset to today and the next {DEFAULT_WINDOW_DAYS} days
            </button>
          </div>
        ) : null}
      </Card>

      {sessionsQuery.isLoading ? (
        <Card>
          <ListSkeleton rows={5} />
        </Card>
      ) : sessionsQuery.isError ? (
        <Card>
          <ErrorState error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No sessions in this window"
            description={
              isOwner
                ? "Widen the dates above or add a session. Sessions are normally generated from the training schedules."
                : "Only sessions for the groups you are assigned to appear here."
            }
            action={
              canManage ? (
                <Button onClick={() => setAddOpen(true)}>
                  <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                  Add session
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {byDay.map(([day, sessions]) => (
            <section key={day} aria-label={formatDateStr(day)}>
              <h2 className="mb-2 font-heading text-[15px] font-semibold text-slate-900">
                {formatDateStr(day)}
              </h2>
              <Card>
                <ul className="divide-y divide-slate-100">
                  {sessions.map((session) => {
                    const progress = markedCount(session);
                    return (
                      <li key={session.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[15px] font-semibold text-slate-900">
                              {academyTime(session.startsAt)}–{academyTime(session.endsAt)} ·{" "}
                              {session.ageGroup.name}
                            </p>
                            <p className="mt-0.5 text-[13px] text-slate-600">
                              {session.venue ? `${session.venue} · ` : ""}
                              {session.leadCoach ? `Coach ${session.leadCoach.fullName}` : "No lead coach"}
                              {progress
                                ? ` · ${progress.marked} of ${progress.total} marked${
                                    progress.unmarked > 0 ? `, ${progress.unmarked} unmarked` : ""
                                  }`
                                : ""}
                            </p>
                            {session.status === "cancelled" && session.cancelReason ? (
                              <p className="mt-1 text-[13px] text-red-700">
                                Cancelled: {session.cancelReason}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusChip status={STATUS_LABEL[session.status]} />
                            <Link
                              href={`/sessions/${session.id}`}
                              className="touch44 inline-flex min-h-[44px] items-center px-2 text-[14px] font-semibold text-pitch-700 underline underline-offset-2"
                            >
                              Open sheet
                            </Link>
                            {canManage && session.status !== "cancelled" ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                aria-label={`Cancel session for ${session.ageGroup.name} on ${formatDateStr(session.sessionDate)}`}
                                onClick={() => setCancelTarget(session)}
                              >
                                Cancel
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}

      <AddSessionDialog
        open={addOpen}
        groups={groupsQuery.data?.data ?? []}
        onClose={() => setAddOpen(false)}
        onAdded={(groupName, date) => {
          setAddOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          setToast(`Session added for ${groupName} on ${formatDateStr(date)}.`);
        }}
      />

      <CancelSessionDialog
        session={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={(session) => {
          setCancelTarget(null);
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          setToast(`Session for ${session.ageGroup.name} cancelled.`);
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function AddSessionDialog({
  open,
  groups,
  onClose,
  onAdded,
}: {
  open: boolean;
  groups: AgeGroup[];
  onClose: () => void;
  onAdded: (groupName: string, date: string) => void;
}) {
  const coachesQuery = useQuery({
    queryKey: ["coaches", { q: "" }],
    queryFn: () => cch01ListCoaches({}),
    enabled: open,
  });

  const [groupId, setGroupId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [startTime, setStartTime] = useState("16:00");
  const [endTime, setEndTime] = useState("17:30");
  const [venue, setVenue] = useState("");
  const [leadCoachUserId, setLeadCoachUserId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setGroupId("");
    setDate(todayISO());
    setStartTime("16:00");
    setEndTime("17:30");
    setVenue("");
    setLeadCoachUserId("");
    setFieldErrors({});
    setFormError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (!groupId) local.ageGroupId = "Choose an age group";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) local.startsAt = "Choose a date";
    const startsAt = academyLocalToInstant(date, startTime);
    const endsAt = academyLocalToInstant(date, endTime);
    if (!startsAt) local.startsAt = "Choose a start time";
    if (!endsAt) local.endsAt = "Choose an end time";
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      local.endsAt = "The end time must be after the start time";
    }
    if (Object.keys(local).length) {
      setFieldErrors(local);
      return;
    }
    setFieldErrors({});
    setFormError(null);
    setPending(true);
    try {
      await ses02CreateSession({
        ageGroupId: groupId,
        startsAt,
        endsAt,
        venue: venue.trim() || undefined,
        leadCoachUserId: leadCoachUserId || undefined,
      });
      const group = groups.find((g) => g.id === groupId);
      reset();
      onAdded(group?.name ?? "the group", date);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_DUPLICATE") {
        setFormError("That group already has a session at this time. Pick another time or group.");
      } else if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
        setFieldErrors(error.fieldErrors());
      } else {
        setFormError(error instanceof ApiError ? error.message : "Could not add the session. Please retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add session"
      description="One extra session for a group. The schedule generator is unaffected."
      footer={
        <>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="add-session-form" pending={pending}>
            Add session
          </Button>
        </>
      }
    >
      <form id="add-session-form" onSubmit={submit} className="space-y-3">
        {formError ? (
          <InlineAlert tone="danger" title="The session was not added">
            <p>{formError}</p>
          </InlineAlert>
        ) : null}
        <div>
          <label htmlFor="add-session-group" className="mb-1 block text-[14px] font-semibold text-slate-800">
            Age group<span className="ml-1 text-red-600">*</span>
          </label>
          <select
            id="add-session-group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            aria-invalid={fieldErrors.ageGroupId ? true : undefined}
            className={`h-12 w-full rounded-xl border bg-white px-3 text-[16px] ${
              fieldErrors.ageGroupId ? "border-red-500" : "border-slate-300"
            }`}
          >
            <option value="">Choose a group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {fieldErrors.ageGroupId ? (
            <p className="mt-1 text-[13px] font-medium text-red-700">{fieldErrors.ageGroupId}</p>
          ) : null}
        </div>
        <TextField
          id="add-session-date"
          label="Date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            id="add-session-start"
            label="Starts"
            type="time"
            required
            value={startTime}
            error={fieldErrors.startsAt}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <TextField
            id="add-session-end"
            label="Ends"
            type="time"
            required
            value={endTime}
            error={fieldErrors.endsAt}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>
        <TextField
          id="add-session-venue"
          label="Venue"
          hint="Optional."
          value={venue}
          error={fieldErrors.venue}
          onChange={(e) => setVenue(e.target.value)}
        />
        <div>
          <label htmlFor="add-session-coach" className="mb-1 block text-[14px] font-semibold text-slate-800">
            Lead coach
          </label>
          <select
            id="add-session-coach"
            value={leadCoachUserId}
            onChange={(e) => setLeadCoachUserId(e.target.value)}
            className="h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-[16px]"
          >
            <option value="">Not set</option>
            {(coachesQuery.data?.data ?? []).map((row: CoachRow) => (
              <option key={row.user.id} value={row.user.id}>
                {row.user.fullName}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[13px] text-slate-600">
            Times are entered in the academy timezone (Asia/Colombo), not the device&apos;s.
          </p>
        </div>
      </form>
    </Modal>
  );
}

function CancelSessionDialog({
  session,
  onClose,
  onCancelled,
}: {
  session: Session | null;
  onClose: () => void;
  onCancelled: (session: Session) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session) return;
    if (reason.trim().length < 5) {
      setError("Give a reason (at least 5 characters).");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const cancelled = await ses04CancelSession(session.id, { reason: reason.trim() });
      setReason("");
      onCancelled(cancelled);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel the session. Please retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={session !== null}
      onClose={() => {
        setReason("");
        setError(null);
        onClose();
      }}
      title="Cancel session"
      description={
        session
          ? `${session.ageGroup.name} · ${formatDateStr(session.sessionDate)} · ${academyTime(session.startsAt)}`
          : undefined
      }
      footer={
        <>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setReason("");
              setError(null);
              onClose();
            }}
          >
            Keep the session
          </Button>
          <Button variant="danger" type="submit" form="cancel-session-form" pending={pending}>
            Cancel session
          </Button>
        </>
      }
    >
      <form id="cancel-session-form" onSubmit={submit} className="space-y-3">
        <InlineAlert tone="warning" title="What cancelling does">
          <p>
            The session stays in the history and any attendance already marked is kept, but the sheet
            becomes read-only and the session is left out of the attendance report.
          </p>
        </InlineAlert>
        <TextAreaField
          id="cancel-session-reason"
          label="Reason"
          required
          rows={3}
          value={reason}
          error={error ?? undefined}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
    </Modal>
  );
}

export default function SessionsPage() {
  return (
    <RequireAuth>
      <RequirePermission permission="sessions:read">
        <Suspense fallback={<ListSkeleton rows={5} />}>
          <SessionsList />
        </Suspense>
      </RequirePermission>
    </RequireAuth>
  );
}
