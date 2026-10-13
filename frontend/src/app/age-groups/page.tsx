"use client";

// Age groups (PAGE_SPECIFICATIONS §4, contract GRP-01..05 + FEE-01 in
// API_CONTRACTS §3.3). Owner: name, age range, active players, current fee and
// status, with create/edit and archive/unarchive. Coach: the assigned groups
// only — GRP-01 omits fee fields for a coach, and this page never asks for them.
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import {
  ApiError,
  grp01ListAgeGroups,
  grp02CreateAgeGroup,
  grp03PatchAgeGroup,
  grp04ArchiveAgeGroup,
} from "@/api/client";
import type { AgeGroup } from "@/api/types";
import { RequireAuth } from "@/components/Guards";
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
  MoneyText,
  TextField,
  Toast,
  Toggle,
  buttonClass,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";

interface FormState {
  name: string;
  minAge: string;
  maxAge: string;
}

const EMPTY_FORM: FormState = { name: "", minAge: "", maxAge: "" };

/** "8–10", "Up to 10", "11 and over" or "—". */
function ageRange(group: AgeGroup): string {
  if (group.minAge !== undefined && group.maxAge !== undefined) return `${group.minAge}–${group.maxAge}`;
  if (group.maxAge !== undefined) return `Up to ${group.maxAge}`;
  if (group.minAge !== undefined) return `${group.minAge} and over`;
  return "—";
}

function parseAge(value: string): number | undefined | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d{1,2}$/.test(trimmed)) return "invalid";
  return Number(trimmed);
}

