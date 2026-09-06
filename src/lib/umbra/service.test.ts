import test from "node:test";
import assert from "node:assert/strict";
import {
  serviceCanConnect,
  serviceState,
  serviceSummary,
  serviceMatches,
  targetAddress,
  validateService,
  type ServiceInput,
} from "./service.ts";
import type { Mapping } from "./types.ts";
const ready = {
  id: "one",
  name: "工作电脑",
  nodeName: "studio",
  nodeId: "node",
  proto: "tcp",
  mode: "visitor",
  enabled: true,
  nodeStatus: "online",
  pushState: "acked",
  listenState: "ready",
  activeConns: 0,
  maxConns: 1024,
  localHost: "::1",
  localPort: 22,
  entryPort: null,
} as Mapping;
test("pending visitor configuration is not ready, even with an online node", () => {
  assert.equal(serviceState({ ...ready, pushState: "pending" }).kind, "pending");
  assert.equal(serviceState({ ...ready, nodeStatus: "offline" }).kind, "attention");
  assert.equal(serviceState({ ...ready, nodeStatus: "revoked" }).label, "节点已吊销");
});
test("closed SPA and ticket access are normal authorization states, not faults", () => {
  assert.equal(serviceState(ready).kind, "ready");
  assert.equal(
    serviceState({ ...ready, mode: "spa", listenState: "listening", reach: "closed" }).kind,
    "ready",
  );
  assert.match(serviceState(ready).detail, /仍需实际验证/);
});
test("disabled, listener failure and UDP saturation remain distinct", () => {
  assert.equal(serviceState({ ...ready, enabled: false, nodeStatus: "offline" }).kind, "disabled");
  assert.equal(serviceState({ ...ready, listenError: "bind failed" }).kind, "attention");
  assert.equal(
    serviceState({ ...ready, proto: "udp", udpActive: 10, maxConns: 10 }).label,
    "连接已满",
  );
});
test("summary includes every node without assuming successful target probes", () => {
  assert.deepEqual(
    serviceSummary([
      ready,
      { ...ready, nodeId: "other", nodeStatus: "offline" },
      { ...ready, pushState: "pending" },
      { ...ready, enabled: false },
    ]),
    { total: 4, ready: 1, attention: 1, pending: 1, disabled: 1 },
  );
});
test("search matches ports, node and access language together", () => {
  assert.equal(serviceMatches(ready, "studio 22 凭证"), true);
  assert.equal(serviceMatches(ready, "studio 3306"), false);
  assert.equal(targetAddress("::1", 22), "[::1]:22");
  assert.equal(targetAddress("[::1]", 22), "[::1]:22");
});
const input: ServiceInput = {
  name: "SSH",
  nodeId: "node",
  proto: "tcp",
  mode: "visitor",
  localHost: "127.0.0.1",
  localPort: 22,
  entryPort: null,
  maxConns: 1024,
  idleTimeoutSec: 0,
  spaTtlSec: 60,
  udpIdleTimeoutSec: 60,
  rateKbps: 0,
  allowCidrs: "",
};
test("real target and public entry ports must be explicit and valid", () => {
  assert.equal(validateService(input), null);
  for (const port of [0, -1, 65536, 22.5, NaN])
    assert.ok(validateService({ ...input, localPort: port }));
  assert.ok(validateService({ ...input, mode: "public" }));
  assert.equal(validateService({ ...input, mode: "public", entryPort: 22022 }), null);
  assert.ok(validateService({ ...input, maxConns: NaN }));
});

test("a failed probe requests attention but does not prevent retrying or connecting", () => {
  const failed = { ...ready, lastProbeError: "EOF" };
  assert.equal(serviceState(failed).kind, "attention");
  assert.equal(serviceCanConnect(failed), true);
  assert.equal(serviceCanConnect({ ...failed, nodeStatus: "offline" }), false);
});
