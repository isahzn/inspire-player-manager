"use client";

// INV-03 manual one-off invoice (PAGE_SPECIFICATIONS §7: "Manual invoice:
// player picker, description, amount, due date (≥ issue date), guardian").
//
// A manual invoice is `kind=manual` and, like every issued invoice, an
// immutable snapshot: there is no draft state ([ADR-006]) — the row exists from
// the moment this form succeeds, numbers are never reused, and a mistake is
// corrected by voiding or by a negative adjustment, never by editing.
//
// The amount goes through the strict money parser (integer minor units, no
// floats) and honours the academy's whole-rupee setting from SET-02.
import { Suspense, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, idempotencyKey, inv03CreateInvoice, ply01ListPlayers, set02GetBillingSettings } from "@/api/client";
import { isOwnerPlayer, type PlayerListItem } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  BackLink,
  Button,
  Card,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  SelectField,
  SectionTitle,
  TextAreaField,
  TextField,
  buttonClass,
} from "@/components/ui";
import { addDaysISO, todayISO } from "@/lib/dates";
import { formatMoneyMinor, parseMoneyInput } from "@/lib/money";

function ManualInvoiceForm() {
  const router = useRouter();
  const [playerId, setPlayerId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(addDaysISO(todayISO(), 7));
  const [guardianId, setGuardianId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string | null>(null);

  // One key for this form: a retry after a network failure reuses it, so a
  // second click can never create a second invoice (API_INTEGRATION §4).
  const keyRef = useRef(idempotencyKey());

  const playersQuery = useQuery({
    queryKey: ["players", { status: "active", pageSize: 100, sort: "fullName", purpose: "invoice-picker" }],
    queryFn: () =>
      ply01ListPlayers({ status: "active", pageSize: 100, sort: "fullName", page: 1 }),
  });

  const settingsQuery = useQuery({
    queryKey: ["settings", "billing"],
    queryFn: set02GetBillingSettings,
    staleTime: 5 * 60_000,
  });

  const allowFractional = settingsQuery.data?.allowFractionalMoney ?? true;

  const players: PlayerListItem[] = playersQuery.data?.data ?? [];
  const selected = players.find((player) => player.id === playerId);
  const guardians =
    selected && isOwnerPlayer(selected)
      ? selected.guardians.map((link) => ({
          id: link.guardian.id,
          fullName: link.guardian.fullName,
          isPrimary: link.isPrimary,
        }))
      : [];

  const parsed = useMemo(
    () => parseMoneyInput(amount, { allowFractional }),
    [amount, allowFractional]
  );
  const parsedMinor = "minor" in parsed ? parsed.minor : null;

  const mutation = useMutation({
    mutationFn: (input: {
      playerId: string;
      description: string;
      amountMinor: number;
      dueDate: string;
      guardianId?: string;
    }) => inv03CreateInvoice(input, keyRef.current),
    onSuccess: (invoice) => {
      router.push(`/billing/invoices/${invoice.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors();
        if (Object.keys(fields).length) {
          setErrors(fields);
          return;
        }
        setAlert(error.message);
        return;
      }
      setAlert("Could not create the invoice. Please retry.");
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!playerId) next.playerId = "Choose a player";
    const text = description.trim();
    if (text.length < 3) next.description = "Describe what is being charged (3–120 characters)";
    else if (text.length > 120) next.description = "Keep the description under 120 characters";
    if (!parsedMinor) {
      next.amountMinor = "error" in parsed ? parsed.error : "Enter an amount";
    }
    if (!dueDate) next.dueDate = "Choose a due date";
    else if (dueDate < todayISO()) next.dueDate = "The due date cannot be before today";
    setErrors(next);
    if (Object.keys(next).length || !parsedMinor) return;
    setAlert(null);
    mutation.mutate({
      playerId,
      description: text,
      amountMinor: parsedMinor,
      dueDate,
      guardianId: guardianId || undefined,
    });
  }

  return (
    <>
      <BackLink href="/billing">Billing</BackLink>
      <PageHeader
        title="Manual invoice"
        sub="A one-off charge that is not part of a period run — a kit fee, a trip, an extra session."
      />

      {playersQuery.isError ? (
        <Card>
          <ErrorState error={playersQuery.error} onRetry={() => playersQuery.refetch()} />
        </Card>
      ) : (
        <form onSubmit={submit}>
          <Card>
            <SectionTitle>Invoice</SectionTitle>
            <div className="space-y-4 p-4">
              {alert ? (
                <InlineAlert tone="danger" title="Could not create the invoice">
                  {alert}
                </InlineAlert>
              ) : null}

              {playersQuery.isLoading ? (
                <ListSkeleton rows={3} />
              ) : players.length === 0 ? (
                <InlineAlert tone="warning" title="No active players">
                  There is nobody to invoice yet.{" "}
                  <Link href="/players/new" className="font-semibold underline underline-offset-2">
                    Register a player
                  </Link>{" "}
                  first.
                </InlineAlert>
              ) : (
                <SelectField
                  id="manual-player"
                  label="Player"
                  required
                  error={errors.playerId}
                  value={playerId}
                  onChange={(event) => {
                    setPlayerId(event.target.value);
                    setGuardianId("");
                  }}
                >
                  <option value="">Choose a player…</option>
                  {players.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.fullName} · {player.registrationNo}
                    </option>
                  ))}
                </SelectField>
              )}

              <TextAreaField
                id="manual-description"
                label="Description"
                required
                rows={2}
                value={description}
                error={errors.description}
                hint="Shown on the invoice and the PDF, e.g. “Kit fee — Under-11”."
                onChange={(event) => setDescription(event.target.value)}
              />

              <div>
                <TextField
                  id="manual-amount"
                  label="Amount (LKR)"
                  required
                  inputMode="decimal"
                  placeholder="4000"
                  value={amount}
                  error={errors.amountMinor}
                  hint={
                    allowFractional
                      ? "Rupees, optionally with 2 decimals. Invoiced, collected and outstanding are always separate figures."
                      : "Whole rupees only — this academy records amounts without cents."
                  }
                  onChange={(event) => setAmount(event.target.value)}
                />
                <p className="mt-1 text-[13px] text-slate-600">
                  Stored as minor units:{" "}
                  <strong>
                    {parsedMinor !== null ? formatMoneyMinor(parsedMinor, { full: true }) : "—"}
                  </strong>
                  {parsedMinor !== null ? (
                    <span className="text-slate-500"> ({parsedMinor} minor)</span>
                  ) : null}
                  {amount && parsedMinor === null && "error" in parsed && !errors.amountMinor ? (
                    <span className="ml-1 font-medium text-red-700">{parsed.error}</span>
                  ) : null}
                </p>
              </div>

              <TextField
                id="manual-due"
                label="Due date"
                required
                type="date"
                value={dueDate}
                error={errors.dueDate}
                hint="Never before the issue date. The issue date is today."
                onChange={(event) => setDueDate(event.target.value)}
              />

              {guardians.length > 0 ? (
                <SelectField
                  id="manual-guardian"
                  label="Guardian billed"
                  value={guardianId}
                  hint="Optional. The guardian who receives the invoice when it is sent."
                  onChange={(event) => setGuardianId(event.target.value)}
                >
                  <option value="">Not recorded</option>
                  {guardians.map((guardian) => (
                    <option key={guardian.id} value={guardian.id}>
                      {guardian.fullName}
                      {guardian.isPrimary ? " (primary)" : ""}
                    </option>
                  ))}
                </SelectField>
              ) : null}
            </div>
          </Card>

          <div className="mt-4">
            <InlineAlert tone="info" title="Issued immediately">
              An invoice has no draft state: as soon as this is saved it exists with a real number
              (numbers are never reused), and it can only be corrected by voiding it or by adding a
              negative adjustment. Nothing is sent to the guardian here — use{" "}
              <em>Send via WhatsApp</em> on the invoice afterwards.
            </InlineAlert>
          </div>

          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Link href="/billing" className={buttonClass("secondary")}>
              Cancel
            </Link>
            <Button type="submit" pending={mutation.isPending} disabled={players.length === 0}>
              Create invoice
            </Button>
          </div>

          {parsedMinor !== null && amount ? (
            <p className="mt-3 text-right text-[13px] text-slate-600">
              Creating one manual invoice for{" "}
              <strong>{formatMoneyMinor(parsedMinor, { full: true })}</strong> — it is not part of a
              period run, so it never affects the group&rsquo;s fee schedule.
            </p>
          ) : null}
        </form>
      )}
    </>
  );
}

export default function NewManualInvoicePage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/billing">
        <Suspense fallback={<ListSkeleton rows={4} />}>
          <ManualInvoiceForm />
        </Suspense>
      </RequirePermissions>
    </RequireAuth>
  );
}
