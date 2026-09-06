import test from "node:test";
import assert from "node:assert/strict";
import type { Mapping, Node } from "./types.ts";
import { nodeServiceSummaries } from "./node-services.ts";
import { pageOf, PAGE_SIZE } from "./page.ts";

const nodes = Array.from(
  { length: 12 },
  (_, i) =>
    ({
      id: `n${i}`,
      name: `node-${String(i).padStart(2, "0")}`,
      status: i === 0 ? "offline" : "online",
    }) as Node,
);
const mappings = Array.from(
  { length: 35 },
  (_, i) =>
    ({
      id: `m${i}`,
      name: `service-${i}`,
      nodeId: "n0",
      nodeName: nodes[0].name,
      nodeStatus: "offline",
      enabled: true,
      proto: "tcp",
      mode: "public",
      localHost: "127.0.0.1",
      localPort: 8080,
      entryPort: 10000 + i,
    }) as Mapping,
);

test("node pagination aggregates all 35 services before paging 12 nodes", () => {
  const summaries = nodeServiceSummaries(nodes, mappings);
  const first = pageOf(summaries, 1, PAGE_SIZE);
  assert.equal(first.total, 12);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].summary.total, 35);
  assert.equal(first.items[0].summary.attention, 35);
  const second = pageOf(summaries, 2, PAGE_SIZE);
  assert.equal(second.items.length, 2);
  assert.equal(
    second.items.some((item) => item.node.id === "n0"),
    false,
  );
  assert.equal(summaries[1].summary.total, 0);
});

test("paging a node's services preserves its full summary and final partial page", () => {
  const group = nodeServiceSummaries(nodes, mappings)[0];
  assert.equal(pageOf(group.services, 4, PAGE_SIZE).items.length, 5);
  assert.equal(pageOf(group.services, 4, PAGE_SIZE).total, 35);
  assert.equal(group.summary.attention, 35);
  assert.equal(pageOf(group.services.slice(0, 3), 4, PAGE_SIZE).page, 1);
});

test("search finds nodes through services without shrinking the impact count", () => {
  const result = nodeServiceSummaries(nodes, mappings, "10034");
  assert.equal(result.length, 1);
  assert.equal(result[0].summary.total, 35);
  assert.equal(nodeServiceSummaries(nodes, mappings, "node-11")[0].summary.total, 0);
  assert.equal(nodeServiceSummaries(nodes, mappings, "missing").length, 0);
});

test("disabled services are counted separately from an offline node's affected services", () => {
  const result = nodeServiceSummaries(
    nodes,
    mappings.map((m, i) => ({ ...m, enabled: i >= 5 })),
  );
  assert.equal(result[0].summary.attention, 30);
  assert.equal(result[0].summary.disabled, 5);
});
