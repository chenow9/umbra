#!/usr/bin/env node
// Real, isolated authentication flows against a freshly built embedded console.
// Run npm run build:embed-ui first. --keep leaves a two-factor preview running.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const dir = mkdtempSync(join(tmpdir(), "umbra-auth-qa-"));
const output = resolve("artifacts/auth-review");
mkdirSync(output, { recursive: true });
const keep = process.argv.includes("--keep");
const password = "umbra-preview-2026";
const children = [];
let browser;
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function startGate(twoFactor) {
  const port = await freePort();
  const tunnel = await freePort();
  const child = spawn(
    join(dir, "umbrad"),
    [
      "-http",
      `127.0.0.1:${port}`,
      "-listen",
      `127.0.0.1:${tunnel}`,
      "-advertise",
      `127.0.0.1:${tunnel}`,
      "-bind",
      "127.0.0.1",
      "-tls-dir",
      join(dir, twoFactor ? "mfa" : "password"),
      "-stealth",
      "off",
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        UMBRA_LOGIN: "on",
        UMBRA_2FA: twoFactor ? "on" : "off",
        UMBRA_UI_UPSTREAM: "",
        GROK_AGENT: "",
        GROK_PROJECT_ID: "",
      },
    },
  );
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, child };
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw new Error("Gateway startup timed out");
}
function totp(secret, ahead = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((s) => parseInt(s, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + ahead));
  const hash = createHmac("sha1", bytes).update(counter).digest();
  return ((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}
async function selectLanguage(page, locale) {
  await page.getByRole("combobox").click();
  assert.equal(await page.getByRole("option").count(), 2);
  await page
    .getByRole("option", { name: locale === "zh" ? "中文" : "English", exact: true })
    .click();
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${name}: horizontal overflow`,
  );
}
async function cleanup() {
  if (browser) await browser.close();
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", () => void cleanup().then(() => process.exit()));
process.once("SIGTERM", () => void cleanup().then(() => process.exit()));
try {
  const build = spawnSync("go", ["build", "-o", join(dir, "umbrad"), "./cmd/umbrad"], {
    stdio: "inherit",
  });
  assert.equal(build.status, 0);
  const mfa = await startGate(true);
  browser = await chromium.launch();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1360, height: 920 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${mfa.url}/login`);
  await page.getByRole("heading", { name: "设置你的控制台", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("umbra-locale")), null);
  assert.equal(await page.getByRole("combobox").innerText(), "中文");
  await screenshot(page, "01-setup-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "01-setup-zh-mobile");
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.getByLabel("管理员密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill("does-not-match");
  await page.getByRole("button", { name: "设置密码并继续", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "两次输入" }).waitFor();
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  const enrollmentResponse = page.waitForResponse(
    (r) => r.url().endsWith("/v1/2fa/enrollment") && r.ok(),
  );
  await page.getByRole("button", { name: "设置密码并继续", exact: true }).click();
  let enrollment = await (await enrollmentResponse).json();
  await page.getByRole("heading", { name: "绑定验证器", exact: true }).waitFor();
  await screenshot(page, "02-enroll-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "02-enroll-zh-mobile");
  await page.setViewportSize({ width: 1360, height: 920 });
  // Losing the pre-auth cookie simulates an expired enrollment session, using the real API.
  await context.clearCookies();
  await page.getByLabel("六位验证码", { exact: true }).fill(totp(enrollment.secret));
  await page.getByRole("button", { name: "验证并继续", exact: true }).click();
  await page.getByRole("button", { name: "返回登录", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill(password);
  const reenrollResponse = page.waitForResponse(
    (r) => r.url().endsWith("/v1/2fa/enrollment") && r.ok(),
  );
  await page.getByRole("button", { name: "登录控制台", exact: true }).click();
  enrollment = await (await reenrollResponse).json();
  await page.getByLabel("六位验证码", { exact: true }).fill(totp(enrollment.secret));
  const confirmed = page.waitForResponse(
    (r) => r.url().endsWith("/v1/2fa/enrollment/confirm") && r.ok(),
  );
  await page.getByRole("button", { name: "验证并继续", exact: true }).click();
  const codes = (await (await confirmed).json()).recoveryCodes;
  await page.getByRole("heading", { name: "保存恢复码", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "进入控制台", exact: true }).isEnabled(),
    false,
  );
  await screenshot(page, "03-recovery-zh");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "03-recovery-zh-mobile");
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "进入控制台", exact: true }).click();
  await page.waitForURL("**/nodes");
  await context.clearCookies();
  await page.goto(`${mfa.url}/login`);
  await page.getByRole("heading", { name: "登录控制台", exact: true }).waitFor();
  await screenshot(page, "04-login-zh");
  await selectLanguage(page, "en");
  await page.getByRole("heading", { name: "Sign in to your console", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Sign in to your console", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByLabel("Authenticator code", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "phone and server clocks" }).waitFor();
  assert.doesNotMatch(await page.getByRole("alert").innerText(), /[\u4e00-\u9fff]/);
  await screenshot(page, "05-error-en");
  await page.getByRole("button", { name: "Sign in with a recovery code", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/nodes");
  await context.clearCookies();
  await page.goto(`${mfa.url}/login`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp(enrollment.secret, 1));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/nodes");
  console.log(
    "PASS: setup, password mismatch, enrollment, lost pre-auth session, recovery acknowledgement, recovery login, TOTP login and localized errors",
  );

  const preview = await startGate(false);
  await page.goto(`${preview.url}/login`);
  await selectLanguage(page, "en");
  await page.getByRole("heading", { name: "Set up your console", exact: true }).waitFor();
  await page
    .getByText("This gateway currently uses password-only sign-in.", { exact: false })
    .waitFor();
  assert.equal(await page.locator(".auth-steps").count(), 0);
  await page.getByLabel("Administrator password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password and enter", exact: true }).click();
  await page.waitForURL("**/nodes");
  await context.clearCookies();
  await page.goto(`${preview.url}/login`);
  await page.getByRole("heading", { name: "Sign in to your console", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Authenticator code", { exact: true }).count(), 0);
  await screenshot(page, "06-login-en");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await screenshot(page, "07-login-dark");
  await page.reload();
  await page.getByRole("heading", { name: "Sign in to your console", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "moye");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await selectLanguage(page, "zh");
  await screenshot(page, "08-login-mobile");
  await page.setViewportSize({ width: 1360, height: 920 });
  await screenshot(page, "09-login-preview");
  // Status retrieval failures should offer retry instead of a misleading login form.
  await page.route("**/v1/auth", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"unavailable"}',
    }),
  );
  await page.reload();
  await page.getByRole("heading", { name: "暂时无法连接控制台", exact: true }).waitFor();
  await page.unroute("**/v1/auth");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("heading", { name: "登录控制台", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: password-only setup, locale/theme persistence, mobile layout, connection failure and retry; no browser errors",
  );
  await context.clearCookies();
  await page.goto(`${mfa.url}/login`);
  await selectLanguage(page, "zh");
  await page.getByLabel("动态验证码", { exact: true }).waitFor();
  await screenshot(page, "09-login-preview");
  await page.getByRole("combobox").click();
  assert.equal(await page.getByRole("option").count(), 2);
  await screenshot(page, "10-language-menu");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "11-twofactor-mobile");
  const english = await browser.newContext({ locale: "en-US" });
  const englishPage = await english.newPage();
  await englishPage.goto(`${mfa.url}/login`);
  await englishPage
    .getByRole("heading", { name: "Sign in to your console", exact: true })
    .waitFor();
  assert.equal(await englishPage.getByRole("combobox").innerText(), "English");
  assert.equal(await englishPage.evaluate(() => localStorage.getItem("umbra-locale")), null);
  await english.close();
  console.log(
    "PASS: styled language menu has two options; fresh Chinese/English browsers follow their locale without storing an override; 2FA preview shows code and recovery inputs",
  );
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify({ preview: mfa.url, output, checks: "passed" }, null, 2),
  );
  console.log(`Screenshots: ${output}`);
  await browser.close();
  browser = null;
  preview.child.kill("SIGTERM");
  if (keep) {
    console.log(
      `Preview: ${mfa.url}/login\nPreview password: ${password}\nPreview unused recovery code: ${codes[1]}\nTemporary state: ${dir}`,
    );
    await new Promise(() => {});
  }
} finally {
  await cleanup();
}
