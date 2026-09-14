-- Application schemas, relations, and functions remain owned by migrator after RESET ROLE.

select
  not exists (
    select 1
    from pg_namespace n
    where n.nspname in ('identity', 'commercial')
      and pg_get_userbyid(n.nspowner) <> 'migrator'
  )
  and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('identity', 'commercial')
      and pg_get_userbyid(c.relowner) <> 'migrator'
  )
  and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('identity', 'commercial')
      and pg_get_userbyid(p.proowner) <> 'migrator'
  )
  as ok;
