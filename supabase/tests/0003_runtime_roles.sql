-- Application roles are created with safe attributes only. Pre-existing unsafe roles fail closed.

select
  (
    select count(*)
    from pg_roles
    where rolname in ('migrator', 'api_app', 'worker_app', 'purge_app')
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
      and not rolbypassrls
  ) = 4
  and not exists (
    select 1 from pg_roles
    where rolname in ('anon', 'authenticated')
      and (rolsuper or rolbypassrls or rolcanlogin)
  )
  as ok;
