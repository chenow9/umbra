"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CheckField, SelectField, TextField } from "@/components/field";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { IssuedDialog, type Issued } from "@/components/nodes/issued-dialog";
import { statusText, useI18n } from "@/lib/i18n";
import { ApiError, applyConfigImport, exportConfig, previewConfigImport } from "@/lib/umbra/api";
import {
  buildExportRequest,
  defaultSelection,
  downloadJson,
  exportFilename,
  previewServices,
  readBundleFile,
  retargetBinding,
  serviceLine,
  setAllMatchedAction,
  setServiceAction,
  suggestBindings,
  withServiceActions,
  type ConfigBundle,
  type ExportSelection,
  type ImportBinding,
  type ImportPreview,
  type ImportResult,
  type PreviewService,
} from "@/lib/umbra/transfer";
import type { Mapping, Node } from "@/lib/umbra/types";
import { ARCHS, PLATFORMS, type Arch, type Platform } from "@/lib/umbra/units";
import { cn } from "@/lib/utils";

type Mode = "export" | "import" | null;
type ImportStep = "file" | "bind" | "preview" | "result";

export function ConfigTransfer({
  mode,
  nodes,
  mappings,
  preselectNodeId,
  onClose,
  onApplied,
}: {
  mode: Mode;
  nodes: Node[];
  mappings: Mapping[];
  preselectNodeId?: string;
  onClose: () => void;
  onApplied?: () => void;
}) {
  return (
    <>
      <ExportSheet
        open={mode === "export"}
        nodes={nodes}
        mappings={mappings}
        preselectNodeId={preselectNodeId}
        onClose={onClose}
      />
      <ImportSheet
        open={mode === "import"}
        preselectNodeId={preselectNodeId}
        onClose={onClose}
        onApplied={onApplied}
      />
    </>
  );
}

