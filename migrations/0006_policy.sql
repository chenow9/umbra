alter table mappings add column if not exists max_conns integer not null default 64;
alter table mappings add column if not exists rate_kbps integer not null default 0;
alter table mappings add column if not exists allow_cidrs text not null default '';
