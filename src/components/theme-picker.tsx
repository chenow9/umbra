"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/app-providers";
import { applyTheme, persistTheme, THEMES } from "@/lib/theme";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card p-5 shadow-border">
      <div>
        <h2 className="text-base font-medium">{t("theme.title")}</h2>
        <p className="mt-1 text-sm text-stone">{t("theme.hint")}</p>
      </div>
      <div role="group" aria-label={t("theme.group")} className="flex gap-2">
        {THEMES.map((item) => {
          const Icon = item.scheme === "light" ? Sun : Moon;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={theme === item.id}
              className={cn(
                "flex h-11 items-center gap-2 rounded-md border px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine",
                theme === item.id
                  ? "border-pine bg-paper-2 text-pine"
                  : "border-line text-ink-soft",
              )}
              onClick={() => {
                setTheme(item.id);
                applyTheme(item.id);
                persistTheme(item.id);
              }}
            >
              <Icon className="size-4" />
              {t(item.scheme === "light" ? "theme.light" : "theme.dark")}
            </button>
          );
        })}
      </div>
    </section>
  );
}
