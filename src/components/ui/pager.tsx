"use client";

import { Button } from "@/components/ui/button";

export function Pager({
  page,
  size,
  total,
  onPage,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone">
      <span>
        {total === 0 ? "共 0 条" : `第 ${from}–${to} 条 · 共 ${total} 条`}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}
