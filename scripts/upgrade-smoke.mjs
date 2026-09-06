#!/usr/bin/env node
// Generate data with a released binary, upgrade, then check rollback to that release.
// Uses only temporary storage and loopback ports. Never reads the user's runtime data.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "umbra-upgrade-qa-"));
const tag = process.argv[2] ?? "v0.1.5";
assert.match(tag, /^v\d+\.\d+\.\d+$/);
const children = [];
const sockets = new Set();
const echo = net.createServer((s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
  s.on("data", (d) => s.write(d));
});
async function port() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const n = server.address().port;
  await new Promise((r) => server.close(r));
  return n;
}
function command(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${bin} failed: ${r.stderr}`);
}
function start(bin, args, extra = {}) {
  const child = spawn(bin, args, {
    stdio: "ignore",
    env: {
      ...process.env,
      UMBRA_LOGIN: "off",
      UMBRA_UI_UPSTREAM: "",
      GROK_AGENT: "",
      GROK_PROJECT_ID: "",
      ...extra,
    },
  });
  children.push(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await delay(100);
  }
  child.kill("SIGKILL");
  throw new Error("process failed to shut down");
}
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {
      // A restarting gate can briefly refuse connections.
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  command("git", ["archive", "--format=tar", "-o", join(dir, "old.tar"), tag]);
  const oldSource = join(dir, "source");
  command("mkdir", ["-p", oldSource]);
  command("tar", ["-xf", join(dir, "old.tar"), "-C", oldSource]);
  command("go", ["build", "-o", join(dir, "old-gate"), "./cmd/umbrad"], oldSource);
  command("go", ["build", "-o", join(dir, "old-node"), "./cmd/umbra-node"], oldSource);
  command("go", ["build", "-o", join(dir, "new-gate"), "./cmd/umbrad"]);
  const tls = join(dir, "state");
  const http = await port();
  const tunnel = await port();
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const localPort = echo.address().port;
  const base = `http://127.0.0.1:${http}`;
  const args = [
    "-listen",
    `127.0.0.1:${tunnel}`,
    "-advertise",
    `127.0.0.1:${tunnel}`,
    "-http",
    `127.0.0.1:${http}`,
    "-bind",
    "127.0.0.1",
    "-tls-dir",
    tls,
    "-stealth",
    "off",
  ];
  async function api(path, data, method = data ? "POST" : "GET") {
    const r = await fetch(`${base}/v1/${path}`, {
      method,
      headers: data ? { "content-type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    const body = await r.text();
    assert.ok(r.ok, `${path}: ${r.status}`);
    return body ? JSON.parse(body) : undefined;
  }
  let gate = start(join(dir, "old-gate"), args);
  await until(async () => (await fetch(`${base}/health`)).ok, "old gate");
  const node = await api("nodes", {
    name: "upgrade-node",
    os: "linux",
    arch: "amd64",
    neverExpire: true,
  });
  start(join(dir, "old-node"), [
    "--server",
    `127.0.0.1:${tunnel}`,
    "--tls-ca",
    join(tls, "ca.crt"),
    "--token",
    node.token,
  ]);
  await until(
    async () => (await api("nodes")).some((n) => n.id === node.id && n.status === "online"),
    "old node online",
  );
  const expected = [];
  for (const mode of ["public", "spa", "visitor"]) {
    const input = {
      nodeId: node.id,
      name: `upgrade-${mode}`,
      proto: "tcp",
      mode,
      entryPort: mode === "visitor" ? null : await port(),
      localHost: "127.0.0.1",
      localPort,
      maxConns: 12,
      allowCidrs: "",
      rateKbps: 0,
      idleTimeoutSec: 0,
      spaTtlSec: 60,
      udpIdleTimeoutSec: 60,
    };
    const m = await api("mappings", input);
    expected.push({ ...input, id: m.id });
    await until(
      async () => (await api("mappings")).find((x) => x.id === m.id)?.pushState === "acked",
      "old configuration ack",
    );
    assert.ok((await api(`mappings/${m.id}/probe`, {})).bytesIn > 0);
  }
  const visitor = expected.find((m) => m.mode === "visitor");
  const ticket = await api(`mappings/${visitor.id}/visitor`, { label: "upgrade-ticket" });
  // Old releases flush history on shutdown, but save counters only periodically.
  // Explicitly save the fixture so this checks persisted-data compatibility.
  await until(
    async () => (await api("traffic?range=1h")).series.length >= 2,
    "old traffic samples",
    35000,
  );
  const before = await api("mappings");
  await api(`nodes/${node.id}`, { comment: "persist upgrade fixture" }, "PATCH");
  await stop(gate);
  cpSync(tls, join(dir, "pre-upgrade-backup"), { recursive: true });
  const ca = readFileSync(join(tls, "ca.crt"), "utf8");
  const controlPath = join(tls, "control.json");
  const oldBox = JSON.parse(readFileSync(controlPath, "utf8"));
  const stateBefore = oldBox.payload;
  for (const phase of ["new-gate", "old-gate"]) {
    gate = start(join(dir, phase), args);
    await until(async () => (await fetch(`${base}/health`)).ok, `${phase} startup`);
    await until(
      async () => (await api("nodes")).some((n) => n.id === node.id && n.status === "online"),
      `${phase} accepts original node credential`,
    );
    await until(
      async () => (await api("mappings")).every((m) => m.pushState === "acked"),
      `${phase} ack`,
    );
    const actual = await api("mappings");
    assert.equal(actual.length, expected.length);
    for (const spec of expected) {
      const m = actual.find((x) => x.id === spec.id);
      for (const key of [
        "nodeId",
        "name",
        "proto",
        "mode",
        "entryPort",
        "localHost",
        "localPort",
        "maxConns",
        "rateKbps",
      ])
        assert.equal(m[key], spec[key], `${phase} preserves ${key}`);
      assert.ok(m.bytesIn >= before.find((x) => x.id === m.id).bytesIn, "traffic counter retained");
      assert.ok((await api(`mappings/${m.id}/probe`, {})).bytesIn > 0, `${phase} service response`);
    }
    assert.ok(
      (await api(`tickets?mappingId=${visitor.id}`)).some((t) => t.id === ticket.id),
      "visitor ticket retained",
    );
    const traffic = await api(`traffic?range=1h&mappingId=${visitor.id}`);
    assert.ok(traffic.series.length >= 2, "historical service traffic retained");
    assert.equal(readFileSync(join(tls, "ca.crt"), "utf8"), ca, "CA retained");
    // Force an ordinary save by editing only the test node's description.
    await api(`nodes/${node.id}`, { comment: `saved by ${phase}` }, "PATCH");
    await stop(gate);
    const saved = JSON.parse(readFileSync(controlPath, "utf8"));
    assert.equal(saved.schema, oldBox.schema, "no storage schema bump");
    for (const key of ["owner_hash", "owner_secret", "two_factor"])
      assert.deepEqual(saved.payload[key], stateBefore[key], `auth field retained: ${key}`);
    console.log(
      `PASS ${phase}: original node, 3 access modes, config, counters, tickets, CA and traffic history`,
    );
  }
  console.log(
    `PASS upgrade ${tag} -> current -> ${tag}; synthetic data only; auth login is covered separately by Go tests`,
  );
} finally {
  for (const child of children.reverse()) await stop(child);
  for (const socket of sockets) socket.destroy();
  echo.close();
}
