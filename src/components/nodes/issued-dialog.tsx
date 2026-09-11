"use client";

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { caDownloadURL, listNodes } from "@/lib/umbra/api";
import {
  nodeEnrollDockerCmd,
  nodeEnrollServiceCmd,
  type Arch,
  type Platform,
} from "@/lib/umbra/units";

export type Issued = {
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
  name?: string;
};

export function IssuedDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={issued !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{issued?.name ? issued.name : t("nodes.issuedTitle")}</DialogTitle>
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
