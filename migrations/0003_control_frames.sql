create table if not exists control_frames (
  id        serial primary key,
  ts        timestamptz not null default now(),
  node_id  text not null,
  dir       text not null,
  type      text not null,
  body      text not null default ''
);

create index if not exists control_frames_ts_idx on control_frames (ts desc);
create index if not exists control_frames_node_idx on control_frames (node_id, ts desc);
