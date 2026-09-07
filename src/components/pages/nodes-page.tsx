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
import { statusText, useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
  const qc = useQueryClient();
  const search = useSearch({ from: "/nodes" });
  const navigate = useNavigate({ from: "/nodes" });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const query = {
    q: q.trim() || undefined,
    status: status === "all" ? undefined : status,
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
  const facets = nodeFacets(catalog.data ?? [], { q, status });
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (!search.edit || !catalog.data) return;
    const node = catalog.data.find((item) => item.id === search.edit);
    if (node) setEditor({ mode: "edit", node });
    else toast.error(t("nodes.missing"));
    void navigate({ search: {}, replace: true });
  }, [search.edit, catalog.data, navigate, t]);
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
    status === "all";
  useEffect(() => {
    setPage(1);
  }, [q, status]);
  useEffect(() => {
    if (!nodes.data) return;
    const pages = Math.max(1, Math.ceil(nodes.data.total / nodes.data.size) || 1);
    if (page > pages) setPage(pages);
  }, [nodes.data, page]);

  const remove = useMutation({
    mutationFn: (node: Node) => deleteNode({ data: { id: node.id, force: node.mappingCount > 0 } }),
    onSuccess: () => {
      toast.message(t("nodes.deleted"));
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rotate = useMutation({
    mutationFn: (node: Node) => rotateNodeToken({ data: { id: node.id } }),
    onSuccess: (r, node) => {
      toast.success(t("nodes.rotated", { sec: r.graceSec }));
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
        note: t("nodes.rotatedNote", { sec: r.graceSec }),
        expiresAt: r.expiresAt,
        neverExpire: r.neverExpire,
      });
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AppShell
      description={t("nodes.description")}
      showTelemetry={false}
      title={t("nodes.title")}
      action={
        empty ? null : (
          <Button type="button" onClick={() => setEditor({ mode: "create" })}>
            {t("nodes.enroll")}
          </Button>
        )
      }
    >
      {nodes.isError ? (
        <div role="alert" className="mb-5 rounded-xl border border-rose/25 p-4 text-sm">
          <p>{t("nodes.loadError", { message: nodes.error.message })}</p>
          <Button variant="outline" className="mt-3" onClick={() => void nodes.refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      {nodes.isPending ? (
        <p role="status" className="py-10 text-sm text-stone">
          {t("nodes.loading")}
        </p>
      ) : empty ? (
        <EmptyNodes onCreate={() => setEditor({ mode: "create" })} />
      ) : nodes.isError && !nodes.data ? null : (
        <>
          <NodeFleetBar
            q={q}
            onQuery={setQ}
            status={status}
            onStatus={setStatus}
            facets={facets}
            loading={catalog.isPending}
          />

          {pageData.total === 0 ? (
            <p className="rounded-xl bg-card px-4 py-8 text-center text-sm text-stone shadow-border">
              {t("nodes.emptyMatch")}
            </p>
          ) : (
            <>
              <div className="node-directory" role="list" aria-label={t("nodes.list")}>
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
        title={pendingDelete?.mappingCount ? t("nodes.deleteWithServices") : t("nodes.deleteTitle")}
        description={
          pendingDelete?.mappingCount
            ? t("nodes.deleteWithServicesBody", {
                name: pendingDelete.name,
                count: pendingDelete.mappingCount,
              })
            : t("nodes.deleteBody", { name: pendingDelete?.name ?? "" })
        }
        confirmLabel={t("common.delete")}
        danger
        pending={remove.isPending}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />

      <ConfirmDialog
        open={pendingRotate !== null}
        title={t("nodes.rotateTitle")}
        description={t("nodes.rotateBody")}
        confirmLabel={t("nodes.rotateConfirm")}
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
  onStatus,
  facets,
  loading,
}: {
  q: string;
  onQuery: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  facets: NodeFacets;
  loading: boolean;
}) {
  const { t } = useI18n();
  const filtered = status !== "all" || q.trim() !== "";
  return (
    <div className="mb-5 space-y-4">
      <div className="workspace-view-row">
        <div role="group" aria-label={t("nodes.statusGroup")} className="service-view-tabs">
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
      </div>
      <div className="service-filter-bar">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone" />
          <Input
            value={q}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t("nodes.searchPlaceholder")}
            aria-label={t("nodes.search")}
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
            }}
          >
            {t("nodes.clear")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EmptyNodes({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-5 py-8">
      <div>
        <h2 className="font-serif text-3xl italic tracking-tight text-ink">{t("nodes.emptyTitle")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{t("nodes.emptyBody")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onCreate}>
          {t("nodes.enroll")}
        </Button>
      </div>
    </div>
  );
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
  const { t } = useI18n();
  return (
    <article className="node-directory-row" role="listitem">
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: node.id }}
        className="node-directory-link"
        aria-label={t("nodes.openServices", { name: node.name })}
      >
        <span className="node-directory-identity">
          <strong>{node.name}</strong>
          <small>{node.comment || node.addr || platformLabel(node.os, node.arch)}</small>
        </span>
        <StatusDot status={node.status} label={statusText(node.status)} />
        <span className="node-directory-services">
          <span>{t("nodes.services", { count: node.mappingCount })}</span>
          {attention ? (
            <small className="text-rose">{t("nodes.attention", { n: attention })}</small>
          ) : null}
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
  const { t } = useI18n();
  const qc = useQueryClient();
  const bye = useMutation({
    mutationFn: () => disconnectNode({ data: { id: node.id } }),
    onSuccess: () => {
      toast.message(t("nodes.disconnected"));
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: () => revokeNode({ data: { id: node.id } }),
    onSuccess: () => {
      toast.message(t("nodes.revokedToast"));
      void qc.invalidateQueries({ queryKey: ["umbra"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ActionMenu
      label={t("nodes.more", { name: node.name })}
      items={[
        { label: t("common.edit"), onSelect: onEdit },
        {
          label: t("nodes.rotate"),
          hidden: node.status === "revoked",
          onSelect: onRotate,
        },
        {
          label: t("nodes.downloadCa"),
          onSelect: () => {
            window.open(caDownloadURL(), "_blank", "noopener");
          },
        },
        {
          label: t("nodes.disconnect"),
          hidden: node.status !== "online",
          disabled: bye.isPending,
          onSelect: () => bye.mutate(),
        },
        {
          label: t("nodes.revoke"),
          hidden: node.status === "revoked",
          disabled: revoke.isPending,
          tone: "danger",
          onSelect: () => revoke.mutate(),
        },
        { label: t("common.delete"), tone: "danger", onSelect: onDelete },
      ]}
    />
  );
}

function CreateNodeForm({ onIssued }: { onIssued: (v: Issued) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [os, setOs] = useState<Platform>("linux");
  const [arch, setArch] = useState<Arch>("amd64");
  const [neverExpire, setNeverExpire] = useState(false);
  const create = useMutation({
    mutationFn: () => createNode({ data: { name, comment, os, arch, neverExpire } }),
    onSuccess: (res) => {
      toast.success(t("nodes.issuedToast"), { id: "create-node" });
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
        <SheetTitle>{t("nodes.enroll")}</SheetTitle>
        <SheetDescription>{t("nodes.enrollHint")}</SheetDescription>
      </SheetHeader>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (create.isPending) return;
          if (!name.trim()) {
            toast.error(t("nodes.needName"));
            return;
          }
          toast.loading(t("nodes.registering"), { id: "create-node" });
          create.mutate();
        }}
      >
        <SheetBody className="flex flex-col gap-3">
          <TextField
            label={t("nodes.name")}
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="home-nas"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("nodes.os")}
              value={os}
              onValueChange={(v) => setOs(v as Platform)}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <SelectField
              label={t("nodes.arch")}
              value={arch}
              onValueChange={(v) => setArch(v as Arch)}
              options={ARCHS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <TextAreaField
            label={t("nodes.comment")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("common.optional")}
          />
          <CheckField
            label={t("nodes.neverExpire")}
            hint={t("nodes.neverExpireHint")}
            checked={neverExpire}
            onChange={setNeverExpire}
          />
        </SheetBody>
        <SheetFooter className="flex items-center justify-between gap-3">
          <p className="text-xs text-stone" aria-live="polite">
            {name.trim()
              ? neverExpire
                ? t("nodes.hintNamedNever")
                : t("nodes.hintNamedTtl")
              : t("nodes.hintEmpty")}
          </p>
          <div className="flex shrink-0 gap-2">
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                {t("common.cancel")}
              </Button>
            </SheetClose>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? t("nodes.issuing") : t("nodes.issue")}
            </Button>
          </div>
        </SheetFooter>
      </form>
    </>
  );
}

function EditNodeForm({ node, onDone }: { node: Node; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(node.name);
  const [comment, setComment] = useState(node.comment);
  const [os, setOs] = useState<Platform>((node.os as Platform) || "linux");
  const [arch, setArch] = useState<Arch>((node.arch as Arch) || "amd64");
  const [neverExpire, setNeverExpire] = useState(Boolean(node.tokenNoExpiry));
  const save = useMutation({
    mutationFn: () => updateNode({ data: { id: node.id, name, comment, os, arch, neverExpire } }),
    onSuccess: () => {
      toast.success(t("nodes.updated"));
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t("nodes.editTitle")}</SheetTitle>
        <SheetDescription>{t("nodes.editHint")}</SheetDescription>
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
              <dt className="text-stone">{t("nodes.nodeStatus")}</dt>
              <dd className="mt-1">{statusText(node.status)}</dd>
            </div>
            <div>
              <dt className="text-stone">{t("nodes.lastSeen")}</dt>
              <dd className="mt-1">{formatRelative(node.lastSeen)}</dd>
            </div>
            <div>
              <dt className="text-stone">{t("nodes.addr")}</dt>
              <dd className="mt-1 break-all">{node.addr ?? t("nodes.notConnected")}</dd>
            </div>
            <div>
              <dt className="text-stone">{t("nodes.trafficRate")}</dt>
              <dd className="mt-1">
                {formatBytes(node.bytesIn + node.bytesOut)} /{" "}
                {formatBps((node.bpsIn ?? 0) + (node.bpsOut ?? 0))}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-stone">{t("nodes.credential")}</dt>
              <dd className="mt-1">
                {node.status === "revoked"
                  ? t("common.revoked")
                  : node.tokenNoExpiry
                    ? t("nodes.neverExpires")
                    : node.tokenExpiresAt
                      ? t("nodes.expiresAt", { when: formatRelative(node.tokenExpiresAt) })
                      : t("nodes.noExpiry")}
              </dd>
            </div>
          </dl>
          <TextField
            label={t("nodes.name")}
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("nodes.os")}
              value={os}
              onValueChange={(v) => setOs(v as Platform)}
              options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <SelectField
              label={t("nodes.arch")}
              value={arch}
              onValueChange={(v) => setArch(v as Arch)}
              options={ARCHS.map((p) => ({ value: p.id, label: p.label }))}
            />
          </div>
          <TextAreaField
            label={t("nodes.comment")}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {node.status !== "revoked" ? (
            <CheckField
              label={t("nodes.neverExpire")}
              hint={t("nodes.neverExpireEditHint")}
              checked={neverExpire}
              onChange={setNeverExpire}
            />
          ) : null}
        </SheetBody>
        <SheetFooter className="flex items-center justify-end gap-2">
          <SheetClose asChild>
            <Button type="button" variant="ghost">
              {t("common.cancel")}
            </Button>
          </SheetClose>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </SheetFooter>
      </form>
    </>
  );
}

function IssuedDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={issued !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("nodes.issuedTitle")}</DialogTitle>
          <DialogDescription>
            {t("nodes.issuedBody")}
            {issued?.listen?.startsWith("127.0.0.1") ? t("nodes.issuedLoopback") : ""}
            {issued?.note ? ` ${issued.note}` : ""}
            {issued?.neverExpire ? t("nodes.issuedNever") : ""}
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
  const { t } = useI18n();
  const liveNodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes });
  const online = liveNodes.data?.find((node) => node.id === issued.id)?.status === "online";
  const [kind, setKind] = useState<"docker" | "bin">(defaultEnrollKind(issued.os));
  const [fetchedPem, setFetchedPem] = useState(issued.caPem ?? "");
  useEffect(() => {
    if (issued.caPem) return;
    const ac = new AbortController();
    fetch(caDownloadURL(), { credentials: "include", signal: ac.signal })
      .then((r) => (r.ok ? r.text() : ""))
      .then((pem) => {
        if (pem.includes("BEGIN CERTIFICATE")) setFetchedPem(pem);
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [issued.caPem]);

  const server = issued.listen?.trim() || t("nodes.fallbackServer");
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
        <p className="text-sm font-medium">{online ? t("nodes.onlineReady") : t("nodes.waitingOnline")}</p>
        <p className="mt-1 text-xs text-stone">
          {online ? t("nodes.onlineReadyHint") : t("nodes.waitingOnlineHint")}
        </p>
        {online ? (
          <Button asChild className="mt-3">
            <Link
              to="/nodes/$nodeId"
              params={{ nodeId: issued.id }}
              search={{ create: true }}
              onClick={onClose}
            >
              {t("nodes.addServiceFor")}
            </Link>
          </Button>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-label={t("nodes.installKind")}
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
          {t("nodes.docker")}
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
          {t("nodes.binary")}
        </button>
      </div>
      <div className="mt-3 rounded-md bg-paper-2 p-4 shadow-border">
        <p className="text-sm font-medium text-ink">
          {kind === "docker" ? t("nodes.dockerReady") : t("nodes.binaryReady")}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-stone">
          {hasCA
            ? kind === "docker"
              ? t("nodes.dockerHasCa")
              : t("nodes.binaryHasCa")
            : t("nodes.missingCa")}
        </p>
        <Button
          type="button"
          className="mt-3"
          onClick={() => {
            void navigator.clipboard.writeText(cmd);
            toast.success(t("nodes.cmdCopied"));
          }}
        >
          {t("nodes.copyCmd")}
        </Button>
      </div>

      <details className="mt-3 rounded-md bg-paper-2 shadow-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">
          {t("nodes.viewCmd")}
        </summary>
        <pre className="max-h-64 overflow-y-auto border-t border-line whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-ink">
          {cmd}
        </pre>
      </details>

      <p className="mt-2 text-xs leading-relaxed text-stone">
        {kind === "docker"
          ? t("nodes.dockerNote")
          : issued.os === "windows"
            ? t("nodes.windowsNote")
            : t("nodes.unixNote")}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!hasCA ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => window.open(caDownloadURL(), "_blank", "noopener")}
          >
            {t("nodes.downloadGateCa")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </>
  );
}
