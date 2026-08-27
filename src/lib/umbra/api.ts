import type {
  Agent,
  AuditItem,
  ControlFrameRow,
  DemoResult,
  Mapping,
  Overview,
  ProbeResult,
  TrafficView,
  VisitorIssued,
} from "./types";

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

export function listAgents() {
  return api<Agent[]>("/v1/agents");
}

export function listMappings() {
  return api<Mapping[]>("/v1/mappings");
}

export function getOverview() {
  return api<Overview>("/v1/overview");
}

export function listAudit() {
  return api<AuditItem[]>("/v1/audit");
}

export function listFrames() {
  return api<ControlFrameRow[]>("/v1/frames");
}

export function getTraffic({ data }: { data?: { range?: string; mappingId?: string; agentId?: string } } = {}) {
  const q = new URLSearchParams();
  if (data?.range) q.set("range", data.range);
  if (data?.mappingId) q.set("mappingId", data.mappingId);
  if (data?.agentId) q.set("agentId", data.agentId);
  const s = q.toString();
  return api<TrafficView>(`/v1/traffic${s ? `?${s}` : ""}`);
}

export function createAgent({
  data,
}: {
  data: { name: string; comment?: string; os: string; arch: string };
}) {
  return api<{ id: string; token: string; os: string; arch: string }>("/v1/agents", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getAgentBootstrap({ data }: { data: { id: string } }) {
  return api<{ token: string }>(`/v1/agents/${encodeURIComponent(data.id)}/bootstrap`);
}

export function helloAgent({ data }: { data: { id: string } }) {
  return api<{ ok: true; pushed: number }>(`/v1/agents/${encodeURIComponent(data.id)}/hello`, { method: "POST" });
}

export function disconnectAgent({ data }: { data: { id: string } }) {
  return api<void>(`/v1/agents/${encodeURIComponent(data.id)}/disconnect`, { method: "POST" });
}

export function revokeAgent({ data }: { data: { id: string } }) {
  return api<void>(`/v1/agents/${encodeURIComponent(data.id)}/revoke`, { method: "POST" });
}

export function createMapping({ data }: { data: Record<string, unknown> }) {
  return api<Mapping>("/v1/mappings", { method: "POST", body: JSON.stringify(data) });
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

export function knockMapping({ data }: { data: { id: string } }) {
  return api<{ until: string }>(`/v1/mappings/${encodeURIComponent(data.id)}/knock`, { method: "POST" });
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

export function runDemo() {
  return api<DemoResult>("/v1/demo", { method: "POST" });
}
