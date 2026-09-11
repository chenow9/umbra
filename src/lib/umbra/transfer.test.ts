import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExportRequest,
  defaultSelection,
  exportFilename,
  previewServices,
  retargetBinding,
  serviceLine,
  setAllMatchedAction,
  suggestBindings,
  withServiceActions,
  type ImportPreview,
} from "./transfer.ts";
import type { Node } from "./types.ts";

const nodes = [
  { id: "n1", name: "a", status: "online" },
  { id: "n2", name: "b", status: "revoked" },
] as Node[];

const preview = {
  valid: true,
  canApply: true,
  sourceId: "src_1",
  exportedAt: "",
  localNodes: [
    { id: "local-1", name: "existing", status: "offline", enabled: true, mappingCount: 0 },
  ],
  nodes: [
    {
      originId: "orig-1",
      name: "office",
      comment: "",
      os: "linux",
      arch: "amd64",
      previousLocalNodeIds: ["local-1"],
      services: [
        {
          originId: "svc-1",
          name: "ssh",
          proto: "tcp",
          mode: "visitor",
          entryPort: null,
          localHost: "127.0.0.1",
          localPort: 22,
          enabled: true,
          matchedLocalId: "map-1",
          action: "skip",
        },
        {
          originId: "svc-2",
          name: "web",
          proto: "tcp",
          mode: "visitor",
          entryPort: null,
          localHost: "127.0.0.1",
          localPort: 80,
          enabled: true,
          action: "create",
        },
      ],
    },
  ],
  summary: {
    nodesCreate: 0,
    nodesBind: 1,
    servicesCreate: 1,
    servicesUpdate: 0,
    servicesSkip: 1,
    conflicts: 0,
  },
} as ImportPreview;

test("export selection omits revoked nodes and can preselect one", () => {
  assert.deepEqual(defaultSelection(nodes), { n1: "all" });
  assert.deepEqual(defaultSelection(nodes, "n1"), { n1: "all" });
  assert.deepEqual(buildExportRequest({ n1: "all", n2: ["s1"] }), {
    nodes: [{ id: "n1" }, { id: "n2", serviceIds: ["s1"] }],
  });
});

test("suggested bindings reuse a previous local node when it is still usable", () => {
  const bindings = suggestBindings(preview);
  assert.equal(bindings[0].action, "bind");
  assert.equal(bindings[0].localNodeId, "local-1");
});

test("matched services default to skip and can bulk-update", () => {
  const withActions = withServiceActions(suggestBindings(preview), preview);
  assert.deepEqual(withActions[0].services, [
    { originId: "svc-1", action: "skip" },
    { originId: "svc-2", action: "create" },
  ]);
  const updated = setAllMatchedAction(withActions, preview, "update");
  assert.equal(updated[0].services?.[0].action, "update");
  assert.equal(updated[0].services?.[1].action, "create");
});

test("retargeting a node drops stale skip/update actions", () => {
  const bound = withServiceActions(suggestBindings(preview), preview);
  assert.equal(bound[0].services?.[0].action, "skip");
  const created = retargetBinding(bound[0], { action: "create" });
  assert.equal(created.action, "create");
  assert.equal(created.localNodeId, undefined);
  assert.deepEqual(created.services, []);
  const rebound = retargetBinding(created, { action: "bind", localNodeId: "other" });
  assert.equal(rebound.localNodeId, "other");
  assert.deepEqual(rebound.services, []);
});

test("preview helpers tolerate a missing service list", () => {
  assert.deepEqual(previewServices({ services: null }), []);
  assert.deepEqual(previewServices(undefined), []);
  assert.equal(setAllMatchedAction(suggestBindings(preview), { ...preview, nodes: [{ ...preview.nodes[0], services: null }] }, "update")[0].services?.length, 0);
});

test("service line and export filename stay compact", () => {
  assert.equal(
    serviceLine({ proto: "tcp", mode: "public", entryPort: 443, localHost: "10.0.0.2", localPort: 443 }),
    "tcp/443 → 10.0.0.2:443",
  );
  assert.equal(
    serviceLine({ proto: "tcp", mode: "visitor", entryPort: null, localHost: "127.0.0.1", localPort: 22 }),
    "tcp 127.0.0.1:22",
  );
  assert.equal(exportFilename(new Date("2026-09-11T00:00:00Z")), "umbra-nodes-2026-09-11.json");
});
