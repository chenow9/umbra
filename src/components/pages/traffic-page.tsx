"use client";

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ObservabilityNav } from "@/components/observability-nav";
import { AppShell } from "@/components/app-shell";
import { ObservationScope } from "@/components/observation-scope";
import { RateChart } from "@/components/rate-chart";
import { Pager } from "@/components/ui/pager";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getTraffic, listNodes, listMappings } from "@/lib/umbra/api";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { peakBpsFromSeries } from "@/lib/umbra/live";
import { PAGE_SIZE, pageOf } from "@/lib/umbra/page";
import { resolveTrafficScope, type TrafficSearch } from "@/lib/umbra/traffic-scope";
import { cn } from "@/lib/utils";

export function TrafficPage() {
  const search = useSearch({ from: "/traffic" });
  const navigate = useNavigate({ from: "/traffic" });
  const range = search.range ?? "24h";
  const chart = search.chart ?? "rate";
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const scope = resolveTrafficScope(search, nodes.data ?? [], mappings.data ?? []);
  const nodeId = scope.nodeId;
  const mappingId = search.service ?? "";
  const catalogReady = Boolean(nodes.data && mappings.data);
  const catalogError = nodes.error || mappings.error;
  const invalid = catalogReady ? scope.error : undefined;
  const traffic = useQuery({
    queryKey: ["umbra", "traffic", range, nodeId, mappingId],
    queryFn: () =>
      getTraffic({
        data: { range, nodeId: nodeId || undefined, mappingId: mappingId || undefined },
      }),
    enabled: catalogReady && !invalid,
    // Preserve the old chart only when refreshing time within the same scope.
    placeholderData: (previous, query) =>
      query?.queryKey[3] === nodeId && query?.queryKey[4] === mappingId ? previous : undefined,
  });
  const t = !invalid && catalogReady ? traffic.data : undefined;
  const peak = peakBpsFromSeries(t?.series ?? []);
  const update = (change: Partial<TrafficSearch>) =>
    void navigate({ search: { ...search, ...change } });
  useEffect(() => {
    setPage(1);
    setQ("");
  }, [nodeId, mappingId]);
  // A service-only link resolves its owning node, so sharing the URL preserves both.
  useEffect(() => {
    if (catalogReady && !invalid && search.service && !search.node && nodeId) {
      void navigate({ search: { ...search, node: nodeId }, replace: true });
    }
  }, [catalogReady, invalid, search, nodeId, navigate]);

  const rows = (
    nodeId
      ? (mappings.data ?? [])
          .filter((m) => m.nodeId === nodeId)
          .map((m) => ({
            id: m.id,
            name: m.name,
            detail: m.proto.toUpperCase(),
            bytesIn: m.bytesIn,
            bytesOut: m.bytesOut,
            rate: (m.bpsIn ?? 0) + (m.bpsOut ?? 0),
            activity: `${m.proto === "udp" ? "活跃会话" : "连接"} ${m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns}`,
            drops:
              m.proto === "udp"
                ? (m.udpDropMaxConns ?? 0) + (m.udpDropPerIP ?? 0) + (m.udpDropRate ?? 0)
                : 0,
          }))
      : (nodes.data ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          detail: n.status === "online" ? "在线" : n.status === "revoked" ? "已吊销" : "离线",
          bytesIn: n.bytesIn,
          bytesOut: n.bytesOut,
          rate: (n.bpsIn ?? 0) + (n.bpsOut ?? 0),
          activity: `${n.mappingCount} 项服务`,
          drops: 0,
        }))
  )
    .filter((row) => `${row.name} ${row.detail}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pageData = pageOf(rows, page, PAGE_SIZE);
  const problem =
    invalid ||
    (catalogError
      ? "无法读取节点或服务，请重试。"
      : traffic.isError
        ? "流量读取失败，请重试。"
        : undefined);

  return (
    <AppShell title="观测" description="查看节点与服务的流量。" showTelemetry={false}>
      <ObservabilityNav
        active="traffic"
        trafficSearch={search}
        actions={
          <div className="observation-toolbar">
            <ObservationScope
              value={nodeId}
              onChange={(id) => update({ node: id || undefined, service: undefined })}
              nodes={nodes.data ?? []}
              loading={nodes.isPending}
              error={nodes.isError}
              onRetry={() => void nodes.refetch()}
            />
            <div
              role="group"
              aria-label="流量时间范围"
              className="flex w-fit rounded-md bg-paper-2 p-0.5 shadow-border"
            >
              {(["1h", "24h", "7d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => update({ range: r })}
                  className={cn(
                    "h-11 rounded-sm px-3 text-sm font-medium",
                    range === r ? "bg-paper text-ink" : "text-stone hover:text-ink",
                  )}
                >
                  {r === "1h" ? "1 小时" : r === "24h" ? "24 小时" : "7 天"}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <nav aria-label="流量范围" className="flex min-w-0 flex-wrap items-center gap-2">
            <Link to="/traffic" search={{ range, chart }}>
              全部节点
            </Link>
            {nodeId ? (
              <>
                <span className="text-stone">/</span>
                <Link to="/traffic" search={{ node: nodeId, range, chart }} className="break-all">
                  {scope.node?.name ?? "所选节点"}
                </Link>
              </>
            ) : null}
            {mappingId ? (
              <>
                <span className="text-stone">/</span>
                <span className="break-all">{scope.service?.name ?? "所选服务"}</span>
              </>
            ) : null}
          </nav>
          {nodeId && catalogReady && !invalid ? (
            <Link
              to="/nodes/$nodeId"
              params={{ nodeId }}
              search={{ service: mappingId || undefined }}
              className="text-xs text-pine"
            >
              {mappingId ? "打开服务" : "返回节点服务"} →
            </Link>
          ) : null}
        </div>
        {problem ? (
          <div role="alert" className="rounded-xl border border-rose/25 p-4 text-sm">
            <p>{problem}</p>
            {invalid ? (
              <Button
                variant="ghost"
                className="mt-2"
                onClick={() => update({ node: undefined, service: undefined })}
              >
                返回全部节点
              </Button>
            ) : (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => {
                  void nodes.refetch();
                  void mappings.refetch();
                  void traffic.refetch();
                }}
              >
                重新加载
              </Button>
            )}
          </div>
        ) : null}
        <section
          aria-label="流量指标"
          aria-busy={traffic.isFetching}
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        >
          <Mini
            label="当前入站速率"
            value={t ? formatBps(t.bpsIn) : "—"}
            hint={t && t.series.length > 1 ? `时段采样峰值 ${formatBps(peak.in)}` : "等待时段采样"}
          />
          <Mini
            label="当前出站速率"
            value={t ? formatBps(t.bpsOut) : "—"}
            hint={t && t.series.length > 1 ? `时段采样峰值 ${formatBps(peak.out)}` : "等待时段采样"}
          />
          <Mini
            label="历史累计入站"
            value={t ? formatBytes(t.bytesIn) : "—"}
            hint="不随时间范围切换"
          />
          <Mini
            label="历史累计出站"
            value={t ? formatBytes(t.bytesOut) : "—"}
            hint="不随时间范围切换"
          />
        </section>
        <section className="min-w-0 rounded-xl bg-card p-4 shadow-border" aria-label="流量趋势">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="图表类型" className="flex gap-1">
              <Button
                size="sm"
                variant={chart === "rate" ? "secondary" : "ghost"}
                aria-pressed={chart === "rate"}
                onClick={() => update({ chart: "rate" })}
              >
                速率趋势
              </Button>
              <Button
                size="sm"
                variant={chart === "bytes" ? "secondary" : "ghost"}
                aria-pressed={chart === "bytes"}
                onClick={() => update({ chart: "bytes" })}
              >
                累计流量
              </Button>
            </div>
            <span className="min-h-4 text-xs text-stone" role="status">
              {traffic.isFetching ? "更新中…" : ""}
            </span>
          </div>
          <p className="mb-2 min-h-8 text-xs leading-4 text-stone">
            {chart === "rate"
              ? "曲线显示所选时段的采样平均速率；上方显示当前速率。"
              : "曲线显示所选时段内的历史累计读数，不是该时段新增流量。"}
          </p>
          <RateChart
            kind={chart}
            range={range}
            data={t?.series ?? []}
            loading={!catalogReady || traffic.isPending}
            updating={traffic.isPlaceholderData}
            error={Boolean(problem)}
          />
        </section>
        {!mappingId && !invalid ? (
          <section className="space-y-3" aria-label={nodeId ? "服务流量明细" : "节点流量明细"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">{nodeId ? "服务流量" : "节点流量"}</h2>
                <p className="mt-1 text-xs text-stone">
                  历史累计与当前速率 · 选择{nodeId ? "服务" : "节点"}查看趋势
                </p>
              </div>
              <Input
                className="w-full bg-card sm:w-56"
                aria-label="搜索流量明细"
                placeholder={nodeId ? "搜索服务" : "搜索节点"}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {!catalogReady ? (
              <p role="status" className="py-6 text-sm text-stone">
                {catalogError ? "明细读取失败。" : "正在读取明细…"}
              </p>
            ) : rows.length ? (
              <ul className="traffic-breakdown">
                {pageData.items.map((row) => (
                  <li key={row.id}>
                    <Link
                      to="/traffic"
                      search={{
                        node: nodeId || row.id,
                        service: nodeId ? row.id : undefined,
                        range,
                        chart,
                      }}
                      aria-label={`查看 ${row.name} 的流量`}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-sm font-medium">{row.name}</strong>
                        <small className="mt-1 block text-xs text-stone">
                          {row.detail} · {row.activity}
                          {row.drops > 0 ? ` · UDP 累计丢弃 ${row.drops}` : ""}
                        </small>
                      </span>
                      <span className="traffic-breakdown-totals">
                        <small>累计入 / 出</small>
                        <span>
                          {formatBytes(row.bytesIn)} / {formatBytes(row.bytesOut)}
                        </span>
                      </span>
                      <span className="traffic-breakdown-rate">
                        <small>当前总速率</small>
                        <span>{formatBps(row.rate)}</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-stone" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-line p-6 text-sm text-stone">
                {q ? "没有匹配结果，请调整搜索。" : nodeId ? "此节点还没有服务。" : "还没有节点。"}
              </p>
            )}
            {rows.length > PAGE_SIZE ? (
              <Pager
                page={pageData.page}
                size={pageData.size}
                total={pageData.total}
                onPage={setPage}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
      <p className="mt-0.5 h-4 text-[11px] leading-4 text-stone">{hint}</p>
    </div>
  );
}
