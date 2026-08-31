#!/usr/bin/env node
/**
 * 入口 + 节点冒烟：不经过控制台，直接打控制通道和业务口。
 * 用独立端口，不碰预览里已经在跑的入口。
 */
import { createServer, createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);

const UMBRAD = process.env.UMBRAD_BIN ?? "/usr/local/bin/umbrad";
const NODE = process.env.UMBRA_NODE_BIN ?? "/usr/local/bin/umbra-node";
const VISIT = process.env.UMBRA_VISIT_BIN ?? "/usr/local/bin/umbra-visit";
const CTRL = process.env.UMBRA_SMOKE_CTRL ?? "127.0.0.1:14400";
const API = process.env.UMBRA_SMOKE_API ?? "127.0.0.1:14401";
const BIND = "127.0.0.1";
const TOKEN = "tok_smoke";
const NODE_ID = "nde_smoke";

const ports = {
  echoTcp: 19224,
  echoUdp: 19225,
  pubTcp: 41222,
  spaTcp: 41223,
  pubUdp: 25566,
  cidrTcp: 41224,
  visLocal: 19226,
  visUdpLocal: 19227,
  afterTcp: 41225,
};

const kids = [];
const results = [];
let replacementPid = 0;

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

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function apiPort() {
  const idx = API.lastIndexOf(":");
  return Number(API.slice(idx + 1));
}

