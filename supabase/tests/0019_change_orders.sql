-- Change-order grants and RESET ROLE (S13/S14 / CHG01).

select
  has_function_privilege(
    'api_app',
    'commercial.open_change_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.save_change_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.freeze_change_preview(uuid, uuid, integer, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.publish_change_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.change_email_facts(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.open_change_draft(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.publish_change_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.save_change_draft(uuid, uuid, text, uuid, uuid, integer, jsonb)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
