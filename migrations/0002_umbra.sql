-- 幽门 M1 schema: nodes, mappings, traffic, audit. Unowned (auth-off).

create table if not exists nodes (
  id            text primary key,
  name          text not null,
  comment       text not null default '',
  bootstrap_hash text not null default '',
  cred_fp       text,
  status        text not null default 'offline',
  addr          text,
  version       text,
  os            text not null default 'linux',
  arch          text not null default 'amd64',
  last_seen     timestamptz,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists mappings (
  id              text primary key,
  node_id        text not null references nodes(id) on delete cascade,
  name            text not null,
  proto           text not null,
  mode            text not null,
  entry_port      integer,
  local_host      text not null default '127.0.0.1',
  local_port      integer not null,
  idle_timeout_sec integer not null default 60,
  enabled         boolean not null default true,
  listen_state    text not null default 'pending',
  listen_error    text,
  push_state      text not null default 'pending_offline',
  bytes_in        bigint not null default 0,
  bytes_out       bigint not null default 0,
  active_conns    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists mappings_entry_unique
  on mappings (proto, entry_port)
  where entry_port is not null;

create index if not exists mappings_node_idx on mappings (node_id);

create table if not exists traffic_samples (
  id            serial primary key,
  ts            timestamptz not null default now(),
  node_id      text not null,
  mapping_id    text not null,
  bytes_in      bigint not null default 0,
  bytes_out     bigint not null default 0,
  conns_opened  integer not null default 0
);

create index if not exists traffic_samples_ts_idx on traffic_samples (ts);
create index if not exists traffic_samples_map_idx on traffic_samples (mapping_id, ts);

create table if not exists audit_log (
  id      serial primary key,
  ts      timestamptz not null default now(),
  actor   text not null default 'admin',
  action  text not null,
  target  text not null default '',
  detail  text not null default ''
);

create table if not exists kv (
  k           text primary key,
  v           text not null,
  updated_at  timestamptz not null default now()
);
