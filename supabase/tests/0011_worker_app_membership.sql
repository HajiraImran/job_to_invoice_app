-- Migration/runtime login may assume worker_app. worker_app stays nologin
-- and non-privileged, with no table DML beyond existing function EXECUTE.

select
  pg_has_role(current_user, 'worker_app', 'member')
  and exists (
    select 1
    from pg_roles
    where rolname = 'worker_app'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolreplication
      and not rolbypassrls
  )
  and not has_table_privilege('worker_app', 'commercial.outbox_tasks', 'select')
  and not has_table_privilege('worker_app', 'commercial.outbox_tasks', 'update')
  and not has_table_privilege('worker_app', 'commercial.documents', 'select')
  and not has_table_privilege('worker_app', 'commercial.documents', 'update')
  and not has_table_privilege('worker_app', 'commercial.artifacts', 'select')
  and not has_table_privilege('worker_app', 'commercial.artifacts', 'insert')
  and not has_table_privilege('worker_app', 'commercial.workspaces', 'select')
  and not has_table_privilege('worker_app', 'identity.app_users', 'select')
  and has_function_privilege('worker_app', 'commercial.claim_generate_original_pdf()', 'execute')
  as ok;
