import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveBps, mergeTrafficView, peakBpsFromSeries } from "./live.ts";
import type { LiveEvent, Mapping, Overview, TrafficView } from "./types.ts";

function overview(bpsIn = 0, bpsOut = 0): Overview {
  return {
    nodesOnline: 1,
    nodesTotal: 1,
    mappingsActive: 1,
    mappingsTotal: 1,
    bytesInToday: 0,
    bytesOutToday: 0,
    bpsIn,
    bpsOut,
    recentAudit: [],
  };
}

function mapping(partial: Partial<Mapping> & Pick<Mapping, "id" | "bytesIn" | "bytesOut">): Mapping {
  return {
    nodeId: "n1",
    nodeName: "node",
    nodeStatus: "online",
    name: partial.id,
    proto: "tcp",
    mode: "public",
    entryPort: 18000,
    localHost: "127.0.0.1",
    localPort: 19224,
    enabled: true,
    listenState: "listening",
    listenError: null,
    pushState: "acked",
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

function ev(partial: Partial<LiveEvent> & Pick<LiveEvent, "ts" | "mappings">): LiveEvent {
  return {
    overview: overview(),
    nodes: [],
    sample: null,
    ...partial,
  };
}

describe("peakBpsFromSeries", () => {
  it("uses positive deltas over elapsed time", () => {
    const p = peakBpsFromSeries([
      { ts: "2026-08-28T00:00:00Z", bytesIn: 0, bytesOut: 0 },
      { ts: "2026-08-28T00:00:02Z", bytesIn: 2000, bytesOut: 1000 },
    ]);
    assert.equal(p.in, 1000);
    assert.equal(p.out, 500);
  });

  it("ignores counter resets", () => {
    const p = peakBpsFromSeries([
      { ts: "2026-08-28T00:00:00Z", bytesIn: 5000, bytesOut: 5000 },
      { ts: "2026-08-28T00:00:01Z", bytesIn: 10, bytesOut: 10 },
    ]);
    assert.equal(p.in, 0);
    assert.equal(p.out, 0);
  });
});

describe("mergeTrafficView peaks and rates", () => {
  it("raises peak from live bps and keeps it when traffic stops", () => {
    const key = ["umbra", "traffic", "24h", "", ""];
    const m = mapping({ id: "m1", bytesIn: 1000, bytesOut: 800, bpsIn: 2_000_000, bpsOut: 1_500_000 });
    const burst = ev({
      ts: "2026-08-28T00:00:01Z",
      overview: overview(2_000_000, 1_500_000),
      mappings: [m],
    });
    const mid = mergeTrafficView(undefined, burst, key);
    assert.equal(mid.bpsIn, 2_000_000);
    assert.equal(mid.bpsOut, 1_500_000);
    assert.equal(mid.peakBpsIn, 2_000_000);
    assert.equal(mid.peakBpsOut, 1_500_000);

    const idle = ev({
      ts: "2026-08-28T00:00:02Z",
      overview: overview(0, 0),
      mappings: [{ ...m, bpsIn: 0, bpsOut: 0, bytesIn: 1000, bytesOut: 800 }],
    });
    const after = mergeTrafficView(mid, idle, key);
    assert.equal(after.bpsIn, 0);
    assert.equal(after.bpsOut, 0);
    assert.equal(after.peakBpsIn, 2_000_000);
    assert.equal(after.peakBpsOut, 1_500_000);
  });

  it("does not freeze peak at the last GET value during a faster live burst", () => {
    const key = ["umbra", "traffic", "24h", "", ""];
    const old: TrafficView = {
      bytesIn: 10,
      bytesOut: 10,
      bpsIn: 0,
      bpsOut: 0,
      peakBpsIn: 100,
      peakBpsOut: 100,
      series: [{ ts: "2026-08-28T00:00:00Z", bytesIn: 10, bytesOut: 10 }],
    };
    const next = mergeTrafficView(
      old,
      ev({
        ts: "2026-08-28T00:00:01Z",
        overview: overview(9_000, 8_000),
        mappings: [mapping({ id: "m1", bytesIn: 9010, bytesOut: 8010, bpsIn: 9_000, bpsOut: 8_000 })],
      }),
      key,
    );
    assert.equal(next.bpsIn, 9_000);
    assert.ok(next.peakBpsIn >= 9_000);
    assert.ok(next.peakBpsOut >= 8_000);
  });

  it("uses mapping bps when the traffic query is filtered", () => {
    const rates = liveBps(
      ev({
        ts: "2026-08-28T00:00:00Z",
        overview: overview(99, 99),
        mappings: [
          mapping({ id: "m1", nodeId: "n1", bytesIn: 1, bytesOut: 1, bpsIn: 40, bpsOut: 30 }),
          mapping({ id: "m2", nodeId: "n1", bytesIn: 1, bytesOut: 1, bpsIn: 5, bpsOut: 6 }),
        ],
      }),
      "",
      "m1",
    );
    assert.equal(rates.in, 40);
    assert.equal(rates.out, 30);
  });
});
