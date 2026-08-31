import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { assertOwner } from "./owner.server";
import { hashToken, newBootstrap, newId, newVisitorTicket } from "./ids";
import type {
  Node,
  AuditItem,
  ControlFrameRow,
  Mapping,
  Overview,
  ProbeResult,
  DemoResult,
  VisitorIssued,
  TrafficView,
} from "./types";
import type { ControlFrame, MappingWire } from "./protocol";
import {
  dropNodeEntries,
  dropSession,
  ensureEcho,
  grantUntilIso,
  heartbeat,
  helloNodeChannel,
  knockChannel,
  openStreamProbe,
  revokeChannel,
  syncNodeEntries,
  syncMappings,
  visitStream,
} from "./hub";
import {
  gateDisconnect,
  gateHealth,
  gateKnock,
  gatePutMappings,
  gatePutToken,
  gateRevoke,
  recallToken,
  rememberToken,
  ensureNodeOnline,
  stopNode,
} from "./gate";
import { ECHO_HOST, ECHO_PORT } from "./protocol";
import { nodeEnrollBinCmd, nodeEnrollDockerCmd, type Arch, type Platform } from "./units";

type NodeRow = {
  id: string;
  name: string;
  comment: string;
  status: string;
  addr: string | null;
  version: string | null;
  os: string;
  arch: string;
  last_seen: string | Date | null;
  enabled: boolean;
  created_at: string | Date;
  mapping_count: number;
  bytes_in: number | string;
  bytes_out: number | string;
};

type MappingRow = {
  id: string;
  node_id: string;
  agent_name: string;
  agent_status: string;
  name: string;
  proto: string;
  mode: string;
  entry_port: number | null;
  local_host: string;
  local_port: number;
  enabled: boolean;
  listen_state: string;
  listen_error: string | null;
  push_state: string;
  bytes_in: number | string;
  bytes_out: number | string;
  active_conns: number;
  last_probe_at: string | Date | null;
  last_probe_preview: string | null;
  max_conns: number;
  rate_kbps: number;
  allow_cidrs: string;
  idle_timeout_sec?: number;
  spa_ttl_sec?: number;
  udp_idle_timeout_sec?: number;
  created_at: string | Date;
  updated_at: string | Date;
};

async function liveSync(nodeId: string, online: boolean) {
  const wires = await loadWires(nodeId);
  if (await gateHealth()) {
    await dropNodeEntries(nodeId);
    await gatePutMappings(nodeId, wires);
    return;
  }
  const { errors } = await syncNodeEntries(nodeId, wires, online);
  if (errors.length === 0) return;
  const sql = await ownerSql();
  for (const e of errors) {
    await sql.query(
      `update mappings set listen_state = 'error', listen_error = $1, updated_at = now() where id = $2`,
      [e.error, e.id],
    );
  }
}

async function persistProbe(
  nodeId: string,
  mappingId: string,
  result: { bytesIn: number; bytesOut: number; preview: string; frames: ControlFrame[] },
  action: string,
) {
  const sql = await ownerSql();
  await persistFrames(nodeId, result.frames);
  await sql.query(
    `update mappings
     set bytes_in = bytes_in + $1,
         bytes_out = bytes_out + $2,
         active_conns = 0,
         last_probe_at = now(),
         last_probe_preview = $3,
         listen_error = null,
         updated_at = now()
     where id = $4`,
    [result.bytesIn, result.bytesOut, result.preview, mappingId],
  );
  await sql.query(
    `insert into traffic_samples (node_id, mapping_id, bytes_in, bytes_out, conns_opened)
     values ($1,$2,$3,$4,1)`,
    [nodeId, mappingId, result.bytesIn, result.bytesOut],
  );
  await persistFrames(
    nodeId,
    heartbeat(nodeId, [
      { id: mappingId, bytes_in_d: result.bytesIn, bytes_out_d: result.bytesOut, active_conns: 0 },
    ]),
  );
  await audit(action, mappingId, `${result.bytesIn}+${result.bytesOut}B`);
}

function asIso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return v.toISOString();
}

function asNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapNode(r: NodeRow): Node {
  return {
    id: r.id,
    name: r.name,
    comment: r.comment,
    status: r.status as Node["status"],
    addr: r.addr,
    version: r.version,
    os: r.os,
    arch: r.arch,
    lastSeen: asIso(r.last_seen),
    enabled: r.enabled,
    createdAt: asIso(r.created_at) ?? "",
    mappingCount: asNum(r.mapping_count),
    bytesIn: asNum(r.bytes_in),
    bytesOut: asNum(r.bytes_out),
  };
}

