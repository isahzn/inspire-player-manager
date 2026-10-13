"use client";

// Session page (ROUTES §1: SES-03, ATT-01..03, CAT-01/02) — the mobile-critical
// screen. Two things live here and they are deliberately kept apart:
//   · the coach's check-in bar (their own clock in/out for THIS session), and
//   · the attendance sheet (the player roster), which is not money and not time.
// A coach's clock has no effect on player attendance, fees or balances
// (ATTENDANCE §5), so the two blocks never share state.
//
// Sheet rules (PAGE_SPECIFICATIONS §5): sticky counts + "Mark all present",
// ≥ 56 px rows with ≥ 48 px P/L/A/E targets, a sticky full-width Save that goes
// through ATT-02 with the draft's Idempotency-Key, an unsent draft kept locally
// for 24 h, a required reason when changing a SAVED record, a read-only mode
// outside the coach's window, and a 409 conflict that offers keep-theirs or
// overwrite-with-a-reason.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck, Timer } from "lucide-react";
import type { SessionAttendance } from "@/api/types";
import {
  ApiError,
  att01GetAttendance,
  idempotencyKey,
  att02SaveAttendance,
  cat01CheckIn,
  cat02CheckOut,
  cat03ListCoachAttendance,
  ses04CancelSession,
} from "@/api/client";
import type { AttendanceRecordInput, RosterRow } from "@/api/types";
import { AttendanceRow, type RowDraft } from "@/components/AttendanceRow";
import {
  BackLink,
  Button,
  Card,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SectionTitle,
  TextField,
  Toast,
} from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { RequireAuth, RequirePermission } from "@/components/Guards";
import { useAuth } from "@/lib/auth";
import {
  academyDateOf,
  academyTime,
  addDaysISO,
  addMinutes,
  formatDateStr,
  formatDuration,
  formatInstant,
  minutesBetween,
} from "@/lib/dates";
import { clearDraft, loadDraft, saveDraft } from "@/lib/attendanceDraft";

export default function Page() {
  return (
    <RequireAuth>
      <RequirePermission permission="sessions:read">
        <SheetForParam />
      </RequirePermission>
    </RequireAuth>
  );
}

/** Keyed by id so the sheet state (marks, draft) resets when the route changes. */
function SheetForParam() {
  const params = useParams<{ id: string }>();
  const sessionId = String(params.id);
  return <SessionSheet key={sessionId} sessionId={sessionId} />;
}

