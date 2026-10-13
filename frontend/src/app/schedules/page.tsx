import { PageHeader } from "@/components/PageHeader";
import { RequireAuth, RequirePermissions } from "@/components/Guards";

export default function Page() {
  return (
    <RequireAuth>
      <RequirePermissions path="/schedules">
        <PageHeader title="Training Schedules" sub="Schedules and session generation arrive in Step 4." />
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-card">
          <p className="text-[15px] font-semibold text-slate-900">Coming in the next slice</p>
          <p className="mx-auto mt-1 max-w-md text-[14px] text-slate-600">Schedules and session generation arrive in Step 4.</p>
        </div>
      </RequirePermissions>
    </RequireAuth>
  );
}
