"use client";

// Register player (PLY-02) — PAGE_SPECIFICATIONS §3, ROUTES_AND_NAVIGATION §1.
// Owner-only. Uses PLY-08 (advisory duplicate check), GRP-05 (age-group
// suggestion from the date of birth) and GDN-01 (reuse a sibling's guardian).
// Nothing is auto-assigned: the suggestion is a chip the owner must confirm, and
// the server decides duplicates — a 409 DUPLICATE_SUSPECTED opens a dialog with
// "Open existing" / "Register anyway" (which sets acknowledgeDuplicates).
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, UserPlus } from "lucide-react";
import { z } from "zod";
import {
  ApiError,
  gdn01ListGuardians,
  grp01ListAgeGroups,
  grp05SuggestAgeGroup,
  ply02CreatePlayer,
  ply08CheckDuplicates,
} from "@/api/client";
import type { DuplicateMatch, PlayerCreate } from "@/api/types";
import { RequireAuth, RequirePermission } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import {
  BackLink,
  Button,
  Card,
  InlineAlert,
  Modal,
  SectionTitle,
  SelectField,
  TextAreaField,
  TextField,
  Toggle,
} from "@/components/ui";
import { addDaysISO, ageOn, todayISO } from "@/lib/dates";
import { normalizeLkPhone } from "@/lib/phone";

const CONSENT_SOURCES = [
  { value: "registration_form", label: "Registration form" },
  { value: "verbal", label: "Verbal" },
  { value: "owner_entry", label: "Owner entry" },
] as const;

interface GuardianDraft {
  key: string;
  /** set when an existing guardian record is reused (GDN-01/GDN-03). */
  linkedGuardianId?: string;
  linkedLabel?: string;
  fullName: string;
  phone: string;
  relationship: string;
  consent: "unknown" | "granted";
  consentSource: string;
  receivesInvoices: boolean;
}

function emptyGuardian(key: string): GuardianDraft {
  return {
    key,
    fullName: "",
    phone: "",
    relationship: "",
    consent: "unknown",
    consentSource: "registration_form",
    receivesInvoices: true,
  };
}

// Zod: the register form is the only multi-field contract form in this slice
// (FRONTEND_PLAN §1 chose Zod for form validation). Server `details[].field`
// always overrides these messages for display.
const registerSchema = z.object({
  fullName: z.string().trim().min(2, "Use 2–120 characters").max(120, "Use 2–120 characters"),
  registrationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a registration date"),
  notes: z.string().max(1000, "Keep notes under 1000 characters").optional(),
  coachNotes: z.string().max(500, "Keep coach notes under 500 characters").optional(),
});

export default function NewPlayerPage() {
  return (
    <RequireAuth>
      <RequirePermission permission="players:manage">
        <RegisterPlayerForm />
      </RequirePermission>
    </RequireAuth>
  );
}