function mapMapping(r: MappingRow): Mapping {
  return {
    id: r.id,
    nodeId: r.node_id,
    nodeName: r.agent_name,
    nodeStatus: r.agent_status as Mapping["nodeStatus"],
    name: r.name,
    proto: r.proto as Mapping["proto"],
    mode: r.mode as Mapping["mode"],
    entryPort: r.entry_port,
    localHost: r.local_host,
    localPort: r.local_port,
    enabled: r.enabled,
    listenState: r.listen_state as Mapping["listenState"],
    listenError: r.listen_error,
    pushState: r.push_state as Mapping["pushState"],
    bytesIn: asNum(r.bytes_in),
    bytesOut: asNum(r.bytes_out),
    activeConns: asNum(r.active_conns),
    lastProbeAt: asIso(r.last_probe_at),
    lastProbePreview: r.last_probe_preview,
    grantUntil: r.mode === "spa" ? grantUntilIso(r.id) : null,
    spaTtlSec: asNum(r.spa_ttl_sec) || 60,
    udpIdleTimeoutSec: asNum(r.udp_idle_timeout_sec) || 60,
    idleTimeoutSec: asNum(r.idle_timeout_sec),
    maxConns: asNum(r.max_conns) || 64,
    rateKbps: asNum(r.rate_kbps),
    allowCidrs: r.allow_cidrs ?? "",
    createdAt: asIso(r.created_at) ?? "",
    updatedAt: asIso(r.updated_at) ?? "",
  };
}

async function persistFrames(nodeId: string, frames: ControlFrame[]) {
  if (frames.length === 0) return;
  const sql = await ownerSql();
  for (const f of frames) {
    await sql.query(
      `insert into control_frames (ts, node_id, dir, type, body) values ($1,$2,$3,$4,$5)`,
      [f.ts, nodeId, f.dir, f.type, JSON.stringify(f.body)],
    );
  }
  await sql.query(
    `delete from control_frames where ts < now() - interval '6 hours'`,
  );
}

function toWire(m: {
  id: string;
  name: string;
  proto: string;
  mode: string;
  entry_port: number | null;
  local_host: string;
  local_port: number;
  enabled: boolean;
  max_conns?: number;
  rate_kbps?: number;
  allow_cidrs?: string;
  idle_timeout_sec?: number;
  spa_ttl_sec?: number;
  udp_idle_timeout_sec?: number;
}): MappingWire {
  return {
    id: m.id,
    name: m.name,
    proto: m.proto as MappingWire["proto"],
    mode: m.mode,
    entry_port: m.entry_port,
    local_host: m.local_host,
    local_port: m.local_port,
    enabled: m.enabled,
    max_conns: m.max_conns ?? 64,
    rate_kbps: m.rate_kbps ?? 0,
    allow_cidrs: m.allow_cidrs ?? "",
    idle_timeout_sec: m.idle_timeout_sec ?? 60,
    spa_ttl_sec: m.spa_ttl_sec ?? 60,
    udp_idle_timeout_sec: m.udp_idle_timeout_sec ?? 60,
  };
}

async function ownerSql() {
  await assertOwner();
  return getSql();
}

async function loadWires(nodeId: string): Promise<MappingWire[]> {
  const sql = await ownerSql();
  const rows = await sql.query<{
    id: string;
    name: string;
    proto: string;
    mode: string;
    entry_port: number | null;
    local_host: string;
    local_port: number;
    enabled: boolean;
    max_conns: number;
    rate_kbps: number;
    allow_cidrs: string;
    idle_timeout_sec: number;
    spa_ttl_sec: number;
    udp_idle_timeout_sec: number;
  }>(
    `select id, name, proto, mode, entry_port, local_host, local_port, enabled,
            max_conns, rate_kbps, allow_cidrs, idle_timeout_sec,
            spa_ttl_sec, udp_idle_timeout_sec
     from mappings where node_id = $1`,
    [nodeId],
  );
  return rows.map(toWire);
}

async function audit(action: string, target: string, detail = "") {
  const sql = await ownerSql();
  await sql`
    insert into audit_log (actor, action, target, detail)
    values ('admin', ${action}, ${target}, ${detail})
  `;
}

async function ownedNode(id: string) {
  const sql = await ownerSql();
  const [a] = await sql.query<{ id: string; status: string; enabled: boolean }>(
    `select id, status, enabled from nodes where id = $1`,
    [id],
  );
  if (!a) throw new Error("节点不存在");
  return a;
}

async function ownedMapping(id: string) {
  const sql = await ownerSql();
  const [m] = await sql.query<{
    id: string;
    node_id: string;
    mode: string;
    proto: string;
    enabled: boolean;
    name: string;
    entry_port: number | null;
    local_host: string;
    local_port: number;
    spa_ttl_sec?: number;
  }>(
    `select m.id, m.node_id, m.mode, m.proto, m.enabled, m.name,
            m.entry_port, m.local_host, m.local_port, m.spa_ttl_sec
     from mappings m
     join nodes a on a.id = m.node_id
     where m.id = $1`,
    [id],
  );
  if (!m) throw new Error("映射不存在");
  return m;
}

function isAllowedTarget(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = m.slice(1).map(Number);
  if (a.some((n) => n > 255)) return false;
  if (a[0] === 10) return true;
  if (a[0] === 127) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  return false;
}

