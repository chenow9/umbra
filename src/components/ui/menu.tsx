"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  hidden?: boolean;
};

export function ActionMenu({ label = "更多操作", items }: { label?: string; items: MenuItem[] }) {
  const visible = items.filter((i) => !i.hidden);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReposition = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  if (visible.length === 0) return null;

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-[80] min-w-40 rounded-lg bg-card p-1 shadow-border"
        >
          {visible.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex h-9 w-full items-center rounded-md px-2.5 text-left text-sm",
                item.tone === "danger" ? "text-rose hover:bg-paper-2" : "text-ink hover:bg-paper-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="relative inline-flex" ref={wrapRef}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          const r = wrapRef.current?.getBoundingClientRect();
          if (!r) return;
          const width = 160;
          const height = visible.length * 36 + 8;
          const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
          const below = r.bottom + 4;
          const top = below + height > window.innerHeight - 8 ? r.top - height - 4 : below;
          setPos({ top, left });
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal className="size-4" />
      </Button>
      {menu}
    </div>
  );
}

export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-1.5 text-xs text-stone">{children}</p>;
}
