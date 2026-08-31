"use client";

import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { seriesToRate } from "@/lib/umbra/live";
import type { TrafficPoint } from "@/lib/umbra/types";
import { useTheme } from "@/components/app-providers";
import { useId, type ReactNode } from "react";

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

export function RateChart({
  data,
  emptyAction,
  kind,
}: {
  data: TrafficPoint[];
  emptyAction?: ReactNode;
  kind: "rate" | "bytes";
}) {
  useTheme();
  const gid = useId().replace(/:/g, "");
  const live = cssVar("--live", "#1e7a45");
  const amber = cssVar("--amber", "#8d7344");
  const stone = cssVar("--stone", "#8a8478");
  const card = cssVar("--card", "#f7f4ec");
  const line = cssVar("--line", "#d9d2c4");
  const ink = cssVar("--ink", "#1a1814");
  const outFill = `out-${gid}`;
  const formatTick = kind === "rate" ? formatBps : formatBytes;

  const hasBytes = data.some((p) => p.bytesIn > 0 || p.bytesOut > 0);
  if (data.length === 0 || !hasBytes) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>{kind === "rate" ? "还没有流量。有数据后这里显示实时速率。" : "还没有流量。映射在线后会在这里累计。"}</span>
        {emptyAction}
      </div>
    );
  }

  const rates = seriesToRate(data);
  if (kind === "rate" && rates.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>再等一个采样即可画出速率。</span>
        {emptyAction}
      </div>
    );
  }

  const src =
    kind === "rate"
      ? rates.map((p) => ({ ts: p.ts, 入站: p.bpsIn, 出站: p.bpsOut }))
      : data.map((p) => ({ ts: p.ts, 入站: p.bytesIn, 出站: p.bytesOut }));
  const t0 = new Date(src[0].ts).getTime();
  const t1 = new Date(src[src.length - 1].ts).getTime();
  const daily = t1 - t0 > 36 * 3600 * 1000;
  const rows = src.map((p) => ({
    ...p,
    label: daily
      ? new Date(p.ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
      : new Date(p.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  }));

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-3">
        <Swatch color={live} label="入站" />
        <Swatch color={amber} label="出站" />
      </div>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 18, right: 8, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id={outFill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={amber} stopOpacity={0.4} />
                <stop offset="100%" stopColor={amber} stopOpacity={0.05} />
              </linearGradient>
            </defs>
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
              width={80}
              tickMargin={6}
              domain={[0, (max: number) => (max > 0 ? max * 1.08 : 1)]}
              tickFormatter={(v: number) => formatTick(v).replace(/\s/g, "")}
            />
            <Tooltip
              contentStyle={{
                background: card,
                border: `1px solid ${line}`,
                borderRadius: 10,
                fontSize: 12,
                color: ink,
              }}
              formatter={(value) => formatTick(Number(value ?? 0))}
            />
            <Area
              type="monotone"
              dataKey="出站"
              stroke={amber}
              fill={`url(#${outFill})`}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: amber }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="入站"
              stroke={live}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: live }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
