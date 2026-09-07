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
import { dateLocale, statusText, useI18n } from "@/lib/i18n";
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
  const { t, locale } = useI18n();
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
  const access = accessOptions().find((option) => option.mode === m.mode)!;
  const grants = (m.grants ?? []).filter((grant) => Date.parse(grant.until) > Date.now());
  const ticketName = revokeTarget?.label || t("connect.unnamed");

  return (
    <>
      <SheetHeader className="service-sheet-heading">
        <p className="sheet-eyebrow">{t("connect.eyebrow")}</p>
        <SheetTitle>{m.name}</SheetTitle>
        <SheetDescription>{t("connect.hint")}</SheetDescription>
        <Link
          to="/traffic"
          search={{ node: m.nodeId, service: m.id }}
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-pine"
        >
          <Activity className="size-3.5" />
          {t("connect.viewTraffic")}
        </Link>
      </SheetHeader>
      <Tabs.Root value={task} onValueChange={setTask} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="connection-task-tabs" aria-label={t("connect.tabs")}>
          <Tabs.Trigger value="connect">{t("connect.connect")}</Tabs.Trigger>
          <Tabs.Trigger value="diagnose">{t("connect.diagnose")}</Tabs.Trigger>
          {m.mode === "visitor" ? (
            <Tabs.Trigger value="credentials">
              {tickets.data?.length
                ? t("connect.ticketsN", { n: tickets.data.length })
                : t("connect.tickets")}
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
                {t("connect.check")}
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
                <p className="text-sm leading-relaxed text-ink-soft">{t("connect.visitorHint")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label={t("connect.clientOs")}
                    value={platform}
                    onValueChange={(v) => setPlatform(v as Platform)}
                    options={PLATFORMS.filter((p) => p.id !== "docker").map((p) => ({
                      value: p.id,
                      label: p.label,
                    }))}
                  />
                  <SelectField
                    label={t("connect.clientArch")}
                    value={arch}
                    onValueChange={(v) => setArch(v as Arch)}
                    options={ARCHS.map((a) => ({ value: a.id, label: a.label }))}
                  />
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  {t("connect.downloadHintPrefix")} <code>{visitBinary}</code>
                  {t("connect.downloadHintMid")} <code>ca.crt</code>
                  {t("connect.downloadHintSuffix")}
                </p>
                <TextField
                  label={t("connect.ticketLabel")}
                  placeholder={t("connect.ticketPh")}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <Button onClick={() => issue.mutate()} disabled={!ready || busy || Boolean(issued)}>
                  {issue.isPending ? t("connect.issuing") : t("connect.issue")}
                </Button>
                {issued ? (
                  <div className="space-y-3 rounded-lg border border-pine/30 bg-paper-2 p-3">
                    <p className="text-sm font-medium">{t("connect.saveCmd")}</p>
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
                      {visitCommand}
                    </pre>
                    <p className="text-xs text-stone">
                      {t("connect.expires", { when: formatRelative(issued.expiresAt) })}
                    </p>
                    <CopyButton text={visitCommand} label={t("connect.copyCmd")} />
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <a href={caDownloadURL()} target="_blank" rel="noreferrer">
                      {t("connect.downloadCa")}
                    </a>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href="https://github.com/chenow9/umbra/releases"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("connect.downloadClient")} <ArrowUpRight className="ml-1 size-3.5" />
                    </a>
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-stone">
                  {platform === "windows" ? t("connect.runWin") : t("connect.runUnix")}{" "}
                  {t("connect.stopHint")}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-soft">
                  {m.mode === "spa" ? t("connect.spaHint") : t("connect.publicHint")}
                </p>
                {m.entryAddress ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper-2 p-3">
                    <code className="break-all text-sm">{m.entryAddress}</code>
                    <CopyButton text={m.entryAddress} label={t("connect.copyAddr")} />
                  </div>
                ) : (
                  <p className="rounded-lg bg-paper-2 p-3 text-sm">
                    {t("connect.noAdvertise", { port: m.entryPort ?? "" })}
                  </p>
                )}
                {m.mode === "spa" ? (
                  <>
                    <Button onClick={() => knock.mutate()} disabled={!ready || busy}>
                      {knock.isPending ? t("connect.knocking") : t("connect.knock")}
                    </Button>
                    {knock.data ? (
                      <p role="status" className="text-sm text-live">
                        {t("connect.knocked", {
                          ip: knock.data.ip,
                          until: new Date(knock.data.until).toLocaleTimeString(dateLocale(locale), {
                            hour12: false,
                          }),
                        })}
                      </p>
                    ) : null}
                    {grants.length ? (
                      <details className="text-xs text-stone">
                        <summary className="cursor-pointer py-2">
                          {t("connect.grants", { n: grants.length })}
                        </summary>
                        {grants.map((g) => (
                          <p key={g.ip}>
                            {t("connect.grantLine", {
                              ip: g.ip,
                              until: formatRelative(g.until),
                            })}
                          </p>
                        ))}
                      </details>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
            <p className="break-all text-xs text-stone">
              {t("connect.cidr", { cidr: m.allowCidrs || t("connect.noCidr") })}
            </p>
          </Tabs.Content>

          <Tabs.Content value="diagnose" className="space-y-4 focus-visible:outline-none">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="size-4" />
              {t("connect.diag")}
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="text-stone">{t("connect.node")}</dt>
              <dd>
                <Link to="/nodes" className="underline underline-offset-4">
                  {m.nodeName}
                </Link>{" "}
                · {statusText(m.nodeStatus)}
              </dd>
              <dt className="text-stone">{t("connect.config")}</dt>
              <dd>{pushLabel()[m.pushState] ?? m.pushState}</dd>
              <dt className="text-stone">{t("connect.entry")}</dt>
              <dd>
                {m.mode === "visitor"
                  ? t("connect.noListen")
                  : (listenLabel()[m.listenState] ?? m.listenState)}
              </dd>
              <dt className="text-stone">{t("connect.target")}</dt>
              <dd className="break-all font-mono text-xs">
                {targetAddress(m.localHost, m.localPort)} · {m.proto.toUpperCase()}
              </dd>
              <dt className="text-stone">{t("connect.lastProbe")}</dt>
              <dd>
                {m.lastProbeAt
                  ? m.lastProbeError
                    ? t("connect.probeNoReply", { when: formatRelative(m.lastProbeAt) })
                    : t("connect.probeHistory", { when: formatRelative(m.lastProbeAt) })
                  : t("connect.neverProbed")}
              </dd>
            </dl>
            <p className="text-xs leading-relaxed text-stone">{t("connect.probeHint")}</p>
            <Button variant="outline" disabled={!ready || busy} onClick={() => probe.mutate()}>
              {probe.isPending ? t("connect.probing") : t("connect.probe")}
            </Button>
            {probe.error ? (
              <div role="alert" className="rounded-lg bg-paper-2 p-3 text-sm">
                <p className="font-medium text-rose">{t("connect.unverified")}</p>
                <p className="mt-1 break-all">{probe.error.message}</p>
                <p className="mt-2 text-xs text-stone">{t("connect.unverifiedHint")}</p>
              </div>
            ) : probe.data ? (
              <div role="status" className="rounded-lg bg-paper-2 p-3 text-sm">
                <p className="font-medium">
                  {probe.data.bytesIn > 0 ? t("connect.probeOk") : t("connect.probeFail")}
                </p>
                <p className="mt-1 text-xs text-stone">
                  {t("connect.io", {
                    in: formatBytes(probe.data.bytesIn),
                    out: formatBytes(probe.data.bytesOut),
                  })}
                </p>
                {probe.data.preview ? (
                  <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">
                    {probe.data.preview}
                  </pre>
                ) : null}
              </div>
            ) : m.lastProbeError ? (
              <p className="break-all text-sm text-rose">
                {t("connect.lastError", { error: m.lastProbeError })}
              </p>
            ) : null}
            <details className="rounded-lg border border-line p-3 text-xs">
              <summary className="cursor-pointer font-medium">{t("connect.details")}</summary>
              <div className="mt-3 space-y-2 text-ink-soft">
                <p>
                  {t("connect.active", {
                    active: m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns,
                    max: m.maxConns,
                  })}
                </p>
                <p>
                  {t("connect.bytes", {
                    in: formatBytes(m.bytesIn),
                    out: formatBytes(m.bytesOut),
                  })}
                </p>
                <p>
                  {t("connect.rateIdle", {
                    rate: m.rateKbps ? `${m.rateKbps} KB/s` : t("connect.unlimited"),
                    idle: m.proto === "udp" ? (m.udpIdleTimeoutSec ?? 60) : (m.idleTimeoutSec ?? 0),
                  })}
                </p>
                {m.lastDrop ? (
                  <p>
                    {t("connect.lastDrop", {
                      reason: dropReasonLabel()[m.lastDrop] ?? m.lastDrop,
                      when: formatRelative(m.lastDropAt ?? null),
                    })}
                  </p>
                ) : null}
              </div>
            </details>
          </Tabs.Content>

          {m.mode === "visitor" ? (
            <Tabs.Content value="credentials" className="space-y-4 focus-visible:outline-none">
              <h3 className="text-sm font-semibold">{t("connect.issuedTitle")}</h3>
              <p className="text-xs text-stone">{t("connect.issuedHint")}</p>
              {tickets.isPending ? (
                <p role="status" className="text-sm text-stone">
                  {t("connect.readingTickets")}
                </p>
              ) : tickets.isError ? (
                <Button variant="outline" onClick={() => tickets.refetch()}>
                  {t("connect.ticketsFail")}
                </Button>
              ) : !tickets.data?.length ? (
                <p className="text-sm text-stone">{t("connect.noTickets")}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {tickets.data.map((ticket) => (
                    <li key={ticket.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{ticket.label || t("connect.unnamed")}</p>
                        <p className="text-xs text-stone">
                          {ticket.expired
                            ? t("connect.expired")
                            : t("connect.expiresAt", { when: formatRelative(ticket.expiresAt) })}{" "}
                          · {ticket.id.slice(-8)}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(ticket)}>
                        {t("connect.revoke")}
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
        title={t("connect.revokeTitle")}
        description={t("connect.revokeBody", { name: ticketName })}
        confirmLabel={t("connect.revokeConfirm")}
        danger
        pending={busy}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
      />
    </>
  );
}
