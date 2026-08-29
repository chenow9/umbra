alter table mappings add column if not exists spa_ttl_sec integer not null default 60;
alter table mappings add column if not exists udp_idle_timeout_sec integer not null default 60;
