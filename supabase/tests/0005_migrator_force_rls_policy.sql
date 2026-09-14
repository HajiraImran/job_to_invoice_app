-- Every FORCE RLS application table must have the migrator owner policy.
-- A later FORCE RLS table that omits the helper call fails this assertion.
-- Runtime and client roles must not receive USING (true) FOR ALL policies.

select
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('identity', 'commercial')
      and c.relkind = 'r'
      and c.relforcerowsecurity
      and not exists (
        select 1
        from pg_policy p
        where p.polrelid = c.oid
          and p.polname = n.nspname || '_' || c.relname || '_migrator_all'
          and p.polcmd = '*'
          and p.polroles = array[(select oid from pg_roles where rolname = 'migrator')]::oid[]
          and pg_get_expr(p.polqual, p.polrelid) in ('true', '(true)')
          and pg_get_expr(p.polwithcheck, p.polrelid) in ('true', '(true)')
      )
  )
  and not exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('identity', 'commercial')
      and p.polcmd = '*'
      and pg_get_expr(p.polqual, p.polrelid) in ('true', '(true)')
      and (
        0 = any (p.polroles)
        or exists (
          select 1
          from pg_roles r
          where r.oid = any (p.polroles)
            and r.rolname in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
        )
      )
  )
  and not has_function_privilege(
    'api_app',
    'identity.install_migrator_force_rls_policy(regclass)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'identity.install_migrator_force_rls_policy(regclass)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'identity.install_migrator_force_rls_policy(regclass)',
    'execute'
  )
  as ok;
