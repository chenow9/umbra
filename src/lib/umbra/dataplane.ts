import dgram from "node:dgram";
import net from "node:net";
import { ECHO_HOST, ECHO_PORT, type MappingWire } from "./protocol";

type UdpSess = {
  sock: dgram.Socket;
  timer: ReturnType<typeof setTimeout>;
};

type Entry = {
  mappingId: string;
  nodeId: string;
  mode: string;
  proto: "tcp" | "udp";
  port: number;
  localHost: string;
  localPort: number;
  nodeOnline: boolean;
  maxConns: number;
  rateKbps: number;
  allowCidrs: string;
  idleSec: number;
  active: number;
  windowStart: number;
  windowBytes: number;
  tcp?: net.Server;
  udp?: dgram.Socket;
  udpSessions?: Map<string, UdpSess>;
};

const g = globalThis as typeof globalThis & {
  __umbraEntries__?: Map<string, Entry>;
  __umbraGrants__?: Map<string, Map<string, number>>;
  __umbraEcho__?: net.Server;
  __umbraEchoUdp__?: dgram.Socket;
};

function entries() {
  g.__umbraEntries__ ??= new Map();
  return g.__umbraEntries__;
}

function grants() {
  g.__umbraGrants__ ??= new Map();
  return g.__umbraGrants__;
}

function grantMap(mappingId: string) {
  const all = grants();
  let byIP = all.get(mappingId);
  if (!byIP) {
    byIP = new Map();
    all.set(mappingId, byIP);
  }
  return byIP;
}

export function ensureEcho(): Promise<void> {
  const tcp = g.__umbraEcho__?.listening
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const server = net.createServer((sock) => {
          sock.on("error", () => undefined);
          sock.on("data", (buf) => sock.write(buf));
        });
        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") resolve();
          else reject(err);
        });
        server.listen(ECHO_PORT, ECHO_HOST, () => {
          g.__umbraEcho__ = server;
          resolve();
        });
      });
  const udp = g.__umbraEchoUdp__
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const sock = dgram.createSocket("udp4");
        sock.on("message", (msg, rinfo) => {
          sock.send(msg, rinfo.port, rinfo.address);
        });
        sock.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") resolve();
          else reject(err);
        });
        sock.bind(ECHO_PORT, ECHO_HOST, () => {
          g.__umbraEchoUdp__ = sock;
          resolve();
        });
      });
  return Promise.all([tcp, udp]).then(() => undefined);
}

export function knockGrant(mappingId: string, ip = "127.0.0.1", ttlMs = 60_000) {
  const until = Date.now() + ttlMs;
  grantMap(mappingId).set(ip || "*", until);
  return until;
}

export function isGranted(mappingId: string, ip?: string) {
  const byIP = grants().get(mappingId);
  if (!byIP) return false;
  const now = Date.now();
  let live = false;
  for (const [src, until] of byIP) {
    if (until <= now) {
      byIP.delete(src);
      continue;
    }
    if (src === "*" || ip == null || src === ip) live = true;
  }
  if (byIP.size === 0) grants().delete(mappingId);
  return live;
}

export function grantUntilIso(mappingId: string): string | null {
  const byIP = grants().get(mappingId);
  if (!byIP) return null;
  let latest = 0;
  const now = Date.now();
  for (const until of byIP.values()) {
    if (until > now && until > latest) latest = until;
  }
  return latest ? new Date(latest).toISOString() : null;
}

