import { t, type Locale } from "../i18n/index.ts";

export type AuthFactor = "password" | "totp" | "recovery" | "enrollment";

const messages: Record<string, string> = {
  认证凭证不正确: "invalid",
  先设置口令: "notSetup",
  尚未设置管理员口令: "notSetup",
  口令已经设过: "alreadySetup",
  "口令至少 8 位": "shortPassword",
  "totp 与 recoveryCode 不能同时提交": "bothFactors",
  已经完成绑定: "alreadyBound",
  需要先验证口令: "pending",
  "绑定会话已过期，请重新验证口令": "expired",
  需要登录: "pending",
  "关闭 2FA 时不能远程改绑定，请使用本机 umbrad -reset-2fa 或先开启 2FA": "forbidden",
};

// Keep backend details out of authentication UI; unknown failures get a localized fallback.
export function authErrorMessage(
  error: unknown,
  factor: AuthFactor = "password",
  locale?: Locale,
): string {
  const err = error as { message?: string; status?: number } | null;
  let key = messages[err?.message ?? ""];
  if (err?.status === 429) key = "rateLimit";
  else if (err?.status && err.status >= 500) key = "unavailable";
  else if (error instanceof TypeError) key = "network";
  if (key === "invalid" && factor === "enrollment") key = "invalidEnrollment";
  if (key === "invalid" && factor === "totp") key = "invalidTotp";
  if (key === "invalid" && factor === "recovery") key = "invalidRecovery";
  return t(`login.errors.${key ?? "generic"}`, undefined, locale);
}

export function enrollmentNeedsLogin(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message;
  return message === "需要先验证口令" || message === "绑定会话已过期，请重新验证口令";
}