function normalizeCidrs(raw: string) {
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  for (const p of parts) {
    const [ip, bitsRaw] = p.split("/");
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error(`无效网段 ${p}`);
    const nums = ip.split(".").map(Number);
    if (nums.some((n) => n > 255)) throw new Error(`无效网段 ${p}`);
    if (bitsRaw != null && bitsRaw !== "") {
      const bits = Number(bitsRaw);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`无效网段 ${p}`);
    }
  }
  return parts.join(",");
}

function statesFor(nodeStatus: string, enabled: boolean, mode: string) {
  if (!enabled) return { listenState: "disabled", pushState: nodeStatus === "online" ? "acked" : "pending_offline" };
  if (nodeStatus !== "online") {
    return { listenState: "pending", pushState: "pending_offline" };
  }
  return {
    listenState: mode === "visitor" ? "ready" : "listening",
    pushState: "acked",
  };
}

const agentSelect = `
  select a.id, a.name, a.comment, a.status, a.addr, a.version, a.os, a.arch,
         a.last_seen, a.enabled, a.created_at,
         count(m.id)::int as mapping_count,
         coalesce(sum(m.bytes_in), 0)::bigint as bytes_in,
         coalesce(sum(m.bytes_out), 0)::bigint as bytes_out
  from nodes a
  left join mappings m on m.node_id = a.id
`;

const mappingSelect = `
  select m.id, m.node_id, a.name as agent_name, a.status as agent_status,
         m.name, m.proto, m.mode, m.entry_port, m.local_host, m.local_port,
         m.enabled, m.listen_state, m.listen_error, m.push_state,
         m.bytes_in, m.bytes_out, m.active_conns,
         m.last_probe_at, m.last_probe_preview, m.created_at, m.updated_at,
         m.max_conns, m.rate_kbps, m.allow_cidrs,
         m.idle_timeout_sec, m.spa_ttl_sec, m.udp_idle_timeout_sec
  from mappings m
  join nodes a on a.id = m.node_id
`;

export const listNodes = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await ownerSql();
  const rows = await sql.query<NodeRow>(
    `${agentSelect} group by a.id order by a.created_at desc`,
  );
  return rows.map(mapNode);
});

export const listMappings = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await ownerSql();
  const rows = await sql.query<MappingRow>(
    `${mappingSelect} order by m.created_at desc`,
  );
  return rows.map(mapMapping);
});

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await ownerSql();
  const [agents] = await sql.query<{ online: number; total: number }>(
    `select
        (select count(*)::int from nodes where status = 'online' and enabled = true) as online,
        (select count(*)::int from nodes) as total`,
  );
  const [maps] = await sql.query<{ active: number; total: number }>(
    `select
        (select count(*)::int from mappings where enabled = true and listen_state in ('listening','ready')) as active,
        (select count(*)::int from mappings) as total`,
  );
  const [today] = await sql.query<{ bytes_in: number | string; bytes_out: number | string }>(
    `select coalesce(sum(bytes_in),0)::bigint as bytes_in,
            coalesce(sum(bytes_out),0)::bigint as bytes_out
     from traffic_samples
     where ts >= date_trunc('day', now())`,
  );
  const [rate] = await sql.query<{ bytes_in: number | string; bytes_out: number | string }>(
    `select coalesce(sum(bytes_in),0)::bigint as bytes_in,
            coalesce(sum(bytes_out),0)::bigint as bytes_out
     from traffic_samples
     where ts > now() - interval '10 seconds'`,
  );
  const auditRows = await sql.query<AuditItem>(
    `select id, ts, actor, action, target, detail
     from audit_log order by ts desc limit 8`,
  );
  const in10 = asNum(rate?.bytes_in);
  const out10 = asNum(rate?.bytes_out);
  const overview: Overview = {
    nodesOnline: agents?.online ?? 0,
    nodesTotal: agents?.total ?? 0,
    mappingsActive: maps?.active ?? 0,
    mappingsTotal: maps?.total ?? 0,
    bytesInToday: asNum(today?.bytes_in),
    bytesOutToday: asNum(today?.bytes_out),
    bpsIn: Math.round(in10 / 10),
    bpsOut: Math.round(out10 / 10),
    recentAudit: auditRows.map((r) => ({
      ...r,
      ts: asIso(r.ts) ?? "",
    })),
  };
  return overview;
});

export const createNode = createServerFn({ method: "POST" })
  
  .validator(
    z.object({
      name: z.string().min(1).max(64),
      comment: z.string().max(200).optional(),
      os: z.enum(["linux", "darwin", "windows", "docker"]),
      arch: z.enum(["amd64", "arm64"]),
    }),
  )
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const id = newId("nde");
    const token = newBootstrap();
    const os = data.os as Platform;
    const arch = data.arch as Arch;
    await sql`
      insert into nodes (id, name, comment, bootstrap_hash, status, os, arch)
      values (${id}, ${data.name.trim()}, ${data.comment?.trim() ?? ""}, ${hashToken(token)}, 'offline', ${os}, ${arch})
    `;
    await audit("node.create", id, `${data.name.trim()} ${os}/${arch}`);
    rememberToken(id, token);
    if (await gateHealth()) {
      await gatePutToken(token, id).catch(() => undefined);
    }
    return {
      id,
      token,
      os,
      arch,
      listen: "gate:4400",
      installCmd: nodeEnrollBinCmd(token, "gate:4400"),
      dockerCmd: nodeEnrollDockerCmd(token, "gate:4400"),
    };
  });

