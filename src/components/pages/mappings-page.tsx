"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Plus, Search, Network, List } from "lucide-react";
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
import { NetworkBoard } from "@/components/services/network-board";
import { ServiceEditor } from "@/components/services/service-editor";
import { ServiceConnect, ServiceConnectSession } from "@/components/services/service-connect";
import { listNodes, listMappings, deleteMapping, setMappingEnabled } from "@/lib/umbra/api";
import { PAGE_SIZE, pageOf } from "@/lib/umbra/page";
import { serviceState, serviceSummary, serviceMatches } from "@/lib/umbra/service";
import type { Mapping } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

type Editor = { mode: "create"; nodeId?: string } | { mode: "edit"; mapping: Mapping };

export function MappingsPage() {
  const qc = useQueryClient();
  const search = useSearch({ from: "/mappings" });
  const navigate = useNavigate({ from: "/mappings" });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const [desktop, setDesktop] = useState(false);
  const [layout, setLayout] = useState<"list" | "nodes">("list");
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
  const all = mappings.data ?? [];
  const hasNode = nodes.data?.some((node) => node.status !== "revoked") ?? false;
  const summary = serviceSummary(all);
  const selected = all.find((mapping) => mapping.id === search.service);
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
      setEditor({ mode: "create", nodeId: search.node });
      void navigate({ search: { node: search.node }, replace: true });
    }
  }, [search.create, search.node, hasNode, nodes.isPending, navigate]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["umbra"] });
  };
  const remove = useMutation({
    mutationFn: (m: Mapping) => deleteMapping({ data: { id: m.id } }),
    onSuccess: () => {
      setPendingDelete(null);
      refresh();
      toast.success("服务已删除");
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
      label={`${m.name} 的更多操作`}
      items={[
        { label: "编辑服务", onSelect: () => setEditor({ mode: "edit", mapping: m }) },
        {
          label: m.enabled ? "停用" : "启用",
          disabled: toggle.isPending,
          onSelect: () => toggle.mutate(m),
        },
        { label: "删除服务", tone: "danger", onSelect: () => setPendingDelete(m) },
      ]}
    />
  );
  const nodeIssues = (nodes.data ?? [])
    .filter((node) => node.status !== "online")
    .map((node) => ({
      node,
      count: all.filter((m) => m.nodeId === node.id && m.enabled).length,
    }))
    .filter((issue) => issue.count > 0 && (!search.node || issue.node.id === search.node));
  const loading = nodes.isPending || mappings.isPending;
  const error = nodes.error || mappings.error;

  return (
    <AppShell
      workspace
      title="服务"
      description="连接你的内网服务，随时知道下一步。"
      action={
        hasNode ? (
          <Button onClick={() => setEditor({ mode: "create", nodeId: search.node })}>
            <Plus className="mr-1.5 size-4" />
            添加服务
          </Button>
        ) : (
          <Button asChild>
            <Link to="/nodes">接入节点</Link>
          </Button>
        )
      }
    >
      <div className={cn("topology-layout", search.service && "has-inspector")}>
        <div className="service-workspace space-y-5">
          {error ? (
            <div role="alert" className="rounded-lg border border-rose/30 p-4 text-sm">
              <p>无法更新服务数据：{error.message}</p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => {
                  void nodes.refetch();
                  void mappings.refetch();
                }}
              >
                重新加载
              </Button>
            </div>
          ) : null}
          {loading ? (
            <p role="status" className="py-12 text-sm text-stone">
              正在读取节点与服务…
            </p>
          ) : !hasNode && !error ? (
            <section className="rounded-xl border border-line bg-card p-6 sm:p-8">
              <h3 className="text-xl font-semibold">从一台内网节点开始</h3>
              <ol className="my-6 grid gap-5 text-sm sm:grid-cols-3">
                <li>
                  <span className="text-xs text-stone">01</span>
                  <p className="mt-1 font-medium">接入节点</p>
                  <p className="mt-1 text-stone">复制安装命令，在内网机器执行。</p>
                </li>
                <li>
                  <span className="text-xs text-stone">02</span>
                  <p className="mt-1 font-medium">添加服务</p>
                  <p className="mt-1 text-stone">填写真实目标，选择访问范围。</p>
                </li>
                <li>
                  <span className="text-xs text-stone">03</span>
                  <p className="mt-1 font-medium">开始连接</p>
                  <p className="mt-1 text-stone">获取地址或访问命令，验证响应。</p>
                </li>
              </ol>
              <Button asChild>
                <Link to="/nodes">
                  接入第一台节点 <ArrowRight className="ml-2 size-4" />
                </Link>
              </Button>
            </section>
          ) : !error || all.length ? (
            <>
              <div className="workspace-view-row">
                <div role="group" aria-label="服务视图" className="service-view-tabs">
                  {[
                    { value: "all", label: "全部服务", count: summary.total },
                    { value: "attention", label: "需要处理", count: summary.attention },
                    { value: "pending", label: "等待确认", count: summary.pending },
                    { value: "disabled", label: "已停用", count: summary.disabled },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={view === item.value}
                      onClick={() => setView(item.value)}
                      className={cn("service-view-tab", view === item.value && "is-active")}
                    >
                      <span>{item.label}</span>
                      <span
                        className={cn(
                          "service-tab-count",
                          item.value === "attention" && item.count > 0 && "text-rose",
                        )}
                      >
                        {item.count}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="board-view-switch" role="group" aria-label="服务查看方式">
                  <button aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
                    <List className="size-4" />
                    服务列表
                  </button>
                  <button aria-pressed={layout === "nodes"} onClick={() => setLayout("nodes")}>
                    <Network className="size-4" />
                    按节点排查
                  </button>
                </div>
              </div>
              <div className="service-filter-bar">
                <div className="relative min-w-48 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone" />
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    aria-label="搜索服务"
                    placeholder="搜索服务、节点或端口"
                    className="pl-9 bg-card"
                  />
                </div>
                <Select
                  aria-label="筛选节点"
                  value={search.node ?? "all"}
                  onValueChange={(value) =>
                    void navigate({ search: { node: value === "all" ? undefined : value } })
                  }
                  triggerClassName="w-40"
                  options={[
                    { value: "all", label: "全部节点" },
                    ...(nodes.data ?? []).map((n) => ({ value: n.id, label: n.name })),
                  ]}
                />
                <Select
                  aria-label="筛选协议"
                  value={proto}
                  onValueChange={setProto}
                  triggerClassName="w-28"
                  options={[
                    { value: "all", label: "全部协议" },
                    { value: "tcp", label: "TCP" },
                    { value: "udp", label: "UDP" },
                  ]}
                />
              </div>
              {search.node || q || proto !== "all" || view !== "all" ? (
                <div className="flex items-center justify-between text-xs text-stone">
                  <span>
                    筛选结果 {rows.length} 项 / 全部 {all.length} 项
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQ("");
                      setProto("all");
                      setView("all");
                      void navigate({ search: {} });
                    }}
                  >
                    清除所有筛选
                  </Button>
                </div>
              ) : null}
              {nodeIssues.length &&
              !q &&
              proto === "all" &&
              (view === "all" || view === "attention") ? (
                <div className="service-node-issues" aria-label="节点故障影响">
                  {nodeIssues.map(({ node, count }) => (
                    <button
                      key={node.id}
                      onClick={() => {
                        setLayout("nodes");
                        setView("attention");
                        setPage(1);
                        void navigate({ search: { node: node.id } });
                      }}
                    >
                      <span>
                        <strong>{node.name}</strong> {node.status === "revoked" ? "已吊销" : "离线"}{" "}
                        · 影响 {count} 项服务
                      </span>
                      <span>
                        按节点排查 <ArrowRight className="size-3.5" />
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {!rows.length ? (
                <section className="rounded-lg border border-dashed border-line px-5 py-10 text-center">
                  <h3 className="font-medium">
                    {all.length ? "没有匹配的服务" : "节点准备好了，添加第一个服务"}
                  </h3>
                  <p className="mt-2 text-sm text-stone">
                    {all.length
                      ? "调整筛选条件，或清除筛选查看全部服务。"
                      : "无需在节点上编写映射配置。填写目标地址和端口即可。"}
                  </p>
                  {!all.length ? (
                    <Button
                      className="mt-5"
                      onClick={() => setEditor({ mode: "create", nodeId: search.node })}
                    >
                      添加服务
                    </Button>
                  ) : null}
                </section>
              ) : layout === "list" ? (
                <ServiceList
                  mappings={pageData.items}
                  selectedId={search.service}
                  onSelect={openService}
                  renderMenu={renderMenu}
                />
              ) : (
                <NetworkBoard
                  mappings={pageData.items}
                  selectedId={search.service}
                  onSelect={openService}
                  onAdd={(nodeId) => setEditor({ mode: "create", nodeId })}
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
              <p className="text-xs leading-relaxed text-stone">
                “配置就绪”表示节点已确认配置。实际连接还取决于访问授权、网络路径和目标服务。
              </p>
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
                openService(m.id);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除服务"
        description={`删除「${pendingDelete?.name ?? ""}」将释放入口端口并撤销关联访问凭证。其它服务不受影响。`}
        confirmLabel="删除服务"
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
  return (
    <SheetHeader>
      <SheetTitle>{loading ? "正在读取服务…" : "服务不可用"}</SheetTitle>
      <SheetDescription>
        {loading ? "稍候重试。" : "此服务可能已删除或数据读取失败，请关闭面板后刷新。"}
      </SheetDescription>
    </SheetHeader>
  );
}
