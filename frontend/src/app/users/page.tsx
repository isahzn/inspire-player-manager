"use client";

// Users (PAGE_SPECIFICATIONS §11 "Users", ROUTES_AND_NAVIGATION §1).
// Owner-only route (`/users` → `users:manage` in lib/permissions.ts), so the
// guard runs before any owner API is called.
//
// Contract obedience notes:
// · the sign-in handle is a `username` (ADR-018) — never an email, never edited
//   after creation (the only remedy is USR-05, a fresh invite);
// · the invite URL is returned ONCE and is never retrievable again, so it is
//   shown in a dialog the owner has to close;
// · `LAST_OWNER` is printed in plain language, never as a code;
// · "Revoke sessions" has no endpoint of its own in API_CONTRACTS: USR-05 is the
//   route that both revokes sessions and issues a new invite, so the row action
//   is USR-05 and its dialog says exactly that. A standalone revoke is NOT
//   invented here — it is raised as a contract gap in the Step 8 handoff.

import { Suspense, useCallback, useDeferredValue, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Pencil, Plus, UserMinus, UserPlus } from "lucide-react";
import {
  ApiError,
  usr01ListUsers,
  usr02CreateUser,
  usr03PatchUser,
  usr04DisableUser,
  usr04EnableUser,
  usr05ResetPassword,
} from "@/api/client";
import type { CreateUserResponse, User } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
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
  TextAreaField,
  TextField,
  Toast,
} from "@/components/ui";
import { useAuth } from "@/lib/auth";

const USERNAME_RULE = /^[a-z0-9._-]{3,32}$/;
const USERNAME_MESSAGE =
  "3–32 characters: a–z, 0–9, dot, underscore or hyphen. Lowercase only.";
const PAGE_SIZE = 20;

function statusLabel(status: User["status"]): string {
  return status === "invited" ? "Invited" : status === "active" ? "Active" : "Disabled";
}

function roleLabel(role: User["role"]): string {
  return role === "owner" ? "Owner" : "Coach";
}

/** LAST_OWNER is a rule, not a code — it is never shown to the owner raw. */
function plainError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "LAST_OWNER") {
      return "This is the only owner account. Add another owner first — the academy must always keep one owner who can sign in.";
    }
    if (err.code === "VALIDATION_ERROR") {
      const fields = err.fieldErrors();
      const first = Object.values(fields)[0];
      return first ?? err.message;
    }
    return `${err.message}${err.requestId ? ` (ref ${err.requestId})` : ""}`;
  }
  return fallback;
}

// --- URL-held filters -------------------------------------------------------

function useUsersFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const role = searchParams.get("role") ?? "";
  const status = searchParams.get("status") ?? "";
  const q = searchParams.get("q") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  // The URL is the single source of truth; each write merges the ONE key it
  // changes into the params as they are right now, so two quick filter changes
  // cannot drop each other (the Step 3 list had to be fixed for exactly this).
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

  return { role, status, q, page, setParam };
}

