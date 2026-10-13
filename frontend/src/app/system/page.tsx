"use client";

// System health — SYS-03 (PAGE_SPECIFICATIONS §11).
//
// This page reports, it does not reassure: each card prints the state word from
// the API (Ok / Degraded / Down / Unknown) with a status chip, the detail the API
// gave, and the time this reading was taken. Nothing is inferred from a colour,
// and a card with no data reads Unknown rather than Ok.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Database, HardDrive, ListChecks, MessageCircle, RefreshCw, Timer } from "lucide-react";
import { sys03GetSystemHealth } from "@/api/client";
import type { HealthState } from "@/api/types";
import { RequireAuth, RequirePermissions } from "@/components/Guards";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import {
  Button,
  Card,
  DateText,
  ErrorState,
  InlineAlert,
  ListSkeleton,
  SectionTitle,
} from "@/components/ui";

const STATE_WORD: Record<HealthState, string> = {
  ok: "Ok",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const BACKUP_WORD: Record<"ok" | "failed" | "unknown", string> = {
  ok: "Ok",
  failed: "Failed",
  unknown: "Unknown",
};

export default function SystemPage() {
  return (
    <RequireAuth>
      <RequirePermissions path="/system">
        <SystemHealth />
      </RequirePermissions>
    </RequireAuth>
  );
}

function SystemHealth() {
  const query = useQuery({
    queryKey: ["system", "health"],
    queryFn: sys03GetSystemHealth,
    // Health is a reading, not a cached fact: every visit asks again.
    refetchOnMount: "always",
  });

  const checkedAt = query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : undefined;

  return (
    <div>
      <PageHeader
        title="System health"
        sub="What the app can see right now: database, storage, WhatsApp, the message queue, the scheduler and the last backup."
        actions={
          <Button variant="secondary" pending={query.isFetching} onClick={() => query.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {query.isLoading ? (
        <Card>
          <ListSkeleton rows={5} />
        </Card>
      ) : query.error ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </Card>
      ) : query.data ? (
        <div className="space-y-5">
          <InlineAlert tone="info" title="This page is for the owner, not for uptime monitoring">
            A host-level check (<span className="font-mono">/health</span> and{" "}
            <span className="font-mono">/ready</span>) watches the server from outside. This is the
            same reading, shown to you in plain words.
          </InlineAlert>

          <section aria-label="Services" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <HealthCard
              icon={<Database className="h-5 w-5" aria-hidden="true" />}
              title="Database"
              state={query.data.db.status}
              detail={query.data.db.detail}
              checkedAt={checkedAt}
            />
            <HealthCard
              icon={<HardDrive className="h-5 w-5" aria-hidden="true" />}
              title="File storage"
              state={query.data.storage.status}
              detail={query.data.storage.detail}
              checkedAt={checkedAt}
            />
            <HealthCard
              icon={<MessageCircle className="h-5 w-5" aria-hidden="true" />}
              title="WhatsApp (OpenWA)"
              state={query.data.openwa.status}
              detail={query.data.openwa.detail}
              checkedAt={checkedAt}
              link={{ href: "/whatsapp", label: "Open WhatsApp status" }}
            />
            <HealthCard
              icon={<ListChecks className="h-5 w-5" aria-hidden="true" />}
              title="Message queue"
              state={query.data.queue.status}
              detail={query.data.queue.detail}
              checkedAt={checkedAt}
              link={{ href: "/whatsapp?tab=messages", label: "Open messages" }}
            />
            <HealthCard
              icon={<Timer className="h-5 w-5" aria-hidden="true" />}
              title="Scheduler heartbeat"
              // The contract gives the heartbeat a time but no state word, so the
              // card shows exactly what it was given instead of inventing a verdict.
              state={undefined}
              extra={
                <p className="tabular text-[15px] font-semibold text-slate-900">
                  <DateText value={query.data.scheduler.lastRunAt} withTime />
                </p>
              }
              detail="Last time the background scheduler ran."
              checkedAt={checkedAt}
            />
            <HealthCard
              icon={<Activity className="h-5 w-5" aria-hidden="true" />}
              title="Last backup"
              state={query.data.lastBackup.status}
              backup
              extra={
                <p className="text-[13px] text-slate-700">
                  <DateText value={query.data.lastBackup.at} withTime />
                </p>
              }
              detail="A backup that is older than expected is worth asking about."
              checkedAt={checkedAt}
            />
          </section>

          <Card>
            <SectionTitle>Version</SectionTitle>
            <div className="flex flex-wrap items-center gap-3 p-4">
              <span className="font-mono text-[14px] text-slate-800">{query.data.version}</span>
              <span className="text-[13px] text-slate-600">
                Read at{" "}
                <DateText value={checkedAt} withTime />
              </span>
            </div>
          </Card>

          <p className="text-[13px] text-slate-600">
            Nothing on this page changes a system: it is a read-only check, and it is audited like
            every other owner read of settings and operations data.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function HealthCard({
  icon,
  title,
  state,
  backup,
  extra,
  detail,
  checkedAt,
  link,
}: {
  icon: React.ReactNode;
  title: string;
  /** Absent when the contract gives this card no state word (scheduler). */
  state?: HealthState | "ok" | "failed" | "unknown";
  backup?: boolean;
  extra?: React.ReactNode;
  detail?: string;
  checkedAt?: string;
  link?: { href: string; label: string };
}) {
  const word = state
    ? backup
      ? BACKUP_WORD[state as "ok" | "failed" | "unknown"]
      : STATE_WORD[state as HealthState]
    : null;

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-slate-500">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[15px] font-semibold text-slate-900">{title}</h2>
        </div>
        {word ? <StatusChip status={word} /> : null}
      </div>

      {extra ? <div className="mt-3">{extra}</div> : null}
      {detail ? <p className="mt-2 text-[13px] text-slate-600">{detail}</p> : null}

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-3 text-[12px] text-slate-500">
        {checkedAt ? (
          <span>
            Last checked <DateText value={checkedAt} withTime />
          </span>
        ) : null}
        {link ? (
          <Link
            href={link.href}
            className="touch44 inline-flex min-h-[44px] items-center font-semibold text-pitch-700 underline underline-offset-2"
          >
            {link.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
