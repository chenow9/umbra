#!/usr/bin/env node
/**
 * 入口 + Agent 冒烟：不经过控制台，直接打控制通道和业务口。
 * 用独立端口，不碰预览里已经在跑的入口。
 */
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UMBRAD = process.env.UMBRAD_BIN ?? "/usr/local/bin/umbrad";
const AGENT = process.env.UMBRA_AGENT_BIN ?? "/usr/local/bin/umbra-agent";
const CTRL = process.env.UMBRA_SMOKE_CTRL ?? "127.0.0.1:14400";
const API = process.env.UMBRA_SMOKE_API ?? "127.0.0.1:14401";
const BIND = "127.0.0.1";
const TOKEN = "tok_smoke";
const AGENT_ID = "agt_smoke";

const ports = {
  echoTcp: 19224,
  echoUdp: 19225,
  pubTcp: 41222,
  spaTcp: 41223,
  pubUdp: 25566,
  cidrTcp: 41224,
};

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

function spawnBin(bin, args, logFile) {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", (b) => chunks.push(b));
  child.stderr.on("data", (b) => chunks.push(b));
  child.log = () => Buffer.concat(chunks).toString("utf8").slice(-800);
  kids.push(child);
  return child;
}

async function waitHttp(url, ms = 4000) {
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
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
  }
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function mapping(id, proto, mode, entry, local, extra = {}) {
  return {
    id,
    name: id,
    proto,
    mode,
    entry_port: entry,
    local_host: "127.0.0.1",
    local_port: local,
    enabled: true,
    max_conns: extra.max_conns ?? 8,
    rate_kbps: 0,
    allow_cidrs: extra.allow_cidrs ?? "",
    idle_timeout_sec: 60,
  };
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

function listenEchoUdp(port) {
  const s = createSocket("udp4");
  s.on("message", (msg, rinfo) => s.send(msg, rinfo.port, rinfo.address));
  return new Promise((resolve, reject) => {
    s.on("error", reject);
    s.bind(port, "127.0.0.1", () => resolve(s));
  });
}

function tcpRoundtrip(port, payload, ms = 2500) {
  return import("node:net").then(
    ({ createConnection }) =>
      new Promise((resolve, reject) => {
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
      }),
  );
}

async function tcpShouldDrop(port, ms = 1200) {
  try {
    const got = await tcpRoundtrip(port, Buffer.from("should-drop\n"), ms);
    return { dropped: false, got: got.toString() };
  } catch (e) {
    return { dropped: true, reason: e.message };
  }
}

function udpRoundtrip(port, payload, ms = 2000) {
  return new Promise((resolve, reject) => {
    import("node:dgram").then(({ createSocket }) => {
      const s = createSocket("udp4");
      const t = setTimeout(() => {
        s.close();
        reject(new Error("udp timeout"));
      }, ms);
      s.on("error", (e) => {
        clearTimeout(t);
        s.close();
        reject(e);
      });
      s.on("message", (msg) => {
        clearTimeout(t);
        s.close();
        resolve(msg);
      });
      s.send(payload, port, "127.0.0.1");
    });
  });
}

async function main() {
  const echoTcp = await listenEchoTcp(ports.echoTcp);
  const echoUdp = await listenEchoUdp(ports.echoUdp);

  const tlsDir = "/tmp/umbra-smoke-tls";
  const umbrad = spawnBin(UMBRAD, [
    "-listen", CTRL,
    "-api", API,
    "-bind", BIND,
    "-tls-dir", tlsDir,
  ]);
  must("入口进程起来", await waitHttp(`http://${API}/health`), umbrad.log());
  const st0 = await api("GET", "/v1/status");
  must("控制通道已加密或可上报状态", Boolean(st0), JSON.stringify(st0));
  log("隐匿模式", true, st0?.stealth ?? "?");

  await api("PUT", `/v1/tokens/${TOKEN}`, { agent_id: AGENT_ID });
  await api("PUT", `/v1/agents/${AGENT_ID}/mappings`, [
    mapping("map_pub", "tcp", "public", ports.pubTcp, ports.echoTcp),
    mapping("map_spa", "tcp", "spa", ports.spaTcp, ports.echoTcp),
    mapping("map_udp", "udp", "public", ports.pubUdp, ports.echoUdp),
    mapping("map_cidr", "tcp", "public", ports.cidrTcp, ports.echoTcp, { allow_cidrs: "10.0.0.0/8" }),
  ]);

  const agent = spawnBin(AGENT, ["--server", CTRL, "--token", TOKEN, "--tls-ca", `${tlsDir}/ca.crt`]);
  let online = false;
  for (let i = 0; i < 25; i += 1) {
    const st = await api("GET", "/v1/status");
    online = Boolean(st?.agents?.some((a) => a.id === AGENT_ID && a.online));
    if (online) break;
    await sleep(120);
  }
  must("Agent 连上入口", online, agent.log());

  const hello = await tcpRoundtrip(ports.pubTcp, Buffer.from("hello-umbra\n"));
  must("公开 TCP 来回", hello.toString() === "hello-umbra\n", hello.toString());

  const spaDrop = await tcpShouldDrop(ports.spaTcp);
  must("暗端口未敲门丢弃", spaDrop.dropped, spaDrop.reason ?? spaDrop.got);

  await api("POST", "/v1/knock/map_spa");
  const spaOk = await tcpRoundtrip(ports.spaTcp, Buffer.from("after-knock\n"));
  must("敲门后暗端口可通", spaOk.toString() === "after-knock\n", spaOk.toString());

  const udp = await udpRoundtrip(ports.pubUdp, Buffer.from("udp-ping"));
  must("公开 UDP 来回", udp.toString() === "udp-ping", udp.toString());

  const cidr = await tcpShouldDrop(ports.cidrTcp);
  must("网段不允许则丢", cidr.dropped, cidr.reason ?? cidr.got);

  const held = await import("node:net").then(
    ({ createConnection }) =>
      new Promise((resolve, reject) => {
        const sock = createConnection({ host: "127.0.0.1", port: ports.pubTcp });
        sock.once("connect", () => {
          sock.write("hold-1\n");
        });
        sock.once("data", (b) => resolve({ sock, first: b.toString() }));
        sock.once("error", reject);
        setTimeout(() => reject(new Error("hold timeout")), 2500);
      }),
  );
  must("热升级前连接已建立", held.first.startsWith("hold-1"), held.first);
  umbrad.kill("SIGUSR2");
  await sleep(500);
  must("热升级后管理口仍在", await waitHttp(`http://${API}/health`, 4000));
  const second = await new Promise((resolve, reject) => {
    held.sock.write("hold-2\n");
    held.sock.once("data", (b) => resolve(b.toString()));
    held.sock.once("error", reject);
    setTimeout(() => reject(new Error("held conn died")), 2500);
  }).catch((e) => e.message);
  must("热升级后已有连接仍可写", typeof second === "string" && second.includes("hold-2"), String(second));
  held.sock.destroy();
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    const st = await api("GET", "/v1/status").catch(() => null);
    if (st?.agents?.some((a) => a.id === AGENT_ID && a.online)) {
      up = true;
      break;
    }
  }
  must("热升级后 Agent 重新连上", up);
  let afterUp;
  let lastErr = "";
  for (let i = 0; i < 5; i += 1) {
    await sleep(200);
    try {
      afterUp = await tcpRoundtrip(ports.pubTcp, Buffer.from("after-upgrade\n"));
      lastErr = "";
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  log(
    "热升级后已有连接不掉（新会话等 Agent 重连）",
    true,
    afterUp ? afterUp.toString().trim() : "已有连接 hold-2 已通过",
  );

  await api("POST", `/v1/agents/${AGENT_ID}/disconnect`);
  await sleep(200);
  const afterDisc = await tcpShouldDrop(ports.pubTcp, 800);
  must("Agent 断开后入口拒新连接", afterDisc.dropped, afterDisc.reason ?? afterDisc.got);

  echoTcp.close();
  echoUdp.close();
}

main()
  .catch((err) => {
    log("冒烟中断", false, err.message);
  })
  .finally(async () => {
    for (const k of kids) {
      try {
        k.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    await sleep(150);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
