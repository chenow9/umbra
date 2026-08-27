"use client";

import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { listAudit } from "@/lib/umbra/api";
import { formatRelative } from "@/lib/umbra/format";
import { actionLabel } from "@/lib/umbra/labels";

export function AuditPage() {
  const audit = useQuery({ queryKey: ["umbra", "audit"], queryFn: () => listAudit() });
  const rows = audit.data ?? [];

  return (
    <AppShell title="审计">
      <p className="mb-4 max-w-xl text-sm leading-relaxed text-stone">
        登记、下发、敲门、开流都记在这里。不存原始流量。
      </p>
      <ol className="divide-y divide-line overflow-hidden rounded-xl bg-card shadow-border">
        {rows.length === 0 ? (
          <li className="px-4 py-6 text-sm text-stone">还没有审计记录。</li>
        ) : (
          rows.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-ink">{actionLabel[item.action] ?? item.action}</p>
                {item.detail ? <p className="mt-0.5 truncate font-mono text-xs text-stone">{item.detail}</p> : null}
              </div>
              <span className="shrink-0 font-mono text-xs text-stone">{formatRelative(item.ts)}</span>
            </li>
          ))
        )}
      </ol>
    </AppShell>
  );
}
