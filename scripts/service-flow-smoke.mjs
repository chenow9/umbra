#!/usr/bin/env node
// Isolated loopback integration test. Never reads or mutates an existing gate.
// Run build:embed-ui first to also inspect the built console. --keep retains the
// disposable gate until interrupted, for manual browser QA.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "umbra-service-qa-"));
const keep = process.argv.includes("--keep");
const children = [];
const sockets = new Set();
const tcp = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("data", (data) => socket.write(data));
});
const udp = dgram.createSocket("udp4");
udp.on("message", (data, peer) => udp.send(data, peer.port, peer.address));
const silent = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("data", () => socket.end());
});
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* startup and cleanup may race with process exit */
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function start(bin, args, env = {}) {
  const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
}
async function cleanup() {
  for (const child of children.reverse()) child.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  tcp.close();
  silent.close();
  try {
    udp.close();
  } catch {
    /* startup and cleanup may race with process exit */
  }
  await delay(150);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
process.once("SIGINT", () => void cleanup().then(() => process.exit()));
process.once("SIGTERM", () => void cleanup().then(() => process.exit()));

try {
  for (const name of ["umbrad", "umbra-node"]) {
    const build = spawnSync("go", ["build", "-o", join(dir, name), `./cmd/${name}`], {
      stdio: "inherit",
    });
    assert.equal(build.status, 0, `build ${name}`);
  }
  const httpPort = await freePort();
  const tunnelPort = await freePort();
  const tcpPort = await listen(tcp);
  const silentPort = await listen(silent);
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${httpPort}`;
  start(
    join(dir, "umbrad"),
    [
      "-listen",
      `127.0.0.1:${tunnelPort}`,
      "-advertise",
      `127.0.0.1:${tunnelPort}`,
      "-http",
      `127.0.0.1:${httpPort}`,
      "-bind",
      "127.0.0.1",
      "-tls-dir",
      dir,
      "-stealth",
      "off",
    ],
    { UMBRA_LOGIN: "off", UMBRA_UI_UPSTREAM: "", GROK_AGENT: "", GROK_PROJECT_ID: "" },
  );
  await until(async () => (await fetch(`${base}/health`)).ok, "gate startup");
  async function api(path, data, method = data ? "POST" : "GET") {
    const response = await fetch(`${base}/v1/${path}`, {
      method,
      headers: data ? { "content-type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    const body = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${body}`);
    return body ? JSON.parse(body) : undefined;
  }
  const node = await api("nodes", {
    name: "QA 工作电脑",
    os: process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "amd64",
  });
  start(join(dir, "umbra-node"), [
    "--server",
    `127.0.0.1:${tunnelPort}`,
    "--tls-ca",
    join(dir, "ca.crt"),
    "--token",
    node.token,
  ]);
  await until(
    async () => (await api("nodes")).some((n) => n.id === node.id && n.status === "online"),
    "node enrollment",
  );
  const baseInput = {
    nodeId: node.id,
    localHost: "127.0.0.1",
    localPort: tcpPort,
    proto: "tcp",
    maxConns: 32,
    allowCidrs: "",
    idleTimeoutSec: 0,
    spaTtlSec: 60,
    udpIdleTimeoutSec: 60,
    rateKbps: 0,
  };
  const services = [];
  for (const mode of ["visitor", "spa", "public"]) {
    const mapping = await api("mappings", {
      ...baseInput,
      name: `QA ${mode}`,
      mode,
      entryPort: mode === "visitor" ? null : await freePort(),
    });
    services.push(mapping);
    await until(
      async () => (await api("mappings")).find((m) => m.id === mapping.id)?.pushState === "acked",
      `${mode} acknowledgement`,
    );
    const result = await api(`mappings/${mapping.id}/probe`, {});
    assert.ok(result.bytesIn > 0, `${mode} response`);
    const view = (await api("mappings")).find((m) => m.id === mapping.id);
    assert.equal(view.entryAddress, mode === "visitor" ? "" : `127.0.0.1:${mapping.entryPort}`);
  }
  const udpService = await api("mappings", {
    ...baseInput,
    proto: "udp",
    mode: "public",
    name: "QA UDP",
    localPort: udp.address().port,
    entryPort: await freePort(),
  });
  await until(
    async () => (await api("mappings")).find((m) => m.id === udpService.id)?.pushState === "acked",
    "UDP acknowledgement",
  );
  assert.ok((await api(`mappings/${udpService.id}/probe`, {})).bytesIn > 0, "UDP response");
  const ticket = await api(`mappings/${services[0].id}/visitor`, { label: "QA disposable" });
  const mine = await api(`tickets?mappingId=${services[0].id}`);
  assert.ok(
    mine.some((t) => t.id === ticket.id),
    "issued ticket listed",
  );
  assert.equal(
    (await api(`tickets?mappingId=${services[1].id}`)).length,
    0,
    "tickets scoped to service",
  );
  await api(`tickets/${ticket.id}/delete`, {});
  assert.equal((await api(`tickets?mappingId=${services[0].id}`)).length, 0, "ticket revoked");
  const spa = await api(`mappings/${services[1].id}/knock`, {});
  assert.equal(spa.ip, "127.0.0.1");
  assert.ok(Date.parse(spa.until) > Date.now());
  const failure = await api("mappings", {
    ...baseInput,
    name: "QA 无响应目标",
    mode: "visitor",
    entryPort: null,
    localPort: silentPort,
  });
  await until(
    async () => (await api("mappings")).find((m) => m.id === failure.id)?.pushState === "acked",
    "silent target acknowledgement",
  );
  const failedProbe = await fetch(`${base}/v1/mappings/${failure.id}/probe`, { method: "POST" });
  assert.equal(failedProbe.status, 400, "no response must not report success");
  assert.ok((await api("mappings")).find((m) => m.id === failure.id).lastProbeError);
  await api(`mappings/${services[2].id}/enabled`, { enabled: false });
  assert.equal((await api("mappings")).find((m) => m.id === services[2].id).reach, "disabled");
  await api(`mappings/${services[2].id}/enabled`, { enabled: true });
  const offline = await api("nodes", { name: "QA 离线节点", os: "linux", arch: "amd64" });
  await api("mappings", {
    ...baseInput,
    nodeId: offline.id,
    name: "QA 待接入服务",
    mode: "visitor",
    entryPort: null,
  });
  const temp = await api("mappings", {
    ...baseInput,
    name: "QA 删除回归",
    mode: "visitor",
    entryPort: null,
  });
  await api(`mappings/${temp.id}/delete`, {});
  assert.ok(!(await api("mappings")).some((m) => m.id === temp.id));
  for (const path of ["/", "/mappings", "/nodes", "/traffic", "/audit", "/deploy"])
    assert.equal((await fetch(base + path)).status, 200, path);
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify(
      {
        url: base,
        passed: [
          "node enrollment",
          "TCP public/spa/visitor probes",
          "UDP probe",
          "entry address",
          "ticket issue/scope/revoke",
          "SPA grant",
          "no-response failure",
          "enable/disable",
          "delete",
          "embedded UI routes",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: node enrollment, TCP/UDP, three access modes, probe failure, scoped ticket lifecycle, enable/disable/delete and embedded routes.\nPreview: ${base}\nEvidence: ${join(dir, "result.json")}`,
  );
  // Generate fresh traffic after all config writes; no save mutation before SIGTERM.
  const target = services.find((m) => m.mode === "public");
  const beforeSaved = JSON.parse(readFileSync(join(dir, "control.json"), "utf8")).payload.maps.find(
    (m) => m.Spec.id === target.id || m.Spec.ID === target.id,
  );
  for (let i = 0; i < 15; i++) await api(`mappings/${target.id}/probe`, {});
  const beforeStop = (await api("mappings")).find((m) => m.id === target.id);
  assert.ok(beforeSaved, "saved mapping found");
  assert.ok(beforeStop.bytesIn > beforeSaved.BytesIn, "fixture has unsaved inbound traffic");
  const gate = children[0];
  gate.kill("SIGTERM");
  await until(() => gate.exitCode !== null || gate.signalCode !== null, "graceful shutdown");
  const saved = JSON.parse(readFileSync(join(dir, "control.json"), "utf8")).payload.maps.find(
    (m) => m.Spec.id === target.id || m.Spec.ID === target.id,
  );
  assert.ok(
    saved.BytesIn >= beforeStop.bytesIn && saved.BytesOut >= beforeStop.bytesOut,
    "shutdown saved fresh totals",
  );
  start(
    join(dir, "umbrad"),
    [
      "-listen",
      `127.0.0.1:${tunnelPort}`,
      "-advertise",
      `127.0.0.1:${tunnelPort}`,
      "-http",
      `127.0.0.1:${httpPort}`,
      "-bind",
      "127.0.0.1",
      "-tls-dir",
      dir,
      "-stealth",
      "off",
    ],
    { UMBRA_LOGIN: "off", UMBRA_UI_UPSTREAM: "", GROK_AGENT: "", GROK_PROJECT_ID: "" },
  );
  await until(async () => (await fetch(`${base}/health`)).ok, "restart");
  const restored = (await api("mappings")).find((m) => m.id === target.id);
  assert.ok(
    restored.bytesIn >= beforeStop.bytesIn && restored.bytesOut >= beforeStop.bytesOut,
    "restart retains totals",
  );
  assert.ok(
    (await api(`traffic?range=1h&mappingId=${target.id}`)).series.length > 0,
    "restart retains history",
  );
  console.log(
    "PASS: fresh unsaved traffic -> SIGTERM -> on-disk totals -> process restart -> counters and history retained",
  );
  await until(
    async () =>
      (await api("mappings"))
        .filter((m) => m.nodeId === node.id)
        .every((m) => !m.enabled || m.pushState === "acked"),
    "node reconnect after restart",
  );
  if (keep) {
    console.log("Disposable loopback QA instance retained; press Ctrl-C to stop.");
    await new Promise(() => {});
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
