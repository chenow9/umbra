#!/usr/bin/env node
// Use a disposable, authenticated or explicitly auth-free local QA instance.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const base = process.env.SMOKE_URL ?? "http://127.0.0.1:8080";
const output = mkdtempSync(join(tmpdir(), "umbra-ui-smoke-"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "服务", exact: true, level: 1 }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/mappings");
  assert.equal(new URL(page.url()).searchParams.has("node"), false);
  for (const [path, title] of [
    ["/nodes", "节点"],
    ["/mappings", "服务"],
    ["/traffic", "观测"],
    ["/audit", "观测"],
    ["/deploy", "系统"],
  ]) {
    await page.goto(base + path, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: title, exact: true, level: 1 }).waitFor();
  }
  await page.getByRole("button", { name: "深色", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "moye");
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await page.goto(base + "/mappings", { waitUntil: "domcontentloaded" });
  const nodes = await page.request.get(base + "/v1/nodes").then((r) => r.json());
  if (nodes.some((node) => node.status !== "revoked")) {
    await page.getByRole("button", { name: "添加服务", exact: true }).click();
    await page.getByRole("heading", { name: "添加服务", exact: true }).waitFor();
    assert.equal(await page.getByLabel("目标端口", { exact: true }).inputValue(), "");
    await page.getByLabel("服务名称", { exact: true }).fill("QA 草稿");
    await page.getByLabel("目标端口", { exact: true }).fill("22");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    assert.equal(await page.getByRole("radio", { name: /凭证访问/ }).isChecked(), true);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "确认接入并连接", exact: true }).isEnabled(),
      true,
    );
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    assert.equal(await page.getByLabel("服务名称", { exact: true }).inputValue(), "QA 草稿");
    // Keep this UI smoke read-only: submitting may expose a real target.
    await page.getByRole("button", { name: "取消", exact: true }).click();
  }
  const endpoints = page.locator(".endpoint-select");
  if ((await endpoints.count()) > 1) {
    await endpoints.nth(0).click();
    const initialTitle = await page
      .getByRole("dialog")
      .getByRole("heading", { level: 2 })
      .innerText();
    await endpoints.nth(1).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.locator("[data-workspace-inspector='true']").count(), 1);
    await page.getByRole("button", { name: "紧凑布局", exact: true }).click();
    assert.equal(await page.getByRole("dialog").isVisible(), true);
    assert.ok(initialTitle.length > 0);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "网络布局", exact: true }).click();
  }
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "mobile horizontal overflow",
  );
  await page.getByRole("navigation", { name: "主导航", exact: true }).waitFor();
  await page.getByRole("button", { name: "快速查找服务和操作", exact: true }).click();
  await page.getByRole("combobox", { name: "查找服务与操作", exact: true }).fill("查看网络观测");
  await page.getByRole("combobox", { name: "查找服务与操作", exact: true }).press("Enter");
  await page.getByRole("heading", { name: "观测", exact: true, level: 1 }).waitFor();
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: service home, routes, appearance, private create defaults and mobile navigation. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
