"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { RateChart } from "@/components/rate-chart";
import { SelectField } from "@/components/field";
import { getTraffic, listAgents, listMappings } from "@/lib/umbra/actions";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { cn } from "@/lib/utils";

type Range = "1h" | "24h" | "7d";

export function TrafficPage() {
  const [range, setRange] = useState<Range>("24h");
  const [agentId, setAgentId] = useState("");
  const [mappingId, setMappingId] = useState("");
  const agents = useQuery({ queryKey: ["umbra", "agents"], queryFn: () => listAgents() });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: () => listMappings() });
  const traffic = useQuery({
    queryKey: ["umbra", "traffic", range, agentId, mappingId],
    queryFn: () =>
      getTraffic({
        data: {
          range,
          agentId: agentId || undefined,
          mappingId: mappingId || undefined,
        },
      }),
  });

  const t = traffic.data;
  const filteredMaps = (mappings.data ?? []).filter((m) => !agentId || m.agentId === agentId);

  return (
    <AppShell title="流量">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex rounded-md bg-paper-2 p-0.5 shadow-border">
            {(["1h", "24h", "7d"] as const).map((r) => (
              <button
                key={r}
                type="button"
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
          <SelectField
            label="节点"
            value={agentId || "all"}
            onValueChange={(v) => {
              setAgentId(v === "all" ? "" : v);
              setMappingId("");
            }}
            options={[
              { value: "all", label: "全部" },
              ...(agents.data ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <SelectField
            label="映射"
            value={mappingId || "all"}
            onValueChange={(v) => setMappingId(v === "all" ? "" : v)}
            options={[
              { value: "all", label: "全部" },
              ...filteredMaps.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </div>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Mini label="入站累计" value={formatBytes(t?.bytesIn ?? 0)} />
          <Mini label="出站累计" value={formatBytes(t?.bytesOut ?? 0)} />
          <Mini label="入站峰值" value={formatBps(t?.peakBpsIn ?? 0)} />
          <Mini label="出站峰值" value={formatBps(t?.peakBpsOut ?? 0)} />
        </section>

        <div className="rounded-xl bg-card p-4 shadow-border">
          <RateChart data={t?.series ?? []} />
        </div>

        <div className="flex flex-col gap-3 md:hidden">
          {filteredMaps.length === 0 ? (
            <p className="rounded-xl bg-card px-4 py-6 text-sm text-stone shadow-border">暂无映射。</p>
          ) : (
            filteredMaps.map((m) => (
              <article key={m.id} className="rounded-xl bg-card p-4 shadow-border">
                <p className="font-medium">{m.name}</p>
                <p className="mt-1 text-xs text-stone">
                  {m.agentName} · {m.proto.toUpperCase()}
                </p>
                <p className="mt-2 font-mono text-xs tabular-nums text-ink-soft">
                  入 {formatBytes(m.bytesIn)} · 出 {formatBytes(m.bytesOut)}
                </p>
              </article>
            ))
          )}
        </div>
        <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-stone">
                <th className="px-4 py-3 font-medium">映射</th>
                <th className="px-4 py-3 font-medium">协议</th>
                <th className="px-4 py-3 font-medium">节点</th>
                <th className="px-4 py-3 font-medium">入站</th>
                <th className="px-4 py-3 font-medium">出站</th>
                <th className="px-4 py-3 font-medium">连接</th>
              </tr>
            </thead>
            <tbody>
              {filteredMaps.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-stone" colSpan={6}>
                    暂无映射。
                  </td>
                </tr>
              ) : (
                filteredMaps.map((m) => (
                  <tr key={m.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-3 font-medium">{m.name}</td>
                    <td className="px-4 py-3 font-mono text-xs uppercase">{m.proto}</td>
                    <td className="px-4 py-3 text-ink-soft">{m.agentName}</td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">{formatBytes(m.bytesIn)}</td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">{formatBytes(m.bytesOut)}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{m.activeConns}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
    </div>
  );
}
