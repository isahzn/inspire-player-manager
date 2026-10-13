import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

export default function ForbiddenPage() {
  return (
    <div>
      <PageHeader title="No access" sub="You do not have permission to view this page." />
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-card">
        <p className="text-[14px] text-slate-600">Coach views never call owner APIs. This state is enforced on the server too.</p>
        <Link href="/dashboard" className="touch44 mt-4 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2">Go to dashboard</Link>
      </div>
    </div>
  );
}
