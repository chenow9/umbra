import type { Mapping, MappingMode, Proto } from "./types.ts";

export const accessOptions: { mode: MappingMode; label: string; description: string }[] = [
  {
    mode: "visitor",
    label: "凭证访问",
    description: "推荐用于私有服务。公网不开放业务端口，访问方运行带票据的客户端。",
  },
  {
    mode: "spa",
    label: "临时放行",
    description: "访问前为来源 IP 临时授权，再使用原有客户端连接。",
  },
  {
    mode: "public",
    label: "公开访问",
    description: "直接通过入口端口连接，可被扫描发现。适合公开服务或已具备强认证的应用。",
  },
];

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
  if (!input.name.trim()) return "请填写服务名称。";
  if (!input.nodeId) return "请选择承载服务的节点。";
  if (!input.localHost.trim()) return "请填写节点可以访问的目标地址。";
  if (!validPort(input.localPort)) return "目标端口应为 1–65535 的整数。";
  if (input.mode !== "visitor" && !validPort(input.entryPort))
    return "公网入口端口应为 1–65535 的整数。";
  if (input.mode === "visitor" && input.entryPort !== null) return "凭证访问不占用公网业务端口。";
  if (
    ![
      input.maxConns,
      input.idleTimeoutSec,
      input.spaTtlSec,
      input.udpIdleTimeoutSec,
      input.rateKbps,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return "高级设置应为非负整数。";
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
      label: "已停用",
      detail: "不会接受新的连接。",
      next: "需要访问时启用服务。",
      tone: "offline",
    };
  if (m.nodeStatus !== "online" || m.pushState === "pending_offline")
    return {
      kind: "attention",
      label: m.nodeStatus === "revoked" ? "节点已吊销" : "节点离线",
      detail: `无法通过 ${m.nodeName} 连接目标。`,
      next:
        m.nodeStatus === "revoked"
          ? "选择有效节点后重新保存服务。"
          : "检查节点进程和到入口的网络连接。",
      tone: "error",
    };
  if (m.listenError || m.listenState === "error" || m.pushState === "error")
    return {
      kind: "attention",
      label: "配置异常",
      detail: m.listenError || "节点未能应用配置。",
      next: "检查入口端口是否被占用，以及节点返回的错误。",
      tone: "error",
    };
  if (m.pushState !== "acked")
    return {
      kind: "pending",
      label: "等待确认",
      detail: "配置已保存，尚未收到节点确认。",
      next: "状态会自动更新；长时间未确认时检查节点连接。",
      tone: "pending",
    };
  if (m.mode !== "visitor" && m.listenState !== "listening" && m.listenState !== "ready")
    return {
      kind: "pending",
      label: "等待入口",
      detail: "节点已确认，入口尚未开始监听。",
      next: "等待入口就绪，或检查入口日志。",
      tone: "pending",
    };
  if (
    m.maxConns > 0 &&
    (m.proto === "udp" ? (m.udpActive ?? m.activeConns) : m.activeConns) >= m.maxConns
  )
    return {
      kind: "attention",
      label: "连接已满",
      detail: `已达到 ${m.maxConns} 路连接上限。`,
      next: "等待现有连接结束，或调整连接上限。",
      tone: "error",
    };
  if (m.lastProbeError)
    return {
      kind: "attention",
      label: "探测未获响应",
      detail: "配置已就绪，但最近一次测试未取得目标响应。",
      next: "检查目标地址与协议，或用业务客户端验证。未响应测试报文不等于服务不可用。",
      tone: "pending",
    };
  return {
    kind: "ready",
    label: "配置就绪",
    detail: "节点已确认配置，目标响应仍需实际验证。",
    next:
      m.mode === "visitor"
        ? "签发访问命令，在访问方电脑运行。"
        : m.mode === "spa"
          ? "临时放行你的来源 IP，再连接入口地址。"
          : "使用业务客户端连接入口地址。",
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
  const text =
    `${m.name} ${m.nodeName} ${m.proto} ${m.mode} ${m.localHost} ${m.localPort} ${m.entryPort ?? ""} ${accessOptions.find((o) => o.mode === m.mode)?.label ?? ""}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export function serviceCanConnect(mapping: Mapping): boolean {
  return serviceState({ ...mapping, lastProbeError: undefined }).kind === "ready";
}
