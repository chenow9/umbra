import { createContext, useContext } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { LiveEvent, Mapping, TrafficPoint, TrafficView } from "./types.ts";
import { pageMappings, pageNodes, type MappingQuery, type NodeQuery } from "./page.ts";

export const LiveStatusCtx = createContext({ connected: false });

export function useLiveStatus() {
  return useContext(LiveStatusCtx);
}

export type TrafficRange = "1h" | "24h" | "7d";

export function trafficRangeMs(range: string): number {
  if (range === "1h") return 3_600_000;
  if (range === "7d") return 7 * 86_400_000;
  return 86_400_000;
}

function upsertByTs(series: TrafficPoint[], point: TrafficPoint): TrafficPoint[] {
  if (series.length === 0) return [point];
  const last = series[series.length - 1];
  if (last.ts === point.ts) {
    const next = series.slice();
    next[next.length - 1] = point;
    return next;
  }
  return [...series, point];
}

function replaceLast(series: TrafficPoint[], point: TrafficPoint): TrafficPoint[] {
  if (series.length === 0) return [point];
  const next = series.slice(0, -1);
  next.push(point);
  return next;
}

function tsAt(series: TrafficPoint[], i: number): number {
  return Date.parse(series[i].ts);
}

function trimToRange(series: TrafficPoint[], range: string, nowMs: number): TrafficPoint[] {
  const cutoff = nowMs - trafficRangeMs(range);
  let i = 0;
  while (i < series.length && tsAt(series, i) < cutoff) i++;
  return i === 0 ? series : series.slice(i);
}

function filteredSample(ev: LiveEvent, nodeId: string, mappingId: string): TrafficPoint | null {
  if (!ev.sample) return null;
  if (!nodeId && !mappingId) {
    return { ts: ev.sample.ts, bytesIn: ev.sample.bytesIn, bytesOut: ev.sample.bytesOut };
  }
  const maps = ev.mappings.filter((m) => {
    if (mappingId && m.id !== mappingId) return false;
    if (nodeId && m.nodeId !== nodeId) return false;
    return true;
  });
  let bytesIn = 0;
  let bytesOut = 0;
  for (const m of maps) {
    const p = ev.sample.by?.[m.id];
    if (p) {
      bytesIn += p.bytesIn;
      bytesOut += p.bytesOut;
    }
  }
  return { ts: ev.sample.ts, bytesIn, bytesOut };
}

function liveTotals(mappings: Mapping[], nodeId: string, mappingId: string) {
  const maps = mappings.filter((m) => {
    if (mappingId && m.id !== mappingId) return false;
    if (nodeId && m.nodeId !== nodeId) return false;
    return true;
  });
  return {
    bytesIn: maps.reduce((s, m) => s + m.bytesIn, 0),
    bytesOut: maps.reduce((s, m) => s + m.bytesOut, 0),
  };
}

export function seriesToRate(series: TrafficPoint[]): { ts: string; bpsIn: number; bpsOut: number }[] {
  const out: { ts: string; bpsIn: number; bpsOut: number }[] = [];
  for (let i = 1; i < series.length; i++) {
    const dt = (Date.parse(series[i].ts) - Date.parse(series[i - 1].ts)) / 1000;
    let bpsIn = 0;
    let bpsOut = 0;
    if (dt > 0) {
      const dIn = series[i].bytesIn - series[i - 1].bytesIn;
      const dOut = series[i].bytesOut - series[i - 1].bytesOut;
      if (dIn > 0) bpsIn = dIn / dt;
      if (dOut > 0) bpsOut = dOut / dt;
    }
    out.push({ ts: series[i].ts, bpsIn, bpsOut });
  }
  return out;
}

export function peakBpsFromSeries(series: TrafficPoint[]): { in: number; out: number } {
  let peakIn = 0;
  let peakOut = 0;
  for (const p of seriesToRate(series)) {
    if (p.bpsIn > peakIn) peakIn = p.bpsIn;
    if (p.bpsOut > peakOut) peakOut = p.bpsOut;
  }
  return { in: peakIn, out: peakOut };
}

