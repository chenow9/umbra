import { t } from "../i18n/index.ts";
import type { MappingMode } from "./types";

export const modeLabel: Record<MappingMode, string> = {
  public: "public",
  spa: "spa",
  visitor: "visitor",
};

export function modeHint(): Record<MappingMode, string> {
  return {
    public: t("mode.public.hint"),
    spa: t("mode.spa.hint"),
    visitor: t("mode.visitor.hint"),
  };
}

export function listenLabel(): Record<string, string> {
  return {
    listening: t("listen.listening"),
    ready: t("listen.ready"),
    pending: t("listen.pending"),
    disabled: t("listen.disabled"),
    error: t("listen.error"),
  };
}

export function pushLabel(): Record<string, string> {
  return {
    acked: t("push.acked"),
    pending: t("push.pending"),
    pending_offline: t("push.pending_offline"),
    error: t("push.error"),
  };
}

export function reachLabel(): Record<string, string> {
  return {
    open: t("reach.open"),
    full: t("reach.full"),
    closed: t("reach.closed"),
    visitor: t("reach.visitor"),
    offline: t("reach.offline"),
    pending: t("reach.pending"),
    error: t("reach.error"),
    disabled: t("reach.disabled"),
  };
}

export function dropReasonLabel(): Record<string, string> {
  return {
    maxconns: t("drop.maxconns"),
    acl: t("drop.acl"),
    spa: t("drop.spa"),
    offline: t("drop.offline"),
    splice: t("drop.splice"),
    tunnel: t("drop.tunnel"),
    per_ip: t("drop.per_ip"),
    rate: t("drop.rate"),
  };
}

const AUDIT_CANONICAL: Record<string, string> = {
  "node.enroll": "node.create",
  "node.disconnect": "node.offline",
};

export function canonicalAuditAction(action: string) {
  return AUDIT_CANONICAL[action] ?? action;
}

export function actionLabel(): Record<string, string> {
  const create = t("action.node.create");
  const offline = t("action.node.offline");
  return {
    "node.create": create,
    "node.update": t("action.node.update"),
    "node.delete": t("action.node.delete"),
    "node.enroll": create,
    "node.offline": offline,
    "node.rotate": t("action.node.rotate"),
    "node.hello": t("action.node.hello"),
    "mapping.ack": t("action.mapping.ack"),
    "mapping.ack_fail": t("action.mapping.ack_fail"),
    "acl.drop": t("action.acl.drop"),
    "mapping.push": t("action.mapping.push"),
    "mapping.probe": t("action.mapping.probe"),
    "mapping.knock": t("action.mapping.knock"),
    "mapping.visit": t("action.mapping.visit"),
    "visitor.issue": t("action.visitor.issue"),
    "visitor.revoke": t("action.visitor.revoke"),
    "node.disconnect": offline,
    "node.revoke": t("action.node.revoke"),
    "mapping.create": t("action.mapping.create"),
    "mapping.update": t("action.mapping.update"),
    "mapping.policy": t("action.mapping.policy"),
    "mapping.delete": t("action.mapping.delete"),
    "mapping.enable": t("action.mapping.enable"),
    "mapping.disable": t("action.mapping.disable"),
    "demo.run": t("action.demo.run"),
    "auth.password.changed": t("action.auth.password.changed"),
    "auth.2fa.enrolled": t("action.auth.2fa.enrolled"),
    "auth.2fa.replaced": t("action.auth.2fa.replaced"),
    "auth.2fa.recovery_used": t("action.auth.2fa.recovery_used"),
    "auth.2fa.recovery_regenerated": t("action.auth.2fa.recovery_regenerated"),
    "auth.2fa.local_reset": t("action.auth.2fa.local_reset"),
  };
}

export function auditActionOptions(): { value: string; label: string }[] {
  const labels = actionLabel();
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const [value, label] of Object.entries(labels)) {
    const canonical = canonicalAuditAction(value);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ value: canonical, label });
  }
  return out;
}

export function auditActorLabel(actor: string) {
  if (!actor || actor === "owner") return t("audit.admin");
  if (actor === "gateway") return t("audit.gateway");
  return actor;
}

function looksLikeUmbraID(value: string) {
  return /^(nde|map|tkt)_/i.test(value.trim());
}

export function humanAuditName(detail?: string) {
  const text = detail?.trim() ?? "";
  if (!text || looksLikeUmbraID(text) || text.includes("=")) return "";
  if (/^(SPA |Hello)/i.test(text)) return "";
  const fields = text.split(/\s+/);
  const last = fields[fields.length - 1] ?? "";
  if (fields.length >= 2 && last.includes("/") && !looksLikeUmbraID(fields[0])) {
    return fields.slice(0, -1).join(" ");
  }
  return text;
}

export function auditTargetLabel(item: { target: string; targetName?: string; detail?: string }) {
  for (const candidate of [item.targetName, humanAuditName(item.detail), item.target]) {
    const value = candidate?.trim();
    if (value && !looksLikeUmbraID(value)) return value;
  }
  return item.target || "—";
}

export function auditTargetHint(item: { target: string; targetName?: string; detail?: string }) {
  const label = auditTargetLabel(item);
  if (item.target && item.target !== label) return item.target;
  return undefined;
}

export function policyBits(
  maxConns: number,
  idleTimeoutSec: number | undefined,
  proto: string,
  extra?: { spaTtlSec?: number; udpIdleTimeoutSec?: number; mode?: string; rateKbps?: number },
) {
  const bits = [t("policy.conns", { n: maxConns || 1024 })];
  if (extra?.mode === "spa") bits.push(t("policy.knock", { n: extra.spaTtlSec || 60 }));
  if (proto === "udp") {
    bits.push(t("policy.idle", { n: extra?.udpIdleTimeoutSec || idleTimeoutSec || 60 }));
  } else if (idleTimeoutSec) {
    bits.push(t("policy.idle", { n: idleTimeoutSec }));
  }
  if (extra?.rateKbps) bits.push(`${extra.rateKbps} KB/s`);
  return bits;
}

export function policyLine(
  maxConns: number,
  idleTimeoutSec: number | undefined,
  proto: string,
  extra?: { spaTtlSec?: number; udpIdleTimeoutSec?: number; mode?: string; rateKbps?: number },
) {
  return policyBits(maxConns, idleTimeoutSec, proto, extra).join(" · ");
}

export function frameLabel(): Record<string, string> {
  return {
    Enroll: t("frame.Enroll"),
    EnrollOk: t("frame.EnrollOk"),
    Hello: t("frame.Hello"),
    HelloOk: t("frame.HelloOk"),
    MappingSync: t("frame.MappingSync"),
    MappingAck: t("frame.MappingAck"),
    Heartbeat: t("frame.Heartbeat"),
    OpenStream: t("frame.OpenStream"),
    CloseStream: t("frame.CloseStream"),
    Knock: t("frame.Knock"),
    KnockOk: t("frame.KnockOk"),
    Dropped: t("frame.Dropped"),
    Visit: t("frame.Visit"),
    Revoked: t("frame.Revoked"),
  };
}
