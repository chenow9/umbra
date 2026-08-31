import type { MappingMode } from "./types";

export const modeLabel: Record<MappingMode, string> = {
  public: "public",
  spa: "spa",
  visitor: "visitor",
};

export const modeHint: Record<MappingMode, string> = {
  public: "公开访问",
  spa: "敲门访问",
  visitor: "加密隧道访问",
};

export const listenLabel: Record<string, string> = {
  listening: "监听中",
  ready: "就绪",
  pending: "待推送",
  disabled: "已停",
  error: "失败",
};

export const pushLabel: Record<string, string> = {
  acked: "已确认",
  pending: "已下发",
  pending_offline: "等待上线",
  error: "下发失败",
};

export const reachLabel: Record<string, string> = {
  open: "外网可连",
  full: "连接已满",
  closed: "未敲门",
  visitor: "需签发",
  offline: "节点离线",
  pending: "等待确认",
  error: "无法开流",
  disabled: "已停用",
};

export const dropReasonLabel: Record<string, string> = {
  maxconns: "连接已满",
  acl: "网段不允许",
  spa: "未敲门",
  offline: "当时节点离线",
  splice: "入口配额已满",
  tunnel: "隧道开流失败",
  per_ip: "单 IP 流过多",
  rate: "新建过快",
};

export function policyBits(
  maxConns: number,
  idleTimeoutSec: number | undefined,
  proto: string,
  extra?: { spaTtlSec?: number; udpIdleTimeoutSec?: number; mode?: string; rateKbps?: number },
) {
  const bits = [`${maxConns || 1024} 路`];
  if (extra?.mode === "spa") bits.push(`敲门 ${extra.spaTtlSec || 60}s`);
  if (proto === "udp") {
    bits.push(`空闲 ${extra?.udpIdleTimeoutSec || idleTimeoutSec || 60}s`);
  } else if (idleTimeoutSec) {
    bits.push(`空闲 ${idleTimeoutSec}s`);
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

export const frameLabel: Record<string, string> = {
  Enroll: "登记",
  EnrollOk: "登记完成",
  Hello: "握手",
  HelloOk: "全量下发",
  MappingSync: "增量推送",
  MappingAck: "确认",
  Heartbeat: "心跳",
  OpenStream: "开流",
  CloseStream: "关流",
  Knock: "敲门",
  KnockOk: "放行",
  Dropped: "丢弃",
  Visit: "探访",
  Revoked: "吊销",
};

export const actionLabel: Record<string, string> = {
  "node.create": "登记节点",
  "node.update": "修改节点",
  "node.delete": "删除节点",
  "node.enroll": "节点登记",
  "node.offline": "节点离线",
  "node.rotate": "轮换凭证",
  "node.hello": "Hello 全量下发",
  "mapping.ack": "映射确认",
  "mapping.ack_fail": "映射确认失败",
  "acl.drop": "ACL 丢弃",
  "mapping.push": "MappingSync",
  "mapping.probe": "探测开流",
  "mapping.knock": "敲门",
  "mapping.visit": "探访",
  "visitor.issue": "签发",
  "visitor.revoke": "作废票据",
  "node.disconnect": "节点离线",
  "node.revoke": "吊销凭证",
  "mapping.create": "新建映射",
  "mapping.update": "修改映射",
  "mapping.policy": "更新策略",
  "mapping.delete": "删除映射",
  "mapping.enable": "启用映射",
  "mapping.disable": "停用映射",
  "demo.run": "跑通演示",
};
