import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { MappingWire } from "./protocol";

const TLS_DIR = process.env.UMBRA_TLS_DIR ?? "/tmp/umbra-tls";
const SOCK = process.env.UMBRA_GATE_SOCK ?? join(TLS_DIR, "api.sock");
const HTTP = process.env.UMBRA_GATE_API;
const AGENT_BIN = process.env.UMBRA_AGENT_BIN ?? "/usr/local/bin/umbra-agent";
const SERVER = process.env.UMBRA_SERVER ?? "127.0.0.1:4400";
const TLS_CA = process.env.UMBRA_TLS_CA ?? join(TLS_DIR, "ca.crt");

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

function gateFetch(path: string, init: RequestInit = {}, timeoutMs = 1500): Promise<Response> {
  if (HTTP) return fetch(`${HTTP.replace(/\/$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: SOCK,
        path,
        method,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: { "content-type": String(res.headers["content-type"] ?? "application/json") },
            }),
          );
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function gateHealth() {
  const cached = g.__umbraHealth__;
  if (cached && Date.now() - cached.t < 2500) return cached.ok;
  try {
    const r = await gateFetch("/health", {}, 150);
    g.__umbraHealth__ = { t: Date.now(), ok: r.ok };
    return r.ok;
  } catch {
    g.__umbraHealth__ = { t: Date.now(), ok: false };
    return false;
  }
}

export async function gatePutToken(token: string, agentId: string) {
  await gateFetch(`/v1/tokens/${encodeURIComponent(token)}`, {
    method: "PUT",
    body: JSON.stringify({ agent_id: agentId }),
  });
}

export async function gatePutMappings(agentId: string, mappings: MappingWire[]) {
  await gateFetch(`/v1/agents/${encodeURIComponent(agentId)}/mappings`, {
    method: "PUT",
    body: JSON.stringify(mappings),
  });
}

export async function gateKnock(mappingId: string) {
  const r = await gateFetch(`/v1/knock/${encodeURIComponent(mappingId)}`, { method: "POST" }, 1000);
  if (!r.ok) return null;
  const j = (await r.json()) as { until?: string };
  return j.until ?? null;
}

export async function gateRevoke(agentId: string) {
  await gateFetch(`/v1/agents/${encodeURIComponent(agentId)}/revoke`, {
    method: "POST",
  }, 1000);
}

export async function gateDisconnect(agentId: string) {
  await gateFetch(`/v1/agents/${encodeURIComponent(agentId)}/disconnect`, {
    method: "POST",
  }, 1000);
}

export async function gateAgentOnline(agentId: string) {
  try {
    const r = await gateFetch("/v1/status", {}, 250);
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
