"use client";

import { AppShell } from "@/components/app-shell";
import { ThemePicker } from "@/components/theme-picker";
import { AuthPanel } from "@/components/pages/auth-panel";

export function SystemPage() {
  return (
    <AppShell title="系统" description="管理员安全与界面外观。">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">系统设置</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            管理控制台的安全设置与外观偏好。
          </p>
        </div>
        <AuthPanel />
        <ThemePicker />
      </div>
    </AppShell>
  );
}
