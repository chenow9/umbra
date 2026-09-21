import test from "node:test";
import assert from "node:assert/strict";
import { validCidrs, validHost, validNodeName } from "./validate.ts";

test("node names reject punctuation and path characters", () => {
  assert.equal(validNodeName("home-nas"), true);
  assert.equal(validNodeName("家里 NAS"), true);
  assert.equal(validNodeName("n1"), true);
  assert.equal(validNodeName("studio.local"), true);
  assert.equal(validNodeName("!!! bad/name?"), false);
  assert.equal(validNodeName(""), false);
  assert.equal(validNodeName("   "), false);
  assert.equal(validNodeName("---"), false);
});

test("target hosts accept IP and hostname, reject garbage", () => {
  assert.equal(validHost("127.0.0.1"), true);
  assert.equal(validHost("localhost"), true);
  assert.equal(validHost("nas.local"), true);
  assert.equal(validHost("::1"), true);
  assert.equal(validHost("[::1]"), true);
  assert.equal(validHost("my_nas"), true);
  assert.equal(validHost("not_a_host!!!"), false);
  assert.equal(validHost("host name"), false);
  assert.equal(validHost(""), false);
});

test("CIDR allowlists accept empty, IP, and prefixes", () => {
  assert.equal(validCidrs(""), true);
  assert.equal(validCidrs("10.0.0.0/8"), true);
  assert.equal(validCidrs("192.168.1.1"), true);
  assert.equal(validCidrs("10.0.0.0/8, 192.168.0.0/16"), true);
  assert.equal(validCidrs("2001:db8::/32"), true);
  assert.equal(validCidrs("not-a-cidr"), false);
  assert.equal(validCidrs("10.0.0.0/33"), false);
});
