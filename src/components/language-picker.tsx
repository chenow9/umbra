"use client";

import { useI18n } from "@/lib/i18n";
import type { LocalePreference } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPTIONS: { id: LocalePreference; labelKey: string }[] = [
  { id: "auto", labelKey: "locale.auto" },
  { id: "zh", labelKey: "locale.zh" },
  { id: "en", labelKey: "locale.en" },
];

export function LanguagePicker() {
  const { preference, setPreference, t } = useI18n();
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card p-5 shadow-border">
      <div>
        <h2 className="text-base font-medium">{t("locale.title")}</h2>
        <p className="mt-1 text-sm text-stone">{t("locale.hint")}</p>
      </div>
      <div role="group" aria-label={t("locale.group")} className="flex flex-wrap gap-2">
        {OPTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={preference === item.id}
            className={cn(
              "flex h-11 items-center gap-2 rounded-md border px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine",
              preference === item.id
                ? "border-pine bg-paper-2 text-pine"
                : "border-line text-ink-soft",
            )}
            onClick={() => setPreference(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>
    </section>
  );
}
