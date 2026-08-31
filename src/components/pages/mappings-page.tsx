"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { FilterChips, NodeSwitcher } from "@/components/filter-chips";
import { SelectField, TextField } from "@/components/field";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ActionMenu } from "@/components/ui/menu";
import { Pager } from "@/components/ui/pager";
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
  caDownloadURL,
  deleteMapping,
  issueVisitor,
  knockMapping,
  listNodes,
  listMappings,
  listTickets,
  probeMapping,
  revokeTicket,
  setMappingEnabled,
  updateMapping,
  visitMapping,
} from "@/lib/umbra/api";
import {
  formatBytes,
  formatBps,
  formatPort,
  formatRateDisplay,
  formatRateHint,
  formatRelative,
  pickRateUnit,
  RATE_UNITS,
  unitToKbps,
  type RateUnit,
} from "@/lib/umbra/format";
import {
  dropReasonLabel,
  listenLabel,
  modeHint,
  modeLabel,
  policyBits,
  pushLabel,
  reachLabel,
} from "@/lib/umbra/labels";
import {
  PAGE_SIZE,
  filterMappings,
  mappingFacets,
  mergeNodeOptions,
  pageOf,
  preferredNodeId,
  sortMappings,
} from "@/lib/umbra/page";
import { ECHO_PORT } from "@/lib/umbra/protocol";
import type { Mapping, MappingMode, Proto, VisitorIssued, VisitorTicket } from "@/lib/umbra/types";

type Editor = { mode: "create"; nodeId?: string } | { mode: "edit"; mapping: Mapping };

