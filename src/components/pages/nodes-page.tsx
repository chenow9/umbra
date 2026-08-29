"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { DemoButton } from "@/components/demo-button";
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
import { TextAreaField, TextField, SelectField } from "@/components/field";
import { Input } from "@/components/ui/input";
import {
  caDownloadURL,
  createNode,
  deleteNode,
  disconnectNode,
  helloNode,
  queryFrames,
  queryNodes,
  rotateNodeToken,
  revokeNode,
  updateNode,
} from "@/lib/umbra/api";
import { emptyPage, PAGE_SIZE } from "@/lib/umbra/page";
import { Pager } from "@/components/ui/pager";
import { formatBytes, formatBps, formatRelative } from "@/lib/umbra/format";
import { frameLabel } from "@/lib/umbra/labels";
import type { Node } from "@/lib/umbra/types";
import {
  ARCHS,
  PLATFORMS,
  nodeInstall,
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
  listen?: string;
  note?: string;
};
type Editor = { mode: "create" } | { mode: "edit"; node: Node };

export function NodesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [os, setOs] = useState("all");
  const [page, setPage] = useState(1);
  const [framePage, setFramePage] = useState(1);
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
  const frames = useQuery({
    queryKey: ["umbra", "frames", "page", { page: framePage, size: PAGE_SIZE }],
    queryFn: () => queryFrames({ page: framePage, size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const pageData = nodes.data ?? emptyPage<Node>(page);
  const list = pageData.items;
  const empty = !nodes.isLoading && pageData.total === 0 && !q && status === "all" && os === "all";
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

  return (
    <AppShell
      title="节点"
      description="只签发凭证。映射、模式、ACL 都在服务端改。"
      action={
        empty ? null : (
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            登记节点
          </Button>
        )
      }
    >
      {empty ? (
        <EmptyNodes onCreate={() => setEditor({ mode: "create" })} />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称、备注、地址"
                aria-label="搜索节点"
                className="max-w-sm"
              />
              <SelectField
                label="状态"
                className="w-36"
                value={status}
                onValueChange={setStatus}
                options={[
                  { value: "all", label: "全部状态" },
                  { value: "online", label: "在线" },
                  { value: "offline", label: "离线" },
                  { value: "revoked", label: "已吊销" },
                ]}
              />
              <SelectField
                label="系统"
                className="w-36"
                value={os}
                onValueChange={setOs}
                options={[
                  { value: "all", label: "全部系统" },
                  { value: "linux", label: "Linux" },
                  { value: "darwin", label: "macOS" },
                  { value: "windows", label: "Windows" },
                ]}
              />
            </div>
          </div>

          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-8 text-center text-sm text-stone shadow-border">
              没有匹配的节点。
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 md:hidden">
                {list.map((a) => (
                  <NodeCard
                    key={a.id}
                    node={a}
                    onEdit={() => setEditor({ mode: "edit", node: a })}
                    onDelete={() => setPendingDelete(a)}
                    onIssued={setIssued}
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-stone">
                      <th className="px-4 py-3 font-medium">名称</th>
                      <th className="px-4 py-3 font-medium">状态</th>
                      <th className="px-4 py-3 font-medium">地址</th>
                      <th className="px-4 py-3 font-medium">映射</th>
                      <th className="px-4 py-3 font-medium">流量</th>
                      <th className="px-4 py-3 font-medium">心跳</th>
                      <th className="px-4 py-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((a) => (
                      <NodeRow
                        key={a.id}
                        node={a}
                        onEdit={() => setEditor({ mode: "edit", node: a })}
                        onDelete={() => setPendingDelete(a)}
                        onIssued={setIssued}
                      />
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

      {(frames.data?.total ?? 0) > 0 ? (
        <details className="mt-8 rounded-xl bg-card shadow-border open:pb-1">
          <summary className="cursor-pointer px-4 py-3 text-sm text-ink-soft">
            控制通道 · {frames.data?.total ?? 0} 帧
          </summary>
          <p className="px-4 pb-2 text-xs leading-relaxed text-stone">
            上线走 Hello / HelloOk 全量对齐；改映射只 push MappingSync。
          </p>
          <ol className="divide-y divide-line text-xs">
            {(frames.data?.items ?? []).map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="w-10 shrink-0 text-stone">{f.dir === "s2c" ? "S→C" : "C→S"}</span>
                <span className="w-20 shrink-0 text-ink">{frameLabel[f.type] ?? f.type}</span>
                <span className="hidden w-16 shrink-0 truncate text-stone sm:inline">
                  {f.nodeName}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{f.body}</span>
              </li>
            ))}
          </ol>
          <div className="px-4 pb-3">
            <Pager
              page={frames.data?.page ?? framePage}
              size={frames.data?.size ?? PAGE_SIZE}
              total={frames.data?.total ?? 0}
              onPage={setFramePage}
            />
          </div>
        </details>
      ) : null}

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
        title={pendingDelete?.mappingCount ? "删除节点及其映射" : "删除节点"}
        description={
          pendingDelete?.mappingCount
            ? `「${pendingDelete.name}」下还有 ${pendingDelete.mappingCount} 条映射，将一并删除并吊销凭证。`
            : `删除「${pendingDelete?.name ?? ""}」并吊销凭证。此操作不能恢复。`
        }
        confirmLabel="删除"
        danger
        pending={remove.isPending}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />
    </AppShell>
  );
}

function EmptyNodes({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 py-8">
      <div>
        <h2 className="font-serif text-3xl italic tracking-tight text-ink">先登记一台节点</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          凭证只显示一次。之后映射都在服务端改，不用再登录那台机器。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onCreate}>
          登记节点
        </Button>
        <DemoButton variant="outline" size="default" label="跑一遍演示" />
      </div>
    </div>
  );
}

function statusLabel(status: Node["status"]) {
  return status === "online" ? "在线" : status === "revoked" ? "已吊销" : "离线";
}

function trafficLine(node: Node) {
  const total = formatBytes(node.bytesIn + node.bytesOut);
  const rate = (node.bpsIn ?? 0) + (node.bpsOut ?? 0);
  return rate > 0 ? `${total} · ${formatBps(rate)}` : total;
}

function NodeCard({
  node,
  onEdit,
  onDelete,
  onIssued,
}: {
  node: Node;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: Issued) => void;
}) {
  return (
    <article className="rounded-xl bg-card p-4 shadow-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{node.name}</p>
          <p className="mt-0.5 text-xs text-stone">{platformLabel(node.os, node.arch)}</p>
          {node.comment ? <p className="mt-0.5 text-xs text-stone">{node.comment}</p> : null}
        </div>
        <StatusDot status={node.status} label={statusLabel(node.status)} />
      </div>
      <p className="mt-3 font-mono text-xs text-ink-soft">
        {node.addr ?? "未连接"} · {node.mappingCount} 映射 · {trafficLine(node)}
      </p>
      <p className="mt-1 text-xs text-stone">{formatRelative(node.lastSeen)}</p>
      <div className="mt-3 flex justify-end">
        <NodeMenu node={node} onEdit={onEdit} onDelete={onDelete} onIssued={onIssued} />
      </div>
    </article>
  );
}

function NodeRow({
  node,
  onEdit,
  onDelete,
  onIssued,
}: {
  node: Node;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: Issued) => void;
}) {
  return (
    <tr className="border-b border-line/70 last:border-0 hover:bg-paper-2/50">
      <td className="px-4 py-3">
        <div className="font-medium">{node.name}</div>
        <div className="text-xs text-stone">{platformLabel(node.os, node.arch)}</div>
        {node.comment ? <div className="text-xs text-stone">{node.comment}</div> : null}
      </td>
      <td className="px-4 py-3">
        <StatusDot status={node.status} label={statusLabel(node.status)} />
      </td>
      <td className="px-4 py-3 font-mono text-xs text-ink-soft">{node.addr ?? "—"}</td>
      <td className="px-4 py-3 font-mono tabular-nums">{node.mappingCount}</td>
      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-soft">
        {trafficLine(node)}
      </td>
      <td className="px-4 py-3 text-xs text-stone">
        {formatRelative(node.lastSeen)}
        {node.tokenExpiresAt ? <div>凭证 {formatRelative(node.tokenExpiresAt)} 到期</div> : null}
      </td>
      <td className="px-4 py-3 text-right">
        <NodeMenu node={node} onEdit={onEdit} onDelete={onDelete} onIssued={onIssued} />
      </td>
    </tr>
  );
}

function NodeMenu({
  node,
  onEdit,
  onDelete,
  onIssued,
}: {
  node: Node;
  onEdit: () => void;
  onDelete: () => void;
  onIssued?: (v: Issued) => void;
}) {
  const qc = useQueryClient();
  const hello = useMutation({
    mutationFn: () => helloNode({ data: { id: node.id } }),
    onMutate: () => toast.loading("正在上线…", { id: `hello-${node.id}` }),
    onSuccess: () => {
      toast.success("已 Hello，映射全量下发并 Ack", { id: `hello-${node.id}` });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message, { id: `hello-${node.id}` }),
  });
  const bye = useMutation({
    mutationFn: () => disconnectNode({ data: { id: node.id } }),
    onSuccess: () => {
      toast.message("节点已离线，映射等待重连");
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
          onSelect: () => {
            if (!window.confirm("轮换后请立刻把新凭证写到节点。旧凭证大约 90 秒内仍可用。")) return;
            void rotateNodeToken({ data: { id: node.id } })
              .then((r) => {
                toast.success(`新凭证已签发，旧凭证宽限 ${r.graceSec} 秒`);
                onIssued?.({
                  id: node.id,
                  token: r.token,
                  os: (node.os as Platform) || "linux",
                  arch: (node.arch as Arch) || "amd64",
                  installCmd: r.installCmd,
                  listen: r.listen,
                  note: `旧凭证宽限 ${r.graceSec} 秒`,
                });
              })
              .catch((e: Error) => toast.error(e.message));
          },
        },
        {
          label: "下载 CA",
          onSelect: () => {
            window.open(caDownloadURL(), "_blank", "noopener");
          },
        },
        {
          label: hello.isPending ? "握手中…" : "本机上线",
          hidden: node.status === "revoked" || node.status === "online",
          disabled: hello.isPending,
          onSelect: () => hello.mutate(),
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
  const create = useMutation({
    mutationFn: () => createNode({ data: { name, comment, os, arch } }),
    onSuccess: (res) => {
      toast.success("凭证已签发，请复制保存", { id: "create-node" });
      onIssued({
        id: res.id,
        token: res.token,
        os,
        arch,
        installCmd: res.installCmd,
        listen: res.listen,
      });
    },
    onError: (e: Error) => toast.error(e.message, { id: "create-node" }),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>登记节点</SheetTitle>
        <SheetDescription>只生成凭证。不要在客户端写映射。</SheetDescription>
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
        </SheetBody>
        <SheetFooter className="flex items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {name.trim() ? "凭证只显示一次，请及时保存。" : "填写名称后即可签发。"}
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
  const save = useMutation({
    mutationFn: () => updateNode({ data: { id: node.id, name, comment, os, arch } }),
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
  const qc = useQueryClient();
  const hello = useMutation({
    mutationFn: () => helloNode({ data: { id: issued!.id } }),
    onMutate: () => toast.loading("正在上线…", { id: "hello-new" }),
    onSuccess: () => {
      toast.success("已上线，映射会立刻下发", { id: "hello-new" });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message, { id: "hello-new" }),
  });
  const installCmd = issued ? nodeInstall(issued.os, issued.arch, issued.token) : "";

  return (
    <Dialog open={issued !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>把凭证放到内网节点上</DialogTitle>
          <DialogDescription>
            这串 token 只显示一次。之后只能轮换。先下载 CA，再在节点上执行命令。
            {issued?.listen?.startsWith("127.0.0.1")
              ? " 命令里的 127.0.0.1 请换成节点能连上的入口地址。"
              : ""}
            {issued?.note ? ` ${issued.note}` : ""}
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <>
            <p className="mt-2 text-xs font-medium text-stone">UMBRA_TOKEN</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink">
              {issued.token}
            </pre>
            <pre className="mt-3 max-h-44 overflow-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink">
              {(issued.installCmd || installCmd).trim()}
            </pre>
            <p className="mt-2 text-xs text-stone">
              把 ca.crt 放到节点的 /etc/umbra/ca.crt 后执行上面的命令。看到心跳「刚刚」即上线。
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => window.open(caDownloadURL(), "_blank", "noopener")}
              >
                下载 CA
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.token);
                  toast.success("凭证已复制");
                }}
              >
                复制凭证
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.installCmd || installCmd);
                  toast.success("已复制安装命令");
                }}
              >
                复制安装命令
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                稍后再上线
              </Button>
              <Button type="button" onClick={() => hello.mutate()} disabled={hello.isPending}>
                {hello.isPending ? "正在上线…" : "本机演示上线"}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
