"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { DemoButton } from "@/components/demo-button";
import { getOverview, getTraffic, listAgents, listMappings } from "@/lib/umbra/actions";
import { formatBps, formatBytes, formatRelative } from "@/lib/umbra/format";
import { actionLabel } from "@/lib/umbra/labels";
import { StatusDot } from "@/components/status-dot";
import { RateChart } from "@/components/rate-chart";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: () => getOverview() });
  const traffic = useQuery({ queryKey: ["umbra", "traffic", "24h"], queryFn: () => getTraffic({ data: { range: "24h" } }) });
  const agents = useQuery({ queryKey: ["umbra", "agents"], queryFn: () => listAgents() });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: () => listMappings() });

  const o = overview.data;
  const empty = !overview.isLoading && (o?.agentsTotal ?? 0) === 0;
  const maps = mappings.data ?? [];
  const probed = maps.some((m) => m.bytesIn + m.bytesOut > 0);

  return (
    <AppShell
      title="总览"
      action={
        overview.isLoading || empty ? undefined : (
          <DemoButton size="sm" variant="outline" label="再跑一遍" />
        )
      }
    >
      {overview.isLoading ? (
        <div className="h-32" />
      ) : empty ? (
        <EmptyGate />
      ) : (
        <div className="flex flex-col gap-8">
          <NextHint
            online={o?.agentsOnline ?? 0}
            mappings={o?.mappingsTotal ?? 0}
            probed={probed}
          />

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="在线节点" value={`${o?.agentsOnline ?? 0}`} hint={`共 ${o?.agentsTotal ?? 0}`} />
            <Stat label="活跃映射" value={`${o?.mappingsActive ?? 0}`} hint={`共 ${o?.mappingsTotal ?? 0}`} />
            <Stat label="今日入站" value={formatBytes(o?.bytesInToday ?? 0)} hint={`现 ${formatBps(o?.bpsIn ?? 0)}`} />
            <Stat label="今日出站" value={formatBytes(o?.bytesOutToday ?? 0)} hint={`现 ${formatBps(o?.bpsOut ?? 0)}`} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium text-ink-soft">近 24 小时</h2>
            <div className="rounded-xl bg-card p-4 shadow-border">
              <RateChart data={traffic.data?.series ?? []} />
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-medium text-ink-soft">节点</h2>
              <ul className="divide-y divide-line rounded-xl bg-card shadow-border">
                {(agents.data ?? []).slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                      <p className="font-mono text-xs text-stone">{a.addr ?? (a.status === "online" ? "" : "未上线")}</p>
                    </div>
                    <StatusDot
                      status={a.status}
                      label={a.status === "online" ? "在线" : a.status === "revoked" ? "已吊销" : "离线"}
                    />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium text-ink-soft">
                最近操作
                <Link to="/audit" className="text-xs text-stone hover:text-ink">
                  全部
                </Link>
              </h2>
              <ul className="divide-y divide-line rounded-xl bg-card shadow-border">
                {(o?.recentAudit ?? []).length === 0 ? (
                  <li className="px-4 py-6 text-sm text-stone">还没有审计记录。</li>
                ) : (
                  (o?.recentAudit ?? []).map((item) => (
                    <li key={item.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
                      <span className="text-sm">{actionLabel[item.action] ?? item.action}</span>
                      <span className="shrink-0 font-mono text-xs text-stone">
                        {formatRelative(item.ts)}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

function NextHint({
  online,
  mappings,
  probed,
}: {
  online: number;
  mappings: number;
  probed: boolean;
}) {
  if (online === 0) {
    return (
      <Hint>
        节点还没上线，映射无法开流。
        <Button asChild size="sm" variant="outline">
          <Link to="/agents">去上线</Link>
        </Button>
      </Hint>
    );
  }
  if (mappings === 0) {
    return (
      <Hint>
        节点已在线。在服务端建映射即可下发，不用改客户端。
        <Button asChild size="sm" variant="outline">
          <Link to="/mappings">新建映射</Link>
        </Button>
      </Hint>
    );
  }
  if (!probed) {
    return (
      <Hint>
        映射已下发。探测走入口（TCP 或 UDP），计入流量。
        <Button asChild size="sm" variant="outline">
          <Link to="/mappings">去探测</Link>
        </Button>
      </Hint>
    );
  }
  return null;
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 text-sm text-ink-soft shadow-border">
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-4 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p className="mt-2 font-mono text-2xl font-medium tabular-nums tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-xs text-stone">{hint}</p>
    </div>
  );
}

function EmptyGate() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 py-10">
      <svg viewBox="0 0 120 88" className="h-16 w-auto text-pine" aria-hidden="true">
        <path
          d="M18 80 V28 Q60 4 102 28 V80"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
        />
        <path d="M58 80 V46" stroke="currentColor" strokeWidth="2.4" />
        <circle cx="62.5" cy="58" r="1.6" fill="currentColor" />
      </svg>
      <div>
        <h2 className="font-serif text-3xl italic tracking-tight text-ink">先让一台节点上线</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          演示会登记节点、暗端口先丢再通，再打一条公开 UDP 游戏口。映射只在服务端改。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <DemoButton />
        <Button asChild variant="ghost">
          <Link to="/agents">手动登记</Link>
        </Button>
      </div>
    </div>
  );
}
