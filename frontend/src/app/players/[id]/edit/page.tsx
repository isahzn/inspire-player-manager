"use client";

// Edit player (PLY-04) — PAGE_SPECIFICATIONS §3 + §0 form rules.
// Owner-only. The record's `version` is echoed on save; a 409 VERSION_CONFLICT
// opens a "someone else changed this" dialog that offers a reload instead of
// silently overwriting. The billing anchor is editable only before the first
// invoice (the server refuses it afterwards, and the field says so up front).
//
// The form is a child keyed by `id + version`: it mounts with the loaded record
// as its initial state, so there is no copy-from-props effect and a reload after
// a conflict gets a genuinely fresh form.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, ply03GetPlayer, ply04PatchPlayer } from "@/api/client";
import { isOwnerPlayer, type Player } from "@/api/types";
import { AuthLoading, RequireAuth, RequirePermission } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  BackLink,
  Button,
  Card,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  Modal,
  SectionTitle,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { todayISO } from "@/lib/dates";

export default function EditPlayerPage() {
  return (
    <RequireAuth>
      <RequirePermission permission="players:manage">
        <Suspense fallback={<AuthLoading />}>
          <EditPlayerScreen />
        </Suspense>
      </RequirePermission>
    </RequireAuth>
  );
}

function EditPlayerScreen() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const playerQuery = useQuery({
    queryKey: ["player", id],
    queryFn: () => ply03GetPlayer(id),
    enabled: Boolean(id),
  });

  const player =
    playerQuery.data && isOwnerPlayer(playerQuery.data) ? playerQuery.data : null;

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

  return (
    <EditPlayerForm
      key={`${player.id}-${player.version}`}
      player={player}
      onReload={async () => {
        await playerQuery.refetch();
      }}
    />
  );
}

function EditPlayerForm({ player, onReload }: { player: Player; onReload: () => Promise<void> }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState(player.fullName);
  const [dateOfBirth, setDateOfBirth] = useState(player.dateOfBirth ?? "");
  const [registrationDate, setRegistrationDate] = useState(player.registrationDate);
  const [billingAnchorDate, setBillingAnchorDate] = useState(player.billingAnchorDate);
  const [notes, setNotes] = useState(player.notes ?? "");
  const [coachNotes, setCoachNotes] = useState(player.coachNotes ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);

  async function save() {
    const next: Record<string, string> = {};
    if (fullName.trim().length < 2 || fullName.trim().length > 120) {
      next.fullName = "Use 2–120 characters";
    }
    if (dateOfBirth && dateOfBirth > todayISO()) {
      next.dateOfBirth = "The date of birth cannot be in the future";
    }
    if (notes.length > 1000) next.notes = "Keep notes under 1000 characters";
    if (coachNotes.length > 500) next.coachNotes = "Keep coach notes under 500 characters";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setPending(true);
    setFormError(null);
    try {
      await ply04PatchPlayer(player.id, {
        fullName: fullName.trim(),
        dateOfBirth: dateOfBirth || undefined,
        registrationDate,
        billingAnchorDate,
        notes,
        coachNotes,
        version: player.version,
      });
      await queryClient.invalidateQueries({ queryKey: ["player", player.id] });
      await queryClient.invalidateQueries({ queryKey: ["players"] });
      router.push(`/players/${player.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setConflict(true);
      } else if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        setFormError(err.requestId ? `${err.message} (reference ${err.requestId})` : err.message);
      } else {
        setFormError("Can't reach the server. Nothing was saved twice — retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <BackLink href={`/players/${player.id}`}>{player.fullName}</BackLink>
      <PageHeader
        title="Edit player"
        sub={`${player.registrationNo} · record version ${player.version}`}
      />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {formError ? (
          <InlineAlert tone="danger" title="Could not save">
            {formError}
          </InlineAlert>
        ) : null}

        <Card>
          <SectionTitle>Details</SectionTitle>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <TextField
              id="edit-fullName"
              label="Full name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              error={errors.fullName}
            />
            <TextField
              id="edit-dateOfBirth"
              label="Date of birth"
              type="date"
              max={todayISO()}
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              error={errors.dateOfBirth}
            />
            <TextField
              id="edit-registrationDate"
              label="Registration date"
              type="date"
              value={registrationDate}
              onChange={(e) => setRegistrationDate(e.target.value)}
            />
            <TextField
              id="edit-billingAnchor"
              label="Billing anchor date"
              type="date"
              value={billingAnchorDate}
              onChange={(e) => setBillingAnchorDate(e.target.value)}
              hint="Editable only before the first invoice is issued."
            />
          </div>
        </Card>

        <Card>
          <SectionTitle>Notes</SectionTitle>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <TextAreaField
              id="edit-notes"
              label="Notes (owner only)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              error={errors.notes}
              hint={`${notes.length}/1000 — never shown to coaches.`}
            />
            <TextAreaField
              id="edit-coachNotes"
              label="Coach notes"
              value={coachNotes}
              onChange={(e) => setCoachNotes(e.target.value)}
              maxLength={500}
              error={errors.coachNotes}
              hint={`${coachNotes.length}/500 — visible to the group's coaches.`}
            />
          </div>
        </Card>

        <InlineAlert tone="info">
          Changing the group and the status is done from the player profile, so each change records
          its own effective date and reason.
        </InlineAlert>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link
            href={`/players/${player.id}`}
            className="touch44 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 px-4 font-semibold text-slate-800"
          >
            Cancel
          </Link>
          <Button type="submit" pending={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      <Modal
        open={conflict}
        onClose={() => setConflict(false)}
        title="Someone else changed this record"
        description="Your edits were not saved, so nothing was overwritten. Reload the current record and reapply your changes."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConflict(false)}>
              Keep editing
            </Button>
            <Button
              onClick={async () => {
                setConflict(false);
                await onReload();
              }}
            >
              Reload current record
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-slate-700">
          Record version on screen: <span className="font-mono">{player.version}</span>. The server
          rejected the save because the record has moved on since it was loaded.
        </p>
      </Modal>
    </>
  );
}
