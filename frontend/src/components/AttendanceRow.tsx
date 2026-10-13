"use client";

// AttendanceRow + SegmentedControl (DESIGN_SYSTEM §6, PAGE_SPECIFICATIONS §5).
// Mobile-critical: rows are ≥ 56 px, every P/L/A/E target is ≥ 48 × 48 px with
// 8 px gaps, the control is a real `radiogroup` (one tab stop, arrow keys move
// and select, Space/Enter select), and the accessible name spells the status out
// ("Present (P) for Amara Perera") instead of leaving a bare letter.
import { useRef } from "react";
import { Check, MessageSquarePlus } from "lucide-react";
import type { AttendanceStatus } from "@/api/types";
import { formatInstant } from "@/lib/dates";

/** Radiogroup tab stop: the selected choice, or the first when nothing is picked. */
function isTabStop(disabled: boolean | undefined, selectedIndex: number, index: number, selected: boolean): boolean {
  if (disabled) return false;
  if (selectedIndex === -1) return index === 0;
  return selected;
}

const CHOICES: { status: AttendanceStatus; letter: string; word: string; on: string }[] = [
  { status: "present", letter: "P", word: "Present", on: "bg-pitch-600 text-white border-pitch-600" },
  { status: "late", letter: "L", word: "Late", on: "bg-amber-500 text-white border-amber-500" },
  { status: "absent", letter: "A", word: "Absent", on: "bg-red-600 text-white border-red-600" },
  { status: "excused", letter: "E", word: "Excused", on: "bg-slate-600 text-white border-slate-600" },
];

export function SegmentedControl({
  id,
  playerName,
  value,
  onChange,
  disabled,
}: {
  id: string;
  playerName: string;
  value: AttendanceStatus | null;
  /** `null` clears the row (only offered for unsaved rows — see the sheet). */
  onChange: (next: AttendanceStatus | null) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = CHOICES.findIndex((c) => c.status === value);

  function move(from: number, delta: number) {
    const next = (from + delta + CHOICES.length) % CHOICES.length;
    refs.current[next]?.focus();
    onChange(CHOICES[next].status);
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={`Attendance for ${playerName}`}
      className="flex shrink-0 items-center gap-2"
    >
      {CHOICES.map((choice, index) => {
        const selected = choice.status === value;
        return (
          <button
            key={choice.status}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${choice.word} (${choice.letter}) for ${playerName}`}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            // One tab stop for the group; arrows move within it (WAI-ARIA).
            tabIndex={isTabStop(disabled, selectedIndex, index, selected) ? 0 : -1}
            data-attendance-choice={`${choice.status}`}
            onClick={() => {
              // Tapping the current choice clears an UNSAVED row; a saved row is
              // never silently unmarked (PAGE_SPECIFICATIONS §5).
              if (selected && !disabled) onChange(null);
              else onChange(choice.status);
            }}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={`h-12 w-12 cursor-pointer rounded-xl border text-[15px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected ? choice.on : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {choice.letter}
            <span className="sr-only">{choice.word}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface RowDraft {
  /** `null` = unmarked. */
  status: AttendanceStatus | null;
  note?: string;
  reason?: string;
}

export function AttendanceRow({
  row,
  value,
  disabled,
  needsReason,
  reasonError,
  conflict,
  onPick,
  onNote,
  onReason,
}: {
  row: {
    player: { id: string; fullName: string; registrationNo: string };
    record?: { status: AttendanceStatus; note?: string; markedAt: string; markedBy: string; version: number };
  };
  value: RowDraft;
  disabled?: boolean;
  needsReason?: boolean;
  reasonError?: string;
  conflict?: string;
  onPick: (next: AttendanceStatus | null) => void;
  /** `undefined` closes the note expander. */
  onNote: (next: string | undefined) => void;
  onReason: (next: string) => void;
}) {
  const noteOpen = value.note !== undefined;
  const { player, record: saved } = row;
  return (
    <li
      className={`min-h-[56px] border-b border-slate-100 px-3 py-2 last:border-b-0 ${
        conflict ? "bg-amber-50" : ""
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-slate-900">{player.fullName}</p>
          <p className="text-[12px] text-slate-500">
            {player.registrationNo}
            {saved ? (
              <>
                {" · "}
                {saved.status} since {formatInstant(saved.markedAt)} · by {saved.markedBy}
              </>
            ) : (
              " · unmarked"
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onNote(noteOpen ? undefined : (value.note ?? ""))}
            aria-expanded={noteOpen}
            aria-label={`${noteOpen ? "Hide" : "Add"} note for ${player.fullName}`}
            className="flex h-12 w-11 cursor-pointer items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {value.note ? (
              <Check className="h-5 w-5" aria-hidden="true" />
            ) : (
              <MessageSquarePlus className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <SegmentedControl
            id={`attendance-${player.id}`}
            playerName={player.fullName}
            value={value.status}
            onChange={onPick}
            disabled={disabled}
          />
        </div>
      </div>

      {noteOpen ? (
        <div className="mt-2">
          <label htmlFor={`note-${player.id}`} className="block text-[13px] font-semibold text-slate-700">
            Note for {player.fullName} (optional, ≤ 500 characters)
          </label>
          <textarea
            id={`note-${player.id}`}
            value={value.note ?? ""}
            maxLength={500}
            rows={2}
            disabled={disabled}
            onChange={(event) => onNote(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-[16px]"
          />
        </div>
      ) : null}

      {needsReason ? (
        <div className="mt-2">
          <label htmlFor={`reason-${player.id}`} className="block text-[13px] font-semibold text-amber-900">
            Reason for changing a saved record (required, at least 5 characters)
          </label>
          <input
            id={`reason-${player.id}`}
            value={value.reason ?? ""}
            maxLength={200}
            disabled={disabled}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? `reason-error-${player.id}` : undefined}
            onChange={(event) => onReason(event.target.value)}
            className={`mt-1 h-12 w-full rounded-xl border px-3 text-[16px] ${
              reasonError ? "border-red-500" : "border-slate-300"
            }`}
          />
          {reasonError ? (
            <p id={`reason-error-${player.id}`} className="mt-1 text-[13px] font-medium text-red-700">
              {reasonError}
            </p>
          ) : null}
        </div>
      ) : null}

      {conflict ? (
        <p role="alert" className="mt-2 text-[13px] font-medium text-amber-900">
          {conflict}
        </p>
      ) : null}
    </li>
  );
}
