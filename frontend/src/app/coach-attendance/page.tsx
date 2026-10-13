"use client";

// Coach attendance log (PAGE_SPECIFICATIONS §6): CAT-03 (log + date/coach
// filters), CAT-04 (owner manual entry) and CAT-05 (owner correction).
//
// Two rules decide the whole shape of this page:
//  · hours are counted from CLOSED records only — an open check-in is shown as
//    elapsed minutes and is never added to the total (ATTENDANCE §5);
//  · the scope is enforced by the API, not by this page. A coach only receives
//    their own rows, so the page is auth-gated only and merely hides the owner
//    actions. Asking for another coach's log answers 403 (handled as an error).
import { Suspense, useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import {
  ApiError,
  cat03ListCoachAttendance,
  cat04CreateCoachAttendance,
  cat05PatchCoachAttendance,
  cch01ListCoaches,
  ses01ListSessions,
} from "@/api/client";
import type { CoachAttendance, Session } from "@/api/types";
import { RequireAuth } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SectionTitle,
  SelectField,
  TextAreaField,
  TextField,
  Toast,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";
import {
  academyDateOf,
  academyLocalToInstant,
  academyTime,
  addDaysISO,
  formatDateStr,
  formatDuration,
  formatInstant,
  minutesBetween,
  todayISO,
} from "@/lib/dates";

/** 12 h: a check-in open longer than this "needs correction" (ATTENDANCE §4). */
const OPEN_CORRECTION_MINUTES = 12 * 60;

const DISCLAIMER =
  "Check-ins are self-reported and server-timestamped; they don't prove physical presence.";

/** An open record's elapsed span, from the check-in to now. */
function elapsedMinutes(row: CoachAttendance): number {
  return minutesBetween(row.checkInAt, new Date().toISOString());
}

function isOpen(row: CoachAttendance): boolean {
  return !row.checkOutAt;
}

/** Academy-local date + "HH:mm" halves of an instant, for the correction form. */
function splitInstant(instant?: string): { date: string; time: string } {
  if (!instant) return { date: "", time: "" };
  return { date: academyDateOf(instant), time: academyTime(instant, "") };
}

function sessionLabel(session: Session): string {
  return `${session.ageGroup.name} · ${formatDateStr(session.sessionDate)} · ${academyTime(session.startsAt)}`;
}

function CoachTimeBody() {
  const { me } = useAuth();
  const canManage = me?.permissions.includes("coach_attendance:manage") ?? false;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const from = searchParams.get("from") ?? addDaysISO(todayISO(), -14);
  const to = searchParams.get("to") ?? addDaysISO(todayISO(), 14);
  const coachUserId = searchParams.get("coachUserId") ?? "";

  const [addOpen, setAddOpen] = useState(false);
  const [correcting, setCorrecting] = useState<CoachAttendance | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const text = next.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const logQuery = useQuery({
    queryKey: ["coach-attendance", { from, to, coachUserId, role: me?.user.role }],
    queryFn: () =>
      cat03ListCoachAttendance({
        from,
        to,
        // A coach must not send `coachUserId` at all: the API scopes them and
        // answers 403 to anyone else's id (C*).
        coachUserId: canManage && coachUserId ? coachUserId : undefined,
      }),
    enabled: Boolean(me),
  });

  const coachesQuery = useQuery({
    queryKey: ["coaches", { q: undefined }],
    queryFn: () => cch01ListCoaches(),
    enabled: Boolean(me && canManage),
  });

  // Memoised so the totals below are not recomputed on every render.
  const rows = useMemo(() => logQuery.data?.data ?? [], [logQuery.data]);
  const coaches = useMemo(() => coachesQuery.data?.data ?? [], [coachesQuery.data]);

  const totals = useMemo(() => {
    const closed = rows.filter((row) => row.checkOutAt);
    const open = rows.filter(isOpen);
    return {
      closedCount: closed.length,
      openCount: open.length,
      closedMinutes: closed.reduce(
        (sum, row) => sum + minutesBetween(row.checkInAt, row.checkOutAt as string),
        0
      ),
    };
  }, [rows]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["coach-attendance"] });
  }

  return (
    <>
      <PageHeader
        title="Coach time"
        sub="Coach check-ins come from the coach's own phone. An open check-in is shown as elapsed time and is never counted as worked hours."
        actions={
          canManage ? (
            <Button onClick={() => setAddOpen(true)}>
              <Clock className="h-4 w-4" aria-hidden="true" />
              Add entry
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            id="ca-from"
            label="From"
            type="date"
            value={from}
            onChange={(event) => setParams({ from: event.target.value || null })}
          />
          <TextField
            id="ca-to"
            label="To"
            type="date"
            value={to}
            onChange={(event) => setParams({ to: event.target.value || null })}
          />
          {canManage ? (
            <SelectField
              id="ca-coach"
              label="Coach"
              value={coachUserId}
              onChange={(event) => setParams({ coachUserId: event.target.value || null })}
            >
              <option value="">All coaches</option>
              {coaches.map((coach) => (
                <option key={coach.user.id} value={coach.user.id}>
                  {coach.user.fullName}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
          <p>
            <strong className="font-semibold text-slate-800">Σ hours (closed records only)</strong>{" "}
            <span className="tabular">{formatDuration(totals.closedMinutes)}</span> ·{" "}
            <span className="tabular">{totals.closedCount}</span> closed ·{" "}
            <span className="tabular">{totals.openCount}</span> still open
          </p>
          <p>Open check-ins are listed as elapsed time and are not added to this total.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle
          right={
            logQuery.isFetching ? <span className="text-[13px] text-slate-500">Refreshing…</span> : undefined
          }
        >
          Check-in log
        </SectionTitle>

        {logQuery.isLoading ? (
          <ListSkeleton rows={5} />
        ) : logQuery.isError ? (
          <ErrorState error={logQuery.error} onRetry={() => logQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No check-ins in this range"
            description={
              canManage
                ? "Widen the dates, or add an entry if a coach forgot to clock in."
                : "Your check-ins will appear here after you clock in on a session."
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 768 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Coach check-ins, {rows.length} in this range, newest first
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Coach</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Session</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Check-in</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Check-out</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Duration</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Entered by</th>
                    {canManage ? (
                      <th scope="col" className="px-4 py-3">
                        <span className="sr-only">Actions</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={`border-b border-slate-100 last:border-0 ${
                        isOpen(row) ? "border-l-4 border-l-amber-400 bg-amber-50" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-semibold text-slate-900">{row.coach.fullName}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.session.ageGroupName} · {formatDateStr(academyDateOf(row.session.startsAt))}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{formatInstant(row.checkInAt)}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.checkOutAt ? (
                          formatInstant(row.checkOutAt)
                        ) : (
                          <span className="font-semibold text-amber-800">Open</span>
                        )}
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-900">
                        <DurationCell row={row} />
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.enteredBy === "self" ? "Coach" : "Owner"}
                        {row.corrected ? (
                          <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-800">
                            Corrected
                          </span>
                        ) : null}
                      </td>
                      {canManage ? (
                        <td className="px-4 py-3 text-right">
                          <Button variant="secondary" size="sm" onClick={() => setCorrecting(row)}>
                            Correct
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 768 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={`px-4 py-3 ${isOpen(row) ? "border-l-4 border-l-amber-400 bg-amber-50" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-slate-900">
                        {row.coach.fullName}
                      </p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        {row.session.ageGroupName} · {formatInstant(row.session.startsAt)}
                      </p>
                    </div>
                    {row.corrected ? (
                      <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-800">
                        Corrected
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[13px] text-slate-700">
                    In {formatInstant(row.checkInAt)} ·{" "}
                    {row.checkOutAt ? `Out ${formatInstant(row.checkOutAt)}` : "Open"}
                  </p>
                  <p className="tabular mt-1 text-[13px] font-semibold text-slate-900">
                    <DurationCell row={row} />
                  </p>
                  <p className="mt-1 text-[12px] text-slate-500">
                    Entered by {row.enteredBy === "self" ? "coach" : "owner"}
                  </p>
                  {canManage ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2"
                      onClick={() => setCorrecting(row)}
                    >
                      Correct
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">{DISCLAIMER}</p>
      </Card>

      {canManage ? (
        <AddEntryDialog
          open={addOpen}
          coaches={coaches}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            refresh();
            setToast("Entry added.");
          }}
        />
      ) : null}

      {canManage && correcting ? (
        <CorrectDialog
          row={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={() => {
            setCorrecting(null);
            refresh();
            setToast("Correction saved.");
          }}
        />
      ) : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

/** Elapsed (open) vs recorded (closed) span. The two are never mixed. */
function DurationCell({ row }: { row: CoachAttendance }) {
  if (row.checkOutAt) {
    return <>{formatDuration(minutesBetween(row.checkInAt, row.checkOutAt))}</>;
  }
  const elapsed = elapsedMinutes(row);
  return (
    <>
      <span className="font-semibold text-amber-800">
        Open · {formatDuration(elapsed)} elapsed
      </span>
      {elapsed > OPEN_CORRECTION_MINUTES ? (
        <span className="ml-2 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[12px] font-semibold text-red-700">
          Needs correction (&gt; 12 h)
        </span>
      ) : null}
    </>
  );
}

function AddEntryDialog({
  open,
  coaches,
  onClose,
  onSaved,
}: {
  open: boolean;
  coaches: { user: { id: string; fullName: string } }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [coachUserId, setCoachUserId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [inDate, setInDate] = useState(todayISO());
  const [inTime, setInTime] = useState("16:00");
  const [outDate, setOutDate] = useState("");
  const [outTime, setOutTime] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);

  // Only fetched while the dialog is open: the picker needs recent + upcoming
  // sessions to attach the entry to (SES-01).
  const sessionsQuery = useQuery({
    queryKey: ["sessions", { from: addDaysISO(todayISO(), -14), to: addDaysISO(todayISO(), 14) }],
    queryFn: () =>
      ses01ListSessions({ from: addDaysISO(todayISO(), -14), to: addDaysISO(todayISO(), 14) }),
    enabled: open,
  });
  // A cancelled session cannot have been coached, so it is not offered here.
  const sessions = (sessionsQuery.data?.data ?? []).filter(
    (session) => session.status !== "cancelled"
  );

  const mutation = useMutation({
    mutationFn: cat04CreateCoachAttendance,
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.code === "VALIDATION_ERROR") {
          const fields = error.fieldErrors();
          if (Object.keys(fields).length) {
            setErrors(fields);
            return;
          }
        }
        setAlert(error.message);
        return;
      }
      setAlert("Could not add the entry. Please retry.");
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!coachUserId) next.coachUserId = "Choose a coach";
    if (!sessionId) next.sessionId = "Choose a session";
    const checkInAt = inDate && inTime ? academyLocalToInstant(inDate, inTime) : "";
    if (!checkInAt) next.checkInAt = "Enter a check-in date and time";
    const hasOut = Boolean(outDate && outTime);
    const checkOutAt = hasOut ? academyLocalToInstant(outDate, outTime) : undefined;
    if (hasOut && (!checkOutAt || Date.parse(checkOutAt) <= Date.parse(checkInAt))) {
      next.checkOutAt = "Check-out must be after check-in";
    }
    if (reason.trim().length < 5) next.reason = "Give a reason (at least 5 characters)";
    setErrors(next);
    if (Object.keys(next).length) return;
    setAlert(null);
    mutation.mutate({
      coachUserId,
      sessionId,
      checkInAt,
      checkOutAt,
      reason: reason.trim(),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add coach time"
      description="For a coach who forgot to clock in. Times are stamped as entered by an owner and audited."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-coach-time-form" pending={mutation.isPending}>
            Add entry
          </Button>
        </>
      }
    >
      <form id="add-coach-time-form" onSubmit={submit} className="space-y-4">
        {alert ? (
          <InlineAlert tone="danger" title="Could not add the entry">
            {alert}
          </InlineAlert>
        ) : null}
        <SelectField
          id="ca-add-coach"
          label="Coach"
          required
          value={coachUserId}
          error={errors.coachUserId}
          onChange={(event) => setCoachUserId(event.target.value)}
        >
          <option value="">Choose a coach…</option>
          {coaches.map((coach) => (
            <option key={coach.user.id} value={coach.user.id}>
              {coach.user.fullName}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="ca-add-session"
          label="Session"
          required
          value={sessionId}
          error={errors.sessionId}
          hint={
            sessionsQuery.isLoading
              ? "Loading the last two weeks and the next two…"
              : "The last two weeks and the next two."
          }
          onChange={(event) => setSessionId(event.target.value)}
        >
          <option value="">Choose a session…</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {sessionLabel(session)}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="ca-add-in-date"
            label="Check-in date"
            required
            type="date"
            value={inDate}
            error={errors.checkInAt}
            onChange={(event) => setInDate(event.target.value)}
          />
          <TextField
            id="ca-add-in-time"
            label="Check-in time"
            required
            type="time"
            value={inTime}
            onChange={(event) => setInTime(event.target.value)}
          />
          <TextField
            id="ca-add-out-date"
            label="Check-out date"
            type="date"
            hint="Leave empty to keep the check-in open."
            value={outDate}
            error={errors.checkOutAt}
            onChange={(event) => setOutDate(event.target.value)}
          />
          <TextField
            id="ca-add-out-time"
            label="Check-out time"
            type="time"
            value={outTime}
            onChange={(event) => setOutTime(event.target.value)}
          />
        </div>
        <TextAreaField
          id="ca-add-reason"
          label="Reason"
          required
          rows={2}
          value={reason}
          error={errors.reason}
          hint="Why this entry is being added by hand (at least 5 characters)."
          onChange={(event) => setReason(event.target.value)}
        />
      </form>
    </Modal>
  );
}

function CorrectDialog({
  row,
  onClose,
  onSaved,
}: {
  row: CoachAttendance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialIn = splitInstant(row.checkInAt);
  const initialOut = splitInstant(row.checkOutAt);
  const [inDate, setInDate] = useState(initialIn.date);
  const [inTime, setInTime] = useState(initialIn.time);
  const [outDate, setOutDate] = useState(initialOut.date);
  const [outTime, setOutTime] = useState(initialOut.time);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { checkInAt?: string; checkOutAt?: string | null; reason: string; version: number }) =>
      cat05PatchCoachAttendance(row.id, input),
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.code === "VERSION_CONFLICT") {
          setAlert("This record changed since you opened it. Reload the page and try again.");
          return;
        }
        if (error.code === "VALIDATION_ERROR" || error.code === "REASON_REQUIRED") {
          const fields = error.fieldErrors();
          if (Object.keys(fields).length) {
            setErrors(fields);
            return;
          }
        }
        setAlert(error.message);
        return;
      }
      setAlert("Could not save the correction. Please retry.");
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const checkInAt = inDate && inTime ? academyLocalToInstant(inDate, inTime) : "";
    if (!checkInAt) next.checkInAt = "Enter a check-in date and time";
    const hasOut = Boolean(outDate && outTime);
    const checkOutAt = hasOut ? academyLocalToInstant(outDate, outTime) : null;
    if (hasOut && checkOutAt && checkInAt && Date.parse(checkOutAt) <= Date.parse(checkInAt)) {
      next.checkOutAt = "Check-out must be after check-in";
    }
    if (reason.trim().length < 5) next.reason = "A reason is required for a correction (at least 5 characters)";
    setErrors(next);
    if (Object.keys(next).length) return;
    setAlert(null);
    mutation.mutate({
      checkInAt,
      // Clearing the fields on a closed row reopens it — that is a real
      // correction, so it stays available, but it needs the reason below.
      checkOutAt,
      reason: reason.trim(),
      version: row.version,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct check-in"
      description="Corrections are audited and mark the record as corrected."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="correct-checkin-form" pending={mutation.isPending}>
            Save correction
          </Button>
        </>
      }
    >
      <form id="correct-checkin-form" onSubmit={submit} className="space-y-4">
        {alert ? (
          <InlineAlert tone="danger" title="Could not save the correction">
            {alert}
          </InlineAlert>
        ) : null}
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-[14px] text-slate-700">
          {row.coach.fullName} · {row.session.ageGroupName} · entered by{" "}
          {row.enteredBy === "self" ? "coach" : "owner"}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id="ca-correct-in-date"
            label="Check-in date"
            required
            type="date"
            value={inDate}
            error={errors.checkInAt}
            onChange={(event) => setInDate(event.target.value)}
          />
          <TextField
            id="ca-correct-in-time"
            label="Check-in time"
            required
            type="time"
            value={inTime}
            onChange={(event) => setInTime(event.target.value)}
          />
          <TextField
            id="ca-correct-out-date"
            label="Check-out date"
            type="date"
            hint="Clearing both fields reopens the check-in."
            value={outDate}
            error={errors.checkOutAt}
            onChange={(event) => setOutDate(event.target.value)}
          />
          <TextField
            id="ca-correct-out-time"
            label="Check-out time"
            type="time"
            value={outTime}
            onChange={(event) => setOutTime(event.target.value)}
          />
        </div>
        <TextAreaField
          id="ca-correct-reason"
          label="Reason"
          required
          rows={2}
          value={reason}
          error={errors.reason}
          hint="Kept in the audit trail (at least 5 characters)."
          onChange={(event) => setReason(event.target.value)}
        />
      </form>
    </Modal>
  );
}

export default function CoachAttendancePage() {
  return (
    <RequireAuth>
      <Suspense fallback={<ListSkeleton rows={5} />}>
        <CoachTimeBody />
      </Suspense>
    </RequireAuth>
  );
}
