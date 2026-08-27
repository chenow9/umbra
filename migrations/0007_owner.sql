alter table agents add column if not exists user_id text not null default '';
create index if not exists agents_user_idx on agents (user_id);

alter table audit_log add column if not exists user_id text not null default '';
create index if not exists audit_user_idx on audit_log (user_id);

alter table traffic_samples add column if not exists user_id text not null default '';
create index if not exists traffic_user_idx on traffic_samples (user_id);
