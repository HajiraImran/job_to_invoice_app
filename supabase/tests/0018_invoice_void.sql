-- Invoice void/replacement grants and RESET ROLE (S16 / BIL03).

select
  has_function_privilege(
    'api_app',
    'commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.freeze_replacement_preview(uuid, uuid, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.issue_replacement(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.void_invoice(uuid, uuid, text, uuid, uuid, text, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.issue_replacement(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
