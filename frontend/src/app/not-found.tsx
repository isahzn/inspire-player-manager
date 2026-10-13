import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-card">
      <h1 className="font-heading text-lg font-bold">Page not found</h1>
      <p className="mt-1 text-[14px] text-slate-600">Out-of-scope resources return 404, so existence is never revealed.</p>
      <Link href="/dashboard" className="touch44 mt-4 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2">Go to dashboard</Link>
    </div>
  );
}
