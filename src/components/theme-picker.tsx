"use client";

import { useEffect, useRef, useState } from "react";
import { applyTheme, persistTheme, themeGroups, THEMES, type ThemeId } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function Swatch({ paper, pine }: { paper: string; pine: string }) {
  return (
    <span
      className="size-3.5 shrink-0 rounded-full"
      style={{
        background: paper,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${pine} 28%, transparent), 0 0 0 2px ${pine}`,
      }}
    />
  );
}

function ThemeGrid({ value, onPick }: { value: ThemeId; onPick: (id: ThemeId) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {themeGroups().map((group) => (
        <div key={group.id}>
          <p className="mb-1.5 px-1 text-xs text-stone">{group.label}</p>
          <div className="grid grid-cols-2 gap-1">
            {group.items.map((t) => {
              const selected = t.id === value;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  title={`${t.name} — ${t.hint}`}
                  aria-label={t.name}
                  aria-checked={selected}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(t.id);
                  }}
                  className={cn(
                    "flex h-11 items-center gap-2 rounded-md px-2 text-left",
                    selected
                      ? "bg-paper text-ink shadow-border"
                      : "text-ink-soft hover:bg-paper/70 hover:text-ink",
                  )}
                >
                  <Swatch paper={t.tokens.paper} pine={t.tokens.pine} />
                  <span className="truncate text-xs">{t.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThemeMenu({
  value,
  onChange,
}: {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = THEMES.find((t) => t.id === value) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: ThemeId) => {
    onChange(id);
    applyTheme(id);
    persistTheme(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Swatch paper={current.tokens.paper} pine={current.tokens.pine} />
        <span className="hidden sm:inline">配色 {current.name}</span>
        <span className="sm:hidden">{current.name}</span>
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="选择配色"
          className="absolute right-0 z-50 mt-2 w-64 rounded-lg bg-card p-2 shadow-border"
        >
          <ThemeGrid value={value} onPick={pick} />
          <p className="mt-2 px-1 text-xs leading-relaxed text-stone">{current.hint}</p>
        </div>
      ) : null}
    </div>
  );
}
