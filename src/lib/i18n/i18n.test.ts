import test from "node:test";
import assert from "node:assert/strict";
import { detectBrowserLocale, resolveLocale } from "./locale.ts";
import { t, setActiveLocale } from "./index.ts";

test("browser Chinese tags resolve to zh, everything else to en", () => {
  assert.equal(detectBrowserLocale(["zh-CN", "en-US"]), "zh");
  assert.equal(detectBrowserLocale(["zh-TW"]), "zh");
  assert.equal(detectBrowserLocale(["en-US", "zh"]), "en");
  assert.equal(detectBrowserLocale(["fr-FR"]), "en");
  assert.equal(detectBrowserLocale([]), "en");
});

test("auto preference follows the browser, explicit preference wins", () => {
  assert.equal(resolveLocale("auto", ["en-GB"]), "en");
  assert.equal(resolveLocale("auto", ["zh-Hans-CN"]), "zh");
  assert.equal(resolveLocale("zh", ["en-US"]), "zh");
  assert.equal(resolveLocale("en", ["zh-CN"]), "en");
});

test("t interpolates and falls back, including simple plurals", () => {
  setActiveLocale("zh");
  assert.equal(t("nav.nodes"), "节点");
  assert.equal(t("nodes.services", { count: 1 }), "1 项服务");
  assert.equal(t("action.node.create"), "登记节点");
  assert.equal(t("action.auth.2fa.enrolled"), "绑定双因素");
  setActiveLocale("en");
  assert.equal(t("nav.nodes"), "Nodes");
  assert.equal(t("nodes.services", { count: 1 }), "1 service");
  assert.equal(t("nodes.services", { count: 2 }), "2 services");
  assert.equal(t("action.node.create"), "Enroll node");
  assert.equal(t("missing.key"), "missing.key");
  setActiveLocale("zh");
});