function ExportSheet({
  open,
  nodes,
  mappings,
  preselectNodeId,
  onClose,
}: {
  open: boolean;
  nodes: Node[];
  mappings: Mapping[];
  preselectNodeId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const usable = nodes.filter((node) => node.status !== "revoked");
  const [selection, setSelection] = useState<ExportSelection>({});
  const nodeKey = `${preselectNodeId ?? ""}:${usable.map((n) => n.id).join(",")}`;
  useEffect(() => {
    if (open) setSelection(defaultSelection(nodes, preselectNodeId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeKey encodes nodes and preselect
  }, [open, nodeKey]);
  const exportMut = useMutation({
    mutationFn: () => exportConfig({ data: buildExportRequest(selection) }),
    onSuccess: (bundle) => {
      downloadJson(exportFilename(), bundle);
      toast.success(t("transfer.exported"));
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const selectedNodes = Object.keys(selection).length;
  const selectedServices = Object.entries(selection).reduce((n, [nodeId, services]) => {
    if (services === "all") return n + mappings.filter((m) => m.nodeId === nodeId).length;
    return n + services.length;
  }, 0);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t("transfer.exportTitle")}</SheetTitle>
          <SheetDescription>{t("transfer.exportHint")}</SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSelection(defaultSelection(usable))}
            >
              {t("transfer.selectAll")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelection({})}>
              {t("transfer.selectNone")}
            </Button>
          </div>
          {usable.length === 0 ? (
            <p className="text-sm text-stone">{t("transfer.noNodes")}</p>
          ) : (
            <ul className="space-y-2">
              {usable.map((node) => {
                const nodeServices = mappings.filter((m) => m.nodeId === node.id);
                const picked = selection[node.id];
                const nodeOn = picked !== undefined;
                return (
                  <li key={node.id} className="rounded-xl bg-paper-2 p-3 shadow-border">
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-[var(--pine)]"
                        checked={nodeOn}
                        onChange={(e) => {
                          const next = { ...selection };
                          if (e.target.checked) next[node.id] = "all";
                          else delete next[node.id];
                          setSelection(next);
                        }}
                      />
                      <span>
                        <span className="font-medium">{node.name}</span>
                        <span className="ml-2 text-xs text-stone">
                          {t("nodes.services", { count: nodeServices.length })}
                        </span>
                      </span>
                    </label>
                    {nodeOn && nodeServices.length > 0 ? (
                      <ul className="mt-2 space-y-1 pl-7 text-sm">
                        {nodeServices.map((service) => {
                          const checked =
                            picked === "all" || (Array.isArray(picked) && picked.includes(service.id));
                          return (
                            <li key={service.id}>
                              <label className="flex cursor-pointer items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 size-4 accent-[var(--pine)]"
                                  checked={checked}
                                  onChange={(e) => {
                                    const current =
                                      picked === "all" ? nodeServices.map((s) => s.id) : [...(picked ?? [])];
                                    const nextIds = e.target.checked
                                      ? [...current, service.id]
                                      : current.filter((id) => id !== service.id);
                                    const next = { ...selection };
                                    if (nextIds.length === 0) delete next[node.id];
                                    else if (nextIds.length === nodeServices.length) next[node.id] = "all";
                                    else next[node.id] = nextIds;
                                    setSelection(next);
                                  }}
                                />
                                <span>
                                  {service.name}
                                  <span className="ml-2 text-xs text-stone">
                                    {serviceLine(service)}
                                    {service.enabled ? "" : ` · ${t("services.disabled")}`}
                                  </span>
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SheetBody>
        <SheetFooter className="flex items-center justify-between gap-2">
          <p className="text-xs text-stone">
            {t("transfer.exportCount", { nodes: selectedNodes, services: selectedServices })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={selectedNodes === 0 || exportMut.isPending}
              onClick={() => exportMut.mutate()}
            >
              {exportMut.isPending ? t("common.pending") : t("transfer.download")}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ImportSheet({
  open,
  preselectNodeId,
  onClose,
  onApplied,
}: {
  open: boolean;
  preselectNodeId?: string;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [step, setStep] = useState<ImportStep>("file");
  const [bundle, setBundle] = useState<ConfigBundle | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [bindings, setBindings] = useState<ImportBinding[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [issuedQueue, setIssuedQueue] = useState<Issued[]>([]);
  const reset = () => {
    setStep("file");
    setBundle(null);
    setPreview(null);
    setBindings([]);
    setResult(null);
    setIssued(null);
    setIssuedQueue([]);
  };
  useEffect(() => {
    if (open) reset();
  }, [open]);

  const parseMut = useMutation({
    mutationFn: (file: File) =>
      readBundleFile(file).then((parsed) => previewConfigImport({ data: { bundle: parsed } }).then((p) => ({ parsed, p }))),
    onSuccess: ({ parsed, p }) => {
      setBundle(parsed);
      setPreview(p);
      const suggested = suggestBindings(p).map((binding) =>
        preselectNodeId && p.localNodes.some((n) => n.id === preselectNodeId && n.enabled)
          ? { ...binding, action: "bind" as const, localNodeId: preselectNodeId }
          : binding,
      );
      setBindings(suggested);
      setStep("bind");
    },
    onError: (e: Error) => toast.error(e.message === "file too large" ? t("transfer.fileTooLarge") : e.message),
  });

  const previewMut = useMutation({
    mutationFn: (next: ImportBinding[]) =>
      previewConfigImport({ data: { bundle: bundle!, bindings: next } }),
    onSuccess: (p) => {
      setPreview(p);
      setBindings((current) => withServiceActions(current, p));
      setStep("preview");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => applyConfigImport({ data: { bundle: bundle!, bindings } }),
    onSuccess: (imported) => {
      setResult(imported);
      setStep("result");
      onApplied?.();
      void qc.invalidateQueries({ queryKey: ["umbra"] });
      const created = imported.nodes
        .filter((n) => n.action === "create" && n.token)
        .map(
          (n): Issued => ({
            id: n.localId,
            token: n.token!,
            os: ((n.os as Platform) || "linux") as Platform,
            arch: ((n.arch as Arch) || "amd64") as Arch,
            installCmd: n.installCmd,
            dockerCmd: n.dockerCmd,
            listen: n.listen,
            caPem: n.caPem,
            expiresAt: n.expiresAt,
            neverExpire: n.neverExpire,
            name: n.name,
          }),
        );
      if (created.length) {
        setIssued(created[0]);
        setIssuedQueue(created.slice(1));
      }
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.status === 409 && e.body && typeof e.body === "object") {
        setPreview(e.body as ImportPreview);
        toast.error(e.message);
        return;
      }
      toast.error(e.message);
    },
  });

  const bindable = useMemo(
    () => (preview?.localNodes ?? []).filter((n) => n.enabled && n.status !== "revoked"),
    [preview],
  );

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <SheetContent side="right" className="max-w-2xl">
          <SheetHeader>
            <SheetTitle>{t("transfer.importTitle")}</SheetTitle>
            <SheetDescription>{t("transfer.importHint")}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <ol className="flex flex-wrap gap-2 text-xs text-stone" aria-label={t("transfer.steps")}>
              {(["file", "bind", "preview", "result"] as ImportStep[]).map((item) => (
                <li
                  key={item}
                  className={cn("rounded-full px-2.5 py-1", step === item ? "bg-pine text-pine-fg" : "bg-paper-2")}
                >
                  {t(`transfer.step.${item}`)}
                </li>
              ))}
            </ol>
            {step !== "file" ? (
              <p className="rounded-lg border border-line bg-paper-2 p-3 text-xs leading-relaxed text-ink-soft">
                {t("transfer.tunnelWarning")}
              </p>
            ) : null}

            {step === "file" ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-soft">{t("transfer.pickFile")}</p>
                <input
                  type="file"
                  accept="application/json,.json"
                  aria-label={t("transfer.pickFile")}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) parseMut.mutate(file);
                  }}
                />
                {parseMut.isPending ? <p className="text-sm text-stone">{t("common.pending")}</p> : null}
              </div>
            ) : null}

            {step === "bind" && preview ? (
              <div className="space-y-3">
                {bindings.map((binding, index) => {
                  const src = preview.nodes.find((n) => n.originId === binding.originNodeId);
                  if (!src) return null;
                  return (
                    <section key={binding.originNodeId} className="rounded-xl bg-paper-2 p-3 shadow-border">
                      <h3 className="text-sm font-medium">
                        {src.name}
                        <span className="ml-2 text-xs font-normal text-stone">
                          {t("nodes.services", { count: previewServices(src).length })}
                        </span>
                      </h3>
                      {src.comment ? <p className="mt-1 text-xs text-stone">{src.comment}</p> : null}
                      <div className="mt-3 flex flex-col gap-2 text-sm">
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`bind-${binding.originNodeId}`}
                            checked={binding.action === "create"}
                            onChange={() => {
                              const next = [...bindings];
                              next[index] = retargetBinding(binding, { action: "create" });
                              setBindings(next);
                            }}
                          />
                          {t("transfer.createNode")}
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`bind-${binding.originNodeId}`}
                            checked={binding.action === "bind"}
                            disabled={bindable.length === 0}
                            onChange={() => {
                              const next = [...bindings];
                              next[index] = retargetBinding(binding, {
                                action: "bind",
                                localNodeId: binding.localNodeId || bindable[0]?.id,
                              });
                              setBindings(next);
                            }}
                          />
                          {t("transfer.bindNode")}
                        </label>
                      </div>
                      {binding.action === "create" ? (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <TextField
                            label={t("nodes.name")}
                            value={binding.name ?? ""}
                            onChange={(e) => {
                              const next = [...bindings];
                              next[index] = { ...binding, name: e.target.value };
                              setBindings(next);
                            }}
                          />
                          <CheckField
                            label={t("nodes.neverExpire")}
                            checked={Boolean(binding.neverExpire)}
                            onChange={(v) => {
                              const next = [...bindings];
                              next[index] = { ...binding, neverExpire: v };
                              setBindings(next);
                            }}
                          />
                          <SelectField
                            label={t("nodes.os")}
                            value={binding.os || "linux"}
                            onValueChange={(v) => {
                              const next = [...bindings];
                              next[index] = { ...binding, os: v };
                              setBindings(next);
                            }}
                            options={PLATFORMS.map((p) => ({ value: p.id, label: p.label }))}
                          />
                          <SelectField
                            label={t("nodes.arch")}
                            value={binding.arch || "amd64"}
                            onValueChange={(v) => {
                              const next = [...bindings];
                              next[index] = { ...binding, arch: v };
                              setBindings(next);
                            }}
                            options={ARCHS.map((p) => ({ value: p.id, label: p.label }))}
                          />
                        </div>
                      ) : (
                        <div className="mt-3">
                          <SelectField
                            label={t("transfer.targetNode")}
                            value={binding.localNodeId ?? ""}
                            onValueChange={(v) => {
                              const next = [...bindings];
                              next[index] = retargetBinding(binding, { action: "bind", localNodeId: v });
                              setBindings(next);
                            }}
                            options={bindable.map((n) => ({
                              value: n.id,
                              label: `${n.name} · ${statusText(n.status)}`,
                            }))}
                          />
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : null}

            {step === "preview" && preview ? (
              <PreviewBody
                preview={preview}
                bindings={bindings}
                onBindings={(next) => {
                  setBindings(next);
                  previewMut.mutate(next);
                }}
              />
            ) : null}

            {step === "result" && result ? <ResultBody result={result} onShowIssued={setIssued} /> : null}
          </SheetBody>
          <SheetFooter className="flex items-center justify-end gap-2">
            {step === "file" ? (
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
            ) : null}
            {step === "bind" ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setStep("file")}>
                  {t("transfer.back")}
                </Button>
                <Button
                  type="button"
                  disabled={previewMut.isPending || bindings.some((b) => b.action === "bind" && !b.localNodeId)}
                  onClick={() => previewMut.mutate(bindings)}
                >
                  {previewMut.isPending ? t("common.pending") : t("transfer.next")}
                </Button>
              </>
            ) : null}
            {step === "preview" ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setStep("bind")}>
                  {t("transfer.back")}
                </Button>
                <Button
                  type="button"
                  disabled={!preview?.canApply || applyMut.isPending}
                  onClick={() => applyMut.mutate()}
                >
                  {applyMut.isPending ? t("common.pending") : t("transfer.confirm")}
                </Button>
              </>
            ) : null}
            {step === "result" ? (
              <Button type="button" onClick={onClose}>
                {t("common.done")}
              </Button>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <IssuedDialog
        issued={issued}
        onClose={() => {
          if (issuedQueue.length) {
            setIssued(issuedQueue[0]);
            setIssuedQueue(issuedQueue.slice(1));
            return;
          }
          setIssued(null);
        }}
      />
    </>
  );
}

function PreviewBody({
  preview,
  bindings,
  onBindings,
}: {
  preview: ImportPreview;
  bindings: ImportBinding[];
  onBindings: (next: ImportBinding[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      {preview.errors?.length ? (
        <div role="alert" className="rounded-lg border border-rose/25 p-3 text-sm text-rose">
          {preview.errors.map((err) => (
            <p key={err}>{err}</p>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-stone">
        {t("transfer.summary", {
          create: preview.summary.servicesCreate,
          update: preview.summary.servicesUpdate,
          skip: preview.summary.servicesSkip,
          conflicts: preview.summary.conflicts,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onBindings(setAllMatchedAction(bindings, preview, "skip"))}
        >
          {t("transfer.skipMatched")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onBindings(setAllMatchedAction(bindings, preview, "update"))}
        >
          {t("transfer.updateMatched")}
        </Button>
      </div>
      {preview.nodes.map((node) => (
        <details key={node.originId} open className="rounded-xl bg-paper-2 p-3 shadow-border">
          <summary className="cursor-pointer text-sm font-medium">
            {node.action === "bind"
              ? t("transfer.bindAs", { src: node.name, dst: node.localNodeName ?? node.localNodeId ?? "" })
              : t("transfer.createAs", { name: node.name })}
            {node.error ? <span className="ml-2 text-rose">{node.reason}</span> : null}
          </summary>
          <ul className="mt-2 space-y-2">
            {previewServices(node).map((service) => (
              <ServicePreviewRow
                key={service.originId}
                service={service}
                onAction={(action) => {
                  onBindings(setServiceAction(bindings, node.originId, service.originId, action));
                }}
              />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function ServicePreviewRow({
  service,
  onAction,
}: {
  service: PreviewService;
  onAction: (action: "create" | "update" | "skip") => void;
}) {
  const { t } = useI18n();
  return (
    <li className={cn("rounded-lg p-2 text-sm", service.error && "border border-rose/25")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {service.name}
            {service.enabled ? null : (
              <span className="ml-2 text-xs font-normal text-stone">{t("services.disabled")}</span>
            )}
          </p>
          <p className="text-xs text-stone">{serviceLine(service)}</p>
          {service.reason ? (
            <p className={cn("mt-1 text-xs", service.error ? "text-rose" : "text-stone")}>{service.reason}</p>
          ) : null}
          {service.diff?.length ? (
            <ul className="mt-1 text-xs text-stone">
              {service.diff.map((d) => (
                <li key={d.field}>
                  {t(`transfer.field.${d.field}`)}: {String(d.from ?? "—")} → {String(d.to ?? "—")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {service.matchedLocalId ? (
          <div className="flex gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={service.action === "skip"}
                onChange={() => onAction("skip")}
              />
              {t("transfer.skip")}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={service.action === "update"}
                onChange={() => onAction("update")}
              />
              {t("transfer.update")}
            </label>
          </div>
        ) : (
          <div className="flex gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={service.action !== "skip"}
                onChange={() => onAction("create")}
              />
              {t("transfer.willCreate")}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={service.action === "skip"}
                onChange={() => onAction("skip")}
              />
              {t("transfer.skip")}
            </label>
          </div>
        )}
      </div>
    </li>
  );
}

function ResultBody({
  result,
  onShowIssued,
}: {
  result: ImportResult;
  onShowIssued: (issued: Issued) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-line bg-paper-2 p-3 text-sm">{t("transfer.saved")}</p>
      <ul className="space-y-2">
        {result.nodes.map((node) => (
          <li key={node.localId} className="rounded-xl bg-paper-2 p-3 text-sm shadow-border">
            <p className="font-medium">
              {node.name}
              <span className="ml-2 text-xs font-normal text-stone">
                {node.action === "create" ? t("transfer.createdNode") : t("transfer.boundNode")}
              </span>
            </p>
            {node.token ? (
              <Button
                type="button"
                size="sm"
                className="mt-2"
                onClick={() =>
                  onShowIssued({
                    id: node.localId,
                    token: node.token!,
                    os: ((node.os as Platform) || "linux") as Platform,
                    arch: ((node.arch as Arch) || "amd64") as Arch,
                    installCmd: node.installCmd,
                    dockerCmd: node.dockerCmd,
                    listen: node.listen,
                    caPem: node.caPem,
                    expiresAt: node.expiresAt,
                    neverExpire: node.neverExpire,
                    name: node.name,
                  })
                }
              >
                {t("transfer.showEnroll")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <ul className="space-y-1 text-sm">
        {(result.services ?? []).map((service) => (
          <li key={`${service.originId}:${service.localId ?? "skip"}`} className="flex justify-between gap-2">
            <span>{service.name}</span>
            <span className="text-xs text-stone">{t(`transfer.result.${service.result}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
