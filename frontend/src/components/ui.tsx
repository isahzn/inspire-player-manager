"use client";

// Shared UI kit for the management screens (DESIGN_SYSTEM §6 component
// inventory). Small on purpose: one button, one form-field trio, one dialog,
// the four state blocks, and money/date text that go through the strict
// helpers in lib/money.ts and lib/dates.ts. Every interactive target is ≥ 44 px
// and every error carries its requestId (PAGE_SPECIFICATIONS §0).
import Link from "next/link";
import { useEffect, useRef } from "react";
import { AlertTriangle, Info, RotateCcw, Search, X } from "lucide-react";
import { ApiError } from "@/api/client";
import { formatDateStr, formatInstant } from "@/lib/dates";
import { formatMoneyMinor } from "@/lib/money";

// --- surface ----------------------------------------------------------------
export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section";
}) {
  return (
    <Tag className={`rounded-2xl border border-slate-200 bg-white shadow-card ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
      <h2 className="font-heading text-[15px] font-semibold text-slate-900">{children}</h2>
      {right}
    </div>
  );
}

// --- buttons ----------------------------------------------------------------
type Variant = "primary" | "secondary" | "danger" | "ghost";

export function buttonClass(variant: Variant = "primary", size: "md" | "sm" = "md") {
  const base =
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
  const sizes = size === "sm" ? "min-h-[44px] px-3 text-[14px]" : "min-h-[44px] px-4 text-[15px]";
  const variants: Record<Variant, string> = {
    primary: "bg-pitch-600 text-white hover:bg-pitch-700",
    secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "text-slate-700 hover:bg-slate-100",
  };
  return `${base} ${sizes} ${variants[variant]}`;
}

export function Button({
  variant = "primary",
  size = "md",
  pending,
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "sm";
  pending?: boolean;
}) {
  return (
    <button
      {...rest}
      aria-busy={pending || undefined}
      className={`${buttonClass(variant, size)} ${className}`}
      disabled={rest.disabled || pending}
    >
      {children}
    </button>
  );
}

// --- form fields ------------------------------------------------------------
function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[14px] font-semibold text-slate-800">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1 text-[13px] text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-[13px] font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const inputClass =
  "h-12 w-full rounded-xl border bg-white px-3 text-[16px] text-slate-900 placeholder:text-slate-400";

export function TextField({
  id,
  label,
  hint,
  error,
  required,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <input
        {...rest}
        id={id}
        name={rest.name ?? id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${inputClass} ${error ? "border-red-500" : "border-slate-300"}`}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  error,
  required,
  rows = 3,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  rows?: number;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <textarea
        {...rest}
        id={id}
        name={rest.name ?? id}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`w-full rounded-xl border bg-white px-3 py-2 text-[16px] ${error ? "border-red-500" : "border-slate-300"}`}
      />
    </FieldShell>
  );
}

export function SelectField({
  id,
  label,
  hint,
  error,
  required,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <select
        {...rest}
        id={id}
        name={rest.name ?? id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${inputClass} ${error ? "border-red-500" : "border-slate-300"}`}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-6 w-6 shrink-0 cursor-pointer rounded border-slate-400"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[14px] font-semibold text-slate-800">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-[13px] text-slate-600">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// --- states -----------------------------------------------------------------
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <Search className="mx-auto h-6 w-6 text-slate-400" aria-hidden="true" />
      <p className="mt-3 text-[15px] font-semibold text-slate-900">{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-md text-[14px] text-slate-600">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const tones = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-900",
  } as const;
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[14px] ${tones[tone]}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Error block for any data view: message + requestId + Retry (PAGE_SPEC §0). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const notFound = api?.status === 404;
  const title = notFound
    ? "Not found"
    : api?.status === 403
      ? "No access"
      : "Something went wrong";
  const message = notFound
    ? "This record does not exist, or it is outside your groups."
    : (api?.message ?? "We could not load this. Please retry.");
  return (
    <div role="alert" className="px-4 py-8 text-center">
      <AlertTriangle className="mx-auto h-6 w-6 text-red-600" aria-hidden="true" />
      <p className="mt-3 text-[15px] font-semibold text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[14px] text-slate-600">{message}</p>
      {api?.requestId ? (
        <p className="mt-1 text-[12px] text-slate-500">
          Reference: <span className="font-mono">{api.requestId}</span>
        </p>
      ) : null}
      {onRetry && !notFound ? (
        <Button variant="secondary" className="mt-4" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-14 rounded-xl" />
      ))}
    </div>
  );
}

// --- dialog -----------------------------------------------------------------
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    focusable()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-navy-900/55" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-pop sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-[17px] font-semibold text-slate-900">{title}</h2>
            {description ? <p className="mt-1 text-[14px] text-slate-600">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="touch44 -mr-1 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
        {footer ? (
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Success toast (role=status, auto-dismiss 5 s per DESIGN_SYSTEM §7). */
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-24 z-50 mx-auto w-[min(92vw,26rem)] rounded-xl bg-navy-900 px-4 py-3 text-[14px] font-medium text-white shadow-pop lg:bottom-8"
    >
      {message}
    </div>
  );
}

// --- text -------------------------------------------------------------------
export function MoneyText({
  minor,
  full,
  muted,
}: {
  minor?: number;
  full?: boolean;
  muted?: boolean;
}) {
  if (minor === undefined || minor === null) {
    return <span className="text-slate-500">—</span>;
  }
  return (
    <span className={`tabular whitespace-nowrap ${muted ? "text-slate-600" : ""}`}>
      {formatMoneyMinor(minor, { full })}
    </span>
  );
}

export function DateText({ value, withTime }: { value?: string | null; withTime?: boolean }) {
  return <span className="whitespace-nowrap">{withTime ? formatInstant(value) : formatDateStr(value)}</span>;
}

// --- tabs -------------------------------------------------------------------
export function Tabs({
  idPrefix,
  tabs,
  active,
  onChange,
}: {
  idPrefix: string;
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            id={`${idPrefix}-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            onClick={() => onChange(tab.key)}
            className={`touch44 -mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2 text-[14px] font-semibold ${
              selected
                ? "border-pitch-600 text-pitch-700"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="touch44 inline-flex min-h-[44px] items-center gap-1 text-[14px] font-semibold text-slate-600 hover:text-slate-900"
    >
      ← {children}
    </Link>
  );
}
