/** M1 控制通道：长度前缀 JSON 的语义。节点不持有映射配置。 */

export type FrameDir = "c2s" | "s2c";

export type FrameType =
  | "Enroll"
  | "EnrollOk"
  | "Hello"
  | "HelloOk"
  | "MappingSync"
  | "MappingAck"
  | "Heartbeat"
  | "OpenStream"
  | "CloseStream"
  | "Knock"
  | "KnockOk"
  | "Dropped"
  | "Visit"
  | "Revoked";

export type ControlFrame = {
  ts: string;
  dir: FrameDir;
  type: FrameType;
  body: unknown;
};

export type MappingWire = {
  id: string;
  name: string;
  proto: "tcp" | "udp";
  mode: string;
  entry_port: number | null;
  local_host: string;
  local_port: number;
  enabled: boolean;
  max_conns: number;
  rate_kbps: number;
  allow_cidrs: string;
  idle_timeout_sec: number;
};

export function specFingerprint(m: MappingWire): string {
  return [m.id, m.proto, m.mode, m.entry_port ?? "", m.local_host, m.local_port, m.enabled ? "1" : "0"].join("|");
}

export function alignMappings(have: Map<string, MappingWire>, want: MappingWire[]) {
  const wantMap = new Map(want.filter((m) => m.enabled).map((m) => [m.id, m]));
  const started: string[] = [];
  const stopped: string[] = [];
  const restarted: string[] = [];

  for (const id of [...have.keys()]) {
    if (!wantMap.has(id)) {
      have.delete(id);
      stopped.push(id);
    }
  }
  for (const [id, spec] of wantMap) {
    const cur = have.get(id);
    if (!cur) {
      have.set(id, spec);
      started.push(id);
    } else if (specFingerprint(cur) !== specFingerprint(spec)) {
      have.set(id, spec);
      restarted.push(id);
    }
  }
  return { started, stopped, restarted };
}

export const ECHO_HOST = "127.0.0.1";
export const ECHO_PORT = 19222;
