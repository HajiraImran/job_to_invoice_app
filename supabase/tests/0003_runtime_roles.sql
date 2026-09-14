-- Runtime roles and migrator must not bypass RLS. Owner access is table-scoped policies.

select
  not exists (
    select 1 from pg_roles
    where rolname in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
      and (rolsuper or rolbypassrls or rolcanlogin)
  )
  and exists (
    select 1 from pg_roles
    where rolname = 'migrator'
      and not rolbypassrls
      and not rolsuper
      and not rolcanlogin
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
  )
  as ok;
