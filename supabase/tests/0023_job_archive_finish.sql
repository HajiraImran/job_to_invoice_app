-- JOB01 archive/finish grants and RESET ROLE.

select
  has_function_privilege(
    'api_app',
    'commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.finish_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.finish_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.archive_job(uuid, uuid, text, uuid, uuid, boolean)',
    'execute'
  )
  and not has_function_privilege(
    'purge_app',
    'commercial.finish_job(uuid, uuid, text, uuid, uuid)',
    'execute'
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