export const helloNode = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const node = await ownedNode(data.id);
    if (node.status === "revoked" || !node.enabled) throw new Error("凭证已吊销");
    await ensureEcho();
    const wires = await loadWires(data.id);
    const token = recallToken(data.id);
    if (await gateHealth()) {
      await liveSync(data.id, true);
      await ensureNodeOnline(data.id, token);
    }
    const { frames } = helloNodeChannel(data.id, wires);
    await persistFrames(data.id, frames);
    await sql`
      update nodes
      set status = 'online',
          last_seen = now(),
          addr = '127.0.0.1',
          version = '0.4.0'
      where id = ${data.id}
    `;
    await sql`
      update mappings
      set push_state = 'acked',
          listen_state = case
            when not enabled then 'disabled'
            when mode = 'visitor' then 'ready'
            else 'listening'
          end,
          listen_error = null,
          updated_at = now()
      where node_id = ${data.id}
    `;
    await audit("node.hello", data.id, `HelloOk ${wires.length} mappings`);
    await liveSync(data.id, true);
    return { ok: true as const, pushed: wires.filter((m) => m.enabled).length };
  });

export const disconnectNode = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    await ownedNode(data.id);
    stopNode(data.id);
    if (await gateHealth()) await gateDisconnect(data.id).catch(() => undefined);
    await sql`update nodes set status = 'offline' where id = ${data.id} and status = 'online'`;
    dropSession(data.id);
    await sql`
      update mappings
      set push_state = 'pending_offline',
          listen_state = case when enabled then 'pending' else 'disabled' end,
          active_conns = 0,
          updated_at = now()
      where node_id = ${data.id}
    `;
    await audit("node.disconnect", data.id, "");
    return { ok: true as const };
  });

export const revokeNode = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    await ownedNode(data.id);
    stopNode(data.id);
    if (await gateHealth()) await gateRevoke(data.id).catch(() => undefined);
    await persistFrames(data.id, revokeChannel(data.id));
    await sql`
      update nodes set status = 'revoked', enabled = false, cred_fp = null
      where id = ${data.id}
    `;
    await sql`
      update mappings
      set push_state = 'error',
          listen_state = 'error',
          listen_error = '凭证已吊销',
          enabled = false,
          active_conns = 0,
          updated_at = now()
      where node_id = ${data.id}
    `;
    await audit("node.revoke", data.id, "");
    return { ok: true as const };
  });

const mappingInput = z.object({
  nodeId: z.string(),
  name: z.string().min(1).max(64),
  proto: z.enum(["tcp", "udp"]),
  mode: z.enum(["visitor", "spa", "public"]),
  entryPort: z.number().int().min(1).max(65535).nullable().optional(),
  localHost: z.string().min(1).max(64),
  localPort: z.number().int().min(1).max(65535),
  maxConns: z.number().int().min(1).max(10000).optional(),
  rateKbps: z.number().int().min(0).max(1_000_000).optional(),
  allowCidrs: z.string().max(400).optional(),
  idleTimeoutSec: z.number().int().min(0).max(86400).optional(),
  spaTtlSec: z.number().int().min(0).max(86400).optional(),
  udpIdleTimeoutSec: z.number().int().min(0).max(86400).optional(),
});

