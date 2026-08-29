import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultGroupOpen,
  filterMappings,
  filterNodeOptions,
  groupMappings,
  mappingFacets,
  mergeNodeOptions,
  preferredNodeId,
} from "./page.ts";
import type { MappingGroup } from "./page.ts";
import type { Mapping } from "./types.ts";

function mapping(partial: Partial<Mapping> & Pick<Mapping, "id" | "nodeId" | "nodeName">): Mapping {
  return {
    nodeStatus: "offline",
    name: partial.id,
    proto: "tcp",
    mode: "public",
    entryPort: 18000,
    localHost: "127.0.0.1",
    localPort: 22,
    enabled: true,
    listenState: "listening",
    listenError: null,
    pushState: "acked",
    bytesIn: 0,
    bytesOut: 0,
    activeConns: 0,
    lastProbeAt: null,
    lastProbePreview: null,
    grantUntil: null,
    maxConns: 64,
    rateKbps: 0,
    allowCidrs: "",
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:00Z",
    ...partial,
  };
}

describe("groupMappings", () => {
  const rows = [
    mapping({ id: "b", nodeId: "n2", nodeName: "load-204", nodeStatus: "offline", name: "ssh", entryPort: 22022 }),
    mapping({ id: "a", nodeId: "n1", nodeName: "load-111", nodeStatus: "online", name: "web", entryPort: 18080 }),
    mapping({ id: "c", nodeId: "n1", nodeName: "load-111", nodeStatus: "online", name: "dns", entryPort: 53, proto: "udp" }),
    mapping({ id: "d", nodeId: "n1", nodeName: "load-111", nodeStatus: "online", name: "visit", entryPort: null, mode: "visitor" }),
  ];

  it("filters then groups online nodes first and sorts ports", () => {
    const groups = groupMappings(rows);
    assert.deepEqual(
      groups.map((g) => g.nodeId),
      ["n1", "n2"],
    );
    assert.deepEqual(
      groups[0].items.map((m) => m.id),
      ["c", "a", "d"],
    );
    assert.equal(groups[0].items[2].mode, "visitor");
  });

  it("keeps proto filter before grouping", () => {
    const groups = groupMappings(rows, { proto: "udp" });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 1);
    assert.equal(groups[0].items[0].id, "c");
  });
});

describe("mappingFacets", () => {
  it("counts nodes, protos and modes from the current rows", () => {
    const rows = [
      mapping({ id: "a", nodeId: "n1", nodeName: "load-111", nodeStatus: "online", proto: "tcp", mode: "spa" }),
      mapping({ id: "b", nodeId: "n1", nodeName: "load-111", nodeStatus: "online", proto: "udp", mode: "public" }),
      mapping({ id: "c", nodeId: "n2", nodeName: "load-204", nodeStatus: "offline", proto: "tcp", mode: "spa" }),
    ];
    const facets = mappingFacets(rows);
    assert.deepEqual(
      facets.nodes.map((n) => [n.label, n.count]),
      [
        ["load-111", 2],
        ["load-204", 1],
      ],
    );
    assert.deepEqual(
      facets.protos.map((p) => [p.value, p.count]),
      [
        ["tcp", 2],
        ["udp", 1],
      ],
    );
    assert.equal(facets.modes.find((m) => m.value === "spa")?.count, 2);
    assert.equal(facets.modes.find((m) => m.value === "spa")?.label, "spa");
    assert.equal(facets.modes.find((m) => m.value === "spa")?.hint, "敲门访问");
    assert.equal(facets.modes.find((m) => m.value === "public")?.label, "public");
    assert.equal(facets.modes.find((m) => m.value === "public")?.hint, "公开访问");
    assert.equal(facets.nodes[0].status, "online");
    assert.equal(facets.nodes[1].status, "offline");
  });
});

describe("preferredNodeId", () => {
  it("keeps an explicit node and otherwise picks the first online one", () => {
    const nodes = [
      { value: "n1", label: "load-111", count: 2, status: "online" as const },
      { value: "n2", label: "load-204", count: 1, status: "offline" as const },
    ];
    assert.equal(preferredNodeId(nodes, "n2"), "n2");
    assert.equal(preferredNodeId(nodes), "n1");
  });
});

describe("mergeNodeOptions", () => {
  it("keeps mapping counts and adds nodes that have none", () => {
    const merged = mergeNodeOptions(
      [{ value: "n1", label: "load-111", count: 45, status: "online" }],
      [
        { id: "n1", name: "load-111", status: "online" },
        { id: "n2", name: "spare", status: "offline" },
      ],
    );
    assert.deepEqual(
      merged.map((n) => [n.value, n.count]),
      [
        ["n1", 45],
        ["n2", 0],
      ],
    );
  });
});

describe("filterNodeOptions", () => {
  it("filters by node name", () => {
    const nodes = [
      { value: "n1", label: "load-111", count: 2 },
      { value: "n2", label: "edge-hk", count: 1 },
    ];
    assert.deepEqual(
      filterNodeOptions(nodes, "hk").map((n) => n.value),
      ["n2"],
    );
  });
});

describe("filterMappings", () => {
  it("matches node name in search", () => {
    const rows = [mapping({ id: "a", nodeId: "n1", nodeName: "load-111", name: "ssh" })];
    assert.equal(filterMappings(rows, { q: "111" }).length, 1);
    assert.equal(filterMappings(rows, { q: "204" }).length, 0);
  });
});

describe("defaultGroupOpen", () => {
  it("opens every group when there are few nodes", () => {
    const open = defaultGroupOpen([
      { nodeId: "a", nodeName: "a", nodeStatus: "offline", items: [] },
      { nodeId: "b", nodeName: "b", nodeStatus: "online", items: [] },
    ]);
    assert.equal(open.a, true);
    assert.equal(open.b, true);
  });

  it("opens only online groups when there are many nodes", () => {
    const groups: MappingGroup[] = ["a", "b", "c", "d", "e"].map((id, i) => ({
      nodeId: id,
      nodeName: id,
      nodeStatus: i === 0 ? "online" : "offline",
      items: [],
    }));
    const open = defaultGroupOpen(groups);
    assert.equal(open.a, true);
    assert.equal(open.b, false);
  });

  it("opens only the focused node", () => {
    const open = defaultGroupOpen(
      [
        { nodeId: "a", nodeName: "a", nodeStatus: "online", items: [] },
        { nodeId: "b", nodeName: "b", nodeStatus: "online", items: [] },
      ],
      "b",
    );
    assert.equal(open.a, false);
    assert.equal(open.b, true);
  });
});
