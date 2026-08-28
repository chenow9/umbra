export type NodeStatus = "online" | "offline" | "revoked";
export type Proto = "tcp" | "udp";
export type MappingMode = "visitor" | "spa" | "public";
export type ListenState = "pending" | "listening" | "ready" | "disabled" | "error";
export type PushState = "acked" | "pending_offline" | "error";

export type Node = {
  id: string;
  name: string;
  comment: string;
  status: NodeStatus;
  addr: string | null;
  version: string | null;
  os: string;
  arch: string;
  lastSeen: string | null;
  enabled: boolean;
  createdAt: string;
  mappingCount: number;
  bytesIn: number;
  bytesOut: number;
};

export type Mapping = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeStatus: NodeStatus;
  name: string;
  proto: Proto;
  mode: MappingMode;
  entryPort: number | null;
  localHost: string;
  localPort: number;
  enabled: boolean;
  listenState: ListenState;
  listenError: string | null;
  pushState: PushState;
  bytesIn: number;
  bytesOut: number;
  activeConns: number;
  lastProbeAt: string | null;
  lastProbePreview: string | null;
  grantUntil: string | null;
  maxConns: number;
  rateKbps: number;
  allowCidrs: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditItem = {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

export type Overview = {
  nodesOnline: number;
  nodesTotal: number;
  mappingsActive: number;
  mappingsTotal: number;
  bytesInToday: number;
  bytesOutToday: number;
  bpsIn: number;
  bpsOut: number;
  recentAudit: AuditItem[];
};

export type TrafficPoint = {
  ts: string;
  bytesIn: number;
  bytesOut: number;
};

export type TrafficView = {
  bytesIn: number;
  bytesOut: number;
  peakBpsIn: number;
  peakBpsOut: number;
  series: TrafficPoint[];
};

export type ControlFrameRow = {
  id: number;
  ts: string;
  nodeId: string;
  nodeName: string;
  dir: "c2s" | "s2c";
  type: string;
  body: string;
};

export type ProbeResult = {
  bytesIn: number;
  bytesOut: number;
  preview: string;
};

export type DemoResult = {
  nodeId: string;
  mappingId: string;
  bytesIn: number;
  bytesOut: number;
  preview: string;
  dropped: boolean;
  udpBytesIn: number;
  udpBytesOut: number;
};

export type VisitorIssued = {
  id: string;
  ticket: string;
  visitCmd: string;
  expiresAt: string;
};

export type NodeIssued = {
  id: string;
  token: string;
  installCmd: string;
  unit: string;
};
