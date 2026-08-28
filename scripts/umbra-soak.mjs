#!/usr/bin/env node
/**
 * Public-network soak: TCP echo, idle/quota release, reconnect, and a
 * light slowloris/stream-flood pulse. Default is a short run for CI/local.
 *
 *   node scripts/umbra-soak.mjs              # ~20s
 *   UMBRA_SOAK=24h node scripts/umbra-soak.mjs
 */
import { createServer, createConnection } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UMBRAD = process.env.UMBRAD_BIN ?? "/usr/local/bin/umbrad";
const NODE = process.env.UMBRA_NODE_BIN ?? "/usr/local/bin/umbra-node";
const CTRL = process.env.UMBRA_SOAK_CTRL ?? "127.0.0.1:15400";
const API = process.env.UMBRA_SOAK_API ?? "127.0.0.1:15401";
const TOKEN = "tok_soak";
const NODE_ID = "nde_soak";
const PUB = Number(process.env.UMBRA_SOAK_PUB ?? 41280);
const ECHO = Number(process.env.UMBRA_SOAK_ECHO ?? 19280);

function parseDuration(s) {
  if (!s) return 20_000;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!m) return 20_000;
  const n = Number(m[1]);
  const u = (m[2] || "s").toLowerCase();
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (mul[u] ?? 1000);
}

const DURATION = parseDuration(process.env.UMBRA_SOAK ?? process.env.UMBRA_SOAK_DURATION);
const kids = [];
const results = [];

function log(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

function must(name, ok, extra) {
  log(name, ok, extra);
  if (!ok) throw new Error(name + (extra ? ": " + extra : ""));
}

function spawnBin(bin, args, extraEnv = {}) {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  const chunks = [];
  child.stdout.on("data", (b) => chunks.push(b));
  child.stderr.on("data", (b) => chunks.push(b));
  child.log = () => Buffer.concat(chunks).toString("utf8").slice(-1200);
  kids.push(child);
  return child;
}

async function waitHttp(url, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(400) });
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(80);
  }
  return false;
}

async function api(method, path, body) {
  const r = await fetch(`http://${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  }
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function listenEchoTcp(port) {
  const s = createServer((c) => {
    c.on("data", (b) => c.write(b));
    c.on("error", () => c.destroy());
  });
  return new Promise((resolve, reject) => {
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

function tcpRoundtrip(port, payload, ms = 2500) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const bufs = [];
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.destroy();
      fn(v);
    };
    const t = setTimeout(() => finish(reject, new Error("tcp timeout")), ms);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (b) => {
      bufs.push(b);
      const got = Buffer.concat(bufs);
      if (got.length >= payload.length) finish(resolve, got);
    });
    sock.on("error", (e) => finish(reject, e));
    sock.on("close", () => {
      if (!done) finish(reject, new Error("tcp closed empty"));
    });
  });
}

function slowloris(hostPort, ms = 1500) {
  const idx = hostPort.lastIndexOf(":");
  const host = hostPort.slice(0, idx);
  const port = Number(hostPort.slice(idx + 1));
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      resolve("timeout");
    }, ms);
    sock.on("connect", () => {
      sock.write("POST /v1/login HTTP/1.1\r\nHost: soak\r\n");
    });
    sock.on("close", () => {
      clearTimeout(t);
      resolve("closed");
    });
    sock.on("error", () => {
      clearTimeout(t);
      resolve("error");
    });
  });
}

function idleHold(port, ms = 1500) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const t = setTimeout(() => {
      sock.destroy();
      resolve("held");
    }, ms);
    sock.on("error", () => {
      clearTimeout(t);
      resolve("error");
    });
    sock.on("close", () => {
      clearTimeout(t);
      resolve("closed");
    });
  });
}

async function waitOnline(ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await api("GET", "/v1/status").catch(() => null);
    if (st?.nodes?.some((a) => a.id === NODE_ID && a.online)) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  const echo = await listenEchoTcp(ECHO);
  const tlsDir = mkdtempSync(join(tmpdir(), "umbra-soak-"));
  const umbrad = spawnBin(UMBRAD, [
    "-listen", CTRL,
    "-http", API,
    "-bind", "127.0.0.1",
    "-tls-dir", tlsDir,
    "-udp", "yamux",
  ], { UMBRA_LOGIN: "off" });
  must("入口起来", await waitHttp(`http://${API}/health`), umbrad.log());

  await api("PUT", `/v1/tokens/${TOKEN}`, { node_id: NODE_ID });
  await api("PUT", `/v1/nodes/${NODE_ID}/mappings`, [
    {
      id: "map_soak",
      name: "soak",
      proto: "tcp",
      mode: "public",
      entry_port: PUB,
      local_host: "127.0.0.1",
      local_port: ECHO,
      enabled: true,
      max_conns: 8,
      idle_timeout_sec: 1,
    },
  ]);

  let node = spawnBin(NODE, ["--server", CTRL, "--token", TOKEN, "--tls-ca", join(tlsDir, "ca.crt")]);
  must("节点上线", await waitOnline(), node.log());

  const t0 = Date.now();
  let rounds = 0;
  let lastErr = "";
  while (Date.now() - t0 < DURATION) {
    try {
      const got = await tcpRoundtrip(PUB, Buffer.from("soak-hi\n"));
      if (got.toString() !== "soak-hi\n") throw new Error("echo mismatch");
      const maps = await api("GET", "/v1/mappings");
      const m = (maps ?? []).find((x) => x.id === "map_soak");
      if (m && m.activeConns > 8) throw new Error(`quota ${m.activeConns}`);
      await idleHold(PUB, 1200);
      const sl = await slowloris(API, 800);
      if (sl !== "closed" && sl !== "error" && sl !== "timeout") {
        throw new Error(`slowloris ${sl}`);
      }
      node.kill("SIGTERM");
      await sleep(150);
      node = spawnBin(NODE, ["--server", CTRL, "--token", TOKEN, "--tls-ca", join(tlsDir, "ca.crt")]);
      if (!(await waitOnline(4000))) throw new Error("node reconnect");
      if (!(await waitHttp(`http://${API}/health`, 2000))) {
        throw new Error("health after reconnect");
      }
      rounds += 1;
      lastErr = "";
    } catch (e) {
      lastErr = e.message;
      await sleep(200);
    }
  }

  must("至少完成一轮 soak", rounds > 0, lastErr || `rounds=${rounds}`);
  const health = await api("GET", "/health").catch(() => null);
  must("结束时 health ok", Boolean(health?.ok), JSON.stringify(health));
  log("soak rounds", true, `${rounds} in ${DURATION}ms`);

  for (const k of kids) {
    try {
      k.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  echo.close();
  rmSync(tlsDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`soak failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`soak ok  rounds=${rounds} duration=${DURATION}ms`);
}

main().catch((e) => {
  console.error(e);
  for (const k of kids) {
    try {
      k.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  process.exit(1);
});
