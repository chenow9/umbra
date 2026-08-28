"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { SelectField, TextField } from "@/components/field";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import {
  createMapping,
  deleteMapping,
  issueVisitor,
  knockMapping,
  listNodes,
  listMappings,
  probeMapping,
  setMappingEnabled,
  visitMapping,
} from "@/lib/umbra/api";
import { formatBytes, formatPort, formatRelative } from "@/lib/umbra/format";
import { listenLabel, modeLabel, pushLabel } from "@/lib/umbra/labels";
import { ECHO_PORT } from "@/lib/umbra/protocol";
import type { Mapping, MappingMode, Proto } from "@/lib/umbra/types";

export function MappingsPage() {
  const qc = useQueryClient();
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: () => listMappings() });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const [composing, setComposing] = useState(false);
  const hasNode = (nodes.data ?? []).some((a) => a.status !== "revoked");
  const list = mappings.data ?? [];
  const empty = !mappings.isLoading && list.length === 0;
  const showForm = hasNode && (composing || empty);

  return (
    <AppShell
      title="映射"
      action={
        hasNode && !empty ? (
          <Button type="button" onClick={() => setComposing((v) => !v)}>
            {composing ? "收起" : "新建映射"}
          </Button>
        ) : null
      }
    >
      {!hasNode ? (
        <p className="max-w-md text-sm leading-relaxed text-ink-soft">
          先登记一台节点，才能把映射下发到它。
        </p>
      ) : null}

      {showForm ? (
        <NewMappingPanel
          onCreated={() => {
            setComposing(false);
            void qc.invalidateQueries({ queryKey: ["umbra"] });
          }}
          onClose={() => setComposing(false)}
          allowCancel={!empty}
        />
      ) : null}

      {hasNode && !empty ? (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {list.map((m) => (
              <MappingCard key={m.id} mapping={m} />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-stone">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">节点</th>
                  <th className="px-4 py-3 font-medium">协议</th>
                  <th className="px-4 py-3 font-medium">模式</th>
                  <th className="px-4 py-3 font-medium">入口</th>
                  <th className="px-4 py-3 font-medium">目标</th>
                  <th className="px-4 py-3 font-medium">下发</th>
                  <th className="px-4 py-3 font-medium">流量</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <MappingRow key={m.id} mapping={m} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </AppShell>
  );
}

function MappingActions({ mapping: m }: { mapping: Mapping }) {
  const qc = useQueryClient();
  const granted = m.grantUntil ? new Date(m.grantUntil).getTime() > Date.now() : false;
  const probe = useMutation({
    mutationFn: () => probeMapping({ data: { id: m.id } }),
    onMutate: () => toast.loading("正在探测…", { id: `probe-${m.id}` }),
    onSuccess: (r) => {
      toast.success(`探测成功 · 入 ${r.bytesIn}B / 出 ${r.bytesOut}B`, { id: `probe-${m.id}` });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message, { id: `probe-${m.id}` }),
  });
  const knock = useMutation({
    mutationFn: () => knockMapping({ data: { id: m.id } }),
    onMutate: () => toast.loading("正在敲门…", { id: `knock-${m.id}` }),
    onSuccess: () => {
      toast.success("已放行 60 秒", { id: `knock-${m.id}` });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message, { id: `knock-${m.id}` }),
  });
  const visit = useMutation({
    mutationFn: () => visitMapping({ data: { id: m.id } }),
    onSuccess: (r) => {
      toast.success(`探访成功 · ${r.bytesIn}B`);
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const issue = useMutation({
    mutationFn: () => issueVisitor({ data: { id: m.id } }),
    onSuccess: (r) => {
      void navigator.clipboard.writeText(r.visitCmd).catch(() => undefined);
      toast.success("访客命令已复制，只显示这一次。本机 L4 监听，不走 HTTP。");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: () => setMappingEnabled({ data: { id: m.id, enabled: !m.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["umbra"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteMapping({ data: { id: m.id } }),
    onSuccess: () => {
      toast.message("映射已删除，其它端口不受影响");
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const live = m.enabled && m.nodeStatus === "online";

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {live && m.mode === "spa" ? (
        <Button size="sm" variant="outline" onClick={() => knock.mutate()} disabled={knock.isPending}>
          {knock.isPending ? "敲门中…" : granted ? "再敲门" : "敲门"}
        </Button>
      ) : null}
      {live && m.mode !== "visitor" ? (
        <Button size="sm" variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
          {probe.isPending ? "探测中…" : "探测"}
        </Button>
      ) : null}
      {live && m.mode === "visitor" ? (
        <>
          <Button size="sm" variant="outline" onClick={() => issue.mutate()} disabled={issue.isPending}>
            {issue.isPending ? "签发中…" : "签发访客"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => visit.mutate()} disabled={visit.isPending}>
            {visit.isPending ? "探访中…" : "探访"}
          </Button>
        </>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
        {m.enabled ? "停用" : "启用"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
        删除
      </Button>
    </div>
  );
}

function stealthNote(m: Mapping) {
  const bits: string[] = [];
  if (m.mode === "visitor") bits.push("无公网入口");
  else if (m.mode === "public") bits.push("公开监听");
  else if (m.grantUntil && new Date(m.grantUntil).getTime() > Date.now()) {
    const sec = Math.max(1, Math.round((new Date(m.grantUntil).getTime() - Date.now()) / 1000));
    bits.push(`已授权 ${sec}s`);
  } else bits.push("未授权丢包");
  if (m.allowCidrs) bits.push(m.allowCidrs);
  if (m.maxConns !== 64) bits.push(`${m.maxConns} 路`);
  if (m.rateKbps) bits.push(`${m.rateKbps} KB/s`);
  return bits.join(" · ");
}

function ProbeNote({ mapping: m }: { mapping: Mapping }) {
  return (
    <p className="mt-2 text-xs text-ink-soft">
      {stealthNote(m)}
      {m.lastProbeAt ? ` · 上次探测 ${formatRelative(m.lastProbeAt)}` : ""}
    </p>
  );
}

function MappingCard({ mapping: m }: { mapping: Mapping }) {
  return (
    <article className="rounded-xl bg-card p-4 shadow-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{m.name}</p>
          <p className="mt-0.5 text-xs text-stone">
            {m.nodeName} · {m.proto.toUpperCase()} · {modeLabel[m.mode]}
          </p>
        </div>
        <StatusDot status={m.listenState} label={listenLabel[m.listenState] ?? m.listenState} />
      </div>
      <p className="mt-3 font-mono text-xs text-ink-soft">
        {formatPort(m.entryPort, m.mode)} → {m.localHost}:{m.localPort}
      </p>
      <p className="mt-1 text-xs text-stone">
        {pushLabel[m.pushState] ?? m.pushState} · 入 {formatBytes(m.bytesIn)} / 出 {formatBytes(m.bytesOut)}
        {m.proto === "udp" ? ` · udp_active ${m.udpActive ?? m.activeConns} · drop maxconns ${m.udpDropMaxConns ?? 0}` : ""}
      </p>
      {m.listenError ? <p className="mt-1 text-xs text-rose">{m.listenError}</p> : null}
      <ProbeNote mapping={m} />
      <div className="mt-3">
        <MappingActions mapping={m} />
      </div>
    </article>
  );
}

function MappingRow({ mapping: m }: { mapping: Mapping }) {
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-4 py-3">
        <div className="font-medium">{m.name}</div>
        <ProbeNote mapping={m} />
      </td>
      <td className="px-4 py-3 text-ink-soft">{m.nodeName}</td>
      <td className="px-4 py-3 font-mono text-xs uppercase">{m.proto}</td>
      <td className="px-4 py-3">{modeLabel[m.mode]}</td>
      <td className="px-4 py-3 font-mono tabular-nums">{formatPort(m.entryPort, m.mode)}</td>
      <td className="px-4 py-3 font-mono text-xs text-ink-soft">
        {m.localHost}:{m.localPort}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <StatusDot status={m.listenState} label={listenLabel[m.listenState] ?? m.listenState} />
          <span className="text-xs text-stone">{pushLabel[m.pushState] ?? m.pushState}</span>
          {m.listenError ? <span className="text-xs text-rose">{m.listenError}</span> : null}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-soft">
        入 {formatBytes(m.bytesIn)}
        <br />
        出 {formatBytes(m.bytesOut)}
        {m.proto === "udp" ? (
          <>
            <br />
            udp_active {m.udpActive ?? m.activeConns} · drop maxconns {m.udpDropMaxConns ?? 0}
          </>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <MappingActions mapping={m} />
      </td>
    </tr>
  );
}

function NewMappingPanel({
  onCreated,
  onClose,
  allowCancel,
}: {
  onCreated: () => void;
  onClose: () => void;
  allowCancel: boolean;
}) {
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const usable = (nodes.data ?? []).filter((a) => a.status !== "revoked");
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [proto, setProto] = useState<Proto>("tcp");
  const [mode, setMode] = useState<MappingMode>("spa");
  const [entryPort, setEntryPort] = useState("40222");
  const [localHost, setLocalHost] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState(String(ECHO_PORT));
  const [maxConns, setMaxConns] = useState("64");
  const [rateKbps, setRateKbps] = useState("0");
  const [allowCidrs, setAllowCidrs] = useState("");
  const selected = nodeId || usable[0]?.id || "";

  const create = useMutation({
    mutationFn: () =>
      createMapping({
        data: {
          nodeId: selected,
          name,
          proto,
          mode,
          entryPort: mode === "visitor" ? null : Number(entryPort),
          localHost,
          localPort: Number(localPort),
          maxConns: Number(maxConns) || 64,
          rateKbps: Number(rateKbps) || 0,
          allowCidrs,
        },
      }),
    onSuccess: (m) => {
      toast.success(
        m.pushState === "acked" ? (m.mode === "visitor" ? "已下发，无公网入口" : "已下发并监听") : "已保存，等待节点上线后下发",
      );
      setName("");
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="mb-8 w-full max-w-3xl rounded-xl bg-card p-6 shadow-border sm:p-7">
      <h2 className="text-base font-medium text-ink">新建映射</h2>
      <p className="mt-1 text-sm leading-relaxed text-stone">
        保存后立刻下发。暗端口默认丢包；公开口才会一直听。
      </p>
      <form
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !selected || create.isPending) return;
          create.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <TextField
            label="名称"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ssh"
          />
        </div>
        <div className="sm:col-span-2">
          <SelectField
            label="节点"
            value={selected}
            onValueChange={setNodeId}
            options={usable.map((a) => ({
              value: a.id,
              label: `${a.name}（${a.status === "online" ? "在线" : "离线"}）`,
            }))}
          />
        </div>
        <SelectField
          label="协议"
          value={proto}
          onValueChange={(v) => {
            const next = v as Proto;
            setProto(next);
            if (next === "udp" && mode === "public") setEntryPort("25565");
          }}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
          ]}
        />
        <SelectField
          label="模式"
          value={mode}
          onValueChange={(v) => {
            const next = v as MappingMode;
            setMode(next);
            if (next === "public" && proto === "udp") setEntryPort("25565");
            if (next === "spa" && entryPort === "25565") setEntryPort("40222");
          }}
          options={[
            { value: "spa", label: "暗端口（SPA）" },
            { value: "visitor", label: "访客（无公网端口）" },
            { value: "public", label: "公开" },
          ]}
        />
        {mode !== "visitor" ? (
          <TextField
            label="入口端口"
            inputMode="numeric"
            value={entryPort}
            onChange={(e) => setEntryPort(e.target.value)}
            required
          />
        ) : (
          <p className="self-end text-xs text-stone">访客模式不占用入口端口。</p>
        )}
        <TextField
          label="目标地址"
          value={localHost}
          onChange={(e) => setLocalHost(e.target.value)}
          required
        />
        <TextField
          label="目标端口"
          inputMode="numeric"
          value={localPort}
          onChange={(e) => setLocalPort(e.target.value)}
          required
        />
        <TextField
          label="最大连接"
          inputMode="numeric"
          value={maxConns}
          onChange={(e) => setMaxConns(e.target.value)}
        />
        <TextField
          label="限速 KB/s"
          inputMode="numeric"
          value={rateKbps}
          onChange={(e) => setRateKbps(e.target.value)}
          placeholder="0 不限制"
        />
        <div className="sm:col-span-2">
          <TextField
            label="允许网段"
            value={allowCidrs}
            onChange={(e) => setAllowCidrs(e.target.value)}
            placeholder="空则不限制，如 10.0.0.0/8"
          />
        </div>
        <div className="mt-1 flex justify-end gap-2 sm:col-span-2">
          {allowCancel ? (
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
          ) : null}
          <Button type="submit" disabled={!name.trim() || !selected || create.isPending}>
            {create.isPending ? "下发中…" : "保存并下发"}
          </Button>
        </div>
      </form>
    </section>
  );
}
