alter table mappings add column if not exists last_probe_at timestamptz;
alter table mappings add column if not exists last_probe_preview text;