function normalizeIp(addr: string | undefined) {
  if (!addr) return "0.0.0.0";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function ipToInt(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

export function cidrAllowed(ip: string, cidrs: string) {
  const list = cidrs.split(/[,\s]+/).filter(Boolean);
  if (list.length === 0) return true;
  const n = ipToInt(normalizeIp(ip));
  if (n == null) return false;
  return list.some((raw) => {
    const [base, bitsRaw] = raw.split("/");
    const b = ipToInt(base ?? "");
    if (b == null) return false;
    const bits = bitsRaw == null || bitsRaw === "" ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  });
}

function takeRate(e: Entry, bytes: number) {
  if (e.rateKbps <= 0) return true;
  const now = Date.now();
  if (now - e.windowStart > 1000) {
    e.windowStart = now;
    e.windowBytes = 0;
  }
  if (e.windowBytes + bytes > e.rateKbps * 1024) return false;
  e.windowBytes += bytes;
  return true;
}

function applyPolicy(e: Entry, spec: MappingWire) {
  e.maxConns = spec.max_conns || 64;
  e.rateKbps = spec.rate_kbps || 0;
  e.allowCidrs = spec.allow_cidrs || "";
  e.idleSec = spec.udp_idle_timeout_sec || spec.idle_timeout_sec || 60;
}

function admit(e: Entry, ip: string): "ok" | "acl" | "conns" {
  if (!cidrAllowed(ip, e.allowCidrs)) return "acl";
  if (e.active >= e.maxConns) return "conns";
  return "ok";
}

function policyOf(spec: MappingWire): Pick<Entry, "maxConns" | "rateKbps" | "allowCidrs" | "idleSec" | "active" | "windowStart" | "windowBytes"> {
  return {
    maxConns: spec.max_conns || 64,
    rateKbps: spec.rate_kbps || 0,
    allowCidrs: spec.allow_cidrs || "",
    idleSec: spec.udp_idle_timeout_sec || spec.idle_timeout_sec || 60,
    active: 0,
    windowStart: 0,
    windowBytes: 0,
  };
}

function closeUdpSessions(e: Entry) {
  if (!e.udpSessions) return;
  for (const s of e.udpSessions.values()) {
    clearTimeout(s.timer);
    try {
      s.sock.close();
    } catch {
      /* ignore */
    }
  }
  e.udpSessions.clear();
}

export function stopEntry(mappingId: string): Promise<void> {
  const e = entries().get(mappingId);
  if (!e) return Promise.resolve();
  entries().delete(mappingId);
  closeUdpSessions(e);
  const tcp = e.tcp ?? (e as Entry & { server?: net.Server }).server;
  return new Promise((resolve) => {
    let left = 0;
    const done = () => {
      left -= 1;
      if (left <= 0) resolve();
    };
    if (tcp) {
      left += 1;
      tcp.close(() => done());
      tcp.unref();
    }
    if (e.udp) {
      left += 1;
      e.udp.close(() => done());
    }
    if (left === 0) resolve();
  });
}

export function markNodeOnline(nodeId: string, online: boolean) {
  for (const e of entries().values()) {
    if (e.nodeId === nodeId) e.nodeOnline = online;
  }
}

export async function dropNodeEntries(nodeId: string) {
  const ids = [...entries().values()].filter((e) => e.nodeId === nodeId).map((e) => e.mappingId);
  await Promise.all(ids.map((id) => stopEntry(id)));
}

function handleConn(mappingId: string, sock: net.Socket) {
  const e = entries().get(mappingId);
  if (!e) {
    sock.destroy();
    return;
  }
  if (e.mode === "spa" && !isGranted(mappingId, normalizeIp(sock.remoteAddress))) {
    sock.destroy();
    return;
  }
  if (!e.nodeOnline) {
    sock.destroy();
    return;
  }
  const why = admit(e, sock.remoteAddress ?? "");
  if (why !== "ok") {
    sock.destroy();
    return;
  }
  e.active += 1;
  const target = net.connect(e.localPort, e.localHost);
  const fail = () => {
    sock.destroy();
    target.destroy();
  };
  const done = () => {
    e.active = Math.max(0, e.active - 1);
  };
  sock.setTimeout(e.idleSec * 1000);
  target.setTimeout(e.idleSec * 1000);
  sock.on("timeout", fail);
  target.on("timeout", fail);
  target.on("error", fail);
  sock.on("error", fail);
  sock.on("close", done);
  sock.on("data", (buf) => {
    if (!takeRate(e, buf.length)) fail();
  });
  target.on("data", (buf) => {
    if (!takeRate(e, buf.length)) fail();
  });
  sock.pipe(target);
  target.pipe(sock);
}

function handleUdp(e: Entry, msg: Buffer, rinfo: dgram.RemoteInfo) {
  if (!e.nodeOnline || !e.udp) return;
  if (admit(e, rinfo.address) !== "ok") return;
  if (!takeRate(e, msg.length)) return;
  e.udpSessions ??= new Map();
  const key = `${rinfo.address}:${rinfo.port}`;
  let sess = e.udpSessions.get(key);
  if (!sess) {
    if (e.mode === "spa" && !isGranted(e.mappingId, normalizeIp(rinfo.address))) return;
    e.active += 1;
    const sock = dgram.createSocket("udp4");
    sock.on("message", (reply) => {
      if (!takeRate(e, reply.length)) return;
      e.udp?.send(reply, rinfo.port, rinfo.address);
    });
    sock.on("error", () => undefined);
    const drop = () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      e.udpSessions?.delete(key);
      e.active = Math.max(0, e.active - 1);
    };
    const timer = setTimeout(drop, e.idleSec * 1000);
    sess = { sock, timer };
    e.udpSessions.set(key, sess);
  } else {
    clearTimeout(sess.timer);
    sess.timer = setTimeout(() => {
      try {
        sess!.sock.close();
      } catch {
        /* ignore */
      }
      e.udpSessions?.delete(key);
      e.active = Math.max(0, e.active - 1);
    }, e.idleSec * 1000);
  }
  sess.sock.send(msg, e.localPort, e.localHost);
}

export function syncEntry(
  spec: MappingWire & { nodeId: string; nodeOnline: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!spec.enabled || spec.mode === "visitor" || spec.entry_port == null) {
    return stopEntry(spec.id).then(() => ({ ok: true }));
  }
  const port = spec.entry_port;
  const proto = spec.proto;
  const cur = entries().get(spec.id);
  if (
    cur &&
    cur.port === port &&
    cur.proto === proto &&
    cur.localHost === spec.local_host &&
    cur.localPort === spec.local_port &&
    cur.mode === spec.mode
  ) {
    cur.nodeOnline = spec.nodeOnline;
    cur.nodeId = spec.nodeId;
    applyPolicy(cur, spec);
    return Promise.resolve({ ok: true });
  }
  return stopEntry(spec.id).then(
    () =>
      new Promise((resolve) => {
        if (proto === "udp") {
          const udp = dgram.createSocket("udp4");
          udp.on("message", (msg, rinfo) => {
            const e = entries().get(spec.id);
            if (e) handleUdp(e, msg, rinfo);
          });
          udp.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              entries().set(spec.id, {
                mappingId: spec.id,
                nodeId: spec.nodeId,
                mode: spec.mode,
                proto: "udp",
                port,
                localHost: spec.local_host,
                localPort: spec.local_port,
                nodeOnline: spec.nodeOnline,
                ...policyOf(spec),
              });
              resolve({ ok: true });
              return;
            }
            resolve({ ok: false, error: err.message });
          });
          udp.bind(port, "127.0.0.1", () => {
            entries().set(spec.id, {
              mappingId: spec.id,
              nodeId: spec.nodeId,
              mode: spec.mode,
              proto: "udp",
              port,
              localHost: spec.local_host,
              localPort: spec.local_port,
              nodeOnline: spec.nodeOnline,
              udp,
              ...policyOf(spec),
            });
            resolve({ ok: true });
          });
          return;
        }
        const server = net.createServer((sock) => handleConn(spec.id, sock));
        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            entries().set(spec.id, {
              mappingId: spec.id,
              nodeId: spec.nodeId,
              mode: spec.mode,
              proto: "tcp",
              port,
              localHost: spec.local_host,
              localPort: spec.local_port,
              nodeOnline: spec.nodeOnline,
              ...policyOf(spec),
            });
            resolve({ ok: true });
            return;
          }
          resolve({ ok: false, error: err.message });
        });
        server.listen(port, "127.0.0.1", () => {
          entries().set(spec.id, {
            mappingId: spec.id,
            nodeId: spec.nodeId,
            mode: spec.mode,
            proto: "tcp",
            port,
            localHost: spec.local_host,
            localPort: spec.local_port,
            tcp: server,
            nodeOnline: spec.nodeOnline,
            ...policyOf(spec),
          });
          resolve({ ok: true });
        });
      }),
  );
}