function RegisterPlayerForm() {
  const router = useRouter();
  const today = todayISO();

  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [registrationDate, setRegistrationDate] = useState(today);
  const [ageGroupId, setAgeGroupId] = useState("");
  const [guardians, setGuardians] = useState<GuardianDraft[]>([emptyGuardian("g1")]);
  const [notes, setNotes] = useState("");
  const [coachNotes, setCoachNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Two separate states on purpose: PLY-08 on blur is ADVISORY (an inline note,
  // never a dialog — the owner is still typing), while the dialog belongs to a
  // 409 DUPLICATE_SUSPECTED from PLY-02, where the server refused the write.
  const [advisoryMatches, setAdvisoryMatches] = useState<DuplicateMatch[] | null>(null);
  const [dialogMatches, setDialogMatches] = useState<DuplicateMatch[] | null>(null);
  const [duplicateChecked, setDuplicateChecked] = useState(false);

  const groupsQuery = useQuery({
    queryKey: ["age-groups", { includeArchived: false }],
    queryFn: () => grp01ListAgeGroups({ includeArchived: false }),
  });

  const suggestionQuery = useQuery({
    queryKey: ["age-group-suggest", dateOfBirth],
    queryFn: () => grp05SuggestAgeGroup(dateOfBirth),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth),
  });

  const age = /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) ? ageOn(dateOfBirth, today) : null;
  const ageWarning = age !== null && (age < 3 || age > 25);
  // GRP-05 suggestion (advisory; the owner still confirms).
  const suggestionData = suggestionQuery.data;

  const checkDuplicates = useCallback(async () => {
    if (fullName.trim().length < 2) return;
    setDuplicateChecked(true);
    try {
      const result = await ply08CheckDuplicates({
        fullName: fullName.trim(),
        dateOfBirth: dateOfBirth || undefined,
        guardianPhones: guardians.map((g) => g.phone).filter(Boolean),
      });
      setAdvisoryMatches(result.matches.length ? result.matches : null);
    } catch {
      // Advisory only: a failed check never blocks registration.
      setAdvisoryMatches(null);
    }
  }, [fullName, dateOfBirth, guardians]);

  const updateGuardian = (key: string, patch: Partial<GuardianDraft>) => {
    setGuardians((current) => current.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  };

  function buildPayload(acknowledgeDuplicates: boolean): PlayerCreate | null {
    const parsed = registerSchema.safeParse({
      fullName,
      registrationDate,
      notes: notes || undefined,
      coachNotes: coachNotes || undefined,
    });
    const nextErrors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        nextErrors[String(issue.path[0])] = issue.message;
      }
    }
    if (dateOfBirth && dateOfBirth > today) {
      nextErrors.dateOfBirth = "The date of birth cannot be in the future";
    }
    if (registrationDate > addDaysISO(today, 30)) {
      nextErrors.registrationDate = "The registration date cannot be more than 30 days ahead";
    }
    guardians.forEach((guardian, index) => {
      if (guardian.linkedGuardianId) return;
      if (guardian.fullName.trim().length < 2) {
        nextErrors[`guardians.${index}.fullName`] = "Guardian name is required";
      }
      if (!normalizeLkPhone(guardian.phone)) {
        nextErrors[`guardians.${index}.phone`] = "Enter a valid Sri Lankan phone number";
      }
    });
    const cleaned = Object.fromEntries(Object.entries(nextErrors).filter(([, v]) => v));
    setErrors(cleaned);
    if (Object.keys(cleaned).length > 0) return null;

    return {
      fullName: fullName.trim(),
      dateOfBirth: dateOfBirth || undefined,
      registrationDate,
      ageGroupId: ageGroupId || undefined,
      notes: notes || undefined,
      coachNotes: coachNotes || undefined,
      guardians: guardians.map((guardian, index) => {
        const base = {
          isPrimary: index === 0,
          receivesInvoices: guardian.receivesInvoices,
        };
        if (guardian.linkedGuardianId) {
          return { guardianId: guardian.linkedGuardianId, ...base };
        }
        return {
          fullName: guardian.fullName.trim(),
          phone: normalizeLkPhone(guardian.phone) ?? guardian.phone,
          relationship: guardian.relationship || undefined,
          whatsappConsent:
            guardian.consent === "granted"
              ? { status: "granted" as const, source: guardian.consentSource }
              : undefined,
          ...base,
        };
      }),
      acknowledgeDuplicates,
    };
  }

  async function submit(acknowledgeDuplicates: boolean) {
    const payload = buildPayload(acknowledgeDuplicates);
    if (!payload) return;
    setPending(true);
    setFormError(null);
    try {
      const created = await ply02CreatePlayer(payload);
      router.push(`/players/${created.id}?created=1`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "DUPLICATE_SUSPECTED" && !acknowledgeDuplicates) {
        const matches = await ply08CheckDuplicates({
          fullName: payload.fullName,
          dateOfBirth: payload.dateOfBirth,
          guardianPhones: guardians.map((g) => g.phone).filter(Boolean),
        }).catch(() => ({ matches: [] }));
        setDialogMatches(
          matches.matches.length
            ? matches.matches
            : ([
                {
                  player: {
                    id: "",
                    registrationNo: "",
                    fullName: "An existing player",
                    registrationDate: today,
                    status: "active",
                    statusEffectiveDate: today,
                    guardians: [],
                    billingAnchorDate: today,
                    version: 1,
                  },
                  reason: "The server flagged a possible duplicate",
                  score: 1,
                },
              ] as DuplicateMatch[])
        );
        return;
      }
      if (err instanceof ApiError) {
        const fields = err.fieldErrors();
        setErrors((current) => ({ ...current, ...fields }));
        setFormError(
          err.requestId
            ? `${err.message} (reference ${err.requestId})`
            : err.message
        );
      } else {
        setFormError("Can't reach the server. Nothing was saved twice — retry.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <BackLink href="/players">Players</BackLink>
      <PageHeader
        title="Register player"
        sub={`Registering today (${today}). Duplicate and age checks are advisory — the academy's records stay under your control.`}
      />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        {formError ? (
          <InlineAlert tone="danger" title="Could not register this player">
            {formError}
          </InlineAlert>
        ) : null}

        <Card>
          <SectionTitle>Player</SectionTitle>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <TextField
              id="fullName"
              label="Full name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={() => void checkDuplicates()}
              error={errors.fullName}
              autoComplete="off"
              hint="2–120 characters, exactly as the academy records it."
            />
            <TextField
              id="dateOfBirth"
              label="Date of birth"
              type="date"
              max={today}
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
              onBlur={() => void checkDuplicates()}
              error={errors.dateOfBirth || undefined}
              hint={age === null ? "Optional — you can assign a group later." : `Age today: ${age}.`}
            />
            <TextField
              id="registrationDate"
              label="Registration date"
              type="date"
              required
              value={registrationDate}
              onChange={(e) => setRegistrationDate(e.target.value)}
              error={errors.registrationDate}
              hint="Used as the billing anchor until the first invoice is issued."
            />
            <SelectField
              id="ageGroupId"
              label="Age group"
              value={ageGroupId}
              onChange={(e) => setAgeGroupId(e.target.value)}
              hint="Assigning later is allowed — the player appears as “Assignment pending”."
            >
              <option value="">Assign later</option>
              {(groupsQuery.data?.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </SelectField>

            <div className="sm:col-span-2 space-y-2">
              {suggestionData && suggestionData.suggestions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2" role="status">
                  {suggestionData?.suggestions.map((suggestion) => (
                    <button
                      key={suggestion.ageGroupId}
                      type="button"
                      onClick={() => setAgeGroupId(suggestion.ageGroupId)}
                      className="touch44 cursor-pointer rounded-full border border-pitch-600 bg-pitch-50 px-3 py-1 text-[13px] font-semibold text-pitch-700"
                    >
                      Suggested: {suggestion.name} (age {suggestionData?.ageOnReference} on{" "}
                      {suggestionData?.referenceDate}) — Use this
                    </button>
                  ))}
                  <p className="text-[13px] text-slate-600">
                    Suggestion only — nothing is assigned until you save.
                  </p>
                </div>
              ) : null}
              {ageWarning ? (
                <InlineAlert tone="warning">
                  An age of {age} is outside the usual 3–25 range. You can still register the
                  player.
                </InlineAlert>
              ) : null}
              {duplicateChecked && advisoryMatches ? (
                <InlineAlert tone="warning" title="Possible duplicate">
                  {advisoryMatches.length} existing{" "}
                  {advisoryMatches.length === 1 ? "player looks" : "players look"} similar to this
                  one: {advisoryMatches.map((match) => match.player.fullName).join(", ")}. This is
                  advisory — registering anyway is allowed.
                </InlineAlert>
              ) : null}
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle
            right={
              guardians.length < 2 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setGuardians((c) => [...c, emptyGuardian(`g${c.length + 1}`)])}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add guardian
                </Button>
              ) : undefined
            }
          >
            Guardians
          </SectionTitle>
          <div className="space-y-5 p-4">
            <p className="text-[13px] text-slate-600">
              A player needs at least one guardian. The first guardian is the primary contact and
              receives invoices by default.
            </p>
            {guardians.map((guardian, index) => (
              <GuardianBlock
                key={guardian.key}
                index={index}
                draft={guardian}
                errors={errors}
                canRemove={guardians.length > 1}
                onChange={(patch) => updateGuardian(guardian.key, patch)}
                onRemove={() =>
                  setGuardians((current) => current.filter((g) => g.key !== guardian.key))
                }
              />
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle>Notes</SectionTitle>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <TextAreaField
              id="notes"
              label="Notes (owner only)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              error={errors.notes}
              hint={`${notes.length}/1000 — never shown to coaches.`}
            />
            <TextAreaField
              id="coachNotes"
              label="Coach notes"
              value={coachNotes}
              onChange={(e) => setCoachNotes(e.target.value)}
              maxLength={500}
              error={errors.coachNotes}
              hint={`${coachNotes.length}/500 — visible to the coaches assigned to the group.`}
            />
          </div>
        </Card>

        {Object.keys(errors).length > 0 ? (
          <InlineAlert tone="danger" title="Please correct the highlighted fields">
            <ul className="ml-4 list-disc">
              {Object.entries(errors).map(([field, message]) => (
                <li key={field}>{message}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}

        <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:flex-row sm:justify-end">
          <Link
            href="/players"
            className="touch44 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 px-4 font-semibold text-slate-800"
          >
            Cancel
          </Link>
          <Button type="submit" pending={pending}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {pending ? "Saving…" : "Register player"}
          </Button>
        </div>
      </form>

      <Modal
        open={dialogMatches !== null}
        onClose={() => setDialogMatches(null)}
        title="Possible duplicate"
        description="PLY-08 is advisory: it flags likely matches so you can decide. Nothing is blocked."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDialogMatches(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDialogMatches(null);
                void submit(true);
              }}
            >
              Register anyway
            </Button>
          </>
        }
      >
        <ul className="space-y-2">
          {(dialogMatches ?? []).map((match) => (
            <li
              key={match.player.id || match.player.fullName}
              className="rounded-xl border border-slate-200 p-3"
            >
              <p className="text-[15px] font-semibold text-slate-900">{match.player.fullName}</p>
              <p className="text-[13px] text-slate-600">
                {match.reason} · confidence {Math.round(match.score * 100)}%
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-700">
                  {match.player.registrationNo || "—"}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-700">
                  {match.player.status}
                </span>
                {"currentGroup" in match.player ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[12px] font-semibold text-slate-700">
                    {match.player.currentGroup?.name ?? "Assignment pending"}
                  </span>
                ) : null}
              </div>
              {match.player.id ? (
                <Link
                  href={`/players/${match.player.id}`}
                  className="mt-2 inline-block text-[13px] font-semibold text-pitch-700 underline underline-offset-2"
                >
                  Open existing player
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}

function GuardianBlock({
  index,
  draft,
  errors,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  draft: GuardianDraft;
  errors: Record<string, string>;
  canRemove: boolean;
  onChange: (patch: Partial<GuardianDraft>) => void;
  onRemove: () => void;
}) {
  const [search, setSearch] = useState("");
  const searchQuery = useQuery({
    queryKey: ["guardians", { q: search }],
    queryFn: () => gdn01ListGuardians({ q: search }),
    enabled: search.trim().length >= 2 && !draft.linkedGuardianId,
  });

  const phonePreview = useMemo(() => normalizeLkPhone(draft.phone), [draft.phone]);

  return (
    <fieldset className="rounded-xl border border-slate-200 p-3">
      <legend className="px-1 text-[14px] font-semibold text-slate-800">
        Guardian {index + 1}
        {index === 0 ? " (primary)" : " (optional)"}
      </legend>

      {draft.linkedGuardianId ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
          <p className="text-[14px]">
            <span className="font-semibold">{draft.linkedLabel}</span> — linked from an existing
            player record.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              onChange({ linkedGuardianId: undefined, linkedLabel: undefined, fullName: "", phone: "" })
            }
          >
            Unlink
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              id={`guardian-${index}-name`}
              label="Name"
              required={index === 0}
              value={draft.fullName}
              onChange={(e) => onChange({ fullName: e.target.value })}
              error={errors[`guardians.${index}.fullName`]}
            />
            <TextField
              id={`guardian-${index}-phone`}
              label="Phone (WhatsApp)"
              required={index === 0}
              inputMode="tel"
              value={draft.phone}
              onChange={(e) => onChange({ phone: e.target.value })}
              error={errors[`guardians.${index}.phone`]}
              hint={phonePreview ? `Saved as ${phonePreview}` : "Sri Lankan number, e.g. 077 000 0001"}
            />
            <TextField
              id={`guardian-${index}-relationship`}
              label="Relationship"
              value={draft.relationship}
              onChange={(e) => onChange({ relationship: e.target.value })}
              hint="Optional — for example Mother."
            />
            <SelectField
              id={`guardian-${index}-consent`}
              label="WhatsApp consent"
              value={draft.consent}
              onChange={(e) => onChange({ consent: e.target.value as "unknown" | "granted" })}
              hint="Only “granted” allows automated WhatsApp messages."
            >
              <option value="unknown">Unknown — no automation</option>
              <option value="granted">Granted</option>
            </SelectField>
            {draft.consent === "granted" ? (
              <SelectField
                id={`guardian-${index}-source`}
                label="Consent recorded from"
                value={draft.consentSource}
                onChange={(e) => onChange({ consentSource: e.target.value })}
              >
                {CONSENT_SOURCES.map((source) => (
                  <option key={source.value} value={source.value}>
                    {source.label}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>

          <div className="mt-3 space-y-3">
            <TextField
              id={`guardian-${index}-search`}
              label="Reuse an existing guardian"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone"
              hint="For siblings: link the guardian you already recorded instead of retyping."
            />
            {searchQuery.data && searchQuery.data.data.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {searchQuery.data.data.slice(0, 5).map((guardian) => (
                  <li key={guardian.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-slate-900">{guardian.fullName}</p>
                      <p className="text-[13px] text-slate-600">
                        {guardian.phone}
                        {guardian.players.length
                          ? ` · guardian of ${guardian.players.map((p) => p.fullName).join(", ")}`
                          : ""}
                        {guardian.whatsappConsent === "revoked" ? " · opted out" : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        onChange({
                          linkedGuardianId: guardian.id,
                          linkedLabel: `${guardian.fullName} · ${guardian.phone}`,
                          fullName: guardian.fullName,
                          phone: guardian.phone,
                        });
                        setSearch("");
                      }}
                    >
                      Use this guardian
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="mt-3">
            <Toggle
              id={`guardian-${index}-invoices`}
              label="Receives invoices"
              hint="The guardians marked here are the ones offered when an invoice is sent."
              checked={draft.receivesInvoices}
              onChange={(next) => onChange({ receivesInvoices: next })}
            />
          </div>
        </>
      )}

      {canRemove ? (
        <div className="mt-3">
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Remove this guardian
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
