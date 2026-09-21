"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact
          ? "gap-2 px-3 py-6"
          : "gap-4 rounded-xl border border-dashed border-line px-5 py-12",
      )}
    >
      <Icon className={cn("text-stone", compact ? "size-6" : "size-8")} aria-hidden />
      <p className="max-w-md text-sm leading-relaxed text-ink-soft">{title}</p>
      {action ? (
        <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
