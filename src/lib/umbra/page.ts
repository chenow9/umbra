import type { AuditItem, Mapping, Node } from "./types.ts";

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

export type MappingQuery = {
  q?: string;
  nodeId?: string;
  proto?: string;
  mode?: string;
  reach?: string;
  page: number;
  size: number;
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

export function filterMappings(rows: Mapping[], q: MappingQuery): Mapping[] {
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

export function pageAudit(rows: AuditItem[], q: AuditQuery): ListPage<AuditItem> {
  return pageOf(filterAudit(rows, q), q.page, q.size);
}