export function liveBps(ev: LiveEvent, nodeId: string, mappingId: string): { in: number; out: number } {
  if (!nodeId && !mappingId) {
    return { in: ev.overview?.bpsIn ?? 0, out: ev.overview?.bpsOut ?? 0 };
  }
  let inn = 0;
  let out = 0;
  for (const m of ev.mappings) {
    if (mappingId && m.id !== mappingId) continue;
    if (nodeId && m.nodeId !== nodeId) continue;
    inn += m.bpsIn ?? 0;
    out += m.bpsOut ?? 0;
  }
  return { in: inn, out: out };
}

export function mergeTrafficView(old: TrafficView | undefined, ev: LiveEvent, key: QueryKey): TrafficView {
  const range = String(key[2] ?? "24h");
  const nodeId = key.length >= 4 ? String(key[3] ?? "") : "";
  const mappingId = key.length >= 5 ? String(key[4] ?? "") : "";
  const totals = liveTotals(ev.mappings, nodeId, mappingId);
  let series = old?.series ? old.series.slice() : [];
  const sample = filteredSample(ev, nodeId, mappingId);
  const livePoint: TrafficPoint =
    sample && ev.mappings.length === 0 && !nodeId && !mappingId
      ? { ts: ev.ts, bytesIn: sample.bytesIn, bytesOut: sample.bytesOut }
      : { ts: ev.ts, bytesIn: totals.bytesIn, bytesOut: totals.bytesOut };
  const liveAt = Date.parse(ev.ts);
  // Samples are ~10s; live ticks are ~1s. Keep committed samples plus one live tail.
  if (sample) {
    const sampleAt = Date.parse(sample.ts);
    while (series.length && tsAt(series, series.length - 1) > sampleAt) {
      series.pop();
    }
    if (series.length >= 2) {
      const lastAt = tsAt(series, series.length - 1);
      const prevAt = tsAt(series, series.length - 2);
      if (lastAt < sampleAt && lastAt - prevAt < 8_000) {
        series.pop();
      }
    }
    series = upsertByTs(series, sample);
    const lastAt = tsAt(series, series.length - 1);
    series = liveAt > lastAt + 500 ? [...series, livePoint] : replaceLast(series, livePoint);
  } else if (series.length === 0) {
    series = [livePoint];
  } else {
    const lastAt = tsAt(series, series.length - 1);
    const prevAt = series.length > 1 ? tsAt(series, series.length - 2) : Number.NaN;
    const lastIsLiveTail = series.length === 1 || (Number.isFinite(prevAt) && lastAt - prevAt < 8_000);
    if (lastIsLiveTail && liveAt + 1 >= lastAt) {
      series = replaceLast(series, livePoint);
    } else if (liveAt > lastAt) {
      series = [...series, livePoint];
    }
  }
  series = trimToRange(series, range, liveAt);
  const rates = liveBps(ev, nodeId, mappingId);
  const fromSeries = peakBpsFromSeries(series);
  return {
    bytesIn: totals.bytesIn,
    bytesOut: totals.bytesOut,
    bpsIn: rates.in,
    bpsOut: rates.out,
    peakBpsIn: Math.max(old?.peakBpsIn ?? 0, fromSeries.in, rates.in),
    peakBpsOut: Math.max(old?.peakBpsOut ?? 0, fromSeries.out, rates.out),
    series,
  };
}

export function applyLiveEvent(qc: QueryClient, ev: LiveEvent) {
  qc.setQueryData(["umbra", "overview"], ev.overview);
  qc.setQueryData(["umbra", "nodes"], ev.nodes);
  qc.setQueryData(["umbra", "mappings"], ev.mappings);
  for (const query of qc.getQueryCache().findAll({ queryKey: ["umbra", "nodes", "page"] })) {
    const params = query.queryKey[3] as NodeQuery | undefined;
    if (!params?.page || !params.size) continue;
    qc.setQueryData(query.queryKey, pageNodes(ev.nodes, params));
  }
  for (const query of qc.getQueryCache().findAll({ queryKey: ["umbra", "mappings", "page"] })) {
    const params = query.queryKey[3] as MappingQuery | undefined;
    if (!params?.page || !params.size) continue;
    qc.setQueryData(query.queryKey, pageMappings(ev.mappings, params));
  }
  for (const query of qc.getQueryCache().findAll({ queryKey: ["umbra", "traffic"] })) {
    qc.setQueryData(query.queryKey, (old: TrafficView | undefined) => mergeTrafficView(old, ev, query.queryKey));
  }
}
