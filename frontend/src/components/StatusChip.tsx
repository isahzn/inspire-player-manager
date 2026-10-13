// Status is never communicated by colour alone: the chip always prints the word
// (DESIGN_SYSTEM §8) and carries a dot for extra scannability.
const STYLES: Record<string, string> = {
  Active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Delivered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Read: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Granted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Partial: "bg-amber-50 text-amber-700 border-amber-200",
  Partially: "bg-amber-50 text-amber-700 border-amber-200",
  // `invoiceStatusLabel()` says "Partially paid" — the billing screens pass it
  // straight through, so the style has to exist under that exact key too.
  "Partially paid": "bg-amber-50 text-amber-700 border-amber-200",
  Pending: "bg-amber-50 text-amber-700 border-amber-200",
  Confirmed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Rejected: "bg-red-50 text-red-700 border-red-200",
  Reversed: "bg-slate-100 text-slate-600 border-slate-200",
  Issued: "bg-blue-50 text-blue-700 border-blue-200",
  Sent: "bg-blue-50 text-blue-700 border-blue-200",
  Invited: "bg-blue-50 text-blue-700 border-blue-200",
  Overdue: "bg-red-50 text-red-700 border-red-200",
  Failed: "bg-red-50 text-red-700 border-red-200",
  Revoked: "bg-red-50 text-red-700 border-red-200",
  Withdrawn: "bg-red-50 text-red-700 border-red-200",
  Inactive: "bg-slate-100 text-slate-600 border-slate-200",
  Archived: "bg-slate-100 text-slate-600 border-slate-200",
  Void: "bg-slate-100 text-slate-600 border-slate-200",
  Unknown: "bg-amber-50 text-amber-700 border-amber-200",
  // Step 6/8 words: message status + delivery, automation state, system health.
  Queued: "bg-blue-50 text-blue-700 border-blue-200",
  Sending: "bg-blue-50 text-blue-700 border-blue-200",
  "Needs review": "bg-amber-50 text-amber-700 border-amber-200",
  "Failed permanently": "bg-red-50 text-red-700 border-red-200",
  "Failed (will retry)": "bg-amber-50 text-amber-700 border-amber-200",
  Cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  Skipped: "bg-slate-100 text-slate-600 border-slate-200",
  "Accepted by server": "bg-blue-50 text-blue-700 border-blue-200",
  "Provider error": "bg-red-50 text-red-700 border-red-200",
  "Awaiting QR scan": "bg-amber-50 text-amber-700 border-amber-200",
  Starting: "bg-amber-50 text-amber-700 border-amber-200",
  Stopped: "bg-slate-100 text-slate-600 border-slate-200",
  Ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Degraded: "bg-amber-50 text-amber-700 border-amber-200",
  Down: "bg-red-50 text-red-700 border-red-200",
  On: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Off: "bg-slate-100 text-slate-600 border-slate-200",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${
        STYLES[status] ?? "bg-slate-100 text-slate-600 border-slate-200"
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full bg-current"
      />
      {status}
    </span>
  );
}
