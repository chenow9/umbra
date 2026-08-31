export type NodeStatus = "online" | "offline" | "revoked";
export type Proto = "tcp" | "udp";
export type MappingMode = "visitor" | "spa" | "public";
export type ListenState = "pending" | "listening" | "ready" | "disabled" | "error";
export type PushState = "acked" | "pending" | "pending_offline" | "error";

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
  tokenExpiresAt?: string;
  tokenNoExpiry?: boolean;
  mappingCount: number;
  bytesIn: number;
  bytesOut: number;
  bpsIn?: number;
  bpsOut?: number;
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
  udpActive?: number;
  udpDropMaxConns?: number;
  udpDropPerIP?: number;
  udpDropRate?: number;
  tcpDropMaxConns?: number;
  tcpDropAcl?: number;
  tcpDropSpa?: number;
  tcpDropOffline?: number;
  tcpDropTunnel?: number;
  tcpDropSplice?: number;
  lastDrop?: string;
  lastDropAt?: string;
  lastProbeAt: string | null;
  lastProbePreview: string | null;
  grantUntil: string | null;
  grantIP?: string | null;
  grants?: { ip: string; until: string }[];
  maxConns: number;
  rateKbps: number;
  allowCidrs: string;
  idleTimeoutSec?: number;
  spaTtlSec?: number;
  udpIdleTimeoutSec?: number;
  reach?: string;
  createdAt: string;
  updatedAt: string;
  bpsIn?: number;
  bpsOut?: number;
};

export type AuditItem = {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  targetName?: string;
  detail: string;
};

export type OverviewAlert = {
  level: "error" | "warn" | string;
  kind: string;
  title: string;
  id?: string;
  href?: string;
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
  alerts?: OverviewAlert[];
};

export type VisitorTicket = {
  id: string;
  mappingId: string;
  mappingName: string;
  label: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
};

export type TrafficPoint = {
  ts: string;
  bytesIn: number;
  bytesOut: number;
};

export type TrafficView = {
  bytesIn: number;
  bytesOut: number;
  bpsIn: number;
  bpsOut: number;
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
  dockerCmd?: string;
  unit: string;
};

export type TrafficSample = {
  ts: string;
  bytesIn: number;
  bytesOut: number;
  by?: Record<string, { bytesIn: number; bytesOut: number }>;
};

export type LiveEvent = {
  ts: string;
  overview: Overview;
  nodes: Node[];
  mappings: Mapping[];
  sample: TrafficSample | null;
};
