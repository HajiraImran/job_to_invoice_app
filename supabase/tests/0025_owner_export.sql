-- Owner export grants and RESET ROLE.

select
  has_function_privilege(
    'api_app',
    'commercial.request_export(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.get_export(uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.latest_export(uuid)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.claim_build_export()',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.complete_export(uuid, text, text, bigint, jsonb, integer, integer)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.claim_export_ready_email()',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.claim_purge_exports()',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.request_export(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.get_export(uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'api_app',
    'commercial.claim_build_export()',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.request_export(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.export_workspace_payload(uuid, timestamptz)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
