-- Customers and jobs are api_app tenant tables. Client and worker roles have no DML.

select
  has_table_privilege('api_app', 'commercial.customers', 'select')
  and has_table_privilege('api_app', 'commercial.customers', 'insert')
  and has_table_privilege('api_app', 'commercial.jobs', 'select')
  and has_table_privilege('api_app', 'commercial.jobs', 'insert')
  and has_function_privilege(
    'api_app',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text)',
    'execute'
  )
  and not has_table_privilege('anon', 'commercial.customers', 'select')
  and not has_table_privilege('authenticated', 'commercial.customers', 'select')
  and not has_table_privilege('anon', 'commercial.jobs', 'select')
  and not has_table_privilege('authenticated', 'commercial.jobs', 'select')
  and not has_table_privilege('worker_app', 'commercial.jobs', 'select')
  and not has_table_privilege('purge_app', 'commercial.jobs', 'select')
  and not has_function_privilege(
    'anon',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.create_job(uuid, uuid, text, uuid, uuid, text, text, jsonb, boolean, text, text)',
    'execute'
  )
  as ok;
