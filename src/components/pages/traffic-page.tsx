"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FilterChips } from "@/components/filter-chips";
import { RateChart } from "@/components/rate-chart";
import { Pager } from "@/components/ui/pager";
import { Button } from "@/components/ui/button";
import { getTraffic, listNodes, listMappings, queryMappings } from "@/lib/umbra/api";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { useLiveStatus, type TrafficRange } from "@/lib/umbra/live";
import { emptyPage, PAGE_SIZE } from "@/lib/umbra/page";
import type { Mapping } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

export function TrafficPage() {
  const [range, setRange] = useState<TrafficRange>("24h");
  const [nodeId, setNodeId] = useState("");
  const [mappingId, setMappingId] = useState("");
  const [page, setPage] = useState(1);
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const mappingOpts = useQuery({ queryKey: ["umbra", "mappings"], queryFn: () => listMappings() });
  const mapQuery = {
    nodeId: nodeId || undefined,
    page,
    size: PAGE_SIZE,
  };
  const mappings = useQuery({
    queryKey: ["umbra", "mappings", "page", mapQuery],
    queryFn: () => queryMappings(mapQuery),
    placeholderData: keepPreviousData,
  });
  const traffic = useQuery({
    queryKey: ["umbra", "traffic", range, nodeId, mappingId],
    queryFn: () =>
      getTraffic({
        data: {
          range,
          nodeId: nodeId || undefined,
          mappingId: mappingId || undefined,
        },
      }),
  });

  const t = traffic.data;
  const pageData = mappings.data ?? emptyPage<Mapping>(page);
  const filteredMaps = pageData.items;
  const nodeChips = (nodes.data ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    count: (mappingOpts.data ?? []).filter((m) => m.nodeId === a.id).length,
  }));

  useEffect(() => {
    setPage(1);
  }, [nodeId]);

  function pickMapping(id: string) {
    setMappingId((cur) => (cur === id ? "" : id));
  }
  useEffect(() => {
    if (!mappings.data) return;
    const pages = Math.max(1, Math.ceil(mappings.data.total / mappings.data.size) || 1);
    if (page > pages) setPage(pages);
  }, [mappings.data, page]);

  return (
    <AppShell title="流量">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
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
                onClick={() => setRange(r)}
                className={cn(
                  "h-11 rounded-sm px-3 text-sm font-medium transition-colors duration-150",
                  range === r ? "bg-paper text-ink" : "text-stone hover:text-ink",
                )}
              >
                {r === "1h" ? "1 小时" : r === "24h" ? "24 小时" : "7 天"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <FilterChips
              label="节点"
              value={nodeId || "all"}
              onChange={(v) => {
                setNodeId(v === "all" ? "" : v);
                setMappingId("");
              }}
              options={nodeChips}
            />
            {mappingId ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setMappingId("")}>
                取消选中映射
              </Button>
            ) : (
              <p className="text-xs text-stone">点下面一行，只看那条映射的流量。</p>
            )}
          </div>
        </div>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Mini label="入站累计" value={formatBytes(t?.bytesIn ?? 0)} />
          <Mini label="出站累计" value={formatBytes(t?.bytesOut ?? 0)} />
          <Mini
            label="入站速率"
            value={formatBps(t?.bpsIn ?? 0)}
            hint={(t?.peakBpsIn ?? 0) > 0 ? `峰值 ${formatBps(t?.peakBpsIn ?? 0)}` : undefined}
          />
          <Mini
            label="出站速率"
            value={formatBps(t?.bpsOut ?? 0)}
            hint={(t?.peakBpsOut ?? 0) > 0 ? `峰值 ${formatBps(t?.peakBpsOut ?? 0)}` : undefined}
          />
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-card p-4 shadow-border">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs text-stone">实时速率</p>
              <LiveHint />
            </div>
            <RateChart
              kind="rate"
              range={range}
              data={t?.series ?? []}
              emptyAction={
                <Button asChild size="sm" variant="outline">
                  <Link to="/mappings">检查映射</Link>
                </Button>
              }
            />
          </div>
          <div className="rounded-xl bg-card p-4 shadow-border">
            <p className="mb-2 text-xs text-stone">累计流量</p>
            <RateChart kind="bytes" range={range} data={t?.series ?? []} />
          </div>
        </div>

        <div className="flex flex-col gap-3 md:hidden">
          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-6 text-sm text-stone shadow-border">
              暂无映射。
            </p>
          ) : (
            filteredMaps.map((m) => (
              <article
                key={m.id}
                role="button"
                tabIndex={0}
                aria-pressed={mappingId === m.id}
                className={cn(
                  "cursor-pointer rounded-xl bg-card p-4 text-left shadow-border",
                  mappingId === m.id && "ring-1 ring-pine/30",
                )}
                onClick={() => pickMapping(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pickMapping(m.id);
                  }
                }}
              >
                <p className="font-medium">{m.name}</p>
                <p className="mt-1 text-xs text-stone">
                  {m.nodeName} · {m.proto.toUpperCase()}
                </p>
                <p className="mt-2 font-mono text-xs tabular-nums text-ink-soft">
                  入 {formatBytes(m.bytesIn)} · 出 {formatBytes(m.bytesOut)}
                  {(m.bpsIn ?? 0) + (m.bpsOut ?? 0) > 0
                    ? ` · ${formatBps((m.bpsIn ?? 0) + (m.bpsOut ?? 0))}`
                    : ""}
                  {m.proto === "udp"
                    ? ` · UDP 活跃会话 ${m.udpActive ?? m.activeConns}`
                    : ` · 连接 ${m.activeConns}`}
                </p>
                <UdpDropNote mapping={m} block />
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-hidden rounded-xl bg-card shadow-border md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[8%]" />
                <col className="w-[16%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
                <col className="w-[22%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-line text-xs text-stone">
                  <th className="px-4 py-3 font-medium">映射</th>
                  <th className="px-4 py-3 font-medium">协议</th>
                  <th className="px-4 py-3 font-medium">节点</th>
                  <th className="px-4 py-3 font-medium">入站</th>
                  <th className="px-4 py-3 font-medium">出站</th>
                  <th className="px-4 py-3 font-medium">速率</th>
                  <th className="px-4 py-3 font-medium">连接 / UDP 丢弃</th>
                </tr>
              </thead>
              <tbody>
              {pageData.total === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-stone" colSpan={7}>
                    暂无映射。
                  </td>
                </tr>
              ) : (
                filteredMaps.map((m) => (
                  <tr
                    key={m.id}
                    tabIndex={0}
                    aria-selected={mappingId === m.id}
                    className={cn(
                      "cursor-pointer border-b border-line/70 last:border-0 hover:bg-paper-2/50",
                      mappingId === m.id && "bg-paper-2",
                    )}
                    onClick={() => pickMapping(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pickMapping(m.id);
                      }
                    }}
                  >
                    <td className="truncate px-4 py-3 font-medium">{m.name}</td>
                    <td className="px-4 py-3 font-mono text-xs uppercase">{m.proto}</td>
                    <td className="truncate px-4 py-3 text-ink-soft">{m.nodeName}</td>
                    <td className="truncate px-4 py-3 font-mono text-xs tabular-nums whitespace-nowrap">
                      {formatBytes(m.bytesIn)}
                    </td>
                    <td className="truncate px-4 py-3 font-mono text-xs tabular-nums whitespace-nowrap">
                      {formatBytes(m.bytesOut)}
                    </td>
                    <td className="truncate px-4 py-3 font-mono text-xs tabular-nums whitespace-nowrap text-ink-soft">
                      {formatBps((m.bpsIn ?? 0) + (m.bpsOut ?? 0))}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      <div className="whitespace-nowrap">
                        {m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns}
                      </div>
                      <UdpDropNote mapping={m} block />
                    </td>
                  </tr>
                ))
              )}
              </tbody>
            </table>
          </div>
        </div>
        {pageData.total > 0 ? (
          <Pager
            page={pageData.page}
            size={pageData.size}
            total={pageData.total}
            onPage={setPage}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function UdpDropNote({ mapping: m, block = false }: { mapping: Mapping; block?: boolean }) {
  if (m.proto !== "udp") return null;
  const maxConns = m.udpDropMaxConns ?? 0;
  const perIp = m.udpDropPerIP ?? 0;
  const rate = m.udpDropRate ?? 0;
  const total = maxConns + perIp + rate;
  if (total <= 0) return null;
  const text = `丢弃 ${total}（连接数 ${maxConns} · 单 IP ${perIp} · 限速 ${rate}）`;
  if (block) return <p className="mt-1 truncate text-xs text-stone">{text}</p>;
  return <span className="text-xs text-stone"> · {text}</span>;
}

function LiveHint() {
  const { connected } = useLiveStatus();
  return (
    <span
      className={cn(
        "text-[11px] tracking-wide uppercase",
        connected ? "text-ink-soft" : "text-stone",
      )}
    >
      {connected ? "实时推送" : "等待通道"}
    </span>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-stone">{hint}</p> : null}
    </div>
  );
}
