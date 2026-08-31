import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downsampleChart, paddedMax, stepYMax, type ChartPt } from "./chart-smooth.ts";

const pts: ChartPt[] = [
  { t: 1000, inn: 10, out: 4 },
  { t: 2000, inn: 20, out: 8 },
];

describe("paddedMax", () => {
  it("adds headroom and floors empty data at 1", () => {
    assert.equal(paddedMax(pts), 20 * 1.08);
    assert.equal(paddedMax([]), 1);
  });
});

describe("stepYMax", () => {
  it("jumps up with a new peak and eases down", () => {
    assert.equal(stepYMax(10, 40), 40);
    assert.equal(stepYMax(40, 10), 40 + (10 - 40) * 0.22);
    assert.ok(stepYMax(40, 10) > 10);
  });
});

describe("downsampleChart", () => {
  it("leaves short series alone", () => {
    assert.equal(downsampleChart(pts, 160), pts);
  });

  it("keeps ends and a lone spike", () => {
    const long: ChartPt[] = [];
    for (let i = 0; i < 500; i++) {
      long.push({ t: i * 1000, inn: i === 200 ? 9000 : 10, out: 5 });
    }
    const out = downsampleChart(long, 80);
    assert.ok(out.length <= 80);
    assert.equal(out[0].t, long[0].t);
    assert.equal(out[out.length - 1].t, long[long.length - 1].t);
    assert.ok(out.some((p) => p.inn === 9000));
  });
});