export function MappingsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/mappings" });
  const search = useSearch({ from: "/mappings" });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const mappings = useQuery({ queryKey: ["umbra", "mappings"], queryFn: () => listMappings() });
  const [q, setQ] = useState("");
  const [wantAll, setWantAll] = useState(false);
  const [proto, setProto] = useState("all");
  const [reach, setReach] = useState("all");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Mapping | null>(null);
  const [issuedVisit, setIssuedVisit] = useState<VisitorIssued | null>(null);
  const hasNode = (nodes.data ?? []).some((a) => a.status !== "revoked");
  const all = mappings.data ?? [];
  const searched = useMemo(() => filterMappings(all, { q: q.trim() || undefined }), [all, q]);
  const nodeFacets = useMemo(
    () => mergeNodeOptions(mappingFacets(searched).nodes, nodes.data ?? []),
    [searched, nodes.data],
  );
  const nodeId = search.node ?? (wantAll ? "all" : preferredNodeId(nodeFacets));
  const facets = useMemo(
    () => mappingFacets(filterMappings(searched, { nodeId: nodeId === "all" ? undefined : nodeId })),
    [searched, nodeId],
  );
  const showNode = nodeId === "all";
  const filter = useMemo(
    () => ({
      q: q.trim() || undefined,
      nodeId: nodeId === "all" ? undefined : nodeId,
      proto: proto === "all" ? undefined : proto,
      reach: reach === "all" ? undefined : reach,
    }),
    [q, nodeId, proto, reach],
  );
  const rows = useMemo(() => sortMappings(filterMappings(all, filter)), [all, filter]);
  const pageData = useMemo(() => pageOf(rows, page, PAGE_SIZE), [rows, page]);
  const list = pageData.items;
  const activeFilterCount = [proto, reach].filter((value) => value !== "all").length;
  const empty = !mappings.isLoading && all.length === 0 && !q && activeFilterCount === 0 && !search.node;

  useEffect(() => {
    if (search.node) setWantAll(false);
  }, [search.node]);

  useEffect(() => {
    setPage(1);
  }, [q, nodeId, proto, reach]);

  useEffect(() => {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE) || 1);
    if (page > pages) setPage(pages);
  }, [rows.length, page]);

  useEffect(() => {
    if (search.node || wantAll || !nodeFacets.length) return;
    const id = preferredNodeId(nodeFacets);
    if (id !== "all") {
      void navigate({ search: { node: id }, replace: true });
    }
  }, [search.node, wantAll, nodeFacets, navigate]);

  function setNodeFilter(next: string) {
    setWantAll(next === "all");
    void navigate({
      search: next === "all" ? {} : { node: next },
      replace: true,
    });
  }

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
      action={
        hasNode && !empty ? (
          <Button
            type="button"
            onClick={() =>
              setEditor({ mode: "create", nodeId: nodeId === "all" ? undefined : nodeId })
            }
          >
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
            公开访问、敲门访问，或加密隧道访问。
          </p>
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            新建映射
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3">
            <NodeSwitcher value={nodeId} onChange={setNodeFilter} options={nodeFacets} />
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称、目标"
                aria-label="搜索映射"
                className="max-w-sm"
              />
              <FilterChips label="协议" value={proto} onChange={setProto} options={facets.protos} />
              <FilterChips label="状态" value={reach} onChange={setReach} options={facets.reaches} />
              {activeFilterCount ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setProto("all");
                    setReach("all");
                  }}
                >
                  清除
                </Button>
              ) : null}
            </div>
          </div>
          {rows.length === 0 ? (
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
                    showNode={showNode}
                    onEdit={() => setEditor({ mode: "edit", mapping: m })}
                    onDelete={() => setPendingDelete(m)}
                    onIssued={setIssuedVisit}
                  />
                ))}
              </div>
              <div className="hidden overflow-hidden rounded-xl bg-card shadow-border md:block">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[880px] table-fixed text-left text-sm">
                    <colgroup>
                      <col className={showNode ? "w-[15%]" : "w-[18%]"} />
                      {showNode ? <col className="w-[10%]" /> : null}
                      <col className={showNode ? "w-[13%]" : "w-[15%]"} />
                      <col className="w-[7%]" />
                      <col className={showNode ? "w-[15%]" : "w-[16%]"} />
                      <col className={showNode ? "w-[16%]" : "w-[17%]"} />
                      <col className={showNode ? "w-[16%]" : "w-[19%]"} />
                      <col className="w-20" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-line text-xs text-stone">
                        <th className="px-4 py-3 font-medium">名称</th>
                        {showNode ? <th className="px-4 py-3 font-medium">节点</th> : null}
                        <th className="px-4 py-3 font-medium">现在</th>
                        <th className="px-4 py-3 font-medium">入口</th>
                        <th className="px-4 py-3 font-medium">目标</th>
                        <th className="px-4 py-3 font-medium">配额</th>
                        <th className="px-4 py-3 font-medium">流量</th>
                        <th className="py-3 pr-5 pl-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((m) => (
                        <MappingRow
                          key={m.id}
                          mapping={m}
                          showNode={showNode}
                          onEdit={() => setEditor({ mode: "edit", mapping: m })}
                          onDelete={() => setPendingDelete(m)}
                          onIssued={setIssuedVisit}
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
          {editor ? (
            <MappingForm
              key={editor.mode === "edit" ? editor.mapping.id : `new-${editor.nodeId ?? "any"}`}
              mapping={editor.mode === "edit" ? editor.mapping : null}
              defaultNodeId={editor.mode === "create" ? editor.nodeId : undefined}
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

function TrafficNote({ mapping: m }: { mapping: Mapping }) {
  const rate = (m.bpsIn ?? 0) + (m.bpsOut ?? 0);
  return (
    <div className="font-mono text-xs tabular-nums text-ink-soft" title={trafficLine(m)}>
      <p className="whitespace-nowrap">入 {formatBytes(m.bytesIn)}</p>
      <p className="whitespace-nowrap">出 {formatBytes(m.bytesOut)}</p>
      {rate > 0 ? <p className="whitespace-nowrap">{formatBps(rate)}</p> : null}
    </div>
  );
}

function quotaBits(m: Mapping) {
  const bits = policyBits(m.maxConns, m.idleTimeoutSec, m.proto, {
    spaTtlSec: m.spaTtlSec,
    udpIdleTimeoutSec: m.udpIdleTimeoutSec,
    mode: m.mode,
    rateKbps: m.rateKbps,
  });
  if (m.allowCidrs) bits.push(m.allowCidrs);
  return bits;
}

function dropInfo(m: Mapping) {
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
  if (n <= 0) return null;
  const why = dropReasonLabel[m.lastDrop ?? ""] ?? m.lastDrop ?? "原因未知";
  return { count: n, why };
}

function reachTone(reach: string | undefined) {
  if (reach === "open" || reach === "visitor") return "online";
  if (reach === "error" || reach === "full") return "error";
  if (reach === "offline" || reach === "closed") return "offline";
  return "pending";
}

function grantedNow(m: Mapping) {
  return Boolean(m.grantUntil && new Date(m.grantUntil).getTime() > Date.now());
}

function inFlight(m: Mapping) {
  return m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns;
}

function QuotaNote({ mapping: m }: { mapping: Mapping }) {
  const drop = dropInfo(m);
  return (
    <div className="flex flex-col gap-0.5 text-xs text-ink-soft">
      {quotaBits(m).map((bit) => (
        <p key={bit} className={bit.includes("/") ? "break-all" : "whitespace-nowrap"}>
          {bit}
        </p>
      ))}
      <p className="whitespace-nowrap font-mono tabular-nums">活跃连接 {inFlight(m)}</p>
      {drop ? (
        <div className="text-rose">
          <p className="whitespace-nowrap">丢弃 {drop.count}</p>
          <p className="whitespace-nowrap">{drop.why}</p>
        </div>
      ) : null}
    </div>
  );
}

function LiveNote({ mapping: m }: { mapping: Mapping }) {
  const granted = grantedNow(m);
  const push = m.pushState;
  const showPush = push && push !== "acked";
  return (
    <div className="flex flex-col gap-1">
      <StatusDot
        status={reachTone(m.reach)}
        label={reachLabel[m.reach ?? ""] ?? m.reach ?? "—"}
      />
      {granted && m.grantIP ? (
        <span className="font-mono text-xs text-ink-soft">已放行 {m.grantIP}</span>
      ) : null}
      {showPush ? <span className="text-xs text-stone">{pushLabel[push] ?? push}</span> : null}
      {m.listenError ? <span className="text-xs text-rose">{m.listenError}</span> : null}
    </div>
  );
}

function MappingCard({
  mapping: m,
  showNode,
  onEdit,
  onDelete,
  onIssued,
}: {
  mapping: Mapping;
  showNode?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: VisitorIssued) => void;
}) {
  return (
    <article className="rounded-xl bg-card p-4 shadow-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{m.name}</p>
          <p className="mt-0.5 truncate text-xs text-stone">
            {showNode ? `${m.nodeName} · ` : ""}
            {m.proto.toUpperCase()} · {m.mode}
            <span className="text-stone"> · {modeHint[m.mode]}</span>
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
      <p className="mt-1 text-xs text-stone">{trafficLine(m)}</p>
      {m.listenError ? <p className="mt-1 text-xs text-rose">{m.listenError}</p> : null}
      <div className="mt-2">
        <QuotaNote mapping={m} />
        {grantedNow(m) && m.grantIP ? (
          <p className="mt-1 font-mono text-xs text-ink-soft">已放行 {m.grantIP}</p>
        ) : null}
      </div>
      <div className="mt-3 flex justify-end">
        <MappingMenu mapping={m} onEdit={onEdit} onDelete={onDelete} onIssued={onIssued} />
      </div>
    </article>
  );
}

function MappingRow({
  mapping: m,
  showNode,
  onEdit,
  onDelete,
  onIssued,
}: {
  mapping: Mapping;
  showNode?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onIssued: (v: VisitorIssued) => void;
}) {
  return (
    <tr className="border-b border-line/70 last:border-0 hover:bg-paper-2/50">
      <td className="px-4 py-3 align-middle">
        <div className="min-w-0">
          <p className="truncate font-medium leading-snug" title={m.name}>
            {m.name}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-xs leading-snug text-stone"
            title={`${m.proto.toUpperCase()} · ${m.mode} · ${modeHint[m.mode]}`}
          >
            {m.proto.toUpperCase()} · {m.mode}
          </p>
        </div>
      </td>
      {showNode ? (
        <td className="px-4 py-3 align-middle">
          <span className={m.nodeStatus === "online" ? "text-live" : m.nodeStatus === "revoked" ? "text-rose" : "text-stone"}>
            {m.nodeName}
          </span>
        </td>
      ) : null}
      <td className="px-4 py-3 align-middle">
        <LiveNote mapping={m} />
      </td>
      <td className="px-4 py-3 align-middle font-mono tabular-nums">{formatPort(m.entryPort, m.mode)}</td>
      <td className="px-4 py-3 align-middle font-mono text-xs text-ink-soft">
        {m.localHost}:{m.localPort}
      </td>
      <td className="px-4 py-3 align-middle">
        <QuotaNote mapping={m} />
      </td>
      <td className="px-4 py-3 align-middle">
        <TrafficNote mapping={m} />
      </td>
      <td className="py-3 pr-5 pl-2 align-middle text-right">
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
    onSuccess: (r) => {
      toast.success(`已放行 ${r.ip}，${r.ttlSec} 秒内可建新连接`, { id: `knock-${m.id}` });
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
      toast.success("访问命令已复制，只显示这一次。");
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
          label: issue.isPending ? "签发中…" : "签发",
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

function RateLimitField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const kbps = Number(value) || 0;
  const [unit, setUnit] = useState<RateUnit>(() => pickRateUnit(kbps));
  const [draft, setDraft] = useState(() => formatRateDisplay(kbps, pickRateUnit(kbps)));

  function commit(raw: string, nextUnit: RateUnit) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "0") {
      onChange("0");
      setDraft(trimmed === "" ? "" : "0");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return;
    const next = String(unitToKbps(n, nextUnit));
    onChange(next);
    setDraft(raw);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>限速</Label>
      <div className="flex h-11 min-w-0 overflow-hidden rounded-md bg-paper shadow-border focus-within:ring-2 focus-within:ring-pine/35">
        <Input
          id={id}
          inputMode="decimal"
          value={draft}
          aria-describedby={hintId}
          placeholder="0"
          className="h-11 rounded-none shadow-none focus-visible:ring-0"
          onChange={(e) => commit(e.target.value, unit)}
        />
        <Select
          aria-label="限速单位"
          value={unit}
          onValueChange={(v) => {
            const next = v as RateUnit;
            setUnit(next);
            setDraft(formatRateDisplay(Number(value) || 0, next));
          }}
          options={RATE_UNITS.map((u) => ({ value: u.id, label: u.label }))}
          triggerClassName="w-auto shrink-0 rounded-none border-l border-line bg-paper-2 px-2 shadow-none focus-visible:ring-0"
        />
      </div>
      <p id={hintId} className="font-mono text-xs tabular-nums text-stone">
        {formatRateHint(Number(value) || 0)}
      </p>
    </div>
  );
}

function MappingForm({
  mapping,
  defaultNodeId,
  onDone,
}: {
  mapping: Mapping | null;
  defaultNodeId?: string;
  onDone: () => void;
}) {
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: () => listNodes() });
  const usable = (nodes.data ?? []).filter((a) => a.status !== "revoked");
  const [nodeId, setNodeId] = useState(mapping?.nodeId ?? defaultNodeId ?? "");
  const [name, setName] = useState(mapping?.name ?? "");
  const [proto, setProto] = useState<Proto>(mapping?.proto ?? "tcp");
  const [mode, setMode] = useState<MappingMode>(mapping?.mode ?? "public");
  const [entryPort, setEntryPort] = useState(String(mapping?.entryPort ?? 40222));
  const [localHost, setLocalHost] = useState(mapping?.localHost ?? "127.0.0.1");
  const [localPort, setLocalPort] = useState(String(mapping?.localPort ?? ECHO_PORT));
  const [maxConns, setMaxConns] = useState(String(mapping?.maxConns ?? 1024));
  const [idleTimeout, setIdleTimeout] = useState(String(mapping?.idleTimeoutSec ?? 0));
  const [spaTtl, setSpaTtl] = useState(String(mapping?.spaTtlSec || 60));
  const [udpIdle, setUdpIdle] = useState(String(mapping?.udpIdleTimeoutSec || 60));
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
    spaTtlSec: Number(spaTtl) || 60,
    udpIdleTimeoutSec: Number(udpIdle) || 60,
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
              ? "已下发，入口不开放端口"
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
          {editing ? "改端口或目标会立刻下发，其它映射不受影响。" : "保存后立刻下发到节点。"}
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
                label: `${a.name} · ${a.status === "online" ? "在线" : "离线"}`,
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
            className="sm:col-span-2"
            label="模式"
            value={mode}
            onValueChange={(v) => {
              const next = v as MappingMode;
              setMode(next);
              if (next === "public" && proto === "udp") setEntryPort("25565");
              if (next === "spa" && entryPort === "25565") setEntryPort("40222");
            }}
            options={[
              { value: "public", label: modeLabel.public, hint: modeHint.public },
              { value: "spa", label: modeLabel.spa, hint: modeHint.spa },
              { value: "visitor", label: modeLabel.visitor, hint: modeHint.visitor },
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
          ) : null}
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
          {mode === "spa" ? (
            <TextField
              label="敲门窗口"
              inputMode="numeric"
              value={spaTtl}
              onChange={(e) => setSpaTtl(e.target.value)}
              placeholder="秒，只限制新建"
            />
          ) : null}
          {proto === "tcp" ? (
            <TextField
              label="TCP 空闲"
              inputMode="numeric"
              value={idleTimeout}
              onChange={(e) => setIdleTimeout(e.target.value)}
              placeholder="秒，0 不断开"
            />
          ) : (
            <TextField
              label="UDP 空闲"
              inputMode="numeric"
              value={udpIdle}
              onChange={(e) => setUdpIdle(e.target.value)}
              placeholder="秒，无报文后回收"
            />
          )}
          <RateLimitField value={rateKbps} onChange={setRateKbps} />
          <div className="sm:col-span-2">
            <TextField
              label="允许网段"
              value={allowCidrs}
              onChange={(e) => setAllowCidrs(e.target.value)}
              placeholder="空则不限制，如 10.0.0.0/8"
            />
          </div>
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
          <DialogTitle>访问命令只显示这一次</DialogTitle>
          <DialogDescription>
            在访问端运行后，本机才会打开端口。尚未安装可先去部署页。
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
                onClick={() => window.open(caDownloadURL(), "_blank", "noopener")}
              >
                下载 CA
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/deploy" onClick={onClose}>
                  安装访问端
                </Link>
              </Button>
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
