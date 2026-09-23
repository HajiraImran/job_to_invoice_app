-- Account deletion grants and RESET ROLE.

select
  has_function_privilege(
    'api_app',
    'commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.get_account_deletion(uuid)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.claim_deletion_receipt_email()',
    'execute'
  )
  and has_function_privilege(
    'purge_app',
    'commercial.claim_purge_account()',
    'execute'
  )
  and has_function_privilege(
    'purge_app',
    'commercial.complete_purge_account(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.get_account_deletion(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'api_app',
    'commercial.claim_purge_account()',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.complete_purge_account(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.request_account_deletion(uuid, uuid, text, uuid, bytea, boolean)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
