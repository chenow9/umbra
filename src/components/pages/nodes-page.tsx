"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActionMenu } from "@/components/ui/menu";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CheckField, TextAreaField, TextField, SelectField } from "@/components/field";
import { Input } from "@/components/ui/input";
import {
  caDownloadURL,
  createNode,
  deleteNode,
  disconnectNode,
  queryNodes,
  listNodes,
  listMappings,
  rotateNodeToken,
  revokeNode,
  updateNode,
} from "@/lib/umbra/api";
import { emptyPage, nodeFacets, PAGE_SIZE, type NodeFacets } from "@/lib/umbra/page";
import { serviceSummary } from "@/lib/umbra/service";
import { cn } from "@/lib/utils";
import { Pager } from "@/components/ui/pager";
import { formatBytes, formatBps, formatRelative } from "@/lib/umbra/format";
import type { Node } from "@/lib/umbra/types";
import {
  ARCHS,
  PLATFORMS,
  nodeEnrollDockerCmd,
  nodeEnrollServiceCmd,
  platformLabel,
  type Arch,
  type Platform,
} from "@/lib/umbra/units";

type Issued = {
  id: string;
  token: string;
  os: Platform;
  arch: Arch;
  installCmd?: string;
  dockerCmd?: string;
  listen?: string;
  caPem?: string;
  note?: string;
  expiresAt?: string;
  neverExpire?: boolean;
};
type Editor = { mode: "create" } | { mode: "edit"; node: Node };

