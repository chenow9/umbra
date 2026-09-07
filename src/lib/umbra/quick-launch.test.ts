import test from "node:test";
import assert from "node:assert/strict";
import { QUICK_LAUNCH_LIMIT, quickLaunchHits } from "./quick-launch.ts";
import type { Mapping, Node } from "./types.ts";

const mapping = (over: Partial<Mapping> & Pick<Mapping, "id" | "name">): Mapping =>
  ({
    nodeName: "studio",
    nodeId: "node",
    proto: "tcp",
    mode: "visitor",
    enabled: true,
    nodeStatus: "online",
    pushState: "acked",
    listenState: "ready",
    localHost: "127.0.0.1",
    localPort: 22,
    entryPort: null,
    ...over,
  }) as Mapping;

const node = (over: Partial<Node> & Pick<Node, "id" | "name">): Node =>
  ({
    comment: "",
    status: "online",
    addr: "10.0.0.1",
    version: "1",
    os: "linux",
    arch: "amd64",
    lastSeen: null,
    enabled: true,
    createdAt: "",
    mappingCount: 1,
    bytesIn: 0,
    bytesOut: 0,
    ...over,
  }) as Node;

test("empty query hides inventory", () => {
  const hits = quickLaunchHits(
    "",
    [mapping({ id: "m1", name: "ssh" })],
    [node({ id: "n1", name: "mac" })],
  );
  assert.equal(hits.searching, false);
  assert.equal(hits.mappings.length, 0);
  assert.equal(hits.nodes.length, 0);
  assert.equal(hits.mappingMore, 0);
  assert.equal(hits.nodeMore, 0);
});

test("query ranks matching services and nodes without dumping the rest", () => {
  const hits = quickLaunchHits(
    "mac",
    [
      mapping({ id: "m1", name: "ssh", nodeName: "mac" }),
      mapping({ id: "m2", name: "web", nodeName: "ql" }),
    ],
    [node({ id: "n1", name: "mac" }), node({ id: "n2", name: "ql" })],
  );
  assert.equal(hits.searching, true);
  assert.deepEqual(
    hits.mappings.map((m) => m.id),
    ["m1"],
  );
  assert.deepEqual(
    hits.nodes.map((n) => n.id),
    ["n1"],
  );
  assert.equal(hits.mappingMore, 0);
  assert.equal(hits.nodeMore, 0);
});

test("caps each group and reports the remainder", () => {
  const mappings = Array.from({ length: QUICK_LAUNCH_LIMIT + 3 }, (_, i) =>
    mapping({ id: `m${i}`, name: `ssh-${String(i).padStart(2, "0")}` }),
  );
  const nodes = Array.from({ length: QUICK_LAUNCH_LIMIT + 1 }, (_, i) =>
    node({ id: `n${i}`, name: `box-${String(i).padStart(2, "0")}` }),
  );
  const hits = quickLaunchHits("ssh", mappings, nodes);
  assert.equal(hits.mappings.length, QUICK_LAUNCH_LIMIT);
  assert.equal(hits.mappingMore, 3);
  assert.equal(hits.nodes.length, 0);
  assert.equal(hits.nodeMore, 0);
  const nodeHits = quickLaunchHits("box", mappings, nodes);
  assert.equal(nodeHits.nodes.length, QUICK_LAUNCH_LIMIT);
  assert.equal(nodeHits.nodeMore, 1);
});
