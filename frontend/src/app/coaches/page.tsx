"use client";

// Coaches & assignments (PAGE_SPECIFICATIONS §4 "Coaches", ROUTES §1).
// Owner-only route: /coaches maps to the `users:manage` permission in
// lib/permissions.ts, so the guard runs before any owner API is called.
// One page covers CCH-01..04 plus USR-02 (invite a coach; the invite URL is
// returned once and is never retrievable again — it is shown in a dialog that
// the owner has to close).
import { Suspense, useCallback, useDeferredValue, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plus } from "lucide-react";
import {
  ApiError,
  cch01ListCoaches,
  cch02ListAssignments,
  cch03CreateAssignment,
  cch04EndAssignment,
  grp01ListAgeGroups,
  usr02CreateUser,
} from "@/api/client";
import type { AgeGroup, CoachAssignment, CoachRow, CreateUserResponse } from "@/api/types";
import { RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  DateText,
  EmptyState,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SelectField,
  TextField,
  Toast,
} from "@/components/ui";
import { formatDateStr, todayISO } from "@/lib/dates";

const USERNAME_RULE = /^[a-z0-9._-]{3,32}$/;

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function CoachesList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const q = searchParams.get("q") ?? "";
  // URL-held search text with a deferred fetch value — same pattern as the
  // players list, so a soft navigation can never swallow a keystroke.
  const deferredQ = useDeferredValue(q);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [invite, setInvite] = useState<CreateUserResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const [assignFor, setAssignFor] = useState<CoachRow | null>(null);
  const [endFor, setEndFor] = useState<{ coach: CoachRow; assignment: CoachAssignment } | null>(null);

  const setQuery = useCallback(
    (next: string | null) => {
      const query = next ? `?q=${encodeURIComponent(next)}` : "";
      router.replace(`${pathname}${query}`, { scroll: false });
    },
    [pathname, router]
  );

  const coachesQuery = useQuery({
    queryKey: ["coaches", { q: deferredQ }],
    // The contract only applies `q` from 2 characters.
    queryFn: () =>
      cch01ListCoaches({ q: deferredQ.trim().length >= 2 ? deferredQ.trim() : undefined }),
    placeholderData: (previous) => previous,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["coach-assignments", {}],
    queryFn: () => cch02ListAssignments({}),
  });

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
  });

  const coaches = coachesQuery.data?.data ?? [];
  const assignments = assignmentsQuery.data?.data ?? [];
  const groups = groupsQuery.data?.data ?? [];

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["coaches"] }),
      queryClient.invalidateQueries({ queryKey: ["coach-assignments"] }),
    ]);
  }, [queryClient]);

  function assignmentsOf(coachUserId: string): CoachAssignment[] {
    return assignments
      .filter((a) => a.coachUserId === coachUserId)
      .sort((a, b) => b.assignedFrom.localeCompare(a.assignedFrom));
  }

  function activeGroupsOf(coach: CoachRow): { id: string; name: string }[] {
    return coach.groups;
  }

  return (
    <>
      <PageHeader
        title="Coaches"
        sub="Coaches are users with the coach role. Their group access comes from assignments — a coach only ever sees the groups assigned to them."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add coach
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="p-4 sm:max-w-sm">
          <TextField
            id="coach-search"
            label="Search"
            placeholder="Name or username"
            value={q}
            onChange={(e) => setQuery(e.target.value || null)}
            hint="Two characters or more."
          />
        </div>
      </Card>

      {groupsQuery.isError || assignmentsQuery.isError ? (
        <div className="mb-4">
          <InlineAlert tone="warning" title="Some data could not be loaded">
            <p>
              {groupsQuery.isError
                ? "The group list is unavailable, so assigning a group is disabled."
                : null}
              {assignmentsQuery.isError
                ? " Assignment history is unavailable, so the counts shown per coach are incomplete."
                : null}
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void groupsQuery.refetch();
                void assignmentsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </InlineAlert>
        </div>
      ) : null}

      <Card>
        {coachesQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : coachesQuery.isError ? (
          <ErrorState error={coachesQuery.error} onRetry={() => coachesQuery.refetch()} />
        ) : coaches.length === 0 ? (
          <EmptyState
            title={q ? "No coaches match this search" : "No coaches yet"}
            description={
              q
                ? "Try a different name or username."
                : "Add a coach to invite them and assign the groups they train."
            }
            action={
              q ? (
                <Button variant="secondary" onClick={() => setQuery(null)}>
                  Clear search
                </Button>
              ) : (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add coach
                </Button>
              )
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">
                  Coaches{coachesQuery.data?.meta ? `, ${coachesQuery.data.meta.total} listed` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Username</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Phone</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Groups</th>
                    <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {coaches.map((coach) => {
                    const own = assignmentsOf(coach.user.id);
                    const open = own.filter((a) => !a.assignedTo);
                    const isOpen = expanded === coach.user.id;
                    return (
                      <tr key={coach.user.id} className="border-b border-slate-100 last:border-0 align-top">
                        <td className="px-4 py-3 font-semibold text-slate-900">{coach.user.fullName}</td>
                        <td className="px-4 py-3 font-mono text-[13px] text-slate-600">{coach.user.username}</td>
                        <td className="px-4 py-3 text-slate-700">{coach.user.phone ?? "—"}</td>
                        <td className="px-4 py-3">
                          <StatusChip status={statusLabel(coach.user.status)} />
                        </td>
                        <td className="px-4 py-3">
                          <GroupChips groups={activeGroupsOf(coach)} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button size="sm" variant="secondary" onClick={() => setAssignFor(coach)}>
                              Assign group
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-expanded={isOpen}
                              onClick={() => setExpanded(isOpen ? null : coach.user.id)}
                            >
                              Assignments ({own.length})
                            </Button>
                          </div>
                          {isOpen ? (
                            <AssignmentPanel
                              assignments={own}
                              onEnd={(assignment) => setEndFor({ coach, assignment })}
                            />
                          ) : null}
                          {open.length === 0 && !isOpen ? (
                            <p className="mt-1 text-right text-[12px] text-slate-500">
                              No active group — this coach sees nothing yet.
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {coaches.map((coach) => {
                const own = assignmentsOf(coach.user.id);
                const isOpen = expanded === coach.user.id;
                return (
                  <li key={coach.user.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-slate-900">{coach.user.fullName}</p>
                        <p className="mt-0.5 font-mono text-[13px] text-slate-600">{coach.user.username}</p>
                        {coach.user.phone ? (
                          <p className="mt-0.5 text-[13px] text-slate-600">{coach.user.phone}</p>
                        ) : null}
                      </div>
                      <StatusChip status={statusLabel(coach.user.status)} />
                    </div>
                    <div className="mt-2">
                      <GroupChips groups={activeGroupsOf(coach)} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setAssignFor(coach)}>
                        Assign group
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : coach.user.id)}
                      >
                        Assignments ({own.length})
                      </Button>
                    </div>
                    {isOpen ? (
                      <AssignmentPanel
                        assignments={own}
                        onEnd={(assignment) => setEndFor({ coach, assignment })}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <AddCoachDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(result) => {
          setAddOpen(false);
          setInvite(result);
          setCopied(false);
          void invalidate();
        }}
      />

      <InviteDialog
        invite={invite}
        copied={copied}
        onCopy={async (url) => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            const field = document.getElementById("invite-url") as HTMLInputElement | null;
            field?.select();
            setCopied(false);
          }
        }}
        onClose={() => setInvite(null)}
      />

      <AssignGroupDialog
        key={assignFor?.user.id ?? "no-coach"}
        coach={assignFor}
        groups={groups}
        onClose={() => setAssignFor(null)}
        onAssigned={async (coach, group, from) => {
          setAssignFor(null);
          await invalidate();
          setToast(`${coach.user.fullName} now trains ${group.name} from ${formatDateStr(from)}.`);
        }}
      />

      <EndAssignmentDialog
        key={endFor?.assignment.id ?? "no-assignment"}
        data={endFor}
        onClose={() => setEndFor(null)}
        onEnded={async (data, until) => {
          setEndFor(null);
          await invalidate();
          setToast(
            `${data.coach.user.fullName} keeps the ${data.assignment.ageGroup.name} history and loses access from ${formatDateStr(until)}.`
          );
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function GroupChips({ groups }: { groups: { id: string; name: string }[] }) {
  if (groups.length === 0) {
    return <span className="text-[13px] text-slate-500">None assigned</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {groups.map((group) => (
        <span
          key={group.id}
          className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] font-semibold text-slate-700"
        >
          {group.name}
        </span>
      ))}
    </span>
  );
}

function AssignmentPanel({
  assignments,
  onEnd,
}: {
  assignments: CoachAssignment[];
  onEnd: (assignment: CoachAssignment) => void;
}) {
  if (assignments.length === 0) {
    return (
      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
        No assignment has been recorded for this coach yet. Until one exists they cannot see any
        group.
      </p>
    );
  }
  return (
    <ul className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3 text-left text-[13px]">
      {assignments.map((assignment) => (
        <li key={assignment.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-slate-800">
            <span className="font-semibold">{assignment.ageGroup.name}</span> · from{" "}
            <DateText value={assignment.assignedFrom} />
            {assignment.assignedTo ? (
              <>
                {" "}
                · ended <DateText value={assignment.assignedTo} />
              </>
            ) : (
              <span className="ml-1 inline-flex items-center gap-1 font-semibold text-emerald-700">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                active
              </span>
            )}
          </span>
          {!assignment.assignedTo ? (
            <Button size="sm" variant="ghost" onClick={() => onEnd(assignment)}>
              End assignment
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AddCoachDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreateUserResponse) => void;
}) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setUsername("");
    setFullName("");
    setPhone("");
    setErrors({});
    setFormError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const handle = username.trim().toLowerCase();
    if (!USERNAME_RULE.test(handle)) {
      next.username = "3–32 characters: a–z, 0–9, dot, underscore or hyphen";
    }
    if (fullName.trim().length < 2) next.fullName = "Enter the coach's full name";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const result = await usr02CreateUser({
        username: handle,
        fullName: fullName.trim(),
        phone: phone.trim() || undefined,
        role: "coach",
      });
      reset();
      onCreated(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        setFormError(
          err.code === "VALIDATION_ERROR"
            ? err.message
            : `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
        );
      } else {
        setFormError("Could not invite the coach. Check your connection and retry.");
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
      title="Add coach"
      description="They receive a single-use invite link to set their own password."
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="add-coach-form" pending={pending}>
            {pending ? "Creating…" : "Create invite"}
          </Button>
        </>
      }
    >
      <form id="add-coach-form" onSubmit={onSubmit} className="space-y-4">
        {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
        <TextField
          id="coach-username"
          label="Username"
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
          hint="This is the sign-in handle and it cannot be changed later — pick it carefully."
        />
        <TextField
          id="coach-full-name"
          label="Full name"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errors.fullName}
        />
        <TextField
          id="coach-phone"
          label="Phone"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
          hint="Optional. Used for WhatsApp contact only — never for signing in."
        />
        <p className="text-[13px] text-slate-600">
          The coach starts with no groups. Assign one on this page after they are created.
        </p>
      </form>
    </Modal>
  );
}

function InviteDialog({
  invite,
  copied,
  onCopy,
  onClose,
}: {
  invite: CreateUserResponse | null;
  copied: boolean;
  onCopy: (url: string) => void;
  onClose: () => void;
}) {
  if (!invite) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Invite link for ${invite.user.fullName}`}
      description="Copy it now and send it to the coach yourself over WhatsApp or SMS."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button onClick={() => onCopy(invite.inviteUrl)}>
            {copied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy link
              </>
            )}
          </Button>
        </>
      }
    >
      <InlineAlert tone="warning" title="Shown only once">
        This link is not stored anywhere you can read it again. It is single use and expires on{" "}
        <DateText value={invite.inviteExpiresAt} withTime />. If it is lost, reset the coach&apos;s
        password from Users — a new link is issued and the old one stops working.
      </InlineAlert>
      <div className="mt-4">
        <TextField
          id="invite-url"
          label="Invite link"
          readOnly
          value={invite.inviteUrl}
          onFocus={(e) => e.currentTarget.select()}
          hint="Select the text and copy it manually if the button does not work."
        />
      </div>
      <p className="mt-3 text-[13px] text-slate-600">
        Username: <span className="font-mono">{invite.user.username}</span> · status{" "}
        <span className="font-semibold">Invited</span> until they set a password.
      </p>
    </Modal>
  );
}

function AssignGroupDialog({
  coach,
  groups,
  onClose,
  onAssigned,
}: {
  coach: CoachRow | null;
  groups: AgeGroup[];
  onClose: () => void;
  onAssigned: (coach: CoachRow, group: AgeGroup, from: string) => Promise<void>;
}) {
  // Mounted per coach (see the `key` at the call site), so the defaults are
  // simply the initial state — no reset effect, no cascading render.
  const [ageGroupId, setAgeGroupId] = useState("");
  const [assignedFrom, setAssignedFrom] = useState(todayISO());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!coach) return null;
  const available = groups.filter((group) => !coach.groups.some((g) => g.id === group.id));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!coach) return;
    if (!ageGroupId) {
      setError("Choose the group this coach will train.");
      return;
    }
    const group = groups.find((g) => g.id === ageGroupId);
    if (!group) return;
    setPending(true);
    setError(null);
    try {
      await cch03CreateAssignment({
        coachUserId: coach.user.id,
        ageGroupId,
        assignedFrom,
      });
      await onAssigned(coach, group, assignedFrom);
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.fieldErrors();
        setError(
          fields.ageGroupId ??
            fields.coachUserId ??
            `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`
        );
      } else {
        setError("Could not save the assignment. Check your connection and retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign a group to ${coach.user.fullName}`}
      description="The coach sees only the groups assigned to them, from the start date you choose."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="assign-group-form" pending={pending}>
            {pending ? "Saving…" : "Assign group"}
          </Button>
        </>
      }
    >
      <form id="assign-group-form" onSubmit={onSubmit} className="space-y-4">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {available.length === 0 ? (
          <InlineAlert tone="info" title="Every group is already assigned">
            This coach already covers all active groups. End an assignment first, or create a new
            group on the Age groups page.
          </InlineAlert>
        ) : (
          <>
            <SelectField
              id="assign-group"
              label="Age group"
              required
              value={ageGroupId}
              onChange={(e) => setAgeGroupId(e.target.value)}
              hint="Only groups this coach does not already cover are listed."
            >
              <option value="">Choose a group…</option>
              {available.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </SelectField>
            <TextField
              id="assign-from"
              label="From"
              type="date"
              required
              value={assignedFrom}
              onChange={(e) => setAssignedFrom(e.target.value)}
              hint="Access starts on this date. Past dates are allowed for back-filling history."
            />
          </>
        )}
      </form>
    </Modal>
  );
}

function EndAssignmentDialog({
  data,
  onClose,
  onEnded,
}: {
  data: { coach: CoachRow; assignment: CoachAssignment } | null;
  onClose: () => void;
  onEnded: (
    data: { coach: CoachRow; assignment: CoachAssignment },
    until: string
  ) => Promise<void>;
}) {
  const [assignedTo, setAssignedTo] = useState(todayISO());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!data) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setPending(true);
    setError(null);
    try {
      await cch04EndAssignment(data.assignment.id, { assignedTo });
      await onEnded(data, assignedTo);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`);
      } else {
        setError("Could not end the assignment. Check your connection and retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="End assignment"
      description={`${data.coach.user.fullName} · ${data.assignment.ageGroup.name} (from ${formatDateStr(data.assignment.assignedFrom)})`}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="end-assignment-form" variant="danger" pending={pending}>
            {pending ? "Ending…" : "End assignment"}
          </Button>
        </>
      }
    >
      <form id="end-assignment-form" onSubmit={onSubmit} className="space-y-4">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <InlineAlert tone="warning" title="What this changes">
          The coach loses access to {data.assignment.ageGroup.name} from the date below. Nothing is
          deleted: their attendance history, sessions and the record of this assignment stay
          exactly as they are.
        </InlineAlert>
        <TextField
          id="assign-to"
          label="Access ends on"
          type="date"
          required
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          hint="Their last day with access is this date."
        />
      </form>
    </Modal>
  );
}

export default function CoachesPage() {
  return (
    <RequirePermissions path="/coaches">
      <Suspense fallback={<ListSkeleton rows={4} />}>
        <CoachesList />
      </Suspense>
    </RequirePermissions>
  );
}
