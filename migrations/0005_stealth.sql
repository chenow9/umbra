create table if not exists visitors (
  id          text primary key,
  mapping_id  text not null,
  label       text not null default '',
  ticket_hash text not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists visitors_map_idx on visitors (mapping_id);
