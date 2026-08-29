"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBytes } from "@/lib/umbra/format";
import type { TrafficPoint } from "@/lib/umbra/types";
import { useTheme } from "@/components/app-providers";
import type { ReactNode } from "react";

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function RateChart({
  data,
  emptyAction,
}: {
  data: TrafficPoint[];
  emptyAction?: ReactNode;
}) {
  useTheme();
  const pine = cssVar("--pine", "#2c4a3e");
  const stone = cssVar("--stone", "#8a8478");
  const card = cssVar("--card", "#f7f4ec");
  const line = cssVar("--line", "#d9d2c4");
  const ink = cssVar("--ink", "#1a1814");

  const hasTraffic = data.some((p) => p.bytesIn > 0 || p.bytesOut > 0);
  if (data.length === 0 || !hasTraffic) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>还没有流量。映射在线后会在这里累计。</span>
        {emptyAction}
      </div>
    );
  }

  const t0 = new Date(data[0].ts).getTime();
  const t1 = new Date(data[data.length - 1].ts).getTime();
  const daily = t1 - t0 > 36 * 3600 * 1000;
  const rows = data.map((p) => ({
    ts: p.ts,
    入站: p.bytesIn,
    出站: p.bytesOut,
    label: daily
      ? new Date(p.ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
      : new Date(p.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  }));

  return (
    <div className="h-48 w-full overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <XAxis
            dataKey="label"
            tick={{ fill: stone, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: stone, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => formatBytes(v)}
          />
          <Tooltip
            contentStyle={{
              background: card,
              border: `1px solid ${line}`,
              borderRadius: 10,
              fontSize: 12,
              color: ink,
            }}
            formatter={(value) => formatBytes(Number(value ?? 0))}
          />
          <Area
            type="monotone"
            dataKey="出站"
            stroke={pine}
            fill={pine}
            fillOpacity={0.16}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="入站"
            stroke={stone}
            fill={stone}
            fillOpacity={0.12}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
