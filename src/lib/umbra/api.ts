import type {
  Node,
  AuditItem,
  ControlFrameRow,
  DemoResult,
  Mapping,
  Overview,
  ProbeResult,
  TrafficView,
  VisitorIssued,
  VisitorTicket,
} from "./types";
import type { ListPage } from "./page";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!r.ok) {
    const err = data as { error?: string };
    throw new Error(err?.error || text || r.statusText);
  }
  return data as T;
}

export function getOwnerStatus() {
  return api<{ required: boolean; configured: boolean; signedIn: boolean }>("/v1/auth");
}

export function setupOwnerPassword({ data }: { data: { password: string } }) {
  return api<{ ok: true }>("/v1/setup", { method: "POST", body: JSON.stringify(data) });
}

export function loginOwnerPassword({ data }: { data: { password: string } }) {
  return api<{ ok: true }>("/v1/login", { method: "POST", body: JSON.stringify(data) });
}

export function logoutOwnerSession() {
  return api<{ ok: true }>("/v1/logout", { method: "POST" });
}

export function listNodes() {
  return api<Node[]>("/v1/nodes");
}

export function queryNodes(data: {
  q?: string;
  status?: string;
  os?: string;
  page: number;
  size: number;
}) {
  const q = new URLSearchParams();
  q.set("page", String(data.page));
  q.set("size", String(data.size));
  if (data.q) q.set("q", data.q);
  if (data.status) q.set("status", data.status);
  if (data.os) q.set("os", data.os);
  return api<ListPage<Node>>(`/v1/nodes?${q}`);
}

export function listMappings() {
  return api<Mapping[]>("/v1/mappings");
}

export function queryMappings(data: {
  q?: string;
  nodeId?: string;
  proto?: string;
  mode?: string;
  reach?: string;
  page: number;
  size: number;
}) {
  const q = new URLSearchParams();
  q.set("page", String(data.page));
  q.set("size", String(data.size));
  if (data.q) q.set("q", data.q);
  if (data.nodeId) q.set("nodeId", data.nodeId);
  if (data.proto) q.set("proto", data.proto);
  if (data.mode) q.set("mode", data.mode);
  if (data.reach) q.set("reach", data.reach);
  return api<ListPage<Mapping>>(`/v1/mappings?${q}`);
}

export function getOverview() {
  return api<Overview>("/v1/overview");
}

export function listAudit() {
  return api<AuditItem[]>("/v1/audit");
}

export function queryAudit(data: { q?: string; action?: string; page: number; size: number }) {
  const q = new URLSearchParams();
  q.set("page", String(data.page));
  q.set("size", String(data.size));
  if (data.q) q.set("q", data.q);
  if (data.action) q.set("action", data.action);
  return api<ListPage<AuditItem>>(`/v1/audit?${q}`);
}

export function listFrames() {
  return api<ControlFrameRow[]>("/v1/frames");
}

export function queryFrames(data: { page: number; size: number }) {
  const q = new URLSearchParams();
  q.set("page", String(data.page));
  q.set("size", String(data.size));
  return api<ListPage<ControlFrameRow>>(`/v1/frames?${q}`);
}

export function getTraffic({ data }: { data?: { range?: string; mappingId?: string; nodeId?: string } } = {}) {
  const q = new URLSearchParams();
  if (data?.range) q.set("range", data.range);
  if (data?.mappingId) q.set("mappingId", data.mappingId);
  if (data?.nodeId) q.set("nodeId", data.nodeId);
  const s = q.toString();
  return api<TrafficView>(`/v1/traffic${s ? `?${s}` : ""}`);
}

