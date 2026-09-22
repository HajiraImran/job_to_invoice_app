-- Direct-invoice grants and RESET ROLE (JRN06 / API04).

select
  has_function_privilege(
    'api_app',
    'commercial.open_direct_invoice_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.save_direct_invoice_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.freeze_direct_invoice_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.open_direct_invoice_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.issue_direct_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.save_direct_invoice_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
