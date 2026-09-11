"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ActionMenu } from "@/components/ui/menu";
import { Pager } from "@/components/ui/pager";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ServiceList } from "@/components/services/service-list";
import { NodeScopePicker } from "@/components/services/node-scope-picker";
import { ServiceEditor } from "@/components/services/service-editor";
import { ServiceConnect, ServiceConnectSession } from "@/components/services/service-connect";
import { ConfigTransfer } from "@/components/config-transfer";
import { statusText, useI18n } from "@/lib/i18n";
import { listNodes, listMappings, deleteMapping, setMappingEnabled } from "@/lib/umbra/api";
import { PAGE_SIZE, pageOf } from "@/lib/umbra/page";
import { serviceState, serviceSummary, serviceMatches } from "@/lib/umbra/service";
import type { Mapping } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

type ServiceSearch = { node?: string; service?: string; create?: boolean };

type Editor = { mode: "create"; nodeId?: string } | { mode: "edit"; mapping: Mapping };

export function MappingsPage({ nodeId }: { nodeId?: string } = {}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const rawSearch = useSearch({ strict: false }) as ServiceSearch;
  const search = { ...rawSearch, node: nodeId };
  const routeNavigate = useNavigate();
  const navigate = ({ search: next, replace }: { search: ServiceSearch; replace?: boolean }) =>
    next.node
      ? routeNavigate({
          to: "/nodes/$nodeId",
          params: { nodeId: next.node },
          search: { service: next.service, create: next.create },
          replace,
        })
      : routeNavigate({ to: "/mappings", search: next, replace });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const [desktop, setDesktop] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1200px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const [q, setQ] = useState("");
  const [view, setView] = useState("all");
  const [proto, setProto] = useState("all");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Mapping | null>(null);
  const [transfer, setTransfer] = useState<"export" | "import" | null>(null);
  const all = mappings.data ?? [];
  const hasNode = nodes.data?.some((node) => node.status !== "revoked") ?? false;
  const scoped = nodeId ? all.filter((m) => m.nodeId === nodeId) : all;
  const summary = serviceSummary(scoped);
  const selected = scoped.find((mapping) => mapping.id === search.service);
  const rows = all.filter(
    (m) =>
      (!search.node || m.nodeId === search.node) &&
      serviceMatches(m, q) &&
      (proto === "all" || m.proto === proto) &&
      (view === "all" || serviceState(m).kind === view),
  );
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.nodeName.localeCompare(b.nodeName) ||
      a.id.localeCompare(b.id),
  );
  const pageData = pageOf(rows, page, PAGE_SIZE);
  useEffect(() => {
    setPage(1);
  }, [q, view, proto, search.node]);
  useEffect(() => {
    if (search.create && hasNode && !nodes.isPending) {
      const target = nodes.data?.find((node) => node.id === nodeId);
      if (!nodeId || (target && target.status !== "revoked")) {
        setEditor({ mode: "create", nodeId });
      }
      void routeNavigate({
        to: nodeId ? "/nodes/$nodeId" : "/mappings",
        params: { nodeId: nodeId ?? "" },
        search: { service: undefined, create: undefined },
        replace: true,
      });
    }
  }, [search.create, search.node, hasNode, nodes.isPending, nodes.data, nodeId, routeNavigate]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["umbra"] });
  };
  const remove = useMutation({
    mutationFn: (m: Mapping) => deleteMapping({ data: { id: m.id } }),
    onSuccess: () => {
      setPendingDelete(null);
      refresh();
      toast.success(t("services.deleted"));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (m: Mapping) => setMappingEnabled({ data: { id: m.id, enabled: !m.enabled } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const openService = (id: string) => {
    void navigate({ search: { node: search.node, service: id } });
  };
  const renderMenu = (m: Mapping) => (
    <ActionMenu
      label={t("services.more", { name: m.name })}
      items={[
        { label: t("services.edit"), onSelect: () => setEditor({ mode: "edit", mapping: m }) },
        {
          label: m.enabled ? t("common.disable") : t("common.enable"),
          disabled: toggle.isPending,
          onSelect: () => toggle.mutate(m),
        },
        { label: t("services.deleteTitle"), tone: "danger", onSelect: () => setPendingDelete(m) },
      ]}
    />
  );
  const scopedNode = nodes.data?.find((node) => node.id === search.node);
  const affected = all.filter((m) => m.nodeId === search.node && m.enabled).length;
  const filterCount = Number(view !== "all") + Number(proto !== "all");
  const statusOptions = [
    { value: "all", label: t("services.allStates") },
    { value: "attention", label: t("services.attention") },
    { value: "pending", label: t("services.pending") },
    { value: "disabled", label: t("services.disabled") },
  ];
  const clearFilters = () => {
    setQ("");
    setView("all");
    setProto("all");
    void navigate({ search: { node: nodeId, service: search.service } });
  };
  const loading = nodes.isPending || mappings.isPending;
  const error = nodes.error || mappings.error;

  return (
    <AppShell
      workspace
      title={nodeId ? (scopedNode?.name ?? t("nodes.nodeServices")) : t("services.title")}
      description={
        nodeId && scopedNode
          ? t("scope.line", { status: statusText(scopedNode.status), count: scoped.length })
          : undefined
      }
      showTelemetry={false}
      action={
        hasNode ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setTransfer("import")}>
              {t("transfer.import")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setTransfer("export")}>
              {t("transfer.export")}
            </Button>
            <Button
              disabled={Boolean(nodeId && (!scopedNode || scopedNode.status === "revoked"))}
              onClick={() => setEditor({ mode: "create", nodeId: search.node })}
            >
              <Plus className="mr-1.5 size-4" />
              {t("services.add")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setTransfer("import")}>
              {t("transfer.import")}
            </Button>
            <Button asChild>
              <Link to="/nodes">{t("services.enrollNode")}</Link>
            </Button>
          </div>
        )
      }
    >
      <div className={cn("topology-layout", search.service && "has-inspector")}>
        <div className="service-workspace space-y-5">
          {nodeId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <Link
                to="/nodes"
                className="inline-flex items-center gap-2 text-stone hover:text-ink"
              >
                <ArrowLeft className="size-4" />
                {t("services.backNode")}
              </Link>
              {scopedNode ? (
                <div className="flex items-center gap-5">
                  <Link to="/traffic" search={{ node: nodeId }} className="text-pine">
                    {t("services.viewTraffic")}
                  </Link>
                  <Link to="/nodes" search={{ edit: nodeId }} className="text-stone hover:text-ink">
                    {t("services.nodeSettings")}
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="rounded-lg border border-rose/30 p-4 text-sm">
              <p>{t("services.loadError", { message: error.message })}</p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => {
                  void nodes.refetch();
                  void mappings.refetch();
                }}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
          {loading ? (
            <p role="status" className="py-12 text-sm text-stone">
              {t("services.readingAll")}
            </p>
          ) : nodeId && !scopedNode && !nodes.error ? (
            <p role="status" className="rounded-xl border border-line p-6">
              {t("services.missingNode")}
            </p>
          ) : !nodes.data?.length && !all.length && !error ? (
            <section className="rounded-xl border border-line bg-card p-6 sm:p-8">
              <h3 className="text-xl font-semibold">{t("services.startTitle")}</h3>
              <ol className="my-6 grid gap-5 text-sm sm:grid-cols-3">
                <li>
                  <span className="text-xs text-stone">01</span>
                  <p className="mt-1 font-medium">{t("services.stepEnroll")}</p>
                  <p className="mt-1 text-stone">{t("services.stepEnrollHint")}</p>
                </li>
                <li>
                  <span className="text-xs text-stone">02</span>
                  <p className="mt-1 font-medium">{t("services.stepAdd")}</p>
                  <p className="mt-1 text-stone">{t("services.stepAddHint")}</p>
                </li>
                <li>
                  <span className="text-xs text-stone">03</span>
                  <p className="mt-1 font-medium">{t("services.stepConnect")}</p>
                  <p className="mt-1 text-stone">{t("services.stepConnectHint")}</p>
                </li>
              </ol>
              <Button asChild>
                <Link to="/nodes">
                  {t("services.firstNode")} <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </section>
          ) : !error || all.length ? (
            <>
              <div className="flex items-center gap-3">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone" />
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    aria-label={t("services.search")}
                    placeholder={nodeId ? t("services.searchHere") : t("services.searchAll")}
                    className="bg-card pl-9"
                  />
                </div>
                <Button
                  variant={filtersOpen ? "secondary" : "outline"}
                  aria-expanded={filtersOpen}
                  aria-controls="service-filters"
                  onClick={() => setFiltersOpen(!filtersOpen)}
                >
                  <SlidersHorizontal className="size-4" />
                  {filterCount ? t("services.filterCount", { n: filterCount }) : t("services.filter")}
                </Button>
              </div>
              {filtersOpen ? (
                <div
                  id="service-filters"
                  className={cn("service-refine-panel", nodeId && "is-node-scoped")}
                >
                  {!nodeId ? (
                    <div>
                      <span className="service-refine-label">{t("services.node")}</span>
                      <NodeScopePicker
                        nodes={nodes.data ?? []}
                        mappings={all}
                        nodeId={search.node}
                        onSelect={(node) => void navigate({ search: { node } })}
                      />
                    </div>
                  ) : null}
                  <div>
                    <span className="service-refine-label">{t("services.state")}</span>
                    <Select
                      aria-label={t("services.state")}
                      value={view}
                      onValueChange={setView}
                      options={statusOptions}
                    />
                  </div>
                  <div>
                    <span className="service-refine-label">{t("services.proto")}</span>
                    <Select
                      aria-label={t("services.proto")}
                      value={proto}
                      onValueChange={setProto}
                      options={[
                        { value: "all", label: t("services.allProtos") },
                        { value: "tcp", label: "TCP" },
                        { value: "udp", label: "UDP" },
                      ]}
                    />
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {q || filterCount
                      ? t("services.countFiltered", { shown: rows.length, total: scoped.length })
                      : t("services.count", { count: scoped.length })}
                  </span>
                  {view !== "all" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("services.clearState")}
                      onClick={() => setView("all")}
                    >
                      {statusOptions.find((option) => option.value === view)?.label}
                      <X className="size-3" />
                    </Button>
                  ) : null}
                  {proto !== "all" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("services.clearProto")}
                      onClick={() => setProto("all")}
                    >
                      {proto.toUpperCase()}
                      <X className="size-3" />
                    </Button>
                  ) : null}
                </div>
                {q || filterCount ? (
                  <Button size="sm" variant="ghost" onClick={clearFilters}>
                    {t("services.clear")}
                  </Button>
                ) : summary.attention > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose"
                    onClick={() => setView("attention")}
                  >
                    {t("services.needAttention", { n: summary.attention })}
                    <ArrowRight className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              {scopedNode && scopedNode.status !== "online" && affected > 0 ? (
                <div
                  className="rounded-xl border border-rose/25 px-4 py-3 text-sm"
                  aria-label={t("services.nodeImpact")}
                >
                  <p>
                    {t("services.nodeDown", {
                      name: scopedNode.name,
                      status: statusText(scopedNode.status),
                      n: affected,
                    })}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-stone">
                    <span>
                      {scopedNode.status === "revoked" ? t("services.pickValid") : t("services.checkNode")}
                    </span>
                    <Link
                      to="/nodes"
                      search={{ edit: nodeId }}
                      className="text-pine underline underline-offset-4"
                    >
                      {t("services.viewNode")}
                    </Link>
                  </div>
                </div>
              ) : null}
              {!rows.length ? (
                <section className="rounded-lg border border-dashed border-line px-5 py-10 text-center">
                  <h3 className="font-medium">
                    {q || filterCount
                      ? t("services.noneMatch")
                      : scopedNode?.status === "revoked"
                        ? t("services.noneOnNode")
                        : t("services.first")}
                  </h3>
                  <p className="mt-2 text-sm text-stone">
                    {q || filterCount
                      ? t("services.noneMatchHint")
                      : scopedNode?.status === "revoked"
                        ? t("services.revokedHint")
                        : t("services.firstHint")}
                  </p>
                  {q || filterCount ? (
                    <Button variant="outline" className="mt-5" onClick={clearFilters}>
                      {t("services.clear")}
                    </Button>
                  ) : null}
                </section>
              ) : (
                <ServiceList
                  mappings={pageData.items}
                  selectedId={search.service}
                  onSelect={openService}
                  renderMenu={renderMenu}
                />
              )}
              {rows.length > PAGE_SIZE ? (
                <Pager
                  page={pageData.page}
                  size={pageData.size}
                  total={pageData.total}
                  onPage={setPage}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <ServiceConnectSession key={selected?.id ?? "missing"} mapping={selected}>
        <Sheet
          modal={!desktop}
          open={Boolean(search.service)}
          onOpenChange={(open) => !open && void navigate({ search: { node: search.node } })}
        >
          <SheetContent
            side="right"
            overlay={!desktop}
            className="max-w-xl service-sheet network-inspector-sheet"
            data-workspace-inspector={desktop ? "true" : undefined}
            onInteractOutside={(event) => {
              if (desktop) event.preventDefault();
            }}
          >
            {selected ? (
              <ServiceConnect
                key={selected.id}
                mapping={selected}
                onEdit={() => {
                  void navigate({ search: { node: search.node } });
                  setEditor({ mode: "edit", mapping: selected });
                }}
              />
            ) : (
              <MissingService loading={mappings.isPending} />
            )}
          </SheetContent>
        </Sheet>
      </ServiceConnectSession>
      <Sheet open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <SheetContent side="right" className="max-w-xl service-sheet">
          {editor ? (
            <ServiceEditor
              key={editor.mode === "edit" ? editor.mapping.id : `new-${editor.nodeId ?? "any"}`}
              mapping={editor.mode === "edit" ? editor.mapping : null}
              defaultNodeId={editor.mode === "create" ? editor.nodeId : undefined}
              onDone={(m) => {
                if (m.proto)
                  qc.setQueryData<Mapping[]>(["umbra", "mappings"], (old = []) => [
                    ...old.filter((item) => item.id !== m.id),
                    m,
                  ]);
                setEditor(null);
                refresh();
                void navigate({ search: { node: nodeId ? m.nodeId : undefined, service: m.id } });
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfigTransfer
        mode={transfer}
        nodes={nodes.data ?? []}
        mappings={all}
        preselectNodeId={nodeId}
        onClose={() => setTransfer(null)}
        onApplied={refresh}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("services.deleteTitle")}
        description={t("services.deleteBody", { name: pendingDelete?.name ?? "" })}
        confirmLabel={t("services.deleteTitle")}
        danger
        pending={remove.isPending}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />
    </AppShell>
  );
}

import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
function MissingService({ loading }: { loading: boolean }) {
  const { t } = useI18n();
  return (
    <SheetHeader>
      <SheetTitle>{loading ? t("services.reading") : t("services.unavailable")}</SheetTitle>
      <SheetDescription>{loading ? t("services.waitRetry") : t("services.gone")}</SheetDescription>
    </SheetHeader>
  );
}
