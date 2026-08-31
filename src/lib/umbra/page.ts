import { modeHint, modeLabel, reachLabel } from "./labels.ts";
import type { AuditItem, Mapping, Node, NodeStatus } from "./types.ts";

export const PAGE_SIZE = 10;

export type ListPage<T> = {
  items: T[];
  total: number;
  page: number;
  size: number;
};

export type NodeQuery = {
  q?: string;
  status?: string;
  os?: string;
  page: number;
  size: number;
};

export type MappingFilter = {
  q?: string;
  nodeId?: string;
  proto?: string;
  mode?: string;
  reach?: string;
};

export type MappingQuery = MappingFilter & {
  page: number;
  size: number;
};

export type MappingGroup = {
  nodeId: string;
  nodeName: string;
  nodeStatus: NodeStatus;
  items: Mapping[];
};

export type FacetOption = {
  value: string;
  label: string;
  hint?: string;
  count: number;
  status?: NodeStatus;
};

export type MappingFacets = {
  nodes: FacetOption[];
  protos: FacetOption[];
  modes: FacetOption[];
  reaches: FacetOption[];
};

export type AuditQuery = {
  q?: string;
  action?: string;
  page: number;
  size: number;
};

export function emptyPage<T>(page = 1, size = PAGE_SIZE): ListPage<T> {
  return { items: [], total: 0, page, size };
}

function clampPage(total: number, page: number, size: number) {
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  return Math.min(Math.max(1, page), pages);
}

export function pageOf<T>(rows: T[], page: number, size: number): ListPage<T> {
  const total = rows.length;
  const p = clampPage(total, page, size);
  const start = (p - 1) * size;
  return { items: rows.slice(start, start + size), total, page: p, size };
}

export function filterNodes(rows: Node[], q: NodeQuery): Node[] {
  const needle = (q.q ?? "").trim().toLowerCase();
  const status = (q.status ?? "").trim();
  const os = (q.os ?? "").trim();
  return rows.filter((n) => {
    if (status && n.status !== status) return false;
    if (os && n.os !== os) return false;
    if (!needle) return true;
    return `${n.name} ${n.comment} ${n.addr ?? ""} ${n.os} ${n.arch}`.toLowerCase().includes(needle);
  });
}

export function filterMappings(rows: Mapping[], q: MappingFilter): Mapping[] {
  const needle = (q.q ?? "").trim().toLowerCase();
  const nodeId = (q.nodeId ?? "").trim();
  const proto = (q.proto ?? "").trim();
  const mode = (q.mode ?? "").trim();
  const reach = (q.reach ?? "").trim();
  return rows.filter((m) => {
    if (nodeId && m.nodeId !== nodeId) return false;
    if (proto && m.proto !== proto) return false;
    if (mode && m.mode !== mode) return false;
    if (reach && (m.reach ?? "") !== reach) return false;
    if (!needle) return true;
    return `${m.name} ${m.nodeName} ${m.proto} ${m.mode} ${m.localHost} ${m.reach ?? ""}`.toLowerCase().includes(needle);
  });
}

export function filterAudit(rows: AuditItem[], q: AuditQuery): AuditItem[] {
  const needle = (q.q ?? "").trim().toLowerCase();
  const action = (q.action ?? "").trim();
  return rows.filter((a) => {
    if (action && a.action !== action) return false;
    if (!needle) return true;
    return `${a.action} ${a.target} ${a.targetName ?? ""} ${a.detail} ${a.actor}`.toLowerCase().includes(needle);
  });
}

export function pageNodes(rows: Node[], q: NodeQuery): ListPage<Node> {
  return pageOf(filterNodes(rows, q), q.page, q.size);
}

export function pageMappings(rows: Mapping[], q: MappingQuery): ListPage<Mapping> {
  return pageOf(filterMappings(rows, q), q.page, q.size);
}

function nodeRank(status: NodeStatus) {
  if (status === "online") return 0;
  if (status === "offline") return 1;
  return 2;
}

const MODE_ORDER = ["public", "spa", "visitor"];

function compareMapping(a: Mapping, b: Mapping) {
  const mode = MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode);
  if (mode !== 0) return mode;
  const pa = a.entryPort ?? 1_000_000;
  const pb = b.entryPort ?? 1_000_000;
  if (pa !== pb) return pa - pb;
  return a.name.localeCompare(b.name, "zh");
}

