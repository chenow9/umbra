"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { SelectField } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Pager } from "@/components/ui/pager";
import { queryAudit } from "@/lib/umbra/api";
import { formatClock, formatRelative } from "@/lib/umbra/format";
import { actionLabel } from "@/lib/umbra/labels";
import { emptyPage, PAGE_SIZE } from "@/lib/umbra/page";
import type { AuditItem } from "@/lib/umbra/types";

const actionOptions = [
  { value: "all", label: "全部操作" },
  ...Object.entries(actionLabel).map(([value, label]) => ({ value, label })),
];

export function AuditPage() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(1);
  const query = {
    q: q.trim() || undefined,
    action: action === "all" ? undefined : action,
    page,
    size: PAGE_SIZE,
  };
  const audit = useQuery({
    queryKey: ["umbra", "audit", "page", query],
    queryFn: () => queryAudit(query),
    placeholderData: keepPreviousData,
  });
  const pageData = audit.data ?? emptyPage<AuditItem>(page);
  const list = pageData.items;
  const empty = !audit.isLoading && pageData.total === 0 && !q && action === "all";

  useEffect(() => {
    setPage(1);
  }, [q, action]);
  useEffect(() => {
    if (!audit.data) return;
    const pages = Math.max(1, Math.ceil(audit.data.total / audit.data.size) || 1);
    if (page > pages) setPage(pages);
  }, [audit.data, page]);

  return (
    <AppShell title="审计" description="登记、下发、敲门、开流都记在这里。不存原始流量。">
      {empty ? (
        <p className="rounded-xl bg-card px-4 py-10 text-center text-sm text-stone shadow-border">
          还没有审计记录。
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索操作、对象、详情"
              aria-label="搜索审计记录"
              className="max-w-sm"
            />
            <SelectField
              label="操作"
              className="w-44"
              value={action}
              onValueChange={setAction}
              options={actionOptions}
            />
          </div>
          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-10 text-center text-sm text-stone shadow-border">
              没有匹配的记录。
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2 md:hidden">
                {list.map((item) => (
                  <article key={item.id} className="rounded-xl bg-card px-4 py-3 shadow-border">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium text-ink">
                        {actionLabel[item.action] ?? item.action}
                      </p>
                      <span className="shrink-0 font-mono text-xs text-stone">
                        {formatRelative(item.ts)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink-soft">
                      {item.targetName || item.target || "—"}
                    </p>
                    {item.detail ? (
                      <p className="mt-1 font-mono text-xs text-stone">{item.detail}</p>
                    ) : null}
                    <p className="mt-1 font-mono text-xs text-stone">
                      {formatClock(item.ts)} · {item.actor || "owner"}
                    </p>
                  </article>
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-stone">
                      <th className="px-4 py-3 font-medium">时间</th>
                      <th className="px-4 py-3 font-medium">操作</th>
                      <th className="px-4 py-3 font-medium">对象</th>
                      <th className="px-4 py-3 font-medium">详情</th>
                      <th className="px-4 py-3 font-medium">操作者</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((item) => (
                      <tr
                        key={item.id}
                        className="border-b border-line/70 last:border-0 hover:bg-paper-2/50"
                      >
                        <td className="px-4 py-3 align-top">
                          <div className="font-mono text-xs tabular-nums text-ink">
                            {formatClock(item.ts)}
                          </div>
                          <div className="text-xs text-stone">{formatRelative(item.ts)}</div>
                        </td>
                        <td className="px-4 py-3 align-top font-medium">
                          {actionLabel[item.action] ?? item.action}
                        </td>
                        <td className="px-4 py-3 align-top text-ink-soft">
                          {item.targetName || item.target || "—"}
                        </td>
                        <td className="px-4 py-3 align-top font-mono text-xs text-stone">
                          {item.detail || "—"}
                        </td>
                        <td className="px-4 py-3 align-top text-xs text-stone">
                          {item.actor || "owner"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={pageData.page}
                size={pageData.size}
                total={pageData.total}
                onPage={setPage}
              />
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
