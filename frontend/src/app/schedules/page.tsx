"use client";

// Training schedules (SCH-01/02) — PAGE_SPECIFICATIONS §5, API_CONTRACTS §3.5.
//
// A schedule is a RULE, not a session: creating or editing one rewrites nothing that
// already exists. Only "Generate sessions" writes rows, and it writes nothing twice —
// the database's `(schedule_id, session_date)` unique index makes a second run a no-op
// (T-ATT-01). Times here are academy-local wall-clock strings; the server converts them
// to real instants in SQL, so this page never guesses a UTC offset (ATTENDANCE §2).
//
// This is the "sessions are automated" screen the owner asked for: set Tuesday + Thursday
// 16:00–17:30 once per age group, generate the range, and the sessions appear on /sessions.
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Pencil, Plus, Power, Repeat } from "lucide-react";
import {
  ApiError,
  grp01ListAgeGroups,
  sch01CreateSchedule,
  sch01DeactivateSchedule,
  sch01ListSchedules,
  sch01UpdateSchedule,
  sch02GenerateSessions,
} from "@/api/client";
import type { TrainingSchedule } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
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
  SelectField,
  TextField,
  Toast,
} from "@/components/ui";
import { addDaysISO, formatDateStr, todayISO } from "@/lib/dates";

const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

function weekdayLabel(weekday: number): string {
  return WEEKDAYS.find((d) => d.value === weekday)?.label ?? `Day ${weekday}`;
}

/** `16:00:00` (or `16:00`) → `16:00`. */
function clock(value: string): string {
  return value.slice(0, 5);
}

interface FormState {
  id?: string;
  ageGroupId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  venue: string;
  validFrom: string;
  validTo: string;
}

function emptyForm(defaultGroupId: string): FormState {
  return {
    ageGroupId: defaultGroupId,
    weekday: 2, // Tuesday
    startTime: "16:00",
    endTime: "17:30",
    venue: "",
    validFrom: todayISO(),
    validTo: "",
  };
}

