alter table nodes add column if not exists user_id text not null default '';
create index if not exists nodes_user_idx on nodes (user_id);

alter table audit_log add column if not exists user_id text not null default '';
create index if not exists audit_user_idx on audit_log (user_id);

alter table traffic_samples add column if not exists user_id text not null default '';
create index if not exists traffic_user_idx on traffic_samples (user_id);
