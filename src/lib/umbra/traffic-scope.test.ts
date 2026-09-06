import test from "node:test";
import assert from "node:assert/strict";
import { parseTrafficSearch, resolveTrafficScope } from "./traffic-scope.ts";
import type { Node, Mapping } from "./types.ts";
const nodes = [{ id: "n1" }, { id: "n2" }] as Node[];
const mappings = [{ id: "s1", nodeId: "n1" }] as Mapping[];

test("traffic URLs normalize invalid ranges and retain valid shared scopes", () => {
  assert.deepEqual(
    parseTrafficSearch({ node: " n1 ", service: "s1", range: "7d", chart: "bytes" }),
    { node: "n1", service: "s1", range: "7d", chart: "bytes" },
  );
  assert.deepEqual(parseTrafficSearch({ node: 7, service: " ", range: "1y", chart: "unknown" }), {
    node: undefined,
    service: undefined,
    range: "24h",
    chart: "rate",
  });
});
test("service-only links resolve their node without broadening the scope", () => {
  const scope = resolveTrafficScope({ service: "s1" }, nodes, mappings);
  assert.equal(scope.nodeId, "n1");
  assert.equal(scope.service?.id, "s1");
  assert.equal(scope.error, undefined);
});
test("missing or mismatched scope is an error instead of a zero-valued chart", () => {
  assert.ok(resolveTrafficScope({ service: "gone" }, nodes, mappings).error);
  assert.ok(resolveTrafficScope({ node: "gone" }, nodes, mappings).error);
  assert.ok(resolveTrafficScope({ node: "n2", service: "s1" }, nodes, mappings).error);
  assert.equal(resolveTrafficScope({}, nodes, mappings).error, undefined);
});
