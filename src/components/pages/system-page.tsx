"use client";

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { SubNav } from "@/components/sub-nav";
import { ThemePicker } from "@/components/theme-picker";
import { LanguagePicker } from "@/components/language-picker";
import { AuthPanel } from "@/components/pages/auth-panel";
import { useI18n } from "@/lib/i18n";

type SettingsTab = "auth" | "locale" | "theme";

export function SystemPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>("auth");
  return (
    <AppShell title={t("system.title")} description={t("system.description")}>
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <p className="text-sm leading-relaxed text-ink-soft">{t("system.intro")}</p>
        <SubNav
          label={t("system.sections")}
          items={[
            {
              key: "auth",
              label: t("system.sectionAuth"),
              current: tab === "auth",
              onSelect: () => setTab("auth"),
            },
            {
              key: "locale",
              label: t("system.sectionLocale"),
              current: tab === "locale",
              onSelect: () => setTab("locale"),
            },
            {
              key: "theme",
              label: t("system.sectionTheme"),
              current: tab === "theme",
              onSelect: () => setTab("theme"),
            },
          ]}
        />
        {tab === "auth" ? <AuthPanel /> : null}
        {tab === "locale" ? <LanguagePicker /> : null}
        {tab === "theme" ? <ThemePicker /> : null}
      </div>
    </AppShell>
  );
}
