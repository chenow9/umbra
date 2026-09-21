"use client";

import { AppShell } from "@/components/app-shell";
import { ThemePicker } from "@/components/theme-picker";
import { LanguagePicker } from "@/components/language-picker";
import { AuthPanel } from "@/components/pages/auth-panel";
import { useI18n } from "@/lib/i18n";

export function SystemPage() {
  const { t } = useI18n();
  return (
    <AppShell title={t("system.title")} description={t("system.description")}>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <p className="text-sm leading-relaxed text-ink-soft">{t("system.intro")}</p>
        <AuthPanel />
        <LanguagePicker />
        <ThemePicker />
      </div>
    </AppShell>
  );
}
