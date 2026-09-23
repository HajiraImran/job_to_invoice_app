-- Owner support case grants. Staff functions stay absent.

select
  has_function_privilege(
    'api_app',
    'commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.create_support_case(uuid, uuid, text, uuid, text, text, boolean)',
    'execute'
  )
  and has_table_privilege('api_app', 'commercial.support_cases', 'select')
  and not has_table_privilege('anon', 'commercial.support_cases', 'select')
  and not has_table_privilege('authenticated', 'commercial.support_cases', 'select')
  and not has_table_privilege('anon', 'commercial.support_cases', 'insert')
  and (to_regclass('commercial.staff_users') is null)
  and (to_regclass('commercial.staff_access_grants') is null)
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