export function NodesPage() {
  const qc = useQueryClient();
  const search = useSearch({ from: "/nodes" });
  const navigate = useNavigate({ from: "/nodes" });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [os, setOs] = useState("all");
  const [page, setPage] = useState(1);
  const query = {
    q: q.trim() || undefined,
    status: status === "all" ? undefined : status,
    os: os === "all" ? undefined : os,
    page,
    size: PAGE_SIZE,
  };
  const nodes = useQuery({
    queryKey: ["umbra", "nodes", "page", query],
    queryFn: () => queryNodes(query),
    placeholderData: keepPreviousData,
  });
  const catalog = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const services = useQuery({ queryKey: ["umbra", "mappings"], queryFn: listMappings });
  const facets = nodeFacets(catalog.data ?? [], { q, status, os });
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (!search.edit || !catalog.data) return;
    const node = catalog.data.find((item) => item.id === search.edit);
    if (node) setEditor({ mode: "edit", node });
    else toast.error("该节点已不存在");
    void navigate({ search: {}, replace: true });
  }, [search.edit, catalog.data, navigate]);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const [pendingRotate, setPendingRotate] = useState<Node | null>(null);
  const pageData = nodes.data ?? emptyPage<Node>(page);
  const list = pageData.items;
  const empty =
    !nodes.isPending &&
    !nodes.isError &&
    pageData.total === 0 &&
    !q &&
    status === "all" &&
    os === "all";
  useEffect(() => {
    setPage(1);
  }, [q, status, os]);
  useEffect(() => {
    if (!nodes.data) return;
    const pages = Math.max(1, Math.ceil(nodes.data.total / nodes.data.size) || 1);
    if (page > pages) setPage(pages);
  }, [nodes.data, page]);

  const remove = useMutation({
    mutationFn: (node: Node) => deleteNode({ data: { id: node.id, force: node.mappingCount > 0 } }),
    onSuccess: () => {
      toast.message("节点已删除");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: (node: Node) => rotateNodeToken({ data: { id: node.id } }),
    onSuccess: (r, node) => {
      toast.success(`新凭证已签发，旧凭证宽限 ${r.graceSec} 秒`);
      setPendingRotate(null);
      setIssued({
        id: node.id,
        token: r.token,
        os: (node.os as Platform) || "linux",
        arch: (node.arch as Arch) || "amd64",
        installCmd: r.installCmd,
        dockerCmd: r.dockerCmd,
        listen: r.listen,
        caPem: r.caPem,
        note: `旧凭证宽限 ${r.graceSec} 秒`,
        expiresAt: r.expiresAt,
        neverExpire: r.neverExpire,
      });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AppShell
      description="选择一台节点，打开它的服务。"
      showTelemetry={false}
      title="节点"
      action={
        empty ? null : (
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            登记节点
          </Button>
        )
      }
    >
      {nodes.isError ? (
        <div role="alert" className="mb-5 rounded-xl border border-rose/25 p-4 text-sm">
          <p>无法读取节点：{nodes.error.message}</p>
          <Button variant="outline" className="mt-3" onClick={() => void nodes.refetch()}>
            重新加载
          </Button>
        </div>
      ) : null}
      {nodes.isPending ? (
        <p role="status" className="py-10 text-sm text-stone">
          正在读取节点…
        </p>
      ) : empty ? (
        <EmptyNodes onCreate={() => setEditor({ mode: "create" })} />
      ) : nodes.isError && !nodes.data ? null : (
        <>
          <NodeFleetBar
            q={q}
            onQuery={setQ}
            status={status}
            os={os}
            onStatus={setStatus}
            onOs={setOs}
            facets={facets}
            loading={catalog.isPending}
          />

          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-8 text-center text-sm text-stone shadow-border">
              没有匹配的节点。
            </p>
          ) : (
            <>
              <div className="node-directory" role="list" aria-label="节点列表">
                {list.map((node) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    attention={
                      services.data
                        ? serviceSummary(services.data.filter((m) => m.nodeId === node.id))
                            .attention
                        : undefined
                    }
                    onEdit={() => setEditor({ mode: "edit", node })}
                    onDelete={() => setPendingDelete(node)}
                    onRotate={() => setPendingRotate(node)}
                  />
                ))}
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

      <Sheet open={editor !== null} onOpenChange={(v) => !v && setEditor(null)}>
        <SheetContent side="right">
          {editor?.mode === "edit" ? (
            <EditNodeForm
              key={editor.node.id}
              node={editor.node}
              onDone={() => {
                setEditor(null);
                void qc.invalidateQueries({ queryKey: ["umbra"] });
              }}
            />
          ) : editor?.mode === "create" ? (
            <CreateNodeForm
              onIssued={(v) => {
                setEditor(null);
                setIssued(v);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <IssuedDialog issued={issued} onClose={() => setIssued(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.mappingCount ? "删除节点及其服务" : "删除节点"}
        description={
          pendingDelete?.mappingCount
            ? `「${pendingDelete.name}」下还有 ${pendingDelete.mappingCount} 条服务，将一并删除并吊销凭证。`
            : `删除「${pendingDelete?.name ?? ""}」并吊销凭证。此操作不能恢复。`
        }
        confirmLabel="删除"
        danger
        pending={remove.isPending}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />

      <ConfirmDialog
        open={pendingRotate !== null}
        title="轮换凭证"
        description="轮换后请立刻把新凭证写到节点。旧凭证大约 90 秒内仍可用。"
        confirmLabel="签发新凭证"
        pending={rotate.isPending}
        onOpenChange={(v) => !v && !rotate.isPending && setPendingRotate(null)}
        onConfirm={() => pendingRotate && rotate.mutate(pendingRotate)}
      />
    </AppShell>
  );
}

function NodeFleetBar({
  q,
  onQuery,
  status,
  os,
  onStatus,
  onOs,
  facets,
  loading,
}: {
  q: string;
  onQuery: (value: string) => void;
  status: string;
  os: string;
  onStatus: (value: string) => void;
  onOs: (value: string) => void;
  facets: NodeFacets;
  loading: boolean;
}) {
  const filtered = status !== "all" || os !== "all" || q.trim() !== "";
  return (
    <div className="mb-5 space-y-4">
      <div className="workspace-view-row">
        <div role="group" aria-label="节点状态" className="service-view-tabs">
          {facets.status.map((item) => {
            const selected = status === item.value;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onStatus(item.value === "all" || selected ? "all" : item.value)}
                className={cn("service-view-tab", selected && "is-active")}
              >
                {item.status ? <i className={cn("node-signal", `is-${item.status}`)} /> : null}
                <span>{item.label}</span>
                <span
                  className={cn(
                    "service-tab-count",
                    item.value === "revoked" && item.count > 0 && "text-rose",
                  )}
                >
                  {loading ? "—" : item.count}
                </span>
              </button>
            );
          })}
        </div>
        <div role="group" aria-label="节点系统" className="node-os-switch">
          {facets.os.map((item) => {
            const selected = os === item.value;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onOs(selected ? "all" : item.value)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="service-filter-bar">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone" />
          <Input
            value={q}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜索名称、备注、地址"
            aria-label="搜索节点"
            className="pl-9 bg-card"
          />
        </div>
        {filtered ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onQuery("");
              onStatus("all");
              onOs("all");
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyNodes({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 py-8">
      <div>
        <h2 className="font-serif text-3xl italic tracking-tight text-ink">先登记一台节点</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          凭证只显示一次。之后服务都在服务端改，不用再登录那台机器。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onCreate}>
          登记节点
        </Button>
      </div>
    </div>
  );
}

function statusLabel(status: Node["status"]) {
  return status === "online" ? "在线" : status === "revoked" ? "已吊销" : "离线";
}

function NodeCard({
  node,
  attention,
  onEdit,
  onDelete,
  onRotate,
}: {
  node: Node;
  attention?: number;
  onEdit: () => void;
  onDelete: () => void;
  onRotate: () => void;
}) {
  return (
    <article className="node-directory-row" role="listitem">
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: node.id }}
        className="node-directory-link"
        aria-label={`打开 ${node.name} 的服务`}
      >
        <span className="node-directory-identity">
          <strong>{node.name}</strong>
          <small>{node.comment || node.addr || platformLabel(node.os, node.arch)}</small>
        </span>
        <StatusDot status={node.status} label={statusLabel(node.status)} />
        <span className="node-directory-services">
          <span>{node.mappingCount} 项服务</span>
          {attention ? <small className="text-rose">{attention} 项需处理</small> : null}
        </span>
        <ArrowRight className="size-4 text-stone" />
      </Link>
      <NodeMenu node={node} onEdit={onEdit} onDelete={onDelete} onRotate={onRotate} />
    </article>
  );
}

function NodeMenu({
  node,
  onEdit,
  onDelete,
  onRotate,
}: {
  node: Node;
  onEdit: () => void;
  onDelete: () => void;
  onRotate: () => void;
}) {
  const qc = useQueryClient();
  const bye = useMutation({
    mutationFn: () => disconnectNode({ data: { id: node.id } }),
    onSuccess: () => {
      toast.message("节点已离线，服务等待重连");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => revokeNode({ data: { id: node.id } }),
    onSuccess: () => {
      toast.message("凭证已吊销");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ActionMenu
      label={`${node.name} 的更多操作`}
      items={[
        { label: "编辑", onSelect: onEdit },
        {
          label: "轮换凭证",
          hidden: node.status === "revoked",
          onSelect: onRotate,
        },
        {
          label: "下载 CA",
          onSelect: () => {
            window.open(caDownloadURL(), "_blank", "noopener");
          },
        },
        {
          label: "断开",
          hidden: node.status !== "online",
          disabled: bye.isPending,
          onSelect: () => bye.mutate(),
        },
        {
          label: "吊销凭证",
          hidden: node.status === "revoked",
          disabled: revoke.isPending,
          tone: "danger",
          onSelect: () => revoke.mutate(),
        },
        { label: "删除", tone: "danger", onSelect: onDelete },
      ]}
    />
  );
}

function CreateNodeForm({ onIssued }: { onIssued: (v: Issued) => void }) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [os, setOs] = useState<Platform>("linux");
  const [arch, setArch] = useState<Arch>("amd64");
  const [neverExpire, setNeverExpire] = useState(false);
  const create = useMutation({
    mutationFn: () => createNode({ data: { name, comment, os, arch, neverExpire } }),
    onSuccess: (res) => {
      toast.success("凭证已签发，请复制保存", { id: "create-node" });
      onIssued({
        id: res.id,
        token: res.token,
        os,
        arch,
        installCmd: res.installCmd,
        dockerCmd: res.dockerCmd,
        listen: res.listen,
        caPem: res.caPem,
        expiresAt: res.expiresAt,
        neverExpire: res.neverExpire,
      });
    },
    onError: (e: Error) => toast.error(e.message, { id: "create-node" }),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>登记节点</SheetTitle>
        <SheetDescription>选择这台机器的平台，生成安装命令。上线后直接添加服务。</SheetDescription>
      </SheetHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (create.isPending) return;
          if (!name.trim()) {
            toast.error("先写名称");
            return;
          }
          toast.loading("正在登记…", { id: "create-node" });
          create.mutate();
        }}
      >
        <SheetBody className="flex flex-col gap-3">
          <TextField
            label="名称"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="home-nas"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="系统"
              value={os}
              onValueChange={(v) => setOs(v as Platform)}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <SelectField
              label="架构"
              value={arch}
              onValueChange={(v) => setArch(v as Arch)}
              options={ARCHS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <TextAreaField
            label="备注"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="可选"
          />
          <CheckField
            label="凭证永不过期"
            hint="默认 90 天。长期在线的实验机或内网节点可勾选；仍可随时轮换或吊销。"
            checked={neverExpire}
            onChange={setNeverExpire}
          />
        </SheetBody>
        <SheetFooter className="flex items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {name.trim()
              ? neverExpire
                ? "凭证永不过期，只显示一次，请及时保存。"
                : "凭证默认 90 天有效，只显示一次，请及时保存。"
              : "填写名称后即可签发。"}
          </p>
          <div className="flex shrink-0 gap-2">
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </SheetClose>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "登记中…" : "签发凭证"}
            </Button>
          </div>
        </SheetFooter>
      </form>
    </>
  );
}

function EditNodeForm({ node, onDone }: { node: Node; onDone: () => void }) {
  const [name, setName] = useState(node.name);
  const [comment, setComment] = useState(node.comment);
  const [os, setOs] = useState<Platform>((node.os as Platform) || "linux");
  const [arch, setArch] = useState<Arch>((node.arch as Arch) || "amd64");
  const [neverExpire, setNeverExpire] = useState(Boolean(node.tokenNoExpiry));
  const save = useMutation({
    mutationFn: () => updateNode({ data: { id: node.id, name, comment, os, arch, neverExpire } }),
    onSuccess: () => {
      toast.success("节点已更新");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>编辑节点</SheetTitle>
        <SheetDescription>名称和备注只影响控制台。系统/架构用于安装命令。</SheetDescription>
      </SheetHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || save.isPending) return;
          save.mutate();
        }}
      >
        <SheetBody className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-paper-2 p-3 text-xs">
            <div>
              <dt className="text-stone">节点状态</dt>
              <dd className="mt-1">{statusLabel(node.status)}</dd>
            </div>
            <div>
              <dt className="text-stone">最近心跳</dt>
              <dd className="mt-1">{formatRelative(node.lastSeen)}</dd>
            </div>
            <div>
              <dt className="text-stone">连接地址</dt>
              <dd className="mt-1 break-all">{node.addr ?? "未连接"}</dd>
            </div>
            <div>
              <dt className="text-stone">累计流量 / 当前速率</dt>
              <dd className="mt-1">
                {formatBytes(node.bytesIn + node.bytesOut)} /{" "}
                {formatBps((node.bpsIn ?? 0) + (node.bpsOut ?? 0))}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-stone">凭证</dt>
              <dd className="mt-1">
                {node.status === "revoked"
                  ? "已吊销"
                  : node.tokenNoExpiry
                    ? "永不过期"
                    : node.tokenExpiresAt
                      ? `${formatRelative(node.tokenExpiresAt)} 到期`
                      : "未提供到期时间"}
              </dd>
            </div>
          </dl>
          <TextField
            label="名称"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="系统"
              value={os}
              onValueChange={(v) => setOs(v as Platform)}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <SelectField
              label="架构"
              value={arch}
              onValueChange={(v) => setArch(v as Arch)}
              options={ARCHS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <TextAreaField
            label="备注"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {node.status !== "revoked" ? (
            <CheckField
              label="凭证永不过期"
              hint="勾选后立刻作用于当前凭证，不断开节点。取消则从现在起再计 90 天。仍可随时轮换或吊销。"
              checked={neverExpire}
              onChange={setNeverExpire}
            />
          ) : null}
        </SheetBody>
        <SheetFooter className="flex items-center justify-end gap-2">
          <SheetClose asChild>
            <Button type="button" variant="ghost">
              取消
            </Button>
          </SheetClose>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
}

function IssuedDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  return (
    <Dialog open={issued !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>节点凭证已签发</DialogTitle>
          <DialogDescription>
            凭证只显示一次，之后只能轮换。复制一键命令并粘贴到节点终端即可。
            {issued?.listen?.startsWith("127.0.0.1")
              ? " 命令里的 127.0.0.1 请换成节点能连上的入口地址。"
              : ""}
            {issued?.note ? ` ${issued.note}` : ""}
            {issued?.neverExpire ? " 此凭证永不过期，仍可随时轮换或吊销。" : ""}
          </DialogDescription>
        </DialogHeader>
        {issued ? <IssuedBody key={issued.token} issued={issued} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function defaultEnrollKind(os: Platform): "docker" | "bin" {
  return os === "darwin" || os === "windows" ? "bin" : "docker";
}

function IssuedBody({ issued, onClose }: { issued: Issued; onClose: () => void }) {
  const liveNodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const online = liveNodes.data?.find((node) => node.id === issued.id)?.status === "online";
  const [kind, setKind] = useState<"docker" | "bin">(defaultEnrollKind(issued.os));
  const [fetchedPem, setFetchedPem] = useState(issued.caPem ?? "");
  useEffect(() => {
    if (issued.caPem) return;
    const ac = new AbortController();
    fetch(caDownloadURL(), { credentials: "include", signal: ac.signal })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (t.includes("BEGIN CERTIFICATE")) setFetchedPem(t);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [issued.caPem]);

  const server = issued.listen?.trim() || "入口:4400";
  const pem = (issued.caPem || fetchedPem).trim();
  const dockerCmd =
    issued.dockerCmd && (issued.dockerCmd.includes("BEGIN CERTIFICATE") || !pem)
      ? issued.dockerCmd
      : nodeEnrollDockerCmd(issued.token, server, pem || undefined);
  const servicePlatform = issued.os === "docker" ? "linux" : issued.os;
  const binCmd = nodeEnrollServiceCmd(
    servicePlatform,
    issued.arch,
    issued.token,
    server,
    pem || undefined,
  );
  const cmd = (kind === "docker" ? dockerCmd : binCmd).trim();
  const hasCA = cmd.includes("BEGIN CERTIFICATE");

  return (
    <>
      <div role="status" className="mb-3 rounded-lg border border-line bg-paper-2 p-4">
        <p className="text-sm font-medium">
          {online ? "节点已上线，可以添加服务了" : "等待节点上线"}
        </p>
        <p className="mt-1 text-xs text-stone">
          {online
            ? "连接状态已自动确认，继续填写这台机器上的服务目标。"
            : "在节点执行下方命令，状态会自动更新。"}
        </p>
        {online ? (
          <Button asChild className="mt-3">
            <Link
              to="/nodes/$nodeId"
              params={{ nodeId: issued.id }}
              search={{ create: true }}
              onClick={onClose}
            >
              为此节点添加服务
            </Link>
          </Button>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-label="安装方式"
        className="mt-1 flex rounded-md bg-paper-2 p-0.5 shadow-border"
      >
        <button
          type="button"
          role="tab"
          aria-selected={kind === "docker"}
          className={`h-9 flex-1 rounded-sm px-2.5 text-sm font-medium ${
            kind === "docker" ? "bg-paper text-ink" : "text-stone hover:text-ink"
          }`}
          onClick={() => setKind("docker")}
        >
          Docker（推荐）
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "bin"}
          className={`h-9 flex-1 rounded-sm px-2.5 text-sm font-medium ${
            kind === "bin" ? "bg-paper text-ink" : "text-stone hover:text-ink"
          }`}
          onClick={() => setKind("bin")}
        >
          二进制服务
        </button>
      </div>
      <div className="mt-3 rounded-md bg-paper-2 p-4 shadow-border">
        <p className="text-sm font-medium text-ink">
          {kind === "docker" ? "Docker 一键命令已准备好" : "系统服务命令已准备好"}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-stone">
          {hasCA
            ? kind === "docker"
              ? "命令已包含入口 CA 和本次凭证，并会创建可自动重启的容器。"
              : "命令已包含入口 CA 和本次凭证，并会安装为开机自动启动的系统服务。"
            : "命令尚未包含入口 CA，请先下载 CA 并按命令提示放置。"}
        </p>
        <Button
          type="button"
          className="mt-3"
          onClick={() => {
            void navigator.clipboard.writeText(cmd);
            toast.success("一键命令已复制");
          }}
        >
          复制一键命令
        </Button>
      </div>

      <details className="mt-3 rounded-md bg-paper-2 shadow-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
          查看完整命令
        </summary>
        <pre className="max-h-64 overflow-y-auto border-t border-line whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-ink">
          {cmd}
        </pre>
      </details>

      <p className="mt-2 text-xs leading-relaxed text-stone">
        {kind === "docker"
          ? "host 网络让服务目标 127.0.0.1 指向节点本机。执行后回到节点列表等待心跳更新。"
          : issued.os === "windows"
            ? "请把对应的二进制放在当前目录，并在管理员 PowerShell 中执行；终端关闭后服务仍会运行。"
            : "请把对应的二进制放在当前目录后执行；命令会请求管理员权限，终端关闭后服务仍会运行。"}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!hasCA ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => window.open(caDownloadURL(), "_blank", "noopener")}
          >
            下载入口 CA
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          关闭
        </Button>
      </div>
    </>
  );
}