function UsersScreen() {
  const { me, switchMockRole } = useAuth();
  const queryClient = useQueryClient();
  const { role, status, q, page, setParam } = useUsersFilters();
  const deferredQ = useDeferredValue(q);

  const [toast, setToast] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [invite, setInvite] = useState<CreateUserResponse | null>(null);
  const [editFor, setEditFor] = useState<User | null>(null);
  const [disableFor, setDisableFor] = useState<User | null>(null);
  const [resetFor, setResetFor] = useState<User | null>(null);

  const usersQuery = useQuery({
    queryKey: ["users", { role, status, q: deferredQ, page }],
    queryFn: () =>
      usr01ListUsers({
        role: role === "owner" || role === "coach" ? role : undefined,
        status: status === "invited" || status === "active" || status === "disabled" ? status : undefined,
        q: deferredQ.trim() || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: (previous) => previous,
  });

  const users = usersQuery.data?.data ?? [];
  const meta = usersQuery.data?.meta;
  const filtered = Boolean(role || status || q.trim());

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    [queryClient]
  );

  return (
    <>
      <PageHeader
        title="Users"
        sub="Everyone who can sign in. Owners see money and admin; coaches see only the groups assigned to them."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add user
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <TextField
            id="user-search"
            label="Search"
            placeholder="Name or username"
            value={q}
            onChange={(e) => setParam("q", e.target.value || null)}
          />
          <SelectField
            id="user-role"
            label="Role"
            value={role}
            onChange={(e) => setParam("role", e.target.value || null)}
          >
            <option value="">All roles</option>
            <option value="owner">Owner</option>
            <option value="coach">Coach</option>
          </SelectField>
          <SelectField
            id="user-status"
            label="Status"
            value={status}
            onChange={(e) => setParam("status", e.target.value || null)}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="disabled">Disabled</option>
          </SelectField>
        </div>
      </Card>

      <Card>
        {usersQuery.isLoading ? (
          <ListSkeleton rows={4} />
        ) : usersQuery.isError ? (
          <ErrorState error={usersQuery.error} onRetry={() => usersQuery.refetch()} />
        ) : users.length === 0 ? (
          <EmptyState
            title={filtered ? "No users match these filters" : "No users yet"}
            description={
              filtered
                ? "Try a different name, role or status."
                : "Add the first user to let someone sign in."
            }
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setParam("q", null);
                    setParam("role", null);
                    setParam("status", null);
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add user
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
                  Users{meta ? `, ${meta.total} listed` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[13px] uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">Full name</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Username</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Role</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Last login</th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-3">
                        <span className="font-semibold text-slate-900">{user.fullName}</span>
                        {user.id === me?.user.id ? (
                          <span className="ml-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                            You
                          </span>
                        ) : null}
                        {user.phone ? (
                          <p className="mt-0.5 text-[13px] text-slate-600">{user.phone}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px] text-slate-700">
                        {user.username}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{roleLabel(user.role)}</td>
                      <td className="px-4 py-3">
                        <StatusChip status={statusLabel(user.status)} />
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {user.lastLoginAt ? (
                          <DateText value={user.lastLoginAt} withTime />
                        ) : (
                          <span className="text-slate-500">Never signed in</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditFor(user)}
                            aria-label={`Edit ${user.fullName}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setResetFor(user)}
                            aria-label={`Reset password for ${user.fullName}`}
                          >
                            <KeyRound className="h-4 w-4" aria-hidden="true" />
                            Reset password
                          </Button>
                          {user.status === "disabled" ? (
                            <EnableButton user={user} onDone={invalidate} onToast={setToast} />
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDisableFor(user)}
                              aria-label={`Disable ${user.fullName}`}
                            >
                              <UserMinus className="h-4 w-4" aria-hidden="true" />
                              Disable
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (< 640 px) */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {users.map((user) => (
                <li key={user.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-slate-900">
                        {user.fullName}
                        {user.id === me?.user.id ? (
                          <span className="ml-2 text-[12px] font-semibold text-slate-500">You</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 font-mono text-[13px] text-slate-600">{user.username}</p>
                      <p className="mt-0.5 text-[13px] text-slate-600">
                        {roleLabel(user.role)} ·{" "}
                        {user.lastLoginAt ? (
                          <>
                            last login <DateText value={user.lastLoginAt} withTime />
                          </>
                        ) : (
                          "never signed in"
                        )}
                      </p>
                    </div>
                    <StatusChip status={statusLabel(user.status)} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditFor(user)}>
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setResetFor(user)}>
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      Reset password
                    </Button>
                    {user.status === "disabled" ? (
                      <EnableButton user={user} onDone={invalidate} onToast={setToast} />
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setDisableFor(user)}>
                        <UserMinus className="h-4 w-4" aria-hidden="true" />
                        Disable
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {meta && meta.totalPages > 1 ? (
              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                <p className="text-[13px] text-slate-600">
                  Page {meta.page} of {meta.totalPages} · {meta.total} users
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

      <AddUserDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(result) => {
          setAddOpen(false);
          setInvite(result);
          void invalidate();
        }}
      />

      <InviteDialog invite={invite} onClose={() => setInvite(null)} />

      <EditUserDialog
        key={editFor?.id ?? "no-user"}
        user={editFor}
        onClose={() => setEditFor(null)}
        onSaved={async (user) => {
          setEditFor(null);
          await invalidate();
          setToast(`${user.fullName} was updated.`);
        }}
      />

      <DisableUserDialog
        key={disableFor?.id ?? "no-disable"}
        user={disableFor}
        isSelf={disableFor?.id === me?.user.id}
        onClose={() => setDisableFor(null)}
        onDisabled={async (user) => {
          setDisableFor(null);
          await invalidate();
          setToast(
            user.id === me?.user.id
              ? "Your account was disabled. Switch the mock role to keep working in this demo."
              : `${user.fullName} is disabled and their sessions were revoked.`
          );
          if (user.id === me?.user.id) switchMockRole();
        }}
      />

      <ResetPasswordDialog
        key={resetFor?.id ?? "no-reset"}
        user={resetFor}
        onClose={() => setResetFor(null)}
        onReset={(user, result) => {
          setResetFor(null);
          void invalidate();
          setInvite({
            user,
            inviteUrl: result.inviteUrl,
            inviteExpiresAt: result.inviteExpiresAt,
          });
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </>
  );
}

function EnableButton({
  user,
  onDone,
  onToast,
}: {
  user: User;
  onDone: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    try {
      await usr04EnableUser(user.id);
      await onDone();
      onToast(`${user.fullName} can sign in again.`);
    } catch (err) {
      setError(plainError(err, "Could not enable this user."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        pending={pending}
        onClick={onClick}
        aria-label={`Enable ${user.fullName}`}
      >
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        Enable
      </Button>
      {error ? (
        <p role="alert" className="w-full text-right text-[13px] font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </>
  );
}

function AddUserDialog({
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
  const [role, setRole] = useState<"owner" | "coach">("coach");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setUsername("");
    setFullName("");
    setPhone("");
    setRole("coach");
    setErrors({});
    setFormError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const handle = username.trim().toLowerCase();
    if (!USERNAME_RULE.test(handle)) next.username = USERNAME_MESSAGE;
    if (fullName.trim().length < 2) next.fullName = "Enter their full name";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const result = await usr02CreateUser({
        username: handle,
        fullName: fullName.trim(),
        phone: phone.trim() || undefined,
        role,
      });
      reset();
      onCreated(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        setFormError(plainError(err, "Could not create the user."));
      } else {
        setFormError("Could not create the user. Check your connection and retry.");
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
      title="Add user"
      description="They get a single-use invite link to set their own password. You choose the username."
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
          <Button type="submit" form="add-user-form" pending={pending}>
            {pending ? "Creating…" : "Create invite"}
          </Button>
        </>
      }
    >
      <form id="add-user-form" onSubmit={onSubmit} className="space-y-4">
        {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
        <TextField
          id="new-username"
          label="Username"
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
          hint="This is their sign-in handle. It cannot be edited later — the only remedy is to reset their password, so pick it carefully."
        />
        <TextField
          id="new-full-name"
          label="Full name"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errors.fullName}
        />
        <TextField
          id="new-phone"
          label="Phone"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
          hint="Optional. Used for WhatsApp contact only — never for signing in."
        />
        <SelectField
          id="new-role"
          label="Role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value === "owner" ? "owner" : "coach")}
          hint="Owners see money, settings and admin. Coaches see only their assigned groups."
        >
          <option value="coach">Coach</option>
          <option value="owner">Owner</option>
        </SelectField>
      </form>
    </Modal>
  );
}

function InviteDialog({
  invite,
  onClose,
}: {
  invite: CreateUserResponse | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!invite) return null;

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
    } catch {
      const field = document.getElementById("invite-url") as HTMLInputElement | null;
      field?.select();
      setCopied(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Invite link for ${invite.user.fullName}`}
      description="Send it to them yourself over WhatsApp or SMS. You will not see it again."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
          <Button onClick={copy}>
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
        <DateText value={invite.inviteExpiresAt} withTime />. If it is lost, use{" "}
        <strong>Reset password</strong> — a new link is issued and the old one stops working.
      </InlineAlert>
      <div className="mt-4 space-y-4">
        <TextField
          id="invite-username"
          label="Username"
          readOnly
          value={invite.user.username}
          onFocus={(e) => e.currentTarget.select()}
          hint="Tell them this too — it is what they sign in with. It cannot be changed afterwards."
        />
        <TextField
          id="invite-url"
          label="Invite link"
          readOnly
          value={invite.inviteUrl}
          onFocus={(e) => e.currentTarget.select()}
          hint="Select the text and copy it manually if the button does not work."
        />
      </div>
    </Modal>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User | null;
  onClose: () => void;
  onSaved: (user: User) => Promise<void>;
}) {
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [role, setRole] = useState<"owner" | "coach">(user?.role ?? "coach");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!user) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    const next: Record<string, string> = {};
    if (fullName.trim().length < 2) next.fullName = "Enter their full name";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const updated = await usr03PatchUser(user.id, {
        fullName: fullName.trim(),
        phone: phone.trim() || undefined,
        role,
      });
      await onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        setFormError(plainError(err, "Could not save the changes."));
      } else {
        setFormError("Could not save the changes. Check your connection and retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.fullName}`}
      description="The username cannot be changed — it is the sign-in handle."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-user-form" pending={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={onSubmit} className="space-y-4">
        {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
        <TextField id="edit-username" label="Username" readOnly value={user.username} />
        <TextField
          id="edit-full-name"
          label="Full name"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errors.fullName}
        />
        <TextField
          id="edit-phone"
          label="Phone"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
          hint="Optional. Contact only."
        />
        <SelectField
          id="edit-role"
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value === "owner" ? "owner" : "coach")}
          error={errors.role}
          hint="Changing a coach to an owner gives them access to money and settings."
        >
          <option value="coach">Coach</option>
          <option value="owner">Owner</option>
        </SelectField>
      </form>
    </Modal>
  );
}

function DisableUserDialog({
  user,
  isSelf,
  onClose,
  onDisabled,
}: {
  user: User | null;
  isSelf: boolean;
  onClose: () => void;
  onDisabled: (user: User) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!user) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setPending(true);
    setError(null);
    try {
      const updated = await usr04DisableUser(user.id, { reason: reason.trim() || undefined });
      await onDisabled(updated);
    } catch (err) {
      setError(plainError(err, "Could not disable this user."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Disable ${user.fullName}?`}
      description="They keep all their history — only the ability to sign in is removed."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="disable-user-form" variant="danger" pending={pending}>
            {pending ? "Disabling…" : "Disable user"}
          </Button>
        </>
      }
    >
      <form id="disable-user-form" onSubmit={onSubmit} className="space-y-4">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <InlineAlert tone="warning" title="What this does">
          {user.fullName} is signed out everywhere and cannot sign in again until you enable them.
          Their attendance, sessions and assignments are not deleted. Disabling the only remaining
          owner is refused.
        </InlineAlert>
        {isSelf ? (
          <InlineAlert tone="danger" title="This is your own account">
            You are signed in as {user.username}. Disabling it ends this session.
          </InlineAlert>
        ) : null}
        <TextAreaField
          id="disable-reason"
          label="Reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Optional, but it is written to the audit log for whoever looks later."
        />
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onReset,
}: {
  user: User | null;
  onClose: () => void;
  onReset: (user: User, result: { inviteUrl: string; inviteExpiresAt: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!user) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setPending(true);
    setError(null);
    try {
      const result = await usr05ResetPassword(user.id);
      onReset(user, result);
    } catch (err) {
      setError(plainError(err, "Could not reset the password."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset the password for ${user.fullName}?`}
      description="A new single-use invite link is issued and every active session of theirs is revoked."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="reset-password-form" pending={pending}>
            {pending ? "Resetting…" : "Reset password"}
          </Button>
        </>
      }
    >
      <form id="reset-password-form" onSubmit={onSubmit} className="space-y-4">
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        <InlineAlert tone="info" title="The old link stops working">
          {user.username} is signed out of every device. The new invite link is shown once, right
          after this — copy it then.
        </InlineAlert>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/users">
        <Suspense fallback={<ListSkeleton rows={4} />}>
          <UsersScreen />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
