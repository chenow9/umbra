"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowRight, Layers, Radio } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { getOverview, listMappings } from "@/lib/umbra/api";
import { formatRelative } from "@/lib/umbra/format";
import { actionLabel, auditActorLabel, auditTargetLabel } from "@/lib/umbra/labels";
import { serviceSummary } from "@/lib/umbra/service";

export function OverviewPage() {
  const { t } = useI18n();
  const overview = useQuery({ queryKey: ["umbra", "overview"], queryFn: getOverview });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const o = overview.data;
  const summary = serviceSummary(mappings.data ?? []);
  const labels = actionLabel();
  const recent = (o?.recentAudit ?? []).slice(0, 3);
  const attention = summary.attention;
  const loading = overview.isPending || mappings.isPending;

  let cta: { to: "/nodes" | "/mappings"; label: string } | null = null;
  if (o && o.nodesTotal === 0) cta = { to: "/nodes", label: t("nodes.enroll") };
  else if (o && o.mappingsTotal === 0) cta = { to: "/mappings", label: t("services.add") };
  else if (attention > 0) cta = { to: "/mappings", label: t("overview.reviewAttention") };

  return (
    <AppShell title={t("overview.title")} description={t("overview.description")}>
      {loading ? (
        <p role="status" className="py-10 text-sm text-stone">
          {t("overview.loading")}
        </p>
      ) : overview.isError ? (
        <div role="alert" className="rounded-xl border border-rose/25 p-4 text-sm">
          <p>{t("overview.loadError")}</p>
          <Button variant="outline" className="mt-3" onClick={() => void overview.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="grid gap-3 sm:grid-cols-3" aria-label={t("overview.summary")}>
            <Glance
              href="/nodes"
              label={t("overview.nodes")}
              value={t("overview.nodesValue", {
                online: o?.nodesOnline ?? 0,
                total: o?.nodesTotal ?? 0,
              })}
            />
            <Glance
              href="/mappings"
              label={t("overview.services")}
              value={String(o?.mappingsTotal ?? 0)}
            />
            <Glance
              href="/mappings"
              label={t("overview.attention")}
              value={String(attention)}
              warn={attention > 0}
            />
          </section>
          {cta ? (
            <EmptyState
              icon={o?.nodesTotal === 0 ? Radio : attention > 0 ? Activity : Layers}
              title={
                o?.nodesTotal === 0
                  ? t("nodes.emptyReason")
                  : o?.mappingsTotal === 0
                    ? t("services.emptyFirst")
                    : t("overview.attentionHint", { n: attention })
              }
              action={
                <Button asChild>
                  <Link to={cta.to}>
                    {cta.label} <ArrowRight className="size-4" />
                  </Link>
                </Button>
              }
            />
          ) : null}
          <section className="rounded-xl bg-card p-5 shadow-border">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{t("overview.recent")}</h2>
              <Link to="/audit" className="text-xs text-pine">
                {t("overview.allAudit")} →
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="text-sm text-stone">{t("audit.empty")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-sm"
                  >
                    <span>
                      <span className="font-medium">{labels[item.action] ?? item.action}</span>
                      <span className="text-ink-soft"> · {auditTargetLabel(item)}</span>
                    </span>
                    <span className="font-mono text-xs text-stone">
                      {formatRelative(item.ts)} · {auditActorLabel(item.actor)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function Glance({
  href,
  label,
  value,
  warn,
}: {
  href: "/nodes" | "/mappings";
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <Link to={href} className="rounded-xl bg-card px-4 py-3 shadow-border hover:bg-paper-2">
      <p className="text-xs text-stone">{label}</p>
      <p className={`mt-1 font-mono text-lg tabular-nums ${warn ? "text-rose" : ""}`}>{value}</p>
    </Link>
  );
}
