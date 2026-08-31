import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nodeEnrollBinCmd,
  nodeEnrollDockerCmd,
  shSingleQuote,
} from "./units.ts";

const pem = `-----BEGIN CERTIFICATE-----
MIIBtest
-----END CERTIFICATE-----`;

describe("shSingleQuote", () => {
  it("wraps and escapes single quotes", () => {
    assert.equal(shSingleQuote("abc"), "'abc'");
    assert.equal(shSingleQuote("a'b"), `'a'"'"'b'`);
  });
});

describe("nodeEnrollDockerCmd", () => {
  it("embeds CA so the node host does not need a separate upload", () => {
    const cmd = nodeEnrollDockerCmd("umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /docker run/);
    assert.match(cmd, /chenow9\/umbra-node:latest/);
    assert.match(cmd, /--network host/);
    assert.match(cmd, /\$HOME\/\.umbra\/ca\.crt/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /umbra_boot_abc/);
    assert.match(cmd, /114\.55\.129\.94:4400/);
    assert.match(cmd, /不必再下载或 scp/);
    assert.equal(cmd.includes("/Users/"), false);
  });

  it("asks for ./ca.crt when PEM is missing", () => {
    const cmd = nodeEnrollDockerCmd("umbra_boot_abc", "gate.example.com:4400");
    assert.match(cmd, /\$PWD\/ca\.crt/);
    assert.equal(cmd.includes("BEGIN CERTIFICATE"), false);
  });
});

describe("nodeEnrollBinCmd", () => {
  it("writes CA then starts umbra-node", () => {
    const cmd = nodeEnrollBinCmd("umbra_boot_abc", "114.55.129.94:4400", pem);
    assert.match(cmd, /mkdir -p \/etc\/umbra/);
    assert.match(cmd, /BEGIN CERTIFICATE/);
    assert.match(cmd, /umbra-node --server '114\.55\.129\.94:4400'/);
  });
});
