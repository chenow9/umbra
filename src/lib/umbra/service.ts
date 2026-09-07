import { t } from "../i18n/index.ts";
import type { Mapping, MappingMode, Proto } from "./types.ts";

export function accessOptions(): { mode: MappingMode; label: string; description: string }[] {
  return [
    {
      mode: "visitor",
      label: t("mode.visitor.label"),
      description: t("access.visitor"),
    },
    {
      mode: "spa",
      label: t("mode.spa.label"),
      description: t("access.spa"),
    },
    {
      mode: "public",
      label: t("mode.public.label"),
      description: t("access.public"),
    },
  ];
}

export type ServiceInput = {
  name: string;
  nodeId: string;
  proto: Proto;
  mode: MappingMode;
  entryPort: number | null;
  localHost: string;
  localPort: number;
  maxConns: number;
  idleTimeoutSec: number;
  spaTtlSec: number;
  udpIdleTimeoutSec: number;
  rateKbps: number;
  allowCidrs: string;
};

export function validateService(input: ServiceInput): string | null {
  if (!input.name.trim()) return t("validate.name");
  if (!input.nodeId) return t("validate.node");
  if (!input.localHost.trim()) return t("validate.host");
  if (!validPort(input.localPort)) return t("validate.localPort");
  if (input.mode !== "visitor" && !validPort(input.entryPort)) return t("validate.entryPort");
  if (input.mode === "visitor" && input.entryPort !== null) return t("validate.visitorPort");
  if (
    ![
      input.maxConns,
      input.idleTimeoutSec,
      input.spaTtlSec,
      input.udpIdleTimeoutSec,
      input.rateKbps,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return t("validate.advanced");
  return null;
}

function validPort(value: number | null) {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export type ServiceState = {
  kind: "ready" | "attention" | "pending" | "disabled";
  label: string;
  detail: string;
  next: string;
  tone: "online" | "error" | "pending" | "offline";
};

// Readiness is configuration evidence, never proof of external or application health.
export function serviceState(m: Mapping): ServiceState {
  if (!m.enabled)
    return {
      kind: "disabled",
      label: t("serviceState.disabled.label"),
      detail: t("serviceState.disabled.detail"),
      next: t("serviceState.disabled.next"),
      tone: "offline",
    };
  if (m.nodeStatus !== "online" || m.pushState === "pending_offline")
    return {
      kind: "attention",
      label: t(m.nodeStatus === "revoked" ? "serviceState.revoked.label" : "serviceState.offline.label"),
      detail: t(
        m.nodeStatus === "revoked" ? "serviceState.revoked.detail" : "serviceState.offline.detail",
        { node: m.nodeName },
      ),
      next: t(m.nodeStatus === "revoked" ? "serviceState.revoked.next" : "serviceState.offline.next"),
      tone: "error",
    };
  if (m.listenError || m.listenState === "error" || m.pushState === "error")
    return {
      kind: "attention",
      label: t("serviceState.configError.label"),
      detail: m.listenError || t("serviceState.configError.detailFallback"),
      next: t("serviceState.configError.next"),
      tone: "error",
    };
  if (m.pushState !== "acked")
    return {
      kind: "pending",
      label: t("serviceState.waitAck.label"),
      detail: t("serviceState.waitAck.detail"),
      next: t("serviceState.waitAck.next"),
      tone: "pending",
    };
  if (m.mode !== "visitor" && m.listenState !== "listening" && m.listenState !== "ready")
    return {
      kind: "pending",
      label: t("serviceState.waitListen.label"),
      detail: t("serviceState.waitListen.detail"),
      next: t("serviceState.waitListen.next"),
      tone: "pending",
    };
  if (
    m.maxConns > 0 &&
    (m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns) >= m.maxConns
  )
    return {
      kind: "attention",
      label: t("serviceState.full.label"),
      detail: t("serviceState.full.detail", { n: m.maxConns }),
      next: t("serviceState.full.next"),
      tone: "error",
    };
  if (m.lastProbeError)
    return {
      kind: "attention",
      label: t("serviceState.probeFail.label"),
      detail: t("serviceState.probeFail.detail"),
      next: t("serviceState.probeFail.next"),
      tone: "pending",
    };
  return {
    kind: "ready",
    label: t("serviceState.ready.label"),
    detail: t("serviceState.ready.detail"),
    next: t(
      m.mode === "visitor"
        ? "serviceState.ready.nextVisitor"
        : m.mode === "spa"
          ? "serviceState.ready.nextSpa"
          : "serviceState.ready.nextPublic",
    ),
    tone: "online",
  };
}

export function targetAddress(host: string, port: number) {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function serviceSummary(mappings: Mapping[]) {
  const result = { total: mappings.length, ready: 0, attention: 0, pending: 0, disabled: 0 };
  for (const mapping of mappings) result[serviceState(mapping).kind]++;
  return result;
}

export function serviceMatches(m: Mapping, query: string) {
  const accessHay =
    m.mode === "visitor"
      ? "凭证访问 ticket access"
      : m.mode === "spa"
        ? "临时放行 knock spa"
        : "公开访问 public access";
  const text =
    `${m.name} ${m.nodeName} ${m.proto} ${m.mode} ${m.localHost} ${m.localPort} ${m.entryPort ?? ""} ${accessHay}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export function serviceCanConnect(mapping: Mapping): boolean {
  return serviceState({ ...mapping, lastProbeError: undefined }).kind === "ready";
}