function AgeGroupsBody() {
  const { me } = useAuth();
  const isOwner = me?.user.role === "owner";
  const queryClient = useQueryClient();

  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; group?: AgeGroup } | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [blockedArchive, setBlockedArchive] = useState<{ group: AgeGroup; message: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: showArchived, role: me?.user.role }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: showArchived }),
    enabled: Boolean(me),
  });

  const groups = groupsQuery.data?.data ?? [];
  const ownerColumns = isOwner;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["age-groups"] });

  const createMutation = useMutation({
    mutationFn: (input: { name: string; minAge?: number; maxAge?: number }) => grp02CreateAgeGroup(input),
    onSuccess: (group) => {
      setDialog(null);
      setToast(`${group.name} created.`);
      void refresh();
    },
    onError: (error) => handleFormError(error, "Could not create the group. Please retry."),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name: string; minAge?: number; maxAge?: number } }) =>
      grp03PatchAgeGroup(id, input),
    onSuccess: (group) => {
      setDialog(null);
      setToast(`${group.name} updated.`);
      void refresh();
    },
    onError: (error) => handleFormError(error, "Could not save the changes. Please retry."),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, archive }: { id: string; archive: boolean }) => grp04ArchiveAgeGroup(id, archive),
    onSuccess: (group) => {
      setToast(group.archivedAt ? `${group.name} archived.` : `${group.name} restored.`);
      void refresh();
    },
    onError: (error, variables) => {
      const group = groups.find((g) => g.id === variables.id);
      if (error instanceof ApiError && error.code === "AGE_GROUP_HAS_ACTIVE_PLAYERS" && group) {
        // The server refuses to archive a group that still holds active players.
        setBlockedArchive({ group, message: error.message });
        return;
      }
      setAlert(error instanceof ApiError ? error.message : "Could not change the group status. Please retry.");
    },
  });

  function handleFormError(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
      const fields = error.fieldErrors();
      setFormErrors(Object.keys(fields).length ? fields : { name: error.message });
      return;
    }
    setFormErrors({ name: error instanceof ApiError ? error.message : fallback });
  }

  function openDialog(mode: "create" | "edit", group?: AgeGroup) {
    setFormErrors({});
    setAlert(null);
    setForm(
      group
        ? {
            name: group.name,
            minAge: group.minAge === undefined ? "" : String(group.minAge),
            maxAge: group.maxAge === undefined ? "" : String(group.maxAge),
          }
        : EMPTY_FORM
    );
    setDialog({ mode, group });
  }

  function submitForm(event: React.FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    const min = parseAge(form.minAge);
    const max = parseAge(form.maxAge);
    const errors: Record<string, string> = {};
    if (name.length < 2 || name.length > 60) errors.name = "Name is required (2–60 characters)";
    if (min === "invalid") errors.minAge = "Use a whole number, e.g. 8";
    if (max === "invalid") errors.maxAge = "Use a whole number, e.g. 10";
    if (typeof min === "number" && typeof max === "number" && min > max) {
      errors.minAge = "Minimum age must not exceed maximum age";
    }
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      return;
    }
    setFormErrors({});
    const input = { name, minAge: typeof min === "number" ? min : undefined, maxAge: typeof max === "number" ? max : undefined };
    if (dialog?.mode === "edit" && dialog.group) {
      patchMutation.mutate({ id: dialog.group.id, input });
    } else {
      createMutation.mutate(input);
    }
  }

  return (
    <>
      <PageHeader
        title="Age groups"
        sub="A player belongs to one group at a time; a transfer keeps the history."
        actions={
          isOwner ? (
            <Button onClick={() => openDialog("create")}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New age group
            </Button>
          ) : undefined
        }
      />

      {alert ? (
        <div className="mb-4">
          <InlineAlert tone="danger" title="That did not work">
            {alert}
          </InlineAlert>
        </div>
      ) : null}

      {!isOwner ? (
        <div className="mb-4">
          <InlineAlert tone="info" title="Your groups">
            You can see the groups you are assigned to. Fees, balances and owner
            settings are not shown to coaches.
          </InlineAlert>
        </div>
      ) : null}

      <Card className="mb-4">
        <div className="p-4">
          <Toggle
            id="show-archived"
            label="Show archived groups"
            hint="Archived groups keep their history but take no new players."
            checked={showArchived}
            onChange={setShowArchived}
          />
        </div>
      </Card>

      <Card>
        {groupsQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : groupsQuery.isError ? (
          <ErrorState error={groupsQuery.error} onRetry={() => groupsQuery.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState
            title="No age groups yet"
            description={
              isOwner
                ? "Create the groups players are assigned to, then set a fee for each one."
                : "You are not assigned to a group yet. Ask an owner to assign you."
            }
            action={
              isOwner ? (
                <Button onClick={() => openDialog("create")}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New age group
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table (≥ 640 px) */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-[14px]">
                <caption className="sr-only">Age groups</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Name</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Age range</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Active players</th>
                    {ownerColumns ? <th scope="col" className="px-4 py-3 text-right font-semibold">Current fee</th> : null}
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    {isOwner ? (
                      <th scope="col" className="px-4 py-3 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        <Link href={`/age-groups/${group.id}`} className="underline-offset-2 hover:underline">
                          {group.name}
                        </Link>
                      </td>
                      <td className="tabular px-4 py-3 text-slate-700">{ageRange(group)}</td>
                      <td className="tabular px-4 py-3 text-right text-slate-700">
                        {group.activePlayerCount ?? 0}
                      </td>
                      {ownerColumns ? (
                        <td className="px-4 py-3 text-right">
                          {group.currentFeeMinor === undefined ? (
                            <span className="text-amber-700">No fee set</span>
                          ) : (
                            <MoneyText minor={group.currentFeeMinor} />
                          )}
                        </td>
                      ) : null}
                      <td className="px-4 py-3">
                        <StatusChip status={group.archivedAt ? "Archived" : "Active"} />
                      </td>
                      {isOwner ? (
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <Button variant="secondary" size="sm" onClick={() => openDialog("edit", group)}>
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              pending={archiveMutation.isPending}
                              onClick={() => archiveMutation.mutate({ id: group.id, archive: !group.archivedAt })}
                            >
                              {group.archivedAt ? (
                                <>
                                  <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                                  Unarchive
                                </>
                              ) : (
                                <>
                                  <Archive className="h-4 w-4" aria-hidden="true" />
                                  Archive
                                </>
                              )}
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {groups.map((group) => (
                <li key={group.id} className="px-4 py-3">
                  <Link href={`/age-groups/${group.id}`} className="block">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold text-slate-900">{group.name}</p>
                        <p className="mt-0.5 text-[13px] text-slate-600">
                          Ages {ageRange(group)} · {group.activePlayerCount ?? 0} active
                        </p>
                        {ownerColumns ? (
                          <p className="tabular mt-1 text-[13px] text-slate-700">
                            {group.currentFeeMinor === undefined ? (
                              <span className="text-amber-700">No fee set</span>
                            ) : (
                              <>Fee <MoneyText minor={group.currentFeeMinor} /></>
                            )}
                          </p>
                        ) : null}
                      </div>
                      <StatusChip status={group.archivedAt ? "Archived" : "Active"} />
                    </div>
                  </Link>
                  {isOwner ? (
                    <div className="mt-2 flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => openDialog("edit", group)}>
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        pending={archiveMutation.isPending}
                        onClick={() => archiveMutation.mutate({ id: group.id, archive: !group.archivedAt })}
                      >
                        {group.archivedAt ? "Unarchive" : "Archive"}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog?.mode === "edit" ? `Edit ${dialog.group?.name ?? "group"}` : "New age group"}
        description="The age range is measured on the academy's reference date and is advisory — a player is never moved automatically."
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="age-group-form"
              pending={createMutation.isPending || patchMutation.isPending}
            >
              {dialog?.mode === "edit" ? "Save changes" : "Create group"}
            </Button>
          </>
        }
      >
        <form id="age-group-form" onSubmit={submitForm} className="space-y-4">
          <TextField
            id="group-name"
            label="Name"
            required
            value={form.name}
            error={formErrors.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField
              id="group-min-age"
              label="Minimum age"
              inputMode="numeric"
              value={form.minAge}
              error={formErrors.minAge}
              onChange={(e) => setForm((prev) => ({ ...prev, minAge: e.target.value }))}
              hint="Optional"
            />
            <TextField
              id="group-max-age"
              label="Maximum age"
              inputMode="numeric"
              value={form.maxAge}
              error={formErrors.maxAge}
              onChange={(e) => setForm((prev) => ({ ...prev, maxAge: e.target.value }))}
              hint="Optional"
            />
          </div>
        </form>
      </Modal>

      <Modal
        open={blockedArchive !== null}
        onClose={() => setBlockedArchive(null)}
        title="Group still has active players"
        description={blockedArchive?.message}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={() => setBlockedArchive(null)}>
              Close
            </Button>
            {blockedArchive ? (
              <Link
                href={`/players?ageGroupId=${blockedArchive.group.id}`}
                className={buttonClass("primary")}
                onClick={() => setBlockedArchive(null)}
              >
                See the active players
              </Link>
            ) : null}
          </>
        }
      >
        <p className="text-[14px] text-slate-600">
          Move those players to another group (or withdraw them) before archiving{" "}
          <strong>{blockedArchive?.group.name}</strong>. Existing invoices and attendance history are
          not changed by archiving.
        </p>
      </Modal>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

export default function AgeGroupsPage() {
  return (
    <RequireAuth>
      <AgeGroupsBody />
    </RequireAuth>
  );
}