async function listenPid(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const n = Number(String(stdout).trim().split("\n")[0]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function httpGetFresh(host, port, path, ms = 1500) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    const bufs = [];
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("fresh http timeout"));
    }, ms);
    sock.on("connect", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (b) => bufs.push(b));
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    sock.on("end", () => {
      clearTimeout(t);
      const raw = Buffer.concat(bufs).toString("utf8");
      if (raw.startsWith("HTTP/1.1 200") || raw.startsWith("HTTP/1.0 200")) {
        resolve(raw);
        return;
      }
      reject(new Error(raw.slice(0, 160) || "empty http"));
    });
  });
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
    "-udp", "required",
  ], { UMBRA_LOGIN: "off" });
  must("入口进程起来", await waitHttp(`http://${API}/health`), umbrad.log());
  const st0 = await api("GET", "/v1/status");
  must("控制通道已加密或可上报状态", Boolean(st0), JSON.stringify(st0));
  log("隐匿模式", true, st0?.stealth ?? "?");

  await api("PUT", `/v1/tokens/${TOKEN}`, { node_id: NODE_ID });
  await api("PUT", `/v1/nodes/${NODE_ID}/mappings`, [
    mapping("map_pub", "tcp", "public", ports.pubTcp, ports.echoTcp),
    mapping("map_spa", "tcp", "spa", ports.spaTcp, ports.echoTcp),
    mapping("map_udp", "udp", "public", ports.pubUdp, ports.echoUdp),
    mapping("map_cidr", "tcp", "public", ports.cidrTcp, ports.echoTcp, { allow_cidrs: "10.0.0.0/8" }),
    mapping("map_vis", "tcp", "visitor", null, ports.echoTcp),
    mapping("map_vis_udp", "udp", "visitor", null, ports.echoUdp),
  ]);

  const node = spawnBin(NODE, ["--server", CTRL, "--token", TOKEN, "--tls-ca", `${tlsDir}/ca.crt`]);
  let online = false;
  for (let i = 0; i < 25; i += 1) {
    const st = await api("GET", "/v1/status");
    online = Boolean(st?.nodes?.some((a) => a.id === NODE_ID && a.online));
    if (online) break;
    await sleep(120);
  }
  must("节点连上入口", online, node.log());
  let plane = false;
  for (let i = 0; i < 25; i += 1) {
    const st = await api("GET", "/v1/status");
    plane = Boolean(st?.udp === "required" && st?.nodes?.some((a) => a.id === NODE_ID && a.uplane));
    if (plane) break;
    await sleep(120);
  }
  must("节点 UDP 数据面已绑定", plane);

  const hello = await tcpRoundtrip(ports.pubTcp, Buffer.from("hello-umbra\n"));
  must("公开 TCP 来回", hello.toString() === "hello-umbra\n", hello.toString());
  const afterTcp = await api("GET", "/v1/mappings");
  const pubMap = (afterTcp ?? []).find((m) => m.id === "map_pub");
  must(
    "TCP 双向计数",
    Boolean(pubMap && pubMap.bytesIn >= 12 && pubMap.bytesOut >= 12),
    JSON.stringify({ in: pubMap?.bytesIn, out: pubMap?.bytesOut }),
  );

  const spaDrop = await tcpShouldDrop(ports.spaTcp);
  must("spa 未敲门丢弃", spaDrop.dropped, spaDrop.reason ?? spaDrop.got);

  await api("POST", "/v1/knock/map_spa");
  const spaOk = await tcpRoundtrip(ports.spaTcp, Buffer.from("after-knock\n"));
  must("敲门后 spa 可通", spaOk.toString() === "after-knock\n", spaOk.toString());

  const udp = await udpRoundtrip(ports.pubUdp, Buffer.from("udp-ping"));
  must("公开 UDP 来回", udp.toString() === "udp-ping", udp.toString());
  const afterUdp = await api("GET", "/v1/mappings");
  const udpMap = (afterUdp ?? []).find((m) => m.id === "map_udp");
  must(
    "UDP 双向计数",
    Boolean(udpMap && udpMap.bytesIn >= 8 && udpMap.bytesOut >= 8),
    JSON.stringify({ in: udpMap?.bytesIn, out: udpMap?.bytesOut }),
  );
  must("公开 UDP 走 uplane", udpMap?.udpVia === "uplane", udpMap?.udpVia ?? "");

  const cidr = await tcpShouldDrop(ports.cidrTcp);
  must("网段不允许则丢", cidr.dropped, cidr.reason ?? cidr.got);

  const issued = await api("POST", "/v1/mappings/map_vis/visitor", { label: "smoke" });
  must("签发 visitor 票据", Boolean(issued?.ticket), JSON.stringify(issued));
  const visitor = spawnBin(VISIT, [
    "--server", CTRL,
    "--ticket", issued.ticket,
    "--local", `127.0.0.1:${ports.visLocal}`,
    "--tls-ca", `${tlsDir}/ca.crt`,
  ]);
  let visOk = false;
  let visErr = "";
  for (let i = 0; i < 25; i += 1) {
    try {
      const got = await tcpRoundtrip(ports.visLocal, Buffer.from("hello-visit\n"), 800);
      visOk = got.toString() === "hello-visit\n";
      if (visOk) break;
      visErr = got.toString();
    } catch (e) {
      visErr = e.message;
    }
    await sleep(120);
  }
  must("访客 L4 TCP 来回", visOk, visOk ? "L4" : visErr || visitor.log());
  const afterVis = await api("GET", "/v1/mappings");
  const visMap = (afterVis ?? []).find((m) => m.id === "map_vis");
  must(
    "访客流量计入入口",
    Boolean(visMap && visMap.bytesIn >= 12 && visMap.bytesOut >= 12),
    JSON.stringify({ in: visMap?.bytesIn, out: visMap?.bytesOut }),
  );

  const issuedUdp = await api("POST", "/v1/mappings/map_vis_udp/visitor", { label: "smoke-udp" });
  must("签发 visitor UDP 票据", Boolean(issuedUdp?.ticket), JSON.stringify(issuedUdp));
  const visitorUdp = spawnBin(VISIT, [
    "--server", CTRL,
    "--ticket", issuedUdp.ticket,
    "--local", `127.0.0.1:${ports.visUdpLocal}`,
    "--tls-ca", `${tlsDir}/ca.crt`,
  ]);
  let visUdpOk = false;
  let visUdpErr = "";
  for (let i = 0; i < 25; i += 1) {
    try {
      const got = await udpRoundtrip(ports.visUdpLocal, Buffer.from("hello-visit-udp"), 800);
      visUdpOk = got.toString() === "hello-visit-udp";
      if (visUdpOk) break;
      visUdpErr = got.toString();
    } catch (e) {
      visUdpErr = e.message;
    }
    await sleep(120);
  }
  must("访客 L4 UDP 来回", visUdpOk, visUdpOk ? "uplane" : visUdpErr || visitorUdp.log());
  const afterVisUdp = await api("GET", "/v1/mappings");
  const visUdpMap = (afterVisUdp ?? []).find((m) => m.id === "map_vis_udp");
  must("访客 UDP 走 uplane", visUdpMap?.udpVia === "uplane", visUdpMap?.udpVia ?? "");

  const oldPid = umbrad.pid;
  must("记录升级前 PID", Boolean(oldPid), String(oldPid));
  umbrad.kill("SIGUSR2");

  let oldGone = false;
  for (let i = 0; i < 40; i += 1) {
    if (!pidAlive(oldPid)) {
      oldGone = true;
      break;
    }
    await sleep(100);
  }
  must("升级后旧进程已退出", oldGone, `pid ${oldPid}`);

  const httpPort = apiPort();
  let newPid = 0;
  for (let i = 0; i < 40; i += 1) {
    newPid = await listenPid(httpPort);
    if (newPid && newPid !== oldPid && pidAlive(newPid)) break;
    newPid = 0;
    await sleep(100);
  }
  replacementPid = newPid;
  must("升级后新进程存活", Boolean(newPid) && newPid !== oldPid && pidAlive(newPid), `old=${oldPid} new=${newPid}`);

  let health = "";
  let healthErr = "";
  for (let i = 0; i < 20; i += 1) {
    try {
      health = await httpGetFresh("127.0.0.1", httpPort, "/health");
      healthErr = "";
      break;
    } catch (e) {
      healthErr = e.message;
      await sleep(100);
    }
  }
  must("升级后全新 TCP 检查 health", health.includes("200") && health.includes(`"ok":true`), healthErr || health.slice(0, 120));

  let up = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    const st = await api("GET", "/v1/status").catch(() => null);
    if (st?.nodes?.some((a) => a.id === NODE_ID && a.online)) {
      up = true;
      break;
    }
  }
  must("热升级后节点重新连上", up);
  let planeAfter = false;
  for (let i = 0; i < 25; i += 1) {
    const st = await api("GET", "/v1/status").catch(() => null);
    planeAfter = Boolean(st?.nodes?.some((a) => a.id === NODE_ID && a.uplane));
    if (planeAfter) break;
    await sleep(120);
  }
  must("升级后 UDP 数据面已绑定", planeAfter);

  let afterUp;
  let lastErr = "";
  for (let i = 0; i < 10; i += 1) {
    await sleep(200);
    try {
      afterUp = await tcpRoundtrip(ports.pubTcp, Buffer.from("after-upgrade\n"));
      lastErr = "";
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  must(
    "升级后原 mapping 可通",
    Boolean(afterUp) && afterUp.toString() === "after-upgrade\n",
    lastErr || (afterUp ? afterUp.toString().trim() : ""),
  );

  await api("PUT", `/v1/nodes/${NODE_ID}/mappings`, [
    mapping("map_pub", "tcp", "public", ports.pubTcp, ports.echoTcp),
    mapping("map_spa", "tcp", "spa", ports.spaTcp, ports.echoTcp),
    mapping("map_udp", "udp", "public", ports.pubUdp, ports.echoUdp),
    mapping("map_cidr", "tcp", "public", ports.cidrTcp, ports.echoTcp, { allow_cidrs: "10.0.0.0/8" }),
    mapping("map_vis", "tcp", "visitor", null, ports.echoTcp),
    mapping("map_vis_udp", "udp", "visitor", null, ports.echoUdp),
    mapping("map_after", "tcp", "public", ports.afterTcp, ports.echoTcp),
  ]);
  let afterUdpPkt;
  lastErr = "";
  for (let i = 0; i < 15; i += 1) {
    await sleep(150);
    try {
      afterUdpPkt = await udpRoundtrip(ports.pubUdp, Buffer.from("udp-after"));
      lastErr = "";
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  must(
    "升级后公开 UDP 可通",
    Boolean(afterUdpPkt) && afterUdpPkt.toString() === "udp-after",
    lastErr || (afterUdpPkt ? afterUdpPkt.toString() : ""),
  );
  const afterUdpMaps = await api("GET", "/v1/mappings");
  const pubUdpAfter = (afterUdpMaps ?? []).find((m) => m.id === "map_udp");
  must("升级后公开 UDP 走 uplane", pubUdpAfter?.udpVia === "uplane", pubUdpAfter?.udpVia ?? "");
  let afterMap;
  lastErr = "";
  for (let i = 0; i < 15; i += 1) {
    await sleep(150);
    try {
      afterMap = await tcpRoundtrip(ports.afterTcp, Buffer.from("new-on-replacement\n"));
      lastErr = "";
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  must(
    "升级后新 mapping 流量走 replacement",
    Boolean(afterMap) && afterMap.toString() === "new-on-replacement\n",
    lastErr || (afterMap ? afterMap.toString().trim() : ""),
  );

  await api("POST", `/v1/nodes/${NODE_ID}/disconnect`);
  await sleep(200);
  const afterDisc = await tcpShouldDrop(ports.pubTcp, 800);
  must("节点断开后入口拒新连接", afterDisc.dropped, afterDisc.reason ?? afterDisc.got);

  echoTcp.close();
  echoUdp.close();
}

main()
  .catch((err) => {
    log("冒烟中断", false, err.message);
  })
  .finally(async () => {
    if (replacementPid) {
      try {
        process.kill(replacementPid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
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