export const createMapping = createServerFn({ method: "POST" })
  
  .validator(mappingInput)
  .handler(async ({ data }) => {
    if (!isAllowedTarget(data.localHost)) {
      throw new Error("目标地址仅允许本机或 RFC1918 内网");
    }
    const entryPort = data.mode === "visitor" ? null : (data.entryPort ?? null);
    if (data.mode !== "visitor" && entryPort == null) {
      throw new Error("public 或 spa 模式必须指定入口端口");
    }
    const sql = await ownerSql();
    const node = await ownedNode(data.nodeId);
    if (node.status === "revoked" || !node.enabled) throw new Error("节点已吊销");
    if (entryPort != null) {
      const [hit] = await sql.query<{ id: string }>(
        `select id from mappings where proto = $1 and entry_port = $2`,
        [data.proto, entryPort],
      );
      if (hit) throw new Error(`入口 ${data.proto}/${entryPort} 已被占用`);
    }
    const id = newId("map");
    const st = statesFor(node.status, true, data.mode);
    const maxConns = data.maxConns ?? 64;
    const rateKbps = data.rateKbps ?? 0;
    const allowCidrs = normalizeCidrs(data.allowCidrs ?? "");
    const idleTimeoutSec = data.idleTimeoutSec ?? 0;
    const spaTtlSec = data.spaTtlSec || 60;
    const udpIdleTimeoutSec = data.udpIdleTimeoutSec || 60;
    await sql.query(
      `insert into mappings (
         id, node_id, name, proto, mode, entry_port, local_host, local_port,
         enabled, listen_state, push_state, max_conns, rate_kbps, allow_cidrs,
         idle_timeout_sec, spa_ttl_sec, udp_idle_timeout_sec, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
      [
        id,
        data.nodeId,
        data.name.trim(),
        data.proto,
        data.mode,
        entryPort,
        data.localHost.trim(),
        data.localPort,
        st.listenState,
        st.pushState,
        maxConns,
        rateKbps,
        allowCidrs,
        idleTimeoutSec,
        spaTtlSec,
        udpIdleTimeoutSec,
      ],
    );
    await audit(
      "mapping.create",
      id,
      `${data.name} ${data.proto} ${data.mode} → ${node.id}`,
    );
    if (node.status === "online") {
      const [created] = await sql.query<{
        id: string;
        name: string;
        proto: string;
        mode: string;
        entry_port: number | null;
        local_host: string;
        local_port: number;
        enabled: boolean;
        max_conns: number;
        rate_kbps: number;
        allow_cidrs: string;
        idle_timeout_sec: number;
        spa_ttl_sec: number;
        udp_idle_timeout_sec: number;
      }>(
        `select id, name, proto, mode, entry_port, local_host, local_port, enabled,
                max_conns, rate_kbps, allow_cidrs, idle_timeout_sec,
                spa_ttl_sec, udp_idle_timeout_sec
         from mappings where id = $1`,
        [id],
      );
      if (created) {
        const { frames } = syncMappings(data.nodeId, [toWire(created)], []);
        await persistFrames(data.nodeId, frames);
        await audit("mapping.push", id, "MappingSync upsert");
      }
    }
    await liveSync(data.nodeId, node.status === "online");
    const [row] = await sql.query<MappingRow>(
      `${mappingSelect} where m.id = $1`,
      [id],
    );
    return mapMapping(row);
  });

export const setMappingPolicy = createServerFn({ method: "POST" })
  
  .validator(
    z.object({
      id: z.string(),
      maxConns: z.number().int().min(1).max(10000),
      rateKbps: z.number().int().min(0).max(1_000_000),
      allowCidrs: z.string().max(400),
    }),
  )
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    const allowCidrs = normalizeCidrs(data.allowCidrs);
    await sql.query(
      `update mappings
       set max_conns = $1, rate_kbps = $2, allow_cidrs = $3, updated_at = now()
       where id = $4`,
      [data.maxConns, data.rateKbps, allowCidrs, data.id],
    );
    const [agent] = await sql.query<{ status: string }>(
      `select status from nodes where id = $1`,
      [m.node_id],
    );
    if (agent?.status === "online") {
      const wires = await loadWires(m.node_id);
      const spec = wires.find((w) => w.id === data.id);
      if (spec) {
        const { frames } = syncMappings(m.node_id, [spec], []);
        await persistFrames(m.node_id, frames);
      }
    }
    await liveSync(m.node_id, agent?.status === "online");
    await audit("mapping.policy", data.id, `${data.maxConns}路 ${data.rateKbps}kbps ${allowCidrs || "any"}`);
    return { ok: true as const };
  });

export const setMappingEnabled = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string(), enabled: z.boolean() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    const [agent] = await sql.query<{ status: string }>(
      `select status from nodes where id = $1`,
      [m.node_id],
    );
    const st = statesFor(agent?.status ?? "offline", data.enabled, m.mode);
    await sql`
      update mappings
      set enabled = ${data.enabled},
          listen_state = ${st.listenState},
          push_state = ${st.pushState},
          active_conns = 0,
          updated_at = now()
      where id = ${data.id}
    `;
    if (agent?.status === "online") {
      const wires = await loadWires(m.node_id);
      const spec = wires.find((w) => w.id === data.id);
      if (spec) {
        const { frames } = data.enabled
          ? syncMappings(m.node_id, [spec], [])
          : syncMappings(m.node_id, [], [data.id]);
        await persistFrames(m.node_id, frames);
        await audit("mapping.push", data.id, data.enabled ? "enable" : "disable");
      }
    }
    await audit(data.enabled ? "mapping.enable" : "mapping.disable", data.id, "");
    await liveSync(m.node_id, agent?.status === "online");
    return { ok: true as const };
  });

export const deleteMapping = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    const [agent] = await sql.query<{ status: string }>(
      `select status from nodes where id = $1`,
      [m.node_id],
    );
    if (agent?.status === "online") {
      const { frames } = syncMappings(m.node_id, [], [data.id]);
      await persistFrames(m.node_id, frames);
    }
    await sql`delete from mappings where id = ${data.id}`;
    await audit("mapping.delete", data.id, "drain");
    await liveSync(m.node_id, agent?.status === "online");
    return { ok: true as const };
  });

export const pulse = createServerFn({ method: "POST" }).handler(async () => {
  const sql = await ownerSql();
  await sql`update nodes set last_seen = now() where status = 'online' and enabled = true`;
  return { ok: true as const };
});

export const listFrames = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await ownerSql();
  const rows = await sql.query<{
    id: number;
    ts: string | Date;
    node_id: string;
    agent_name: string;
    dir: string;
    type: string;
    body: string;
  }>(
    `select f.id, f.ts, f.node_id, coalesce(a.name, '') as agent_name,
            f.dir, f.type, f.body
     from control_frames f
     left join nodes a on a.id = f.node_id
     order by f.ts desc, f.id desc
     limit 40`,
  );
  const out: ControlFrameRow[] = rows.map((r) => ({
    id: r.id,
    ts: asIso(r.ts) ?? "",
    nodeId: r.node_id,
    nodeName: r.agent_name,
    dir: r.dir as ControlFrameRow["dir"],
    type: r.type,
    body: r.body,
  }));
  return out;
});

export const listAudit = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await ownerSql();
  const rows = await sql.query<AuditItem>(
    `select id, ts, actor, action, target, detail from audit_log order by ts desc limit 80`,
  );
  return rows.map((r) => ({
    ...r,
    ts: asIso(r.ts) ?? "",
  }));
});

export const probeMapping = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    const [agent] = await sql.query<{ status: string; enabled: boolean }>(
      `select status, enabled from nodes where id = $1`,
      [m.node_id],
    );
    if (!agent || agent.status !== "online" || !agent.enabled) {
      throw new Error("节点不在线，无法开流");
    }
    await ensureEcho();
    const spec = (await loadWires(m.node_id)).find((w) => w.id === m.id);
    if (!spec) throw new Error("映射不存在");
    const payload = `umbra-probe ${m.id} ${new Date().toISOString()}\n`;
    try {
      const result = await openStreamProbe(m.node_id, spec, payload);
      await persistProbe(m.node_id, m.id, result, "mapping.probe");
      const out: ProbeResult = {
        bytesIn: result.bytesIn,
        bytesOut: result.bytesOut,
        preview: result.preview,
      };
      return out;
    } catch (err) {
      const frames = (err as { frames?: ControlFrame[] }).frames;
      if (frames) await persistFrames(m.node_id, frames);
      const message = err instanceof Error ? err.message : "探测失败";
      if (!message.includes("未授权") && !message.includes("访问端")) {
        await sql.query(
          `update mappings set listen_error = $1, updated_at = now() where id = $2`,
          [message, m.id],
        );
      }
      throw new Error(message);
    }
  });

export const knockMapping = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    if (m.mode !== "spa" || !m.enabled) throw new Error("只有启用的 spa 映射需要敲门");
    const ttlSec = Number(m.spa_ttl_sec) || 60;
    const { until, frames } = knockChannel(m.id, "127.0.0.1", ttlSec);
    if (await gateHealth()) await gateKnock(m.id).catch(() => undefined);
    await persistFrames(m.node_id, frames);
    await audit("mapping.knock", m.id, `SPA grant ${ttlSec}s 127.0.0.1`);
    return { until: new Date(until).toISOString(), ip: "127.0.0.1", ttlSec };
  });

export const issueVisitor = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string(), label: z.string().max(64).optional() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    if (m.mode !== "visitor" || !m.enabled) throw new Error("只有启用的访问端映射可以签发");
    const id = newId("vis");
    const ticket = newVisitorTicket();
    const expires = new Date(Date.now() + 24 * 3600 * 1000);
    await sql.query(
      `insert into visitors (id, mapping_id, label, ticket_hash, expires_at)
       values ($1,$2,$3,$4,$5)`,
      [id, m.id, data.label?.trim() || "访问", hashToken(ticket), expires.toISOString()],
    );
    await audit("visitor.issue", m.id, id);
    const issued: VisitorIssued = {
      id,
      ticket,
      visitCmd: `umbra-visit --server gate:4400 --tls-ca /etc/umbra/ca.crt --ticket ${ticket} --local 127.0.0.1:2222`,
      expiresAt: expires.toISOString(),
    };
    return issued;
  });

export const visitMapping = createServerFn({ method: "POST" })
  
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const m = await ownedMapping(data.id);
    const [agent] = await sql.query<{ status: string; enabled: boolean }>(
      `select status, enabled from nodes where id = $1`,
      [m.node_id],
    );
    if (!agent || agent.status !== "online" || !agent.enabled) {
      throw new Error("节点不在线，无法探访");
    }
    await ensureEcho();
    const spec = (await loadWires(m.node_id)).find((w) => w.id === m.id);
    if (!spec) throw new Error("映射不存在");
    const payload = `umbra-visit ${m.id} ${new Date().toISOString()}\n`;
    try {
      const result = await visitStream(m.node_id, spec, payload);
      await persistProbe(m.node_id, m.id, result, "mapping.visit");
      const out: ProbeResult = {
        bytesIn: result.bytesIn,
        bytesOut: result.bytesOut,
        preview: result.preview,
      };
      return out;
    } catch (err) {
      const frames = (err as { frames?: ControlFrame[] }).frames;
      if (frames) await persistFrames(m.node_id, frames);
      throw new Error(err instanceof Error ? err.message : "探访失败");
    }
  });

export const getTraffic = createServerFn({ method: "GET" })
  
  .validator(
    z.object({
      range: z.enum(["1h", "24h", "7d"]).optional(),
      mappingId: z.string().optional(),
      nodeId: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const sql = await ownerSql();
    const range = data.range ?? "24h";
    const interval = range === "1h" ? "1 hour" : range === "7d" ? "7 days" : "24 hours";
    const trunc = range === "1h" ? "minute" : range === "7d" ? "hour" : "minute";
    const clauses: string[] = [`ts > now() - interval '${interval}'`];
    const params: unknown[] = [];
    if (data.mappingId) {
      params.push(data.mappingId);
      clauses.push(`mapping_id = $${params.length}`);
    }
    if (data.nodeId) {
      params.push(data.nodeId);
      clauses.push(`node_id = $${params.length}`);
    }
    const where = clauses.join(" and ");
    const series = await sql.query<{ ts: string | Date; bytes_in: number | string; bytes_out: number | string }>(
      `select date_trunc('${trunc}', ts) as ts,
              sum(bytes_in)::bigint as bytes_in,
              sum(bytes_out)::bigint as bytes_out
       from traffic_samples
       where ${where}
       group by 1
       order by 1`,
      params,
    );
    const points = series.map((r) => ({
      ts: asIso(r.ts) ?? "",
      bytesIn: asNum(r.bytes_in),
      bytesOut: asNum(r.bytes_out),
    }));
    const bytesIn = points.reduce((s, p) => s + p.bytesIn, 0);
    const bytesOut = points.reduce((s, p) => s + p.bytesOut, 0);
    const span = range === "1h" ? 60 : range === "7d" ? 3600 : 60;
    let peakIn = 0;
    let peakOut = 0;
    for (const p of points) {
      peakIn = Math.max(peakIn, p.bytesIn / span);
      peakOut = Math.max(peakOut, p.bytesOut / span);
    }
    const view: TrafficView = {
      bytesIn,
      bytesOut,
      bpsIn: 0,
      bpsOut: 0,
      peakBpsIn: peakIn,
      peakBpsOut: peakOut,
      series: points,
    };
    return view;
  });

export const runDemo = createServerFn({ method: "POST" }).handler(async () => {
  const sql = await ownerSql();
  await ensureEcho();

  let [node] = await sql.query<{ id: string; status: string; enabled: boolean }>(
    `select id, status, enabled from nodes
     where name = '演示节点' and status <> 'revoked'
     order by created_at desc limit 1`,
  );
  if (!node) {
    const id = newId("nde");
    const token = newBootstrap();
    await sql`
      insert into nodes (id, name, comment, bootstrap_hash, status)
      values (${id}, '演示节点', '预览内嵌节点，映射由服务端下发', ${hashToken(token)}, 'offline')
    `;
    await audit("node.create", id, "演示节点");
    node = { id, status: "offline", enabled: true };
  }
  const demoToken = recallToken(node.id) ?? newBootstrap();
  rememberToken(node.id, demoToken);
  if (await gateHealth()) {
    await gatePutToken(demoToken, node.id).catch(() => undefined);
  }

  const wiresBefore = await loadWires(node.id);
  const { frames: helloFrames } = helloNodeChannel(node.id, wiresBefore);
  await persistFrames(node.id, helloFrames);
  await sql`
    update nodes
    set status = 'online', last_seen = now(), addr = '127.0.0.1', version = '0.4.0'
    where id = ${node.id}
  `;
  await sql`
    update mappings
    set push_state = 'acked',
        listen_state = case
          when not enabled then 'disabled'
          when mode = 'visitor' then 'ready'
          else 'listening'
        end,
        listen_error = null,
        updated_at = now()
    where node_id = ${node.id}
  `;
  await audit("node.hello", node.id, "demo HelloOk");
  await liveSync(node.id, true);

  let [mapping] = await sql.query<{
    id: string;
    name: string;
    proto: string;
    mode: string;
    entry_port: number | null;
    local_host: string;
    local_port: number;
    enabled: boolean;
  }>(
    `select id, name, proto, mode, entry_port, local_host, local_port, enabled
     from mappings where node_id = $1 and name = '回声' limit 1`,
    [node.id],
  );

  if (!mapping) {
    let entryPort = 40222;
    for (let i = 0; i < 32; i += 1) {
      const [hit] = await sql.query<{ id: string }>(
        `select id from mappings where proto = 'tcp' and entry_port = $1`,
        [entryPort],
      );
      if (!hit) break;
      entryPort += 1;
    }
    const id = newId("map");
    await sql.query(
      `insert into mappings (
         id, node_id, name, proto, mode, entry_port, local_host, local_port,
         enabled, listen_state, push_state, updated_at
       ) values ($1,$2,'回声','tcp','spa',$3,$4,$5,true,'listening','acked',now())`,
      [id, node.id, entryPort, ECHO_HOST, ECHO_PORT],
    );
    const [created] = await sql.query<{
      id: string;
      name: string;
      proto: string;
      mode: string;
      entry_port: number | null;
      local_host: string;
      local_port: number;
      enabled: boolean;
    }>(
      `select id, name, proto, mode, entry_port, local_host, local_port, enabled
       from mappings where id = $1`,
      [id],
    );
    mapping = created;
    if (created) {
      const { frames } = syncMappings(node.id, [toWire(created)], []);
      await persistFrames(node.id, frames);
      await audit("mapping.create", id, "回声 spa → echo");
      await audit("mapping.push", id, "MappingSync upsert");
    }
  }

  if (!mapping) throw new Error("演示映射创建失败");
  await liveSync(node.id, true);
  if (await gateHealth()) {
    const up = await ensureNodeOnline(node.id, demoToken);
    if (!up) {
      /* 入口不在就走控制台内的回声，不能空等 */
    }
  }

  const payload = `umbra-probe ${mapping.id} ${new Date().toISOString()}\n`;
  let dropped = false;
  try {
    await openStreamProbe(node.id, toWire(mapping), payload);
  } catch (err) {
    dropped = true;
    const frames = (err as { frames?: ControlFrame[] }).frames;
    if (frames) await persistFrames(node.id, frames);
  }
  const knocked = knockChannel(mapping.id);
  if (await gateHealth()) await gateKnock(mapping.id).catch(() => undefined);
  await persistFrames(node.id, knocked.frames);
  await audit("mapping.knock", mapping.id, "demo SPA");
  const tcpSpec = (await loadWires(node.id)).find((w) => w.id === mapping.id);
  if (!tcpSpec) throw new Error("演示映射丢失");
  const result = await openStreamProbe(node.id, tcpSpec, payload);
  await persistProbe(node.id, mapping.id, result, "mapping.probe");

  let [udpMap] = await sql.query<{
    id: string;
    name: string;
    proto: string;
    mode: string;
    entry_port: number | null;
    local_host: string;
    local_port: number;
    enabled: boolean;
  }>(
    `select id, name, proto, mode, entry_port, local_host, local_port, enabled
     from mappings where node_id = $1 and name = '游戏口' limit 1`,
    [node.id],
  );
  if (!udpMap) {
    let entryPort = 25565;
    for (let i = 0; i < 32; i += 1) {
      const [hit] = await sql.query<{ id: string }>(
        `select id from mappings where proto = 'udp' and entry_port = $1`,
        [entryPort],
      );
      if (!hit) break;
      entryPort += 1;
    }
    const id = newId("map");
    await sql.query(
      `insert into mappings (
         id, node_id, name, proto, mode, entry_port, local_host, local_port,
         enabled, listen_state, push_state, max_conns, allow_cidrs, updated_at
       ) values ($1,$2,'游戏口','udp','public',$3,$4,$5,true,'listening','acked',8,'127.0.0.0/8',now())`,
      [id, node.id, entryPort, ECHO_HOST, ECHO_PORT],
    );
    const [created] = await sql.query<{
      id: string;
      name: string;
      proto: string;
      mode: string;
      entry_port: number | null;
      local_host: string;
      local_port: number;
      enabled: boolean;
    }>(
      `select id, name, proto, mode, entry_port, local_host, local_port, enabled
       from mappings where id = $1`,
      [id],
    );
    udpMap = created;
    if (created) {
      const { frames } = syncMappings(node.id, [toWire(created)], []);
      await persistFrames(node.id, frames);
      await audit("mapping.create", id, "游戏口 udp public");
    }
  }
  if (!udpMap) throw new Error("UDP 映射创建失败");
  await sql.query(
    `update mappings set max_conns = 8, allow_cidrs = '127.0.0.0/8', updated_at = now() where id = $1`,
    [udpMap.id],
  );
  await liveSync(node.id, true);
  const udpSpec = (await loadWires(node.id)).find((w) => w.id === udpMap.id);
  if (!udpSpec) throw new Error("UDP 映射丢失");
  const udpPayload = `umbra-udp ${udpMap.id} ${new Date().toISOString()}\n`;
  const udpResult = await openStreamProbe(node.id, udpSpec, udpPayload);
  await persistProbe(node.id, udpMap.id, udpResult, "mapping.probe");
  await audit("demo.run", node.id, dropped ? "drop → knock → tcp + udp" : "knock → tcp + udp");

  const out: DemoResult = {
    nodeId: node.id,
    mappingId: mapping.id,
    bytesIn: result.bytesIn,
    bytesOut: result.bytesOut,
    preview: result.preview,
    dropped,
    udpBytesIn: udpResult.bytesIn,
    udpBytesOut: udpResult.bytesOut,
  };
  return out;
});

