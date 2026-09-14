-- Runtime roles must not bypass RLS. Migrator is the object owner only.

select
  not exists (
    select 1 from pg_roles
    where rolname in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
      and (rolsuper or rolbypassrls or rolcanlogin)
  )
  and exists (select 1 from pg_roles where rolname = 'migrator' and rolbypassrls and not rolsuper)
  as ok;
