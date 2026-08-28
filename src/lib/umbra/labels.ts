import type { MappingMode } from "./types";

export const modeLabel: Record<MappingMode, string> = {
  visitor: "访客",
  spa: "暗端口",
  public: "公开",
};

export const listenLabel: Record<string, string> = {
  listening: "监听中",
  ready: "就绪",
  pending: "待推送",
  disabled: "已停",
  error: "失败",
};

export const pushLabel: Record<string, string> = {
  acked: "已下发",
  pending_offline: "等待上线",
  error: "下发失败",
};

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
  "node.hello": "Hello 全量下发",
  "mapping.push": "MappingSync",
  "mapping.probe": "探测开流",
  "mapping.knock": "SPA 敲门",
  "mapping.visit": "访客探访",
  "visitor.issue": "签发访客",
  "node.disconnect": "节点离线",
  "node.revoke": "吊销凭证",
  "mapping.create": "新建映射",
  "mapping.policy": "更新策略",
  "mapping.delete": "删除映射",
  "mapping.enable": "启用映射",
  "mapping.disable": "停用映射",
  "demo.run": "跑通演示",
};
