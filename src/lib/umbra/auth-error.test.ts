import test from "node:test";
import assert from "node:assert/strict";
import { authErrorMessage, enrollmentNeedsLogin } from "./auth-error.ts";

test("auth errors are localized without leaking server text", () => {
  assert.match(
    authErrorMessage(new Error("认证凭证不正确"), "password", "en"),
    /credentials are incorrect/,
  );
  assert.doesNotMatch(
    authErrorMessage(new Error("认证凭证不正确"), "enrollment", "en"),
    /password|credentials/,
  );
  assert.doesNotMatch(
    authErrorMessage(new Error("认证凭证不正确"), "password", "en"),
    /clock|[\u4e00-\u9fff]/,
  );
  assert.match(authErrorMessage(new Error("认证凭证不正确"), "totp", "zh"), /时间/);
  assert.match(authErrorMessage(new Error("认证凭证不正确"), "recovery", "en"), /not been used/);
  assert.doesNotMatch(authErrorMessage(new Error("认证凭证不正确"), "recovery", "en"), /clock/);
  assert.doesNotMatch(
    authErrorMessage(new Error("internal detail /private/path"), "password", "en"),
    /private\/path/,
  );
});

test("network, rate limit and server failures have distinct guidance", () => {
  assert.match(
    authErrorMessage({ status: 429, message: "试得太勤，过一会儿再来" }, "password", "en"),
    /Too many/,
  );
  assert.match(
    authErrorMessage({ status: 500, message: "状态未能落盘" }, "password", "zh"),
    /稍后重试/,
  );
  assert.match(authErrorMessage(new TypeError("Failed to fetch"), "password", "en"), /network/);
});

test("expired enrollment offers a way back to password verification", () => {
  assert.equal(enrollmentNeedsLogin(new Error("绑定会话已过期，请重新验证口令")), true);
  assert.equal(enrollmentNeedsLogin(new Error("需要先验证口令")), true);
  assert.equal(enrollmentNeedsLogin(new Error("认证凭证不正确")), false);
  assert.match(
    authErrorMessage(new Error("绑定会话已过期，请重新验证口令"), "totp", "en"),
    /Sign in again/,
  );
});
