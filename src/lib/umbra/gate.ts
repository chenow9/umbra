import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { MappingWire } from "./protocol";

const TLS_DIR = process.env.UMBRA_TLS_DIR ?? "/tmp/umbra-tls";
const SOCK = process.env.UMBRA_GATE_SOCK ?? join(TLS_DIR, "api.sock");
const HTTP = process.env.UMBRA_GATE_API;
const NODE_BIN = process.env.UMBRA_NODE_BIN ?? "/usr/local/bin/umbra-node";
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

export function rememberToken(nodeId: string, token: string) {
  boots().set(nodeId, token);
}

export function recallToken(nodeId: string) {
  return boots().get(nodeId);
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

export async function gatePutToken(token: string, nodeId: string) {
  await gateFetch(`/v1/tokens/${encodeURIComponent(token)}`, {
    method: "PUT",
    body: JSON.stringify({ node_id: nodeId }),
  });
}

export async function gatePutMappings(nodeId: string, mappings: MappingWire[]) {
  await gateFetch(`/v1/nodes/${encodeURIComponent(nodeId)}/mappings`, {
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

export async function gateRevoke(nodeId: string) {
  await gateFetch(`/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, {
    method: "POST",
  }, 1000);
}

export async function gateDisconnect(nodeId: string) {
  await gateFetch(`/v1/nodes/${encodeURIComponent(nodeId)}/disconnect`, {
    method: "POST",
  }, 1000);
}

export async function gateNodeOnline(nodeId: string) {
  try {
    const r = await gateFetch("/v1/status", {}, 250);
    if (!r.ok) return false;
    const j = (await r.json()) as { nodes?: { id: string; online: boolean }[] };
    return Boolean(j.nodes?.some((a) => a.id === nodeId && a.online));
  } catch {
    return false;
  }
}

export function spawnNode(nodeId: string, token: string) {
  const existing = kids().get(nodeId);
  if (existing && existing.exitCode == null) return;
  const args = ["--server", SERVER, "--token", token];
  if (TLS_CA) args.push("--tls-ca", TLS_CA);
  const child = spawn(NODE_BIN, args, {
    stdio: "ignore",
    detached: false,
  });
  child.on("exit", () => {
    const cur = kids().get(nodeId);
    if (cur === child) kids().delete(nodeId);
  });
  kids().set(nodeId, child);
}

export function stopNode(nodeId: string) {
  const child = kids().get(nodeId);
  if (!child) return;
  kids().delete(nodeId);
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

export async function waitOnline(nodeId: string, ms = 2500) {
  const t0 = Date.now();
  if (await gateNodeOnline(nodeId)) return true;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 50));
    if (await gateNodeOnline(nodeId)) return true;
  }
  return false;
}

export async function ensureNodeOnline(nodeId: string, token?: string) {
  if (!(await gateHealth())) return false;
  if (token) await gatePutToken(token, nodeId).catch(() => undefined);
  if (await gateNodeOnline(nodeId)) return true;
  if (!token) return false;
  spawnNode(nodeId, token);
  return waitOnline(nodeId, 2500);
}
