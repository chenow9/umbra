"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { SelectField, TextField } from "@/components/field";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { ActionMenu } from "@/components/ui/menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  createMapping,
  deleteMapping,
  issueVisitor,
  knockMapping,
  listNodes,
  listTickets,
  queryMappings,
  probeMapping,
  revokeTicket,
  setMappingEnabled,
  updateMapping,
  visitMapping,
} from "@/lib/umbra/api";
import { formatBytes, formatBps, formatPort, formatRelative } from "@/lib/umbra/format";
import {
  dropReasonLabel,
  listenLabel,
  modeLabel,
  policyLine,
  pushLabel,
  reachLabel,
} from "@/lib/umbra/labels";
import { emptyPage, PAGE_SIZE } from "@/lib/umbra/page";
import { Pager } from "@/components/ui/pager";
import { ECHO_PORT } from "@/lib/umbra/protocol";
import type { Mapping, MappingMode, Proto, VisitorIssued, VisitorTicket } from "@/lib/umbra/types";
import { cn } from "@/lib/utils";

type Editor = { mode: "create" } | { mode: "edit"; mapping: Mapping };

export function MappingsPage() {
  const qc = useQueryClient();
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const [q, setQ] = useState("");
  const [nodeId, setNodeId] = useState("all");
  const [proto, setProto] = useState("all");
  const [mode, setMode] = useState("all");
  const [reach, setReach] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const query = {
    q: q.trim() || undefined,
    nodeId: nodeId === "all" ? undefined : nodeId,
    proto: proto === "all" ? undefined : proto,
    mode: mode === "all" ? undefined : mode,
    reach: reach === "all" ? undefined : reach,
    page,
    size: PAGE_SIZE,
  };
  const mappings = useQuery({
    queryKey: ["umbra", "mappings", "page", query],
    queryFn: () => queryMappings(query),
    placeholderData: keepPreviousData,
  });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Mapping | null>(null);
  const [issuedVisit, setIssuedVisit] = useState<VisitorIssued | null>(null);
  const hasNode = (nodes.data ?? []).some((a) => a.status !== "revoked");
  const pageData = mappings.data ?? emptyPage<Mapping>(page);
  const list = pageData.items;
  const activeFilterCount = [nodeId, proto, mode, reach].filter((value) => value !== "all").length;
  const empty =
    !mappings.isLoading &&
    pageData.total === 0 &&
    !q &&
    nodeId === "all" &&
    proto === "all" &&
    mode === "all" &&
    reach === "all";
  useEffect(() => {
    setPage(1);
  }, [q, nodeId, proto, mode, reach]);
  useEffect(() => {
    if (!mappings.data) return;
    const pages = Math.max(1, Math.ceil(mappings.data.total / mappings.data.size) || 1);
    if (page > pages) setPage(pages);
  }, [mappings.data, page]);

  const remove = useMutation({
    mutationFn: (m: Mapping) => deleteMapping({ data: { id: m.id } }),
    onSuccess: () => {
      toast.message("映射已删除，其它端口不受影响");
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AppShell
      title="映射"
      description="保存后立刻下发。不用登录节点改任何文件。"
      action={
        hasNode && !empty ? (
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            新建映射
          </Button>
        ) : null
      }
    >
      {!hasNode ? (
        <p className="max-w-md text-sm leading-relaxed text-ink-soft">
          先登记一台节点，才能把映射下发到它。
        </p>
      ) : empty ? (
        <div className="mx-auto flex max-w-md flex-col items-start gap-4 py-8">
          <h2 className="font-serif text-3xl italic tracking-tight text-ink">还没有映射</h2>
          <p className="text-sm leading-relaxed text-ink-soft">
            暗端口默认丢包；公开口才会一直听。访客模式不占用入口端口。
          </p>
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            新建映射
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
            <div className="flex min-w-0 gap-2 md:w-72">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称、节点、目标"
                aria-label="搜索映射"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 md:hidden"
                aria-expanded={filtersOpen}
                aria-controls="mapping-filters"
                onClick={() => setFiltersOpen((value) => !value)}
              >
                {filtersOpen ? "收起" : `筛选${activeFilterCount ? ` ${activeFilterCount}` : ""}`}
              </Button>
            </div>
            <div
              id="mapping-filters"
              className={cn(
                "grid grid-cols-2 gap-3 md:contents",
                filtersOpen ? "grid" : "hidden md:contents",
              )}
            >
              <SelectField
                label="节点"
                className="md:w-44"
                value={nodeId}
                onValueChange={setNodeId}
                options={[
                  { value: "all", label: "全部节点" },
                  ...(nodes.data ?? []).map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
              <SelectField
                label="协议"
                className="md:w-32"
                value={proto}
                onValueChange={setProto}
                options={[
                  { value: "all", label: "全部协议" },
                  { value: "tcp", label: "TCP" },
                  { value: "udp", label: "UDP" },
                ]}
              />
              <SelectField
                label="模式"
                className="md:w-36"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "all", label: "全部模式" },
                  { value: "public", label: "公开" },
                  { value: "spa", label: "暗端口" },
                  { value: "visitor", label: "访客" },
                ]}
              />
              <SelectField
                label="现在"
                className="md:w-44"
                value={reach}
                onValueChange={setReach}
                options={[
                  { value: "all", label: "全部状态" },
                  { value: "open", label: "外网可连" },
                  { value: "closed", label: "未敲门" },
                  { value: "full", label: "连接已满" },
                  { value: "offline", label: "节点离线" },
                  { value: "pending", label: "等待确认" },
                  { value: "error", label: "无法开流" },
                  { value: "disabled", label: "已停用" },
                ]}
              />
            </div>
            {activeFilterCount ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNodeId("all");
                  setProto("all");
                  setMode("all");
                  setReach("all");
                }}
              >
                清除筛选
              </Button>
            ) : null}
          </div>
          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-8 text-center text-sm text-stone shadow-border">
              没有匹配的映射。
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-3 md:hidden">
                {list.map((m) => (
                  <MappingCard
                    key={m.id}
                    mapping={m}
                    onEdit={() => setEditor({ mode: "edit", mapping: m })}
                    onDelete={() => setPendingDelete(m)}
                    onIssued={setIssuedVisit}
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-xl bg-card shadow-border md:block">
                <table className="w-full min-w-[880px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-stone">
                      <th className="px-4 py-3 font-medium">名称</th>
                      <th className="px-4 py-3 font-medium">节点</th>
                      <th className="px-4 py-3 font-medium">现在</th>
                      <th className="px-4 py-3 font-medium">入口</th>
                      <th className="px-4 py-3 font-medium">目标</th>
                      <th className="px-4 py-3 font-medium">配额</th>
                      <th className="px-4 py-3 font-medium">流量</th>
                      <th className="px-4 py-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => (
                      <MappingRow
                        key={m.id}
                        mapping={m}
                        onEdit={() => setEditor({ mode: "edit", mapping: m })}
                        onDelete={() => setPendingDelete(m)}
                        onIssued={setIssuedVisit}
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

      <Sheet open={editor !== null} onOpenChange={(v) => !v && setEditor(null)}>
        <SheetContent side="right">
          {editor ? (
            <MappingForm
              key={editor.mode === "edit" ? editor.mapping.id : "new"}
              mapping={editor.mode === "edit" ? editor.mapping : null}
              onDone={() => {
                setEditor(null);
                void qc.invalidateQueries({ queryKey: ["umbra"] });
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除映射"
        description={`删除「${pendingDelete?.name ?? ""}」后入口会释放端口，其它映射不受影响。`}
        confirmLabel="删除"
        danger
        pending={remove.isPending}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />

      <VisitorIssuedDialog issued={issuedVisit} onClose={() => setIssuedVisit(null)} />
    </AppShell>
  );
}

function trafficLine(m: Mapping) {
  const rate = (m.bpsIn ?? 0) + (m.bpsOut ?? 0);
  const base = `入 ${formatBytes(m.bytesIn)} / 出 ${formatBytes(m.bytesOut)}`;
  return rate > 0 ? `${base} · ${formatBps(rate)}` : base;
}

function stealthNote(m: Mapping) {
  const bits: string[] = [];
  bits.push(policyLine(m.maxConns, m.idleTimeoutSec, m.proto));
  if (m.allowCidrs) bits.push(m.allowCidrs);
  if (m.rateKbps) bits.push(`${m.rateKbps} KB/s`);
  const drops = dropLine(m);
  if (drops) bits.push(drops);
  return bits.join(" · ");
}

function dropLine(m: Mapping) {
  const n =
    (m.tcpDropMaxConns ?? 0) +
    (m.tcpDropAcl ?? 0) +
    (m.tcpDropSpa ?? 0) +
    (m.tcpDropOffline ?? 0) +
    (m.tcpDropTunnel ?? 0) +
    (m.tcpDropSplice ?? 0) +
    (m.udpDropMaxConns ?? 0) +
    (m.udpDropPerIP ?? 0) +
    (m.udpDropRate ?? 0);
  if (n <= 0) return "";
  const why = dropReasonLabel[m.lastDrop ?? ""] ?? m.lastDrop ?? "丢弃";
  return `丢弃 ${n}（${why}）`;
}

function reachTone(reach: string | undefined) {
  if (reach === "open" || reach === "visitor") return "online";
  if (reach === "error" || reach === "full") return "error";
  if (reach === "offline" || reach === "closed") return "offline";
  return "pending";
}

function ProbeNote({ mapping: m }: { mapping: Mapping }) {
  return (
    <p className="mt-1 text-xs text-ink-soft">
      {stealthNote(m)}
      {m.lastProbeAt ? ` · 上次探测 ${formatRelative(m.lastProbeAt)}` : ""}
    </p>
  );
}

function MappingCard({
  mapping: m,
  onEdit,
  onDelete,
  onIssued,
}: {
  mapping: Mapping;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: VisitorIssued) => void;
}) {
  return (
    <article className="rounded-xl bg-card p-4 shadow-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{m.name}</p>
          <p className="mt-0.5 text-xs text-stone">
            {m.nodeName} · {m.proto.toUpperCase()} · {modeLabel[m.mode]}
          </p>
        </div>
        <StatusDot
          status={reachTone(m.reach)}
          label={reachLabel[m.reach ?? ""] ?? listenLabel[m.listenState] ?? m.listenState}
        />
      </div>
      <p className="mt-3 font-mono text-xs text-ink-soft">
        {formatPort(m.entryPort, m.mode)} → {m.localHost}:{m.localPort}
      </p>
      <p className="mt-1 text-xs text-stone">
        {pushLabel[m.pushState] ?? m.pushState} · {trafficLine(m)}
        {m.proto === "udp" ? ` · UDP 活跃会话 ${m.udpActive ?? m.activeConns}` : ""}
      </p>
      {m.listenError ? <p className="mt-1 text-xs text-rose">{m.listenError}</p> : null}
      <ProbeNote mapping={m} />
      <div className="mt-3 flex justify-end">
        <MappingMenu mapping={m} onEdit={onEdit} onDelete={onDelete} onIssued={onIssued} />
      </div>
    </article>
  );
}

function MappingRow({
  mapping: m,
  onEdit,
  onDelete,
  onIssued,
}: {
  mapping: Mapping;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: VisitorIssued) => void;
}) {
  return (
    <tr className="border-b border-line/70 last:border-0 hover:bg-paper-2/50">
      <td className="px-4 py-3">
        <div className="font-medium">{m.name}</div>
        <p className="text-xs text-stone">
          {m.proto.toUpperCase()} · {modeLabel[m.mode]}
        </p>
        <ProbeNote mapping={m} />
      </td>
      <td className="px-4 py-3 text-ink-soft">{m.nodeName}</td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <StatusDot
            status={reachTone(m.reach)}
            label={reachLabel[m.reach ?? ""] ?? m.reach ?? "—"}
          />
          <span className="text-xs text-stone">{pushLabel[m.pushState] ?? m.pushState}</span>
          {m.listenError ? <span className="text-xs text-rose">{m.listenError}</span> : null}
        </div>
      </td>
      <td className="px-4 py-3 font-mono tabular-nums">{formatPort(m.entryPort, m.mode)}</td>
      <td className="px-4 py-3 font-mono text-xs text-ink-soft">
        {m.localHost}:{m.localPort}
      </td>
      <td className="px-4 py-3 text-xs text-ink-soft">
        {policyLine(m.maxConns, m.idleTimeoutSec, m.proto)}
        <div className="font-mono tabular-nums">
          在途 {m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns}
        </div>
        {dropLine(m) ? <div className="text-rose">{dropLine(m)}</div> : null}
      </td>
      <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-soft">{trafficLine(m)}</td>
      <td className="px-4 py-3 text-right">
        <MappingMenu mapping={m} onEdit={onEdit} onDelete={onDelete} onIssued={onIssued} />
      </td>
    </tr>
  );
}

function MappingMenu({
  mapping: m,
  onEdit,
  onDelete,
  onIssued,
}: {
  mapping: Mapping;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: VisitorIssued) => void;
}) {
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
      toast.success("访客命令已复制，只显示这一次。");
      onIssued(r);
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: () => setMappingEnabled({ data: { id: m.id, enabled: !m.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["umbra"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const live = m.enabled && m.nodeStatus === "online";

  return (
    <ActionMenu
      label={`${m.name} 的更多操作`}
      items={[
        { label: "编辑", onSelect: onEdit },
        {
          label: knock.isPending ? "敲门中…" : granted ? "再敲门" : "敲门",
          hidden: !(live && m.mode === "spa"),
          disabled: knock.isPending,
          onSelect: () => knock.mutate(),
        },
        {
          label: probe.isPending ? "探测中…" : "探测",
          hidden: !(live && m.mode !== "visitor"),
          disabled: probe.isPending,
          onSelect: () => probe.mutate(),
        },
        {
          label: issue.isPending ? "签发中…" : "签发访客",
          hidden: !(live && m.mode === "visitor"),
          disabled: issue.isPending,
          onSelect: () => issue.mutate(),
        },
        {
          label: visit.isPending ? "探访中…" : "探访",
          hidden: !(live && m.mode === "visitor"),
          disabled: visit.isPending,
          onSelect: () => visit.mutate(),
        },
        {
          label: m.enabled ? "停用" : "启用",
          disabled: toggle.isPending,
          onSelect: () => toggle.mutate(),
        },
        { label: "删除", tone: "danger", onSelect: onDelete },
      ]}
    />
  );
}

function MappingForm({ mapping, onDone }: { mapping: Mapping | null; onDone: () => void }) {
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const usable = (nodes.data ?? []).filter((a) => a.status !== "revoked");
  const [nodeId, setNodeId] = useState(mapping?.nodeId ?? "");
  const [name, setName] = useState(mapping?.name ?? "");
  const [proto, setProto] = useState<Proto>(mapping?.proto ?? "tcp");
  const [mode, setMode] = useState<MappingMode>(mapping?.mode ?? "spa");
  const [entryPort, setEntryPort] = useState(String(mapping?.entryPort ?? 40222));
  const [localHost, setLocalHost] = useState(mapping?.localHost ?? "127.0.0.1");
  const [localPort, setLocalPort] = useState(String(mapping?.localPort ?? ECHO_PORT));
  const [maxConns, setMaxConns] = useState(String(mapping?.maxConns ?? 1024));
  const [idleTimeout, setIdleTimeout] = useState(String(mapping?.idleTimeoutSec ?? 0));
  const [rateKbps, setRateKbps] = useState(String(mapping?.rateKbps ?? 0));
  const [allowCidrs, setAllowCidrs] = useState(mapping?.allowCidrs ?? "");
  const selected = nodeId || usable[0]?.id || "";
  const editing = mapping !== null;

  const payload = {
    nodeId: selected,
    name,
    proto,
    mode,
    entryPort: mode === "visitor" ? null : Number(entryPort),
    localHost,
    localPort: Number(localPort),
    maxConns: Number(maxConns) || 1024,
    idleTimeoutSec: Number(idleTimeout) || 0,
    rateKbps: Number(rateKbps) || 0,
    allowCidrs,
  };

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateMapping({ data: { id: mapping.id, ...payload } })
        : createMapping({ data: payload }),
    onSuccess: (m) => {
      if (editing) {
        toast.success("映射已更新并下发");
      } else {
        toast.success(
          m.pushState === "acked"
            ? m.mode === "visitor"
              ? "已下发，无公网入口"
              : "已下发并监听"
            : "已保存，等待节点上线后下发",
        );
      }
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>{editing ? "编辑映射" : "新建映射"}</SheetTitle>
        <SheetDescription>
          {editing
            ? "改端口或目标会热下发，其它映射的在途连接不受影响。"
            : "保存后立刻下发。暗端口默认丢包；公开口才会一直听。"}
        </SheetDescription>
      </SheetHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !selected || save.isPending) return;
          save.mutate();
        }}
      >
        <SheetBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            label="空闲超时（秒）"
            inputMode="numeric"
            value={idleTimeout}
            onChange={(e) => setIdleTimeout(e.target.value)}
            placeholder="0 表示 TCP 不断开"
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
          <p className="sm:col-span-2 text-xs text-stone">
            默认最多 1024 路、TCP 空闲不关。SSH / 数据库请保持 0；UDP 无值时仍按约 60 秒回收会话。
          </p>
        </SheetBody>
        <SheetFooter className="flex items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {!name.trim()
              ? "填写名称后即可保存。"
              : !selected
                ? "选择节点后即可保存。"
                : "保存后会立即下发。"}
          </p>
          <div className="flex shrink-0 gap-2">
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </SheetClose>
            <Button type="submit" disabled={!name.trim() || !selected || save.isPending}>
              {save.isPending ? (editing ? "保存中…" : "下发中…") : "保存并下发"}
            </Button>
          </div>
        </SheetFooter>
      </form>
    </>
  );
}

function VisitorIssuedDialog({
  issued,
  onClose,
}: {
  issued: VisitorIssued | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const tickets = useQuery({
    queryKey: ["umbra", "tickets"],
    queryFn: () => listTickets(),
    enabled: issued !== null,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeTicket({ data: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["umbra", "tickets"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const rows: VisitorTicket[] = tickets.data ?? [];
  return (
    <Dialog open={issued !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>访客命令只显示这一次</DialogTitle>
          <DialogDescription>
            在访问侧跑这条命令，本机开 L4 口。入口不暴露业务端口。
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <>
            <pre className="mt-2 overflow-x-auto rounded-md bg-paper-2 p-3 font-mono text-xs leading-relaxed">
              {issued.visitCmd}
            </pre>
            <p className="mt-1 text-xs text-stone">到期 {formatRelative(issued.expiresAt)}</p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(issued.visitCmd);
                  toast.success("已复制");
                }}
              >
                再复制
              </Button>
              <Button type="button" onClick={onClose}>
                关闭
              </Button>
            </div>
            {rows.length > 0 ? (
              <div className="mt-4">
                <p className="text-xs text-stone">已签发票据</p>
                <ul className="mt-2 divide-y divide-line text-xs">
                  {rows.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate">
                        {t.mappingName || t.mappingId}
                        {t.label ? ` · ${t.label}` : ""}
                        {t.expired ? " · 已过期" : ` · ${formatRelative(t.expiresAt)}`}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(t.id)}
                      >
                        作废
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
