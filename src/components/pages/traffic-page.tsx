"use client";

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ObservabilityNav } from "@/components/observability-nav";
import { AppShell } from "@/components/app-shell";
import { ObservationScope } from "@/components/observation-scope";
import { RateChart } from "@/components/rate-chart";
import { Pager } from "@/components/ui/pager";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { statusText, useI18n } from "@/lib/i18n";
import { getTraffic, listNodes, listMappings } from "@/lib/umbra/api";
import { formatBps, formatBytes } from "@/lib/umbra/format";
import { peakBpsFromSeries } from "@/lib/umbra/live";
import { PAGE_SIZE, pageOf } from "@/lib/umbra/page";
import { resolveTrafficScope, type TrafficSearch } from "@/lib/umbra/traffic-scope";
import { cn } from "@/lib/utils";

export function TrafficPage() {
  const { t } = useI18n();
  const search = useSearch({ from: "/traffic" });
  const navigate = useNavigate({ from: "/traffic" });
  const range = search.range ?? "24h";
  const chart = search.chart ?? "rate";
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const scope = resolveTrafficScope(search, nodes.data ?? [], mappings.data ?? []);
  const nodeId = scope.nodeId;
  const mappingId = search.service ?? "";
  const catalogReady = Boolean(nodes.data && mappings.data);
  const catalogError = nodes.error || mappings.error;
  const invalid = catalogReady ? scope.error : undefined;
  const traffic = useQuery({
    queryKey: ["umbra", "traffic", range, nodeId, mappingId],
    queryFn: () =>
      getTraffic({
        data: { range, nodeId: nodeId || undefined, mappingId: mappingId || undefined },
      }),
    enabled: catalogReady && !invalid,
    // Preserve the old chart only when refreshing time within the same scope.
    placeholderData: (previous, query) =>
      query?.queryKey[3] === nodeId && query?.queryKey[4] === mappingId ? previous : undefined,
  });
  const stats = !invalid && catalogReady ? traffic.data : undefined;
  const peak = peakBpsFromSeries(stats?.series ?? []);
  const update = (change: Partial<TrafficSearch>) =>
    void navigate({ search: { ...search, ...change } });
  useEffect(() => {
    setPage(1);
    setQ("");
  }, [nodeId, mappingId]);
  // A service-only link resolves its owning node, so sharing the URL preserves both.
  useEffect(() => {
    if (catalogReady && !invalid && search.service && !search.node && nodeId) {
      void navigate({ search: { ...search, node: nodeId }, replace: true });
    }
  }, [catalogReady, invalid, search, nodeId, navigate]);

  const rows = (
    nodeId
      ? (mappings.data ?? [])
          .filter((m) => m.nodeId === nodeId)
          .map((m) => ({
            id: m.id,
            name: m.name,
            detail: m.proto.toUpperCase(),
            bytesIn: m.bytesIn,
            bytesOut: m.bytesOut,
            rate: (m.bpsIn ?? 0) + (m.bpsOut ?? 0),
            activity:
              m.proto === "udp"
                ? t("traffic.sessions", { n: m.udpActive ?? m.activeConns })
                : t("traffic.conns", { n: m.activeConns }),
            drops:
              m.proto === "udp"
                ? (m.udpDropMaxConns ?? 0) + (m.udpDropPerIP ?? 0) + (m.udpDropRate ?? 0)
                : 0,
          }))
      : (nodes.data ?? []).map((n) => ({
          id: n.id,
          name: n.name,
          detail: statusText(n.status),
          bytesIn: n.bytesIn,
          bytesOut: n.bytesOut,
          rate: (n.bpsIn ?? 0) + (n.bpsOut ?? 0),
          activity: t("traffic.serviceCount", { n: n.mappingCount }),
          drops: 0,
        }))
  )
    .filter((row) => `${row.name} ${row.detail}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pageData = pageOf(rows, page, PAGE_SIZE);
  const problem =
    invalid ||
    (catalogError
      ? t("traffic.nodesFail")
      : traffic.isError
        ? t("traffic.trafficFail")
        : undefined);

  return (
    <AppShell title={t("traffic.title")} description={t("traffic.description")} showTelemetry={false}>
      <ObservabilityNav
        active="traffic"
        trafficSearch={search}
        actions={
          <div className="observation-toolbar">
            <ObservationScope
              value={nodeId}
              onChange={(id) => update({ node: id || undefined, service: undefined })}
              nodes={nodes.data ?? []}
              loading={nodes.isPending}
              error={nodes.isError}
              onRetry={() => void nodes.refetch()}
            />
            <div
              role="group"
              aria-label={t("traffic.range")}
              className="flex w-fit rounded-md bg-paper-2 p-0.5 shadow-border"
            >
              {(["1h", "24h", "7d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => update({ range: r })}
                  className={cn(
                    "h-11 rounded-sm px-3 text-sm font-medium",
                    range === r ? "bg-paper text-ink" : "text-stone hover:text-ink",
                  )}
                >
                  {r === "1h" ? t("traffic.h1") : r === "24h" ? t("traffic.h24") : t("traffic.d7")}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <nav aria-label={t("traffic.scope")} className="flex min-w-0 flex-wrap items-center gap-2">
            <Link to="/traffic" search={{ range, chart }}>
              {t("traffic.allNodes")}
            </Link>
            {nodeId ? (
              <>
                <span className="text-stone">/</span>
                <Link to="/traffic" search={{ node: nodeId, range, chart }} className="break-all">
                  {scope.node?.name ?? t("traffic.selectedNode")}
                </Link>
              </>
            ) : null}
            {mappingId ? (
              <>
                <span className="text-stone">/</span>
                <span className="break-all">{scope.service?.name ?? t("traffic.selectedService")}</span>
              </>
            ) : null}
          </nav>
          {nodeId && catalogReady && !invalid ? (
            <Link
              to="/nodes/$nodeId"
              params={{ nodeId }}
              search={{ service: mappingId || undefined }}
              className="text-xs text-pine"
            >
              {mappingId ? t("traffic.openService") : t("traffic.backNode")} →
            </Link>
          ) : null}
        </div>
        {problem ? (
          <div role="alert" className="rounded-xl border border-rose/25 p-4 text-sm">
            <p>{problem}</p>
            {invalid ? (
              <Button
                variant="ghost"
                className="mt-2"
                onClick={() => update({ node: undefined, service: undefined })}
              >
                {t("traffic.backAll")}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => {
                  void nodes.refetch();
                  void mappings.refetch();
                  void traffic.refetch();
                }}
              >
                {t("common.retry")}
              </Button>
            )}
          </div>
        ) : null}
        <section
          aria-label={t("traffic.metrics")}
          aria-busy={traffic.isFetching}
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        >
          <Mini
            label={t("traffic.inRate")}
            value={stats ? formatBps(stats.bpsIn) : "—"}
            hint={
              stats && stats.series.length > 1
                ? t("traffic.peak", { v: formatBps(peak.in) })
                : t("traffic.waitSample")
            }
          />
          <Mini
            label={t("traffic.outRate")}
            value={stats ? formatBps(stats.bpsOut) : "—"}
            hint={
              stats && stats.series.length > 1
                ? t("traffic.peak", { v: formatBps(peak.out) })
                : t("traffic.waitSample")
            }
          />
          <Mini
            label={t("traffic.histIn")}
            value={stats ? formatBytes(stats.bytesIn) : "—"}
            hint={t("traffic.histHint")}
          />
          <Mini
            label={t("traffic.histOut")}
            value={stats ? formatBytes(stats.bytesOut) : "—"}
            hint={t("traffic.histHint")}
          />
        </section>
        <section className="min-w-0 rounded-xl bg-card p-4 shadow-border" aria-label={t("traffic.trend")}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label={t("traffic.chartType")} className="flex gap-1">
              <Button
                size="sm"
                variant={chart === "rate" ? "secondary" : "ghost"}
                aria-pressed={chart === "rate"}
                onClick={() => update({ chart: "rate" })}
              >
                {t("traffic.rate")}
              </Button>
              <Button
                size="sm"
                variant={chart === "bytes" ? "secondary" : "ghost"}
                aria-pressed={chart === "bytes"}
                onClick={() => update({ chart: "bytes" })}
              >
                {t("traffic.bytes")}
              </Button>
            </div>
            <span className="min-h-4 text-xs text-stone" role="status">
              {traffic.isFetching ? t("traffic.updating") : ""}
            </span>
          </div>
          <p className="mb-2 min-h-8 text-xs leading-4 text-stone">
            {chart === "rate" ? t("traffic.rateHint") : t("traffic.bytesHint")}
          </p>
          <RateChart
            kind={chart}
            range={range}
            data={stats?.series ?? []}
            loading={!catalogReady || traffic.isPending}
            updating={traffic.isPlaceholderData}
            error={Boolean(problem)}
          />
        </section>
        {!mappingId && !invalid ? (
          <section
            className="space-y-3"
            aria-label={nodeId ? t("traffic.serviceDetail") : t("traffic.nodeDetail")}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">
                  {nodeId ? t("traffic.serviceTraffic") : t("traffic.nodeTraffic")}
                </h2>
                <p className="mt-1 text-xs text-stone">
                  {nodeId ? t("traffic.detailHintService") : t("traffic.detailHintNode")}
                </p>
              </div>
              <Input
                className="w-full bg-card sm:w-56"
                aria-label={t("traffic.searchDetail")}
                placeholder={nodeId ? t("traffic.searchService") : t("traffic.searchNode")}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {!catalogReady ? (
              <p role="status" className="py-6 text-sm text-stone">
                {catalogError ? t("traffic.catalogFail") : t("traffic.catalogLoading")}
              </p>
            ) : rows.length ? (
              <ul className="traffic-breakdown">
                {pageData.items.map((row) => (
                  <li key={row.id}>
                    <Link
                      to="/traffic"
                      search={{
                        node: nodeId || row.id,
                        service: nodeId ? row.id : undefined,
                        range,
                        chart,
                      }}
                      aria-label={t("traffic.viewRow", { name: row.name })}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-sm font-medium">{row.name}</strong>
                        <small className="mt-1 block text-xs text-stone">
                          {row.detail} · {row.activity}
                          {row.drops > 0 ? t("traffic.udpDrops", { n: row.drops }) : ""}
                        </small>
                      </span>
                      <span className="traffic-breakdown-totals">
                        <small>{t("traffic.cumIo")}</small>
                        <span>
                          {formatBytes(row.bytesIn)} / {formatBytes(row.bytesOut)}
                        </span>
                      </span>
                      <span className="traffic-breakdown-rate">
                        <small>{t("traffic.nowRate")}</small>
                        <span>{formatBps(row.rate)}</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-stone" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-line p-6 text-sm text-stone">
                {q ? t("traffic.noMatch") : nodeId ? t("traffic.noServices") : t("traffic.noNodes")}
              </p>
            )}
            {rows.length > PAGE_SIZE ? (
              <Pager
                page={pageData.page}
                size={pageData.size}
                total={pageData.total}
                onPage={setPage}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 shadow-border">
      <p className="text-xs text-stone">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
      <p className="mt-0.5 h-4 text-[11px] leading-4 text-stone">{hint}</p>
    </div>
  );
}