function SchedulesView() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [generateFor, setGenerateFor] = useState<TrainingSchedule | "all" | null>(null);
  const [generateRange, setGenerateRange] = useState({
    from: todayISO(),
    to: addDaysISO(todayISO(), 60),
  });
  const [generating, setGenerating] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);

  const schedulesQuery = useQuery({
    queryKey: ["training-schedules", { includeInactive: true }],
    queryFn: () => sch01ListSchedules({ includeInactive: true }),
  });

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
  });

  const schedules = schedulesQuery.data?.data ?? [];
  const groups = groupsQuery.data?.data ?? [];
  const activeSchedules = schedules.filter((s) => s.isActive);

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["training-schedules"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    ]);
  }, [queryClient]);

  function openCreate() {
    setFormError(null);
    setFieldErrors({});
    setForm(emptyForm(groups[0]?.id ?? ""));
  }

  function openEdit(schedule: TrainingSchedule) {
    setFormError(null);
    setFieldErrors({});
    setForm({
      id: schedule.id,
      ageGroupId: schedule.ageGroup.id,
      weekday: schedule.weekday,
      startTime: clock(schedule.startTime),
      endTime: clock(schedule.endTime),
      venue: schedule.venue ?? "",
      validFrom: schedule.validFrom,
      validTo: schedule.validTo ?? "",
    });
  }

  async function submitForm() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      if (form.id) {
        await sch01UpdateSchedule(form.id, {
          startTime: form.startTime,
          endTime: form.endTime,
          venue: form.venue,
          validFrom: form.validFrom,
          validTo: form.validTo || undefined,
        });
        setToast("Schedule updated. Existing sessions are unchanged — generate to add new dates.");
      } else {
        await sch01CreateSchedule({
          ageGroupId: form.ageGroupId,
          weekday: form.weekday,
          startTime: form.startTime,
          endTime: form.endTime,
          venue: form.venue || undefined,
          validFrom: form.validFrom,
          validTo: form.validTo || undefined,
        });
        setToast("Schedule created. Use “Generate sessions” to create the dates.");
      }
      setForm(null);
      await invalidate();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors());
        setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please retry.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(schedule: TrainingSchedule) {
    setDeactivating(schedule.id);
    try {
      await sch01DeactivateSchedule(schedule.id);
      setToast("Schedule deactivated. Sessions already generated are kept.");
      await invalidate();
    } catch {
      setToast("Could not deactivate that schedule. Please retry.");
    } finally {
      setDeactivating(null);
    }
  }

  async function runGenerate() {
    if (!generateFor) return;
    setGenerating(true);
    try {
      const targets: TrainingSchedule[] =
        generateFor === "all" ? activeSchedules : [generateFor];
      let created = 0;
      let skipped = 0;
      for (const schedule of targets) {
        const result = await sch02GenerateSessions(schedule.id, {
          from: generateRange.from,
          to: generateRange.to,
        });
        created += result.created;
        skipped += result.skipped;
      }
      setToast(
        `${created} session${created === 1 ? "" : "s"} created` +
          (skipped > 0 ? ` · ${skipped} already existed` : "")
      );
      setGenerateFor(null);
      await invalidate();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : "Could not generate sessions. Please retry.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Training schedules"
        sub="The weekly rule: which age group trains on which day and time. Sessions are generated from it and appear on the Sessions page."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setGenerateFor("all")}
              disabled={activeSchedules.length === 0}
            >
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
              Generate sessions
            </Button>
            <Button size="sm" onClick={openCreate} disabled={groups.length === 0}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add schedule
            </Button>
          </div>
        }
      />

      <Card className="mb-4">
        <div className="flex items-start gap-3 p-4">
          <Repeat className="mt-0.5 h-5 w-5 shrink-0 text-pitch-600" aria-hidden="true" />
          <p className="text-[14px] text-slate-700">
            A schedule is a rule, never the sessions themselves. Editing one does not touch
            sessions already created, and generating a range twice cannot duplicate a date.
          </p>
        </div>
      </Card>

      {groupsQuery.isError ? (
        <div className="mb-4">
          <InlineAlert tone="warning" title="The age-group list could not be loaded">
            <p>Adding a schedule is disabled until the groups load.</p>
            <Button size="sm" variant="secondary" onClick={() => groupsQuery.refetch()}>
              Retry
            </Button>
          </InlineAlert>
        </div>
      ) : null}

      <Card>
        {schedulesQuery.isLoading ? (
          <ListSkeleton rows={5} />
        ) : schedulesQuery.isError ? (
          <ErrorState error={schedulesQuery.error} onRetry={() => schedulesQuery.refetch()} />
        ) : schedules.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            description="Add the weekly pattern — for example Tuesday and Thursday, 16:00 to 17:30 — and generate the sessions."
            action={
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add schedule
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-semibold">Age group</th>
                  <th className="px-4 py-3 font-semibold">Day</th>
                  <th className="px-4 py-3 font-semibold">Time</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Venue</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">Valid</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {schedule.ageGroup.name}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{weekdayLabel(schedule.weekday)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {clock(schedule.startTime)}–{clock(schedule.endTime)}
                    </td>
                    <td className="hidden px-4 py-3 text-slate-700 sm:table-cell">
                      {schedule.venue ?? "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-slate-600 md:table-cell">
                      {formatDateStr(schedule.validFrom)}
                      {schedule.validTo ? ` – ${formatDateStr(schedule.validTo)}` : " onwards"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={schedule.isActive ? "Active" : "Inactive"} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(schedule)}
                          aria-label={`Edit ${schedule.ageGroup.name} schedule`}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!schedule.isActive}
                          onClick={() => setGenerateFor(schedule)}
                          aria-label={`Generate sessions for ${schedule.ageGroup.name}`}
                        >
                          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                          Generate
                        </Button>
                        {schedule.isActive ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            pending={deactivating === schedule.id}
                            onClick={() => deactivate(schedule)}
                            aria-label={`Deactivate ${schedule.ageGroup.name} schedule`}
                          >
                            <Power className="h-4 w-4" aria-hidden="true" />
                            Deactivate
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- create / edit --- */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? "Edit schedule" : "Add schedule"}
        description={
          form?.id
            ? "Changing the rule never rewrites sessions that already exist."
            : "One weekly pattern for one age group. Add a second schedule for a second day."
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={submitForm} pending={saving}>
              {form?.id ? "Save changes" : "Create schedule"}
            </Button>
          </>
        }
      >
        {form ? (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitForm();
            }}
          >
            {formError ? (
              <InlineAlert tone="danger" title="Could not save">
                <p>{formError}</p>
              </InlineAlert>
            ) : null}
            <SelectField
              id="schedule-group"
              label="Age group"
              required
              value={form.ageGroupId}
              disabled={Boolean(form.id)}
              error={fieldErrors["ageGroupId"]}
              onChange={(e) => setForm({ ...form, ageGroupId: e.target.value })}
            >
              <option value="">Choose a group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              id="schedule-weekday"
              label="Day of the week"
              required
              value={form.weekday}
              disabled={Boolean(form.id)}
              hint={form.id ? "The day cannot change on an existing schedule." : undefined}
              onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </SelectField>
            <div className="grid grid-cols-2 gap-3">
              <TextField
                id="schedule-start"
                label="Starts"
                type="time"
                required
                value={form.startTime}
                error={fieldErrors["startTime"]}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              />
              <TextField
                id="schedule-end"
                label="Ends"
                type="time"
                required
                value={form.endTime}
                error={fieldErrors["endTime"]}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              />
            </div>
            <TextField
              id="schedule-venue"
              label="Venue"
              value={form.venue}
              hint="Optional."
              onChange={(e) => setForm({ ...form, venue: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField
                id="schedule-from"
                label="Valid from"
                type="date"
                required
                value={form.validFrom}
                error={fieldErrors["validFrom"]}
                onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
              />
              <TextField
                id="schedule-to"
                label="Valid to"
                type="date"
                value={form.validTo}
                hint="Optional."
                onChange={(e) => setForm({ ...form, validTo: e.target.value })}
              />
            </div>
          </form>
        ) : null}
      </Modal>

      {/* --- generate --- */}
      <Modal
        open={generateFor !== null}
        onClose={() => setGenerateFor(null)}
        title="Generate sessions"
        description={
          generateFor === "all"
            ? "Creates sessions for every active schedule in the range below. A date that already exists is skipped."
            : "Creates the sessions this rule produces in the range below."
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setGenerateFor(null)}>
              Cancel
            </Button>
            <Button onClick={runGenerate} pending={generating}>
              Generate
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <TextField
            id="generate-from"
            label="From"
            type="date"
            value={generateRange.from}
            onChange={(e) => setGenerateRange({ ...generateRange, from: e.target.value })}
          />
          <TextField
            id="generate-to"
            label="To"
            type="date"
            value={generateRange.to}
            hint="At most 90 days."
            onChange={(e) => setGenerateRange({ ...generateRange, to: e.target.value })}
          />
        </div>
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <RequirePermissions path="/schedules">
        <SchedulesView />
      </RequirePermissions>
    </RequireAuth>
  );
}
