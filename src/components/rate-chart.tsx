"use client";

import { formatBps, formatBytes } from "@/lib/umbra/format";
import { seriesToRate, trafficRangeMs, type TrafficRange } from "@/lib/umbra/live";
import type { TrafficPoint } from "@/lib/umbra/types";
import { useTheme } from "@/components/app-providers";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { AxisPointerComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { LineSeriesOption } from "echarts/charts";
import type {
  AxisPointerComponentOption,
  GridComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import type { ComposeOption } from "echarts/core";

type ECOption = ComposeOption<
  LineSeriesOption | GridComponentOption | TooltipComponentOption | AxisPointerComponentOption
>;

echarts.use([LineChart, GridComponent, TooltipComponent, AxisPointerComponent, CanvasRenderer]);

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

function formatX(t: number, span: number): string {
  const d = new Date(t);
  if (span > 36 * 3600 * 1000) {
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric" });
  }
  if (span < 4 * 60 * 1000) {
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTooltipTime(t: number, span: number): string {
  const d = new Date(t);
  if (span > 36 * 3600 * 1000) {
    return d.toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return formatX(t, span);
}

function toPairs(data: TrafficPoint[], kind: "rate" | "bytes"): [number, number][][] {
  const src =
    kind === "rate"
      ? seriesToRate(data).map((p) => ({ t: Date.parse(p.ts), inn: p.bpsIn, out: p.bpsOut }))
      : data.map((p) => ({ t: Date.parse(p.ts), inn: p.bytesIn, out: p.bytesOut }));
  const inn: [number, number][] = [];
  const out: [number, number][] = [];
  for (const p of src) {
    if (!Number.isFinite(p.t)) continue;
    inn.push([p.t, p.inn]);
    out.push([p.t, p.out]);
  }
  return [inn, out];
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
  range = "24h",
}: {
  data: TrafficPoint[];
  emptyAction?: ReactNode;
  kind: "rate" | "bytes";
  range?: TrafficRange;
}) {
  useTheme();
  const live = cssVar("--live", "#1e7a45");
  const amber = cssVar("--amber", "#8d7344");
  const stone = cssVar("--stone", "#8a8478");
  const card = cssVar("--card", "#f7f4ec");
  const line = cssVar("--line", "#d9d2c4");
  const ink = cssVar("--ink", "#1a1814");
  const formatTick = kind === "rate" ? formatBps : formatBytes;
  const reduced = usePrefersReducedMotion();
  const [inn, out] = useMemo(() => toPairs(data, kind), [data, kind]);
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const hasBytes = data.some((p) => p.bytesIn > 0 || p.bytesOut > 0);
  const waitingRate = kind === "rate" && inn.length === 0;
  const showChart = hasBytes && !waitingRate && data.length > 0;

  const option = useMemo<ECOption>(() => {
    const span = trafficRangeMs(range);
    const last = inn[inn.length - 1]?.[0] ?? Date.now();
    const xMax = Math.max(Date.now(), last);
    const xMin = xMax - span;
    return {
      useUTC: false,
      animation: !reduced,
      animationDuration: 400,
      animationDurationUpdate: reduced ? 0 : 200,
      grid: { top: 12, right: 12, left: 4, bottom: 4, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: line, width: 1 } },
        backgroundColor: card,
        borderColor: line,
        borderWidth: 1,
        textStyle: { color: ink, fontSize: 12 },
        extraCssText: "border-radius:10px;",
        formatter: (params) => {
          const items = (Array.isArray(params) ? params : [params]) as {
            seriesName?: string;
            value?: [number, number];
            marker?: string;
          }[];
          const t = items[0]?.value?.[0];
          if (t == null || Number.isNaN(Number(t))) return "";
          const rows = [`<div>${formatTooltipTime(Number(t), span)}</div>`];
          for (const it of items) {
            rows.push(
              `<div>${it.marker ?? ""}${it.seriesName ?? ""} ${formatTick(Number(it.value?.[1] ?? 0))}</div>`,
            );
          }
          return rows.join("");
        },
      },
      xAxis: {
        type: "time",
        min: xMin,
        max: xMax,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: stone,
          fontSize: 11,
          hideOverlap: true,
          formatter: (v) => formatX(Number(v), span),
        },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: (extent) => (extent.max > 0 ? extent.max * 1.08 : 1),
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: stone,
          fontSize: 11,
          formatter: (v) => formatTick(Number(v)).replace(/\s/g, ""),
        },
      },
      series: [
        {
          name: "出站",
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          lineStyle: { width: 2, color: amber, cap: "round", join: "round" },
          itemStyle: { color: amber },
          areaStyle: { color: amber, opacity: 0.28 },
          data: out,
          z: 1,
        },
        {
          name: "入站",
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          lineStyle: { width: 2.5, color: live, cap: "round", join: "round" },
          itemStyle: { color: live },
          data: inn,
          z: 2,
        },
      ],
    };
  }, [amber, card, formatTick, inn, ink, line, live, out, range, reduced, stone]);

  useEffect(() => {
    if (!showChart) return;
    const el = elRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [showChart]);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option, showChart]);

  if (data.length === 0 || !hasBytes) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>
          {kind === "rate"
            ? "还没有流量。有数据后这里显示实时速率。"
            : "还没有流量。映射在线后会在这里累计。"}
        </span>
        {emptyAction}
      </div>
    );
  }

  if (waitingRate) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-center text-sm text-stone">
        <span>再等一个采样即可画出速率。</span>
        {emptyAction}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-3">
        <Swatch color={live} label="入站" />
        <Swatch color={amber} label="出站" />
      </div>
      <div ref={elRef} className="h-52 w-full" role="img" aria-label={kind === "rate" ? "实时速率" : "累计流量"} />
    </div>
  );
}