/** Height of the mobile tab bar, so the sticky Save sits above it, not under it. */
function useMobileNavHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const measure = () => {
      const nav = document.querySelector('nav[aria-label="Mobile"]');
      setHeight(nav ? Math.round(nav.getBoundingClientRect().height) : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return height;
}

function SessionSheet({ sessionId }: { sessionId: string }) {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const navHeight = useMobileNavHeight();

  // Only the coach's OWN edits live in state; every row's displayed value is
  // derived from the server row plus those edits. That is what makes a refetch
  // (window focus, another coach saving) unable to wipe work in progress, and it
  // keeps the component free of state-syncing effects.
  const [restored] = useState(() => loadDraft(sessionId));
  const [edits, setEdits] = useState<Record<string, RowDraft>>(restored?.records ?? {});
  const [draftId, setDraftId] = useState(() => restored?.key ?? idempotencyKey());
  const [reasonErrors, setReasonErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<{ playerId: string; message: string }[] | null>(null);
  const [sheetError, setSheetError] = useState<{ title: string; message: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const sheetQuery = useQuery({
    queryKey: ["session-attendance", sessionId],
    queryFn: () => att01GetAttendance(sessionId),
  });
  const data = sheetQuery.data;
  const session = data?.session;
  const roster = useMemo<RosterRow[]>(() => data?.roster ?? [], [data]);
  const cancelled = session?.status === "cancelled";
  const readOnly = Boolean(data) && (!data!.canEdit || cancelled);

  const isCoach = me?.user.role === "coach";
  const sessionDate = session?.sessionDate;

  // The coach's own check-ins. CAT-03 only ever returns the caller's rows for a
  // coach, so this needs no owner/self branching beyond the `enabled` flag.
  const myCheckInsQuery = useQuery({
    queryKey: ["my-checkins", sessionId, me?.user.id],
    queryFn: () =>
      cat03ListCoachAttendance({
        from: addDaysISO(sessionDate ?? "", -1),
        to: addDaysISO(sessionDate ?? "", 1),
      }),
    enabled: isCoach && Boolean(sessionDate),
  });
  const thisCheckIn = (myCheckInsQuery.data?.data ?? []).find((c) => c.session.id === sessionId);
  const openElsewhere = (myCheckInsQuery.data?.data ?? []).find(
    (c) => !c.checkOutAt && c.session.id !== sessionId
  );

  /** Server row + the coach's edits = what the sheet shows. */
  const choices = useMemo(() => {
    const out: Record<string, RowDraft> = {};
    for (const row of roster) {
      const base: RowDraft = { status: row.record?.status ?? null, note: row.record?.note };
      out[row.player.id] = edits[row.player.id] ? { ...base, ...edits[row.player.id] } : base;
    }
    return out;
  }, [roster, edits]);

  const isDirty = useCallback(
    (row: RosterRow) => {
      const choice = choices[row.player.id];
      if (!choice) return false;
      if (!row.record) return choice.status !== null || (choice.note ?? "").trim().length > 0;
      return (
        choice.status !== row.record.status || (choice.note ?? "") !== (row.record.note ?? "")
      );
    },
    [choices]
  );

  const dirtyRows = useMemo(() => roster.filter(isDirty), [roster, isDirty]);

  // Persist the unsent marks (24 h) so a dropped connection cannot lose them.
  // Writing to localStorage from an effect is the point — it is an external
  // system, and nothing here re-enters React state.
  useEffect(() => {
    if (!data || readOnly) return;
    if (dirtyRows.length === 0) {
      clearDraft(sessionId);
      return;
    }
    const records: Record<string, RowDraft> = {};
    for (const row of dirtyRows) {
      records[row.player.id] = choices[row.player.id];
    }
    saveDraft(sessionId, records, draftId);
  }, [choices, data, dirtyRows, draftId, readOnly, sessionId]);

  const counts = useMemo(() => {
    const out = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
    for (const row of roster) {
      const status = choices[row.player.id]?.status ?? null;
      if (status) out[status] += 1;
      else out.unmarked += 1;
    }
    return out;
  }, [roster, choices]);

  const setChoice = (playerId: string, patch: Partial<RowDraft>) => {
    setEdits((prev) => ({ ...prev, [playerId]: { ...prev[playerId], ...patch } }));
    setSheetError(null);
  };

  const markAllPresent = () => {
    // Only UNSAVED rows: flipping a record someone already saved would demand a
    // reason for each of them, which is not what a one-tap shortcut means.
    setEdits((prev) => {
      const next = { ...prev };
      for (const row of roster) {
        if (row.record) continue;
        next[row.player.id] = { ...next[row.player.id], status: "present" };
      }
      return next;
    });
    setSheetError(null);
  };

  const saveMutation = useMutation({
    mutationFn: (input: { records: AttendanceRecordInput[]; key: string }) =>
      att02SaveAttendance(sessionId, input.records, input.key),
    onSuccess: (result) => {
      clearDraft(sessionId);
      // The response carries the saved roster, so the sheet shows server truth
      // immediately instead of an optimistic guess.
      queryClient.setQueryData<SessionAttendance>(["session-attendance", sessionId], (old) =>
        old ? { ...old, roster: result.roster } : old
      );
      setEdits({});
      setDraftId(idempotencyKey());
      setReasonErrors({});
      setConflicts(null);
      setSheetError(null);
      setToast(
        result.saved === 1 ? "1 attendance record saved." : `${result.saved} attendance records saved.`
      );
      void queryClient.invalidateQueries({ queryKey: ["session-attendance", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => {
      const api = error instanceof ApiError ? error : null;
      if (api?.code === "VERSION_CONFLICT") {
        const rows = (api.details ?? []).map((d) => ({
          playerId: d.field ?? "",
          message: `${d.issue ?? "Changed by someone else"} — your mark was not saved.`,
        }));
        setConflicts(rows.length ? rows : [{ playerId: "", message: api.message }]);
        return;
      }
      if (api?.code === "REASON_REQUIRED" || api?.code === "VALIDATION_ERROR") {
        const fields: Record<string, string> = {};
        for (const detail of api.details ?? []) {
          if (detail.field && detail.issue) fields[detail.field] = detail.issue;
        }
        setReasonErrors(fields);
        setSheetError({ title: "Not saved", message: api.message });
        return;
      }
      // Anything else (offline, 5xx): the draft stays, the key stays, retry is safe.
      setSheetError({
        title: "Not saved",
        message:
          api?.code === "ATTENDANCE_WINDOW_CLOSED"
            ? "The editing window for this session has closed. Ask an owner to correct it."
            : (api?.message ?? "Please retry."),
      });
    },
  });

  /**
   * Builds the ATT-02 body from the dirty rows. `overwrite` re-sends only the
   * conflicting rows without their `version` — that is what clears a 409.
   */
  function save(overwrite = false) {
    const conflicted = new Set((conflicts ?? []).map((c) => c.playerId));
    const records: AttendanceRecordInput[] = [];
    const missingReason: Record<string, string> = {};
    for (const row of dirtyRows) {
      const choice = choices[row.player.id];
      const changingSaved = Boolean(row.record && choice.status && choice.status !== row.record.status);
      if (changingSaved && (choice.reason ?? "").trim().length < 5) {
        missingReason[row.player.id] = "Give a reason (at least 5 characters)";
        continue;
      }
      records.push({
        playerId: row.player.id,
        status: choice.status ?? "present",
        note: (choice.note ?? "").trim() || undefined,
        version: overwrite && conflicted.has(row.player.id) ? undefined : row.record?.version,
        reason: changingSaved ? choice.reason : undefined,
      });
    }
    if (Object.keys(missingReason).length > 0) {
      setReasonErrors(missingReason);
      setSheetError({ title: "Reason needed", message: "A reason is required to change a saved record." });
      return;
    }
    if (records.length === 0) {
      setToast("Nothing to save.");
      return;
    }
    setConflicts(null);
    saveMutation.mutate({ records, key: draftId });
  }

  // --- coach check-in bar ---------------------------------------------------
  const checkInMutation = useMutation({
    mutationFn: () => cat01CheckIn({ sessionId }),
    onSuccess: (record) => {
      setToast(`Checked in at ${academyTime(record.checkInAt)}.`);
      void queryClient.invalidateQueries({ queryKey: ["my-checkins", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["coach-attendance"] });
    },
    onError: (error) => {
      const api = error instanceof ApiError ? error : null;
      if (api?.code === "ALREADY_CHECKED_IN") {
        setSheetError({ title: "Already checked in", message: api.message });
      } else if (api?.code === "CHECKIN_WINDOW_CLOSED") {
        setSheetError({
          title: "Check-in is closed",
          message: "Check-in opens 60 minutes before the session and closes 2 hours after it ends.",
        });
      } else {
        setSheetError({ title: "Could not check in", message: api?.message ?? "Please retry." });
      }
      void queryClient.invalidateQueries({ queryKey: ["my-checkins", sessionId] });
    },
  });

  const checkOutMutation = useMutation({
    mutationFn: () => cat02CheckOut({ sessionId }),
    onSuccess: (record) => {
      setToast(
        record.checkOutAt && record.checkInAt
          ? `Clocked out — recorded span ${formatDuration(minutesBetween(record.checkInAt, record.checkOutAt))}.`
          : "Clocked out."
      );
      void queryClient.invalidateQueries({ queryKey: ["my-checkins", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["coach-attendance"] });
    },
    onError: (error) => {
      setSheetError({
        title: "Could not clock out",
        message: error instanceof ApiError ? error.message : "Please retry.",
      });
      void queryClient.invalidateQueries({ queryKey: ["my-checkins", sessionId] });
    },
  });

  // Elapsed time only ticks while a check-in is open (never a completed span).
  const openHere = thisCheckIn && !thisCheckIn.checkOutAt;
  useEffect(() => {
    if (!openHere) return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [openHere]);

  const cancelMutation = useMutation({
    mutationFn: () => ses04CancelSession(sessionId, { reason: cancelReason.trim() }),
    onSuccess: (updated) => {
      setCancelOpen(false);
      setCancelReason("");
      setToast(`Session cancelled: ${updated.cancelReason ?? ""}`);
      void queryClient.invalidateQueries({ queryKey: ["session-attendance", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => {
      const api = error instanceof ApiError ? error : null;
      setCancelError(api?.fieldErrors().reason ?? api?.message ?? "Could not cancel the session.");
    },
  });

  const canManageSessions = me?.permissions.includes("sessions:manage") ?? false;
  const checkinWindow = session
    ? { opensAt: addMinutes(session.startsAt, -60), closesAt: addMinutes(session.endsAt, 120) }
    : null;
  const checkinOpen =
    checkinWindow !== null &&
    nowTick >= Date.parse(checkinWindow.opensAt) &&
    nowTick <= Date.parse(checkinWindow.closesAt);

  if (sheetQuery.isLoading) return <ListSkeleton rows={6} />;
  if (sheetQuery.isError) {
    return <ErrorState error={sheetQuery.error} onRetry={() => void sheetQuery.refetch()} />;
  }
  if (!session) return null;

  return (
    <>
      <div className="mb-1">
        <BackLink href="/sessions">Sessions</BackLink>
      </div>
      <PageHeader
        title={`${session.ageGroup.name} · ${formatDateStr(session.sessionDate)}`}
        sub={`${academyTime(session.startsAt)}–${academyTime(session.endsAt)}${
          session.venue ? ` · ${session.venue}` : ""
        }${session.leadCoach ? ` · Lead coach ${session.leadCoach.fullName}` : ""}`}
        actions={
          canManageSessions && !cancelled ? (
            <Button variant="secondary" onClick={() => setCancelOpen(true)}>
              Cancel session
            </Button>
          ) : null
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700">
          <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {session.status}
        </span>
        <span className="text-slate-600">
          {session.attendanceSummary
            ? `${roster.length - counts.unmarked} of ${roster.length} marked`
            : `${roster.length} on the roster`}
        </span>
      </div>

      {cancelled ? (
        <div className="mb-4">
          <InlineAlert tone="warning" title="This session was cancelled">
            <p>
              {session.cancelReason ? `${session.cancelReason} ` : ""}
              Attendance is read-only; the marks already recorded are kept as history and are not
              counted in reports.
            </p>
          </InlineAlert>
        </div>
      ) : null}

      {sheetError ? (
        <div className="mb-4">
          <InlineAlert
            tone="danger"
            title={sheetError.title}
            action={
              dirtyRows.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={() => save()} pending={saveMutation.isPending}>
                  Retry save
                </Button>
              ) : undefined
            }
          >
            <p>{sheetError.message}</p>
          </InlineAlert>
        </div>
      ) : null}

      {isCoach ? (
        <Card className="mb-4">
          <SectionTitle
            right={
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-600">
                <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                server times · {me?.academy.timezone}
              </span>
            }
          >
            Your time on this session
          </SectionTitle>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-[14px] text-slate-700">
              {!thisCheckIn ? (
                <p>Not clocked in for this session.</p>
              ) : openHere ? (
                <p>
                  <strong>Checked in at {academyTime(thisCheckIn.checkInAt)}</strong>
                  {" · "}
                  {formatDuration(minutesBetween(thisCheckIn.checkInAt, new Date(nowTick).toISOString()))}{" "}
                  elapsed
                </p>
              ) : (
                <p>
                  <strong>Done</strong> — {academyTime(thisCheckIn.checkInAt)} to{" "}
                  {academyTime(thisCheckIn.checkOutAt ?? undefined)}, recorded span{" "}
                  {formatDuration(minutesBetween(thisCheckIn.checkInAt, thisCheckIn.checkOutAt ?? ""))}.
                </p>
              )}
              {openElsewhere ? (
                <p className="mt-1 text-[13px] font-medium text-amber-800">
                  You still have an open check-in for {openElsewhere.session.ageGroupName} on{" "}
                  {formatDateStr(academyDateOf(openElsewhere.session.startsAt))}. Check out of that
                  one first.
                </p>
              ) : null}
            </div>
            {/* One tap, no dialog, ≥ 48 px, thumb-reachable (PAGE_SPEC §2, T-UI-10). */}
            <div className="flex shrink-0 gap-2">
              {!thisCheckIn ? (
                <Button
                  className="min-h-[48px] w-full sm:w-auto"
                  onClick={() => checkInMutation.mutate()}
                  pending={checkInMutation.isPending}
                  disabled={!checkinOpen || Boolean(openElsewhere)}
                  title={
                    checkinOpen
                      ? undefined
                      : `Check-in opens at ${academyTime(checkinWindow?.opensAt)} and closes at ${academyTime(checkinWindow?.closesAt)}`
                  }
                >
                  Check in
                </Button>
              ) : openHere ? (
                <Button
                  variant="secondary"
                  className="min-h-[48px] w-full sm:w-auto"
                  onClick={() => checkOutMutation.mutate()}
                  pending={checkOutMutation.isPending}
                >
                  Check out
                </Button>
              ) : (
                <span className="inline-flex min-h-[48px] items-center text-[14px] font-semibold text-slate-600">
                  Recorded
                </span>
              )}
            </div>
          </div>
          {!checkinOpen && !thisCheckIn ? (
            <p className="px-4 pb-4 text-[13px] text-slate-600">
              Check-in is closed for this session (it opens 60 minutes before the start and closes 2
              hours after the end). An owner can add or correct coach time on Coach Time.
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <SectionTitle
          right={
            <span className="text-[12px] text-slate-600">
              {readOnly ? "Read-only" : `${dirtyRows.length} unsaved`}
            </span>
          }
        >
          Attendance sheet
        </SectionTitle>

        {/* Sticky counts + the one-tap shortcut, so the coach never scrolls up. */}
        <div className="sticky top-16 z-20 -mx-px border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-700">
              Present {counts.present} · Late {counts.late} · Absent {counts.absent} · Excused{" "}
              {counts.excused} ·
            </span>
            <span
              className={`text-[13px] font-semibold ${
                counts.unmarked > 0 ? "text-amber-800" : "text-slate-600"
              }`}
            >
              Unmarked {counts.unmarked}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={markAllPresent}
              disabled={readOnly || roster.length === 0}
            >
              Mark all present
            </Button>
          </div>
          <p className="mt-1 text-[12px] text-slate-500">
            Rows already saved keep their record — only unmarked rows are filled.
          </p>
        </div>

        {roster.length === 0 ? (
          <p className="px-4 py-8 text-center text-[14px] text-slate-600">
            No players were on this group&apos;s roster on {formatDateStr(session.sessionDate)}.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Attendance roster">
            {roster.map((row) => {
              const choice = choices[row.player.id] ?? { status: row.record?.status ?? null };
              const needsReason = Boolean(
                row.record && choice.status && choice.status !== row.record.status
              );
              const conflict = conflicts?.find((c) => c.playerId === row.player.id);
              return (
                <AttendanceRow
                  key={row.player.id}
                  row={row}
                  value={choice}
                  disabled={readOnly}
                  needsReason={needsReason}
                  reasonError={reasonErrors[row.player.id]}
                  conflict={conflict?.message}
                  onPick={(next) => setChoice(row.player.id, { status: next })}
                  onNote={(next) => setChoice(row.player.id, { note: next })}
                  onReason={(next) => setChoice(row.player.id, { reason: next })}
                />
              );
            })}
          </ul>
        )}

        {readOnly ? (
          <p className="border-t border-slate-200 px-4 py-3 text-[13px] text-slate-600">
            {cancelled
              ? "This session was cancelled, so the sheet is read-only."
              : `Your editing window for this session closed on ${formatInstant(data?.editableUntil)}. An owner can still correct it.`}
          </p>
        ) : null}
      </Card>

      {conflicts ? (
        <Modal
          open
          onClose={() => setConflicts(null)}
          title="Someone else changed these records"
          description="Two people are marking the same session. Nothing was saved for the rows listed below."
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  // Drop my local marks for the conflicting rows and trust the server.
                  setConflicts(null);
                  setEdits({});
                  void sheetQuery.refetch();
                }}
              >
                Keep theirs
              </Button>
              <Button
                onClick={() => {
                  save(true);
                }}
                pending={saveMutation.isPending}
              >
                Overwrite with mine
              </Button>
            </>
          }
        >
          <ul className="space-y-2 text-[14px]">
            {conflicts.map((c, index) => (
              <li key={`${c.playerId}-${index}`} className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <span>{c.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-slate-600">
            Overwriting keeps your marks and records the reason you entered.
          </p>
        </Modal>
      ) : null}

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel session"
        description="Cancellation cannot be undone. Attendance already marked is kept as history and excluded from reports."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep the session
            </Button>
            <Button
              variant="danger"
              onClick={() => cancelMutation.mutate()}
              pending={cancelMutation.isPending}
            >
              Cancel session
            </Button>
          </>
        }
      >
        <TextField
          id="cancel-reason"
          label="Reason"
          required
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
          error={cancelError ?? undefined}
          hint="At least 5 characters. The reason is stored with the session."
        />
      </Modal>

      {/* Sticky full-width Save, above the mobile tab bar (PAGE_SPEC §5). */}
      {!readOnly ? (
        <div
          className="fixed inset-x-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:left-[248px]"
          style={{ bottom: navHeight }}
        >
          <div className="mx-auto flex max-w-7xl items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px] text-slate-600">
              {dirtyRows.length === 0
                ? "No changes yet."
                : `${dirtyRows.length} row${dirtyRows.length === 1 ? "" : "s"} to save.`}
            </p>
            <Button
              className="min-h-[48px] w-full sm:w-auto"
              onClick={() => save()}
              pending={saveMutation.isPending}
              disabled={dirtyRows.length === 0}
            >
              Save attendance
            </Button>
          </div>
        </div>
      ) : null}

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <p className="mt-4 text-[12px] text-slate-500">
        Times are the server&apos;s, in {me?.academy.timezone ?? "the academy timezone"}. A coach&apos;s
        clock time never changes a player&apos;s attendance, a fee or a balance.{" "}
        <Link href="/coach-attendance" className="font-semibold underline underline-offset-2">
          Coach Time
        </Link>
      </p>
    </>
  );
}
