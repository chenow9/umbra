"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { FilterChips } from "@/components/filter-chips";
import { Input } from "@/components/ui/input";
import {
  caDownloadURL,
  createNode,
  deleteNode,
  disconnectNode,
  queryNodes,
  rotateNodeToken,
  revokeNode,
  updateNode,
} from "@/lib/umbra/api";
import { emptyPage, PAGE_SIZE } from "@/lib/umbra/page";
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const [pendingRotate, setPendingRotate] = useState<Node | null>(null);
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
      title="节点"
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
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称、备注、地址"
              aria-label="搜索节点"
              className="max-w-sm"
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <FilterChips
                label="状态"
                value={status}
                onChange={setStatus}
                always
                options={[
                  { value: "online", label: "在线" },
                  { value: "offline", label: "离线" },
                  { value: "revoked", label: "已吊销" },
                ]}
              />
              <FilterChips
                label="系统"
                value={os}
                onChange={setOs}
                always
                options={[
                  { value: "linux", label: "Linux" },
                  { value: "darwin", label: "macOS" },
                  { value: "windows", label: "Windows" },
                ]}
              />
              {status !== "all" || os !== "all" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setStatus("all");
                    setOs("all");
                  }}
                >
                  清除
                </Button>
              ) : null}
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
                    onRotate={() => setPendingRotate(a)}
                  />
                ))}
              </div>
              <div className="hidden overflow-hidden rounded-xl bg-card shadow-border md:block">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] table-fixed text-left text-sm">
                    <colgroup>
                      <col className="w-[16%]" />
                      <col className="w-[10%]" />
                      <col className="w-[16%]" />
                      <col className="w-[8%]" />
                      <col className="w-[20%]" />
                      <col className="w-[14%]" />
                      <col className="w-28" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-line text-xs text-stone">
                        <th className="px-4 py-3 font-medium">名称</th>
                        <th className="px-4 py-3 font-medium">状态</th>
                        <th className="px-4 py-3 font-medium">地址</th>
                        <th className="px-4 py-3 font-medium">映射</th>
                        <th className="px-4 py-3 font-medium">流量</th>
                        <th className="px-4 py-3 font-medium">心跳</th>
                        <th className="py-3 pr-5 pl-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((a) => (
                        <NodeRow
                          key={a.id}
                          node={a}
                          onEdit={() => setEditor({ mode: "edit", node: a })}
                          onDelete={() => setPendingDelete(a)}
                          onRotate={() => setPendingRotate(a)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
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

function tokenPolicyLine(node: Node) {
  if (node.status === "revoked") return null;
  if (node.tokenNoExpiry) return "凭证永不过期";
  if (node.tokenExpiresAt) return `凭证 ${formatRelative(node.tokenExpiresAt)} 到期`;
  return null;
}

function NodeCard({
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
  const tokenLine = tokenPolicyLine(node);
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
        {node.addr ?? "未连接"} ·{" "}
        <Link to="/mappings" search={{ node: node.id }} className="hover:text-ink">
          {node.mappingCount} 映射
        </Link>{" "}
        · {trafficLine(node)}
      </p>
      <p className="mt-1 text-xs text-stone">
        {formatRelative(node.lastSeen)}
        {tokenLine ? ` · ${tokenLine}` : null}
      </p>
      <div className="mt-3 flex justify-end gap-1">
        <NodeMappingsButton node={node} />
        <NodeMenu node={node} onEdit={onEdit} onDelete={onDelete} onRotate={onRotate} />
      </div>
    </article>
  );
}

function NodeRow({
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
  const tokenLine = tokenPolicyLine(node);
  return (
    <tr className="border-b border-line/70 last:border-0 hover:bg-paper-2/50">
      <td className="px-4 py-3 align-middle">
        <div className="truncate font-medium">{node.name}</div>
        <div className="truncate text-xs text-stone">{platformLabel(node.os, node.arch)}</div>
        {node.comment ? <div className="truncate text-xs text-stone">{node.comment}</div> : null}
      </td>
      <td className="truncate px-4 py-3 align-middle">
        <StatusDot status={node.status} label={statusLabel(node.status)} />
      </td>
      <td className="truncate px-4 py-3 align-middle font-mono text-xs whitespace-nowrap text-ink-soft">
        {node.addr ?? "—"}
      </td>
      <td className="px-4 py-3 align-middle font-mono tabular-nums">
        <Link to="/mappings" search={{ node: node.id }} className="hover:text-pine">
          {node.mappingCount}
        </Link>
      </td>
      <td className="truncate px-4 py-3 align-middle font-mono text-xs tabular-nums whitespace-nowrap text-ink-soft">
        {trafficLine(node)}
      </td>
      <td className="px-4 py-3 align-middle text-xs text-stone">
        <div className="truncate whitespace-nowrap">{formatRelative(node.lastSeen)}</div>
        {tokenLine ? <div className="truncate">{tokenLine}</div> : null}
      </td>
      <td className="py-3 pr-5 pl-2 align-middle text-right">
        <div className="flex items-center justify-end gap-1">
          <NodeMappingsButton node={node} />
          <NodeMenu node={node} onEdit={onEdit} onDelete={onDelete} onRotate={onRotate} />
        </div>
      </td>
    </tr>
  );
}

function NodeMappingsButton({ node }: { node: Node }) {
  return (
    <Button asChild size="sm" variant="outline">
      <Link to="/mappings" search={{ node: node.id }} aria-label={`查看 ${node.name} 的映射`}>
        映射
      </Link>
    </Button>
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
          ? "host 网络让映射目标 127.0.0.1 指向节点本机。执行后回到节点列表等待心跳更新。"
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
