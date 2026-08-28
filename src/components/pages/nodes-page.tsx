"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { DemoButton } from "@/components/demo-button";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField, SelectField } from "@/components/field";
import {
  createNode,
  disconnectNode,
  rotateNodeToken,
  helloNode,
  listNodes,
  listFrames,
  revokeNode,
} from "@/lib/umbra/api";
import { formatBytes, formatRelative } from "@/lib/umbra/format";
import { frameLabel } from "@/lib/umbra/labels";
import type { Node } from "@/lib/umbra/types";
import { ARCHS, PLATFORMS, nodeInstall, platformLabel, type Arch, type Platform } from "@/lib/umbra/units";

type Issued = { id: string; token: string; os: Platform; arch: Arch };

export function NodesPage() {
  const qc = useQueryClient();
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const frames = useQuery({ queryKey: ["umbra", "frames"], queryFn: () => listFrames() });
  const [composing, setComposing] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const list = nodes.data ?? [];
  const empty = !nodes.isLoading && list.length === 0;
  const showForm = composing || empty || issued !== null;

  function closeForm() {
    setComposing(false);
    setIssued(null);
    void qc.invalidateQueries({ queryKey: ["umbra"] });
  }

  return (
    <AppShell
      title="节点"
      action={
        empty && !issued ? null : (
          <Button
            type="button"
            onClick={() => {
              if (showForm) closeForm();
              else setComposing(true);
            }}
          >
            {showForm ? "收起" : "登记节点"}
          </Button>
        )
      }
    >
      {showForm ? (
        <div className={empty && !issued ? "mx-auto mb-8 flex w-full max-w-xl flex-col gap-8" : undefined}>
          <NewNodePanel
            issued={issued}
            onIssued={setIssued}
            onClose={closeForm}
            allowCancel={!empty || issued !== null}
          />
          {empty && !issued ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-stone">还没有节点时，也可以先在本机跑通一遍。</p>
              <DemoButton variant="outline" size="default" label="跑一遍演示" />
            </div>
          ) : null}
        </div>
      ) : null}

      {!empty ? (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {list.map((a) => (
              <NodeCard key={a.id} node={a} />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
            <table className="w-full min-w-[640px] text-left text-sm">
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
                  <NodeRow key={a.id} node={a} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {(frames.data ?? []).length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-ink-soft">控制通道</h2>
          <p className="mb-3 max-w-xl text-xs leading-relaxed text-stone">
            上线走 Hello / HelloOk 全量对齐；改映射只 push MappingSync。
          </p>
          <ol className="divide-y divide-line overflow-hidden rounded-xl bg-card text-xs shadow-border">
            {(frames.data ?? []).slice(0, 24).map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="w-10 shrink-0 text-stone">{f.dir === "s2c" ? "S→C" : "C→S"}</span>
                <span className="w-20 shrink-0 text-ink">{frameLabel[f.type] ?? f.type}</span>
                <span className="hidden w-16 shrink-0 truncate text-stone sm:inline">{f.nodeName}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{f.body}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </AppShell>
  );
}

function NodeActions({ node }: { node: Node }) {
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
    <div className="flex flex-wrap justify-end gap-1">
      {node.status !== "revoked" ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!window.confirm("轮换后请立刻把新凭证写到节点。旧凭证大约 90 秒内仍可用。")) {
              return;
            }
            void rotateNodeToken({ data: { id: node.id } })
              .then((r) => navigator.clipboard.writeText(r.token).then(() => r))
              .then((r) => toast.success(`新凭证已复制，旧凭证宽限 ${r.graceSec} 秒`))
              .catch((e: Error) => toast.error(e.message));
          }}
        >
          轮换凭证
        </Button>
      ) : null}
      {node.status !== "revoked" && node.status !== "online" ? (
        <Button size="sm" variant="outline" onClick={() => hello.mutate()} disabled={hello.isPending}>
          {hello.isPending ? "握手中…" : "上线"}
        </Button>
      ) : null}
      {node.status === "online" ? (
        <Button size="sm" variant="ghost" onClick={() => bye.mutate()} disabled={bye.isPending}>
          断开
        </Button>
      ) : null}
      {node.status !== "revoked" ? (
        <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
          吊销
        </Button>
      ) : null}
    </div>
  );
}

function statusLabel(status: Node["status"]) {
  return status === "online" ? "在线" : status === "revoked" ? "已吊销" : "离线";
}

function NodeCard({ node }: { node: Node }) {
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
        {node.addr ?? "未连接"} · {node.mappingCount} 映射 · {formatBytes(node.bytesIn + node.bytesOut)}
      </p>
      <p className="mt-1 text-xs text-stone">{formatRelative(node.lastSeen)}</p>
      {node.tokenExpiresAt ? (
        <p className="mt-1 text-xs text-stone">凭证 {formatRelative(node.tokenExpiresAt)} 到期</p>
      ) : null}
      <div className="mt-3">
        <NodeActions node={node} />
      </div>
    </article>
  );
}

function NodeRow({ node }: { node: Node }) {
  return (
    <tr className="border-b border-line/70 last:border-0">
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
        {formatBytes(node.bytesIn + node.bytesOut)}
      </td>
      <td className="px-4 py-3 text-xs text-stone">
        {formatRelative(node.lastSeen)}
        {node.tokenExpiresAt ? (
          <div>凭证 {formatRelative(node.tokenExpiresAt)} 到期</div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <NodeActions node={node} />
      </td>
    </tr>
  );
}

function NewNodePanel({
  issued,
  onIssued,
  onClose,
  allowCancel,
}: {
  issued: Issued | null;
  onIssued: (v: Issued) => void;
  onClose: () => void;
  allowCancel: boolean;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [os, setOs] = useState<Platform>("linux");
  const [arch, setArch] = useState<Arch>("amd64");

  const create = useMutation({
    mutationFn: () => createNode({ data: { name, comment, os, arch } }),
    onSuccess: (res) => {
      toast.success("凭证已签发，请复制保存", { id: "create-node" });
      onIssued({ id: res.id, token: res.token, os, arch });
    },
    onError: (e: Error) => toast.error(e.message, { id: "create-node" }),
  });

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
    <section className="mb-8 w-full rounded-xl bg-card p-6 shadow-border sm:p-7">
      {issued ? (
        <>
          <h2 className="text-base font-medium text-ink">把凭证放到内网节点上</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone">
            这串 token 只显示一次，请马上复制到节点。之后只能轮换，不能再从控制台读出旧凭证。「本机演示上线」只在入口这台机器上拉节点进程。
          </p>
          <p className="mt-4 text-xs font-medium text-stone">UMBRA_TOKEN</p>
          <pre className="mt-1 overflow-x-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink">
            {issued.token}
          </pre>
          <pre className="mt-3 max-h-56 overflow-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink">
            {installCmd.trim()}
          </pre>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
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
                void navigator.clipboard.writeText(installCmd);
                toast.success("已复制安装命令");
              }}
            >
              复制安装命令
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              稍后再上线
            </Button>
            <Button type="button" onClick={() => hello.mutate()} disabled={hello.isPending} aria-busy={hello.isPending}>
              {hello.isPending ? "正在上线…" : "本机演示上线"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <h2 className="text-base font-medium text-ink">登记节点</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone">只生成凭证。不要在客户端写映射。</p>
          <form
            className="mt-4 flex flex-col gap-3"
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
            <div className="mt-1 flex justify-end gap-2">
              {allowCancel ? (
                <Button type="button" variant="ghost" onClick={onClose}>
                  取消
                </Button>
              ) : null}
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "登记中…" : "登记"}
              </Button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