export async function syncNodeEntries(
  nodeId: string,
  wires: MappingWire[],
  nodeOnline: boolean,
) {
  const want = new Set(wires.map((w) => w.id));
  for (const e of [...entries().values()]) {
    if (e.nodeId === nodeId && !want.has(e.mappingId)) await stopEntry(e.mappingId);
  }
  const errors: { id: string; error: string }[] = [];
  for (const w of wires) {
    const r = await syncEntry({ ...w, nodeId, nodeOnline });
    if (!r.ok && r.error) errors.push({ id: w.id, error: r.error });
  }
  return { errors };
}

export function dialTarget(host: string, port: number, payload: Buffer): Promise<{ rx: Buffer; tx: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const chunks: Buffer[] = [];
    const finish = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
    };
    const timer = setTimeout(() => finish(new Error("目标无响应")), 2500);
    sock.setTimeout(2500);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (buf) => {
      chunks.push(buf);
      sock.end();
    });
    sock.on("timeout", () => finish(new Error("目标无响应")));
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      const rx = Buffer.concat(chunks);
      if (rx.length === 0) {
        reject(new Error("连接已丢弃或没有返回数据"));
        return;
      }
      resolve({ rx, tx: payload.length });
    });
  });
}

export function dialUdp(host: string, port: number, payload: Buffer): Promise<{ rx: Buffer; tx: number }> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error("报文无响应"));
    }, 2500);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve({ rx: msg, tx: payload.length });
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

export function probeEntry(port: number, payload: Buffer, proto: "tcp" | "udp" = "tcp") {
  return proto === "udp" ? dialUdp("127.0.0.1", port, payload) : dialTarget("127.0.0.1", port, payload);
}
