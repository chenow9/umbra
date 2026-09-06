"use client";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ShieldCheck, Activity, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/field";
import { ConfirmDialog } from "@/components/ui/confirm";
import { SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@/components/ui/sheet";
import { StatusDot } from "@/components/status-dot";
import { CopyButton } from "./copy-button";
import {
  caDownloadURL,
  issueVisitor,
  knockMapping,
  probeMapping,
  listTickets,
  revokeTicket,
} from "@/lib/umbra/api";
import { accessOptions, serviceState, serviceCanConnect, targetAddress } from "@/lib/umbra/service";
import {
  ARCHS,
  PLATFORMS,
  binaryName,
  portableVisitorCommand,
  type Platform,
  type Arch,
} from "@/lib/umbra/units";
import { formatBytes, formatRelative } from "@/lib/umbra/format";
import { pushLabel, listenLabel, dropReasonLabel } from "@/lib/umbra/labels";
import type { Mapping, VisitorIssued, VisitorTicket } from "@/lib/umbra/types";

function useConnectSession(mapping?: Mapping) {
  const [task, setTask] = useState(
    mapping && serviceState(mapping).kind === "attention" ? "diagnose" : "connect",
  );
  const [issued, setIssued] = useState<VisitorIssued | null>(null);
  const [label, setLabel] = useState("");
  const [platform, setPlatform] = useState<Platform>("linux");
  const [arch, setArch] = useState<Arch>("amd64");
  const [revokeTarget, setRevokeTarget] = useState<VisitorTicket | null>(null);
  return {
    task,
    setTask,
    issued,
    setIssued,
    label,
    setLabel,
    platform,
    setPlatform,
    arch,
    setArch,
    revokeTarget,
    setRevokeTarget,
  };
}
const ConnectSessionContext = createContext<ReturnType<typeof useConnectSession> | null>(null);
// Keep one-time credentials and drafts above the responsive dialog boundary.
export function ServiceConnectSession({
  mapping,
  children,
}: {
  mapping?: Mapping;
  children: ReactNode;
}) {
  const state = useConnectSession(mapping);
  return <ConnectSessionContext.Provider value={state}>{children}</ConnectSessionContext.Provider>;
}

export function ServiceConnect({ mapping: m, onEdit }: { mapping: Mapping; onEdit: () => void }) {
  const qc = useQueryClient();
  const busy = useIsMutating({ mutationKey: ["umbra", "service-operation", m.id] }) > 0;
  const state = serviceState(m);
  const session = useContext(ConnectSessionContext)!;
  const {
    task,
    setTask,
    issued,
    setIssued,
    label,
    setLabel,
    platform,
    setPlatform,
    arch,
    setArch,
    revokeTarget,
    setRevokeTarget,
  } = session;
  const visitCommand = issued ? portableVisitorCommand(issued.visitCmd, platform, arch) : "";
  const visitBinary = binaryName("umbra-visit", platform, arch);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["umbra"] });
  };
  const tickets = useQuery({
    queryKey: ["umbra", "tickets", m.id],
    queryFn: () => listTickets({ data: { mappingId: m.id } }),
    enabled: m.mode === "visitor",
  });
  const issue = useMutation({
    mutationKey: ["umbra", "service-operation", m.id],
    mutationFn: () => issueVisitor({ data: { id: m.id, label: label.trim() || undefined } }),
    onSuccess: (result) => {
      setIssued(result);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const knock = useMutation({
    mutationKey: ["umbra", "service-operation", m.id],
    mutationFn: () => knockMapping({ data: { id: m.id } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const probe = useMutation({
    mutationKey: ["umbra", "service-operation", m.id],
    mutationFn: () => probeMapping({ data: { id: m.id } }),
    onSettled: refresh,
  });
  const revoke = useMutation({
    mutationKey: ["umbra", "service-operation", m.id],
    mutationFn: (id: string) => revokeTicket({ data: { id } }),
    onSuccess: (_, id) => {
      if (issued?.id === id) setIssued(null);
      setRevokeTarget(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ready = serviceCanConnect(m);
  const access = accessOptions.find((option) => option.mode === m.mode)!;
  const grants = (m.grants ?? []).filter((grant) => Date.parse(grant.until) > Date.now());

  return (
    <>
      <SheetHeader className="service-sheet-heading">
        <p className="sheet-eyebrow">SERVICE / 连接工作区</p>
        <SheetTitle>{m.name}</SheetTitle>
        <SheetDescription>连接服务、检查链路与管理访问权限。</SheetDescription>
      </SheetHeader>
      <Tabs.Root value={task} onValueChange={setTask} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="connection-task-tabs" aria-label="服务操作">
          <Tabs.Trigger value="connect">连接服务</Tabs.Trigger>
          <Tabs.Trigger value="diagnose">诊断链路</Tabs.Trigger>
          {m.mode === "visitor" ? (
            <Tabs.Trigger value="credentials">
              访问凭证{tickets.data?.length ? ` · ${tickets.data.length}` : ""}
            </Tabs.Trigger>
          ) : null}
        </Tabs.List>
        <SheetBody className="space-y-5">
          <section className="connection-status-panel rounded-lg border border-line bg-card p-4">
            <StatusDot status={state.tone} label={state.label} />
            <p className="mt-2 text-sm text-ink-soft">{state.detail}</p>
            <p className="mt-1 text-sm font-medium">{state.next}</p>
            {state.kind === "attention" || state.kind === "disabled" ? (
              <Button variant="outline" size="sm" className="mt-3" onClick={onEdit}>
                检查配置
              </Button>
            ) : null}
          </section>

          <Tabs.Content value="connect" className="space-y-4 focus-visible:outline-none">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="size-4" />
              {access.label}
            </h3>
            {m.mode === "visitor" ? (
              <>
                <p className="text-sm leading-relaxed text-ink-soft">
                  公网不开放业务端口。签发后，在需要访问服务的电脑上运行命令，然后把业务客户端连到本机端口。
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label="访问方系统"
                    value={platform}
                    onValueChange={(v) => setPlatform(v as Platform)}
                    options={PLATFORMS.filter((p) => p.id !== "docker").map((p) => ({
                      value: p.id,
                      label: p.label,
                    }))}
                  />
                  <SelectField
                    label="访问方架构"
                    value={arch}
                    onValueChange={(v) => setArch(v as Arch)}
                    options={ARCHS.map((a) => ({ value: a.id, label: a.label }))}
                  />
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  从发行页下载 <code>{visitBinary}</code>，将它与下载的 <code>ca.crt</code>{" "}
                  放在同一目录，再在该目录运行签发的命令。
                </p>
                <TextField
                  label="访问凭证备注（可选）"
                  placeholder="例如：笔记本、临时协作"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <Button onClick={() => issue.mutate()} disabled={!ready || busy || Boolean(issued)}>
                  {issue.isPending ? "正在签发…" : "签发 24 小时访问命令"}
                </Button>
                {issued ? (
                  <div className="space-y-3 rounded-lg border border-pine/30 bg-paper-2 p-3">
                    <p className="text-sm font-medium">请保存命令，关闭面板后无法再次查看</p>
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
                      {visitCommand}
                    </pre>
                    <p className="text-xs text-stone">
                      {formatRelative(issued.expiresAt)}到期。命令中的 --local
                      指定业务客户端连接的本机端口。
                    </p>
                    <CopyButton text={visitCommand} label="复制访问命令" />
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <a href={caDownloadURL()} target="_blank" rel="noreferrer">
                      下载入口 CA
                    </a>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href="https://github.com/chenow9/umbra/releases"
                      target="_blank"
                      rel="noreferrer"
                    >
                      下载访问客户端 <ArrowUpRight className="ml-1 size-3.5" />
                    </a>
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  {platform === "windows" ? "在 PowerShell 中运行命令。" : "在终端中运行命令。"}
                  停掉访问端进程即关闭本机端口。
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-soft">
                  {m.mode === "spa"
                    ? "先放行当前来源 IP，再用原有客户端连接下方地址。授权只影响有效期内的新连接。"
                    : "用对应协议的业务客户端连接此地址；目标服务仍需自己的身份验证。"}
                </p>
                {m.entryAddress ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper-2 p-3">
                    <code className="break-all text-sm">{m.entryAddress}</code>
                    <CopyButton text={m.entryAddress} label="复制连接地址" />
                  </div>
                ) : (
                  <p className="rounded-lg bg-paper-2 p-3 text-sm">
                    入口地址尚未提供。请检查入口的 advertise 配置；业务端口为 {m.entryPort}
                    。这里不会把控制台地址误当作业务入口。
                  </p>
                )}
                {m.mode === "spa" ? (
                  <>
                    <Button onClick={() => knock.mutate()} disabled={!ready || busy}>
                      {knock.isPending ? "正在放行…" : "临时放行我的 IP"}
                    </Button>
                    {knock.data ? (
                      <p role="status" className="text-sm text-live">
                        已放行 {knock.data.ip}，截至{" "}
                        {new Date(knock.data.until).toLocaleTimeString()}
                        。请在有效期内建立连接。
                      </p>
                    ) : null}
                    {grants.length ? (
                      <details className="text-xs text-stone">
                        <summary className="cursor-pointer py-2">
                          当前放行记录 · {grants.length}
                        </summary>
                        {grants.map((g) => (
                          <p key={g.ip}>
                            {g.ip} · {formatRelative(g.until)}到期
                          </p>
                        ))}
                      </details>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
            <p className="break-all text-xs text-stone">
              来源限制：{m.allowCidrs || "未设置 CIDR 白名单"}
            </p>
          </Tabs.Content>

          <Tabs.Content value="diagnose" className="space-y-4 focus-visible:outline-none">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="size-4" />
              连接诊断
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="text-stone">节点</dt>
              <dd>
                <Link to="/nodes" className="underline underline-offset-4">
                  {m.nodeName}
                </Link>{" "}
                ·{" "}
                {m.nodeStatus === "online"
                  ? "在线"
                  : m.nodeStatus === "revoked"
                    ? "已吊销"
                    : "离线"}
              </dd>
              <dt className="text-stone">配置</dt>
              <dd>{pushLabel[m.pushState] ?? m.pushState}</dd>
              <dt className="text-stone">入口</dt>
              <dd>
                {m.mode === "visitor"
                  ? "不监听公网业务端口"
                  : (listenLabel[m.listenState] ?? m.listenState)}
              </dd>
              <dt className="text-stone">内网目标</dt>
              <dd className="break-all font-mono text-xs">
                {targetAddress(m.localHost, m.localPort)} · {m.proto.toUpperCase()}
              </dd>
              <dt className="text-stone">最近探测</dt>
              <dd>
                {m.lastProbeAt
                  ? `${formatRelative(m.lastProbeAt)}${m.lastProbeError ? " · 未取得响应" : " · 历史记录"}`
                  : "尚未验证"}
              </dd>
            </dl>
            <p className="text-xs leading-relaxed text-stone">
              探测会向真实目标发送少量测试数据，计入流量。收到响应也不代表应用健康或外部网络一定可达；不响应测试报文的服务可能仍能正常使用。
            </p>
            <Button variant="outline" disabled={!ready || busy} onClick={() => probe.mutate()}>
              {probe.isPending ? "正在验证响应…" : "发送探测"}
            </Button>
            {probe.error ? (
              <div role="alert" className="rounded-lg bg-paper-2 p-3 text-sm">
                <p className="font-medium text-rose">未验证目标响应</p>
                <p className="mt-1 break-all">{probe.error.message}</p>
                <p className="mt-2 text-xs text-stone">
                  检查节点是否能访问目标、服务是否监听以及协议是否匹配。目标也可能不支持测试报文，请再用业务客户端验证。
                </p>
              </div>
            ) : probe.data ? (
              <div role="status" className="rounded-lg bg-paper-2 p-3 text-sm">
                <p className="font-medium">
                  {probe.data.bytesIn > 0
                    ? "本次探测收到响应"
                    : "本次探测未收到响应，不能确认目标可达"}
                </p>
                <p className="mt-1 text-xs text-stone">
                  入 {formatBytes(probe.data.bytesIn)} / 出 {formatBytes(probe.data.bytesOut)}
                </p>
                {probe.data.preview ? (
                  <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">
                    {probe.data.preview}
                  </pre>
                ) : null}
              </div>
            ) : m.lastProbeError ? (
              <p className="break-all text-sm text-rose">上次探测：{m.lastProbeError}</p>
            ) : null}
            <details className="rounded-lg border border-line p-3 text-xs">
              <summary className="cursor-pointer font-medium">运行与策略详情</summary>
              <div className="mt-3 space-y-2 text-ink-soft">
                <p>
                  活跃连接 {m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns} /
                  上限 {m.maxConns}
                </p>
                <p>
                  累计入站 {formatBytes(m.bytesIn)} · 出站 {formatBytes(m.bytesOut)}
                </p>
                <p>
                  限速 {m.rateKbps ? `${m.rateKbps} KB/s` : "不限"} · 空闲超时{" "}
                  {m.proto === "udp" ? (m.udpIdleTimeoutSec ?? 60) : (m.idleTimeoutSec ?? 0)} 秒
                </p>
                {m.lastDrop ? (
                  <p>
                    最近丢弃：{dropReasonLabel[m.lastDrop] ?? m.lastDrop} ·{" "}
                    {formatRelative(m.lastDropAt ?? null)}
                  </p>
                ) : null}
              </div>
            </details>
          </Tabs.Content>

          {m.mode === "visitor" ? (
            <Tabs.Content value="credentials" className="space-y-4 focus-visible:outline-none">
              <h3 className="text-sm font-semibold">已签发凭证</h3>
              <p className="text-xs text-stone">
                无需签发新凭证即可查看或撤销。撤销后不能再建立新连接。
              </p>
              {tickets.isPending ? (
                <p role="status" className="text-sm text-stone">
                  正在读取凭证…
                </p>
              ) : tickets.isError ? (
                <Button variant="outline" onClick={() => tickets.refetch()}>
                  读取失败，重试
                </Button>
              ) : !tickets.data?.length ? (
                <p className="text-sm text-stone">此服务尚未签发凭证。</p>
              ) : (
                <ul className="divide-y divide-line">
                  {tickets.data.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{t.label || "未命名凭证"}</p>
                        <p className="text-xs text-stone">
                          {t.expired ? "已过期" : `${formatRelative(t.expiresAt)}到期`} ·{" "}
                          {t.id.slice(-8)}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(t)}>
                        撤销
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Tabs.Content>
          ) : null}
        </SheetBody>
      </Tabs.Root>
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="撤销访问凭证"
        description={`撤销「${revokeTarget?.label || "未命名凭证"}」后，持有者将无法用它建立新连接。`}
        confirmLabel="撤销凭证"
        danger
        pending={busy}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
      />
    </>
  );
}
