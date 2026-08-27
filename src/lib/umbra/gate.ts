import { spawn, type ChildProcess } from "node:child_process";
import type { MappingWire } from "./protocol";

const API = process.env.UMBRA_GATE_API ?? "http://127.0.0.1:4401";
const AGENT_BIN = process.env.UMBRA_AGENT_BIN ?? "/usr/local/bin/umbra-agent";
const SERVER = process.env.UMBRA_SERVER ?? "127.0.0.1:4400";
const TLS_CA = process.env.UMBRA_TLS_CA ?? "/tmp/umbra-tls/ca.crt";

const g = globalThis as typeof globalThis & {
  __umbraKids__?: Map<string, ChildProcess>;
  __umbraBoots__?: Map<string, string>;
  __umbraHealth__?: { t: number; ok: boolean };
};

function kids() {
  g.__umbraKids__ ??= new Map();
  return g.__umbraKids__;
}

function boots() {
  g.__umbraBoots__ ??= new Map();
  return g.__umbraBoots__;
}

export function rememberToken(agentId: string, token: string) {
  boots().set(agentId, token);
}

export function recallToken(agentId: string) {
  return boots().get(agentId);
}

export async function gateHealth() {
  const cached = g.__umbraHealth__;
  if (cached && Date.now() - cached.t < 2500) return cached.ok;
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(150) });
    g.__umbraHealth__ = { t: Date.now(), ok: r.ok };
    return r.ok;
  } catch {
    g.__umbraHealth__ = { t: Date.now(), ok: false };
    return false;
  }
}

export async function gatePutToken(token: string, agentId: string) {
  await fetch(`${API}/v1/tokens/${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
    signal: AbortSignal.timeout(1500),
  });
}

export async function gatePutMappings(agentId: string, mappings: MappingWire[]) {
  await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/mappings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mappings),
    signal: AbortSignal.timeout(1500),
  });
}

export async function gateKnock(mappingId: string) {
  const r = await fetch(`${API}/v1/knock/${encodeURIComponent(mappingId)}`, {
    method: "POST",
    signal: AbortSignal.timeout(1000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { until?: string };
  return j.until ?? null;
}

export async function gateRevoke(agentId: string) {
  await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/revoke`, {
    method: "POST",
    signal: AbortSignal.timeout(1000),
  });
}

export async function gateDisconnect(agentId: string) {
  await fetch(`${API}/v1/agents/${encodeURIComponent(agentId)}/disconnect`, {
    method: "POST",
    signal: AbortSignal.timeout(1000),
  });
}

export async function gateAgentOnline(agentId: string) {
  try {
    const r = await fetch(`${API}/v1/status`, { signal: AbortSignal.timeout(250) });
    if (!r.ok) return false;
    const j = (await r.json()) as { agents?: { id: string; online: boolean }[] };
    return Boolean(j.agents?.some((a) => a.id === agentId && a.online));
  } catch {
    return false;
  }
}

export function spawnAgent(agentId: string, token: string) {
  const existing = kids().get(agentId);
  if (existing && existing.exitCode == null) return;
  const args = ["--server", SERVER, "--token", token];
  if (TLS_CA) args.push("--tls-ca", TLS_CA);
  const child = spawn(AGENT_BIN, args, {
    stdio: "ignore",
    detached: false,
  });
  child.on("exit", () => {
    const cur = kids().get(agentId);
    if (cur === child) kids().delete(agentId);
  });
  kids().set(agentId, child);
}

export function stopAgent(agentId: string) {
  const child = kids().get(agentId);
  if (!child) return;
  kids().delete(agentId);
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

export async function waitOnline(agentId: string, ms = 2500) {
  const t0 = Date.now();
  if (await gateAgentOnline(agentId)) return true;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (await gateAgentOnline(agentId)) return true;
  }
  return false;
}

export async function ensureAgentOnline(agentId: string, token?: string) {
  if (!(await gateHealth())) return false;
  if (token) await gatePutToken(token, agentId).catch(() => undefined);
  if (await gateAgentOnline(agentId)) return true;
  if (!token) return false;
  spawnAgent(agentId, token);
  return waitOnline(agentId, 2500);
}