export function groupMappings(rows: Mapping[], q: MappingFilter = {}): MappingGroup[] {
  const by = new Map<string, Mapping[]>();
  for (const m of filterMappings(rows, q)) {
    const list = by.get(m.nodeId);
    if (list) list.push(m);
    else by.set(m.nodeId, [m]);
  }
  const groups: MappingGroup[] = [];
  for (const [nodeId, items] of by) {
    items.sort(compareMapping);
    const first = items[0];
    groups.push({
      nodeId,
      nodeName: first.nodeName,
      nodeStatus: first.nodeStatus,
      items,
    });
  }
  groups.sort((a, b) => {
    const d = nodeRank(a.nodeStatus) - nodeRank(b.nodeStatus);
    if (d !== 0) return d;
    return a.nodeName.localeCompare(b.nodeName, "zh");
  });
  return groups;
}

const PROTO_ORDER = ["tcp", "udp"];
const REACH_ORDER = ["open", "closed", "full", "visitor", "offline", "pending", "error", "disabled"];

function tally(rows: Mapping[], key: (m: Mapping) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function orderedFacets(
  counts: Map<string, number>,
  order: string[],
  labels: Record<string, string>,
  hints?: Record<string, string>,
): FacetOption[] {
  const out: FacetOption[] = [];
  const seen = new Set<string>();
  for (const value of order) {
    const count = counts.get(value);
    if (!count) continue;
    seen.add(value);
    out.push({ value, label: labels[value] ?? value, hint: hints?.[value], count });
  }
  for (const [value, count] of counts) {
    if (seen.has(value) || !count) continue;
    out.push({ value, label: labels[value] ?? value, hint: hints?.[value], count });
  }
  return out;
}

export function mappingFacets(rows: Mapping[]): MappingFacets {
  const nodesBy = new Map<string, { name: string; status: NodeStatus; count: number }>();
  for (const m of rows) {
    const cur = nodesBy.get(m.nodeId);
    if (cur) cur.count += 1;
    else nodesBy.set(m.nodeId, { name: m.nodeName, status: m.nodeStatus, count: 1 });
  }
  const nodes = [...nodesBy.entries()]
    .map(([value, info]) => ({
      value,
      label: info.name,
      count: info.count,
      status: info.status,
    }))
    .sort((a, b) => {
      const d = nodeRank(a.status) - nodeRank(b.status);
      if (d !== 0) return d;
      return a.label.localeCompare(b.label, "zh");
    });

  return {
    nodes,
    protos: orderedFacets(tally(rows, (m) => m.proto), PROTO_ORDER, { tcp: "TCP", udp: "UDP" }),
    modes: orderedFacets(tally(rows, (m) => m.mode), MODE_ORDER, modeLabel, modeHint),
    reaches: orderedFacets(tally(rows, (m) => m.reach ?? ""), REACH_ORDER, reachLabel),
  };
}

export function sortMappings(rows: Mapping[]): Mapping[] {
  return [...rows].sort((a, b) => {
    const d = nodeRank(a.nodeStatus) - nodeRank(b.nodeStatus);
    if (d !== 0) return d;
    const n = a.nodeName.localeCompare(b.nodeName, "zh");
    if (n !== 0) return n;
    return compareMapping(a, b);
  });
}

export function preferredNodeId(nodes: FacetOption[], requested?: string): string {
  if (requested && nodes.some((n) => n.value === requested)) return requested;
  return nodes.find((n) => n.status === "online")?.value ?? nodes[0]?.value ?? "all";
}

export function mergeNodeOptions(
  facets: FacetOption[],
  nodes: { id: string; name: string; status: NodeStatus }[],
): FacetOption[] {
  const byId = new Map(facets.map((n) => [n.value, n]));
  for (const n of nodes) {
    if (n.status === "revoked") continue;
    if (!byId.has(n.id)) {
      byId.set(n.id, { value: n.id, label: n.name, count: 0, status: n.status });
    }
  }
  return [...byId.values()].sort((a, b) => {
    const d = nodeRank(a.status ?? "offline") - nodeRank(b.status ?? "offline");
    if (d !== 0) return d;
    return a.label.localeCompare(b.label, "zh");
  });
}

export function filterNodeOptions<T extends { label: string }>(nodes: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.filter((n) => n.label.toLowerCase().includes(needle));
}

export function defaultGroupOpen(groups: MappingGroup[], focusNodeId?: string): Record<string, boolean> {
  const few = groups.length <= 4;
  const open: Record<string, boolean> = {};
  for (const g of groups) {
    open[g.nodeId] = focusNodeId ? g.nodeId === focusNodeId : few || g.nodeStatus === "online";
  }
  return open;
}

export function pageAudit(rows: AuditItem[], q: AuditQuery): ListPage<AuditItem> {
  return pageOf(filterAudit(rows, q), q.page, q.size);
}
