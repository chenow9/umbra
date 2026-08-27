#!/usr/bin/env node
import { chromium } from "playwright";

const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:8080";
const results = [];

function log(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 25000 });
  await page.waitForTimeout(600);
  let body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log("总览无登录墙", !body.includes("用 Google") && !body.includes("登录控制台") && body.includes("总览"));
  log("总览有演示按钮", /跑一遍演示|再跑一遍/.test(body));

  const demo = page.getByRole("button", { name: /跑一遍演示|再跑一遍/ }).first();
  await demo.click();
  await page.waitForTimeout(12000);
  body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log("演示后节点在线", body.includes("在线") && !body.includes("未连上"));
  log("演示后有流量", /今日入站\s+[1-9]/.test(body) || /\d+\s*B/.test(body));

  const routes = [
    ["/agents", "节点"],
    ["/mappings", "映射"],
    ["/traffic", "流量"],
    ["/audit", "审计"],
    ["/deploy", "部署"],
  ];
  for (const [path, title] of routes) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(400);
    const t = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    log(`打开${title}`, t.includes(title), t.slice(0, 80));
    if (path === "/mappings") {
      log("映射含暗端口", t.includes("暗") || t.includes("spa") || t.includes("回声"));
      log("映射含游戏口", t.includes("游戏口") || t.includes("UDP") || t.includes("udp"));
    }
    if (path === "/deploy") {
      log("部署含入口程序", t.includes("umbrad") || t.includes("入口"));
      log("部署含 Agent 安装", t.includes("umbra-agent") || t.includes("安装"));
    }
  }

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const theme = page.getByRole("button", { name: /配色/ }).first();
  if (await theme.count()) {
    await theme.click();
    await page.waitForTimeout(300);
    const pick = page.getByText("朱砂", { exact: true }).first();
    if (await pick.count()) {
      await pick.click();
      await page.waitForTimeout(200);
      log("切换配色", true);
    } else {
      log("切换配色", false, "没有朱砂");
    }
  } else {
    log("切换配色", false, "没有配色按钮");
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
  await mobile.waitForTimeout(500);
  const mt = (await mobile.locator("body").innerText()).replace(/\s+/g, " ");
  log("窄屏总览可看", mt.includes("总览") || mt.includes("幽门"));
  await mobile.close();

  log("控制台无脚本错误", errors.length === 0, errors.join("; "));
  await page.screenshot({ path: "/workspace/screenshots/smoke-ui.png" });
  await browser.close();
}

main()
  .catch((err) => {
    log("控制台冒烟中断", false, err.message);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
