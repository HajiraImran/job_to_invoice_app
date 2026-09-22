-- JOB02 cancel/delete grants and RESET ROLE.

select
  has_function_privilege(
    'api_app',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.delete_draft_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.delete_draft_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.cancel_job(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.delete_draft_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text, uuid)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