export function createNode({
  data,
}: {
  data: { name: string; comment?: string; os: string; arch: string; neverExpire?: boolean };
}) {
  return api<{
    id: string;
    token: string;
    os: string;
    arch: string;
    expiresAt?: string;
    neverExpire?: boolean;
    installCmd?: string;
    listen?: string;
    caURL?: string;
  }>("/v1/nodes", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getNodeBootstrap({ data }: { data: { id: string } }) {
  return api<{ token: string }>(`/v1/nodes/${encodeURIComponent(data.id)}/bootstrap`);
}

export function rotateNodeToken({ data }: { data: { id: string; neverExpire?: boolean } }) {
  return api<{
    token: string;
    graceSec: number;
    expiresAt?: string;
    neverExpire?: boolean;
    installCmd?: string;
    listen?: string;
  }>(`/v1/nodes/${encodeURIComponent(data.id)}/rotate`, {
    method: "POST",
    body: data.neverExpire === undefined ? undefined : JSON.stringify({ neverExpire: data.neverExpire }),
  });
}

export function logoutAllOwnerSessions() {
  return api<{ ok: true }>("/v1/logout-all", { method: "POST" });
}

export function helloNode({ data }: { data: { id: string } }) {
  return api<{ ok: true; pushed: number }>(`/v1/nodes/${encodeURIComponent(data.id)}/hello`, { method: "POST" });
}

export function disconnectNode({ data }: { data: { id: string } }) {
  return api<void>(`/v1/nodes/${encodeURIComponent(data.id)}/disconnect`, { method: "POST" });
}

export function revokeNode({ data }: { data: { id: string } }) {
  return api<void>(`/v1/nodes/${encodeURIComponent(data.id)}/revoke`, { method: "POST" });
}

export function updateNode({
  data,
}: {
  data: {
    id: string;
    name?: string;
    comment?: string;
    os?: string;
    arch?: string;
    neverExpire?: boolean;
  };
}) {
  const { id, ...body } = data;
  return api<Node>(`/v1/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteNode({ data }: { data: { id: string; force?: boolean } }) {
  return api<{ ok: true }>(`/v1/nodes/${encodeURIComponent(data.id)}/delete`, {
    method: "POST",
    body: JSON.stringify({ force: Boolean(data.force) }),
  });
}

export function createMapping({ data }: { data: Record<string, unknown> }) {
  return api<Mapping>("/v1/mappings", { method: "POST", body: JSON.stringify(data) });
}

export function updateMapping({ data }: { data: Record<string, unknown> & { id: string } }) {
  const { id, ...body } = data;
  return api<Mapping>(`/v1/mappings/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function setMappingEnabled({ data }: { data: { id: string; enabled: boolean } }) {
  return api<{ ok: true }>(`/v1/mappings/${encodeURIComponent(data.id)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled: data.enabled }),
  });
}

export function deleteMapping({ data }: { data: { id: string } }) {
  return api<{ ok: true }>(`/v1/mappings/${encodeURIComponent(data.id)}/delete`, { method: "POST" });
}

export function knockMapping({ data }: { data: { id: string; ip?: string } }) {
  return api<{ until: string; ip: string; ttlSec: number }>(
    `/v1/mappings/${encodeURIComponent(data.id)}/knock`,
    {
      method: "POST",
      body: JSON.stringify(data.ip ? { ip: data.ip } : {}),
    },
  );
}

export function probeMapping({ data }: { data: { id: string } }) {
  return api<ProbeResult>(`/v1/mappings/${encodeURIComponent(data.id)}/probe`, { method: "POST" });
}

export function visitMapping({ data }: { data: { id: string } }) {
  return api<ProbeResult>(`/v1/mappings/${encodeURIComponent(data.id)}/visit`, { method: "POST" });
}

export function issueVisitor({ data }: { data: { id: string; label?: string } }) {
  return api<VisitorIssued>(`/v1/mappings/${encodeURIComponent(data.id)}/visitor`, {
    method: "POST",
    body: JSON.stringify({ label: data.label }),
  });
}

export function listTickets({ data }: { data?: { mappingId?: string } } = {}) {
  const q = data?.mappingId ? `?mappingId=${encodeURIComponent(data.mappingId)}` : "";
  return api<VisitorTicket[]>(`/v1/tickets${q}`);
}

export function revokeTicket({ data }: { data: { id: string } }) {
  return api<{ ok: true }>(`/v1/tickets/${encodeURIComponent(data.id)}/delete`, { method: "POST" });
}

export function caDownloadURL() {
  return "/v1/ca";
}

export function runDemo() {
  return api<DemoResult>("/v1/demo", { method: "POST" });
}
