"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/app-providers";
import { applyTheme, persistTheme, THEMES } from "@/lib/theme";
import { cn } from "@/lib/utils";
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card p-5 shadow-border">
      <div>
        <h2 className="text-base font-medium">外观</h2>
        <p className="mt-1 text-sm text-stone">适合长时间使用的浅色与深色工作区。</p>
      </div>
      <div role="group" aria-label="配色模式" className="flex gap-2">
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
              {item.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}
