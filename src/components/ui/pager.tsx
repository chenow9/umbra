"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone">
      <span>
        {total === 0 ? t("pager.empty") : t("pager.range", { from, to, total })}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("common.previous")}
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}
