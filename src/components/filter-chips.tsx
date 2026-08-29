"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { filterNodeOptions } from "@/lib/umbra/page";
import type { NodeStatus } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";
import { NameDotHint } from "@/components/mode-name";
import { Input } from "@/components/ui/input";

export type FilterChip = {
  value: string;
  label: string;
  hint?: string;
  count?: number;
};

export function FilterChips({
  label,
  value,
  onChange,
  options,
  always = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterChip[];
  always?: boolean;
}) {
  if (!always && options.length < 2) return null;

  const segmented = options.length <= 4 && options.every((o) => !o.hint);

  function toggle(next: string) {
    onChange(value === next ? "all" : next);
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex",
        segmented ? "rounded-md bg-paper-2 p-0.5 shadow-border" : "flex-wrap gap-1",
      )}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => toggle(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 font-medium transition-colors duration-150",
              segmented
                ? "h-9 rounded-sm px-2.5 text-sm"
                : "h-8 rounded-md px-2.5 text-xs shadow-border",
              selected
                ? "bg-paper text-ink"
                : segmented
                  ? "text-stone hover:text-ink"
                  : "bg-paper-2 text-stone hover:text-ink",
            )}
          >
            {opt.hint ? (
              <NameDotHint name={opt.label} hint={opt.hint} />
            ) : (
              <span className="truncate">{opt.label}</span>
            )}
            {opt.count != null ? (
              <span className="font-mono text-[11px] tabular-nums opacity-70">{opt.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export type NodeOption = {
  value: string;
  label: string;
  count?: number;
  status?: NodeStatus;
};

function nodeTone(status?: NodeStatus) {
  if (status === "online") return "bg-live";
  if (status === "revoked") return "bg-rose";
  return "bg-stone";
}

function nodeText(status?: NodeStatus) {
  if (status === "online") return "text-live";
  if (status === "revoked") return "text-rose";
  return "text-stone";
}

function nodeStatusLabel(status?: NodeStatus) {
  if (status === "online") return "在线";
  if (status === "revoked") return "已吊销";
  if (status === "offline") return "离线";
  return "";
}

function NodeMark({ status, className }: { status?: NodeStatus; className?: string }) {
  return <span className={cn("size-2.5 shrink-0 rounded-full", nodeTone(status), className)} />;
}

function groupNodes(nodes: NodeOption[]) {
  const online = nodes.filter((n) => n.status === "online");
  const offline = nodes.filter((n) => n.status === "offline");
  const revoked = nodes.filter((n) => n.status === "revoked");
  const rest = nodes.filter((n) => !n.status);
  const groups = [
    { label: "在线", items: online },
    { label: "离线", items: offline },
    { label: "已吊销", items: revoked },
    { label: "", items: rest },
  ].filter((g) => g.items.length > 0);
  return groups;
}

export function NodeSwitcher({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: NodeOption[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const current =
    value === "all" ? undefined : options.find((n) => n.value === value) ?? options[0];
  const total = options.reduce((n, o) => n + (o.count ?? 0), 0);
  const searchable = options.length > 6;
  const filtered = useMemo(() => filterNodeOptions(options, q), [options, q]);
  const groups = groupNodes(filtered);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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

  useEffect(() => {
    if (open) setQ("");
  }, [open]);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  if (options.length === 0) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label="切换节点"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-left shadow-border"
      >
        {current ? <NodeMark status={current.status} /> : null}
        <span className={cn("truncate font-medium", current ? nodeText(current.status) : "text-ink")}>
          {current?.label ?? "全部节点"}
        </span>
        <span className="shrink-0 text-xs text-stone">
          {current
            ? `${nodeStatusLabel(current.status)}${current.count != null ? ` · ${current.count} 条` : ""}`
            : `${total} 条`}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-stone transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="节点"
          className="absolute left-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-card p-2 shadow-border"
        >
          {searchable ? (
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索节点"
              aria-label="搜索节点"
              className="mb-2 h-9"
            />
          ) : null}
          <div className="max-h-72 overflow-y-auto">
            {options.length > 1 ? (
              <button
                type="button"
                role="option"
                aria-selected={value === "all"}
                onClick={() => pick("all")}
                className={cn(
                  "flex h-9 w-full items-center justify-between rounded-md px-2.5 text-sm",
                  value === "all" ? "bg-paper-2 text-ink" : "text-ink-soft hover:bg-paper-2 hover:text-ink",
                )}
              >
                <span>全部节点</span>
                <span className="font-mono text-xs tabular-nums text-stone">{total}</span>
              </button>
            ) : null}
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-stone">没有匹配的节点。</p>
            ) : (
              groups.map((group) => (
                <div key={group.label || "nodes"} className="mt-1">
                  {group.label && groups.length > 1 ? (
                    <p className="px-2.5 py-1 text-[11px] text-stone">{group.label}</p>
                  ) : null}
                  {group.items.map((opt) => {
                    const selected = value === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => pick(opt.value)}
                        className={cn(
                          "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm",
                          selected ? "bg-paper-2" : "hover:bg-paper-2",
                        )}
                      >
                        <NodeMark status={opt.status} />
                        <span className={cn("min-w-0 flex-1 truncate", nodeText(opt.status))}>
                          {opt.label}
                        </span>
                        {opt.count != null ? (
                          <span className="font-mono text-xs tabular-nums text-stone">{opt.count}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
