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
  createAgent,
  disconnectAgent,
  helloAgent,
  listAgents,
  listFrames,
  revokeAgent,
} from "@/lib/umbra/api";
import { formatBytes, formatRelative } from "@/lib/umbra/format";
import { frameLabel } from "@/lib/umbra/labels";
import type { Agent } from "@/lib/umbra/types";
import { ARCHS, PLATFORMS, agentInstall, platformLabel, type Arch, type Platform } from "@/lib/umbra/units";

export function AgentsPage() {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["umbra", "agents"], queryFn: () => listAgents() });
  const frames = useQuery({ queryKey: ["umbra", "frames"], queryFn: () => listFrames() });
  const [composing, setComposing] = useState(false);
  const list = agents.data ?? [];
  const empty = !agents.isLoading && list.length === 0;
  const showForm = composing || empty;

  return (
    <AppShell
      title="节点"
      action={
        empty ? null : (
          <Button type="button" onClick={() => setComposing((v) => !v)}>
            {composing ? "收起" : "登记节点"}
          </Button>
        )
      }
    >
      {empty ? (
        <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
          <NewAgentPanel
            onCreated={() => {
              setComposing(true);
              void qc.invalidateQueries({ queryKey: ["umbra"] });
            }}
            onClose={() => setComposing(false)}
            allowCancel={false}
          />
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs text-stone">还没有节点时，也可以先在本机跑通一遍。</p>
            <DemoButton variant="outline" size="default" label="跑一遍演示" />
          </div>
        </div>
      ) : (
        <>
          {showForm ? (
            <NewAgentPanel
              onCreated={() => {
                setComposing(true);
                void qc.invalidateQueries({ queryKey: ["umbra"] });
              }}
              onClose={() => setComposing(false)}
              allowCancel
            />
          ) : null}
          <div className="flex flex-col gap-3 md:hidden">
            {list.map((a) => (
              <AgentCard key={a.id} agent={a} />
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
                  <AgentRow key={a.id} agent={a} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
                <span className="hidden w-16 shrink-0 truncate text-stone sm:inline">{f.agentName}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-ink-soft">{f.body}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </AppShell>
  );
}

function AgentActions({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const hello = useMutation({
    mutationFn: () => helloAgent({ data: { id: agent.id } }),
    onMutate: () => toast.loading("正在上线…", { id: `hello-${agent.id}` }),
    onSuccess: () => {
      toast.success("已 Hello，映射全量下发并 Ack", { id: `hello-${agent.id}` });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message, { id: `hello-${agent.id}` }),
  });
  const bye = useMutation({
    mutationFn: () => disconnectAgent({ data: { id: agent.id } }),
    onSuccess: () => {
      toast.message("节点已离线，映射等待重连");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => revokeAgent({ data: { id: agent.id } }),
    onSuccess: () => {
      toast.message("凭证已吊销");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {agent.status !== "revoked" && agent.status !== "online" ? (
        <Button size="sm" variant="outline" onClick={() => hello.mutate()} disabled={hello.isPending}>
          {hello.isPending ? "握手中…" : "上线"}
        </Button>
      ) : null}
      {agent.status === "online" ? (
        <Button size="sm" variant="ghost" onClick={() => bye.mutate()} disabled={bye.isPending}>
          断开
        </Button>
      ) : null}
      {agent.status !== "revoked" ? (
        <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
          吊销
        </Button>
      ) : null}
    </div>
  );
}

function statusLabel(status: Agent["status"]) {
  return status === "online" ? "在线" : status === "revoked" ? "已吊销" : "离线";
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <article className="rounded-xl bg-card p-4 shadow-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{agent.name}</p>
          <p className="mt-0.5 text-xs text-stone">{platformLabel(agent.os, agent.arch)}</p>
          {agent.comment ? <p className="mt-0.5 text-xs text-stone">{agent.comment}</p> : null}
        </div>
        <StatusDot status={agent.status} label={statusLabel(agent.status)} />
      </div>
      <p className="mt-3 font-mono text-xs text-ink-soft">
        {agent.addr ?? "未连接"} · {agent.mappingCount} 映射 · {formatBytes(agent.bytesIn + agent.bytesOut)}
      </p>
      <p className="mt-1 text-xs text-stone">{formatRelative(agent.lastSeen)}</p>
      <div className="mt-3">
        <AgentActions agent={agent} />
      </div>
    </article>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{agent.name}</div>
        <div className="text-xs text-stone">{platformLabel(agent.os, agent.arch)}</div>
        {agent.comment ? <div className="text-xs text-stone">{agent.comment}</div> : null}
      </td>
      <td className="px-4 py-3">
        <StatusDot status={agent.status} label={statusLabel(agent.status)} />
      </td>
      <td className="px-4 py-3 font-mono text-xs text-ink-soft">{agent.addr ?? "—"}</td>
      <td className="px-4 py-3 font-mono tabular-nums">{agent.mappingCount}</td>
      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-soft">
        {formatBytes(agent.bytesIn + agent.bytesOut)}
      </td>
      <td className="px-4 py-3 text-xs text-stone">{formatRelative(agent.lastSeen)}</td>
      <td className="px-4 py-3">
        <AgentActions agent={agent} />
      </td>
    </tr>
  );
}

function NewAgentPanel({
  onCreated,
  onClose,
  allowCancel,
}: {
  onCreated: () => void;
  onClose: () => void;
  allowCancel: boolean;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [os, setOs] = useState<Platform>("linux");
  const [arch, setArch] = useState<Arch>("amd64");
  const [issued, setIssued] = useState<{
    id: string;
    token: string;
    installCmd: string;
  } | null>(null);

  const create = useMutation({
    mutationFn: () => createAgent({ data: { name, comment, os, arch } }),
    onSuccess: (res) => {
      toast.success("凭证已签发", { id: "create-agent" });
      setIssued({
        id: res.id,
        token: res.token,
        installCmd: agentInstall(os, arch, res.token),
      });
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message, { id: "create-agent" }),
  });

  const hello = useMutation({
    mutationFn: () => helloAgent({ data: { id: issued!.id } }),
    onMutate: () => toast.loading("正在上线…", { id: "hello-new" }),
    onSuccess: () => {
      toast.success("已上线，映射会立刻下发", { id: "hello-new" });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message, { id: "hello-new" }),
  });

  return (
    <section className="mb-8 w-full rounded-xl bg-card p-6 shadow-border sm:p-7">
      {issued ? (
        <>
          <h2 className="text-base font-medium text-ink">安装命令只显示这一次</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone">
            真机只带入口和凭证。映射永远在服务端改。预览可直接上线。
          </p>
          <pre className="mt-4 max-h-56 overflow-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink">
            {issued.installCmd.trim()}
          </pre>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(issued.installCmd);
                toast.success("已复制");
              }}
            >
              复制
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              稍后再上线
            </Button>
            <Button type="button" onClick={() => hello.mutate()} disabled={hello.isPending} aria-busy={hello.isPending}>
              {hello.isPending ? "正在上线…" : "完成并上线"}
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
              toast.loading("正在登记…", { id: "create-agent" });
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
