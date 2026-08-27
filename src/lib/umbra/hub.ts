import {
  alignMappings,
  ECHO_HOST,
  ECHO_PORT,
  type ControlFrame,
  type FrameType,
  type MappingWire,
} from "./protocol";
import {
  dialTarget,
  dialUdp,
  dropAgentEntries,
  ensureEcho,
  grantUntilIso,
  isGranted,
  cidrAllowed,
  knockGrant,
  markAgentOnline,
  probeEntry,
  syncAgentEntries,
  syncEntry,
} from "./dataplane";

export {
  ECHO_HOST,
  ECHO_PORT,
  ensureEcho,
  grantUntilIso,
  isGranted,
  markAgentOnline,
  syncAgentEntries,
  syncEntry,
  dropAgentEntries,
};

type Session = {
  agentId: string;
  have: Map<string, MappingWire>;
  version: string;
};

type ProbeOk = {
  bytesIn: number;
  bytesOut: number;
  preview: string;
  frames: ControlFrame[];
};

const g = globalThis as typeof globalThis & {
  __umbraSessions__?: Map<string, Session>;
};

function sessions() {
  g.__umbraSessions__ ??= new Map();
  return g.__umbraSessions__;
}

function frame(dir: ControlFrame["dir"], type: FrameType, body: unknown): ControlFrame {
  return { ts: new Date().toISOString(), dir, type, body };
}

export function getSession(agentId: string): Session {
  const all = sessions();
  let s = all.get(agentId);
  if (!s) {
    s = { agentId, have: new Map(), version: "0.3.0-m3" };
    all.set(agentId, s);
  }
  return s;
}

export function dropSession(agentId: string) {
  sessions().delete(agentId);
  markAgentOnline(agentId, false);
}

export function helloAgentChannel(agentId: string, mappings: MappingWire[]) {
  const s = getSession(agentId);
  const frames: ControlFrame[] = [
    frame("c2s", "Hello", { agent_id: agentId, version: s.version }),
    frame("s2c", "HelloOk", { mappings }),
  ];
  const { started, stopped, restarted } = alignMappings(s.have, mappings);
  for (const id of [...started, ...restarted]) {
    frames.push(frame("c2s", "MappingAck", { id, ok: true }));
  }
  for (const id of stopped) {
    frames.push(frame("c2s", "MappingAck", { id, ok: true, error: "" }));
  }
  return { frames, started, stopped, restarted };
}

export function syncMappings(agentId: string, upsert: MappingWire[], del: string[]) {
  const s = getSession(agentId);
  const frames: ControlFrame[] = [frame("s2c", "MappingSync", { upsert, delete: del })];
  const next = new Map(s.have);
  for (const id of del) next.delete(id);
  for (const m of upsert) next.set(m.id, m);
  const want = [...next.values()];
  const { started, stopped, restarted } = alignMappings(s.have, want);
  for (const id of [...started, ...stopped, ...restarted, ...del]) {
    frames.push(frame("c2s", "MappingAck", { id, ok: true }));
  }
  return { frames, started, stopped, restarted };
}

export function heartbeat(agentId: string, deltas: { id: string; bytes_in_d: number; bytes_out_d: number; active_conns: number }[]) {
  return [frame("c2s", "Heartbeat", { ts: Date.now(), mappings: deltas })];
}

export function revokeChannel(agentId: string) {
  const frames = [frame("s2c", "Revoked", {})];
  dropSession(agentId);
  void dropAgentEntries(agentId);
  return frames;
}

export function knockChannel(mappingId: string) {
  const until = knockGrant(mappingId, 60_000);
  return {
    until,
    frames: [
      frame("c2s", "Knock", { mapping_id: mappingId }),
      frame("s2c", "KnockOk", { mapping_id: mappingId, ttl_sec: 60 }),
    ],
  };
}

function streamFrames(mapping: MappingWire, ok: boolean, extra: ControlFrame[] = []): ControlFrame[] {
  return [
    frame("s2c", "OpenStream", {
      mapping_id: mapping.id,
      proto: mapping.proto,
      peer_ip: "127.0.0.1",
      peer_port: 0,
      via: mapping.mode,
    }),
    ...extra,
    frame("c2s", "CloseStream", { mapping_id: mapping.id, ok }),
  ];
}

export async function openStreamProbe(agentId: string, mapping: MappingWire, payload: string): Promise<ProbeOk> {
  const s = getSession(agentId);
  if (!s.have.has(mapping.id) && mapping.enabled) s.have.set(mapping.id, mapping);
  if (!mapping.enabled) throw new Error("映射已停用");

  const buf = Buffer.from(payload);
  const proto = mapping.proto;

  if (mapping.mode === "visitor") {
    throw Object.assign(new Error("访客模式没有公网入口。签发访客后探访。"), {
      frames: [frame("s2c", "Dropped", { mapping_id: mapping.id, reason: "visitor" })],
    });
  }

  if (!cidrAllowed("127.0.0.1", mapping.allow_cidrs)) {
    throw Object.assign(new Error("来源不在允许网段"), {
      frames: [frame("s2c", "Dropped", { mapping_id: mapping.id, reason: "acl" })],
    });
  }

  if (mapping.mode === "spa" && !isGranted(mapping.id)) {
    if (mapping.entry_port != null) {
      await probeEntry(mapping.entry_port, buf, proto).catch(() => undefined);
    }
    throw Object.assign(new Error("暗端口未授权，连接已丢弃。先敲门。"), {
      frames: [frame("s2c", "Dropped", { mapping_id: mapping.id, reason: "spa" })],
    });
  }

  if (mapping.entry_port == null) throw new Error("入口端口缺失");

  try {
    const { rx, tx } = await probeEntry(mapping.entry_port, buf, proto);
    return {
      bytesIn: tx,
      bytesOut: rx.length,
      preview: rx.toString("utf8").slice(0, 180),
      frames: streamFrames(mapping, true),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "入口无响应";
    throw Object.assign(new Error(message), { frames: streamFrames(mapping, false) });
  }
}

export async function visitStream(agentId: string, mapping: MappingWire, payload: string): Promise<ProbeOk> {
  const s = getSession(agentId);
  if (!s.have.has(mapping.id) && mapping.enabled) s.have.set(mapping.id, mapping);
  if (!mapping.enabled) throw new Error("映射已停用");
  if (mapping.mode !== "visitor") throw new Error("只有访客模式需要探访");
  const buf = Buffer.from(payload);
  const visit = frame("c2s", "Visit", { mapping_id: mapping.id });
  const dial = mapping.proto === "udp" ? dialUdp : dialTarget;
  try {
    const { rx, tx } = await dial(mapping.local_host, mapping.local_port, buf);
    return {
      bytesIn: tx,
      bytesOut: rx.length,
      preview: rx.toString("utf8").slice(0, 180),
      frames: streamFrames(mapping, true, [visit]),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "探访失败";
    throw Object.assign(new Error(message), { frames: streamFrames(mapping, false, [visit]) });
  }
}
