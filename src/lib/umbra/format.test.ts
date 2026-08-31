import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatRateDisplay,
  formatRateHint,
  kbpsToUnit,
  pickRateUnit,
  unitToKbps,
} from "./format.ts";

describe("rate unit conversion", () => {
  it("treats 1024 KB/s as 1 MB/s", () => {
    assert.equal(kbpsToUnit(1024, "KBps"), 1024);
    assert.equal(kbpsToUnit(1024, "MBps"), 1);
    assert.equal(unitToKbps(1, "MBps"), 1024);
    assert.equal(formatRateDisplay(1024, "MBps"), "1");
  });

  it("converts Mbps using 1024-byte kilobytes", () => {
    const kbps = unitToKbps(10, "Mbps");
    assert.equal(kbps, Math.round((10 * 1_000_000) / 8 / 1024));
    assert.ok(Math.abs(kbpsToUnit(kbps, "Mbps") - 10) < 0.01);
  });

  it("maps 0 to unlimited and picks MB/s for large stored values", () => {
    assert.equal(unitToKbps(0, "Mbps"), 0);
    assert.equal(formatRateHint(0), "0 不限制");
    assert.equal(pickRateUnit(0), "KBps");
    assert.equal(pickRateUnit(2048), "MBps");
    assert.match(formatRateHint(1024), /1024 KB\/s/);
    assert.match(formatRateHint(1024), /1 MB\/s/);
  });
});
