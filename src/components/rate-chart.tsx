"use client";

import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { seriesToRate } from "@/lib/umbra/live";
import { downsampleChart, paddedMax, stepYMax, type ChartPt } from "@/lib/umbra/chart-smooth";
import type { TrafficPoint } from "@/lib/umbra/types";
import { useTheme } from "@/components/app-providers";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

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

function toChartPts(data: TrafficPoint[], kind: "rate" | "bytes"): ChartPt[] {
  const src =
    kind === "rate"
      ? seriesToRate(data).map((p) => ({ t: Date.parse(p.ts), inn: p.bpsIn, out: p.bpsOut }))
      : data.map((p) => ({ t: Date.parse(p.ts), inn: p.bytesIn, out: p.bytesOut }));
  return downsampleChart(src.filter((p) => Number.isFinite(p.t)));
}

function formatX(t: number, span: number): string {
  const d = new Date(t);
  if (span > 36 * 3600 * 1000) {
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (span < 4 * 60 * 1000) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function usePlotMax(target: ChartPt[]): number {
  const [yMax, setYMax] = useState(() => paddedMax(target));
  const yRef = useRef(yMax);
  const headRef = useRef(target[0]?.t ?? 0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const sig =
    target.length === 0
      ? "0"
      : `${target.length}:${target[0].t}:${target[target.length - 1].t}:${target[target.length - 1].inn}:${target[target.length - 1].out}`;

  useEffect(() => {
    const pts = targetRef.current;
    const next = paddedMax(pts);
    const head = pts[0]?.t ?? 0;
    if (pts.length === 0 || head !== headRef.current) {
      headRef.current = head;
      yRef.current = next;
      setYMax(next);
      return;
    }
    const stepped = stepYMax(yRef.current, next);
    yRef.current = stepped;
    setYMax(stepped);
  }, [sig]);

  return Math.max(1, yMax);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
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
  const target = useMemo(() => toChartPts(data, kind), [data, kind]);
  const yMax = usePlotMax(target);
  const reduced = usePrefersReducedMotion();
  const plot = useMemo(() => target.map((p) => ({ t: p.t, 入站: p.inn, 出站: p.out })), [target]);

  const hasBytes = data.some((p) => p.bytesIn > 0 || p.bytesOut > 0);
  if (data.length === 0 || !hasBytes) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>{kind === "rate" ? "还没有流量。有数据后这里显示实时速率。" : "还没有流量。映射在线后会在这里累计。"}</span>
        {emptyAction}
      </div>
    );
  }

  if (kind === "rate" && target.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>再等一个采样即可画出速率。</span>
        {emptyAction}
      </div>
    );
  }

  const xMin = target[0].t;
  const xMax = target[target.length - 1].t;
  const span = Math.max(0, xMax - xMin);
  const animate = !reduced;

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-3">
        <Swatch color={live} label="入站" />
        <Swatch color={amber} label="出站" />
      </div>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plot} margin={{ top: 18, right: 8, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id={outFill} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={amber} stopOpacity={0.4} />
                <stop offset="100%" stopColor={amber} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              type="number"
              domain={[xMin === xMax ? xMin - 1000 : xMin, xMin === xMax ? xMax + 1000 : xMax]}
              tick={{ fill: stone, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
              tickFormatter={(v: number) => formatX(v, span)}
            />
            <YAxis
              tick={{ fill: stone, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={80}
              tickMargin={6}
              domain={[0, yMax]}
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
              labelFormatter={(value) => formatX(Number(value), span)}
              formatter={(value) => formatTick(Number(value ?? 0))}
            />
            <Area
              type="monotone"
              dataKey="出站"
              stroke={amber}
              fill={`url(#${outFill})`}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: amber }}
              isAnimationActive={animate}
              animationDuration={700}
              animationEasing="ease-out"
              animationBegin={0}
              baseValue={0}
            />
            <Line
              type="monotone"
              dataKey="入站"
              stroke={live}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: live }}
              isAnimationActive={animate}
              animationDuration={700}
              animationEasing="ease-out"
              animationBegin={0}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
