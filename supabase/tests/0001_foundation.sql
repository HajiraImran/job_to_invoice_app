-- Foundation assertion: private schemas and runtime roles exist.

select
  (select count(*) from information_schema.schemata where schema_name in ('commercial', 'identity')) = 2
  and (select count(*) from pg_roles where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')) = 4
  as ok;
