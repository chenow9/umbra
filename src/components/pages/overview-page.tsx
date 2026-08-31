"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { DemoButton } from "@/components/demo-button";
import { getOverview, getTraffic, queryNodes } from "@/lib/umbra/api";
import { formatBps, formatBytes, formatRelative } from "@/lib/umbra/format";
import { actionLabel } from "@/lib/umbra/labels";
import { emptyPage } from "@/lib/umbra/page";
import { StatusDot } from "@/components/status-dot";
import { RateChart } from "@/components/rate-chart";
import type { Node, OverviewAlert } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: () => getOverview() });
  const traffic = useQuery({ queryKey: ["umbra", "traffic", "24h"], queryFn: () => getTraffic({ data: { range: "24h" } }) });
  const nodes = useQuery({
    queryKey: ["umbra", "nodes", "page", { page: 1, size: 5 }],
    queryFn: () => queryNodes({ page: 1, size: 5 }),
  });

  const o = overview.data;
  const empty = !overview.isLoading && (o?.nodesTotal ?? 0) === 0;
  const preview = nodes.data ?? emptyPage<Node>(1, 5);
  const probed = (o?.bytesInToday ?? 0) + (o?.bytesOutToday ?? 0) > 0 || (traffic.data?.bytesIn ?? 0) > 0;
  const alerts = o?.alerts ?? [];

  return (
    <AppShell title="总览">
      {overview.isLoading ? (
        <div className="h-32" />
      ) : empty ? (
        <EmptyGate />
      ) : (
        <div className="flex flex-col gap-8">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="在线节点"
              value={`${o?.nodesOnline ?? 0}`}
              hint={`共 ${o?.nodesTotal ?? 0}`}
              tone={(o?.nodesOnline ?? 0) === 0 && (o?.nodesTotal ?? 0) > 0 ? "warn" : "ok"}
            />
            <Stat
              label="可连映射"
              value={`${o?.mappingsActive ?? 0}`}
              hint={`共 ${o?.mappingsTotal ?? 0}`}
              tone={(o?.mappingsActive ?? 0) === 0 && (o?.mappingsTotal ?? 0) > 0 ? "warn" : "ok"}
            />
            <Stat label="今日入站" value={formatBytes(o?.bytesInToday ?? 0)} hint="自 0 点起" />
            <Stat label="今日出站" value={formatBytes(o?.bytesOutToday ?? 0)} hint="自 0 点起" />
            <Stat
              label="入站速率"
              value={formatBps(o?.bpsIn ?? 0)}
              hint={traffic.data?.peakBpsIn ? `峰值 ${formatBps(traffic.data.peakBpsIn)}` : "此刻"}
            />
            <Stat
              label="出站速率"
              value={formatBps(o?.bpsOut ?? 0)}
              hint={traffic.data?.peakBpsOut ? `峰值 ${formatBps(traffic.data.peakBpsOut)}` : "此刻"}
            />
            <Stat
              label="累计入站"
              value={formatBytes(traffic.data?.bytesIn ?? 0)}
              hint="全部映射"
            />
            <Stat
              label="累计出站"
              value={formatBytes(traffic.data?.bytesOut ?? 0)}
              hint="全部映射"
            />
          </section>

          {alerts.length > 0 ? (
            <AlertStrip alerts={alerts} />
          ) : (
            <NextHint online={o?.nodesOnline ?? 0} mappings={o?.mappingsTotal ?? 0} probed={probed} />
          )}

          <section>
            <h2 className="mb-3 text-sm font-medium text-ink">近 24 小时</h2>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl bg-card p-4 shadow-border">
                <p className="mb-2 text-xs text-stone">实时速率</p>
                <RateChart kind="rate" data={traffic.data?.series ?? []} />
              </div>
              <div className="rounded-xl bg-card p-4 shadow-border">
                <p className="mb-2 text-xs text-stone">累计流量</p>
                <RateChart kind="bytes" data={traffic.data?.series ?? []} />
              </div>
            </div>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium text-ink">
                节点
                <Link to="/nodes" className="text-xs font-normal text-stone hover:text-ink">
                  全部 {o?.nodesTotal ?? 0}
                </Link>
              </h2>
              <ul className="divide-y divide-line rounded-xl bg-card shadow-border">
                {preview.items.length === 0 ? (
                  <li className="px-4 py-6 text-sm text-stone">还没有节点。</li>
                ) : (
                  preview.items.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{a.name}</p>
                        <p className="truncate text-xs text-stone">
                          {[a.addr || (a.status === "online" ? "" : "未上线"), a.comment].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <StatusDot
                        status={a.status}
                        label={a.status === "online" ? "在线" : a.status === "revoked" ? "已吊销" : "离线"}
                      />
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div>
              <h2 className="mb-3 flex items-baseline justify-between text-sm font-medium text-ink">
                最近操作
                <Link to="/audit" className="text-xs font-normal text-stone hover:text-ink">
                  全部
                </Link>
              </h2>
              <ul className="divide-y divide-line rounded-xl bg-card shadow-border">
                {(o?.recentAudit ?? []).length === 0 ? (
                  <li className="px-4 py-6 text-sm text-stone">还没有审计记录。</li>
                ) : (
                  (o?.recentAudit ?? []).slice(0, 5).map((item) => (
                    <li key={item.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{actionLabel[item.action] ?? item.action}</p>
                        <p className="truncate text-xs text-stone">{item.targetName || item.detail || item.target || "—"}</p>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-stone">{formatRelative(item.ts)}</span>
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

function AlertStrip({ alerts }: { alerts: OverviewAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <ul className="overflow-hidden rounded-xl bg-card shadow-border">
      {alerts.map((a, i) => (
        <li
          key={`${a.kind}-${a.id ?? i}`}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-3 last:border-0"
        >
          <span className={cn("text-sm", a.level === "error" ? "text-rose" : "text-ink")}>{a.title}</span>
          {a.href ? (
            <Link
              to={a.href === "/nodes" ? "/nodes" : "/mappings"}
              className="shrink-0 text-xs text-stone hover:text-ink"
            >
              {a.href === "/nodes" ? "去节点" : "去映射"}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
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
  if (online === 0) return null;
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
        映射已下发。探测走入口，计入流量。
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

function Stat({
  label,
  value,
  hint,
  tone = "ok",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-xl bg-card px-4 py-4 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-2xl font-medium tabular-nums tracking-tight",
          tone === "warn" ? "text-ink-soft" : "text-ink",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-stone">{hint}</p>
    </div>
  );
}

function EmptyGate() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 py-10">
      <svg viewBox="0 0 120 88" className="h-16 w-auto text-pine" aria-hidden="true">
        <path d="M18 80 V28 Q60 4 102 28 V80" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M58 80 V46" stroke="currentColor" strokeWidth="2.4" />
        <circle cx="62.5" cy="58" r="1.6" fill="currentColor" />
      </svg>
      <div>
        <h2 className="font-serif text-3xl italic tracking-tight text-ink">先让一台节点上线</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          演示会登记节点、开一条 spa 和一条 public。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <DemoButton />
        <Button asChild variant="ghost">
          <Link to="/nodes">手动登记</Link>
        </Button>
      </div>
    </div>
  );
}
